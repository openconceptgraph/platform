import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { baseObject, objectKind } from "./registry";

// Review: the judgement record is the product (ADR-017). It is append-only;
// a change of mind is a new record that supersedes the old one.

export const decision = pgEnum("decision", ["confirm", "reject", "needs-change"]);
export type Decision = (typeof decision.enumValues)[number];

/**
 * A set of objects put to one reviewer together, with planted controls among
 * them. Each batch suits one kind of reviewer: concept cards and prerequisite
 * links for a mathematical reviewer, typical mistakes for a classroom one.
 */
export const batch = pgTable("batch", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  /** The reviewer who judges it. Only they may record judgements in it. */
  assignedTo: text("assigned_to")
    .notNull()
    .references(() => user.id),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const batchItem = pgTable(
  "batch_item",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => batch.id),
    objectId: uuid("object_id").notNull(),
    objectKind: objectKind("object_kind").notNull(),
    /** Set for a planted control: the decision a careful reviewer reaches. */
    controlExpected: decision("control_expected"),
    controlNote: text("control_note"),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "batch_item_pkey", columns: [t.batchId, t.objectId] }),
    foreignKey({
      name: "batch_item_object_fk",
      columns: [t.objectId, t.objectKind],
      foreignColumns: [baseObject.id, baseObject.kind],
    }),
  ],
);

/**
 * One reviewer's decision on one revision of one object, with the evidence
 * they saw. The database fills in the time and the control flag, refuses a
 * stale revision, and refuses any update or delete.
 */
export const judgement = pgTable(
  "judgement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectId: uuid("object_id").notNull(),
    objectKind: objectKind("object_kind").notNull(),
    objectRevision: integer("object_revision").notNull(),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => user.id),
    decision: decision("decision").notNull(),
    /** Required to confirm: why it is right, from a fixed list. */
    reasonCode: text("reason_code"),
    /** Required to reject or ask for a change: what is wrong, in the reviewer's words. */
    reason: text("reason"),
    /** What the reviewer was shown: the object, its sources, its neighbours. */
    evidence: jsonb("evidence").notNull(),
    batchId: uuid("batch_id").references(() => batch.id),
    isControl: boolean("is_control").notNull().default(false),
    timeSpentMs: integer("time_spent_ms"),
    /** The same reviewer's earlier judgement on the same object, now replaced. Needs a reason. */
    supersedesId: uuid("supersedes_id"),
    /**
     * Set when this judgement was made on another object's screen: confirming a
     * concept card also judges the curriculum lines it cites and its family.
     */
    coveredById: uuid("covered_by_id").references((): AnyPgColumn => judgement.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "judgement_object_fk",
      columns: [t.objectId, t.objectKind],
      foreignColumns: [baseObject.id, baseObject.kind],
    }),
    unique("judgement_id_object_reviewer_key").on(t.id, t.objectId, t.reviewerId),
    foreignKey({
      name: "judgement_supersedes_fk",
      columns: [t.supersedesId, t.objectId, t.reviewerId],
      foreignColumns: [t.id, t.objectId, t.reviewerId],
    }),
    unique("judgement_supersedes_once_key").on(t.supersedesId),
    index("judgement_object_idx").on(t.objectId),
    index("judgement_reviewer_idx").on(t.reviewerId),
    index("judgement_batch_idx").on(t.batchId),
    check(
      "judgement_reason_given",
      sql`(${t.decision} = 'confirm' and coalesce(${t.reasonCode}, '') <> '')
       or (${t.decision} <> 'confirm' and coalesce(trim(${t.reason}), '') <> '')`,
    ),
    check("judgement_time_spent_nonnegative", sql`${t.timeSpentMs} >= 0`),
    check(
      "judgement_change_of_mind_explained",
      sql`${t.supersedesId} is null or coalesce(trim(${t.reason}), '') <> ''`,
    ),
    check("judgement_covered_outside_batch", sql`${t.coveredById} is null or ${t.batchId} is null`),
    index("judgement_covered_by_idx").on(t.coveredById),
  ],
);
