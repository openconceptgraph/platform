import type { BaseGraph, ConceptNode, GraphEdge, GraphNode } from "./data";

// Lookups over a graph document, for the cards, the table and the family
// spotlight: what a concept needs and is needed for, the lines that define it,
// the mistakes that hinder it, and which families each node touches.

export interface Related<T extends GraphNode = GraphNode> {
  node: T;
  edge: GraphEdge;
}

export class Relations {
  readonly byId: Map<string, GraphNode>;
  private readonly into = new Map<string, GraphEdge[]>();
  private readonly outOf = new Map<string, GraphEdge[]>();
  private readonly familiesOf = new Map<string, Set<string>>();

  constructor(graph: Pick<BaseGraph, "nodes" | "edges">) {
    this.byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      push(this.into, e.target, e);
      push(this.outOf, e.source, e);
    }
    // A concept's family; a line's, a mistake's or a heading's are those of the concepts it leads to.
    const visit = (id: string): Set<string> => {
      const known = this.familiesOf.get(id);
      if (known) return known;
      const found = new Set<string>();
      this.familiesOf.set(id, found);
      const node = this.byId.get(id);
      if (node?.kind === "concept") {
        if (node.family) found.add(node.family);
        return found;
      }
      const leadsTo =
        node?.kind === "topic"
          ? this.edgesInto(id, "under").map((e) => e.source)
          : this.edgesOutOf(id).filter((e) => e.type !== "under").map((e) => e.target);
      for (const next of leadsTo) for (const f of visit(next)) found.add(f);
      return found;
    };
    for (const n of graph.nodes) visit(n.id);
  }

  edgesInto(id: string, type?: GraphEdge["type"]) {
    return (this.into.get(id) ?? []).filter((e) => !type || e.type === type);
  }

  edgesOutOf(id: string, type?: GraphEdge["type"]) {
    return (this.outOf.get(id) ?? []).filter((e) => !type || e.type === type);
  }

  /** The concepts this one needs. */
  prerequisites(id: string) {
    return this.related<ConceptNode>(this.edgesInto(id, "needs"), "source");
  }

  /** The concepts that need this one. */
  neededFor(id: string) {
    return this.related<ConceptNode>(this.edgesOutOf(id, "needs"), "target");
  }

  /** The curriculum lines that define a concept. */
  lines(id: string) {
    return this.related(this.edgesInto(id, "defines"), "source");
  }

  /** The typical mistakes that hinder a concept. */
  mistakes(id: string) {
    return this.related(this.edgesInto(id, "hinders"), "source");
  }

  /** The concepts a line defines, or a mistake hinders. */
  concepts(id: string) {
    return this.related<ConceptNode>(
      this.edgesOutOf(id).filter((e) => e.type === "defines" || e.type === "hinders"),
      "target",
    );
  }

  /** The lines and headings directly under a heading. */
  children(id: string) {
    return this.related(this.edgesInto(id, "under"), "source");
  }

  families(id: string): string[] {
    return [...(this.familiesOf.get(id) ?? [])];
  }

  /** An edge belongs to the families of the concepts it touches, or of the line that hangs by it. */
  edgeFamilies(edge: GraphEdge): string[] {
    const ends =
      edge.type === "needs" ? [edge.source, edge.target] : edge.type === "under" ? [edge.source] : [edge.target];
    return [...new Set(ends.flatMap((id) => this.families(id)))];
  }

  /** A node, its neighbours, and the edges between them: what lights up when it is in focus. */
  neighbourhood(id: string) {
    const edges = [...this.edgesInto(id), ...this.edgesOutOf(id)];
    return { nodes: [id, ...edges.map((e) => (e.source === id ? e.target : e.source))], edges: edges.map((e) => e.id) };
  }

  private related<T extends GraphNode = GraphNode>(edges: GraphEdge[], end: "source" | "target"): Related<T>[] {
    return edges.flatMap((edge) => {
      const node = this.byId.get(edge[end]);
      return node ? [{ node: node as T, edge }] : [];
    });
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
