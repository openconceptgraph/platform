import type { OverlayDb } from "./client";
import type { AlignmentRecord, ArtefactRecord, Overlay, PlacementRecord } from "./files";
import { alignmentTypes } from "./schema";
import * as s from "./schema";

// Exports a workspace's overlay as the specification lays it out: every
// record, in a fixed order, so that the same database gives the same bytes.
// Exporting is always possible, at any time (ADR-033).

/** The specification version an export conforms to: 0.1.1 added `explains`. */
export const OVERLAY_SPEC_VERSION = "0.1.1";

/** Drops undefined fields, so optional ones are absent rather than null. */
const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const opt = <T>(v: T | null): T | undefined => v ?? undefined;

export async function exportOverlay(db: OverlayDb, options: { updated: string }): Promise<Overlay> {
  const [profile] = await db.select().from(s.profile);
  if (!profile) throw new Error("This workspace has no overlay yet: import one, or create its profile");
  const kinds = (await db.select().from(s.artefactKind)).sort((a, b) => a.ordinal - b.ordinal || a.kind.localeCompare(b.kind));
  const artefactRows = await db.select().from(s.artefact);
  const alignmentRows = await db.select().from(s.alignment);
  const planRows = (await db.select().from(s.plan)).sort((a, b) => a.slug.localeCompare(b.slug));
  const placementRows = await db.select().from(s.placement);

  // Artefacts as a tree: each parent before its children, siblings by their ordinal, then code.
  const children = new Map<string | null, typeof artefactRows>();
  for (const a of artefactRows) {
    const parent = a.parentId && artefactRows.some((x) => x.id === a.parentId) ? a.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), a]);
  }
  const sibling = (a: (typeof artefactRows)[number], b: (typeof artefactRows)[number]) =>
    (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || (a.code ?? "").localeCompare(b.code ?? "") || a.id.localeCompare(b.id);
  const ordered: typeof artefactRows = [];
  const walk = (parent: string | null) => {
    for (const a of (children.get(parent) ?? []).sort(sibling)) {
      ordered.push(a);
      walk(a.id);
    }
  };
  walk(null);
  const position = new Map(ordered.map((a, i) => [a.id, i]));
  const planSlug = new Map(planRows.map((p) => [p.id, p.slug]));

  const artefacts = ordered.map(
    (a): ArtefactRecord =>
      clean({
        id: a.id,
        type: "Artefact" as const,
        namespace: a.namespace,
        kind: a.kind,
        code: opt(a.code),
        title: a.title,
        language: a.language,
        parent: opt(a.parentId),
        ordinal: opt(a.ordinal),
        url: opt(a.url),
        ref: opt(a.ref),
      }),
  );
  const alignments = alignmentRows
    .sort(
      (a, b) =>
        position.get(a.artefactId)! - position.get(b.artefactId)! ||
        alignmentTypes.indexOf(a.alignmentType) - alignmentTypes.indexOf(b.alignmentType) ||
        (a.part ?? "").localeCompare(b.part ?? "") ||
        a.targetId.localeCompare(b.targetId) ||
        a.id.localeCompare(b.id),
    )
    .map(
      (a): AlignmentRecord =>
        clean({
          id: a.id,
          type: "Alignment" as const,
          artefact: a.artefactId,
          part: opt(a.part),
          alignmentType: a.alignmentType,
          target: a.targetId,
          targetKind: a.targetKind,
          source: clean({ kind: a.sourceKind, model: opt(a.sourceModel), promptVersion: opt(a.sourcePromptVersion), by: opt(a.sourceBy), date: opt(a.sourceDate) }),
          status: a.status,
          confidence: opt(a.confidence),
          rationale: opt(a.rationale),
        }),
    );
  const placements = placementRows
    .sort((a, b) => planSlug.get(a.planId)!.localeCompare(planSlug.get(b.planId)!) || a.ordinal - b.ordinal || a.id.localeCompare(b.id))
    .map(
      (p): PlacementRecord =>
        clean({
          id: p.id,
          type: "OverlayPlacement" as const,
          plan: p.planId,
          artefact: p.artefactId,
          educationLevel: p.educationLevelId,
          term: opt(p.term),
          weekStart: opt(p.weekStart),
          weekEnd: opt(p.weekEnd),
          hours: p.hours === null ? undefined : Number(p.hours),
          ordinal: p.ordinal,
        }),
    );

  return {
    manifest: clean({
      spec: OVERLAY_SPEC_VERSION,
      kind: "overlay" as const,
      client: { namespace: profile.namespace, name: profile.name },
      base: clean({ slug: profile.baseSlug, framework: profile.baseFramework, version: profile.baseVersion, manifestSha256: opt(profile.baseManifestSha256) }),
      version: opt(profile.version),
      updated: options.updated,
    }),
    profile: {
      type: "ClientProfile",
      namespace: profile.namespace,
      name: profile.name,
      artefactKinds: kinds.map((k) =>
        clean({ kind: k.kind, label: k.label, description: opt(k.description), alignments: k.alignments, learningResourceType: opt(k.learningResourceType) }),
      ),
    },
    artefacts,
    alignments,
    plans: planRows.map((p) => ({ id: p.id, type: "OverlayPlan" as const, namespace: p.namespace, slug: p.slug, title: p.title })),
    placements,
  };
}
