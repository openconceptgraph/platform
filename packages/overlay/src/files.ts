import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { alignmentTypes } from "./schema";

// An overlay bundle as the OpenConceptGraph specification lays it out
// (spec repository, docs/overlay.md): a manifest, the client profile, and
// four arrays of records. These shapes mirror the specification's schemas;
// its validator is the full check, and the CLI runs it on every bundle in and
// out.

const uuid = z.uuid();
const date = z.iso.date();
const semver = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/);
const tag = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/, "a BCP 47 language tag");
const langString = z.record(tag, z.string().min(1)).refine((m) => Object.keys(m).length > 0, "at least one language");
const namespace = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const fileEntry = z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), count: z.int().min(0) });

export const OVERLAY_FILES = {
  profile: "profile.json",
  artefacts: "artefacts.json",
  alignments: "alignments.json",
  plans: "plans.json",
  placements: "placements.json",
} as const;
export type OverlayFileKey = keyof typeof OVERLAY_FILES;

export const overlayManifest = z.strictObject({
  spec: semver,
  kind: z.literal("overlay"),
  client: z.strictObject({ namespace, name: z.string().min(1) }),
  base: z.strictObject({ slug: z.string().min(1), framework: uuid, version: semver, manifestSha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }),
  version: semver.optional(),
  updated: date,
  files: z.strictObject({ profile: fileEntry, artefacts: fileEntry, alignments: fileEntry, plans: fileEntry, placements: fileEntry }),
});

export const artefactKindRecord = z.strictObject({
  kind: namespace,
  label: langString,
  description: langString.optional(),
  alignments: z.array(z.enum(alignmentTypes)).min(1),
  learningResourceType: z.string().min(1).optional(),
});

export const profileRecord = z.strictObject({
  type: z.literal("ClientProfile"),
  namespace,
  name: z.string().min(1),
  artefactKinds: z.array(artefactKindRecord).min(1),
});

export const artefactRecord = z.strictObject({
  id: uuid,
  type: z.literal("Artefact"),
  namespace,
  kind: z.string().min(1),
  code: z.string().min(1).optional(),
  title: langString,
  language: tag,
  parent: uuid.optional(),
  ordinal: z.int().optional(),
  url: z.url().optional(),
  ref: z.string().min(1).optional(),
});

export const alignmentRecord = z.strictObject({
  id: uuid,
  type: z.literal("Alignment"),
  artefact: uuid,
  part: z.string().min(1).optional(),
  alignmentType: z.enum(alignmentTypes),
  target: uuid,
  targetKind: z.enum(["concept", "level", "misconception", "statement", "node"]),
  source: z.strictObject({
    kind: z.enum(["ai", "person", "import"]),
    model: z.string().min(1).optional(),
    promptVersion: z.string().min(1).optional(),
    by: z.string().min(1).optional(),
    date: date.optional(),
  }),
  status: z.enum(["proposed", "confirmed", "rejected"]),
  confidence: z.number().min(0).max(1).optional(),
  rationale: langString.optional(),
});

export const planRecord = z.strictObject({ id: uuid, type: z.literal("OverlayPlan"), namespace, slug: z.string().min(1), title: langString });

export const placementRecord = z.strictObject({
  id: uuid,
  type: z.literal("OverlayPlacement"),
  plan: uuid,
  artefact: uuid,
  educationLevel: uuid,
  term: z.int().min(1).optional(),
  weekStart: z.int().min(1).optional(),
  weekEnd: z.int().min(1).optional(),
  hours: z.number().positive().optional(),
  ordinal: z.int(),
});

export type OverlayManifest = z.infer<typeof overlayManifest>;
export type ProfileRecord = z.infer<typeof profileRecord>;
export type ArtefactKindRecord = z.infer<typeof artefactKindRecord>;
export type ArtefactRecord = z.infer<typeof artefactRecord>;
export type AlignmentRecord = z.infer<typeof alignmentRecord>;
export type PlanRecord = z.infer<typeof planRecord>;
export type PlacementRecord = z.infer<typeof placementRecord>;

/** An overlay's manifest (without its file entries, which writing fills in) and its records. */
export interface Overlay {
  manifest: Omit<OverlayManifest, "files">;
  profile: ProfileRecord;
  artefacts: ArtefactRecord[];
  alignments: AlignmentRecord[];
  plans: PlanRecord[];
  placements: PlacementRecord[];
}

/** Reads an overlay bundle's manifest and records, checking each against its shape and each file against its hash. */
export async function readOverlay(dir: string): Promise<Overlay> {
  const parse = <T>(schema: z.ZodType<T>, data: unknown, file: string): T => {
    const r = schema.safeParse(data);
    if (!r.success) throw new Error(`${file}: ${z.prettifyError(r.error)}`);
    return r.data;
  };
  const manifest = parse(overlayManifest, JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")), "manifest.json");
  const read = async (key: OverlayFileKey) => {
    const entry = manifest.files[key];
    const bytes = await readFile(path.join(dir, entry.path));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`${entry.path}: its SHA-256 does not match the manifest`);
    return { data: JSON.parse(bytes.toString("utf8")) as unknown, file: entry.path };
  };
  const list = async <T>(key: OverlayFileKey, schema: z.ZodType<T>) => {
    const { data, file } = await read(key);
    return parse(z.array(schema), data, file);
  };
  const profileFile = await read("profile");
  return {
    manifest: { spec: manifest.spec, kind: manifest.kind, client: manifest.client, base: manifest.base, version: manifest.version, updated: manifest.updated },
    profile: parse(profileRecord, profileFile.data, profileFile.file),
    artefacts: await list("artefacts", artefactRecord),
    alignments: await list("alignments", alignmentRecord),
    plans: await list("plans", planRecord),
    placements: await list("placements", placementRecord),
  };
}

/** Writes an overlay's files and its manifest, with each file's SHA-256 and object count. */
export async function writeOverlay(outDir: string, overlay: Overlay): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const files: Record<string, { path: string; sha256: string; count: number }> = {};
  for (const [key, file] of Object.entries(OVERLAY_FILES) as [OverlayFileKey, string][]) {
    const data = overlay[key];
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
    await writeFile(path.join(outDir, file), bytes);
    files[key] = { path: file, sha256: createHash("sha256").update(bytes).digest("hex"), count: Array.isArray(data) ? data.length : 1 };
  }
  await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify({ ...overlay.manifest, files }, null, 2)}\n`);
}
