import type { Db } from "@ocg/db";
import { type SQL, sql } from "drizzle-orm";
import { live } from "@/curate/select";

// The graph view's data: one framework's curriculum lines and our reading of
// them, as a plain document of nodes and edges that the map, the table and
// the tests all read. Built on the server for each viewer. Deliberately
// absent: planted controls (never shown as neighbours, ADR-029), rejected and
// retired objects, and the AI's agreement score (ADR-028). A client's
// artefacts would be one more kind of node, with alignment edges, laid over
// the same document.

/**
 * How far an item is through review. "reviewed": one reviewer has confirmed
 * it and nobody has objected; it waits for a second (ADR-032). Shown only to
 * those who may see progress; for everyone else it reads as proposed.
 */
export type GraphStatus = "proposed" | "reviewed" | "confirmed";

interface NodeBase {
  id: string;
  /** The human code: "1.3", "8/1.3/c04", "INT-03", "MIS-031". */
  code: string;
}

/** A heading in the curriculum document: a content area or topic. */
export interface TopicNode extends NodeBase {
  kind: "topic";
  title: string;
  nodeType: string;
}

/** A curriculum line, word for word: a content bullet, or any line that defines a concept. */
export interface StatementNode extends NodeBase {
  kind: "statement";
  text: string;
  page: number | null;
  statementType: string;
  isRevision: boolean;
  /** The heading it sits under: "1.3 Integers". */
  topic: string | null;
  /** The document it quotes. */
  document: string;
}

export interface ConceptNode extends NodeBase {
  kind: "concept";
  title: string;
  description: string | null;
  conceptKind: string | null;
  isGateway: boolean;
  /** Family code, if it has one. */
  family: string | null;
  status: GraphStatus;
}

export interface MistakeNode extends NodeBase {
  kind: "mistake";
  statement: string;
  example: string | null;
  /** Whether it cites a source; unsourced mistakes are flagged as such. */
  sourced: boolean;
  status: GraphStatus;
}

export type GraphNode = TopicNode | StatementNode | ConceptNode | MistakeNode;

/**
 * Drawn from `source` to `target`, in reading order: a prerequisite is
 * "needed for" the concept that needs it; a line defines a concept; a mistake
 * hinders a concept; a line or heading sits under its parent.
 */
export interface GraphEdge {
  id: string;
  type: "needs" | "defines" | "hinders" | "under";
  source: string;
  target: string;
  /** Links only; "under" is the document's own structure. */
  status?: GraphStatus;
  /** Why the link was proposed. */
  rationale?: string | null;
}

export interface Tally {
  total: number;
  reviewed: number;
  confirmed: number;
}

export interface BaseGraph {
  framework: { id: string; slug: string; title: string };
  /** In curriculum order: the order of each family's first concept. */
  families: { code: string; title: string }[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: { concepts: Tally; prerequisites: Tally; mistakes: Tally };
  seesProgress: boolean;
}

/** The frameworks there are, most concepts first. */
export async function frameworksWithConcepts(db: Db) {
  const rows = await db.execute<{ id: string; slug: string; title: string; concepts: number }>(sql`
    select f.id, f.slug, f.title ->> 'en' as title,
           (select count(*)::int from concept c where c.framework_id = f.id) as concepts
      from framework f
     order by concepts desc, f.slug`);
  return rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title, concepts: r.concepts }));
}

export async function buildGraph(db: Db, frameworkId: string, opts: { seesProgress: boolean }): Promise<BaseGraph> {
  const status = (table: string) => graphStatus(sql.raw(table), opts.seesProgress);

  const [framework] = await db.execute<{ id: string; slug: string; title: string }>(
    sql`select id, slug, title ->> 'en' as title from framework where id = ${frameworkId}`,
  );
  if (!framework) {
    throw new Error(`no framework ${frameworkId}`);
  }

  const headings = await db.execute<{
    id: string;
    code: string | null;
    title: string;
    node_type: string;
    parent_id: string | null;
  }>(sql`
    select n.id, n.human_code as code, n.title, n.node_type, n.parent_id
      from node n join document d on d.id = n.document_id
     where d.framework_id = ${frameworkId} and ${current(sql`n.id`)}
     order by n.ordinal, n.human_code`);

  const lines = await db.execute<{
    id: string;
    code: string | null;
    text: string;
    page: number | null;
    statement_type: string;
    is_revision: boolean;
    node_id: string | null;
    parent_id: string | null;
    document: string;
  }>(sql`
    select s.id, s.human_code as code, s.text, s.page, s.statement_type, s.is_revision, s.node_id, s.parent_id,
           d.title as document
      from statement s join document d on d.id = s.document_id
     where d.framework_id = ${frameworkId} and ${current(sql`s.id`)}
       and (s.statement_type = 'content'
            or exists (select 1 from link l where l.link_type = 'defines' and l.from_id = s.id and l.status <> 'rejected'))
     order by s.page nulls last, s.ordinal`);

  const concepts = await db.execute<{
    id: string;
    code: string;
    title: string;
    description: string | null;
    kind: string | null;
    is_gateway: boolean;
    family: string | null;
    status: GraphStatus;
  }>(sql`
    select c.id, c.human_code as code, c.title ->> 'en' as title, c.description ->> 'en' as description,
           c.kind, c.is_gateway, ${status("c")} as status,
           (select f.human_code from link p join family f on f.id = p.to_id
             where p.link_type = 'part-of' and p.from_id = c.id and p.status <> 'rejected' and f.status <> 'rejected'
             limit 1) as family
      from concept c
     where c.framework_id = ${frameworkId} and c.status <> 'rejected' and ${current(sql`c.id`)} and ${notPlanted(sql`c.id`)}
     order by (select min(array[coalesce(s.page, 2147483647), s.ordinal])
                 from link d join statement s on s.id = d.from_id
                where d.link_type = 'defines' and d.to_id = c.id and d.status <> 'rejected') nulls last,
              c.human_code`);

  const mistakes = await db.execute<{
    id: string;
    code: string;
    statement: string;
    example: string | null;
    sourced: boolean;
    status: GraphStatus;
  }>(sql`
    select m.id, m.human_code as code, m.statement ->> 'en' as statement, m.example ->> 'en' as example,
           m.source_id is not null as sourced, ${status("m")} as status
      from misconception m
     where m.framework_id = ${frameworkId} and m.status <> 'rejected' and ${current(sql`m.id`)} and ${notPlanted(sql`m.id`)}
     order by m.human_code`);

  const links = await db.execute<{
    id: string;
    type: "needs" | "defines" | "hinders";
    from_id: string;
    to_id: string;
    status: GraphStatus;
    rationale: string | null;
  }>(sql`
    select l.id, l.link_type as type, l.from_id, l.to_id, ${status("l")} as status, l.rationale
      from link l
     where l.link_type in ('needs', 'defines', 'hinders') and l.status <> 'rejected'
       and ${current(sql`l.id`)} and ${notPlanted(sql`l.id`)}
       and exists (select 1 from concept c where c.id = l.to_id and c.framework_id = ${frameworkId})
     order by l.link_type, l.id`);

  // Headings that hold a line on the map, and the headings above them.
  const headingById = new Map(headings.map((h) => [h.id, h]));
  const shownHeadings = new Set<string>();
  for (const line of lines) {
    for (let id = line.node_id; id && !shownHeadings.has(id); id = headingById.get(id)?.parent_id ?? null) {
      shownHeadings.add(id);
    }
  }
  const lineIds = new Set(lines.map((l) => l.id));

  const nodes: GraphNode[] = [
    ...headings
      .filter((h) => shownHeadings.has(h.id))
      .map((h): TopicNode => ({ kind: "topic", id: h.id, code: h.code ?? "", title: h.title, nodeType: h.node_type })),
    ...lines.map(
      (l): StatementNode => ({
        kind: "statement",
        id: l.id,
        code: l.code ?? "",
        text: l.text,
        page: l.page,
        statementType: l.statement_type,
        isRevision: l.is_revision,
        topic: headingLabel(l.node_id ? headingById.get(l.node_id) : undefined),
        document: l.document,
      }),
    ),
    ...concepts.map(
      (c): ConceptNode => ({
        kind: "concept",
        id: c.id,
        code: c.code,
        title: c.title,
        description: c.description,
        conceptKind: c.kind,
        isGateway: c.is_gateway,
        family: c.family,
        status: c.status,
      }),
    ),
    ...mistakes.map(
      (m): MistakeNode => ({
        kind: "mistake",
        id: m.id,
        code: m.code,
        statement: m.statement,
        example: m.example,
        sourced: m.sourced,
        status: m.status,
      }),
    ),
  ];
  const shown = new Set(nodes.map((n) => n.id));

  const edges: GraphEdge[] = [];
  for (const h of headings) {
    if (shownHeadings.has(h.id) && h.parent_id && shownHeadings.has(h.parent_id)) {
      edges.push({ id: `under:${h.id}`, type: "under", source: h.id, target: h.parent_id });
    }
  }
  for (const l of lines) {
    // A nested line hangs from the line above it when that is on the map, else from its heading.
    const parent = l.parent_id && lineIds.has(l.parent_id) ? l.parent_id : l.node_id;
    if (parent && shown.has(parent)) {
      edges.push({ id: `under:${l.id}`, type: "under", source: l.id, target: parent });
    }
  }
  for (const l of links) {
    // A prerequisite is drawn towards the concept that needs it.
    const [source, target] = l.type === "needs" ? [l.to_id, l.from_id] : [l.from_id, l.to_id];
    if (shown.has(source) && shown.has(target)) {
      edges.push({ id: l.id, type: l.type, source, target, status: l.status, rationale: l.rationale });
    }
  }

  const familyTitles = new Map(
    (
      await db.execute<{ code: string; title: string }>(sql`
        select human_code as code, title ->> 'en' as title from family
         where framework_id = ${frameworkId} and status <> 'rejected' and ${current(sql`id`)}`)
    ).map((f) => [f.code, f.title]),
  );
  const families: BaseGraph["families"] = [];
  for (const c of concepts) {
    if (c.family && !families.some((f) => f.code === c.family)) {
      families.push({ code: c.family, title: familyTitles.get(c.family) ?? c.family });
    }
  }

  return {
    framework,
    families,
    nodes,
    edges,
    counts: {
      concepts: tally(nodes.filter((n) => n.kind === "concept")),
      prerequisites: tally(edges.filter((e) => e.type === "needs")),
      mistakes: tally(nodes.filter((n) => n.kind === "mistake")),
    },
    seesProgress: opts.seesProgress,
  };
}

function headingLabel(heading: { code: string | null; title: string } | undefined) {
  return heading ? [heading.code, heading.title].filter(Boolean).join(" ") : null;
}

function tally(items: { status?: GraphStatus }[]): Tally {
  return {
    total: items.length,
    reviewed: items.filter((i) => i.status === "reviewed").length,
    confirmed: items.filter((i) => i.status === "confirmed").length,
  };
}

/**
 * An item's status as the viewer may see it: "reviewed" when it is still
 * proposed, a reviewer has confirmed this revision, and nobody's current
 * judgement objects. Planted controls never count (ADR-032).
 */
function graphStatus(t: SQL, seesProgress: boolean) {
  if (!seesProgress) return sql`${t}.status::text`;
  const id = sql`${t}.id`;
  const revision = sql`${t}.revision`;
  return sql`case when ${t}.status = 'proposed'
                   and exists ${live(id, revision, sql`j.decision = 'confirm'`)}
                   and not exists ${live(id, revision, sql`j.decision <> 'confirm'`)}
                  then 'reviewed' else ${t}.status::text end`;
}

/** Not retired. */
function current(id: SQL) {
  return sql`not exists (select 1 from base_object o where o.id = ${id} and o.retired_at is not null)`;
}

function notPlanted(id: SQL) {
  return sql`not exists (select 1 from planted p where p.object_id = ${id})`;
}
