import { type Db, type ObjectKind, schema } from "@ocg/db";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

const { batch, batchItem, judgement, link } = schema;

export interface BatchItemState {
  objectId: string;
  objectKind: ObjectKind;
  linkType: string | null;
  position: number;
  decided: boolean;
}

/** A reviewer's batches, open ones first, with how far they have got. */
export async function batchesFor(db: Db, reviewerId: string) {
  const batches = await db
    .select()
    .from(batch)
    .where(eq(batch.assignedTo, reviewerId))
    .orderBy(asc(batch.closedAt), desc(batch.createdAt));
  return Promise.all(
    batches.map(async (b) => {
      const items = await itemsOf(db, b.id, reviewerId);
      return { ...b, total: items.length, done: items.filter((i) => i.decided).length, next: nextUndecided(items) };
    }),
  );
}

/** A batch, if it is assigned to this reviewer. */
export async function batchFor(db: Db, batchId: string, reviewerId: string) {
  const [b] = await db
    .select()
    .from(batch)
    .where(and(eq(batch.id, batchId), eq(batch.assignedTo, reviewerId)));
  return b;
}

/** The batch's items in order, each marked decided once the reviewer has judged it in this batch. */
export async function itemsOf(db: Db, batchId: string, reviewerId: string): Promise<BatchItemState[]> {
  const items = await db
    .select({ objectId: batchItem.objectId, objectKind: batchItem.objectKind, linkType: link.linkType })
    .from(batchItem)
    .leftJoin(link, eq(link.id, batchItem.objectId))
    .where(eq(batchItem.batchId, batchId))
    .orderBy(asc(batchItem.ordinal), asc(batchItem.objectId));
  const decided = await db
    .selectDistinct({ objectId: judgement.objectId })
    .from(judgement)
    .where(and(eq(judgement.batchId, batchId), eq(judgement.reviewerId, reviewerId), isNull(judgement.coveredById)));
  const decidedIds = new Set(decided.map((d) => d.objectId));
  return items.map((item, i) => ({ ...item, position: i + 1, decided: decidedIds.has(item.objectId) }));
}

/** The next item still to decide, after the given one if possible, else from the start. */
export function nextUndecided(items: BatchItemState[], afterObjectId?: string) {
  const from = afterObjectId ? items.findIndex((i) => i.objectId === afterObjectId) + 1 : 0;
  return items.slice(from).find((i) => !i.decided) ?? items.find((i) => !i.decided && i.objectId !== afterObjectId);
}
