import { type Db, schema } from "@ocg/db";
import { eq, inArray, type InferInsertModel } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { allNodes, type BaseFiles, type NodeFile, topicStatements } from "./files";

// Loads a base's transcription into the working database: framework, grades,
// documents and their headings, statements, teaching plans and placements.
//
// Every object keeps the ID its file gives it. Running the import again
// changes nothing that has not changed; a changed object is updated, and the
// database raises its revision. Nothing is deleted: an object that is in the
// database but no longer in the files is an error, to be retired instead.

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Synced = PgTable & { id: PgColumn; revision: PgColumn };

export interface Counts {
  added: number;
  changed: number;
  unchanged: number;
}
export type ImportReport = Record<string, Counts>;

export async function importBase(db: Db, base: BaseFiles): Promise<ImportReport> {
  requireIds(base);
  const fw = base.framework.data;
  const report: ImportReport = {};

  await db.transaction(async (tx) => {
    const frameworkId = fw.id!;
    report.framework = await sync(tx, schema.framework, [
      {
        id: frameworkId,
        slug: fw.slug,
        title: fw.title,
        jurisdiction: fw.jurisdiction,
        subject: fw.subject,
        publisher: fw.publisher ?? null,
        nodeTypes: fw.nodeTypes,
      },
    ]);
    report.grades = await sync(
      tx,
      schema.educationLevel,
      fw.educationLevels.map((l) => ({
        id: l.id!,
        frameworkId,
        code: l.code,
        title: l.title,
        iscedLevel: l.iscedLevel,
        ordinal: l.ordinal,
      })),
    );
    const grade = new Map(fw.educationLevels.map((l) => [l.code, l.id!]));

    report.documents = await sync(
      tx,
      schema.document,
      base.documents.map(({ data: d }) => ({
        id: d.id!,
        frameworkId,
        title: d.title,
        language: d.language,
        publisher: d.publisher ?? null,
        issued: d.issued ?? null,
        versionLabel: d.versionLabel ?? null,
        url: d.url ?? null,
        rights: d.rights ?? null,
      })),
    );

    // Headings, parents before children, each numbered among its siblings.
    const nodeRows: (InferInsertModel<typeof schema.node> & { id: string })[] = [];
    const nodeIds = new Map<string, Map<string, string>>();
    for (const { name, data: d } of base.documents) {
      const codes = new Map<string, string>();
      const walk = (nodes: NodeFile[], parentId: string | null) =>
        nodes.forEach((n, i) => {
          nodeRows.push({ id: n.id!, documentId: d.id!, parentId, nodeType: n.type, humanCode: n.code ?? null, title: n.title, ordinal: i + 1 });
          if (n.code) codes.set(n.code, n.id!);
          walk(n.children ?? [], n.id!);
        });
      walk(d.nodes, null);
      nodeIds.set(name, codes);
    }
    report.headings = await sync(tx, schema.node, nodeRows);

    const docId = new Map(base.documents.map((d) => [d.name, d.data.id!]));
    const statementRows: (InferInsertModel<typeof schema.statement> & { id: string })[] = base.topics.flatMap(({ data: t }) =>
      topicStatements(t).map(({ statement: s, parent, column, heading, type, ordinal }) => ({
        id: s.id!,
        documentId: docId.get(t.document)!,
        nodeId: nodeIds.get(t.document)!.get(t.topic)!,
        parentId: parent?.id ?? null,
        educationLevelId: grade.get(t.grade)!,
        statementType: type,
        isRevision: s.revise ?? false,
        humanCode: s.code ?? null,
        text: s.text,
        page: s.page,
        locator: [
          `Grade ${t.grade}${t.term ? `, Term ${t.term}` : ""}`,
          column === "concepts" ? "Concepts and skills" : "Clarification notes",
          ...(heading ? [heading] : []),
        ].join(" · "),
        ordinal,
      })),
    );
    report.statements = await sync(tx, schema.statement, statementRows);

    report.teachingPlans = await sync(
      tx,
      schema.teachingPlan,
      base.teachingPlans.map(({ data: p }) => ({
        id: p.id!,
        frameworkId,
        documentId: docId.get(p.document)!,
        slug: p.slug,
        title: p.title,
      })),
    );
    report.placements = await sync(
      tx,
      schema.placement,
      base.teachingPlans.flatMap(({ data: p }) =>
        p.placements.map((pl, i) => ({
          id: pl.id!,
          teachingPlanId: p.id!,
          targetId: nodeIds.get(p.document)!.get(pl.node)!,
          targetKind: "node" as const,
          educationLevelId: grade.get(pl.grade)!,
          term: pl.term ?? null,
          weekStart: pl.weekStart ?? null,
          weekEnd: pl.weekEnd ?? null,
          hours: pl.hours === undefined ? null : pl.hours.toFixed(1),
          ordinal: i + 1,
        })),
      ),
    );

    // Nothing the files no longer hold may stay behind unnoticed.
    const documentIds = base.documents.map((d) => d.data.id!);
    const planIds = base.teachingPlans.map((p) => p.data.id!);
    await requireNoneLeft(tx, "headings", schema.node, schema.node.documentId, documentIds, nodeRows);
    await requireNoneLeft(tx, "statements", schema.statement, schema.statement.documentId, documentIds, statementRows);
    if (planIds.length) {
      const placementIds = base.teachingPlans.flatMap((p) => p.data.placements.map((pl) => ({ id: pl.id! })));
      await requireNoneLeft(tx, "placements", schema.placement, schema.placement.teachingPlanId, planIds, placementIds);
    }
  });
  return report;
}

/**
 * Inserts the rows not yet in the table and updates the rest. The registry
 * trigger refuses a second insert of an ID, so existing rows are found first
 * rather than upserted. Rows are inserted in the order given, parents first.
 */
async function sync<T extends Synced>(tx: Tx, table: T, rows: (InferInsertModel<T> & { id: string })[]): Promise<Counts> {
  const counts: Counts = { added: 0, changed: 0, unchanged: 0 };
  if (rows.length === 0) return counts;
  const t = table as Synced;
  const existing = (await tx
    .select({ id: t.id, revision: t.revision })
    .from(t)
    .where(
      inArray(
        t.id,
        rows.map((r) => r.id),
      ),
    )) as { id: string; revision: number }[];
  const before = new Map(existing.map((e) => [e.id, e.revision]));

  const fresh = rows.filter((r) => !before.has(r.id));
  for (let i = 0; i < fresh.length; i += 500) {
    await tx.insert(table).values(fresh.slice(i, i + 500) as never);
  }
  counts.added = fresh.length;

  for (const row of rows.filter((r) => before.has(r.id))) {
    const { id, ...rest } = row;
    const [after] = (await tx
      .update(table)
      .set(rest as never)
      .where(eq(t.id, id))
      .returning({ revision: t.revision })) as { revision: number }[];
    if (after!.revision !== before.get(id)) counts.changed++;
    else counts.unchanged++;
  }
  return counts;
}

/** Fails if the database holds objects of these parents that the files do not. */
async function requireNoneLeft(
  tx: Tx,
  what: string,
  table: Synced,
  parent: PgColumn,
  parentIds: string[],
  rows: { id?: string | null }[],
) {
  if (parentIds.length === 0) return;
  const inFiles = new Set(rows.map((r) => r.id));
  const inDb = (await tx.select({ id: table.id }).from(table).where(inArray(parent, parentIds))) as { id: string }[];
  const left = inDb.filter((r) => !inFiles.has(r.id));
  if (left.length > 0) {
    throw new Error(
      `${left.length} ${what} are in the database but no longer in the files (${left
        .slice(0, 3)
        .map((r) => r.id)
        .join(", ")}${left.length > 3 ? ", ..." : ""}). Nothing is deleted: retire them instead.`,
    );
  }
}

/** Every object must have its permanent ID before it is loaded. */
function requireIds(base: BaseFiles) {
  const missing: string[] = [];
  const need = (id: string | undefined, what: string) => {
    if (!id) missing.push(what);
  };
  need(base.framework.data.id, "the framework");
  base.framework.data.educationLevels.forEach((l) => need(l.id, `grade ${l.code}`));
  for (const d of base.documents) {
    need(d.data.id, d.name);
    allNodes(d.data.nodes).forEach((n) => need(n.id, `${d.name} heading ${n.code ?? n.title}`));
  }
  for (const p of base.teachingPlans) {
    need(p.data.id, p.name);
    p.data.placements.forEach((pl) => need(pl.id, `${p.name} placement of ${pl.node}`));
  }
  for (const t of base.topics) {
    topicStatements(t.data).forEach(({ statement: s }) => {
      need(s.id, `${t.name} "${s.text.slice(0, 30)}"`);
      need(s.code, `${t.name} code of "${s.text.slice(0, 30)}"`);
    });
  }
  if (missing.length) {
    throw new Error(`${missing.length} objects have no ID or code yet (${missing.slice(0, 3).join("; ")}): run pnpm base mint first`);
  }
}
