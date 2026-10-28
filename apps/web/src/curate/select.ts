import type { Db, ObjectKind } from "@ocg/db";
import { type SQL, sql } from "drizzle-orm";
import type { ScreenType } from "@/review/reasons";
import type { NewBatchItem } from "./create-batch";

// Choosing what to put to a reviewer next.

export interface Candidate {
  objectId: string;
  objectKind: ObjectKind;
  screen: ScreenType;
  /** For the curator: "INT-03 needs INT-02", "MIS-031 Subtracting a negative…". */
  label: string;
}

export interface PlannedItem extends NewBatchItem {
  screen: ScreenType;
  label: string;
  isControl: boolean;
}

/**
 * Items ready for review, in curriculum order: still proposed, not decided on
 * their current revision, not waiting in an open batch, and not planted.
 * Within a concept, its card comes before its prerequisite links and mistakes.
 * Topics, if given, are the curriculum's own topic codes ("1.3").
 */
export async function candidates(
  db: Db,
  q: { frameworkId: string; screens: ScreenType[]; topics?: string[] },
): Promise<Candidate[]> {
  const parts: SQL[] = [];
  if (q.screens.includes("card")) {
    parts.push(sql`
      select c.id as object_id, 'concept' as object_kind, 'card' as screen, 0 as rank,
             c.human_code || ' ' || (c.title ->> 'en') as label, ${conceptOrder(sql`c.id`)} as ord
        from concept c
       where c.framework_id = ${q.frameworkId} and c.status = 'proposed'
         and ${ready(sql`c.id`, sql`c.revision`)} and ${inTopics(sql`c.id`, q.topics)}`);
  }
  if (q.screens.includes("prerequisite")) {
    parts.push(sql`
      select l.id as object_id, 'link' as object_kind, 'prerequisite' as screen, 1 as rank,
             fc.human_code || ' needs ' || tc.human_code as label, ${conceptOrder(sql`l.from_id`)} as ord
        from link l
        join concept fc on fc.id = l.from_id
        join concept tc on tc.id = l.to_id
       where l.link_type = 'needs' and fc.framework_id = ${q.frameworkId} and l.status = 'proposed'
         and ${ready(sql`l.id`, sql`l.revision`)} and ${inTopics(sql`l.from_id`, q.topics)}`);
  }
  if (q.screens.includes("mistake")) {
    parts.push(sql`
      select m.id as object_id, 'misconception' as object_kind, 'mistake' as screen, 2 as rank,
             m.human_code || ' ' || (m.statement ->> 'en') as label,
             (select min(${conceptOrder(sql`h.to_id`)}) from link h
               where h.link_type = 'hinders' and h.from_id = m.id and h.status <> 'rejected') as ord
        from misconception m
       where m.framework_id = ${q.frameworkId} and m.status = 'proposed'
         and ${ready(sql`m.id`, sql`m.revision`)}
         and exists (select 1 from link h where h.link_type = 'hinders' and h.from_id = m.id
                       and h.status <> 'rejected' and ${inTopics(sql`h.to_id`, q.topics)})`);
  }
  if (parts.length === 0) return [];

  const rows = await db.execute<{ object_id: string; object_kind: ObjectKind; screen: ScreenType; label: string }>(
    sql`select * from (${sql.join(parts, sql` union all `)}) items order by ord nulls last, rank, label`,
  );
  return rows.map((r) => ({ objectId: r.object_id, objectKind: r.object_kind, screen: r.screen, label: r.label }));
}

/**
 * A batch for one reviewer: up to `size` items. Controls are optional, chosen
 * by an admin to calibrate a new reviewer: `controls` of them, planted items
 * this reviewer has not seen, placed at random among the real items but never
 * first or last. None by default.
 */
export async function planBatch(
  db: Db,
  q: {
    frameworkId: string;
    reviewerId: string;
    screens: ScreenType[];
    topics?: string[];
    size?: number;
    controls?: number;
    random?: () => number;
  },
): Promise<{ items: PlannedItem[]; controlsShort: number }> {
  const size = q.size ?? 20;
  const wanted = Math.min(q.controls ?? 0, size);
  const random = q.random ?? Math.random;

  const plants = shuffle(await unseenPlants(db, q), random).slice(0, wanted);
  const real = (await candidates(db, q)).slice(0, size - plants.length);
  const items: PlannedItem[] = real.map((c) => ({ ...c, isControl: false }));
  for (const p of plants) {
    // Between two real items when there are two; anywhere otherwise.
    const at = items.length >= 2 ? 1 + Math.floor(random() * (items.length - 1)) : Math.floor(random() * (items.length + 1));
    items.splice(at, 0, { ...p, isControl: true });
  }
  return { items, controlsShort: wanted - plants.length };
}

/** Planted items for these screens that this reviewer has never been given. */
async function unseenPlants(db: Db, q: { frameworkId: string; reviewerId: string; screens: ScreenType[] }) {
  const rows = await db.execute<{ object_id: string; object_kind: ObjectKind; screen: ScreenType; label: string }>(sql`
    select p.object_id, p.object_kind,
           case when p.object_kind = 'concept' then 'card'
                when p.object_kind = 'misconception' then 'mistake'
                else 'prerequisite' end as screen,
           coalesce(c.human_code || ' ' || (c.title ->> 'en'),
                    m.human_code || ' ' || (m.statement ->> 'en'),
                    fc.human_code || ' needs ' || tc.human_code) as label
      from planted p
      left join concept c on c.id = p.object_id
      left join misconception m on m.id = p.object_id
      left join link l on l.id = p.object_id and l.link_type = 'needs'
      left join concept fc on fc.id = l.from_id
      left join concept tc on tc.id = l.to_id
     where coalesce(c.framework_id, m.framework_id, fc.framework_id) = ${q.frameworkId}
       and not exists (select 1 from batch_item bi join batch b on b.id = bi.batch_id
                        where bi.object_id = p.object_id and b.assigned_to = ${q.reviewerId})
     order by p.created_at`);
  return rows
    .map((r) => ({ objectId: r.object_id, objectKind: r.object_kind, screen: r.screen, label: r.label }))
    .filter((r) => q.screens.includes(r.screen));
}

/** Not planted, not waiting in an open batch, and not yet decided on this revision. */
function ready(id: SQL, revision: SQL) {
  return sql`not exists (select 1 from planted p where p.object_id = ${id})
    and not exists (select 1 from batch_item bi join batch b on b.id = bi.batch_id
                     where bi.object_id = ${id} and b.closed_at is null)
    and not exists (select 1 from judgement j
                     where j.object_id = ${id} and j.object_revision = ${revision} and not j.is_control
                       and not exists (select 1 from judgement later where later.supersedes_id = j.id))`;
}

/** Where a concept sits in the curriculum: the first line that defines it, by page and position. */
function conceptOrder(conceptId: SQL) {
  return sql`(select min(array[coalesce(s.page, 2147483647), s.ordinal])
                from link d join statement s on s.id = d.from_id
               where d.link_type = 'defines' and d.to_id = ${conceptId} and d.status <> 'rejected')`;
}

/** Whether a concept is defined by a line under one of these topics. True when no topics are given. */
function inTopics(conceptId: SQL, topics: string[] | undefined) {
  if (!topics?.length) return sql`true`;
  return sql`exists (select 1 from link d
                       join statement s on s.id = d.from_id
                       join node n on n.id = s.node_id
                      where d.link_type = 'defines' and d.to_id = ${conceptId} and d.status <> 'rejected'
                        and n.human_code in (${sql.join(
                          topics.map((t) => sql`${t}`),
                          sql`, `,
                        )}))`;
}

function shuffle<T>(items: T[], random: () => number) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
