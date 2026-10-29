import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Db, type Decision, schema } from "@ocg/db";
import { freshTestDb } from "@ocg/db/testing";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePages, recordCheck } from "../src/checks";
import { type DraftFile, loadDraft } from "../src/draft";
import { readBase } from "../src/files";
import { importBase } from "../src/import";
import { mintBase } from "../src/mint";
import { buildRelease, type Release, readReleaseConfig, specValidator, writeRelease } from "../src/release";

// An invented curriculum, imported and drafted, then partly confirmed by two
// reviewers: the tests are about what a release holds and leaves out.

const SLUG = "xx-release/mathematics";
const DOC_TITLE = "Example Curriculum, Senior Phase";
let db: Db;
let dir: string;
let out: string;
const ids: Record<string, string> = {};
const reviewers = { ada: "", ben: "" };

const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

beforeAll(async () => {
  db = await freshTestDb();
  dir = await mkdtemp(path.join(tmpdir(), "ocg-release-base-"));
  out = await mkdtemp(path.join(tmpdir(), "ocg-release-out-"));
  await writeBase(dir);
  await mintBase(dir);
  await importBase(db, await readBase(dir));
  await loadDraft(db, draft());
  await reviewersWithPublicNames();
  await findIds();
  await confirmAllBut(["C-3", "M-2"]);
  await plantConfirmedControl();
});
afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

async function writeBase(at: string) {
  await mkdir(path.join(at, "documents"), { recursive: true });
  await mkdir(path.join(at, "teaching-plans"), { recursive: true });
  await mkdir(path.join(at, "statements", "grade-8"), { recursive: true });
  await writeFile(
    path.join(at, "framework.json"),
    json({
      slug: SLUG,
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
      title: DOC_TITLE,
      language: "en",
      pdf: { sha256: "a".repeat(64), pages: 40, printedPageOffset: 2 },
      nodes: [{ type: "content-area", code: "1", title: "Numbers", children: [{ type: "topic", code: "1.3", title: "Signed numbers" }] }],
    }),
  );
  await writeFile(
    path.join(at, "teaching-plans", "example-plan.json"),
    json({
      slug: "example-plan",
      title: { en: "Example plan" },
      document: "example-curriculum",
      placements: [{ node: "1.3", asPrinted: "SIGNED NUMBERS", grade: "8", term: 1, weekStart: 1, weekEnd: 2, hours: 9 }],
    }),
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
            { label: "Revise:", revise: true, text: "Order signed numbers", page: 12 },
            { text: "Add signed numbers", page: 12 },
            { text: "Subtract signed numbers", page: 12 },
          ],
        },
      ],
      notes: [
        {
          heading: "Calculating with signed numbers",
          statements: [
            { text: "Learners often think subtracting a negative makes a number smaller.", page: 12, note: "\"Learners\" is printed with a capital." },
            { text: "5 – (–3) = 8", page: 12, eyeChecked: true },
          ],
        },
      ],
    }),
  );
  await writeFile(
    path.join(at, "release.json"),
    json({
      license: { id: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
      attribution: ["Example Mathematics, an invented base for tests."],
      reviewPolicy: { minReviewers: 2 },
    }),
  );
}

function draft(): DraftFile {
  return {
    framework: SLUG,
    source: { model: "test-model", promptVersion: "draft-v1" },
    families: [{ code: "F-1", title: { en: "Signed numbers" } }],
    concepts: [
      { code: "C-1", family: "F-1", title: { en: "order signed numbers" }, kind: "procedure", gateway: false, definedBy: ["8/1.3/c02"], rationale: "Ordering comes first." },
      { code: "C-2", family: "F-1", title: { en: "add signed numbers" }, kind: "procedure", gateway: false, definedBy: ["8/1.3/c02"], rationale: "The line names adding." },
      { code: "C-3", family: "F-1", title: { en: "subtract signed numbers" }, kind: "procedure", gateway: true, definedBy: ["8/1.3/c03"], rationale: "The line names subtracting." },
      { code: "C-4", family: "F-1", title: { en: "a planted wrong concept" }, kind: "fact", gateway: false, definedBy: ["8/1.3/c03"], rationale: "Planted." },
    ],
    misconceptions: [
      { code: "M-1", statement: { en: "a bigger digit is always a bigger number" }, hinders: ["C-1"], evidence: null, rationale: "Common." },
      { code: "M-2", statement: { en: "subtracting a negative makes it smaller" }, hinders: ["C-3"], evidence: "8/1.3/n01", rationale: "The note names it." },
    ],
    needs: [
      { from: "C-2", to: "C-1", rationale: "Adding on a number line uses order." },
      { from: "C-3", to: "C-2", rationale: "Subtraction is taught through addition." },
    ],
  };
}

async function reviewersWithPublicNames() {
  for (const [key, name, publicName] of [
    ["ada", "Ada Realname", "A. Example"],
    ["ben", "Ben Realname", "B. Sample"],
  ] as const) {
    const id = randomUUID();
    await db.insert(schema.user).values({ id, name, email: `${key}@example.org`, role: "reviewer" });
    await db.insert(schema.reviewerProfile).values({ userId: id, publicName });
    reviewers[key] = id;
  }
}

async function findIds() {
  for (const t of [schema.family, schema.concept, schema.misconception]) {
    for (const r of await db.select({ id: t.id, code: t.humanCode }).from(t)) ids[r.code] = r.id;
  }
}

async function judge(objectId: string, objectKind: "family" | "concept" | "misconception" | "link", reviewerId: string, decision: Decision = "confirm") {
  const table = { family: schema.family, concept: schema.concept, misconception: schema.misconception, link: schema.link }[objectKind];
  const [{ revision }] = (await db.select({ revision: table.revision }).from(table).where(eq(table.id, objectId))) as [{ revision: number }];
  await db.insert(schema.judgement).values({
    objectId,
    objectKind,
    objectRevision: revision,
    reviewerId,
    decision,
    reasonCode: decision === "confirm" ? "fails-without-it" : null,
    reason: decision === "confirm" ? null : "Not right.",
    evidence: {},
  });
}

const twice = async (id: string, kind: "family" | "concept" | "misconception" | "link") => {
  await judge(id, kind, reviewers.ada);
  await judge(id, kind, reviewers.ben);
};

/** Confirms every family, concept and mistake but those named, and every link. */
async function confirmAllBut(skip: string[]) {
  for (const code of ["F-1", "C-1", "C-2", "C-3", "M-1", "M-2"].filter((c) => !skip.includes(c))) {
    await twice(ids[code]!, code.startsWith("F") ? "family" : code.startsWith("M") ? "misconception" : "concept");
  }
  for (const l of await db.select({ id: schema.link.id }).from(schema.link)) await twice(l.id, "link");
}

/** C-4 is a planted control. A control never counts towards a status, so force one to test that it is still left out. */
async function plantConfirmedControl() {
  await db.insert(schema.planted).values({ objectId: ids["C-4"]!, objectKind: "concept", note: "Wrong on purpose.", plantedBy: reviewers.ada });
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('ocg.deriving_status', 'on', true)`);
    await tx.update(schema.concept).set({ status: "confirmed" }).where(eq(schema.concept.id, ids["C-4"]!));
  });
}

const build = async (version = "0.1.0", previousDir?: string): Promise<Release> =>
  buildRelease(db, SLUG, await readReleaseConfig(dir), { version, released: "2026-11-01", previousDir });

const codes = (rows: unknown) => (rows as { code: string }[]).map((r) => r.code);

describe("a release from the working database", () => {
  it("holds only confirmed interpretation, without planted controls", async () => {
    const r = await build();
    expect(codes(r.files.concepts)).toEqual(["C-1", "C-2"]);
    expect(codes(r.files.misconceptions)).toEqual(["M-1"]);
    expect(codes(r.files.families)).toEqual(["F-1"]);
  });

  it("keeps only links whose ends are both released", async () => {
    const r = await build();
    const released = new Set([ids["C-1"], ids["C-2"], ids["F-1"], ids["M-1"]]);
    const links = r.files.links as { linkType: string; from: string; to: string; fromKind: string }[];
    expect(links.map((l) => l.linkType).sort()).toEqual(["defines", "defines", "hinders", "needs", "part-of", "part-of"]);
    for (const l of links) {
      expect(released.has(l.to)).toBe(true);
      if (l.fromKind !== "statement") expect(released.has(l.from)).toBe(true);
    }
  });

  it("holds the whole transcription, with labels, headings, notes and as-printed headings", async () => {
    const r = await build();
    const statements = r.files.statements as Record<string, unknown>[];
    expect(statements).toHaveLength(5);
    expect(statements[0]).toMatchObject({ code: "8/1.3/c01", label: "Revise:", heading: "Calculating with signed numbers", revise: true });
    expect(statements.find((x) => x.code === "8/1.3/n01")).toMatchObject({ note: { en: "\"Learners\" is printed with a capital." } });
    expect(r.files.placements).toEqual([expect.objectContaining({ asPrinted: "SIGNED NUMBERS", hours: 9, weekStart: 1, weekEnd: 2 })]);
    expect((r.files.documents as Record<string, unknown>[])[0]).toMatchObject({ file: { sha256: "a".repeat(64), pages: 40, printedPageOffset: 2 } });
  });

  it("says how a line was verified only once the machine check is on record", async () => {
    const before = (await build()).files.statements as Record<string, unknown>[];
    expect(before.some((x) => "verifiedBy" in x)).toBe(false);

    await recordCheck(db, { frameworkSlug: SLUG, documentTitle: DOC_TITLE, method: "machine", on: "2026-10-30" });
    await recordCheck(db, { frameworkSlug: SLUG, documentTitle: DOC_TITLE, method: "person", pages: parsePages("12"), on: "2026-10-31", by: "S. Steward" });
    const r = await build();
    const after = r.files.statements as Record<string, unknown>[];
    expect(after.find((x) => x.code === "8/1.3/n02")?.verifiedBy).toBe("eye");
    expect(after.find((x) => x.code === "8/1.3/c02")?.verifiedBy).toBe("text-layer");
    expect((r.files.documents as Record<string, unknown>[])[0]!.checks).toEqual([
      { method: "machine", date: "2026-10-30" },
      { method: "person", pages: [12], date: "2026-10-31", by: "S. Steward" },
    ]);
  });

  it("summarises each review under the reviewers' public names, never their real ones", async () => {
    const r = await build();
    const reviews = r.files.reviews as { object: string; reviewers: string[]; judgements: number; status: string }[];
    expect(reviews.find((x) => x.object === ids["C-1"])).toMatchObject({ reviewers: ["A. Example", "B. Sample"], judgements: 2, status: "confirmed" });
    expect(JSON.stringify(r)).not.toContain("Realname");
  });

  it("is deterministic: the same database gives the same bytes", async () => {
    const a = path.join(out, "a");
    const b = path.join(out, "b");
    await writeRelease(a, await build());
    await writeRelease(b, await build());
    for (const f of ["manifest.json", "statements.json", "links.json", "reviews.json"]) {
      expect(await readFile(path.join(a, f), "utf8")).toBe(await readFile(path.join(b, f), "utf8"));
    }
  });

  // Skipped only on a machine with no spec checkout; in CI, a missing validator fails the test.
  it.skipIf(!process.env.CI && !process.env.OCG_SPEC_DIR && !specValidator())("conforms to the specification's reference validator", async () => {
    const at = path.join(out, "conforms");
    await writeRelease(at, await build());
    const cli = specValidator();
    expect(cli).not.toBeNull();
    const v = spawnSync(process.execPath, [cli!, "release", at], { encoding: "utf8" });
    expect(v.stdout).toContain("conforms (0 errors");
    expect(v.status).toBe(0);
  });
});

describe("a release after another", () => {
  it("names the release before it", async () => {
    const first = path.join(out, "first");
    await writeRelease(first, await build("0.1.0"));
    const r = await build("0.1.1", first);
    expect(r.manifest.previous).toBe("0.1.0");
    expect(r.files.retired).toEqual([]);
  });

  it("refuses to drop an object the previous release held without retiring it", async () => {
    const first = path.join(out, "before-edit");
    await writeRelease(first, await build("0.1.0"));
    // A change to its content sends C-2 back to proposed.
    await db.update(schema.concept).set({ title: { en: "add signed numbers on a number line" } }).where(eq(schema.concept.id, ids["C-2"]!));
    const [c2] = await db.select().from(schema.concept).where(and(eq(schema.concept.id, ids["C-2"]!)));
    expect(c2?.status).toBe("proposed");
    await expect(build("0.1.1", first)).rejects.toThrow(/without retiring them[\s\S]*concept/);
    await twice(ids["C-2"]!, "concept");
    expect(codes((await build("0.1.1", first)).files.concepts)).toEqual(["C-1", "C-2"]);
  });
});
