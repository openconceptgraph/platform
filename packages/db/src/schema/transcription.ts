import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { baseObject, langString, langStringCheck, objectColumns, objectKind } from "./registry";

// Transcription: what the curriculum authority published, copied word for word
// with its reference. Endorsement attaches to this layer, not to our reading of it.

/**
 * One curriculum for one subject, as a base releases it: "za-caps/mathematics".
 * Concepts are authored per framework (ADR-019). Each framework names its own
 * structure: the node types it uses, from the top down.
 */
export const framework = pgTable(
  "framework",
  {
    ...objectColumns(),
    slug: text("slug").notNull().unique(),
    title: langString("title").notNull(),
    /** ISO 3166-1 alpha-2 country, or ISO 3166-2 subdivision: "ZA", "US-CA". */
    jurisdiction: text("jurisdiction").notNull(),
    subject: text("subject").notNull(),
    publisher: text("publisher"),
    /** The framework's own vocabulary for its structure, e.g. {content-area, topic}. */
    nodeTypes: text("node_types").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    langStringCheck("framework_title_lang", t.title),
    check("framework_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'`),
  ],
);

/** A grade or year in the framework's own terms, beside its ISCED 2011 level (ADR-019). */
export const educationLevel = pgTable(
  "education_level",
  {
    ...objectColumns(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => framework.id),
    /** The local code: "R", "8", "Y10". */
    code: text("code").notNull(),
    title: langString("title").notNull(),
    iscedLevel: smallint("isced_level").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (t) => [
    unique("education_level_framework_code_key").on(t.frameworkId, t.code),
    langStringCheck("education_level_title_lang", t.title),
    check("education_level_isced_range", sql`${t.iscedLevel} between 0 and 8`),
  ],
);

/** One official publication: a curriculum statement, an annual teaching plan. Citation attaches here. */
export const document = pgTable(
  "document",
  {
    ...objectColumns(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => framework.id),
    /** The official title, in the document's own language. */
    title: text("title").notNull(),
    /** BCP 47 tag of the document's language. Its nodes and statements are in this language. */
    language: text("language").notNull(),
    publisher: text("publisher"),
    issued: date("issued"),
    versionLabel: text("version_label"),
    url: text("url"),
    rights: text("rights"),
  },
  (t) => [
    index("document_framework_idx").on(t.frameworkId),
    check("document_title_present", sql`${t.title} <> ''`),
  ],
);

/** A heading in a document's structure (content area, topic, ...), typed by the framework's vocabulary. Any depth. */
export const node = pgTable(
  "node",
  {
    ...objectColumns(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => node.id),
    nodeType: text("node_type").notNull(),
    /** The document's own numbering: "1.3". */
    humanCode: text("human_code"),
    title: text("title").notNull(),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (t) => [
    unique("node_id_document_key").on(t.id, t.documentId),
    unique("node_document_code_key").on(t.documentId, t.humanCode),
    index("node_parent_idx").on(t.parentId),
    check("node_title_present", sql`${t.title} <> ''`),
  ],
);

export const statementType = pgEnum("statement_type", [
  /** A leaf of the content: a "concepts and skills" bullet. */
  "content",
  /** Teaching guidance beside the content. */
  "clarification",
  /** The authority's own account of what changes from the grade before. */
  "progression",
  /** A worked example. */
  "exemplar",
  /** A stated prerequisite, e.g. an annual teaching plan's pre-knowledge cell. */
  "prerequisite",
]);

/**
 * Official text, word for word, with its page. The unit a concept is defined by
 * and coverage is measured against. Its language is its document's language.
 */
export const statement = pgTable(
  "statement",
  {
    ...objectColumns(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => document.id),
    nodeId: uuid("node_id"),
    /** Nested bullets point at the bullet they sit under. */
    parentId: uuid("parent_id").references((): AnyPgColumn => statement.id),
    educationLevelId: uuid("education_level_id").references(() => educationLevel.id),
    statementType: statementType("statement_type").notNull(),
    /** Opens with "Revise": it points back to earlier teaching and never creates a concept (ADR-003). */
    isRevision: boolean("is_revision").notNull().default(false),
    humanCode: text("human_code"),
    text: text("text").notNull(),
    page: integer("page"),
    /** Where on the page, when the page alone is ambiguous: "Grade 8 column". */
    locator: text("locator"),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (t) => [
    // A statement sits under a node of its own document.
    foreignKey({
      name: "statement_node_same_document_fk",
      columns: [t.nodeId, t.documentId],
      foreignColumns: [node.id, node.documentId],
    }),
    index("statement_document_idx").on(t.documentId),
    index("statement_node_idx").on(t.nodeId),
    check("statement_text_present", sql`${t.text} <> ''`),
    check("statement_page_positive", sql`${t.page} > 0`),
  ],
);

/**
 * A sequence for teaching a framework: CAPS 2011's terms and hours, an annual
 * teaching plan's weeks. Timing lives here, never in a concept (ADR-005).
 */
export const teachingPlan = pgTable(
  "teaching_plan",
  {
    ...objectColumns(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => framework.id),
    /** The publication the plan is transcribed from. */
    documentId: uuid("document_id").references(() => document.id),
    slug: text("slug").notNull(),
    title: langString("title").notNull(),
  },
  (t) => [
    unique("teaching_plan_framework_slug_key").on(t.frameworkId, t.slug),
    langStringCheck("teaching_plan_title_lang", t.title),
  ],
);

/** When a plan teaches a node, family or concept: grade, term, weeks, hours. */
export const placement = pgTable(
  "placement",
  {
    ...objectColumns(),
    teachingPlanId: uuid("teaching_plan_id")
      .notNull()
      .references(() => teachingPlan.id),
    targetId: uuid("target_id").notNull(),
    targetKind: objectKind("target_kind").notNull(),
    educationLevelId: uuid("education_level_id")
      .notNull()
      .references(() => educationLevel.id),
    term: smallint("term"),
    weekStart: smallint("week_start"),
    weekEnd: smallint("week_end"),
    hours: numeric("hours", { precision: 5, scale: 1 }),
    ordinal: integer("ordinal").notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: "placement_target_fk",
      columns: [t.targetId, t.targetKind],
      foreignColumns: [baseObject.id, baseObject.kind],
    }),
    index("placement_plan_idx").on(t.teachingPlanId),
    index("placement_target_idx").on(t.targetId),
    check("placement_target_kind", sql`${t.targetKind} in ('node', 'family', 'concept')`),
    check("placement_weeks_ordered", sql`${t.weekEnd} >= ${t.weekStart}`),
    check("placement_hours_positive", sql`${t.hours} > 0`),
  ],
);
