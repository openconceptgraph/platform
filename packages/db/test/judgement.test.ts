import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, schema } from "../src";
import { freshTestDb } from "../src/testing";
import { addAiSource, addConcept, addFramework, addNeeds, addUser, pgError } from "./fixtures";

let db: Db;
beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.close();
});

const judgements = schema.judgement;

async function setup() {
  const fw = await addFramework(db);
  const source = await addAiSource(db, fw.id);
  const a = await addConcept(db, fw.id, "Add integers");
  const b = await addConcept(db, fw.id, "Subtract integers");
  const link = await addNeeds(db, source.id, b.id, a.id);
  const reviewer = await addUser(db);
  return { fw, link, reviewer };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function confirm({ link, reviewer }: Setup, extra: Partial<typeof judgements.$inferInsert> = {}) {
  return db
    .insert(judgements)
    .values({
      objectId: link.id,
      objectKind: "link",
      objectRevision: link.revision,
      reviewerId: reviewer.id,
      decision: "confirm",
      reasonCode: "matches-source",
      evidence: { link },
      ...extra,
    })
    .returning();
}

describe("the judgement record", () => {
  it("is stamped with the database's time, not the caller's", async () => {
    const s = await setup();
    const [j] = await confirm(s, { createdAt: new Date("2000-01-01") });
    expect(j!.createdAt.getFullYear()).toBeGreaterThan(2000);
  });

  it("is append-only", async () => {
    const s = await setup();
    const [j] = await confirm(s);

    const update = await pgError(db.update(judgements).set({ decision: "reject" }).where(eq(judgements.id, j!.id)));
    expect(update.message).toMatch(/append-only/);

    const del = await pgError(db.delete(judgements).where(eq(judgements.id, j!.id)));
    expect(del.message).toMatch(/append-only/);

    const truncate = await pgError(db.execute(sql`truncate judgement`));
    expect(truncate.message).toMatch(/cannot be truncated/);
  });

  it("needs a reason code to confirm, and written reasons to reject or ask for a change", async () => {
    const s = await setup();
    expect((await pgError(confirm(s, { reasonCode: null }))).message).toMatch(/judgement_reason_given/);
    expect((await pgError(confirm(s, { decision: "reject", reasonCode: null }))).message).toMatch(
      /judgement_reason_given/,
    );
    expect((await pgError(confirm(s, { decision: "needs-change", reason: "  " }))).message).toMatch(
      /judgement_reason_given/,
    );
    await expect(
      confirm(s, { decision: "reject", reasonCode: null, reason: "Adding does not need subtracting." }),
    ).resolves.toHaveLength(1);
  });

  it("is refused on an out-of-date revision", async () => {
    const s = await setup();
    await db.update(schema.link).set({ rationale: "Reworded" }).where(eq(schema.link.id, s.link.id));

    const err = await pgError(confirm(s)); // still on revision 1
    expect(err.message).toMatch(/revision 1 of link .* now at revision 2/);
  });

  it("can only be superseded by the same reviewer, on the same object, once", async () => {
    const s = await setup();
    const [first] = await confirm(s);

    const other = await addUser(db);
    const byOther = await pgError(confirm({ ...s, reviewer: other }, { supersedesId: first!.id }));
    expect(byOther.code).toBe("23503");

    const [second] = await confirm(s, {
      decision: "needs-change",
      reasonCode: null,
      reason: "On reflection the source does not say this.",
      supersedesId: first!.id,
    });
    expect(second!.supersedesId).toBe(first!.id);

    const again = await pgError(confirm(s, { supersedesId: first!.id }));
    expect(again.code).toBe("23505");
  });
});

describe("batches and controls", () => {
  async function batchWith(s: Setup, controlExpected: "confirm" | "reject" | null) {
    const curator = await addUser(db, "curator");
    const [b] = await db.insert(schema.batch).values({ title: "Week 1", createdBy: curator.id }).returning();
    await db
      .insert(schema.batchItem)
      .values({ batchId: b!.id, objectId: s.link.id, objectKind: "link", controlExpected });
    return b!;
  }

  it("takes the control flag from the batch, whatever the caller says", async () => {
    const s = await setup();
    const control = await batchWith(s, "reject");
    const [j] = await confirm(s, { batchId: control.id, isControl: false });
    expect(j!.isControl).toBe(true);

    const plain = await batchWith(s, null);
    const [k] = await confirm(s, { batchId: plain.id, isControl: true });
    expect(k!.isControl).toBe(false);
  });

  it("refuses a judgement on an object outside the batch", async () => {
    const s = await setup();
    const elsewhere = await setup();
    const b = await batchWith(elsewhere, null);
    expect((await pgError(confirm(s, { batchId: b.id }))).message).toMatch(/is not in batch/);
  });

  it("refuses a judgement in a closed batch", async () => {
    const s = await setup();
    const b = await batchWith(s, null);
    await db.update(schema.batch).set({ closedAt: new Date() }).where(eq(schema.batch.id, b.id));
    expect((await pgError(confirm(s, { batchId: b.id }))).message).toMatch(/closed/);
  });
});
