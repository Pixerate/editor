/**
 * Core document model shared by every diagram family.
 *
 * Design goals:
 *  - **Lossless**: a document parsed and serialised without edits is
 *    byte-identical to its input. Anything the diagram module does not understand is kept
 *    verbatim as a passthrough statement.
 *  - **Graph-first**: every editable family projects onto the same
 *    {@link DiagramGraph} so that one canvas can render all of them.
 *  - **Mermaid-compatible metadata**: canvas state is stored in
 *    `%% @pixerate …` comments (or frontmatter) that every Mermaid parser ignores.
 *
 * @module
 */

/** Mermaid diagram families the diagram module knows how to detect. */
export type DiagramFamily =
  | "flowchart"
  | "state"
  | "class"
  | "er"
  | "requirement"
  | "mindmap"
  | "sequence"
  | "gantt"
  | "pie"
  | "journey"
  | "timeline"
  | "gitGraph"
  | "c4"
  | "quadrant"
  | "sankey"
  | "xychart"
  | "block"
  | "architecture"
  | "packet"
  | "kanban"
  | "radar"
  | "treemap"
  | "info"
  | "unknown";

/**
 * How deeply the diagram module can edit a family.
 *
 * - `editable` — statement-level lossless editing on the canvas. Every
 *   family the diagram module ships an adapter for is editable; the canvas model differs
 *   per family (graph, tree, timeline, chart data…).
 * - `render-only` — source editing with a live Mermaid preview; no canvas.
 *   Used for families without an adapter and for unknown input.
 */
export type SupportTier = "editable" | "render-only";

/** `[x, y]` canvas position in React Flow coordinates. */
export type Point = readonly [number, number];

/** Line pattern of an edge. Mirrors Mermaid's `thickness` / `pattern`. */
export type EdgePattern = "solid" | "dotted" | "thick" | "invisible";

/**
 * Arrow head identifiers, aligned with Mermaid's `arrowTypeStart` /
 * `arrowTypeEnd` values so React Flow markers can be derived uniformly.
 */
export type ArrowHead =
  | "none"
  | "arrow_point"
  | "arrow_open"
  | "arrow_cross"
  | "arrow_circle"
  | "arrow_barb"
  | "extension"
  | "composition"
  | "aggregation"
  | "dependency"
  | "lollipop"
  | "only_one"
  | "zero_or_one"
  | "one_or_more"
  | "zero_or_more"
  | "md_parent"
  | "requirement_arrow"
  | "requirement_contains";

export interface GraphNode {
  /** Stable identifier (the Mermaid id, e.g. `A`). */
  id: string;
  /** Display label (raw Mermaid text, markdown strings included). */
  label: string;
  /**
   * Canonical shape identifier (`rect`, `diam`, `cyl`, `stateStart`,
   * `classBox`, `erBox`…). Mermaid aliases such as `squareRect` or `diamond`
   * are normalised on parse. See `FLOWCHART_SHAPES` for the flowchart set.
   */
  shape: string;
  /** Enclosing group (subgraph / composite state / namespace) id. */
  parentId?: string;
  /** CSS class names applied with `:::`, `class`, or `classDef` defaults. */
  classes: string[];
  /** Inline `style` declarations (`fill:#f9f`, …). */
  styles: string[];
  /** `click` href target. */
  link?: string;
  linkTarget?: string;
  tooltip?: string;
  /** Family-specific payload (class members, ER attributes, state notes…). */
  data?: Record<string, unknown>;
}

export interface GraphGroup {
  id: string;
  label: string;
  parentId?: string;
  /** Local layout direction override (`TB`, `LR`, …). */
  direction?: string;
  classes: string[];
  styles: string[];
  data?: Record<string, unknown>;
}

export interface GraphEdge {
  /** Mermaid-compatible id (`L_A_B_0` for auto ids, or the user id). */
  id: string;
  source: string;
  target: string;
  label?: string;
  pattern: EdgePattern;
  arrowStart: ArrowHead;
  arrowEnd: ArrowHead;
  /** Minimum rank length requested with extra dashes (`---->`). */
  length: number;
  classes: string[];
  styles: string[];
  animate?: boolean;
  animation?: "fast" | "slow";
  /** True when the id was written by the user (`A e1@--> B`). */
  userDefinedId: boolean;
  data?: Record<string, unknown>;
}

/** Normalised, family-independent view of a diagram. */
export interface DiagramGraph {
  direction: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  groups: GraphGroup[];
  /** `classDef` declarations keyed by class name. */
  classDefs: Record<string, string[]>;
  title?: string;
  /**
   * Diagram-level, family-specific settings that are not nodes or edges
   * (pie `showData`, quadrant axis labels, gantt `dateFormat`…). Edited with
   * `setGraphData`; the keys are documented per family in `FamilyUI.diagramFields`.
   */
  data?: Record<string, unknown>;
}

/** Canvas state that Mermaid itself does not model. Persisted as metadata. */
export interface DiagramMeta {
  /** Schema version of the metadata payload. */
  v: 1;
  /** Node / group positions keyed by id. */
  layout?: Record<string, Point>;
  /** Explicit node sizes for resized nodes/groups. */
  sizes?: Record<string, readonly [number, number]>;
  /** Viewport the user last looked at. */
  viewport?: { x: number; y: number; zoom: number };
  /** Free-form extension slot for host applications. */
  ext?: Record<string, unknown>;
}

/** Where metadata lives in the source. */
export type MetaCarrier = "comment" | "frontmatter";

/**
 * Lines that precede the diagram header: YAML frontmatter, `%%{init}%%`
 * directives, comments and blank lines. Kept verbatim.
 */
export interface Preamble {
  /** Raw lines, including the `---` fences of any frontmatter. */
  lines: string[];
  /** Parsed frontmatter when present (title/config/pixerate…). */
  frontmatter?: Record<string, unknown>;
}

/** A parse problem reported by the diagram parser or by Mermaid. */
export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  /** 1-based line in the source, when known. */
  line?: number;
  column?: number;
  source: "pixerate" | "mermaid";
}

/**
 * The parsed document. Family adapters extend `body` with their own statement
 * list; consumers that only need the graph never look at it.
 */
export interface MermaidDocument<TBody = unknown> {
  family: DiagramFamily;
  tier: SupportTier;
  /** Source as given to {@link parseMermaid}. */
  source: string;
  preamble: Preamble;
  /** The header line (`flowchart LR`, `stateDiagram-v2`, …) exactly as written. */
  header: string;
  /** Trailing newline / whitespace after the last statement, kept for fidelity. */
  trailing: string;
  /** End-of-line sequence detected in the source. */
  eol: "\n" | "\r\n";
  graph: DiagramGraph;
  meta: DiagramMeta;
  metaCarrier: MetaCarrier;
  body: TBody;
  diagnostics: Diagnostic[];
  /** True once any edit has been applied to this document. */
  dirty: boolean;
}

/** Directions understood by flowchart / state / class / ER. */
export const DIRECTIONS = ["TB", "TD", "BT", "LR", "RL"] as const;
export type Direction = (typeof DIRECTIONS)[number];

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------

export type EditOp =
  | { type: "addNode"; node: Partial<GraphNode> & { id: string }; position?: Point }
  | { type: "removeNodes"; ids: string[] }
  | { type: "renameNode"; id: string; label: string }
  | { type: "setNodeShape"; id: string; shape: string }
  | { type: "setNodeClasses"; id: string; classes: string[] }
  | { type: "setNodeStyles"; id: string; styles: string[] }
  | { type: "setNodeLink"; id: string; link?: string; target?: string; tooltip?: string }
  | { type: "setNodeData"; id: string; data: Record<string, unknown> }
  | { type: "moveNodes"; moves: { id: string; position: Point }[] }
  | { type: "resizeNode"; id: string; size: readonly [number, number] | undefined }
  | { type: "addEdge"; edge: Partial<GraphEdge> & { source: string; target: string } }
  | { type: "removeEdges"; ids: string[] }
  | { type: "setEdgeLabel"; id: string; label: string }
  /** Family-specific edge payload (sequence activation, message order, gantt dependency type…). */
  | { type: "setEdgeData"; id: string; data: Record<string, unknown> }
  | {
      type: "setEdgeStyle";
      id: string;
      pattern?: EdgePattern;
      arrowStart?: ArrowHead;
      arrowEnd?: ArrowHead;
      length?: number;
      styles?: string[];
    }
  | { type: "reconnectEdge"; id: string; source: string; target: string }
  | { type: "groupNodes"; groupId: string; label: string; nodeIds: string[]; parentId?: string }
  | { type: "ungroup"; groupId: string }
  | { type: "renameGroup"; id: string; label: string }
  | { type: "setGroupDirection"; id: string; direction?: string }
  | { type: "setNodeParent"; ids: string[]; parentId?: string }
  | { type: "setDirection"; direction: string }
  | { type: "setClassDef"; name: string; styles: string[] | undefined }
  | { type: "setTitle"; title: string | undefined }
  /** Merge diagram-level settings into `graph.data` (see {@link DiagramGraph.data}). */
  | { type: "setGraphData"; data: Record<string, unknown> }
  | { type: "setViewport"; viewport: DiagramMeta["viewport"] }
  | { type: "setMetaExt"; key: string; value: unknown }
  | { type: "replaceSource"; source: string };

/** Family adapter contract. See `docs/architecture.md`. */
export interface DiagramAdapter<TBody = unknown> {
  family: DiagramFamily;
  tier: SupportTier;
  parse(source: string, context: AdapterParseContext): MermaidDocument<TBody>;
  serialize(doc: MermaidDocument<TBody>): string;
  apply(doc: MermaidDocument<TBody>, op: EditOp): MermaidDocument<TBody>;
}

/** Pre-split source handed to adapters so they do not repeat the work. */
export interface AdapterParseContext {
  source: string;
  eol: "\n" | "\r\n";
  preamble: Preamble;
  header: string;
  /** Body lines after the header (metadata comments already removed). */
  bodyLines: string[];
  trailing: string;
  meta: DiagramMeta;
  metaCarrier: MetaCarrier;
  family: DiagramFamily;
}
