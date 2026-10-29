import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { BaseGraph } from "./data";

// Where each node sits on the map. Worked out on the server with ForceAtlas2
// from fixed starting points, so the same data always gives the same picture
// whoever looks at it, and toggling a layer moves nothing: hidden nodes keep
// their places. (A release will store its layout, so a picture shown once can
// be shown again.)

export type Positions = Record<string, { x: number; y: number }>;

/** How strongly each kind of edge pulls its ends together. Prerequisites hold the map's shape. */
const pull: Record<BaseGraph["edges"][number]["type"], number> = { needs: 3, defines: 1, hinders: 1, under: 1 };

export function layOut(graph: Pick<BaseGraph, "nodes" | "edges">, iterations = 500): Positions {
  const g = new Graph({ type: "undirected" });
  // Start on a sunflower spiral in the document's order: curriculum, then concepts, then mistakes.
  const golden = Math.PI * (3 - Math.sqrt(5));
  graph.nodes.forEach((node, i) => {
    const r = 10 * Math.sqrt(i + 1);
    g.addNode(node.id, { x: r * Math.cos(i * golden), y: r * Math.sin(i * golden) });
  });
  for (const e of graph.edges) {
    g.mergeEdge(e.source, e.target, { weight: pull[e.type] });
  }
  forceAtlas2.assign(g, {
    iterations,
    getEdgeWeight: "weight",
    settings: { ...forceAtlas2.inferSettings(g), scalingRatio: 6, gravity: 0.4, barnesHutOptimize: g.order > 400 },
  });

  const positions: Positions = {};
  g.forEachNode((id, a) => {
    positions[id] = { x: Math.round(a.x * 100) / 100, y: Math.round(a.y * 100) / 100 };
  });
  return positions;
}
