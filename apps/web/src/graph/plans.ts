import type { BaseGraph, ConceptNode, Placed, TeachingPlan } from "./data";

// Teaching plans on the map: when a plan teaches something, and what changes
// from one plan to another (ADR-005: timing lives in placements, never in a
// concept).

/** A plan's short name, for controls and column heads: its title up to the first colon. */
export function planName(plan: TeachingPlan): string {
  return plan.title.split(":")[0]!.trim();
}

/** "Term 2, weeks 1–2", or "T2 wk 1–2" when short. */
export function whenText(placed: Placed | undefined, { short = false } = {}): string {
  if (!placed) return "not placed";
  const term = placed.term ? (short ? `T${placed.term}` : `Term ${placed.term}`) : "";
  let weeks = "";
  if (placed.weekStart) {
    const range = placed.weekEnd && placed.weekEnd !== placed.weekStart;
    weeks = `${short ? "wk" : range ? "weeks" : "week"} ${placed.weekStart}${range ? `–${placed.weekEnd}` : ""}`;
  }
  return [term, weeks].filter(Boolean).join(short ? " " : ", ") || "no term given";
}

export interface TermChange {
  /** What the earlier plan places: "1.2 Exponents". */
  of: string;
  fromTerm: number;
  toTerm: number;
  concepts: ConceptNode[];
}

/**
 * The concepts both plans place, in different terms, grouped by what the
 * earlier plan placed and where they move: "1.2 Exponents, Term 1 → Term 2".
 */
export function termChanges(graph: Pick<BaseGraph, "nodes">, from: string, to: string): TermChange[] {
  const groups = new Map<string, TermChange>();
  for (const node of graph.nodes) {
    if (node.kind !== "concept") continue;
    const [a, b] = [node.when[from], node.when[to]];
    if (!a?.term || !b?.term || a.term === b.term) continue;
    const key = `${a.of}|${a.term}|${b.term}`;
    const group = groups.get(key) ?? { of: a.of, fromTerm: a.term, toTerm: b.term, concepts: [] };
    group.concepts.push(node);
    groups.set(key, group);
  }
  return [...groups.values()];
}
