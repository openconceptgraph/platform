import Link from "next/link";
import { notFound } from "next/navigation";
import { AppHeader, Progress } from "@/components/AppHeader";
import { getDb } from "@/lib/db";
import { requireReviewer } from "@/lib/session";
import { batchFor, itemsOf } from "@/review/batches";

export default async function BatchDonePage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const user = await requireReviewer();
  const db = getDb();
  const batch = await batchFor(db, batchId, user.id);
  if (!batch) notFound();
  const items = await itemsOf(db, batchId, user.id);
  const done = items.filter((i) => i.decided).length;
  const left = items.find((i) => !i.decided);

  return (
    <>
      <AppHeader name={user.name} role={user.role}>
        <Progress title={batch.title} done={done} total={items.length} />
      </AppHeader>
      <main className="narrow">
        <div className="panel">
          {left ? (
            <>
              <h1>Some items are still waiting</h1>
              <p>You skipped {items.length - done} of {items.length}. They are kept for you.</p>
              <Link className="primary" href={`/review/${batchId}/${left.objectId}`}>
                Go to the next one
              </Link>
            </>
          ) : (
            <>
              <h1>Batch complete. Thank you.</h1>
              <p>
                {done} decisions are recorded under your name. You can still open any item and change your decision
                until the batch is closed.
              </p>
              <Link className="primary" href="/review">
                Back to your batches
              </Link>
            </>
          )}
        </div>
      </main>
    </>
  );
}
