import type { BaseGraph, GraphEdge, GraphNode, GraphStatus } from "./data";

// How the map draws each node and edge. Colour says which family a concept
// belongs to; fill says how far it is through review: hollow when proposed,
// a wash once one reviewer has confirmed it, solid when two have. Red is the
// teacher's pen, kept for mistakes. Edges: a confirmed prerequisite is solid
// ink, anything less is dashed.

export const ink = "#14213d";
export const ink2 = "#46557a";
export const feint = "#c8d5ea";
export const paper = "#fbfcfe";
export const red = "#d62839";

/**
 * Family colours, given in curriculum order and never cycled: the first seven
 * slots of the house data-viz palette, its red left out for mistakes. They
 * tell clusters apart at a glance; the code beside each node, the legend and
 * the family spotlight carry identity, since seven hues cannot all be told
 * apart side by side. Families beyond the seventh are grey.
 */
export const familyPalette = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"];
export const otherFamily = "#8a9bbd";

export function familyColours(families: BaseGraph["families"]): Record<string, string> {
  return Object.fromEntries(families.map((f, i) => [f.code, familyPalette[i] ?? otherFamily]));
}

/** `a` mixed with `b`: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2]
    .map((i) => Math.round(channel(a, i) * (1 - t) + channel(b, i) * t).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * What sigma needs to draw a node. Sizes are screen pixels. Every node has an
 * outer band of fixed width (sigma's border layer switches itself off when its
 * first band is sized by an attribute and that size is 0), drawn in ink for a
 * gateway and in the node's own colour otherwise; then a band of `borderSize`
 * (a fraction of the radius) in `borderColor`; then the fill, `color`.
 */
export interface NodeLook {
  label: string;
  shape: "circle" | "square" | "diamond";
  size: number;
  color: string;
  ringColor: string;
  borderColor: string;
  borderSize: number;
}

/** The outer band's width, as a fraction of the radius. */
export const RING = 0.15;

function filled(colour: string, status: GraphStatus) {
  if (status === "confirmed") return { color: colour, borderColor: colour, borderSize: 0 };
  return { color: status === "reviewed" ? mix(colour, paper, 0.55) : paper, borderColor: colour, borderSize: RING };
}

/** `dependents`: how many concepts need this one, which sets its size. */
export function nodeLook(node: GraphNode, colours: Record<string, string>, dependents = 0): NodeLook {
  switch (node.kind) {
    case "topic":
      return {
        label: `${node.code} ${node.title}`.trim(),
        shape: "square",
        size: node.nodeType === "topic" ? 8 : 10,
        color: ink,
        ringColor: ink,
        borderColor: ink,
        borderSize: 0,
      };
    case "statement":
      // A "Revise" line points back to earlier teaching and defines nothing here (ADR-003).
      return {
        label: "",
        shape: "square",
        size: 3.5,
        ringColor: ink2,
        ...(node.isRevision ? { color: paper, borderColor: ink2, borderSize: RING } : { color: ink2, borderColor: ink2, borderSize: 0 }),
      };
    case "concept": {
      const colour = (node.family && colours[node.family]) || otherFamily;
      return {
        label: node.code,
        shape: "circle",
        size: 6 + 2.4 * Math.sqrt(dependents),
        ...filled(colour, node.status),
        // A gateway's ink band takes the outside, so its own colour gets a wider band inside it.
        ...(node.isGateway && node.status !== "confirmed" && { borderSize: 2 * RING }),
        ringColor: node.isGateway ? ink : colour,
      };
    }
    case "mistake":
      return { label: node.code, shape: "diamond", size: 5, ...filled(red, node.status), ringColor: red };
  }
}

/** What sigma needs to draw an edge. A gap of 0 draws a solid line. */
export interface EdgeLook {
  size: number;
  color: string;
  dashSize: number;
  gapSize: number;
  /** Prerequisites only: an arrowhead at the concept that needs it. */
  head?: "arrow";
}

function dashes(status: GraphStatus | undefined) {
  if (status === "confirmed") return { dashSize: 1, gapSize: 0 };
  return status === "reviewed" ? { dashSize: 9, gapSize: 3 } : { dashSize: 4, gapSize: 4 };
}

export function edgeLook(edge: GraphEdge): EdgeLook {
  switch (edge.type) {
    case "needs":
      return {
        size: edge.status === "confirmed" ? 2.4 : 1.8,
        color: edge.status === "confirmed" ? ink : ink2,
        ...dashes(edge.status),
        head: "arrow",
      };
    case "hinders":
      return { size: 1.2, color: mix(red, paper, 0.35), ...dashes(edge.status) };
    case "defines":
      return { size: 1, color: feint, dashSize: 1, gapSize: 0 };
    case "under":
      return { size: 0.8, color: feint, dashSize: 1, gapSize: 0 };
  }
}
