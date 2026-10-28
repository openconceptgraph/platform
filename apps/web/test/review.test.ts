import { randomUUID } from "node:crypto";
import { type Db, schema } from "@ocg/db";
import { freshTestDb } from "@ocg/db/testing";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exampleCurriculum } from "@/example/curriculum";
import { itemsOf, nextUndecided } from "@/review/batches";
import { createBatch, type NewBatchItem } from "@/curate/create-batch";
import { buildEvidence, type CardEvidence, type MistakeEvidence, type PrerequisiteEvidence } from "@/review/evidence";
import { recordDecision } from "@/review/record";
import { profileOf, saveProfile } from "@/review/profile";
import { present, signPresentation, verifyPresentation } from "@/review/token";

let db: Db;
let items: NewBatchItem[];
// The example batch, in order: card INT-03, needs INT-03→INT-02, mistake MIS-031,
// needs ALG-05→INT-03, planted needs INT-02→MEA-01, card INT-02, mistake MIS-032,
// needs INT-03→INT-04.
const CARD = 0;
const PREREQ = 1;
const MISTAKE = 2;
const PLANTED = 4;
const UNSOURCED_MISTAKE = 6;

beforeAll(async () => {
  db = await freshTestDb();
  const [curator] = await db
    .insert(schema.user)
    .values({ id: randomUUID(), name: "Cara Curator", email: "curator@example.org", role: "curator" })
    .returning();
  items = (await exampleCurriculum(db, curator!.id)).batchItems;
});
afterAll(async () => {
  await db.close();
});

async function reviewerWithBatch() {
  const [reviewer] = await db
    .insert(schema.user)
    .values({ id: randomUUID(), name: "Ada Reviewer", email: `${randomUUID()}@example.org`, role: "reviewer" })
    .returning();
  const batch = await createBatch(db, { title: "Example", assignedTo: reviewer!.id, createdBy: reviewer!.id, items });
  return { reviewer: reviewer!, batch };
}

async function show(batchId: string, reviewerId: string, index: number) {
  const evidence = await buildEvidence(db, items[index]!);
  return { evidence, token: present(batchId, reviewerId, evidence) };
}

describe("the evidence a screen shows", () => {
  it("asks a prerequisite question in plain words, with the curriculum, the proposal and the neighbours", async () => {
    const e = (await buildEvidence(db, items[PREREQ]!)) as PrerequisiteEvidence;
    expect(e.question.map((s) => s.text).join("")).toBe(
      "Must a learner be able to add integers before they can learn to subtract an integer by adding its additive inverse?",
    );
    expect(e.needed).toMatchObject({ code: "INT-02", firstTaught: "Grade 7" });
    // In document order: page, then position on the page.
    expect(e.curriculum[0]!.quotes.map((q) => q.statementType)).toEqual(["content", "clarification", "exemplar"]);
    expect(e.curriculum[0]!.quotes[1]!.reference).toBe(
      "Example Mathematics Curriculum, Senior Phase · p. 41 · Grade 7 · 1.3 Integers",
    );
    expect(e.proposal).toMatchObject({ label: "AI draft", detail: "Drafting prompt example-v1" });
    expect(e.alsoNeeds.map((r) => r.code)).toEqual(["INT-04"]);
    expect(e.neededBy.map((r) => r.code)).toEqual(["ALG-05"]);
    expect(e.covered).toEqual([]);
  });

  it("never shows the AI's agreement score", async () => {
    for (const item of items) {
      expect(JSON.stringify(await buildEvidence(db, item))).not.toMatch(/confidence|agreement/i);
    }
  });

  it("covers a concept card's curriculum lines and family", async () => {
    const e = (await buildEvidence(db, items[CARD]!)) as CardEvidence;
    expect(e.concept).toMatchObject({ code: "INT-03", family: "Integers", isGateway: true, firstTaught: "Grade 7" });
    expect(e.quotes).toHaveLength(3);
    expect(e.covered).toHaveLength(4); // three "defines" links and one "part-of"
    expect(e.mistakes.map((m) => m.code)).toEqual(["MIS-031", "MIS-032"]);
    expect(e.family.map((m) => m.code)).toEqual(["INT-01", "INT-02", "INT-04"]);
  });

  it("covers the concepts a mistake gets in the way of, and says where it is documented", async () => {
    const sourced = (await buildEvidence(db, items[MISTAKE]!)) as MistakeEvidence;
    expect(sourced.question.map((s) => s.text).join("")).toBe(
      "Do learners really make this mistake, and does it get in the way of learning to subtract an integer by adding its additive inverse?",
    );
    expect(sourced.hinders.map((c) => c.code)).toEqual(["INT-03"]);
    expect(sourced.covered).toHaveLength(1);
    expect(sourced.documentedIn?.label).toBe("The curriculum");
    expect(sourced.documentedIn?.quote?.text).toMatch(/subtracting always gives a smaller number/);

    const unsourced = (await buildEvidence(db, items[UNSOURCED_MISTAKE]!)) as MistakeEvidence;
    expect(unsourced.documentedIn).toBeUndefined();
  });
});

describe("the presentation token", () => {
  it("refuses anything the server did not sign", async () => {
    const { reviewer, batch } = await reviewerWithBatch();
    const { token } = await show(batch.id, reviewer.id, PREREQ);
    expect(verifyPresentation(token)).not.toBeNull();

    const [body, mac] = token.split(".");
    const altered = JSON.parse(Buffer.from(body!, "base64url").toString());
    altered.evidence.question = [{ text: "Is this fine?" }];
    expect(verifyPresentation(`${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${mac}`)).toBeNull();
    expect(verifyPresentation("not-a-token")).toBeNull();
  });
});

describe("recording a decision", () => {
  it("records the item and everything shown with it, with exactly what was shown and how long it took", async () => {
    const { reviewer, batch } = await reviewerWithBatch();
    const { evidence, token } = await show(batch.id, reviewer.id, CARD);
    const presentedAt = verifyPresentation(token)!.presentedAt;

    const result = await recordDecision(db, {
      token,
      reviewerId: reviewer.id,
      input: { decision: "confirm", reasonCode: "matches-curriculum" },
      now: presentedAt + 75_000,
    });
    expect(result).toEqual({ ok: true, batchId: batch.id, objectId: evidence.primary.id });

    const rows = await db.select().from(schema.judgement).where(eq(schema.judgement.reviewerId, reviewer.id));
    const primary = rows.find((r) => r.coveredById === null)!;
    expect(primary).toMatchObject({ objectId: evidence.primary.id, batchId: batch.id, timeSpentMs: 75_000 });
    expect(primary.evidence).toEqual(evidence);
    expect(rows.filter((r) => r.coveredById === primary.id)).toHaveLength(4);

    // One reviewer confirming, with nobody objecting, confirms the card and what it covers.
    const [card] = await db.select().from(schema.concept).where(eq(schema.concept.id, evidence.primary.id));
    expect(card!.status).toBe("confirmed");
    const covered = await db
      .select({ status: schema.link.status })
      .from(schema.link)
      .where(inArray(schema.link.id, evidence.covered.map((c) => c.id)));
    expect(covered.map((c) => c.status)).toEqual(["confirmed", "confirmed", "confirmed", "confirmed"]);
  });

  it("needs a listed reason to confirm and written words to reject", async () => {
    const { reviewer, batch } = await reviewerWithBatch();
    const { token } = await show(batch.id, reviewer.id, PREREQ);
    const attempt = (input: Parameters<typeof recordDecision>[1]["input"]) =>
      recordDecision(db, { token, reviewerId: reviewer.id, input });

    expect(await attempt({ decision: "confirm" })).toMatchObject({ ok: false, error: "Choose why it is right." });
    // A reason from another screen's list is not accepted.
    expect(await attempt({ decision: "confirm", reasonCode: "seen-in-class" })).toMatchObject({ ok: false });
    expect(await attempt({ decision: "reject", reason: "   " })).toMatchObject({ ok: false, error: "Say why it is wrong." });
    expect(await attempt({ decision: "maybe" })).toMatchObject({ ok: false });
    expect(await attempt({ decision: "reject", reason: "Adding does not need subtracting." })).toMatchObject({ ok: true });
  });

  it("refuses a page shown to someone else", async () => {
    const { batch } = await reviewerWithBatch();
    const other = await reviewerWithBatch();
    const { token } = await show(batch.id, "someone-else", PREREQ);
    const result = await recordDecision(db, {
      token,
      reviewerId: other.reviewer.id,
      input: { decision: "reject", reason: "No." },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/could not be verified/) });
  });

  it("asks why when a reviewer changes their mind, and supersedes the earlier decision and its covered ones", async () => {
    const { reviewer, batch } = await reviewerWithBatch();
    const first = await show(batch.id, reviewer.id, MISTAKE);
    await recordDecision(db, {
      token: first.token,
      reviewerId: reviewer.id,
      input: { decision: "confirm", reasonCode: "curriculum-warns" },
    });

    const second = await show(batch.id, reviewer.id, MISTAKE);
    const silent = await recordDecision(db, {
      token: second.token,
      reviewerId: reviewer.id,
      input: { decision: "needs-change", reason: "" },
    });
    expect(silent).toMatchObject({ ok: false });
    const silentConfirm = await recordDecision(db, {
      token: second.token,
      reviewerId: reviewer.id,
      input: { decision: "confirm", reasonCode: "seen-in-class" },
    });
    expect(silentConfirm).toMatchObject({ ok: false, error: "Say why you are changing your decision." });

    expect(
      await recordDecision(db, {
        token: second.token,
        reviewerId: reviewer.id,
        input: { decision: "needs-change", reason: "The example should use a smaller number." },
      }),
    ).toMatchObject({ ok: true });

    const rows = await db
      .select()
      .from(schema.judgement)
      .where(eq(schema.judgement.reviewerId, reviewer.id))
      .orderBy(schema.judgement.createdAt);
    expect(rows).toHaveLength(4); // misconception and its hinders link, twice
    const live = rows.filter((r) => !rows.some((s) => s.supersedesId === r.id));
    expect(live.map((r) => r.decision)).toEqual(["needs-change", "needs-change"]);
    expect(live.every((r) => r.supersedesId)).toBe(true);
  });

  it("tells the reviewer when the item changed while they were looking", async () => {
    const { reviewer, batch } = await reviewerWithBatch();
    const { evidence, token } = await show(batch.id, reviewer.id, PREREQ);
    await db
      .update(schema.link)
      .set({ rationale: "Reworded while the reviewer was reading." })
      .where(eq(schema.link.id, evidence.primary.id));

    const result = await recordDecision(db, {
      token,
      reviewerId: reviewer.id,
      input: { decision: "confirm", reasonCode: "done-using-it" },
    });
    expect(result).toEqual({ ok: false, error: "This item changed while you were looking at it. Please look again." });
  });

  it("marks a planted control as such, though the page never says so", async () => {
    const { reviewer, batch } = await reviewerWithBatch();
    const { evidence, token } = await show(batch.id, reviewer.id, PLANTED);
    expect(JSON.stringify(evidence)).not.toMatch(/planted|control/i);
    await recordDecision(db, { token, reviewerId: reviewer.id, input: { decision: "reject", reason: "Not needed." } });
    const [j] = await db
      .select()
      .from(schema.judgement)
      .where(and(eq(schema.judgement.reviewerId, reviewer.id), isNull(schema.judgement.coveredById)));
    expect(j!.isControl).toBe(true);
    // A control measures the reviewer; it never changes the base.
    const [planted] = await db.select().from(schema.link).where(eq(schema.link.id, evidence.primary.id));
    expect(planted!.status).toBe("proposed");
  });
});

describe("progress through a batch", () => {
  it("counts decided items and moves on to the next undecided one, wrapping round", async () => {
    const { reviewer, batch } = await reviewerWithBatch();
    for (const index of [0, 2]) {
      const { token } = await show(batch.id, reviewer.id, index);
      await recordDecision(db, {
        token,
        reviewerId: reviewer.id,
        input: { decision: "needs-change", reason: "Later." },
      });
    }
    const state = await itemsOf(db, batch.id, reviewer.id);
    expect(state.map((i) => i.decided)).toEqual([true, false, true, false, false, false, false, false]);
    expect(nextUndecided(state)?.position).toBe(2);
    expect(nextUndecided(state, state[1]!.objectId)?.position).toBe(4);
    expect(nextUndecided(state, state[7]!.objectId)?.position).toBe(2);
  });
});

describe("making a batch", () => {
  it("accepts only items with a screen of their own", async () => {
    const [definesLink] = await db.select().from(schema.link).where(eq(schema.link.linkType, "defines")).limit(1);
    const { reviewer } = await reviewerWithBatch();
    await expect(
      createBatch(db, {
        title: "Bad",
        assignedTo: reviewer.id,
        createdBy: reviewer.id,
        items: [{ objectId: definesLink!.id, objectKind: "link" }],
      }),
    ).rejects.toThrow(/no review screen/);
  });
});

describe("signing", () => {
  it("round-trips", () => {
    const token = signPresentation({
      v: 1,
      batchId: "b",
      reviewerId: "r",
      presentedAt: 1,
      evidence: { type: "card" } as CardEvidence,
    });
    expect(verifyPresentation(token)?.batchId).toBe("b");
  });
});

describe("public names", () => {
  it("are unique whatever the case, and checked before saving", async () => {
    const { reviewer } = await reviewerWithBatch();
    const other = await reviewerWithBatch();
    expect(await saveProfile(db, reviewer.id, { publicName: "  Reviewer   Kestrel ", publicNote: "Retired physicist" })).toEqual({
      ok: true,
    });
    expect((await profileOf(db, reviewer.id))?.publicName).toBe("Reviewer Kestrel");
    expect(await saveProfile(db, other.reviewer.id, { publicName: "reviewer kestrel" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already uses that public name/),
    });
    expect(await saveProfile(db, other.reviewer.id, { publicName: "x" })).toMatchObject({ ok: false });
    expect(await saveProfile(db, other.reviewer.id, { publicName: "ada@example.org" })).toMatchObject({ ok: false });
    // Changing one's own public name is fine.
    expect(await saveProfile(db, reviewer.id, { publicName: "Reviewer Osprey" })).toEqual({ ok: true });
  });

  it("are what a screen shows of a reviewer, never the name on their account", async () => {
    const { reviewer } = await reviewerWithBatch();
    await saveProfile(db, reviewer.id, { publicName: "Classroom reviewer 2" });
    const [fw] = await db.select().from(schema.framework).limit(1);
    const [seen] = await db
      .insert(schema.source)
      .values({ frameworkId: fw!.id, kind: "reviewer", reviewerId: reviewer.id })
      .returning();
    const [mistake] = await db
      .insert(schema.misconception)
      .values({
        frameworkId: fw!.id,
        humanCode: "MIS-099",
        statement: { en: "Ordering negatives like positives." },
        sourceId: seen!.id,
      })
      .returning();

    const e = (await buildEvidence(db, { objectId: mistake!.id, objectKind: "misconception" })) as MistakeEvidence;
    expect(e.documentedIn?.label).toBe("Seen in class by Classroom reviewer 2");
    expect(JSON.stringify(e)).not.toContain(reviewer.name);
  });
});
