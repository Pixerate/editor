import type { ArrowHead, DiagramFamily, DiagramGraph, EdgePattern, GraphNode } from "../types.js";

export interface ShapeOption {
  value: string;
  label: string;
  category?: string;
}

export interface EdgeKindOption {
  value: string;
  label: string;
  arrowStart: ArrowHead;
  arrowEnd: ArrowHead;
  pattern: EdgePattern;
}

/**
 * A data field the inspector edits generically. `node` fields are written with
 * `setNodeData`, `edge` fields with `setEdgeData`, `diagram` fields with
 * `setGraphData`; the adapter decides how each key is serialised.
 */
export interface FieldSpec {
  key: string;
  label: string;
  /** `numbers`: a comma-separated list of numbers (chart values). */
  type: "text" | "number" | "numbers" | "lines" | "select" | "boolean" | "tags";
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Offer the field only on nodes of these shapes (e.g. an image's picture on `image` nodes). */
  shapes?: string[];
}

export interface FamilyUI {
  family: DiagramFamily;
  title: string;
  shapes: ShapeOption[];
  edgeKinds: EdgeKindOption[];
  patterns: { value: EdgePattern; label: string }[];
  arrowHeads: { value: ArrowHead; label: string }[];
  groups: { supported: boolean; label: string };
  /** Whether nodes carry an explicit label distinct from their id. */
  labels: boolean;
  nodeNoun: string;
  /** Suggests an id for a new node. */
  nextId(graph: DiagramGraph): string;
  /** Whether a node in this family may be moved out of its group. */
  canDetach: boolean;
  /** Node data fields the inspector offers (written with `setNodeData`). */
  nodeFields?: FieldSpec[];
  /** Edge data fields (written with `setEdgeData`). */
  edgeFields?: FieldSpec[];
  /** Diagram-level fields (written with `setGraphData`). */
  diagramFields?: FieldSpec[];
  /** Show classes / inline style / link / classDef controls (default true). */
  styling?: boolean;
  /** Whether dragging a handle to another node creates an edge (default true). */
  connectable?: boolean;
  /** Trees: "Add" attaches the new node under the selected node. */
  hierarchy?: boolean;
  /** Offer the direction selector (default true). */
  directions?: boolean;
  /** Offer a per-group direction in the inspector (default true; git graphs have one direction). */
  groupDirections?: boolean;
  /** Offer "Arrange" (dagre). False when positions derive from the data (default true). */
  arrange?: boolean;
  /**
   * Show Mermaid's own rendering next to the canvas by default. Every built-in
   * family draws its Mermaid picture on the canvas itself, so this is off.
   */
  preview?: boolean;
  /**
   * Whether the family is drawn on the canvas (default true). Every built-in
   * family is: flowchart, state, class and ER as nodes and edges, the rest as
   * their own picture (`mermaidToScene` in `@pixerate/editor/canvas`). A host
   * family without a drawing can set it false and show Mermaid's rendering.
   */
  canvas?: boolean;
  /** Offer From / To selects for edges in the inspector (`reconnectEdge`). */
  endpoints?: boolean;
  /** Noun for edges in the UI ("Message", "Dependency"…). Default "Edge". */
  edgeNoun?: string;
  /** Default payload for a node created from the toolbar. */
  newNode?(graph: DiagramGraph, parentId?: string): Partial<GraphNode>;
}

