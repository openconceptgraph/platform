import { randomUUID } from "node:crypto";
import { type Db, type ObjectKind, schema } from "@ocg/db";
import { freshTestDb } from "@ocg/db/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBatch } from "@/curate/create-batch";
import { exampleCurriculum } from "@/example/curriculum";
import { type BaseGraph, buildGraph, type ConceptNode, frameworksWithConcepts, type GraphNode } from "@/graph/data";
import { layOut } from "@/graph/layout";
import { termChanges, whenText } from "@/graph/plans";
import { Relations } from "@/graph/relations";
import { familyColours, familyPalette, nodeLook, otherFamily, termColour, unplaced } from "@/graph/style";
import { buildEvidence } from "@/review/evidence";
import { recordDecision } from "@/review/record";
import { present } from "@/review/token";

// Each test starts from a fresh example curriculum: judgements change what the graph shows.
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

const graphFor = (seesProgress: boolean) => buildGraph(db, frameworkId, { seesProgress });

function byCode(graph: BaseGraph, code: string): GraphNode {
  const node = graph.nodes.find((n) => n.code === code && n.kind !== "statement");
  if (!node) throw new Error(`no ${code} on the graph`);
  return node;
}

/** A reviewer's decision on one item, made through its review screen in a batch of its own. */
async function decide(
  reviewerId: string,
  item: { objectId: string; objectKind: ObjectKind },
  input: { decision: string; reasonCode?: string; reason?: string },
  stage: "review" | "confirmation" = "review",
) {
  const batch = await createBatch(db, { title: "One", assignedTo: reviewerId, createdBy: curatorId, items: [item], stage });
  const evidence = await buildEvidence(db, item, stage === "confirmation" ? { confirming: reviewerId } : {});
  const result = await recordDecision(db, { token: present(batch.id, reviewerId, evidence), reviewerId, input });
  expect(result.ok).toBe(true);
}

const card = (graph: BaseGraph, code: string) => ({ objectId: byCode(graph, code).id, objectKind: "concept" as const });

describe("the graph of a base", () => {
  it("holds the curriculum's content lines, and any other line that defines a concept, under their headings", async () => {
    const graph = await graphFor(true);
    const lines = graph.nodes.filter((n) => n.kind === "statement");
    // Five content lines (one a "Revise" line), and a clarification and an example that define INT-03.
    expect(lines).toHaveLength(7);
    expect(lines.filter((l) => l.kind === "statement" && l.isRevision)).toHaveLength(1);
    expect(lines.some((l) => l.kind === "statement" && l.text.startsWith("Learners often believe"))).toBe(false);
    expect(graph.nodes.filter((n) => n.kind === "topic").map((n) => n.code).sort()).toEqual(["1", "1.3", "2", "2.4", "4", "4.1"]);
    for (const line of lines) {
      expect(graph.edges.some((e) => e.type === "under" && e.source === line.id)).toBe(true);
    }
    expect(graph.framework.slug).toBe("xx-example/mathematics");
  });

  it("never shows a planted control", async () => {
    const graph = await graphFor(true);
    const needs = graph.edges.filter((e) => e.type === "needs");
    expect(needs).toHaveLength(4);
    const mea = byCode(graph, "MEA-01").id;
    expect(needs.some((e) => e.source === mea || e.target === mea)).toBe(false);
    expect(graph.counts.prerequisites).toEqual({ total: 4, reviewed: 0, confirmed: 0 });
  });

  it("draws a prerequisite towards the concept that needs it", async () => {
    const graph = await graphFor(true);
    const relations = new Relations(graph);
    const int02 = byCode(graph, "INT-02");
    expect(relations.prerequisites(int02.id).map((r) => r.node.code)).toEqual(["INT-01"]);
    expect(relations.neededFor(int02.id).map((r) => r.node.code)).toEqual(["INT-03"]);
    const edge = relations.edgesInto(int02.id, "needs")[0]!;
    expect(edge.source).toBe(byCode(graph, "INT-01").id);
  });

  it("orders concepts as the curriculum first teaches them, and families likewise", async () => {
    const graph = await graphFor(true);
    const concepts = graph.nodes.filter((n): n is ConceptNode => n.kind === "concept");
    expect(concepts.map((c) => c.code)).toEqual(["INT-01", "INT-02", "INT-03", "INT-04", "ALG-05", "MEA-01"]);
    expect(graph.families.map((f) => f.code)).toEqual(["INT", "ALG", "MEA"]);
    expect(concepts.find((c) => c.code === "INT-03")).toMatchObject({ family: "INT", isGateway: true });
  });
});

describe("review status on the graph", () => {
  it("shows an item one reviewer has confirmed as reviewed to curators and admins, and as proposed to reviewers", async () => {
    const ada = await person("reviewer");
    await decide(ada.id, card(await graphFor(true), "INT-03"), { decision: "confirm", reasonCode: "matches-curriculum" });

    const curators = await graphFor(true);
    expect(byCode(curators, "INT-03")).toMatchObject({ status: "reviewed" });
    expect(curators.counts.concepts).toEqual({ total: 6, reviewed: 1, confirmed: 0 });
    // Confirming a card also judges the lines that define it.
    const defining = curators.edges.filter((e) => e.type === "defines" && e.target === byCode(curators, "INT-03").id);
    expect(defining.map((e) => e.status)).toEqual(["reviewed", "reviewed", "reviewed"]);

    const reviewers = await graphFor(false);
    expect(byCode(reviewers, "INT-03")).toMatchObject({ status: "proposed" });
    expect(reviewers.nodes.some((n) => "status" in n && n.status === "reviewed")).toBe(false);
    expect(reviewers.edges.some((e) => e.status === "reviewed")).toBe(false);
    expect(reviewers.counts.concepts).toEqual({ total: 6, reviewed: 0, confirmed: 0 });
  });

  it("shows an objection as proposed, a second confirmation as confirmed, and drops what is rejected", async () => {
    const [ada, ben] = [await person("reviewer"), await person("reviewer")];
    const before = await graphFor(true);

    await decide(ada.id, card(before, "INT-02"), { decision: "confirm", reasonCode: "matches-curriculum" });
    await decide(ben.id, card(before, "INT-02"), { decision: "confirm", reasonCode: "agrees-with-review" }, "confirmation");
    await decide(ada.id, card(before, "INT-04"), { decision: "needs-change", reason: "Too broad." });
    const mistake = byCode(before, "MIS-032");
    await decide(ada.id, { objectId: mistake.id, objectKind: "misconception" }, { decision: "reject", reason: "Not a mistake learners make here." });

    const after = await graphFor(true);
    expect(byCode(after, "INT-02")).toMatchObject({ status: "confirmed" });
    expect(byCode(after, "INT-04")).toMatchObject({ status: "proposed" });
    expect(after.nodes.some((n) => n.id === mistake.id)).toBe(false);
    expect(after.edges.some((e) => e.source === mistake.id)).toBe(false);
    expect(after.counts).toMatchObject({
      concepts: { total: 6, reviewed: 0, confirmed: 1 },
      mistakes: { total: 1, reviewed: 0, confirmed: 0 },
    });
  });
});

describe("teaching plans on the graph", () => {
  /** Two invented plans: one places topics by term, the other also by week, and one family directly. */
  async function plans() {
    const { node, family, educationLevel, teachingPlan, placement } = schema;
    const [grade8] = await db
      .select()
      .from(educationLevel)
      .where(and(eq(educationLevel.frameworkId, frameworkId), eq(educationLevel.code, "8")));
    const nodeId = async (code: string) => (await db.select().from(node).where(eq(node.humanCode, code)))[0]!.id;
    const [mea] = await db.select().from(family).where(and(eq(family.frameworkId, frameworkId), eq(family.humanCode, "MEA")));
    const plan = async (slug: string, title: string) =>
      (await db.insert(teachingPlan).values({ frameworkId, slug, title: { en: title } }).returning())[0]!;
    const yearly = await plan("yearly", "Yearly plan: terms and hours");
    const weekly = await plan("weekly", "Weekly plan: terms, weeks and hours");
    const place = (planId: string, targetId: string, targetKind: "node" | "family", at: { term: number; weekStart?: number; weekEnd?: number; hours?: string }) =>
      db.insert(placement).values({ teachingPlanId: planId, targetId, targetKind, educationLevelId: grade8!.id, ...at });
    await place(yearly.id, await nodeId("1.3"), "node", { term: 1, hours: "9.0" });
    await place(yearly.id, await nodeId("2.4"), "node", { term: 2 });
    await place(weekly.id, await nodeId("1.3"), "node", { term: 1, weekStart: 3, weekEnd: 4, hours: "9.0" });
    await place(weekly.id, await nodeId("2.4"), "node", { term: 3, weekStart: 1, weekEnd: 1 });
    await place(weekly.id, mea!.id, "family", { term: 4 });
  }

  it("say when each plan teaches a concept: through the topic that defines it, or its family", async () => {
    await plans();
    const graph = await graphFor(false);
    expect(graph.plans.map((p) => p.slug)).toEqual(["yearly", "weekly"]);
    expect((byCode(graph, "INT-03") as ConceptNode).when).toEqual({
      yearly: { term: 1, weekStart: null, weekEnd: null, hours: 9, of: "1.3 Integers" },
      weekly: { term: 1, weekStart: 3, weekEnd: 4, hours: 9, of: "1.3 Integers" },
    });
    expect((byCode(graph, "ALG-05") as ConceptNode).when.weekly).toMatchObject({ term: 3, of: "2.4 Equations" });
    expect((byCode(graph, "MEA-01") as ConceptNode).when).toEqual({
      weekly: { term: 4, weekStart: null, weekEnd: null, hours: null, of: "MEA" },
    });
    // A heading is taught when it, or a heading above it, is placed.
    expect(graph.nodes.find((n) => n.kind === "topic" && n.code === "1.3")).toMatchObject({ when: { yearly: { term: 1 } } });
    expect(graph.nodes.find((n) => n.kind === "topic" && n.code === "1")).toMatchObject({ when: {} });
  });

  it("list what moves to another term from one plan to the next", async () => {
    await plans();
    const graph = await graphFor(false);
    const changes = termChanges(graph, "yearly", "weekly");
    expect(changes.map((c) => ({ ...c, concepts: c.concepts.map((n) => n.code) }))).toEqual([
      { of: "2.4 Equations", fromTerm: 2, toTerm: 3, concepts: ["ALG-05"] },
    ]);
    expect(termChanges(graph, "weekly", "weekly")).toEqual([]);
  });

  it("describe a placement in words, and colour a concept by its term", () => {
    const at = { term: 2, weekStart: 1, weekEnd: 2, hours: 9, of: "1.2 Exponents" };
    expect(whenText(at)).toBe("Term 2, weeks 1–2");
    expect(whenText(at, { short: true })).toBe("T2 wk 1–2");
    expect(whenText({ ...at, weekEnd: 1 })).toBe("Term 2, week 1");
    expect(whenText({ ...at, weekStart: null, weekEnd: null })).toBe("Term 2");
    expect(whenText(undefined)).toBe("not placed");
    expect(termColour(2)).not.toBe(termColour(1));
    expect(termColour(undefined)).toBe(unplaced);
  });
});

describe("the map's layout", () => {
  it("places every node, and the same data always gives the same picture", async () => {
    const graph = await graphFor(true);
    const first = layOut(graph);
    expect(Object.keys(first).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
    for (const { x, y } of Object.values(first)) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
    expect(layOut(await graphFor(false))).toEqual(first);
  });
});

describe("lookups and looks", () => {
  it("give each line, mistake and heading the families of the concepts it leads to", async () => {
    const graph = await graphFor(true);
    const relations = new Relations(graph);
    const solve = graph.nodes.find((n) => n.kind === "statement" && n.text.startsWith("Solve simple equations"))!;
    expect(relations.families(solve.id)).toEqual(["ALG"]);
    expect(relations.families(byCode(graph, "MIS-031").id)).toEqual(["INT"]);
    expect(relations.families(byCode(graph, "1").id)).toEqual(["INT"]);
    const needs = relations.edgesInto(byCode(graph, "ALG-05").id, "needs")[0]!;
    expect(relations.edgeFamilies(needs).sort()).toEqual(["ALG", "INT"]);
  });

  it("colour families in curriculum order and never reuse a colour", () => {
    const families = Array.from({ length: 9 }, (_, i) => ({ code: `F${i}`, title: `Family ${i}` }));
    const colours = familyColours(families);
    expect(Object.values(colours).slice(0, 7)).toEqual(familyPalette);
    expect([colours.F7, colours.F8]).toEqual([otherFamily, otherFamily]);
  });

  it("draw a proposed concept hollow and a confirmed one solid", async () => {
    const graph = await graphFor(true);
    const concept = byCode(graph, "INT-01") as ConceptNode;
    const colours = familyColours(graph.families);
    const proposed = nodeLook(concept, colours);
    const confirmed = nodeLook({ ...concept, status: "confirmed" }, colours);
    expect(proposed.borderColor).toBe(colours.INT);
    expect(proposed.color).not.toBe(colours.INT);
    expect(confirmed.color).toBe(colours.INT);
  });
});

it("lists frameworks with the most concepts first", async () => {
  const frameworks = await frameworksWithConcepts(db);
  expect(frameworks).toEqual([{ id: frameworkId, slug: "xx-example/mathematics", title: "Example Curriculum: Mathematics", concepts: 6 }]);
});
