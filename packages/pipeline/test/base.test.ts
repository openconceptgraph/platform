import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Db, schema } from "@ocg/db";
import { freshTestDb } from "@ocg/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DraftFile, loadDraft, readDraft } from "../src/draft";
import { readBase } from "../src/files";
import { importBase } from "../src/import";
import { mintBase } from "../src/mint";

// An invented curriculum, written to a temporary folder as a base would hold
// it: the tests are about the pipeline, not the content.

let db: Db;
let dir: string;
beforeAll(async () => {
  db = await freshTestDb();
  dir = await mkdtemp(path.join(tmpdir(), "ocg-base-"));
  await writeBase(dir);
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

async function writeBase(at: string) {
  await mkdir(path.join(at, "documents"), { recursive: true });
  await mkdir(path.join(at, "teaching-plans"), { recursive: true });
  await mkdir(path.join(at, "statements", "grade-8"), { recursive: true });
  await writeFile(
    path.join(at, "framework.json"),
    json({
      slug: "xx-example/mathematics",
      title: { en: "Example Mathematics" },
      jurisdiction: "XX",
      subject: "mathematics",
      nodeTypes: ["content-area", "topic"],
      educationLevels: [{ code: "8", title: { en: "Grade 8" }, iscedLevel: 2, ordinal: 8 }],
    }),
  );
  await writeFile(
    path.join(at, "documents", "example-curriculum.json"),
    json({
      title: "Example Curriculum, Senior Phase",
      language: "en",
      nodes: [{ type: "content-area", code: "1", title: "Numbers", children: [{ type: "topic", code: "1.3", title: "Signed numbers" }] }],
    }),
  );
  await writeFile(
    path.join(at, "teaching-plans", "example-plan.json"),
    json({ slug: "example-plan", title: { en: "Example plan" }, document: "example-curriculum", placements: [{ node: "1.3", grade: "8", term: 1, hours: 9 }] }),
  );
  await writeFile(
    path.join(at, "statements", "grade-8", "1.3-signed-numbers.json"),
    json({
      document: "example-curriculum",
      grade: "8",
      term: 1,
      topic: "1.3",
      pages: [12],
      concepts: [
        {
          heading: "Calculating with signed numbers",
          statements: [
            { label: "Revise:", revise: true, text: "Add and subtract signed numbers", page: 12 },
            { text: "Multiply signed numbers", page: 12 },
            { text: "Divide signed numbers", page: 12 },
          ],
        },
      ],
      notes: [{ statements: [{ text: "Develop the sign rules from patterns.", page: 12 }] }],
    }),
  );
}

const statementsFile = () => path.join(dir, "statements", "grade-8", "1.3-signed-numbers.json");

describe("minting", () => {
  it("gives every object an ID and every statement a code, once", async () => {
    const first = await mintBase(dir);
    expect(first.reduce((n, r) => n + r.ids, 0)).toBe(1 + 1 + 1 + 2 + 1 + 1 + 4);
    const topic = JSON.parse(await readFile(statementsFile(), "utf8"));
    expect(topic.concepts[0].statements.map((s: { code: string }) => s.code)).toEqual(["8/1.3/c01", "8/1.3/c02", "8/1.3/c03"]);
    expect(topic.notes[0].statements[0].code).toBe("8/1.3/n01");

    const again = await mintBase(dir);
    expect(again.every((r) => r.ids === 0 && r.codes === 0)).toBe(true);
    expect(JSON.parse(await readFile(statementsFile(), "utf8"))).toEqual(topic);
  });

  it("numbers a statement added later after the existing ones", async () => {
    const topic = JSON.parse(await readFile(statementsFile(), "utf8"));
    topic.concepts[0].statements.splice(1, 0, { text: "Order signed numbers", page: 12 });
    await writeFile(statementsFile(), json(topic));
    await mintBase(dir);
    const minted = JSON.parse(await readFile(statementsFile(), "utf8"));
    expect(minted.concepts[0].statements[1].code).toBe("8/1.3/c04");
    expect(minted.concepts[0].statements[0].code).toBe("8/1.3/c01");
  });
});

describe("importing a transcription", () => {
  it("loads every object under the ID its file gives it", async () => {
    const base = await readBase(dir);
    const report = await importBase(db, base);
    expect(report.statements).toEqual({ added: 5, changed: 0, unchanged: 0 });
    expect(report.placements).toEqual({ added: 1, changed: 0, unchanged: 0 });

    const id = base.topics[0]!.data.concepts[0]!.statements[2]!.id!;
    const [row] = await db.select().from(schema.statement).where(eq(schema.statement.id, id));
    expect(row).toMatchObject({
      humanCode: "8/1.3/c02",
      text: "Multiply signed numbers",
      page: 12,
      statementType: "content",
      locator: "Grade 8, Term 1 · Concepts and skills · Calculating with signed numbers",
    });
    const [revise] = await db.select().from(schema.statement).where(eq(schema.statement.humanCode, "8/1.3/c01"));
    expect(revise?.isRevision).toBe(true);
  });

  it("changes nothing when run again, and counts a corrected statement as a new revision", async () => {
    expect((await importBase(db, await readBase(dir))).statements).toEqual({ added: 0, changed: 0, unchanged: 5 });

    const topic = JSON.parse(await readFile(statementsFile(), "utf8"));
    topic.concepts[0].statements[2].text = "Multiply and divide signed numbers";
    await writeFile(statementsFile(), json(topic));
    expect((await importBase(db, await readBase(dir))).statements).toEqual({ added: 0, changed: 1, unchanged: 4 });
    const [row] = await db.select().from(schema.statement).where(eq(schema.statement.humanCode, "8/1.3/c02"));
    expect(row?.revision).toBe(2);
  });

  it("refuses to lose a statement the files no longer hold", async () => {
    const topic = JSON.parse(await readFile(statementsFile(), "utf8"));
    const removed = topic.concepts[0].statements.pop();
    await writeFile(statementsFile(), json(topic));
    await expect(importBase(db, await readBase(dir))).rejects.toThrow(/no longer in the files.*retire/);
    topic.concepts[0].statements.push(removed);
    await writeFile(statementsFile(), json(topic));
  });

  it("places a curriculum's topic from another document's teaching plan", async () => {
    await writeFile(
      path.join(dir, "documents", "example-annual-plan.json"),
      json({ title: "Example Annual Teaching Plan, Grade 8", language: "en", nodes: [] }),
    );
    const plan = path.join(dir, "teaching-plans", "example-annual.json");
    const placement = { document: "example-curriculum", node: "1.3", asPrinted: "SIGNED NUMBERS", grade: "8", term: 2, weekStart: 1, weekEnd: 2, hours: 9 };
    await writeFile(plan, json({ slug: "example-annual", title: { en: "Example annual plan" }, document: "example-annual-plan", placements: [placement] }));
    await mintBase(dir);
    const base = await readBase(dir);
    expect((await importBase(db, base)).placements).toEqual({ added: 1, changed: 0, unchanged: 1 });

    const minted = JSON.parse(await readFile(plan, "utf8"));
    const [row] = await db.select().from(schema.placement).where(eq(schema.placement.id, minted.placements[0].id));
    const topic = base.documents.find((d) => d.name === "example-curriculum")!.data.nodes[0]!.children![0]!;
    expect(row).toMatchObject({ targetId: topic.id, targetKind: "node", term: 2, weekStart: 1, weekEnd: 2, hours: "9.0" });
    const [annual] = await db.select().from(schema.teachingPlan).where(eq(schema.teachingPlan.slug, "example-annual"));
    const annualDoc = base.documents.find((d) => d.name === "example-annual-plan")!.data.id;
    expect(annual?.documentId).toBe(annualDoc);

    await writeFile(plan, json({ ...minted, placements: [{ ...minted.placements[0], document: "example-annual-plan" }] }));
    await expect(readBase(dir)).rejects.toThrow(/no node 1.3 in example-annual-plan/);
    await writeFile(plan, json(minted));
  });

  it("refuses files without their IDs", async () => {
    const topic = JSON.parse(await readFile(statementsFile(), "utf8"));
    topic.notes[0].statements.push({ text: "A new note.", page: 12 });
    await writeFile(statementsFile(), json(topic));
    await expect(importBase(db, await readBase(dir))).rejects.toThrow(/pnpm base mint/);
    topic.notes[0].statements.pop();
    await writeFile(statementsFile(), json(topic));
  });
});

const draft = (): DraftFile => ({
  framework: "xx-example/mathematics",
  source: { model: "test-model", promptVersion: "draft-concepts/v1" },
  families: [{ code: "SGN", title: { en: "Signed numbers" } }],
  concepts: [
    { code: "SGN-01", family: "SGN", title: { en: "multiply signed numbers" }, kind: "procedure", gateway: true, definedBy: ["8/1.3/c02"], rationale: "One rule, one mistake." },
    { code: "SGN-02", family: "SGN", title: { en: "divide signed numbers" }, kind: "procedure", gateway: false, definedBy: ["8/1.3/c03"], rationale: "Its own mistake." },
  ],
  misconceptions: [
    { code: "MIS-SGN-01", statement: { en: "Two negatives make a negative." }, hinders: ["SGN-01"], evidence: "8/1.3/n01", rationale: "Named in the notes." },
    { code: "MIS-SGN-02", statement: { en: "The quotient takes the dividend's sign." }, hinders: ["SGN-02"], evidence: null, rationale: "Unsourced." },
  ],
  needs: [{ from: "SGN-02", to: "SGN-01", rationale: "Division is developed from multiplication." }],
});

describe("loading an AI draft", () => {
  it("loads everything as proposed, each link sourced to the drafting run", async () => {
    const report = await loadDraft(db, draft());
    expect(report).toMatchObject({ families: 1, concepts: 2, misconceptions: 2, unsourcedMistakes: 1 });
    expect(report.links).toEqual({ "part-of": 2, defines: 2, hinders: 2, needs: 1 });

    const concepts = await db.select().from(schema.concept);
    expect(concepts.map((c) => c.status)).toEqual(["proposed", "proposed"]);
    const [needs] = await db.select().from(schema.link).where(eq(schema.link.linkType, "needs"));
    const [source] = await db.select().from(schema.source).where(eq(schema.source.id, needs!.sourceId));
    expect(source).toMatchObject({ kind: "ai", model: "test-model", promptVersion: "draft-concepts/v1" });
    expect(needs?.confidence).toBeNull();
  });

  it("cites the curriculum for a mistake it names, and flags the others unsourced", async () => {
    const [named] = await db.select().from(schema.misconception).where(eq(schema.misconception.humanCode, "MIS-SGN-01"));
    const [evidence] = await db.select().from(schema.source).where(eq(schema.source.id, named!.sourceId!));
    expect(evidence?.kind).toBe("statement");
    const [unsourced] = await db.select().from(schema.misconception).where(eq(schema.misconception.humanCode, "MIS-SGN-02"));
    expect(unsourced?.sourceId).toBeNull();
  });

  it("changes nothing when loaded again, and updates what a revised draft changes", async () => {
    await loadDraft(db, draft());
    const revisions = async () => (await db.select({ r: schema.concept.revision }).from(schema.concept)).map((c) => c.r);
    expect(await revisions()).toEqual([1, 1]);

    const revised = draft();
    revised.concepts[1]!.title = { en: "divide signed numbers using the sign rules" };
    await loadDraft(db, revised);
    const [c] = await db.select().from(schema.concept).where(eq(schema.concept.humanCode, "SGN-02"));
    expect(c).toMatchObject({ revision: 2, status: "proposed" });
  });

  it("is refused a prerequisite loop by the database", async () => {
    const looped = draft();
    looped.needs.push({ from: "SGN-01", to: "SGN-02", rationale: "A loop." });
    await expect(loadDraft(db, looped)).rejects.toThrow();
    const needs = await db.select().from(schema.link).where(and(eq(schema.link.linkType, "needs")));
    expect(needs).toHaveLength(1);
  });

  it("refuses a draft with a concept that has no typical mistake", async () => {
    const file = path.join(dir, "draft.json");
    const d = draft();
    d.misconceptions.pop();
    await writeFile(file, json(d));
    await expect(readDraft(file)).rejects.toThrow(/SGN-02: no typical mistake/);
  });
});
