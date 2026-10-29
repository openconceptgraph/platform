import { notFound } from "next/navigation";
import { AppHeader, Progress } from "@/components/AppHeader";
import { EvidenceView } from "@/components/EvidenceView";
import { getDb } from "@/lib/db";
import { requireReviewer } from "@/lib/session";
import { batchFor, itemsOf, nextUndecided } from "@/review/batches";
import { buildEvidence, screenFor } from "@/review/evidence";
import { reasonLabel, reasonOptions } from "@/review/reasons";
import { liveJudgement } from "@/review/record";
import { present } from "@/review/token";
import { DecisionPanel, type Earlier } from "./DecisionPanel";

const covers = {
  prerequisite: undefined,
  card: "Your decision also covers the curriculum lines it cites and its family.",
  mistake: "Your decision also covers the concepts it gets in the way of.",
};

const when = new Intl.DateTimeFormat("en-ZA", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Africa/Johannesburg",
});

export default async function ReviewItemPage({ params }: { params: Promise<{ batchId: string; objectId: string }> }) {
  const { batchId, objectId } = await params;
  const user = await requireReviewer();
  const db = getDb();

  const batch = await batchFor(db, batchId, user.id);
  if (!batch) notFound();
  const items = await itemsOf(db, batchId, user.id);
  const item = items.find((i) => i.objectId === objectId);
  if (!item || !screenFor(item.objectKind, item.linkType)) notFound();

  const confirming = batch.stage === "confirmation";
  const evidence = await buildEvidence(db, item, confirming ? { confirming: user.id } : {});
  const token = present(batchId, user.id, evidence);

  const live = await liveJudgement(db, user.id, objectId);
  const earlier: Earlier | undefined = live && {
    decision: live.decision,
    reasonLabel: reasonLabel(evidence.type, live.reasonCode),
    reason: live.reason ?? undefined,
    at: when.format(live.createdAt),
  };

  const next = nextUndecided(items, objectId);
  const done = items.filter((i) => i.decided).length;

  return (
    <>
      <AppHeader name={user.name}>
        <Progress title={batch.title} done={done} total={items.length} />
      </AppHeader>
      <main className="page review">
        <EvidenceView evidence={evidence} position={item.position} total={items.length} />
        <aside>
          <DecisionPanel
            key={`${objectId}:${live?.id ?? "new"}`}
            token={token}
            options={reasonOptions(evidence.type, { confirming: Boolean(evidence.review) })}
            earlier={earlier}
            confirming={confirming}
            review={evidence.review}
            covers={covers[evidence.type]}
            nextHref={next ? `/review/${batchId}/${next.objectId}` : `/review/${batchId}/done`}
          />
        </aside>
      </main>
    </>
  );
}
