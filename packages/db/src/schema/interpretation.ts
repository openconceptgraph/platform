import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  real,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { source } from "./provenance";
import {
  baseObject,
  langString,
  langStringCheck,
  objectColumns,
  objectKind,
  reviewStatus,
} from "./registry";
import { framework } from "./transcription";

// Interpretation: our reading of the curriculum. Nothing here is official;
// trust is earned through qualified reviewers' judgements, and only confirmed
// objects and links reach a public release.

/** A planning-grain group of concepts: "Integers". Teachers plan by family. */
export const family = pgTable(
  "family",
  {
    ...objectColumns(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => framework.id),
    humanCode: text("human_code").notNull(),
    title: langString("title").notNull(),
    description: langString("description"),
    status: reviewStatus("status").notNull().default("proposed"),
  },
  (t) => [
    unique("family_framework_code_key").on(t.frameworkId, t.humanCode),
    langStringCheck("family_title_lang", t.title),
    langStringCheck("family_description_lang", t.description),
  ],
);

export const conceptKind = pgEnum("concept_kind", ["fact", "category", "procedure", "principle"]);

/**
 * The atomic teachable unit: taught in one go, checked with a few short
 * questions, with at least one typical way of going wrong (ADR-003).
 */
export const concept = pgTable(
  "concept",
  {
    ...objectColumns(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => framework.id),
    /** A label, not the identity: it may gain aliases but never changes meaning. */
    humanCode: text("human_code").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    /** The concept as an action on an object, with its conditions. */
    title: langString("title").notNull(),
    description: langString("description"),
    kind: conceptKind("kind"),
    /** One of the few concepts per grade a diagnosis turns on (ADR-002). */
    isGateway: boolean("is_gateway").notNull().default(false),
    status: reviewStatus("status").notNull().default("proposed"),
  },
  (t) => [
    unique("concept_framework_code_key").on(t.frameworkId, t.humanCode),
    langStringCheck("concept_title_lang", t.title),
    langStringCheck("concept_description_lang", t.description),
  ],
);

/** Ordered variants of one concept that differ only by a parameter, such as the number range (ADR-003). */
export const level = pgTable(
  "level",
  {
    ...objectColumns(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concept.id),
    ordinal: smallint("ordinal").notNull(),
    title: langString("title").notNull(),
    description: langString("description"),
    status: reviewStatus("status").notNull().default("proposed"),
  },
  (t) => [
    unique("level_concept_ordinal_key").on(t.conceptId, t.ordinal),
    langStringCheck("level_title_lang", t.title),
    langStringCheck("level_description_lang", t.description),
  ],
);

/** A typical wrong rule, written as a rule: "subtracting a negative subtracts". */
export const misconception = pgTable(
  "misconception",
  {
    ...objectColumns(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => framework.id),
    humanCode: text("human_code").notNull(),
    statement: langString("statement").notNull(),
    example: langString("example"),
    /** Null means unsourced, and the misconception is flagged as such. */
    sourceId: uuid("source_id").references(() => source.id),
    status: reviewStatus("status").notNull().default("proposed"),
  },
  (t) => [
    unique("misconception_framework_code_key").on(t.frameworkId, t.humanCode),
    langStringCheck("misconception_statement_lang", t.statement),
    langStringCheck("misconception_example_lang", t.example),
  ],
);

export const linkType = pgEnum("link_type", [
  /** Concept → concept: the first must be secure before the second can be learnt. Never loops. */
  "needs",
  /** Misconception → concept it blocks. */
  "hinders",
  /** Statement → concept it defines: the concept's word-for-word source. */
  "defines",
  /** Concept → its family. One live family per concept. */
  "part-of",
  /** A retired object → its replacement, of the same kind. */
  "replaced-by",
]);
export type LinkType = (typeof linkType.enumValues)[number];

/** A typed, directed link. Every link has a source and a status (ADR-006). */
export const link = pgTable(
  "link",
  {
    ...objectColumns(),
    linkType: linkType("link_type").notNull(),
    fromId: uuid("from_id").notNull(),
    fromKind: objectKind("from_kind").notNull(),
    toId: uuid("to_id").notNull(),
    toKind: objectKind("to_kind").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id),
    status: reviewStatus("status").notNull().default("proposed"),
    /** For AI proposals: the share of drafting runs that agreed, 0 to 1. */
    confidence: real("confidence"),
    rationale: text("rationale"),
  },
  (t) => [
    foreignKey({
      name: "link_from_fk",
      columns: [t.fromId, t.fromKind],
      foreignColumns: [baseObject.id, baseObject.kind],
    }),
    foreignKey({
      name: "link_to_fk",
      columns: [t.toId, t.toKind],
      foreignColumns: [baseObject.id, baseObject.kind],
    }),
    unique("link_type_from_to_key").on(t.linkType, t.fromId, t.toId),
    index("link_from_idx").on(t.fromId),
    index("link_to_idx").on(t.toId),
    uniqueIndex("link_one_family_per_concept")
      .on(t.fromId)
      .where(sql`${t.linkType} = 'part-of' and ${t.status} <> 'rejected'`),
    check("link_not_to_self", sql`${t.fromId} <> ${t.toId}`),
    check(
      "link_endpoint_kinds",
      sql`(${t.linkType} = 'needs' and ${t.fromKind} = 'concept' and ${t.toKind} = 'concept')
       or (${t.linkType} = 'hinders' and ${t.fromKind} = 'misconception' and ${t.toKind} = 'concept')
       or (${t.linkType} = 'defines' and ${t.fromKind} = 'statement' and ${t.toKind} = 'concept')
       or (${t.linkType} = 'part-of' and ${t.fromKind} = 'concept' and ${t.toKind} = 'family')
       or (${t.linkType} = 'replaced-by' and ${t.fromKind} = ${t.toKind})`,
    ),
    check("link_confidence_range", sql`${t.confidence} between 0 and 1`),
  ],
);
