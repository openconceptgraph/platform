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
  /** When each teaching plan teaches it, by plan slug. */
  when: Record<string, Placed>;
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
  /** When each teaching plan first teaches it, by plan slug. */
  when: Record<string, Placed>;
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

/**
 * When a teaching plan teaches something. A plan places topics, families or
 * concepts (ADR-005); a concept is taught when the first topic that defines
 * it is, unless the plan places the concept or its family itself.
 */
export interface Placed {
  term: number | null;
  weekStart: number | null;
  weekEnd: number | null;
  /** The hours the plan gives what it places, which may be a whole topic. */
  hours: number | null;
  /** What the plan places: a heading ("1.3 Integers"), or a family's or the concept's code. */
  of: string;
}

export interface TeachingPlan {
  slug: string;
  title: string;
  /** The document it is transcribed from. */
  document: string | null;
}

export interface BaseGraph {
  framework: { id: string; slug: string; title: string };
  /** In the order they were added: a curriculum's own plan before later ones. */
  plans: TeachingPlan[];
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
    family_id: string | null;
    status: GraphStatus;
  }>(sql`
    select c.id, c.human_code as code, c.title ->> 'en' as title, c.description ->> 'en' as description,
           c.kind, c.is_gateway, ${status("c")} as status, fam.human_code as family, fam.id as family_id
      from concept c
      left join lateral (
        select f.id, f.human_code from link p join family f on f.id = p.to_id
         where p.link_type = 'part-of' and p.from_id = c.id and p.status <> 'rejected' and f.status <> 'rejected'
         limit 1) fam on true
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

  const plans = await db.execute<{ slug: string; title: string; document: string | null }>(sql`
    select tp.slug, tp.title ->> 'en' as title, d.title as document
      from teaching_plan tp left join document d on d.id = tp.document_id
     where tp.framework_id = ${frameworkId} and ${current(sql`tp.id`)}
     order by tp.created_at, tp.slug`);
  const placements = await db.execute<{
    slug: string;
    target_id: string;
    term: number | null;
    week_start: number | null;
    week_end: number | null;
    hours: number | null;
  }>(sql`
    select tp.slug, p.target_id, p.term, p.week_start, p.week_end, p.hours::float8 as hours
      from placement p join teaching_plan tp on tp.id = p.teaching_plan_id
     where tp.framework_id = ${frameworkId} and ${current(sql`p.id`)}
     order by p.term nulls last, p.week_start nulls last, p.ordinal`);

  // Headings that hold a line on the map, and the headings above them.
  const headingById = new Map(headings.map((h) => [h.id, h]));
  const shownHeadings = new Set<string>();
  for (const line of lines) {
    for (let id = line.node_id; id && !shownHeadings.has(id); id = headingById.get(id)?.parent_id ?? null) {
      shownHeadings.add(id);
    }
  }
  const lineIds = new Set(lines.map((l) => l.id));

  // Each plan's earliest placement of each target, and when each node and concept is taught.
  const placedAt = new Map<string, Map<string, (typeof placements)[number]>>();
  for (const p of placements) {
    const byPlan = placedAt.get(p.target_id) ?? new Map();
    if (!byPlan.has(p.slug)) byPlan.set(p.slug, p);
    placedAt.set(p.target_id, byPlan);
  }
  /** For each plan, the first of these targets it places. */
  const whenOf = (targets: { id: string; of: string }[]) => {
    const when: Record<string, Placed> = {};
    for (const plan of plans) {
      for (const t of targets) {
        const p = placedAt.get(t.id)?.get(plan.slug);
        if (p) {
          when[plan.slug] = { term: p.term, weekStart: p.week_start, weekEnd: p.week_end, hours: p.hours, of: t.of };
          break;
        }
      }
    }
    return when;
  };
  /** A heading and the headings above it, as placement targets. */
  const headingAndAbove = (id: string | null) => {
    const out: { id: string; of: string }[] = [];
    for (let at = id; at; at = headingById.get(at)?.parent_id ?? null) out.push({ id: at, of: headingLabel(headingById.get(at))! });
    return out;
  };
  const lineOrder = new Map(lines.map((l, i) => [l.id, i]));
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const definingHeadings = new Map<string, { id: string; of: string }[]>();
  for (const l of links
    .filter((l) => l.type === "defines" && lineById.has(l.from_id))
    .sort((a, b) => lineOrder.get(a.from_id)! - lineOrder.get(b.from_id)!)) {
    const list = definingHeadings.get(l.to_id) ?? [];
    list.push(...headingAndAbove(lineById.get(l.from_id)!.node_id));
    definingHeadings.set(l.to_id, list);
  }

  const nodes: GraphNode[] = [
    ...headings
      .filter((h) => shownHeadings.has(h.id))
      .map(
        (h): TopicNode => ({
          kind: "topic",
          id: h.id,
          code: h.code ?? "",
          title: h.title,
          nodeType: h.node_type,
          when: whenOf(headingAndAbove(h.id)),
        }),
      ),
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
        when: whenOf([
          { id: c.id, of: c.code },
          ...(c.family_id ? [{ id: c.family_id, of: c.family! }] : []),
          ...(definingHeadings.get(c.id) ?? []),
        ]),
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
    plans: [...plans],
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
