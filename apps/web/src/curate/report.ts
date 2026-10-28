import { type Db, schema } from "@ocg/db";
import { and, eq, isNull, sql } from "drizzle-orm";

export interface BatchReport {
  id: string;
  title: string;
  reviewer: string;
  createdAt: Date;
  closedAt: Date | null;
  total: number;
  done: number;
  controls: { caught: number; missed: number; waiting: number };
  minutes: number;
}

/**
 * Each batch's progress, with how its reviewer did on the planted controls:
 * caught when their current decision matches the expected one. For the
 * curator only; reviewers never see which items were controls.
 */
export async function batchReports(db: Db, reviewerId?: string): Promise<BatchReport[]> {
  const rows = await db.execute<{
    id: string;
    title: string;
    reviewer: string;
    created_at: Date;
    closed_at: Date | null;
    total: number;
    done: number;
    caught: number;
    missed: number;
    waiting: number;
    seconds: number;
  }>(sql`
    with live as (
      select j.batch_id, j.object_id, j.decision, j.time_spent_ms
        from judgement j
       where j.batch_id is not null and j.covered_by_id is null
         and not exists (select 1 from judgement later where later.supersedes_id = j.id)
    )
    select b.id, b.title, u.name || coalesce(' (' || p.public_name || ')', '') as reviewer,
           b.created_at, b.closed_at,
           count(bi.object_id)::int as total,
           count(live.object_id)::int as done,
           count(*) filter (where bi.control_expected is not null and live.decision = bi.control_expected)::int as caught,
           count(*) filter (where bi.control_expected is not null and live.decision <> bi.control_expected)::int as missed,
           count(*) filter (where bi.control_expected is not null and live.decision is null)::int as waiting,
           coalesce(sum(live.time_spent_ms), 0) / 1000 as seconds
      from batch b
      join "user" u on u.id = b.assigned_to
      left join reviewer_profile p on p.user_id = b.assigned_to
      left join batch_item bi on bi.batch_id = b.id
      left join live on live.batch_id = b.id and live.object_id = bi.object_id
     where ${reviewerId ? sql`b.assigned_to = ${reviewerId}` : sql`true`}
     group by b.id, u.name, p.public_name
     order by b.created_at`);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    reviewer: r.reviewer,
    createdAt: new Date(r.created_at),
    closedAt: r.closed_at ? new Date(r.closed_at) : null,
    total: r.total,
    done: r.done,
    controls: { caught: r.caught, missed: r.missed, waiting: r.waiting },
    minutes: Math.round(Number(r.seconds) / 60),
  }));
}

/** Closes a batch: its reviewer can no longer record or change decisions in it. */
export async function closeBatch(db: Db, batchId: string) {
  const [closed] = await db
    .update(schema.batch)
    .set({ closedAt: sql`now()` })
    .where(and(eq(schema.batch.id, batchId), isNull(schema.batch.closedAt)))
    .returning();
  return closed;
}
