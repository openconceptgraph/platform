"use client";

import type { AbstractGraph, Attributes } from "graphology-types";
import type Sigma from "sigma";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BaseGraph,
  ConceptNode,
  GraphNode,
  GraphStatus,
  MistakeNode,
  Placed,
  StatementNode,
  Tally,
  TeachingPlan,
  TopicNode,
} from "@/graph/data";
import type { Positions } from "@/graph/layout";
import { planName, termChanges, whenText } from "@/graph/plans";
import { type Related, Relations } from "@/graph/relations";
import {
  edgeLook,
  familyColours,
  ink,
  ink2,
  mix,
  nodeLook,
  paper,
  RING,
  red,
  termColour,
  termPalette,
  unplaced,
} from "@/graph/style";

// The graph view: the map (sigma.js, WebGL), a card for the node in focus, and
// the same concepts as a table for anyone who cannot use the map.

interface MapState {
  showLines: boolean;
  showMistakes: boolean;
  /** A family code, or "" for none. */
  spotlight: string;
}

type Renderer = Sigma<Attributes, Attributes, Attributes, object, object, MapState>;

/** "family", or a teaching plan's slug: colour concepts by the term that plan teaches them in. */
type ColourBy = string;

function look(node: GraphNode, colours: Record<string, string>, relations: Relations, colourBy: ColourBy) {
  const byTerm = colourBy !== "family" && node.kind === "concept" ? termColour(node.when[colourBy]?.term) : undefined;
  return nodeLook(node, colours, relations.neededFor(node.id).length, byTerm);
}

export function GraphExplorer({ graph, positions }: { graph: BaseGraph; positions: Positions }) {
  const relations = useMemo(() => new Relations(graph), [graph]);
  const colours = useMemo(() => familyColours(graph.families), [graph.families]);
  const [view, setView] = useState<"map" | "table">("map");
  const [showLines, setShowLines] = useState(true);
  const [showMistakes, setShowMistakes] = useState(false);
  const [spotlight, setSpotlight] = useState<string | null>(null);
  /** The node under the pointer, where the pointer is, and whether its card must open to the left. */
  const [hovered, setHovered] = useState<{ id: string; x: number; y: number; flip: boolean } | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [colourBy, setColourBy] = useState<ColourBy>("family");
  const colourByNow = useRef<ColourBy>("family");
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const drawn = useRef<AbstractGraph | null>(null);

  // Build the map once per graph. Sigma needs the browser, so it loads here.
  useEffect(() => {
    let cancelled = false;
    let instance: Renderer | undefined;
    let stopPhysics: (() => void) | undefined;
    (async () => {
      const [{ default: SigmaClass }, { default: Graph }, rendering, { layerBorder }, physics] = await Promise.all([
        import("sigma"),
        import("graphology"),
        import("sigma/rendering"),
        import("@sigma/node-border"),
        import("d3-force"),
      ]);
      // Labels are drawn from a font atlas, so the page's font must be ready first.
      await document.fonts.ready;
      if (cancelled || !container.current) return;
      const font = getComputedStyle(document.body).fontFamily;

      const g = new Graph({ type: "directed", multi: true });
      for (const node of graph.nodes) {
        const at = positions[node.id] ?? { x: 0, y: 0 };
        g.addNode(node.id, {
          ...look(node, colours, relations, colourByNow.current),
          ...at,
          kind: node.kind,
          families: relations.families(node.id),
        });
      }
      for (const edge of graph.edges) {
        g.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, {
          ...edgeLook(edge),
          families: relations.edgeFamilies(edge),
        });
      }

      const hiddenByLayer = (a: Attributes, s: MapState) =>
        ((a.kind === "statement" || a.kind === "topic") && !s.showLines) || (a.kind === "mistake" && !s.showMistakes);
      const outsideSpotlight = (a: Attributes, s: MapState) =>
        s.spotlight !== "" && !(a.families as string[]).includes(s.spotlight);

      try {
        instance = new SigmaClass(g, container.current, {
          customGraphState: { showLines: true, showMistakes: false, spotlight: "" },
          primitives: {
            nodes: {
              shapes: [rendering.sdfCircle(), rendering.sdfSquare(), rendering.sdfDiamond()],
              variables: {
                ringColor: { type: "color", default: paper },
                borderColor: { type: "color", default: paper },
                borderSize: { type: "number", default: 0 },
              },
              layers: [
                layerBorder({
                  borders: [
                    { size: RING, color: { attribute: "ringColor" }, mode: "relative" },
                    { size: { attribute: "borderSize" }, color: { attribute: "borderColor" }, mode: "relative" },
                    { size: 0, color: { attribute: "color" }, fill: true },
                  ],
                }),
              ],
            },
            edges: {
              paths: [rendering.pathLine()],
              extremities: [rendering.extremityArrow()],
              variables: {
                dashSize: { type: "number", default: 1 },
                gapSize: { type: "number", default: 0 },
              },
              layers: [
                rendering.layerDashed({
                  dashSize: { attribute: "dashSize" },
                  gapSize: { attribute: "gapSize" },
                  solidExtremities: "head",
                }),
              ],
            },
          },
          styles: {
            stage: { background: paper },
            nodes: [
              {
                x: { attribute: "x" },
                y: { attribute: "y" },
                size: { attribute: "size" },
                shape: { attribute: "shape" },
                color: { attribute: "color" },
                ringColor: { attribute: "ringColor" },
                borderColor: { attribute: "borderColor" },
                borderSize: { attribute: "borderSize" },
                label: { attribute: "label" },
                labelFont: font,
                labelColor: ink,
                labelSize: 13,
                depth: "nodes",
                cursor: "pointer",
                visibility: (a, _state, s) => (hiddenByLayer(a, s) ? "hidden" : "visible"),
                labelVisibility: (a) => (a.kind === "mistake" ? "hidden" : "auto"),
                backdropVisibility: "hidden",
              },
              { when: (a, _state, s) => outsideSpotlight(a, s), then: { opacity: 0.12, labelVisibility: "hidden" } },
              {
                when: (_a, state, s) => s.hasHighlighted && !state.isHighlighted,
                then: { opacity: 0.12, labelVisibility: "hidden" },
              },
              { whenState: "isHighlighted", then: { opacity: 1, depth: "topNodes", labelVisibility: "visible" } },
              {
                whenState: "isHovered",
                then: { depth: "topNodes", labelVisibility: "visible", size: (a) => (a.size as number) * 1.3 },
              },
            ],
            edges: [
              {
                size: { attribute: "size" },
                color: { attribute: "color" },
                head: { attribute: "head" },
                dashSize: { attribute: "dashSize" },
                gapSize: { attribute: "gapSize" },
                depth: "edges",
              },
              { when: (a, _state, s) => outsideSpotlight(a, s), then: { opacity: 0.08 } },
              { when: (_a, state, s) => s.hasHighlighted && !state.isHighlighted, then: { opacity: 0.06 } },
              { whenState: "isHighlighted", then: { opacity: 1, depth: "topEdges" } },
            ],
          },
          settings: {
            itemSizesReference: "screen",
            enableNodeDrag: true,
            labelDensity: 0.9,
            labelRenderedSizeThreshold: 5,
            stagePadding: 32,
            minCameraRatio: 0.05,
            maxCameraRatio: 3,
            // The map's box is hidden while the table is shown.
            allowInvalidContainer: true,
            // Fit the map to the box once, so nodes moving under a drag never re-fit the view.
            autoRescale: "once",
          },
        }) as unknown as Renderer;
      } catch {
        setFailed(true);
        return;
      }
      const box = container.current;
      instance.on("enterNode", ({ node, event }) =>
        setHovered({ id: node, x: event.x, y: event.y, flip: event.x > box.clientWidth - 340 }),
      );
      instance.on("leaveNode", () => setHovered(null));
      instance.on("clickNode", ({ node }) => setPinned(node));
      instance.on("clickStage", () => setPinned(null));

      // Dragging a node pulls its neighbours after it, and theirs after them,
      // as the map springs to fit. Every link is a spring at rest at its length
      // in the server's layout, and every node is held lightly to its place
      // there, so the map holds still until it is pulled and keeps its shape.
      // A dropped node is let go where it is put, held there as lightly as the
      // rest are to their places, and settles with its neighbours.
      type Body = { id: string; x: number; y: number; fx?: number | null; fy?: number | null; homeX: number; homeY: number };
      const bodies = new Map<string, Body>(
        graph.nodes.map((n) => {
          const at = positions[n.id] ?? { x: 0, y: 0 };
          return [n.id, { id: n.id, x: at.x, y: at.y, homeX: at.x, homeY: at.y }];
        }),
      );
      const springs = graph.edges.map((e) => {
        const [a, b] = [bodies.get(e.source)!, bodies.get(e.target)!];
        return { source: a, target: b, rest: Math.hypot(a.x - b.x, a.y - b.y) };
      });
      const sim = physics
        .forceSimulation([...bodies.values()])
        .force("springs", physics.forceLink(springs).distance((l) => l.rest))
        .force("homeX", physics.forceX<Body>((b) => b.homeX).strength(0.03))
        .force("homeY", physics.forceY<Body>((b) => b.homeY).strength(0.03))
        .alpha(0)
        .stop()
        .on("tick", () =>
          g.updateEachNodeAttributes(
            (id, a) => {
              const b = bodies.get(id);
              if (b && b.fx == null) {
                a.x = b.x;
                a.y = b.y;
              }
              return a;
            },
            { attributes: ["x", "y"] },
          ),
        );
      const held = (node: string) => {
        const b = bodies.get(node);
        if (!b) return;
        const at = g.getNodeAttributes(node);
        b.x = b.fx = at.x as number;
        b.y = b.fy = at.y as number;
        return b;
      };
      instance.on("nodeDragStart", ({ node }) => {
        setHovered(null);
        held(node);
        sim.alphaTarget(0.3).restart();
      });
      instance.on("nodeDrag", ({ node }) => held(node));
      instance.on("nodeDragEnd", ({ node }) => {
        const b = held(node);
        if (b) {
          [b.homeX, b.homeY] = [b.x, b.y];
          b.fx = b.fy = null;
        }
        sim.alphaTarget(0);
      });
      stopPhysics = () => sim.stop();

      renderer.current = instance;
      drawn.current = g;
    })();
    return () => {
      cancelled = true;
      stopPhysics?.();
      instance?.kill();
      renderer.current = null;
      drawn.current = null;
    };
  }, [graph, positions, relations, colours]);

  // Recolour the concepts by family or by term; sigma redraws when their attributes change.
  useEffect(() => {
    colourByNow.current = colourBy;
    const g = drawn.current;
    if (!g) return;
    for (const node of graph.nodes) {
      if (node.kind === "concept") g.mergeNodeAttributes(node.id, look(node, colours, relations, colourBy));
    }
  }, [colourBy, graph, colours, relations]);

  // The box had no size while the table was shown.
  useEffect(() => {
    if (view === "map") renderer.current?.resize(true).refresh({ skipIndexation: true });
  }, [view]);

  // Layers and the family spotlight.
  useEffect(() => {
    renderer.current
      ?.setGraphState({ showLines, showMistakes, spotlight: spotlight ?? "" })
      .refresh({ skipIndexation: true });
  }, [showLines, showMistakes, spotlight]);

  // The node in focus lights up with its neighbours; everything else fades.
  const focus = hovered?.id ?? pinned;
  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    r.setNodesState(graph.nodes.map((n) => n.id), { isHighlighted: false });
    r.setEdgesState(graph.edges.map((e) => e.id), { isHighlighted: false });
    if (focus) {
      const near = relations.neighbourhood(focus);
      r.setNodesState(near.nodes, { isHighlighted: true });
      r.setEdgesState(near.edges, { isHighlighted: true });
    }
    r.refresh({ skipIndexation: true });
  }, [focus, graph, relations]);

  /** Put a node in focus from a card, the search box or the table: show its layer, pin it, centre the map on it. */
  function select(id: string) {
    const node = relations.byId.get(id);
    if (!node) return;
    if (node.kind === "mistake") setShowMistakes(true);
    if (node.kind === "statement" || node.kind === "topic") setShowLines(true);
    setPinned(id);
    const r = renderer.current;
    const at = r?.getNodeDisplayData(id);
    if (r && at && view === "map") {
      void r.getCamera().animate({ x: at.x, y: at.y, ratio: Math.min(r.getCamera().ratio, 0.5) }, { duration: 400 });
    }
  }

  const searchable = useMemo(
    () =>
      graph.nodes
        .filter((n) => n.kind !== "statement")
        .map((n) => ({ id: n.id, label: `${n.code} — ${summary(n)}` })),
    [graph.nodes],
  );
  const hoveredNode = hovered && relations.byId.get(hovered.id);
  const pinnedNode = pinned ? relations.byId.get(pinned) : undefined;

  return (
    <div className="graph">
      <Standing counts={graph.counts} seesProgress={graph.seesProgress} />

      <div className="graph-controls">
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === "map"} onClick={() => setView("map")}>
            Map
          </button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>
            Table
          </button>
        </div>
        {view === "map" && (
          <>
            <label className="toggle">
              <input type="checkbox" checked={showLines} onChange={(e) => setShowLines(e.target.checked)} />
              Curriculum lines
            </label>
            <label className="toggle">
              <input type="checkbox" checked={showMistakes} onChange={(e) => setShowMistakes(e.target.checked)} />
              Typical mistakes
            </label>
            {graph.plans.length > 0 && (
              <label className="toggle">
                Colour by
                <select value={colourBy} onChange={(e) => setColourBy(e.target.value)}>
                  <option value="family">family</option>
                  {graph.plans.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      term in {planName(p)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <input
          className="graph-search"
          type="search"
          list="graph-search-options"
          placeholder="Find a concept, mistake or topic"
          aria-label="Find a concept, mistake or topic"
          onChange={(e) => {
            const hit = searchable.find((s) => s.label === e.target.value);
            if (hit) {
              select(hit.id);
              e.target.value = "";
            }
          }}
        />
        <datalist id="graph-search-options">
          {searchable.map((s) => (
            <option key={s.id} value={s.label} />
          ))}
        </datalist>
      </div>

      <Legend
        families={graph.families}
        colours={colours}
        spotlight={spotlight}
        onSpotlight={setSpotlight}
        seesProgress={graph.seesProgress}
        byFamily={view === "table" || colourBy === "family"}
      />
      {view === "map" && colourBy !== "family" && <TermKey graph={graph} plan={colourBy} />}

      <div className="graph-body">
        <div className="graph-main">
          <div className="graph-stage" hidden={view !== "map" || failed}>
            <div ref={container} className="graph-canvas" aria-label="Map of the base" role="img" />
            {hoveredNode && hovered && (
              <div
                className="graph-tip"
                style={{
                  left: hovered.x + 16,
                  top: hovered.y + 12,
                  transform: hovered.flip ? "translateX(calc(-100% - 32px))" : undefined,
                }}
              >
                <Tip node={hoveredNode} relations={relations} graph={graph} />
              </div>
            )}
            <p className="graph-hint meta">
              Hover over a node to read it, click to keep its card open, drag it to pull its neighbours along, scroll to zoom.
            </p>
          </div>
          {view === "map" && failed && (
            <p className="flag">This browser could not draw the map (it needs WebGL 2). The table shows the same concepts.</p>
          )}
          {(view === "table" || failed) && <ConceptTable graph={graph} relations={relations} onSelect={select} />}
        </div>
        <aside className="graph-side">
          {pinnedNode ? (
            <Card node={pinnedNode} graph={graph} relations={relations} onSelect={select} onClose={() => setPinned(null)} />
          ) : (
            <div className="panel meta">Click a node, or a row of the table, to see its card here.</div>
          )}
        </aside>
      </div>
    </div>
  );
}

function summary(node: GraphNode) {
  switch (node.kind) {
    case "topic":
      return node.title;
    case "statement":
      return node.text;
    case "concept":
      return node.title;
    case "mistake":
      return node.statement;
  }
}

/** Where the base stands, and what may be claimed for it. */
function Standing({ counts, seesProgress }: { counts: BaseGraph["counts"]; seesProgress: boolean }) {
  const confirmed = counts.concepts.confirmed + counts.prerequisites.confirmed + counts.mistakes.confirmed;
  const line = (label: string, t: Tally) => (
    <span>
      <b>{label}</b> {t.confirmed} of {t.total} confirmed
      {seesProgress && t.reviewed > 0 ? `, ${t.reviewed} reviewed once` : ""}
    </span>
  );
  return (
    <div className="graph-standing">
      <div className="graph-counts">
        {line("Concepts", counts.concepts)}
        {line("Prerequisites", counts.prerequisites)}
        {line("Mistakes", counts.mistakes)}
      </div>
      <p className="meta">
        {confirmed === 0
          ? "Nothing here is confirmed yet: the concepts, prerequisites and mistakes are an AI draft until two reviewers confirm them."
          : "Solid items are confirmed by two reviewers; hollow ones are an AI draft still awaiting review."}{" "}
        The curriculum lines are the curriculum&apos;s own words, checked word for word against the published document.
      </p>
    </div>
  );
}

function Legend({
  families,
  colours,
  spotlight,
  onSpotlight,
  seesProgress,
  byFamily,
}: {
  families: BaseGraph["families"];
  colours: Record<string, string>;
  spotlight: string | null;
  onSpotlight: (code: string | null) => void;
  seesProgress: boolean;
  /** Whether the map is coloured by family, so the chips carry the colours. */
  byFamily: boolean;
}) {
  return (
    <div className="graph-legend">
      <div className="chips" role="group" aria-label="Families: choose one to pick it out">
        {families.map((f) => (
          <button
            key={f.code}
            type="button"
            className="chip"
            aria-pressed={spotlight === f.code}
            onClick={() => onSpotlight(spotlight === f.code ? null : f.code)}
            title={spotlight === f.code ? "Show every family" : `Pick out ${f.title}`}
          >
            {byFamily && <i style={{ background: colours[f.code] }} />}
            <b>{f.code}</b> {f.title}
          </button>
        ))}
      </div>
      <div className="keys meta">
        <span>
          <Glyph status="proposed" /> proposed
        </span>
        {seesProgress && (
          <span>
            <Glyph status="reviewed" /> reviewed once
          </span>
        )}
        <span>
          <Glyph status="confirmed" /> confirmed
        </span>
        <span>
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill={paper} stroke={ink2} strokeWidth="1.5" />
            <circle cx="7" cy="7" r="6.2" fill="none" stroke={ink} strokeWidth="1.4" />
          </svg>{" "}
          gateway
        </span>
        <span>
          <svg width="12" height="12" aria-hidden="true">
            <rect x="2" y="2" width="8" height="8" fill={ink2} />
          </svg>{" "}
          curriculum line
        </span>
        <span>
          <svg width="12" height="12" aria-hidden="true">
            <path d="M6 1 L11 6 L6 11 L1 6 Z" fill={red} />
          </svg>{" "}
          typical mistake
        </span>
        <span>
          <svg width="34" height="10" aria-hidden="true">
            <path d="M1 5 H26" stroke={ink2} strokeWidth="1.8" strokeDasharray="4 4" />
            <path d="M26 1.5 L33 5 L26 8.5 Z" fill={ink2} />
          </svg>{" "}
          needed for (solid once confirmed)
        </span>
      </div>
    </div>
  );
}

function Glyph({ status }: { status: GraphStatus }) {
  const fill = status === "confirmed" ? ink2 : status === "reviewed" ? mix(ink2, paper, 0.55) : paper;
  return (
    <svg width="12" height="12" aria-hidden="true">
      <circle cx="6" cy="6" r="4.8" fill={fill} stroke={ink2} strokeWidth="1.5" />
    </svg>
  );
}

const statusLabel: Record<GraphStatus, string> = {
  proposed: "proposed",
  reviewed: "reviewed once",
  confirmed: "confirmed",
};

function Status({ status }: { status: GraphStatus }) {
  return <span className={`status ${status}`}>{statusLabel[status]}</span>;
}

/** The short card beside the pointer. */
function Tip({ node, relations, graph }: { node: GraphNode; relations: Relations; graph: BaseGraph }) {
  switch (node.kind) {
    case "concept": {
      const needs = relations.prerequisites(node.id);
      const mistakes = relations.mistakes(node.id).length;
      const line = relations.lines(node.id)[0]?.node as StatementNode | undefined;
      return (
        <>
          <div className="kicker">
            {node.code} · {familyTitle(graph, node.family)}
            {node.isGateway ? " · gateway" : ""}
          </div>
          <div className="tip-title">{node.title}</div>
          {line && <blockquote>{line.text}</blockquote>}
          <div className="meta">
            <Status status={node.status} />
            {needs.length > 0 && ` Needs ${needs.map((n) => n.node.code).join(", ")}.`}
            {mistakes > 0 && ` ${mistakes} typical mistake${mistakes === 1 ? "" : "s"}.`}
          </div>
          {graph.plans.length > 0 && (
            <div className="meta">
              {graph.plans.map((p) => `${planName(p)}: ${whenText(node.when[p.slug], { short: true })}`).join(" · ")}
            </div>
          )}
        </>
      );
    }
    case "statement":
      return (
        <>
          <div className="kicker">
            Curriculum line{node.page ? ` · p. ${node.page}` : ""}
            {node.topic ? ` · ${node.topic}` : ""}
          </div>
          <blockquote>{node.text}</blockquote>
          {node.isRevision && <div className="meta">A &ldquo;Revise&rdquo; line: it points back to earlier teaching.</div>}
        </>
      );
    case "mistake":
      return (
        <>
          <div className="kicker">{node.code} · typical mistake</div>
          <div className="tip-title">{node.statement}</div>
          {node.example && <div className="tip-example">{node.example}</div>}
          <div className="meta">
            <Status status={node.status} /> Gets in the way of {relations.concepts(node.id).map((c) => c.node.code).join(", ")}.
          </div>
        </>
      );
    case "topic":
      return (
        <>
          <div className="kicker">{node.nodeType.replace("-", " ")}</div>
          <div className="tip-title">
            {node.code} {node.title}
          </div>
        </>
      );
  }
}

function familyTitle(graph: BaseGraph, code: string | null) {
  return graph.families.find((f) => f.code === code)?.title ?? "no family";
}

/** The full card for the pinned node. */
function Card({
  node,
  graph,
  relations,
  onSelect,
  onClose,
}: {
  node: GraphNode;
  graph: BaseGraph;
  relations: Relations;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="panel graph-card">
      <button type="button" className="link-button graph-card-close" onClick={onClose}>
        Close
      </button>
      {node.kind === "concept" && <ConceptCard node={node} graph={graph} relations={relations} onSelect={onSelect} />}
      {node.kind === "statement" && <StatementCard node={node} relations={relations} onSelect={onSelect} />}
      {node.kind === "mistake" && <MistakeCard node={node} relations={relations} onSelect={onSelect} />}
      {node.kind === "topic" && <TopicCard node={node} graph={graph} relations={relations} onSelect={onSelect} />}
    </div>
  );
}

function ConceptCard({
  node,
  graph,
  relations,
  onSelect,
}: {
  node: ConceptNode;
  graph: BaseGraph;
  relations: Relations;
  onSelect: (id: string) => void;
}) {
  const lines = relations.lines(node.id);
  const needs = relations.prerequisites(node.id);
  const neededFor = relations.neededFor(node.id);
  const mistakes = relations.mistakes(node.id);
  const facts = [node.conceptKind && `A ${node.conceptKind}`, node.isGateway && "gateway concept"].filter(Boolean);
  return (
    <>
      <div className="kicker">Concept · {familyTitle(graph, node.family)}</div>
      <div className="code">{node.code}</div>
      <h2>{node.title}</h2>
      <p className="meta">
        <Status status={node.status} /> {facts.join(" · ")}
      </p>
      {node.description && <p>{node.description}</p>}

      <WhenTaught plans={graph.plans} when={node.when} />

      <h3>What the curriculum says</h3>
      {lines.length ? (
        lines.map(({ node: line }) => <LineQuote key={line.id} line={line as StatementNode} onSelect={onSelect} />)
      ) : (
        <p className="empty">No curriculum line defines this concept yet.</p>
      )}

      <RelatedList title="Needs" items={needs} empty="Nothing in this grade, so far." onSelect={onSelect} why />
      <RelatedList title="Needed for" items={neededFor} empty="Nothing yet." onSelect={onSelect} />
      <RelatedList title="Typical mistakes" items={mistakes} empty="None drafted." onSelect={onSelect} />
    </>
  );
}

function StatementCard({ node, relations, onSelect }: { node: StatementNode; relations: Relations; onSelect: (id: string) => void }) {
  const defines = relations.concepts(node.id);
  return (
    <>
      <div className="kicker">Curriculum line</div>
      <blockquote>
        <p>{node.text}</p>
        <div className="reference">{[node.document, node.page && `p. ${node.page}`, node.topic].filter(Boolean).join(" · ")}</div>
      </blockquote>
      {node.isRevision ? (
        <p className="meta">A &ldquo;Revise&rdquo; line: it points back to earlier teaching and defines no concept of its own.</p>
      ) : (
        <RelatedList title="Defines" items={defines} empty="No concept yet." onSelect={onSelect} />
      )}
    </>
  );
}

function MistakeCard({ node, relations, onSelect }: { node: MistakeNode; relations: Relations; onSelect: (id: string) => void }) {
  return (
    <>
      <div className="kicker">Typical mistake</div>
      <div className="mistake">
        <div className="code">{node.code}</div>
        <div className="rule">{node.statement}</div>
        {node.example && <div className="example">{node.example}</div>}
      </div>
      <p className="meta">
        <Status status={node.status} /> {node.sourced ? "Cites a source." : "Unsourced so far."}
      </p>
      <RelatedList title="Gets in the way of" items={relations.concepts(node.id)} empty="No concept." onSelect={onSelect} />
    </>
  );
}

function TopicCard({
  node,
  graph,
  relations,
  onSelect,
}: {
  node: TopicNode;
  graph: BaseGraph;
  relations: Relations;
  onSelect: (id: string) => void;
}) {
  const children = relations.children(node.id);
  const headings = children.filter((c) => c.node.kind === "topic");
  const lines = children.length - headings.length;
  return (
    <>
      <div className="kicker">{node.nodeType.replace("-", " ")}</div>
      <h2>
        {node.code} {node.title}
      </h2>
      <WhenTaught plans={graph.plans} when={node.when} />
      {headings.length > 0 && <RelatedList title="Under it" items={headings} empty="" onSelect={onSelect} />}
      {lines > 0 && (
        <p className="meta">
          {lines} curriculum line{lines === 1 ? "" : "s"} on the map.
        </p>
      )}
    </>
  );
}

function LineQuote({ line, onSelect }: { line: StatementNode; onSelect: (id: string) => void }) {
  return (
    <blockquote>
      <p>{line.text}</p>
      <button type="button" className="link-button reference" onClick={() => onSelect(line.id)}>
        {[line.page && `p. ${line.page}`, line.topic].filter(Boolean).join(" · ")}
      </button>
    </blockquote>
  );
}

function RelatedList({
  title,
  items,
  empty,
  onSelect,
  why = false,
}: {
  title: string;
  items: Related[];
  empty: string;
  onSelect: (id: string) => void;
  /** Show why each link was proposed. */
  why?: boolean;
}) {
  return (
    <>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <ul className="graph-related">
          {items.map(({ node, edge }) => (
            <li key={edge.id}>
              <button type="button" className="link-button" onClick={() => onSelect(node.id)}>
                <b>{node.code}</b> {summary(node)}
              </button>
              {edge.status && edge.type !== "defines" && <Status status={edge.status} />}
              {why && edge.rationale && <div className="rationale">{edge.rationale}</div>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Every concept in curriculum order, with what it needs: the map's content without the map. */
function ConceptTable({ graph, relations, onSelect }: { graph: BaseGraph; relations: Relations; onSelect: (id: string) => void }) {
  const concepts = graph.nodes.filter((n): n is ConceptNode => n.kind === "concept");
  return (
    <div className="panel graph-table">
      <table>
        <caption className="meta">
          {concepts.length} concepts, in the order the curriculum first teaches them.
        </caption>
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Concept</th>
            <th scope="col">Family</th>
            <th scope="col">Status</th>
            <th scope="col">Needs</th>
            <th scope="col">Mistakes</th>
            {graph.plans.map((p) => (
              <th key={p.slug} scope="col">
                {planName(p)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {concepts.map((c) => (
            <tr key={c.id}>
              <th scope="row">
                <button type="button" className="link-button" onClick={() => onSelect(c.id)}>
                  {c.code}
                </button>
              </th>
              <td>
                {c.title}
                {c.isGateway ? " (gateway)" : ""}
              </td>
              <td>{c.family ?? "—"}</td>
              <td>
                <Status status={c.status} />
              </td>
              <td>{relations.prerequisites(c.id).map((p) => p.node.code).join(", ") || "—"}</td>
              <td>{relations.mistakes(c.id).length}</td>
              {graph.plans.map((p) => (
                <td key={p.slug}>{whenText(c.when[p.slug], { short: true })}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** When each teaching plan teaches a concept or heading, and what the plan places to teach it. */
function WhenTaught({ plans, when }: { plans: TeachingPlan[]; when: Record<string, Placed> }) {
  if (plans.length === 0) return null;
  return (
    <>
      <h3>When it is taught</h3>
      <ul className="graph-related">
        {plans.map((p) => {
          const placed = when[p.slug];
          return (
            <li key={p.slug}>
              <b>{planName(p)}</b>: {whenText(placed)}
              {placed && (
                <div className="rationale">
                  {placed.of}
                  {placed.hours ? `, ${placed.hours.toLocaleString("en-ZA")} hours` : ""}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The term colours, and what changes against every other plan. */
function TermKey({ graph, plan }: { graph: BaseGraph; plan: string }) {
  const chosen = graph.plans.find((p) => p.slug === plan);
  if (!chosen) return null;
  return (
    <div className="graph-term-key">
      <div className="keys meta">
        <span>Coloured by the term {planName(chosen)} teaches each concept in:</span>
        {termPalette.map((colour, i) => (
          <span key={colour}>
            <Swatch colour={colour} /> Term {i + 1}
          </span>
        ))}
        <span>
          <Swatch colour={unplaced} /> not placed
        </span>
      </div>
      {graph.plans
        .filter((p) => p.slug !== plan)
        .map((other) => {
          const changes = termChanges(graph, other.slug, plan);
          return (
            <p key={other.slug} className="meta">
              {changes.length === 0
                ? `Every concept both plans place is taught in the same term as in ${planName(other)}.`
                : `Against ${planName(other)}: ${changes
                    .map(
                      (c) =>
                        `${c.of} (${c.concepts.length} concept${c.concepts.length === 1 ? "" : "s"}) moves from Term ${c.fromTerm} to Term ${c.toTerm}`,
                    )
                    .join("; ")}.`}
            </p>
          );
        })}
    </div>
  );
}

function Swatch({ colour }: { colour: string }) {
  return (
    <svg width="12" height="12" aria-hidden="true">
      <circle cx="6" cy="6" r="5" fill={colour} />
    </svg>
  );
}
