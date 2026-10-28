import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { requireReviewer } from "@/lib/session";
import { batchFor, itemsOf, nextUndecided } from "@/review/batches";

/** A batch opens at the first item still to decide. */
export default async function BatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const user = await requireReviewer();
  const db = getDb();
  if (!(await batchFor(db, batchId, user.id))) notFound();
  const next = nextUndecided(await itemsOf(db, batchId, user.id));
  redirect(next ? `/review/${batchId}/${next.objectId}` : `/review/${batchId}/done`);
}
