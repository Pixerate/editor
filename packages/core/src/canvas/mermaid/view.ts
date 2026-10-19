import type { DiagramGraph, Point } from "../../diagram/types.js";
import { DEFAULT_DIAGRAM_NODE_HEIGHT, type DiagramLayout, type DiagramSize } from "./layout.js";

/**
 * Helpers for showing a laid-out diagram outside the editor: sizing an inline
 * viewer to its content, animating between two layouts, and trimming a graph
 * that is still being streamed in. Pure functions — no React, no DOM.
 *
 * @module
 */

export interface DiagramBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Extent of every positioned node and group, or `null` for an empty layout. */
export function diagramLayoutBounds(layout: DiagramLayout): DiagramBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [id, [x, y]] of Object.entries(layout.positions)) {
    const size = layout.sizes[id] ?? { width: 0, height: 0 };
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + size.width);
    maxY = Math.max(maxY, y + size.height);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface DiagramCanvasHeightOptions {
  /** Smallest height returned (default 320). */
  min?: number;
  /** Largest height returned; taller content is zoomed out (default 560). */
  max?: number;
  /** Room added around the content (default 48). */
  padding?: number;
}

function clampHeight(content: number, options: DiagramCanvasHeightOptions = {}): number {
  const { min = 320, max = 560, padding = 48 } = options;
  return Math.round(Math.min(max, Math.max(min, content + padding)));
}

/** Container height that shows a layout at 1:1 where it fits, clamped. */
export function diagramCanvasHeight(layout: DiagramLayout, options?: DiagramCanvasHeightOptions): number {
  return clampHeight(diagramLayoutBounds(layout)?.height ?? 0, options);
}

// Shared with dagre's default rank separation, so the estimate and the real
// height agree for a simple chain.
const RANK_HEIGHT = DEFAULT_DIAGRAM_NODE_HEIGHT + 72;
// Counts alone cannot tell a chain from a fan-out; both clamp long before the
// error matters.
const NODES_PER_RANK = 2;
const GROUP_BAND = 24 * 2 + 32;

/**
 * Height to reserve before the asynchronous layout resolves, from the graph's
 * counts alone. Uses the same clamp as {@link diagramCanvasHeight}, so the container
 * does not jump when the layout lands.
 */
export function estimateDiagramCanvasHeight(graph: DiagramGraph, options?: DiagramCanvasHeightOptions): number {
  const ranks = Math.ceil(graph.nodes.length / NODES_PER_RANK);
  return clampHeight(ranks * RANK_HEIGHT + graph.groups.length * GROUP_BAND, options);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * A layout partway between two others, for animating a re-layout: ids in both
 * interpolate at `t` (0 = `from`, 1 = `to`), ids new in `to` start at their
 * target, and ids missing from `to` drop out.
 */
export function blendDiagramLayout(from: DiagramLayout, to: DiagramLayout, t: number): DiagramLayout {
  if (t >= 1) return to;
  const positions: Record<string, Point> = {};
  for (const [id, [x, y]] of Object.entries(to.positions)) {
    const origin = from.positions[id];
    positions[id] = origin ? [mix(origin[0], x, t), mix(origin[1], y, t)] : [x, y];
  }
  const sizes: Record<string, DiagramSize> = {};
  for (const [id, size] of Object.entries(to.sizes)) {
    const origin = from.sizes[id];
    sizes[id] = origin
      ? { width: mix(origin.width, size.width, t), height: mix(origin.height, size.height, t) }
      : size;
  }
  return { positions, sizes };
}

/**
 * The graph without nodes that no edge touches yet. While a diagram streams
 * in, a node usually arrives a line before the edge that places it; showing it
 * alone makes the layout jump twice. Groups are kept when they (or a nested
 * group) still contain a node.
 */
export function connectedDiagramOnly(graph: DiagramGraph): DiagramGraph {
  const linked = new Set<string>();
  for (const edge of graph.edges) {
    linked.add(edge.source);
    linked.add(edge.target);
  }
  const nodes = graph.nodes.filter((n) => linked.has(n.id));
  if (nodes.length === graph.nodes.length) return graph;
  const parentOf = new Map(graph.groups.map((g) => [g.id, g.parentId]));
  const keep = new Set<string>();
  for (const node of nodes) {
    let id = node.parentId;
    while (id && !keep.has(id)) {
      keep.add(id);
      id = parentOf.get(id);
    }
  }
  // An edge can name a group as an endpoint (flowchart allows it).
  for (const id of linked) if (parentOf.has(id)) keep.add(id);
  return { ...graph, nodes, groups: graph.groups.filter((g) => keep.has(g.id)) };
}
