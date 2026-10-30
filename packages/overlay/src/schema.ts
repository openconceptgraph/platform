import { type AnyPgColumn, check, date, doublePrecision, index, integer, jsonb, numeric, pgSchema, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// A client's overlay, in the client's own workspace database (ADR-034): its
// profile and the base release it is pinned to, its kinds of artefact, its
// artefacts and their alignments into the base, and its own plans. One client
// per database, so nothing here is scoped by client. The base itself is not
// here: it is read from the pinned release bundle. The tables live in their
// own Postgres schema, "overlay".

export const overlay = pgSchema("overlay");

/** The specification's alignment types (spec 0.1.1, docs/overlay.md). */
export const alignmentTypes = ["teaches", "assumes", "tests", "reveals", "backfills", "covers", "explains"] as const;
export const alignmentType = overlay.enum("alignment_type", alignmentTypes);
export type AlignmentType = (typeof alignmentTypes)[number];

/** The kinds of base object an alignment may point at. */
export const targetKind = overlay.enum("target_kind", ["concept", "level", "misconception", "statement", "node"]);
export const status = overlay.enum("status", ["proposed", "confirmed", "rejected"]);
/** Where an alignment comes from: an AI run, a person, or an import from the client's own systems. */
export const sourceKind = overlay.enum("source_kind", ["ai", "person", "import"]);

export type LangString = Record<string, string>;
const langString = (name: string) => jsonb(name).$type<LangString>();
const langStringCheck = (name: string, column: AnyPgColumn) => check(name, sql`overlay.is_lang_string(${column})`);

const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The workspace's one client, and the base release its overlay is pinned to. Re-pinning is an explicit act. */
export const profile = overlay.table(
  "profile",
  {
    /** Always 1: a workspace holds one client's overlay. */
    id: smallint("id").primaryKey().default(1),
    namespace: text("namespace").notNull().unique(),
    name: text("name").notNull(),
    /** The overlay's own version, if the client keeps one. */
    version: text("version"),
    baseSlug: text("base_slug").notNull(),
    baseFramework: uuid("base_framework").notNull(),
    baseVersion: text("base_version").notNull(),
    /** The pinned release's manifest.json, by SHA-256, when the pin names the exact bundle. */
    baseManifestSha256: text("base_manifest_sha256"),
    ...timestamps(),
  },
  (t) => [
    check("profile_one_client", sql`${t.id} = 1`),
    check("profile_namespace_format", sql`${t.namespace} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("profile_manifest_sha256", sql`${t.baseManifestSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** A kind of artefact the client has, defined at onboarding, and the alignment types it may carry. */
export const artefactKind = overlay.table(
  "artefact_kind",
  {
    kind: text("kind").primaryKey(),
    label: langString("label").notNull(),
    description: langString("description"),
    alignments: alignmentType("alignments").array().notNull(),
    /** The nearest schema.org/LRMI learningResourceType: "lesson plan", "video". */
    learningResourceType: text("learning_resource_type"),
    /** Its place in the profile's list. */
    ordinal: integer("ordinal").notNull(),
  },
  (t) => [
    check("artefact_kind_format", sql`${t.kind} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("artefact_kind_alignments", sql`cardinality(${t.alignments}) > 0`),
    langStringCheck("artefact_kind_label_lang", t.label),
    langStringCheck("artefact_kind_description_lang", t.description),
  ],
);

/** One of the client's artefacts. It identifies the artefact; the content stays wherever the client keeps it. */
export const artefact = overlay.table(
  "artefact",
  {
    id: uuid("id").primaryKey(),
    namespace: text("namespace")
      .notNull()
      .references(() => profile.namespace),
    kind: text("kind")
      .notNull()
      .references(() => artefactKind.kind),
    /** The client's own code: "EL-G8-L03". */
    code: text("code"),
    title: langString("title").notNull(),
    /** BCP 47. */
    language: text("language").notNull(),
    /** The artefact this one sits inside: a question inside a lesson's exit ticket. */
    parentId: uuid("parent_id").references((): AnyPgColumn => artefact.id),
    ordinal: integer("ordinal"),
    url: text("url"),
    /** The client's own reference, opaque here: a path, a content ID. */
    ref: text("ref"),
    ...timestamps(),
  },
  (t) => [
    langStringCheck("artefact_title_lang", t.title),
    check("artefact_not_its_own_parent", sql`${t.parentId} IS DISTINCT FROM ${t.id}`),
    index("artefact_parent_idx").on(t.parentId),
  ],
);

/** A typed link from an artefact, or a part of it, into the pinned base release, with its source and the client's own status. */
export const alignment = overlay.table(
  "alignment",
  {
    id: uuid("id").primaryKey(),
    artefactId: uuid("artefact_id")
      .notNull()
      .references(() => artefact.id),
    /** Where in the artefact, when it is not the whole: "option B", "slide 4". */
    part: text("part"),
    alignmentType: alignmentType("alignment_type").notNull(),
    /** A base object's UUID, in the pinned release. */
    targetId: uuid("target_id").notNull(),
    targetKind: targetKind("target_kind").notNull(),
    sourceKind: sourceKind("source_kind").notNull(),
    sourceModel: text("source_model"),
    sourcePromptVersion: text("source_prompt_version"),
    /** For a person: the name they work under in the client's workspace. */
    sourceBy: text("source_by"),
    sourceDate: date("source_date"),
    status: status("status").notNull().default("proposed"),
    confidence: doublePrecision("confidence"),
    rationale: langString("rationale"),
    ...timestamps(),
  },
  (t) => [
    // Each type points at the kinds it may (ALIGNMENT_TARGETS in the specification's validator).
    check(
      "alignment_target_kind",
      sql`CASE ${t.alignmentType}
            WHEN 'reveals' THEN ${t.targetKind} = 'misconception'
            WHEN 'covers' THEN ${t.targetKind} IN ('statement', 'node')
            ELSE ${t.targetKind} IN ('concept', 'level')
          END`,
    ),
    check("alignment_ai_source", sql`${t.sourceKind} <> 'ai' OR (${t.sourceModel} IS NOT NULL AND ${t.sourcePromptVersion} IS NOT NULL)`),
    check("alignment_person_source", sql`${t.sourceKind} <> 'person' OR ${t.sourceBy} IS NOT NULL`),
    check("alignment_confidence", sql`${t.confidence} BETWEEN 0 AND 1`),
    langStringCheck("alignment_rationale_lang", t.rationale),
    index("alignment_artefact_idx").on(t.artefactId),
    index("alignment_target_idx").on(t.targetId),
  ],
);

/** The client's own teaching sequence. */
export const plan = overlay.table(
  "plan",
  {
    id: uuid("id").primaryKey(),
    namespace: text("namespace")
      .notNull()
      .references(() => profile.namespace),
    slug: text("slug").notNull(),
    title: langString("title").notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("plan_slug_key").on(t.slug),
    check("plan_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'`),
    langStringCheck("plan_title_lang", t.title),
  ],
);

/** When the client's plan teaches one of its artefacts, in one of the base's education levels. */
export const placement = overlay.table(
  "placement",
  {
    id: uuid("id").primaryKey(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id),
    artefactId: uuid("artefact_id")
      .notNull()
      .references(() => artefact.id),
    /** An education level of the pinned base. */
    educationLevelId: uuid("education_level_id").notNull(),
    term: smallint("term"),
    weekStart: smallint("week_start"),
    weekEnd: smallint("week_end"),
    hours: numeric("hours", { precision: 5, scale: 1 }),
    ordinal: integer("ordinal").notNull(),
    ...timestamps(),
  },
  (t) => [
    check("placement_term", sql`${t.term} >= 1`),
    check("placement_weeks", sql`${t.weekStart} >= 1 AND ${t.weekEnd} >= 1 AND ${t.weekEnd} >= ${t.weekStart}`),
    check("placement_hours", sql`${t.hours} > 0`),
    index("placement_plan_idx").on(t.planId),
    index("placement_artefact_idx").on(t.artefactId),
  ],
);
