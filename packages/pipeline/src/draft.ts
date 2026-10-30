import { readFile } from "node:fs/promises";
import { type Db, schema } from "@ocg/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

// Loads an AI draft of a base's interpretation: families, concepts with their
// levels, prerequisite links and typical mistakes. Each link is sourced to the
// drafting run (model and prompt version), except a prerequisite the
// curriculum itself states, which cites that statement. Each mistake cites the
// curriculum note that names it, or a publication that documents it, or
// nothing, which flags it unsourced. Everything loads as proposed; only
// reviewers' judgements change that.
//
// Objects are matched by code and links by type and ends, so loading a
// revised draft updates what changed. The database then raises the revision
// and returns a reviewed object to proposed. Nothing is deleted.

const langString = z.record(z.string(), z.string().min(1)).refine((m) => Object.keys(m).length > 0);
const code = z.string().regex(/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/);

export const draftFile = z.strictObject({
  framework: z.string(),
  source: z.strictObject({
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    citation: z.string().min(1).optional(),
  }),
  families: z.array(z.strictObject({ code, title: langString, description: langString.optional() })),
  concepts: z.array(
    z.strictObject({
      code,
      family: code,
      title: langString,
      description: langString.optional(),
      kind: z.enum(schema.conceptKind.enumValues),
      gateway: z.boolean().default(false),
      /** Codes of the statements that define it. */
      definedBy: z.array(z.string()).min(1),
      /** Where siblings differ only by a parameter, such as a number range or a sign: the steps, in order (ADR-003). */
      levels: z.array(z.strictObject({ title: langString, description: langString.optional() })).optional(),
      rationale: z.string().min(1),
    }),
  ),
  misconceptions: z.array(
    z.strictObject({
      code,
      statement: langString,
      example: langString.optional(),
      hinders: z.array(code).min(1),
      /** The code of the curriculum note that names the mistake, or null. */
      evidence: z.string().nullable(),
      /** Or a publication that documents it. With neither, the mistake is unsourced. */
      publication: z.strictObject({ citation: z.string().min(1), url: z.url().optional() }).optional(),
      rationale: z.string().min(1),
    }),
  ),
  needs: z.array(
    z.strictObject({
      from: code,
      to: code,
      rationale: z.string().min(1),
      /** The code of a statement in which the curriculum itself says so; the link then cites it rather than the drafting run. */
      evidence: z.string().optional(),
    }),
  ),
});
export type DraftFile = z.infer<typeof draftFile>;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type LinkType = (typeof schema.linkType.enumValues)[number];
type Kind = (typeof schema.objectKind.enumValues)[number];

export interface DraftReport {
  families: number;
  concepts: number;
  levels: number;
  misconceptions: number;
  links: Record<string, number>;
  unsourcedMistakes: number;
  /** Objects of this framework the draft no longer has: left alone, to be retired by hand if wrong. */
  notInDraft: string[];
}

export async function readDraft(file: string): Promise<DraftFile> {
  const parsed = draftFile.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  const d = parsed.data;
  const problems: string[] = [];
  const families = new Set(d.families.map((f) => f.code));
  const concepts = new Set(d.concepts.map((c) => c.code));
  for (const c of d.concepts) if (!families.has(c.family)) problems.push(`${c.code}: no family ${c.family}`);
  for (const m of d.misconceptions) {
    for (const h of m.hinders) if (!concepts.has(h)) problems.push(`${m.code}: no concept ${h}`);
    if (m.evidence && m.publication) problems.push(`${m.code}: cites both a curriculum note and a publication; give one source`);
  }
  for (const n of d.needs) {
    if (!concepts.has(n.from)) problems.push(`needs: no concept ${n.from}`);
    if (!concepts.has(n.to)) problems.push(`needs: no concept ${n.to}`);
  }
  const without = new Set(d.concepts.map((c) => c.code));
  for (const m of d.misconceptions) for (const h of m.hinders) without.delete(h);
  for (const c of without) problems.push(`${c}: no typical mistake (a concept needs one)`);
  for (const [what, codes] of [
    ["family", d.families.map((f) => f.code)],
    ["concept", d.concepts.map((c) => c.code)],
    ["mistake", d.misconceptions.map((m) => m.code)],
  ] as const) {
    const seen = new Set<string>();
    for (const c of codes) {
      if (seen.has(c)) problems.push(`${what} ${c} appears twice`);
      seen.add(c);
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  return d;
}

export async function loadDraft(db: Db, d: DraftFile): Promise<DraftReport> {
  const [fw] = await db.select().from(schema.framework).where(eq(schema.framework.slug, d.framework));
  if (!fw) throw new Error(`no framework ${d.framework}: import its transcription first`);
  const frameworkId = fw.id;

  // Statements by code, within this framework's documents.
  const statementCodes = [
    ...new Set([...d.concepts.flatMap((c) => c.definedBy), ...d.misconceptions.flatMap((m) => m.evidence ?? []), ...d.needs.flatMap((n) => n.evidence ?? [])]),
  ];
  const rows = await db
    .select({ id: schema.statement.id, code: schema.statement.humanCode })
    .from(schema.statement)
    .innerJoin(schema.document, eq(schema.document.id, schema.statement.documentId))
    .where(and(eq(schema.document.frameworkId, frameworkId), inArray(schema.statement.humanCode, statementCodes)));
  const statementId = new Map<string, string>();
  for (const r of rows) {
    if (statementId.has(r.code!)) throw new Error(`statement code ${r.code} is not unique in ${d.framework}`);
    statementId.set(r.code!, r.id);
  }
  const unknown = statementCodes.filter((c) => !statementId.has(c));
  if (unknown.length) throw new Error(`no statements ${unknown.join(", ")} in ${d.framework}`);

  const report: DraftReport = { families: 0, concepts: 0, levels: 0, misconceptions: 0, links: {}, unsourcedMistakes: 0, notInDraft: [] };

  await db.transaction(async (tx) => {
    const ai = await aiSource(tx, frameworkId, d.source);

    const familyId = new Map<string, string>();
    for (const f of d.families) {
      familyId.set(f.code, await upsertByCode(tx, schema.family, frameworkId, f.code, { title: f.title, description: f.description ?? null }));
    }
    report.families = d.families.length;

    const conceptId = new Map<string, string>();
    for (const c of d.concepts) {
      conceptId.set(
        c.code,
        await upsertByCode(tx, schema.concept, frameworkId, c.code, {
          title: c.title,
          description: c.description ?? null,
          kind: c.kind,
          isGateway: c.gateway,
        }),
      );
    }
    report.concepts = d.concepts.length;

    // Levels by their place in the concept's list: a revised draft updates them in place.
    for (const c of d.concepts) {
      for (const [i, l] of (c.levels ?? []).entries()) {
        await upsertLevel(tx, conceptId.get(c.code)!, i + 1, { title: l.title, description: l.description ?? null });
        report.levels++;
      }
    }

    const link = async (linkType: LinkType, from: [string, Kind], to: [string, Kind], rationale: string | null, sourceId = ai) => {
      await upsertLink(tx, { linkType, fromId: from[0], fromKind: from[1], toId: to[0], toKind: to[1], sourceId, rationale });
      report.links[linkType] = (report.links[linkType] ?? 0) + 1;
    };
    for (const c of d.concepts) {
      const id = conceptId.get(c.code)!;
      await link("part-of", [id, "concept"], [familyId.get(c.family)!, "family"], null);
      for (const s of c.definedBy) await link("defines", [statementId.get(s)!, "statement"], [id, "concept"], c.rationale);
    }

    for (const m of d.misconceptions) {
      const evidence = m.evidence
        ? await statementSource(tx, frameworkId, statementId.get(m.evidence)!)
        : m.publication
          ? await publicationSource(tx, frameworkId, m.publication)
          : null;
      if (!evidence) report.unsourcedMistakes++;
      const id = await upsertByCode(tx, schema.misconception, frameworkId, m.code, {
        statement: m.statement,
        example: m.example ?? null,
        sourceId: evidence,
      });
      for (const h of m.hinders) await link("hinders", [id, "misconception"], [conceptId.get(h)!, "concept"], m.rationale);
    }
    report.misconceptions = d.misconceptions.length;

    for (const n of d.needs) {
      const source = n.evidence ? await statementSource(tx, frameworkId, statementId.get(n.evidence)!) : ai;
      await link("needs", [conceptId.get(n.from)!, "concept"], [conceptId.get(n.to)!, "concept"], n.rationale, source);
    }

    // What this framework holds that the draft no longer does.
    const drafted = new Set([...d.families.map((f) => f.code), ...d.concepts.map((c) => c.code), ...d.misconceptions.map((m) => m.code)]);
    for (const table of [schema.family, schema.concept, schema.misconception]) {
      const held = await tx.select({ code: table.humanCode }).from(table).where(eq(table.frameworkId, frameworkId));
      report.notInDraft.push(...held.map((h) => h.code).filter((c) => !drafted.has(c)));
    }
  });
  return report;
}

/** The drafting run's source: one per model and prompt version. */
async function aiSource(tx: Tx, frameworkId: string, s: DraftFile["source"]): Promise<string> {
  const { source } = schema;
  const [found] = await tx
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.frameworkId, frameworkId), eq(source.kind, "ai"), eq(source.model, s.model), eq(source.promptVersion, s.promptVersion)));
  if (found) return found.id;
  const [made] = await tx
    .insert(source)
    .values({ frameworkId, kind: "ai", model: s.model, promptVersion: s.promptVersion, citation: s.citation ?? null })
    .returning({ id: source.id });
  return made!.id;
}

/** A curriculum statement as a source: one per statement. */
async function statementSource(tx: Tx, frameworkId: string, statementId: string): Promise<string> {
  const { source } = schema;
  const [found] = await tx
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.frameworkId, frameworkId), eq(source.kind, "statement"), eq(source.statementId, statementId)));
  if (found) return found.id;
  const [made] = await tx.insert(source).values({ frameworkId, kind: "statement", statementId }).returning({ id: source.id });
  return made!.id;
}

/** A publication as a source: one per citation. */
async function publicationSource(tx: Tx, frameworkId: string, p: { citation: string; url?: string }): Promise<string> {
  const { source } = schema;
  const [found] = await tx
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.frameworkId, frameworkId), eq(source.kind, "publication"), eq(source.citation, p.citation)));
  if (found) {
    await tx.update(source).set({ url: p.url ?? null }).where(eq(source.id, found.id));
    return found.id;
  }
  const [made] = await tx.insert(source).values({ frameworkId, kind: "publication", citation: p.citation, url: p.url ?? null }).returning({ id: source.id });
  return made!.id;
}

/** A concept's level at a place in its order, updated, or created. Its status is never touched. */
async function upsertLevel(tx: Tx, conceptId: string, ordinal: number, values: { title: Record<string, string>; description: Record<string, string> | null }) {
  const { level } = schema;
  const [found] = await tx
    .select({ id: level.id })
    .from(level)
    .where(and(eq(level.conceptId, conceptId), eq(level.ordinal, ordinal)));
  if (found) await tx.update(level).set(values).where(eq(level.id, found.id));
  else await tx.insert(level).values({ conceptId, ordinal, ...values });
}

type ByCode = typeof schema.family | typeof schema.concept | typeof schema.misconception;

/** Finds an object by its code in the framework, updating it, or creates it. Its status is never touched. */
async function upsertByCode(tx: Tx, table: ByCode, frameworkId: string, humanCode: string, values: Record<string, unknown>): Promise<string> {
  const [found] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.frameworkId, frameworkId), eq(table.humanCode, humanCode)));
  if (found) {
    await tx
      .update(table)
      .set(values as never)
      .where(eq(table.id, found.id));
    return found.id;
  }
  const [made] = (await tx
    .insert(table)
    .values({ frameworkId, humanCode, ...values } as never)
    .returning({ id: table.id })) as { id: string }[];
  return made!.id;
}

/** Finds a link by its type and ends, updating its source and rationale, or creates it. */
async function upsertLink(
  tx: Tx,
  l: { linkType: LinkType; fromId: string; fromKind: Kind; toId: string; toKind: Kind; sourceId: string; rationale: string | null },
) {
  const { link } = schema;
  const [found] = await tx
    .select({ id: link.id })
    .from(link)
    .where(and(eq(link.linkType, l.linkType), eq(link.fromId, l.fromId), eq(link.toId, l.toId)));
  if (found) {
    await tx.update(link).set({ sourceId: l.sourceId, rationale: l.rationale }).where(eq(link.id, found.id));
  } else {
    await tx.insert(link).values(l);
  }
}
