import { type Db, schema } from "@ocg/db";
import { eq, sql } from "drizzle-orm";

const { reviewerProfile } = schema;

export async function profileOf(db: Db, userId: string) {
  const [row] = await db.select().from(reviewerProfile).where(eq(reviewerProfile.userId, userId));
  return row;
}

/** The name others see for a person: their public name, never their account name. */
export async function publicNameOf(db: Db, userId: string) {
  return (await profileOf(db, userId))?.publicName ?? "a reviewer";
}

export type SaveResult = { ok: true } | { ok: false; error: string };

export async function saveProfile(
  db: Db,
  userId: string,
  input: { publicName: string; publicNote?: string },
): Promise<SaveResult> {
  const publicName = input.publicName.trim().replace(/\s+/g, " ");
  const publicNote = input.publicNote?.trim().replace(/\s+/g, " ") || null;
  if (publicName.length < 2 || publicName.length > 60) {
    return { ok: false, error: "Choose a public name of 2 to 60 characters." };
  }
  if (publicName.includes("@")) {
    return { ok: false, error: "Please do not use an email address as your public name." };
  }
  if (publicNote && publicNote.length > 120) {
    return { ok: false, error: "Keep the line about you to 120 characters." };
  }
  try {
    await db
      .insert(reviewerProfile)
      .values({ userId, publicName, publicNote })
      .onConflictDoUpdate({
        target: reviewerProfile.userId,
        set: { publicName, publicNote, updatedAt: sql`now()` },
      });
    return { ok: true };
  } catch (error) {
    if (/reviewer_profile_public_name_key/.test(String((error as { cause?: unknown }).cause ?? error))) {
      return { ok: false, error: "Another reviewer already uses that public name. Please choose another." };
    }
    throw error;
  }
}
