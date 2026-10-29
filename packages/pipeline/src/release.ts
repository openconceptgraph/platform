import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Db, schema } from "@ocg/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";

// Builds a base release from the working database, as the OpenConceptGraph
// specification 0.1 lays it out (spec repository, docs/release.md): the
// transcription in full, and only the interpretation that reviewers have
// confirmed, each object with a summary of its review under the reviewers'
// public names. Planted controls never reach a release, nor does anything
// retired. Output is deterministic: the same database gives the same bytes.

export const SPEC_VERSION = "0.1.0";

type LangString = Record<string, string>;
type Kind = (typeof schema.objectKind.enumValues)[number];

const langString = z.record(z.string(), z.string().min(1)).refine((m) => Object.keys(m).length > 0);

/** A base's own release settings: `release.json` beside its `framework.json`. */
export const releaseConfig = z.strictObject({
  title: langString.optional(),
  license: z.strictObject({ id: z.string().min(1), url: z.url() }),
  attribution: z.array(z.string().min(1)).min(1),
  reviewPolicy: z.strictObject({ minReviewers: z.int().positive() }),
});
export type ReleaseConfig = z.infer<typeof releaseConfig>;

export async function readReleaseConfig(baseDir: string): Promise<ReleaseConfig> {
  const file = path.join(baseDir, "release.json");
  const parsed = releaseConfig.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export interface ReleaseOptions {
  version: string;
  /** YYYY-MM-DD. */
  released: string;
  notes?: LangString;
  /** The folder of the release before this one: it supplies `previous`, and what must be retired rather than dropped. */
  previousDir?: string;
  /** The language of authored plain text held without a language map (link rationales). */
  language?: string;
}

/** The release's files by manifest key, in the specification's names. */
export const RELEASE_FILES = {
  framework: "framework.json",
  documents: "documents.json",
  nodes: "nodes.json",
  statements: "statements.json",
  teachingPlans: "teaching-plans.json",
  placements: "placements.json",
  families: "families.json",
  concepts: "concepts.json",
  levels: "levels.json",
  misconceptions: "misconceptions.json",
  links: "links.json",
  sources: "sources.json",
  reviews: "reviews.json",
  retired: "retired.json",
} as const;
export type ReleaseFileKey = keyof typeof RELEASE_FILES;

export interface Release {
  manifest: Record<string, unknown>;
  files: Record<ReleaseFileKey, unknown>;
}

/** The database names kinds with underscores ("teaching_plan"); the specification with hyphens ("teaching-plan"). */
const specKind = (kind: string) => kind.replace(/_/g, "-");
const byNatural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
const LINK_ORDER = ["defines", "part-of", "needs", "hinders", "replaced-by"];
const KIND_ORDER: Kind[] = ["family", "concept", "level", "misconception", "link"];
const hours = (h: string | null) => (h === null ? undefined : Number(h));
/** Drops undefined fields, so optional ones are absent rather than null. */
const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function buildRelease(db: Db, frameworkSlug: string, config: ReleaseConfig, options: ReleaseOptions): Promise<Release> {
  const lang = options.language ?? "en";
  const s = schema;

  const [fw] = await db.select().from(s.framework).where(eq(s.framework.slug, frameworkSlug));
  if (!fw) throw new Error(`No framework "${frameworkSlug}" in the database`);
  const levelsOfFw = await db.select().from(s.educationLevel).where(eq(s.educationLevel.frameworkId, fw.id));

  // What is never released: anything retired, and planted controls.
  const retiredRows = await db.select({ id: s.baseObject.id, kind: s.baseObject.kind }).from(s.baseObject).where(isNotNull(s.baseObject.retiredAt));
  const retiredNow = new Map(retiredRows.map((r) => [r.id, r.kind]));
  const planted = new Set((await db.select({ id: s.planted.objectId }).from(s.planted)).map((p) => p.id));
  const live = (id: string) => !retiredNow.has(id) && !planted.has(id);

  // Transcription: everything the framework's documents hold.
  const documents = (await db.select().from(s.document).where(eq(s.document.frameworkId, fw.id))).filter((d) => live(d.id));
  documents.sort((a, b) => byNatural(a.title, b.title) || a.id.localeCompare(b.id));
  const documentIds = documents.map((d) => d.id);
  const docOrder = new Map(documentIds.map((id, i) => [id, i]));
  const checks = documentIds.length ? await db.select().from(s.transcriptionCheck).where(inArray(s.transcriptionCheck.documentId, documentIds)) : [];
  const machineChecked = new Set(checks.filter((c) => c.method === "machine").map((c) => c.documentId));

  const nodes = documentIds.length ? (await db.select().from(s.node).where(inArray(s.node.documentId, documentIds))).filter((n) => live(n.id)) : [];
  const nodeOrder = treeOrder(nodes, (n) => n.parentId, (n) => [docOrder.get(n.documentId)!, n.ordinal]);
  nodes.sort((a, b) => nodeOrder.get(a.id)! - nodeOrder.get(b.id)!);

  const statements = documentIds.length ? (await db.select().from(s.statement).where(inArray(s.statement.documentId, documentIds))).filter((x) => live(x.id)) : [];
  statements.sort(
    (a, b) =>
      docOrder.get(a.documentId)! - docOrder.get(b.documentId)! ||
      (a.nodeId ? nodeOrder.get(a.nodeId) ?? -1 : -1) - (b.nodeId ? nodeOrder.get(b.nodeId) ?? -1 : -1) ||
      a.ordinal - b.ordinal ||
      a.id.localeCompare(b.id),
  );

  const plans = (await db.select().from(s.teachingPlan).where(eq(s.teachingPlan.frameworkId, fw.id))).filter((p) => live(p.id));
  plans.sort((a, b) => byNatural(a.slug, b.slug));
  const planOrder = new Map(plans.map((p, i) => [p.id, i]));
  const allPlacements = plans.length ? (await db.select().from(s.placement).where(inArray(s.placement.teachingPlanId, plans.map((p) => p.id)))).filter((p) => live(p.id)) : [];

  // Interpretation: confirmed, live, not planted.
  const confirmed = <T extends { id: string; status: string }>(rows: T[]) => rows.filter((r) => r.status === "confirmed" && live(r.id));
  const families = confirmed(await db.select().from(s.family).where(eq(s.family.frameworkId, fw.id))).sort((a, b) => byNatural(a.humanCode, b.humanCode));
  const concepts = confirmed(await db.select().from(s.concept).where(eq(s.concept.frameworkId, fw.id))).sort((a, b) => byNatural(a.humanCode, b.humanCode));
  const conceptCode = new Map(concepts.map((c) => [c.id, c.humanCode]));
  const levels = concepts.length ? confirmed(await db.select().from(s.level).where(inArray(s.level.conceptId, concepts.map((c) => c.id)))) : [];
  levels.sort((a, b) => byNatural(conceptCode.get(a.conceptId)!, conceptCode.get(b.conceptId)!) || a.ordinal - b.ordinal);
  const misconceptions = confirmed(await db.select().from(s.misconception).where(eq(s.misconception.frameworkId, fw.id))).sort((a, b) => byNatural(a.humanCode, b.humanCode));

  // What this release holds, by ID, for keeping links and placements to it.
  const released = new Map<string, Kind>();
  for (const [kind, rows] of [
    ["statement", statements],
    ["node", nodes],
    ["family", families],
    ["concept", concepts],
    ["level", levels],
    ["misconception", misconceptions],
  ] as const) {
    for (const r of rows) released.set(r.id, kind);
  }

  // Retirement: anything the previous release held must still be here, or be retired.
  const previous = options.previousDir ? await readPreviousRelease(options.previousDir) : undefined;
  const retired: { id: string; kind: string; retiredIn: string; replacedBy?: string }[] = [...(previous?.retired ?? [])];
  const problems: string[] = [];
  if (previous) {
    for (const [id, kind] of previous.live) {
      if (released.has(id) || ["framework", "education-level", "document", "teaching-plan", "placement", "link", "source"].includes(kind)) continue;
      if (retiredNow.has(id)) retired.push({ id, kind, retiredIn: options.version });
      else problems.push(`${kind} ${id} was in ${previous.version} but is not confirmed now; confirm it again or retire it`);
    }
  }
  if (problems.length) throw new Error(`The release would drop objects without retiring them:\n${problems.join("\n")}`);
  const retiredIds = new Set(retired.map((r) => r.id));

  const candidateLinks = (await db.select().from(s.link).where(eq(s.link.status, "confirmed"))).filter((l) => live(l.id) && !planted.has(l.fromId) && !planted.has(l.toId));
  const links = candidateLinks.filter((l) =>
    l.linkType === "replaced-by" ? retiredIds.has(l.fromId) && released.has(l.toId) : released.has(l.fromId) && released.has(l.toId),
  );
  for (const r of retired) {
    const to = links.find((l) => l.linkType === "replaced-by" && l.fromId === r.id)?.toId;
    if (to) r.replacedBy = to;
  }
  retired.sort((a, b) => a.id.localeCompare(b.id));
  const sortKey = (id: string) => conceptCode.get(id) ?? id;
  links.sort(
    (a, b) =>
      LINK_ORDER.indexOf(a.linkType) - LINK_ORDER.indexOf(b.linkType) ||
      byNatural(sortKey(a.fromId), sortKey(b.fromId)) ||
      byNatural(sortKey(a.toId), sortKey(b.toId)) ||
      a.id.localeCompare(b.id),
  );

  const placements = allPlacements.filter((p) => released.has(p.targetId));
  placements.sort((a, b) => planOrder.get(a.teachingPlanId)! - planOrder.get(b.teachingPlanId)! || a.ordinal - b.ordinal || a.id.localeCompare(b.id));

  // Sources: only those a released link or mistake cites. Reviewers by public name.
  const sourceIds = [...new Set([...links.map((l) => l.sourceId), ...misconceptions.map((m) => m.sourceId).filter((x): x is string => x !== null)])];
  const sources = sourceIds.length ? await db.select().from(s.source).where(inArray(s.source.id, sourceIds)) : [];
  const userIds = [...new Set(sources.map((x) => x.reviewerId).filter((x): x is string => x !== null))];

  // Reviews: the judgements that decide each released object's status, as ocg_derive_status counts them.
  const interp: { id: string; kind: Kind; revision: number }[] = [
    ...families.map((x) => ({ id: x.id, kind: "family" as const, revision: x.revision })),
    ...concepts.map((x) => ({ id: x.id, kind: "concept" as const, revision: x.revision })),
    ...levels.map((x) => ({ id: x.id, kind: "level" as const, revision: x.revision })),
    ...misconceptions.map((x) => ({ id: x.id, kind: "misconception" as const, revision: x.revision })),
    ...links.map((x) => ({ id: x.id, kind: "link" as const, revision: x.revision })),
  ];
  const judgements = interp.length
    ? await db.select().from(s.judgement).where(and(inArray(s.judgement.objectId, interp.map((o) => o.id)), eq(s.judgement.isControl, false)))
    : [];
  const superseded = new Set(judgements.map((j) => j.supersedesId).filter((x): x is string => x !== null));
  for (const j of judgements) if (j.decision === "confirm") userIds.push(j.reviewerId);
  const profiles = userIds.length
    ? await db.select().from(s.reviewerProfile).where(inArray(s.reviewerProfile.userId, [...new Set(userIds)]))
    : [];
  const publicName = new Map(profiles.map((p) => [p.userId, p.publicName]));
  const nameOf = (userId: string) => {
    const name = publicName.get(userId);
    if (!name) throw new Error(`Reviewer ${userId} has no public name; a release never shows a real name`);
    return name;
  };

  const reviews = interp.map((o) => {
    const current = judgements.filter((j) => j.objectId === o.id && j.objectRevision === o.revision && !superseded.has(j.id));
    const confirmers = [...new Set(current.filter((j) => j.decision === "confirm").map((j) => j.reviewerId))];
    if (current.length === 0 || confirmers.length === 0) throw new Error(`The confirmed ${o.kind} ${o.id} has no current judgements`);
    const decided = current.map((j) => j.createdAt.toISOString().slice(0, 10)).sort().at(-1)!;
    return {
      object: o.id,
      objectKind: o.kind,
      revision: o.revision,
      status: "confirmed",
      decided,
      reviewers: confirmers.map(nameOf).sort(byNatural),
      judgements: current.length,
    };
  });
  reviews.sort((a, b) => KIND_ORDER.indexOf(a.objectKind) - KIND_ORDER.indexOf(b.objectKind) || a.object.localeCompare(b.object));

  // The files, in the specification's shapes.
  const levelsOut = [...levelsOfFw].sort((a, b) => a.ordinal - b.ordinal || byNatural(a.code, b.code));
  const files: Record<ReleaseFileKey, unknown> = {
    framework: clean({
      id: fw.id,
      type: "Framework",
      revision: fw.revision,
      slug: fw.slug,
      title: fw.title,
      jurisdiction: fw.jurisdiction,
      subject: fw.subject,
      publisher: fw.publisher ?? undefined,
      nodeTypes: fw.nodeTypes,
      educationLevels: levelsOut.map((l) => ({ id: l.id, type: "EducationLevel", revision: l.revision, code: l.code, title: l.title, iscedLevel: l.iscedLevel, ordinal: l.ordinal })),
    }),
    documents: documents.map((d) => {
      const own = checks
        .filter((c) => c.documentId === d.id)
        .sort((a, b) => a.checkedOn.localeCompare(b.checkedOn) || a.createdAt.getTime() - b.createdAt.getTime());
      return clean({
        id: d.id,
        type: "Document",
        revision: d.revision,
        framework: d.frameworkId,
        title: d.title,
        language: d.language,
        publisher: d.publisher ?? undefined,
        issued: d.issued ?? undefined,
        versionLabel: d.versionLabel ?? undefined,
        url: d.url ?? undefined,
        rights: d.rights ?? undefined,
        file: d.fileSha256 ? clean({ sha256: d.fileSha256, pages: d.filePages ?? undefined, printedPageOffset: d.printedPageOffset ?? undefined }) : undefined,
        checks: own.length
          ? own.map((c) => clean({ method: c.method, pages: c.pages ?? undefined, date: c.checkedOn, by: c.checkedBy ?? undefined, note: c.note ?? undefined }))
          : undefined,
      });
    }),
    nodes: nodes.map((n) =>
      clean({ id: n.id, type: "Node", revision: n.revision, document: n.documentId, parent: n.parentId, nodeType: n.nodeType, code: n.humanCode ?? undefined, title: n.title, ordinal: n.ordinal }),
    ),
    statements: statements.map((x) =>
      clean({
        id: x.id,
        type: "Statement",
        revision: x.revision,
        document: x.documentId,
        node: x.nodeId,
        parent: x.parentId,
        educationLevel: x.educationLevelId ?? undefined,
        statementType: x.statementType,
        revise: x.isRevision,
        code: x.humanCode ?? undefined,
        label: x.label ?? undefined,
        heading: x.heading ?? undefined,
        text: x.text,
        page: x.page ?? undefined,
        locator: x.locator ?? undefined,
        ordinal: x.ordinal,
        // How a line was verified means something only once its document's machine check is on record.
        verifiedBy: machineChecked.has(x.documentId) ? (x.verifiedBy ?? undefined) : undefined,
        note: x.note ?? undefined,
      }),
    ),
    teachingPlans: plans.map((p) =>
      clean({ id: p.id, type: "TeachingPlan", revision: p.revision, framework: p.frameworkId, document: p.documentId ?? undefined, slug: p.slug, title: p.title }),
    ),
    placements: placements.map((p) =>
      clean({
        id: p.id,
        type: "Placement",
        revision: p.revision,
        teachingPlan: p.teachingPlanId,
        target: p.targetId,
        targetKind: p.targetKind,
        educationLevel: p.educationLevelId,
        term: p.term ?? undefined,
        weekStart: p.weekStart ?? undefined,
        weekEnd: p.weekEnd ?? undefined,
        hours: hours(p.hours),
        ordinal: p.ordinal,
        asPrinted: p.asPrinted ?? undefined,
      }),
    ),
    families: families.map((f) =>
      clean({ id: f.id, type: "Family", revision: f.revision, framework: f.frameworkId, code: f.humanCode, title: f.title, description: f.description ?? undefined, status: f.status }),
    ),
    concepts: concepts.map((c) =>
      clean({
        id: c.id,
        type: "Concept",
        revision: c.revision,
        framework: c.frameworkId,
        code: c.humanCode,
        aliases: c.aliases,
        title: c.title,
        description: c.description ?? undefined,
        kind: c.kind ?? undefined,
        gateway: c.isGateway,
        status: c.status,
      }),
    ),
    levels: levels.map((l) =>
      clean({ id: l.id, type: "Level", revision: l.revision, concept: l.conceptId, ordinal: l.ordinal, title: l.title, description: l.description ?? undefined, status: l.status }),
    ),
    misconceptions: misconceptions.map((m) =>
      clean({
        id: m.id,
        type: "Misconception",
        revision: m.revision,
        framework: m.frameworkId,
        code: m.humanCode,
        statement: m.statement,
        example: m.example ?? undefined,
        source: m.sourceId,
        status: m.status,
      }),
    ),
    links: links.map((l) =>
      clean({
        id: l.id,
        type: "Link",
        revision: l.revision,
        linkType: l.linkType,
        from: l.fromId,
        fromKind: specKind(l.fromKind),
        to: l.toId,
        toKind: specKind(l.toKind),
        source: l.sourceId,
        status: l.status,
        confidence: l.confidence ?? undefined,
        rationale: l.rationale ? { [lang]: l.rationale } : undefined,
      }),
    ),
    sources: sources
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
      .map((x) =>
        clean({
          id: x.id,
          type: "Source",
          revision: x.revision,
          framework: x.frameworkId,
          kind: x.kind,
          statement: x.statementId ?? undefined,
          citation: x.citation ?? undefined,
          url: x.url ?? undefined,
          reviewer: x.reviewerId ? nameOf(x.reviewerId) : undefined,
          model: x.model ?? undefined,
          promptVersion: x.promptVersion ?? undefined,
        }),
      ),
    reviews,
    retired,
  };

  const manifest = clean({
    spec: SPEC_VERSION,
    kind: "base-release",
    base: fw.slug,
    framework: fw.id,
    version: options.version,
    previous: previous?.version,
    released: options.released,
    title: config.title,
    notes: options.notes,
    license: config.license,
    attribution: config.attribution,
    reviewPolicy: config.reviewPolicy,
  });
  return { manifest, files };
}

/** Writes a release's files and its manifest, with each file's SHA-256 and object count. */
export async function writeRelease(outDir: string, release: Release): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const entries: Record<string, { path: string; sha256: string; count: number }> = {};
  for (const [key, file] of Object.entries(RELEASE_FILES) as [ReleaseFileKey, string][]) {
    const data = release.files[key];
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
    await writeFile(path.join(outDir, file), bytes);
    entries[key] = { path: file, sha256: createHash("sha256").update(bytes).digest("hex"), count: Array.isArray(data) ? data.length : 1 };
  }
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify({ ...release.manifest, files: entries }, null, 2)}\n`);
}

interface PreviousRelease {
  version: string;
  /** Every object the previous release held, with its kind as the specification names it. */
  live: Map<string, string>;
  retired: { id: string; kind: string; retiredIn: string; replacedBy?: string }[];
}

async function readPreviousRelease(dir: string): Promise<PreviousRelease> {
  const read = async (file: string) => JSON.parse(await readFile(path.join(dir, file), "utf8")) as unknown;
  const manifest = (await read("manifest.json")) as { version: string };
  const live = new Map<string, string>();
  const kinds: [ReleaseFileKey, string][] = [
    ["documents", "document"],
    ["nodes", "node"],
    ["statements", "statement"],
    ["teachingPlans", "teaching-plan"],
    ["placements", "placement"],
    ["families", "family"],
    ["concepts", "concept"],
    ["levels", "level"],
    ["misconceptions", "misconception"],
    ["links", "link"],
    ["sources", "source"],
  ];
  for (const [key, kind] of kinds) {
    for (const o of (await read(RELEASE_FILES[key])) as { id: string }[]) live.set(o.id, kind);
  }
  return { version: manifest.version, live, retired: (await read(RELEASE_FILES.retired)) as PreviousRelease["retired"] };
}

/** Positions of a forest's nodes in depth-first order, parents first, siblings by `key`. */
function treeOrder<T extends { id: string }>(rows: T[], parentOf: (r: T) => string | null, key: (r: T) => number[]): Map<string, number> {
  const children = new Map<string | null, T[]>();
  for (const r of rows) {
    const p = parentOf(r);
    const parent = p !== null && rows.some((x) => x.id === p) ? p : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const cmp = (a: T, b: T) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) if ((ka[i] ?? 0) !== (kb[i] ?? 0)) return (ka[i] ?? 0) - (kb[i] ?? 0);
    return a.id.localeCompare(b.id);
  };
  const order = new Map<string, number>();
  const walk = (parent: string | null) => {
    for (const r of (children.get(parent) ?? []).sort(cmp)) {
      order.set(r.id, order.size);
      walk(r.id);
    }
  };
  walk(null);
  return order;
}

/**
 * Validates a release folder with the specification's reference validator, if
 * a built checkout of the spec repository is at hand: OCG_SPEC_DIR, or `spec`
 * beside this repository, as the workspace keeps it. Returns null when there
 * is none, so the caller can say the release went unchecked.
 */
export function specValidator(): string | null {
  const fromEnv = process.env.OCG_SPEC_DIR;
  const beside = path.resolve(new URL("../../../../spec", import.meta.url).pathname);
  for (const dir of [fromEnv, beside]) {
    if (dir && existsSync(path.join(dir, "dist", "cli.js"))) return path.join(dir, "dist", "cli.js");
  }
  return null;
}
