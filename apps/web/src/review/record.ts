import { type Db, type Decision, schema } from "@ocg/db";
import { and, desc, eq, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ObjectRef } from "./evidence";
import { confirmReasons } from "./reasons";
import { verifyPresentation } from "./token";

const { judgement } = schema;

export interface DecisionInput {
  decision: string;
  reasonCode?: string;
  /** Required to reject, to ask for a change, or to change one's mind; optional note otherwise. */
  reason?: string;
}

export type RecordResult = { ok: true; batchId: string; objectId: string } | { ok: false; error: string };

const decisions: Decision[] = ["confirm", "reject", "needs-change"];

/**
 * Records a reviewer's decision on the item a review page showed: one judgement
 * on the item and one on each object shown as part of it, together or not at
 * all. A change of mind supersedes the reviewer's earlier judgement.
 */
export async function recordDecision(
  db: Db,
  { token, reviewerId, input, now = Date.now() }: { token: string; reviewerId: string; input: DecisionInput; now?: number },
): Promise<RecordResult> {
  const presentation = verifyPresentation(token);
  if (!presentation || presentation.reviewerId !== reviewerId) {
    return { ok: false, error: "This page could not be verified. Please reload it and decide again." };
  }
  const { evidence, batchId } = presentation;

  const decision = input.decision as Decision;
  if (!decisions.includes(decision)) {
    return { ok: false, error: "Choose confirm, needs a change, or reject." };
  }
  const reasonCode = decision === "confirm" ? input.reasonCode : undefined;
  if (decision === "confirm" && !(reasonCode && reasonCode in confirmReasons[evidence.type])) {
    return { ok: false, error: "Choose why it is right." };
  }
  const reason = input.reason?.trim() || undefined;
  if (decision !== "confirm" && !reason) {
    return { ok: false, error: decision === "reject" ? "Say why it is wrong." : "Say what should change." };
  }

  try {
    return await db.transaction(async (tx) => {
      // One decision at a time per reviewer and item, so a double click cannot record two.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${reviewerId}:${evidence.primary.id}`}))`);

      const earlier = await liveJudgement(tx, reviewerId, evidence.primary.id);
      if (earlier && !reason) {
        return { ok: false, error: "Say why you are changing your decision." } as const;
      }

      const common = { reviewerId, decision, reasonCode: reasonCode ?? null, evidence };
      const [primary] = await tx
        .insert(judgement)
        .values({
          ...common,
          ...ref(evidence.primary),
          reason: reason ?? null,
          batchId,
          timeSpentMs: Math.max(0, now - presentation.presentedAt),
          supersedesId: earlier?.id ?? null,
        })
        .returning({ id: judgement.id });

      for (const covered of evidence.covered) {
        const before = await liveJudgement(tx, reviewerId, covered.id);
        await tx.insert(judgement).values({
          ...common,
          ...ref(covered),
          reason: reason ?? (before ? "Judged again with the item it belongs to." : null),
          coveredById: primary!.id,
          supersedesId: before?.id ?? null,
        });
      }
      return { ok: true, batchId, objectId: evidence.primary.id } as const;
    });
  } catch (error) {
    const message = String((error as { cause?: unknown }).cause ?? error);
    if (/is now at revision/.test(message)) {
      return { ok: false, error: "This item changed while you were looking at it. Please look again." };
    }
    if (/would make a loop/.test(message)) {
      return {
        ok: false,
        error: "Confirming this would make a loop of prerequisites, so it was not recorded. Please tell the curator.",
      };
    }
    throw error;
  }
}

function ref(object: ObjectRef) {
  return { objectId: object.id, objectKind: object.kind, objectRevision: object.revision };
}

/** The reviewer's current judgement on an object: the latest one nothing has superseded. */
export async function liveJudgement(db: Pick<Db, "select">, reviewerId: string, objectId: string) {
  const later = alias(judgement, "later");
  const [row] = await db
    .select()
    .from(judgement)
    .where(
      and(
        eq(judgement.reviewerId, reviewerId),
        eq(judgement.objectId, objectId),
        notExists(db.select({ id: later.id }).from(later).where(eq(later.supersedesId, judgement.id))),
      ),
    )
    .orderBy(desc(judgement.createdAt))
    .limit(1);
  return row;
}
