import type { DiagramFamily, DiagramGraph, DiagramMeta, GraphNode, Point } from "./types.js";

/**
 * Family layouts: families whose positions come from their data (quadrant points,
 * sequence participants, pie slices, Gantt bars…) register one here so the canvas
 * shows the diagram's own geometry instead of a generic graph layout. The dagre layout
 * in `@pixerate/editor/canvas` asks this registry first. Kept here, free of dagre, so
 * family adapters can register without pulling in the canvas.
 *
 * @module
 */

export interface Size {
  width: number;
  height: number;
}

/** Absolute top-left positions and sizes for every node and group. */
export interface LayoutResult {
  positions: Record<string, Point>;
  sizes: Record<string, Size>;
}

/** Options a family layout receives (the canvas layout options, with a measure resolved). */
export interface FamilyLayoutOptions {
  /** Node size estimator. */
  measure: (node: GraphNode) => Size;
  /** Gap between nodes in a rank, in px. */
  nodeSep?: number;
  /** Gap between ranks, in px. */
  rankSep?: number;
  /** Padding inside groups around their children, in px. */
  groupPadding?: number;
  /** Height reserved for a group's title, in px. */
  groupTitleHeight?: number;
}

/**
 * A family-specific layout. Receives the graph, the stored metadata and the resolved
 * options; returns absolute positions and sizes for every node and group.
 */
export type FamilyLayout = (graph: DiagramGraph, meta: DiagramMeta, options: FamilyLayoutOptions) => LayoutResult;

const familyLayouts = new Map<DiagramFamily, FamilyLayout>();

/** Registers (or replaces) the layout used for a family. */
export function registerFamilyLayout(family: DiagramFamily, layout: FamilyLayout): void {
  familyLayouts.set(family, layout);
}

export function getFamilyLayout(family: DiagramFamily | undefined): FamilyLayout | undefined {
  return family ? familyLayouts.get(family) : undefined;
}

/** The frame XY charts are drawn in (Mermaid's default 700 × 500). */
export const XY_CHART_BOX = { x: 0, y: 0, width: 700, height: 500 } as const;
/** The frame radar charts are drawn in (Mermaid's default 600 × 600). */
export const RADAR_CHART_BOX = { x: 0, y: 0, width: 600, height: 600 } as const;

/** A layout that gives every node and group the same frame (charts drawn as one picture). */
export function sharedFrameLayout(box: { x: number; y: number; width: number; height: number }): FamilyLayout {
  return (graph) => {
    const positions: Record<string, Point> = {};
    const sizes: Record<string, Size> = {};
    for (const item of [...graph.nodes, ...graph.groups]) {
      positions[item.id] = [box.x, box.y];
      sizes[item.id] = { width: box.width, height: box.height };
    }
    return { positions, sizes };
  };
}
