import type { Metadata } from "next";
import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { buildGraph, frameworksWithConcepts } from "@/graph/data";
import { layOut } from "@/graph/layout";
import { getDb } from "@/lib/db";
import { requireGraphViewer } from "@/lib/session";
import { GraphExplorer } from "./GraphExplorer";

export const metadata: Metadata = { title: "Graph · OpenConceptGraph" };

export default async function GraphPage({ searchParams }: { searchParams: Promise<{ framework?: string }> }) {
  const user = await requireGraphViewer();
  const db = getDb();
  const frameworks = await frameworksWithConcepts(db);
  const { framework: slug } = await searchParams;
  const chosen = frameworks.find((f) => f.slug === slug) ?? frameworks[0];

  if (!chosen) {
    return (
      <>
        <AppHeader name={user.name} role={user.role} />
        <main className="narrow">
          <p className="empty panel">There is no base to show yet.</p>
        </main>
      </>
    );
  }

  const graph = await buildGraph(db, chosen.id, { seesProgress: user.seesProgress });
  const positions = layOut(graph);
  const others = frameworks.filter((f) => f.id !== chosen.id);

  const heading = (
    <div className="graph-heading">
      <h1>{graph.framework.title}</h1>
      {others.length > 0 && (
        <span className="meta">
          Also:{" "}
          {others.map((f, i) => (
            <span key={f.id}>
              {i > 0 && " · "}
              <Link href={`/graph?framework=${encodeURIComponent(f.slug)}`}>{f.title}</Link>
            </span>
          ))}
        </span>
      )}
    </div>
  );

  return (
    <>
      <AppHeader name={user.name} role={user.role} />
      <main className="graph-page">
        <GraphExplorer key={graph.framework.id} graph={graph} positions={positions} heading={heading} />
      </main>
    </>
  );
}
