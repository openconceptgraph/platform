import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OverlayDb } from "../src/client";
import { exportOverlay } from "../src/export";
import { type Overlay, OVERLAY_FILES, readOverlay, writeOverlay } from "../src/files";
import { importOverlay } from "../src/import";
import * as s from "../src/schema";
import { freshOverlayTestDb } from "../src/testing";
import { specValidator } from "../src/where";

// An invented client's overlay, pinned to an invented base: the tests are
// about the records going in and out, not about any real client's content.

let db: OverlayDb;
let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "ocg-overlay-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  db = await freshOverlayTestDb();
});
afterEach(async () => {
  await db.close();
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = { concept: id(901), otherConcept: id(902), mistake: id(903), statement: id(904), grade8: id(905) };
const L1 = id(1);
const L2 = id(2);
const Q1 = id(3);
const R1 = id(4);
const PLAN = id(50);

function fixture(): Overlay {
  return {
    manifest: {
      spec: "0.1.1",
      kind: "overlay",
      client: { namespace: "example-school", name: "Example School" },
      base: { slug: "xx-example/mathematics", framework: id(900), version: "0.1.0-draft.1", manifestSha256: "b".repeat(64) },
      updated: "2026-10-30",
    },
    profile: {
      type: "ClientProfile",
      namespace: "example-school",
      name: "Example School",
      artefactKinds: [
        { kind: "lesson", label: { en: "Lesson" }, alignments: ["teaches", "assumes", "covers"], learningResourceType: "lesson plan" },
        { kind: "question", label: { en: "Exit-ticket question" }, alignments: ["tests", "reveals"], learningResourceType: "assessment item" },
        { kind: "reference", label: { en: "Reference notes" }, description: { en: "The school's approved notes." }, alignments: ["explains"] },
      ],
    },
    artefacts: [
      { id: L1, type: "Artefact", namespace: "example-school", kind: "lesson", code: "EX-L01", title: { en: "Lesson 1: Counting with signs" }, language: "en", ordinal: 1, ref: "lessons/01" },
      { id: Q1, type: "Artefact", namespace: "example-school", kind: "question", code: "EX-L01-Q1", title: { en: "Lesson 1, question 1" }, language: "en", parent: L1, ordinal: 1 },
      { id: L2, type: "Artefact", namespace: "example-school", kind: "lesson", code: "EX-L02", title: { en: "Lesson 2: Taking away a negative" }, language: "en", ordinal: 2, url: "https://example.org/lessons/02" },
      { id: R1, type: "Artefact", namespace: "example-school", kind: "reference", code: "EX-REF-1", title: { en: "Notes: the number line" }, language: "en" },
    ],
    alignments: [
      {
        id: id(11),
        type: "Alignment",
        artefact: L1,
        alignmentType: "teaches",
        target: base.concept,
        targetKind: "concept",
        source: { kind: "ai", model: "example-model", promptVersion: "tag-v1", date: "2026-10-29" },
        status: "proposed",
        confidence: 0.82,
        rationale: { en: "The lesson's examples all add signed numbers." },
      },
      { id: id(12), type: "Alignment", artefact: L1, alignmentType: "assumes", target: base.otherConcept, targetKind: "concept", source: { kind: "person", by: "Teacher A", date: "2026-10-30" }, status: "confirmed" },
      { id: id(13), type: "Alignment", artefact: L1, alignmentType: "covers", target: base.statement, targetKind: "statement", source: { kind: "import" }, status: "confirmed" },
      { id: id(14), type: "Alignment", artefact: Q1, alignmentType: "tests", target: base.concept, targetKind: "concept", source: { kind: "person", by: "Teacher A" }, status: "confirmed" },
      { id: id(15), type: "Alignment", artefact: Q1, part: "option B", alignmentType: "reveals", target: base.mistake, targetKind: "misconception", source: { kind: "ai", model: "example-model", promptVersion: "tag-v1" }, status: "proposed", confidence: 0.6 },
      { id: id(16), type: "Alignment", artefact: R1, alignmentType: "explains", target: base.concept, targetKind: "concept", source: { kind: "person", by: "Teacher B" }, status: "confirmed" },
    ],
    plans: [{ id: PLAN, type: "OverlayPlan", namespace: "example-school", slug: "term-1", title: { en: "Example School, Term 1" } }],
    placements: [
      { id: id(21), type: "OverlayPlacement", plan: PLAN, artefact: L1, educationLevel: base.grade8, term: 1, weekStart: 1, weekEnd: 1, hours: 1.5, ordinal: 1 },
      { id: id(22), type: "OverlayPlacement", plan: PLAN, artefact: L2, educationLevel: base.grade8, term: 1, weekStart: 2, weekEnd: 2, ordinal: 2 },
    ],
  };
}

/** Writes a bundle and reads it back, as an import would. */
async function bundle(o: Overlay, name: string): Promise<Overlay> {
  const dir = path.join(tmp, name);
  await writeOverlay(dir, o);
  return readOverlay(dir);
}

const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));

describe("an overlay in and out of a workspace", () => {
  it("comes out as it went in", async () => {
    const report = await importOverlay(db, await bundle(fixture(), "in"));
    expect(report.profile).toBe("created");
    expect(report.referenceKindAdded).toBe(false);
    expect(report.counts.alignments).toEqual({ added: 6, changed: 0, unchanged: 0, kept: 0 });

    const out = await exportOverlay(db, { updated: "2026-10-30" });
    const f = fixture();
    expect(out.manifest).toEqual(f.manifest);
    expect(out.profile).toEqual(f.profile);
    for (const key of ["artefacts", "alignments", "plans", "placements"] as const) {
      expect(byId(out[key] as { id: string }[])).toEqual(byId(f[key] as { id: string }[]));
    }
    // Parents before children; siblings in order.
    expect(out.artefacts.map((a) => a.code)).toEqual(["EX-L01", "EX-L01-Q1", "EX-L02", "EX-REF-1"]);
  });

  it("gives the same bytes from the same workspace, and changes nothing when its own export is loaded again", async () => {
    await importOverlay(db, await bundle(fixture(), "in"));
    await writeOverlay(path.join(tmp, "a"), await exportOverlay(db, { updated: "2026-10-30" }));
    await writeOverlay(path.join(tmp, "b"), await exportOverlay(db, { updated: "2026-10-30" }));
    for (const file of ["manifest.json", ...Object.values(OVERLAY_FILES)]) {
      expect(await readFile(path.join(tmp, "a", file), "utf8")).toBe(await readFile(path.join(tmp, "b", file), "utf8"));
    }
    const again = await importOverlay(db, await readOverlay(path.join(tmp, "a")));
    expect(again.profile).toBe("unchanged");
    for (const c of Object.values(again.counts)) expect(c.added + c.changed).toBe(0);
  });

  it("adds and updates what a partial bundle holds, and keeps the rest", async () => {
    await importOverlay(db, await bundle(fixture(), "in"));
    const f = fixture();
    const L3 = id(5);
    const partial: Overlay = {
      ...f,
      artefacts: [
        { ...f.artefacts.find((a) => a.id === L2)!, title: { en: "Lesson 2: Subtracting a negative number" } },
        { id: L3, type: "Artefact", namespace: "example-school", kind: "lesson", code: "EX-L03", title: { en: "Lesson 3: Drafted by a tool" }, language: "en", ordinal: 3 },
      ],
      alignments: [{ id: id(17), type: "Alignment", artefact: L3, alignmentType: "teaches", target: base.concept, targetKind: "concept", source: { kind: "ai", model: "example-model", promptVersion: "draft-v1" }, status: "proposed" }],
      placements: [],
    };
    const r = await importOverlay(db, await bundle(partial, "partial"));
    expect(r.counts.artefacts).toEqual({ added: 1, changed: 1, unchanged: 0, kept: 3 });
    expect(r.counts.alignments).toEqual({ added: 1, changed: 0, unchanged: 0, kept: 6 });
    const out = await exportOverlay(db, { updated: "2026-10-31" });
    expect(out.artefacts.map((a) => a.code)).toEqual(["EX-L01", "EX-L01-Q1", "EX-L02", "EX-L03", "EX-REF-1"]);
    expect(out.artefacts.find((a) => a.id === L2)?.title).toEqual({ en: "Lesson 2: Subtracting a negative number" });
  });

  it("refuses another client's bundle, and a bundle pinned to another base release", async () => {
    await importOverlay(db, await bundle(fixture(), "in"));
    const other = fixture();
    other.manifest.client.namespace = other.profile.namespace = "another-school";
    for (const r of [...other.artefacts, ...other.plans]) r.namespace = "another-school";
    await expect(importOverlay(db, await bundle(other, "other"))).rejects.toThrow(/example-school's overlay/);

    const repinned = fixture();
    repinned.manifest.base = { ...repinned.manifest.base, version: "0.1.0", manifestSha256: undefined };
    await expect(importOverlay(db, await bundle(repinned, "repinned"))).rejects.toThrow(/Re-pinning is a separate step/);
  });

  it("gives every workspace a kind for reference material, which explains concepts", async () => {
    const f = fixture();
    f.profile.artefactKinds = f.profile.artefactKinds.filter((k) => k.kind !== "reference");
    f.artefacts = f.artefacts.filter((a) => a.kind !== "reference");
    f.alignments = f.alignments.filter((a) => a.artefact !== R1);
    const r = await importOverlay(db, await bundle(f, "no-reference"));
    expect(r.referenceKindAdded).toBe(true);
    const out = await exportOverlay(db, { updated: "2026-10-30" });
    expect(out.profile.artefactKinds.at(-1)).toMatchObject({ kind: "reference", alignments: ["explains", "covers"] });
  });

  // Skipped only on a machine with no spec checkout.
  it.skipIf(!process.env.CI && !process.env.OCG_SPEC_DIR && !specValidator())("exports a bundle that conforms to the specification", async () => {
    await importOverlay(db, await bundle(fixture(), "in"));
    const at = path.join(tmp, "conforms");
    await writeOverlay(at, await exportOverlay(db, { updated: "2026-10-30" }));
    const v = spawnSync(process.execPath, [specValidator()!, "overlay", at], { encoding: "utf8" });
    expect(v.stdout).toContain("conforms (0 errors");
  });
});

describe("rules the workspace database keeps", () => {
  beforeEach(async () => {
    await importOverlay(db, await bundle(fixture(), "in"));
  });
  const alignment = (over: Partial<typeof s.alignment.$inferInsert>) =>
    db.insert(s.alignment).values({ id: id(99), artefactId: L1, alignmentType: "teaches", targetId: base.concept, targetKind: "concept", sourceKind: "import", ...over });

  it("an alignment carries only a type its artefact's kind allows", async () => {
    expect((await pgError(alignment({ alignmentType: "explains" }))).message).toMatch(/may not carry a explains alignment/);
    const narrowed = db.update(s.artefactKind).set({ alignments: ["assumes", "covers"] }).where(eq(s.artefactKind.kind, "lesson"));
    expect((await pgError(narrowed)).message).toMatch(/may not carry a teaches/);
  });

  it("an alignment points at the kind of base object its type allows", async () => {
    expect((await pgError(alignment({ targetKind: "misconception" }))).message).toMatch(/alignment_target_kind/);
    expect((await pgError(alignment({ alignmentType: "covers", targetKind: "concept" }))).message).toMatch(/alignment_target_kind/);
  });

  it("an AI alignment names its model and prompt version; a person's names them", async () => {
    expect((await pgError(alignment({ sourceKind: "ai" }))).message).toMatch(/alignment_ai_source/);
    expect((await pgError(alignment({ sourceKind: "person" }))).message).toMatch(/alignment_person_source/);
  });

  it("holds one client's overlay", async () => {
    const second = db.insert(s.profile).values({ id: 2, namespace: "another-school", name: "Another", baseSlug: "x", baseFramework: id(1), baseVersion: "0.1.0" });
    expect((await pgError(second)).message).toMatch(/profile_one_client/);
  });
});

/** The Postgres error behind a failed query, whatever wraps it. */
async function pgError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    let e: unknown = error;
    while (e instanceof Error && e.cause && !(e as { code?: string }).code) e = e.cause;
    return e as { code?: string; message: string };
  }
  throw new Error("expected the query to fail, and it succeeded");
}
