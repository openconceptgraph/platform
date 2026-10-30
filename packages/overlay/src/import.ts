import { eq, inArray, notInArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { OverlayDb } from "./client";
import type { ArtefactKindRecord, ArtefactRecord, Overlay } from "./files";
import * as s from "./schema";

// Loads an overlay bundle into a workspace's database. Every record keeps the
// ID the bundle gives it; a record already here is updated, and one the bundle
// does not hold is kept: a bundle may be a partial write-back, such as the
// lessons a tool has just drafted. Nothing is deleted. The bundle must be
// the workspace's own client, pinned to the same base release: re-pinning is a
// separate, explicit step.

type Tx = Parameters<Parameters<OverlayDb["transaction"]>[0]>[0];
type Synced = PgTable & { id: PgColumn; updatedAt: PgColumn };

/**
 * The kind every workspace's profile has from the start (ADR-036, design rule
 * 4): approved material that what is taught is grounded in, which `explains`
 * concepts.
 */
export const REFERENCE_KIND: ArtefactKindRecord = {
  kind: "reference",
  label: { en: "Reference material" },
  description: { en: "Approved material that what is taught is grounded in: a source document, a textbook section, approved notes." },
  alignments: ["explains", "covers"],
  learningResourceType: "reference",
};

export interface Counts {
  added: number;
  changed: number;
  unchanged: number;
  /** Already in the workspace and not in the bundle: kept. */
  kept: number;
}

export interface OverlayImportReport {
  profile: "created" | "changed" | "unchanged";
  /** The bundle's profile had no reference kind, so the workspace's gained one. */
  referenceKindAdded: boolean;
  counts: Record<"artefactKinds" | "artefacts" | "alignments" | "plans" | "placements", Counts>;
}

export async function importOverlay(db: OverlayDb, o: Overlay): Promise<OverlayImportReport> {
  const ns = o.manifest.client.namespace;
  const strangers = [o.profile, ...o.artefacts, ...o.plans].filter((r) => r.namespace !== ns);
  if (strangers.length) throw new Error(`The bundle is ${ns}'s, but holds records of namespace ${strangers[0]!.namespace}`);

  return db.transaction(async (tx) => {
    const profile = await syncProfile(tx, o);

    const kindsBefore = await tx.select().from(s.artefactKind);
    const kinds = o.profile.artefactKinds.map((k, i) => ({
      kind: k.kind,
      label: k.label,
      description: k.description ?? null,
      alignments: k.alignments,
      learningResourceType: k.learningResourceType ?? null,
      ordinal: i + 1,
    }));
    const kindCounts: Counts = { added: 0, changed: 0, unchanged: 0, kept: 0 };
    for (const k of kinds) {
      const before = kindsBefore.find((b) => b.kind === k.kind);
      if (!before) {
        await tx.insert(s.artefactKind).values(k);
        kindCounts.added++;
      } else if (canonical(before) !== canonical({ ...before, ...k })) {
        await tx.update(s.artefactKind).set(k).where(eq(s.artefactKind.kind, k.kind));
        kindCounts.changed++;
      } else kindCounts.unchanged++;
    }
    kindCounts.kept = kindsBefore.filter((b) => !kinds.some((k) => k.kind === b.kind)).length;
    const referenceKindAdded = ![...kindsBefore, ...kinds].some((k) => k.kind === REFERENCE_KIND.kind);
    if (referenceKindAdded) {
      const last = Math.max(0, ...[...kindsBefore, ...kinds].map((k) => k.ordinal));
      await tx.insert(s.artefactKind).values({
        ...REFERENCE_KIND,
        description: REFERENCE_KIND.description ?? null,
        learningResourceType: REFERENCE_KIND.learningResourceType ?? null,
        ordinal: last + 1,
      });
    }

    const artefacts = await sync(
      tx,
      s.artefact,
      parentsFirst(o.artefacts).map((a) => ({
        id: a.id,
        namespace: a.namespace,
        kind: a.kind,
        code: a.code ?? null,
        title: a.title,
        language: a.language,
        parentId: a.parent ?? null,
        ordinal: a.ordinal ?? null,
        url: a.url ?? null,
        ref: a.ref ?? null,
      })),
    );
    const plans = await sync(tx, s.plan, o.plans.map((p) => ({ id: p.id, namespace: p.namespace, slug: p.slug, title: p.title })));
    const placements = await sync(
      tx,
      s.placement,
      o.placements.map((p) => ({
        id: p.id,
        planId: p.plan,
        artefactId: p.artefact,
        educationLevelId: p.educationLevel,
        term: p.term ?? null,
        weekStart: p.weekStart ?? null,
        weekEnd: p.weekEnd ?? null,
        hours: p.hours === undefined ? null : p.hours.toFixed(1),
        ordinal: p.ordinal,
      })),
    );
    const alignments = await sync(
      tx,
      s.alignment,
      o.alignments.map((a) => ({
        id: a.id,
        artefactId: a.artefact,
        part: a.part ?? null,
        alignmentType: a.alignmentType,
        targetId: a.target,
        targetKind: a.targetKind,
        sourceKind: a.source.kind,
        sourceModel: a.source.model ?? null,
        sourcePromptVersion: a.source.promptVersion ?? null,
        sourceBy: a.source.by ?? null,
        sourceDate: a.source.date ?? null,
        status: a.status,
        confidence: a.confidence ?? null,
        rationale: a.rationale ?? null,
      })),
    );
    return { profile, referenceKindAdded, counts: { artefactKinds: kindCounts, artefacts, alignments, plans, placements } };
  });
}

/** Creates the workspace's profile from the bundle, or checks the bundle is its own client on the same pin. */
async function syncProfile(tx: Tx, o: Overlay): Promise<OverlayImportReport["profile"]> {
  const { client, base, version } = o.manifest;
  const [current] = await tx.select().from(s.profile);
  if (!current) {
    await tx.insert(s.profile).values({
      namespace: client.namespace,
      name: client.name,
      version: version ?? null,
      baseSlug: base.slug,
      baseFramework: base.framework,
      baseVersion: base.version,
      baseManifestSha256: base.manifestSha256 ?? null,
    });
    return "created";
  }
  if (current.namespace !== client.namespace) {
    throw new Error(`This workspace holds ${current.namespace}'s overlay; the bundle is ${client.namespace}'s`);
  }
  const pinned = `${current.baseSlug} ${current.baseVersion}`;
  if (current.baseSlug !== base.slug || current.baseFramework !== base.framework || current.baseVersion !== base.version) {
    throw new Error(`The workspace is pinned to ${pinned}; the bundle to ${base.slug} ${base.version}. Re-pinning is a separate step.`);
  }
  if (base.manifestSha256 && current.baseManifestSha256 && base.manifestSha256 !== current.baseManifestSha256) {
    throw new Error(`The bundle pins a different copy of ${pinned} (its manifest's SHA-256 differs)`);
  }
  const [after] = await tx
    .update(s.profile)
    .set({ name: client.name, version: version ?? current.version, baseManifestSha256: current.baseManifestSha256 ?? base.manifestSha256 ?? null })
    .returning({ updatedAt: s.profile.updatedAt });
  return after!.updatedAt.getTime() === current.updatedAt.getTime() ? "unchanged" : "changed";
}

/**
 * Inserts the rows not yet in the table and updates the rest, in the order
 * given. The database moves updated_at only when content changes, which is
 * how a change is told from a row loaded again unchanged.
 */
async function sync<T extends Synced>(tx: Tx, table: T, rows: (T["$inferInsert"] & { id: string })[]): Promise<Counts> {
  const t = table as Synced;
  const counts: Counts = { added: 0, changed: 0, unchanged: 0, kept: 0 };
  const ids = rows.map((r) => r.id);
  const existing = ids.length
    ? ((await tx.select({ id: t.id, updatedAt: t.updatedAt }).from(t).where(inArray(t.id, ids))) as { id: string; updatedAt: Date }[])
    : [];
  const before = new Map(existing.map((e) => [e.id, e.updatedAt.getTime()]));
  for (const row of rows) {
    if (!before.has(row.id)) {
      await tx.insert(table).values(row as never);
      counts.added++;
      continue;
    }
    const { id, ...rest } = row;
    const [after] = (await tx.update(table).set(rest as never).where(eq(t.id, id)).returning({ updatedAt: t.updatedAt })) as { updatedAt: Date }[];
    if (after!.updatedAt.getTime() !== before.get(id)) counts.changed++;
    else counts.unchanged++;
  }
  const [{ n }] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(ids.length ? notInArray(t.id, ids) : sql`true`)) as [{ n: number }];
  counts.kept = n;
  return counts;
}

/** Artefacts in an order where each parent the bundle holds comes before its children. */
function parentsFirst(artefacts: ArtefactRecord[]): ArtefactRecord[] {
  const byId = new Map(artefacts.map((a) => [a.id, a]));
  const out: ArtefactRecord[] = [];
  const placed = new Set<string>();
  const visit = (a: ArtefactRecord, path: Set<string>) => {
    if (placed.has(a.id)) return;
    if (path.has(a.id)) throw new Error(`Artefact ${a.id} sits inside itself`);
    const parent = a.parent ? byId.get(a.parent) : undefined;
    if (parent) visit(parent, new Set([...path, a.id]));
    placed.add(a.id);
    out.push(a);
  };
  for (const a of artefacts) visit(a, new Set());
  return out;
}

/** JSON with every object's keys sorted, so that two equal values compare equal as text. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}
