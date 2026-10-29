import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { getDb } from "@/lib/db";
import { requireReviewer } from "@/lib/session";
import { batchesFor } from "@/review/batches";

export default async function BatchesPage() {
  const user = await requireReviewer();
  const batches = await batchesFor(getDb(), user.id);
  const open = batches.filter((b) => !b.closedAt);
  const closed = batches.filter((b) => b.closedAt);

  return (
    <>
      <AppHeader name={user.name} role={user.role} />
      <main className="narrow">
        <h1>Your batches</h1>
        {open.length === 0 && <p className="empty panel">Nothing to review at the moment.</p>}
        <ul className="batches">
          {open.map((b) => (
            <li key={b.id} className="panel">
              <div>
                <b>{b.title}</b>
                <div className="meta">
                  {b.stage === "confirmation" ? "Confirmation review · " : ""}
                  {b.done} of {b.total} done
                </div>
              </div>
              {b.next ? (
                <Link className="primary" href={`/review/${b.id}/${b.next.objectId}`}>
                  {b.done === 0 ? "Start" : "Continue"}
                </Link>
              ) : (
                <Link className="meta" href={`/review/${b.id}/done`}>
                  Finished
                </Link>
              )}
              <div className="bar">
                <i style={{ width: `${b.total ? (100 * b.done) / b.total : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
        {closed.length > 0 && (
          <>
            <h2>Closed</h2>
            <ul className="batches">
              {closed.map((b) => (
                <li key={b.id} className="panel">
                  <b>{b.title}</b>
                  <span className="meta">
                    {b.done} of {b.total} decided
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
