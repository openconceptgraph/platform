import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { profileOf } from "@/review/profile";
import { auth } from "./auth";
import { getDb } from "./db";
import { can } from "./permissions";

export async function currentUser() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

/**
 * The signed-in reviewer. Anyone else is sent to sign in, or told they are not
 * a reviewer; a reviewer without a public name is asked to choose one first.
 */
export async function requireReviewer() {
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }
  if (!can(user.role, { judgement: ["create"] })) {
    redirect("/not-a-reviewer");
  }
  const profile = await profileOf(getDb(), user.id);
  if (!profile) {
    redirect("/profile");
  }
  return { ...user, publicName: profile.publicName };
}
