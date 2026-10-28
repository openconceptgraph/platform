"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export async function signIn(_state: { error?: string } | undefined, formData: FormData) {
  try {
    await auth.api.signInEmail({
      body: { email: String(formData.get("email") ?? ""), password: String(formData.get("password") ?? "") },
      headers: await headers(),
    });
  } catch {
    return { error: "That email and password do not match an account." };
  }
  redirect("/review");
}

export async function signOut() {
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}
