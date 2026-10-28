import { type Db, schema } from "@ocg/db";
import { and, desc, eq, like } from "drizzle-orm";

// Planting controls: items written to be wrong, put to reviewers among real
// ones to measure how carefully they judge. A planted item looks exactly like
// a drafted one on screen, citing the same AI drafting source, so that the
// control is fair; the planted table is the honest record that it is planted.

const { concept, link, misconception, planted, source } = schema;

export async function conceptByCode(db: Db, frameworkId: string, code: string) {
  const [row] = await db
    .select()
    .from(concept)
    .where(and(eq(concept.frameworkId, frameworkId), eq(concept.humanCode, code)));
  if (!row) throw new Error(`no concept ${code} in this framework`);
  return row;
}

/** The framework's latest AI drafting source, which planted items cite like everything drafted. */
async function draftingSource(db: Db, frameworkId: string) {
  const [row] = await db
    .select()
    .from(source)
    .where(and(eq(source.frameworkId, frameworkId), eq(source.kind, "ai")))
    .orderBy(desc(source.createdAt))
    .limit(1);
  if (!row) throw new Error("this framework has no AI drafting source yet, so a planted item would stand out");
  return row;
}

/** Plants a prerequisite link a careful reviewer should reject. */
export async function plantLink(
  db: Db,
  p: { frameworkId: string; from: string; to: string; rationale: string; note: string; plantedBy: string },
) {
  const from = await conceptByCode(db, p.frameworkId, p.from);
  const to = await conceptByCode(db, p.frameworkId, p.to);
  const drafting = await draftingSource(db, p.frameworkId);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(link)
      .values({
        linkType: "needs",
        fromKind: "concept",
        fromId: from.id,
        toKind: "concept",
        toId: to.id,
        sourceId: drafting.id,
        rationale: p.rationale,
      })
      .returning();
    await tx.insert(planted).values({ objectId: row!.id, objectKind: "link", note: p.note, plantedBy: p.plantedBy });
    return row!;
  });
}

/** Plants a typical mistake a careful reviewer should reject, with the concept it supposedly gets in the way of. */
export async function plantMistake(
  db: Db,
  p: {
    frameworkId: string;
    statement: string;
    example?: string;
    hinders: string;
    rationale: string;
    note: string;
    plantedBy: string;
  },
) {
  const hindered = await conceptByCode(db, p.frameworkId, p.hinders);
  const drafting = await draftingSource(db, p.frameworkId);
  const humanCode = await nextMistakeCode(db, p.frameworkId);
  return db.transaction(async (tx) => {
    const [m] = await tx
      .insert(misconception)
      .values({
        frameworkId: p.frameworkId,
        humanCode,
        statement: { en: p.statement },
        example: p.example ? { en: p.example } : undefined,
      })
      .returning();
    await tx.insert(link).values({
      linkType: "hinders",
      fromKind: "misconception",
      fromId: m!.id,
      toKind: "concept",
      toId: hindered.id,
      sourceId: drafting.id,
      rationale: p.rationale,
    });
    await tx.insert(planted).values({ objectId: m!.id, objectKind: "misconception", note: p.note, plantedBy: p.plantedBy });
    return m!;
  });
}

/** The next code in the MIS-NNN series, so a planted mistake looks like its neighbours. */
async function nextMistakeCode(db: Db, frameworkId: string) {
  const codes = await db
    .select({ code: misconception.humanCode })
    .from(misconception)
    .where(and(eq(misconception.frameworkId, frameworkId), like(misconception.humanCode, "MIS-%")));
  const highest = Math.max(0, ...codes.map((c) => Number(c.code.slice(4)) || 0));
  return `MIS-${String(highest + 1).padStart(3, "0")}`;
}
