import { randomUUID } from "node:crypto";
import { type Db, type ObjectKind, schema } from "@ocg/db";
import { freshTestDb } from "@ocg/db/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBatch } from "@/curate/create-batch";
import { plantMistake } from "@/curate/plant";
import { batchReports, closeBatch } from "@/curate/report";
import { candidates, planBatch } from "@/curate/select";
import { exampleCurriculum } from "@/example/curriculum";
import { buildEvidence, type CardEvidence, type PrerequisiteEvidence } from "@/review/evidence";
import { recordDecision } from "@/review/record";
import { present } from "@/review/token";

// Each test starts from a fresh example curriculum: batches change what is ready next.
let db: Db;
let frameworkId: string;
let curatorId: string;

beforeEach(async () => {
  db = await freshTestDb();
  curatorId = (await person("curator")).id;
  frameworkId = (await exampleCurriculum(db, curatorId)).frameworkId;
});
afterEach(async () => {
  await db.close();
});

async function person(role: string) {
  const [row] = await db
    .insert(schema.user)
    .values({ id: randomUUID(), name: `A ${role}`, email: `${randomUUID()}@example.org`, role })
    .returning();
  return row!;
}

const labels = (items: { label: string }[]) => items.map((i) => i.label.split(" ").slice(0, 3).join(" "));

async function decide(batchId: string, reviewerId: string, item: { objectId: string; objectKind: ObjectKind }) {
  const evidence = await buildEvidence(db, item);
  return recordDecision(db, {
    token: present(batchId, reviewerId, evidence),
    reviewerId,
    input: { decision: "reject", reason: "Not right." },
  });
}

describe("choosing items", () => {
  it("offers what is ready, in curriculum order, never a planted item", async () => {
    const items = await candidates(db, { frameworkId, screens: ["card", "prerequisite"] });
    expect(labels(items)).toEqual([
      "INT-01 Order integers",
      "INT-02 Add integers",
      "INT-03 Subtract an",
      "INT-02 needs INT-01",
      "INT-03 needs INT-02",
      "INT-03 needs INT-04",
      "INT-04 Find the",
      "ALG-05 Solve equations",
      "ALG-05 needs INT-03",
      "MEA-01 Convert between",
    ]);
    expect(labels(items)).not.toContain("INT-02 needs MEA-01");
  });

  it("narrows to the curriculum's own topics", async () => {
    const items = await candidates(db, { frameworkId, screens: ["card", "prerequisite"], topics: ["2.4"] });
    expect(labels(items)).toEqual(["ALG-05 Solve equations", "ALG-05 needs INT-03"]);
  });

  it("holds back items waiting in an open batch, and items already decided", async () => {
    const reviewer = await person("reviewer");
    const [first, second] = await candidates(db, { frameworkId, screens: ["card"] });
    const batch = await createBatch(db, {
      title: "Week 1",
      assignedTo: reviewer.id,
      createdBy: curatorId,
      items: [first!, second!],
    });
    expect(labels(await candidates(db, { frameworkId, screens: ["card"] }))).not.toContain("INT-01 Order integers");

    await decide(batch.id, reviewer.id, first!);
    await closeBatch(db, batch.id);
    const after = labels(await candidates(db, { frameworkId, screens: ["card"] }));
    expect(after).not.toContain("INT-01 Order integers"); // decided
    expect(after).toContain("INT-02 Add integers"); // skipped, so ready again
  });
});

describe("choosing items to confirm", () => {
  it("offers what one reviewer confirmed and nobody objected to, never to that reviewer", async () => {
    const [ada, ben] = [await person("reviewer"), await person("reviewer")];
    const firsts = await candidates(db, { frameworkId, screens: ["card"] });
    const batch = await createBatch(db, {
      title: "Cards",
      assignedTo: ada.id,
      createdBy: curatorId,
      items: firsts.slice(0, 2),
    });
    for (const [item, decision] of [
      [firsts[0]!, "confirm"],
      [firsts[1]!, "reject"],
    ] as const) {
      const evidence = await buildEvidence(db, item);
      await recordDecision(db, {
        token: present(batch.id, ada.id, evidence),
        reviewerId: ada.id,
        input:
          decision === "confirm" ? { decision, reasonCode: "matches-curriculum" } : { decision, reason: "Two concepts." },
      });
    }
    await closeBatch(db, batch.id);

    const confirm = (reviewerId: string) =>
      candidates(db, { frameworkId, screens: ["card"], stage: "confirmation", reviewerId });
    expect(labels(await confirm(ben.id))).toEqual([labels([firsts[0]!])[0]]);
    expect(await confirm(ada.id)).toEqual([]);
    // Nor is it offered for a first review again.
    const again = await candidates(db, { frameworkId, screens: ["card"] });
    expect(again.map((c) => c.objectId)).not.toContain(firsts[0]!.objectId);

    await expect(
      planBatch(db, { frameworkId, reviewerId: ben.id, screens: ["card"], stage: "confirmation", controls: 1 }),
    ).rejects.toThrow(/review batches only/);
    await expect(candidates(db, { frameworkId, screens: ["card"], stage: "confirmation" })).rejects.toThrow(/reviewer/);
  });
});

describe("planning a batch", () => {
  it("mixes in planted controls, never first or last, and never the same one twice for a reviewer", async () => {
    const reviewer = await person("reviewer");
    let seed = 0;
    const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    const { items, controlsShort } = await planBatch(db, {
      frameworkId,
      reviewerId: reviewer.id,
      screens: ["card", "prerequisite"],
      size: 6,
      controls: 1,
      random,
    });
    expect(items).toHaveLength(6);
    expect(controlsShort).toBe(0);
    const at = items.findIndex((i) => i.isControl);
    expect(items[at]!.label).toBe("INT-02 needs MEA-01");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(items.length - 1);

    const batch = await createBatch(db, { title: "Week 1", assignedTo: reviewer.id, createdBy: curatorId, items });
    const [control] = await db
      .select()
      .from(schema.batchItem)
      .where(and(eq(schema.batchItem.batchId, batch.id), eq(schema.batchItem.objectId, items[at]!.objectId)));
    expect(control!.controlExpected).toBe("reject");

    const again = await planBatch(db, { frameworkId, reviewerId: reviewer.id, screens: ["prerequisite"], controls: 1 });
    expect(again.items.some((i) => i.isControl)).toBe(false);
    expect(again.controlsShort).toBe(1);
  });

  it("plants mistakes that only ever appear as controls", async () => {
    const planted = await plantMistake(db, {
      frameworkId,
      statement: "A negative number times a negative number is negative.",
      example: "(−2) × (−3) = −6",
      hinders: "INT-03",
      rationale: "Learners keep the sign of the numbers they multiply.",
      note: "It is about multiplying, not subtracting: wrong concept.",
      plantedBy: curatorId,
    });
    expect(planted.humanCode).toBe("MIS-033");

    expect(labels(await candidates(db, { frameworkId, screens: ["mistake"] }))).not.toContain("MIS-033 A negative");
    const card = (await buildEvidence(db, {
      objectId: (await db.select().from(schema.concept).where(eq(schema.concept.humanCode, "INT-03")))[0]!.id,
      objectKind: "concept",
    })) as CardEvidence;
    expect(card.mistakes.map((m) => m.code)).toEqual(["MIS-031", "MIS-032"]);

    const reviewer = await person("reviewer");
    const { items } = await planBatch(db, { frameworkId, reviewerId: reviewer.id, screens: ["mistake"], controls: 1 });
    expect(items.filter((i) => i.isControl).map((i) => i.label)).toEqual([
      "MIS-033 A negative number times a negative number is negative.",
    ]);
  });

  it("keeps a planted link out of other items' neighbours", async () => {
    const [addNeedsOrder] = await candidates(db, { frameworkId, screens: ["prerequisite"] });
    const e = (await buildEvidence(db, addNeedsOrder!)) as PrerequisiteEvidence;
    expect(e.question.map((s) => s.text).join("")).toMatch(/order integers .* add integers/);
    expect(e.alsoNeeds.map((r) => r.code)).toEqual([]); // not MEA-01, the planted one
  });
});

describe("reporting on batches", () => {
  it("shows progress and how the reviewer did on the controls", async () => {
    const reviewer = await person("reviewer");
    const { items } = await planBatch(db, {
      frameworkId,
      reviewerId: reviewer.id,
      screens: ["prerequisite"],
      size: 3,
      controls: 1,
      random: () => 0.5,
    });
    const batch = await createBatch(db, { title: "Week 1", assignedTo: reviewer.id, createdBy: curatorId, items });
    for (const item of items) {
      await decide(batch.id, reviewer.id, item); // rejects everything, the control included
    }
    const [report] = await batchReports(db, reviewer.id);
    expect(report).toMatchObject({
      title: "Week 1",
      total: 3,
      done: 3,
      controls: { caught: 1, missed: 0, waiting: 0 },
      closedAt: null,
    });
  });
});
