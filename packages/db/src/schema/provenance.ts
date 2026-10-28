import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { objectColumns } from "./registry";
import { framework, statement } from "./transcription";

export const sourceKind = pgEnum("source_kind", [
  /** An official statement: the authority's own words, e.g. a prerequisite cell. */
  "statement",
  /** A citable publication: a research paper, a diagnostic report. */
  "publication",
  /** A named reviewer's judgement. */
  "reviewer",
  /** An AI drafting run, identified by model and prompt version. */
  "ai",
]);

/**
 * A citable origin. Every link and every misconception cites one; the base's
 * credibility is this table.
 */
export const source = pgTable(
  "source",
  {
    ...objectColumns(),
    frameworkId: uuid("framework_id")
      .notNull()
      .references(() => framework.id),
    kind: sourceKind("kind").notNull(),
    statementId: uuid("statement_id").references(() => statement.id),
    citation: text("citation"),
    url: text("url"),
    reviewerId: text("reviewer_id").references(() => user.id),
    model: text("model"),
    promptVersion: text("prompt_version"),
  },
  (t) => [
    index("source_framework_idx").on(t.frameworkId),
    check(
      "source_kind_fields",
      sql`(${t.kind} = 'statement' and ${t.statementId} is not null)
       or (${t.kind} = 'publication' and coalesce(${t.citation}, '') <> '')
       or (${t.kind} = 'reviewer' and ${t.reviewerId} is not null)
       or (${t.kind} = 'ai' and ${t.model} is not null and ${t.promptVersion} is not null)`,
    ),
  ],
);
