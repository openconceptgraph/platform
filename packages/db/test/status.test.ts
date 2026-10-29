import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, type Decision, schema } from "../src";
import { freshTestDb } from "../src/testing";
import { addAiSource, addConcept, addFramework, addNeeds, addUser, pgError } from "./fixtures";

let db: Db;
beforeAll(async () => {
  db = await freshTestDb();
});
afterAll(async () => {
  await db.close();
});

async function setup() {
  const fw = await addFramework(db);
  const source = await addAiSource(db, fw.id);
  const a = await addConcept(db, fw.id, "Add integers");
  const b = await addConcept(db, fw.id, "Subtract integers");
  const link = await addNeeds(db, source.id, b.id, a.id);
  return { link, ada: await addUser(db), ben: await addUser(db) };
}

async function linkNow(id: string) {
  const [row] = await db.select().from(schema.link).where(eq(schema.link.id, id));
  return row!;
}

async function judge(
  linkId: string,
  reviewerId: string,
  decision: Decision,
  extra: Partial<typeof schema.judgement.$inferInsert> = {},
) {
  const { revision } = await linkNow(linkId);
  const [row] = await db
    .insert(schema.judgement)
    .values({
      objectId: linkId,
      objectKind: "link",
      objectRevision: revision,
      reviewerId,
      decision,
      reasonCode: decision === "confirm" ? "fails-without-it" : null,
      reason: decision === "confirm" ? null : "Not right.",
      evidence: {},
      ...extra,
    })
    .returning();
  return row!;
}

const status = async (id: string) => (await linkNow(id)).status;

describe("a review status follows judgements", () => {
  it("is confirmed once two reviewers confirm, rejected by one's rejection", async () => {
    const confirmed = await setup();
    await judge(confirmed.link.id, confirmed.ada.id, "confirm");
    expect(await status(confirmed.link.id)).toBe("proposed");
    await judge(confirmed.link.id, confirmed.ben.id, "confirm");
    expect(await status(confirmed.link.id)).toBe("confirmed");

    const rejected = await setup();
    await judge(rejected.link.id, rejected.ada.id, "reject");
    expect(await status(rejected.link.id)).toBe("rejected");
  });

  it("needs two different reviewers: one reviewer confirming twice is still one", async () => {
    const s = await setup();
    const first = await judge(s.link.id, s.ada.id, "confirm");
    await judge(s.link.id, s.ada.id, "confirm", { supersedesId: first.id, reason: "Looked again." });
    expect(await status(s.link.id)).toBe("proposed");
    await judge(s.link.id, s.ada.id, "confirm");
    expect(await status(s.link.id)).toBe("proposed");
  });

  it("stays proposed while a change is asked for", async () => {
    const s = await setup();
    await judge(s.link.id, s.ada.id, "needs-change");
    expect(await status(s.link.id)).toBe("proposed");
  });

  it("stays proposed while reviewers disagree, and follows them once they agree", async () => {
    const s = await setup();
    await judge(s.link.id, s.ada.id, "confirm");
    const objection = await judge(s.link.id, s.ben.id, "reject");
    expect(await status(s.link.id)).toBe("proposed");

    await judge(s.link.id, s.ben.id, "confirm", {
      supersedesId: objection.id,
      reason: "Talked it through: the worked example settles it.",
    });
    expect(await status(s.link.id)).toBe("confirmed");
  });

  it("follows a reviewer's change of mind", async () => {
    const s = await setup();
    const first = await judge(s.link.id, s.ada.id, "confirm");
    await judge(s.link.id, s.ada.id, "reject", { supersedesId: first.id, reason: "I misread it." });
    expect(await status(s.link.id)).toBe("rejected");
  });

  it("goes back to proposed when one of two confirming reviewers changes their mind", async () => {
    const s = await setup();
    await judge(s.link.id, s.ada.id, "confirm");
    const second = await judge(s.link.id, s.ben.id, "confirm");
    expect(await status(s.link.id)).toBe("confirmed");
    await judge(s.link.id, s.ben.id, "needs-change", { supersedesId: second.id, reason: "The example is Grade 9." });
    expect(await status(s.link.id)).toBe("proposed");
  });

  it("counts only judgements on the current revision", async () => {
    const s = await setup();
    await judge(s.link.id, s.ada.id, "confirm");
    await db.update(schema.link).set({ rationale: "Reworded." }).where(eq(schema.link.id, s.link.id));
    expect(await status(s.link.id)).toBe("proposed");

    // Ben's view of the new wording decides; Ada's earlier confirmation no longer counts.
    await judge(s.link.id, s.ben.id, "needs-change");
    expect(await status(s.link.id)).toBe("proposed");
    await judge(s.link.id, s.ada.id, "reject");
    expect(await status(s.link.id)).toBe("proposed");
  });

  it("never moves on a planted control's judgement", async () => {
    const s = await setup();
    const [batch] = await db
      .insert(schema.batch)
      .values({ title: "Controls", assignedTo: s.ada.id, createdBy: s.ada.id })
      .returning();
    await db
      .insert(schema.batchItem)
      .values({ batchId: batch!.id, objectId: s.link.id, objectKind: "link", controlExpected: "reject" });

    const wrong = await judge(s.link.id, s.ada.id, "confirm", { batchId: batch!.id });
    expect(wrong.isControl).toBe(true);
    expect(await status(s.link.id)).toBe("proposed");
  });

  it("cannot be set directly", async () => {
    const s = await setup();
    const err = await pgError(
      db.update(schema.link).set({ status: "confirmed" }).where(eq(schema.link.id, s.link.id)),
    );
    expect(err.message).toMatch(/follows judgements and cannot be set directly/);
    expect(await status(s.link.id)).toBe("proposed");
  });
});
