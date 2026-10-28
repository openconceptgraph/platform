import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * How a person appears to anyone else. The account keeps their real name, so
 * every judgement stays attributable inside the workbench; anything others
 * see (other reviewers, releases, the explorer) shows only the public name
 * they chose: their own name if they are happy for it to be public, or one
 * that does not identify them.
 */
export const reviewerProfile = pgTable(
  "reviewer_profile",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    publicName: text("public_name").notNull(),
    /** An optional public line about them: "Retired physicist, PhD". */
    publicNote: text("public_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Unique regardless of case, so two reviewers can never be confused.
    uniqueIndex("reviewer_profile_public_name_key").on(sql`lower(${t.publicName})`),
    check("reviewer_profile_public_name_length", sql`char_length(btrim(${t.publicName})) between 2 and 60`),
    check("reviewer_profile_public_note_length", sql`char_length(${t.publicNote}) <= 120`),
  ],
);
