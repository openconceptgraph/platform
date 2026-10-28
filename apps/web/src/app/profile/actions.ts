"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { saveProfile } from "@/review/profile";

export async function updateProfile(_state: { error?: string } | undefined, formData: FormData) {
  const user = await currentUser();
  if (!user) {
    redirect("/sign-in");
  }
  const result = await saveProfile(getDb(), user.id, {
    publicName: String(formData.get("publicName") ?? ""),
    publicNote: formData.get("publicNote")?.toString(),
  });
  if (!result.ok) {
    return { error: result.error };
  }
  redirect("/review");
}
