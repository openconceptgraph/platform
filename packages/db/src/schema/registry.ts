import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Every object a base publishes. The values are the names of the tables that
 * hold each kind, so the database can find any object from its ID alone.
 */
export const objectKind = pgEnum("object_kind", [
  // Transcription: the official text, word for word
  "framework",
  "education_level",
  "document",
  "node",
  "statement",
  "teaching_plan",
  "placement",
  // Interpretation: our reading of it, earned through review
  "family",
  "concept",
  "level",
  "misconception",
  "link",
  // Provenance
  "source",
]);
export type ObjectKind = (typeof objectKind.enumValues)[number];

/** Review status of an interpretation object or link (ADR-006). */
export const reviewStatus = pgEnum("review_status", ["proposed", "confirmed", "rejected"]);
export type ReviewStatus = (typeof reviewStatus.enumValues)[number];

/**
 * The ID registry. Every base object is registered here when it is created
 * (by a trigger, never by hand) and the row is never deleted, so an ID is
 * permanent, never reused, and resolvable at /id/<uuid> whatever its kind.
 * Retiring an object sets retired_at and adds a replaced-by link; the row stays.
 */
export const baseObject = pgTable(
  "base_object",
  {
    id: uuid("id").primaryKey(),
    kind: objectKind("kind").notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("base_object_id_kind_key").on(t.id, t.kind)],
);

/**
 * Columns every registered object carries. `revision` counts changes to the
 * object's content and is what a judgement records; a trigger maintains it.
 */
export function objectColumns() {
  return {
    id: uuid("id")
      .primaryKey()
      .defaultRandom()
      .references(() => baseObject.id),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  };
}

/**
 * Text we author, keyed by BCP 47 language tag: { "en": "Subtract integers" }.
 * The same shape as a JSON-LD language map. Official text is not stored this
 * way: a statement quotes one document, in that document's language.
 */
export type LangString = Record<string, string>;

export function langString(name: string) {
  return jsonb(name).$type<LangString>();
}

/** Check constraint: the column holds a well-formed, non-empty language map (or is null). */
export function langStringCheck(constraint: string, column: AnyPgColumn) {
  return check(constraint, sql`ocg_is_lang_string(${column})`);
}
