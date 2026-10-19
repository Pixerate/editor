import type {
  ArrowHead,
  DiagramGraph,
  EdgePattern,
  GraphEdge,
  GraphGroup,
  GraphNode,
  Point,
} from "../../diagram/types.js";
import type { DiagramLayout, DiagramSize } from "./layout.js";

/**
 * Projection of a Mermaid diagram graph onto canvas (React Flow / Svelte Flow) nodes and edges.
 * Kept free of React so it can be unit-tested and reused (e.g. for export).
 *
 * @module
 */

export interface MermaidNodeData extends Record<string, unknown> {
  node: GraphNode;
  family: string;
  /** Resolved `classDef` styles for the node's classes, merged with inline styles. */
  resolvedStyles: Record<string, string>;
  editable: boolean;
}

export interface MermaidGroupData extends Record<string, unknown> {
  group: GraphGroup;
  family: string;
  resolvedStyles: Record<string, string>;
  editable: boolean;
}

export interface MermaidEdgeData extends Record<string, unknown> {
  edge: GraphEdge;
  family: string;
  resolvedStyles: Record<string, string>;
  editable: boolean;
}

export interface MermaidFlowNode {
  id: string;
  /** `mermaid-node` / `mermaid-group`, or a family canvas node type. */
  type: string;
  position: { x: number; y: number };
  data: MermaidNodeData | MermaidGroupData | Record<string, unknown>;
  parentId?: string;
  width: number;
  height: number;
  style?: Record<string, string | number>;
  draggable: boolean;
  selectable: boolean;
  connectable: boolean;
  zIndex: number;
  extent?: "parent";
  className?: string;
}

export interface MermaidFlowEdge {
  id: string;
  /** `mermaid-edge`, or a family canvas edge type. */
  type: string;
  source: string;
  target: string;
  data: MermaidEdgeData;
  label?: string;
  selectable: boolean;
  reconnectable: boolean;
  zIndex: number;
  sourceHandle?: string;
  targetHandle?: string;
  className?: string;
}

/** Parses `fill:#f9f,stroke:#333,stroke-width:4px` into an object. */
export function parseMermaidStyles(styles: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of styles) {
    const idx = s.indexOf(":");
    if (idx === -1) continue;
    out[s.slice(0, idx).trim()] = s.slice(idx + 1).trim();
  }
  return out;
}

export function resolveMermaidStyles(
  classes: string[],
  inline: string[],
  classDefs: Record<string, string[]>,
): Record<string, string> {
  let out: Record<string, string> = {};
  if (classDefs.default) out = { ...out, ...parseMermaidStyles(classDefs.default) };
  for (const cls of classes)
    if (classDefs[cls]) out = { ...out, ...parseMermaidStyles(classDefs[cls]!) };
  return { ...out, ...parseMermaidStyles(inline) };
}

function depth(id: string, parents: Map<string, string | undefined>): number {
  let d = 0;
  let cur = parents.get(id);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    d++;
    cur = parents.get(cur);
  }
  return d;
}

export interface MermaidFlowOptions {
  editable?: boolean;
  /** Override positions (e.g. during a drag). Absolute coordinates. */
  positions?: Record<string, Point>;
  sizes?: Record<string, DiagramSize>;
}

/**
 * Converts the graph + layout into React Flow nodes. Positions in the layout
 * are absolute; React Flow wants child positions relative to the parent, so
 * they are converted here.
 */
export function mermaidFlowNodes(
  graph: DiagramGraph,
  layout: DiagramLayout,
  options: MermaidFlowOptions = {},
): MermaidFlowNode[] {
  const editable = options.editable ?? false;
  const positions = { ...layout.positions, ...(options.positions ?? {}) };
  const sizes = { ...layout.sizes, ...(options.sizes ?? {}) };
  const parents = new Map<string, string | undefined>();
  for (const n of graph.nodes) parents.set(n.id, n.parentId);
  for (const g of graph.groups) parents.set(g.id, g.parentId);

  const rel = (id: string, parentId: string | undefined): { x: number; y: number } => {
    const [x, y] = positions[id] ?? [0, 0];
    if (!parentId) return { x, y };
    const [px, py] = positions[parentId] ?? [0, 0];
    return { x: x - px, y: y - py };
  };

  const groups: MermaidFlowNode[] = graph.groups.map((g) => {
    const size = sizes[g.id] ?? { width: 240, height: 160 };
    return {
      id: g.id,
      type: "mermaid-group",
      position: rel(g.id, g.parentId),
      parentId: g.parentId,
      data: {
        group: g,
        family: "",
        resolvedStyles: resolveMermaidStyles(g.classes, g.styles, graph.classDefs),
        editable,
      },
      width: size.width,
      height: size.height,
      style: { width: size.width, height: size.height },
      draggable: editable && !g.data?.locked,
      selectable: editable,
      connectable: editable && !g.data?.locked,
      zIndex: depth(g.id, parents),
    };
  });

  const nodes: MermaidFlowNode[] = graph.nodes.map((n) => {
    const size = sizes[n.id] ?? { width: 160, height: 56 };
    return {
      id: n.id,
      type: "mermaid-node",
      position: rel(n.id, n.parentId),
      parentId: n.parentId,
      data: {
        node: n,
        family: "",
        resolvedStyles: resolveMermaidStyles(n.classes, n.styles, graph.classDefs),
        editable,
      },
      width: size.width,
      height: size.height,
      style: { width: size.width, height: size.height },
      draggable: editable && !n.data?.locked,
      selectable: editable,
      connectable: editable && !n.data?.locked && !n.data?.synthetic,
      zIndex: depth(n.id, parents) + 100,
    };
  });

  // Parents must precede children for React Flow.
  const order = (a: MermaidFlowNode, b: MermaidFlowNode) => depth(a.id, parents) - depth(b.id, parents);
  return [...groups.sort(order), ...nodes.sort(order)];
}

export function mermaidFlowEdges(graph: DiagramGraph, options: MermaidFlowOptions = {}): MermaidFlowEdge[] {
  const editable = options.editable ?? false;
  return graph.edges.map((e) => ({
    id: e.id,
    type: "mermaid-edge",
    source: e.source,
    target: e.target,
    label: e.label,
    data: {
      edge: e,
      family: "",
      resolvedStyles: resolveMermaidStyles(e.classes, e.styles, graph.classDefs),
      editable,
    },
    selectable: editable,
    reconnectable: editable,
    zIndex: 1000,
  }));
}

/** SVG marker id for an arrow head (markers are defined once by the canvas). */
export function mermaidMarkerId(head: ArrowHead, side: "start" | "end"): string | undefined {
  if (head === "none") return undefined;
  return `pixerate-mermaid-marker-${head}-${side}`;
}

export function mermaidEdgeDash(pattern: EdgePattern): string | undefined {
  switch (pattern) {
    case "dotted":
      return "6 4";
    case "invisible":
      return "0 1";
    default:
      return undefined;
  }
}

export function mermaidEdgeWidth(pattern: EdgePattern): number {
  return pattern === "thick" ? 3.5 : 1.75;
}
