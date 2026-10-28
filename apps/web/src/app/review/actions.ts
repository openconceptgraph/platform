"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { can } from "@/lib/permissions";
import { currentUser } from "@/lib/session";
import { itemsOf, nextUndecided } from "@/review/batches";
import { recordDecision } from "@/review/record";

export async function decide(token: string, _state: { error?: string } | undefined, formData: FormData) {
  const user = await currentUser();
  if (!user || !can(user.role, { judgement: ["create"] })) {
    return { error: "Please sign in again as a reviewer." };
  }
  const db = getDb();
  const result = await recordDecision(db, {
    token,
    reviewerId: user.id,
    input: {
      decision: String(formData.get("decision") ?? ""),
      reasonCode: formData.get("reasonCode")?.toString(),
      reason: formData.get("reason")?.toString(),
    },
  });
  if (!result.ok) {
    return { error: result.error };
  }
  const next = nextUndecided(await itemsOf(db, result.batchId, user.id), result.objectId);
  redirect(next ? `/review/${result.batchId}/${next.objectId}` : `/review/${result.batchId}/done`);
}
