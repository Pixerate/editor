import type { Node, Edge, XYPosition, Rect, ColorMode } from '@xyflow/svelte';

/**
 * Generic node interface representing an element on the canvas.
 */
export type CanvasNode<
  TData extends Record<string, any> = Record<string, any>,
  TType extends string | undefined = string | undefined
> = Node<TData, TType>;

/**
 * Generic edge interface representing a connection on the canvas.
 */
export type CanvasEdge<
  TData extends Record<string, any> = Record<string, any>,
  TType extends string | undefined = string | undefined
> = Edge<TData, TType>;

/**
 * Differences computed between two graph states.
 */
export interface GraphDifferences<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  changedNodes: TNode[];
  changedEdges: TEdge[];
  removedNodes: TNode[];
  removedEdges: TEdge[];
}

/**
 * Standard serialized clipboard payload for nodes and optional edges.
 */
export interface CanvasClipboardPayload<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  version?: number;
  nodes: TNode[];
  edges?: TEdge[];
}

/**
 * Options for Dagre graph layout.
 */
export interface CanvasLayoutOptions {
  direction?: 'LR' | 'TB' | 'RL' | 'BT';
  ranksep?: number;
  nodesep?: number;
  defaultNodeWidth?: number;
  defaultNodeHeight?: number;
}

/**
 * Options for keyboard shortcuts.
 */
export interface CanvasShortcutsOptions<TNode extends CanvasNode = CanvasNode> {
  targetElement?: HTMLElement | Window;
  onCopy?: () => void;
  onCut?: () => void;
  onPaste?: (event: ClipboardEvent) => void;
  onDelete?: (selectedNodes: TNode[]) => void;
  onDuplicate?: (selectedNodes: TNode[]) => void;
  onSelectAll?: () => void;
  onGroup?: (selectedNodes: TNode[]) => void;
  onUngroup?: (selectedNodes: TNode[]) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFitView?: () => void;
  onSearch?: () => void;
  getSelectedNodes?: () => TNode[];
}

/**
 * Docking and intersection callbacks.
 */
export interface CanvasDockingCallbacks<TNode extends CanvasNode = CanvasNode> {
  onDockHover?: (dockTarget: TNode, draggedNode: TNode) => void;
  onDockLeave?: (dockTarget: TNode, draggedNode: TNode) => void;
  onDockDrop?: (dockTarget: TNode, draggedNode: TNode) => void;
}

/**
 * Configuration options for SvelteFlow presets.
 */
export interface CanvasInteractionPresetConfig {
  snapGrid?: [number, number];
  panOnDrag?: number[] | boolean;
  panOnScroll?: boolean;
  selectionOnDrag?: boolean;
  colorMode?: ColorMode;
  multiSelectionKey?: string[];
  minZoom?: number;
  maxZoom?: number;
}

/**
 * Parametric point returned by a trajectory evaluation.
 */
export interface TrajectoryPoint {
  position: XYPosition;
  scale?: number;
  opacity?: number;
}

/**
 * Trajectory evaluation function determining path, scale, and opacity over time t in [0, 1].
 */
export type TrajectoryFunction = (
  origin: XYPosition,
  target: XYPosition,
  progress: number,
  index: number,
  total: number
) => TrajectoryPoint;

/**
 * Options for fan-out trajectory generator.
 */
export interface FanOutTrajectoryOptions {
  curvature?: number;
  spreadAngle?: number;
  startScale?: number;
  endScale?: number;
  startOpacity?: number;
  endOpacity?: number;
}

/**
 * Single node animation transition definition.
 */
export interface NodeTransition<TNode extends CanvasNode = CanvasNode> {
  node: TNode;
  from: XYPosition;
  to: XYPosition;
  trajectory?: TrajectoryFunction;
  delay?: number;
  duration?: number;
  easing?: (t: number) => number;
  index?: number;
  total?: number;
}

/**
 * Displacement axis / direction.
 */
export type DisplacementDirection = 'right' | 'left' | 'down' | 'up';

/**
 * Options for directional displacement calculation.
 */
export interface DirectionalDisplacementOptions {
  direction?: DisplacementDirection;
  gap?: number;
  spreadSiblingLanes?: boolean;
  siblingTolerance?: number;
}

/**
 * Options for Dagre reflow displacement calculation.
 */
export interface ReflowDisplacementOptions extends CanvasLayoutOptions {
  anchorNodeId: string;
}

/**
 * Snapshot of canvas graph state prior to node explosion, enabling exact reversibility.
 */
export interface ExplosionSnapshot<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  parentId: string;
  childNodeIds: string[];
  childEdgeIds: string[];
  displacedNodes: { id: string; originalPosition: XYPosition }[];
  timestamp: number;
}

/**
 * Options for exploding a node.
 */
export interface ExplodeNodeOptions<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  childNodes: TNode[];
  childEdges?: TEdge[];
  connectParentToChildren?: boolean | 'first' | 'all';
  connectChildrenToDownstream?: boolean;
  displacementStrategy?: 'directional' | 'dagre' | 'none';
  directionalOptions?: DirectionalDisplacementOptions;
  reflowOptions?: Partial<ReflowDisplacementOptions>;
  trajectory?: TrajectoryFunction;
  duration?: number;
  staggerDelay?: number;
  easing?: (t: number) => number;
  onComplete?: () => void;
}

/**
 * Options for collapsing an exploded node.
 */
export interface CollapseNodeOptions {
  duration?: number;
  staggerDelay?: number;
  easing?: (t: number) => number;
  trajectory?: TrajectoryFunction;
  onComplete?: () => void;
}


/**
 * Pure calculation of graph differences between a current state and a baseline state.
 */
export declare function calculateGraphDifferences<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
>(
  currentState: { nodes?: TNode[]; edges?: TEdge[] },
  baselineState: { nodes?: TNode[]; edges?: TEdge[] }
): GraphDifferences<TNode, TEdge>;

/**
 * Pure function to replace a node in a graph, optionally preserving its connected edges.
 */
export declare function replaceNodeInGraph<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
>(
  nodes: TNode[],
  edges: TEdge[],
  oldNode: TNode,
  newNode: TNode,
  keepEdges?: boolean
): { nodes: TNode[]; edges: TEdge[] };

export interface CreateCanvasGraphOptions<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  initialNodes?: TNode[];
  initialEdges?: TEdge[];
  onNodesChange?: (nodes: TNode[]) => void;
  onEdgesChange?: (edges: TEdge[]) => void;
  onSave?: () => void;
  createEdge?: (
    sourceId: string,
    targetId: string,
    options?: { label?: string; animated?: boolean; data?: any }
  ) => TEdge;
}

/**
 * Headless Svelte 5 rune managing canvas graph state and operations.
 */
export declare function createCanvasGraph<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
>(options?: CreateCanvasGraphOptions<TNode, TEdge>): {
  nodes: TNode[];
  edges: TEdge[];
  setNodes(newNodes: TNode[], triggerCallback?: boolean): void;
  setEdges(newEdges: TEdge[], triggerCallback?: boolean): void;
  addNodeOrNodes(nodeOrNodesToAdd: TNode | TNode[], animateFromPosition?: XYPosition, save?: boolean): void;
  addEdge(edgeToAdd: TEdge, save?: boolean): void;
  addEdges(edgesToAdd: TEdge[], save?: boolean): void;
  removeNodes(nodesToRemove: TNode[], save?: boolean): void;
  removeEdges(edgesToRemove: TEdge[], save?: boolean): void;
  replaceNode(oldNode: TNode, newNode: TNode, save?: boolean, keepEdges?: boolean): void;
  addConnectedNodes(params: {
    nodesToAdd: TNode[];
    inboundNodes?: TNode[];
    outboundNodes?: TNode[];
    animatedEdges?: boolean;
    animateFromPosition?: XYPosition;
    inboundEdgeData?: any;
    outboundEdgeData?: any;
    getEdgeLabel?: (source: TNode, target: TNode) => string;
  }): void;
  animateNodePosition(
    node: TNode,
    targetPosition: XYPosition,
    duration?: number,
    easing?: (t: number) => number
  ): void;
  getDifferences(baseline: { nodes?: TNode[]; edges?: TEdge[] }): GraphDifferences<TNode, TEdge>;
};

/**
 * Calculates upper-left flow coordinate for an element to be centered in the viewport.
 */
export declare function getCenteredNodePosition(
  width?: number,
  height?: number,
  screenToFlowPosition?: (position: XYPosition) => XYPosition,
  screenDimensions?: { width: number; height: number }
): XYPosition;

/**
 * Updates positions of nodes so their collective bounding box is centered in the current viewport.
 */
export declare function centerNodes<TNode extends CanvasNode = CanvasNode>(
  nodes: TNode[],
  screenToFlowPosition: (position: XYPosition) => XYPosition,
  getNodesBounds: (nodes: TNode[]) => Rect,
  screenDimensions?: { width: number; height: number }
): TNode[];

/**
 * Automatically calculates directed hierarchical layout of nodes and edges using Dagre.
 */
export declare function getLayoutedNodes<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
>(
  nodes: TNode[],
  edges: TEdge[],
  getNodesBounds: (nodes: TNode[]) => Rect,
  options?: CanvasLayoutOptions
): TNode[];

/**
 * Checks if an event originated from a text input, textarea, contenteditable element, or rich editor.
 */
export declare function isEventFromTextInput(event: Event | { target: EventTarget | null }): boolean;

/**
 * Validates that an object conforms to minimal CanvasNode shape.
 */
export declare function isValidCanvasNode(obj: unknown): obj is CanvasNode;

/**
 * Checks if a string is a valid HTTP/HTTPS URL.
 */
export declare function isValidUrl(url: string): boolean;

export interface CreateCanvasClipboardOptions<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  onPasteNodes?: (nodes: TNode[], edges?: TEdge[]) => void | Promise<void>;
  onPasteUrl?: (url: string, position?: XYPosition) => void;
  onPasteText?: (text: string, position?: XYPosition) => void;
  onPasteImage?: (blob: File) => void | Promise<void>;
  screenToFlowPosition?: (position: XYPosition) => XYPosition;
}

/**
 * Headless Svelte 5 rune managing canvas copy, cut, and paste interactions.
 */
export declare function createCanvasClipboard<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
>(options?: CreateCanvasClipboardOptions<TNode, TEdge>): {
  copySelectedNodes(
    selectedNodes: TNode[],
    connectedEdges?: TEdge[],
    event?: ClipboardEvent
  ): boolean;
  cutSelectedNodes(
    selectedNodes: TNode[],
    connectedEdges?: TEdge[],
    onRemove?: (nodes: TNode[]) => void,
    event?: ClipboardEvent
  ): boolean;
  handlePasteEvent(event: ClipboardEvent): Promise<boolean>;
};

export interface CreateCanvasDockingOptions<TNode extends CanvasNode = CanvasNode>
  extends CanvasDockingCallbacks<TNode> {
  isDockTarget?: (target: TNode) => boolean;
  restorePositionOnDock?: boolean;
  onSave?: () => void;
}

/**
 * Headless Svelte 5 rune managing canvas node dragging, docking intersection, and connection tracking.
 */
export declare function createCanvasDocking<TNode extends CanvasNode = CanvasNode>(
  options?: CreateCanvasDockingOptions<TNode>
): {
  readonly draggedNode: TNode | null;
  readonly draggedInitialPosition: XYPosition | null;
  readonly connectingHandle: string;
  readonly connectingNode: TNode | null;
  readonly isDragging: boolean;
  handleNodeDragStart(params: {
    targetNode: TNode | null;
    event?: MouseEvent | TouchEvent;
  }): void;
  handleNodeDrag(
    params: {
      targetNode: TNode | null;
      event?: MouseEvent | TouchEvent;
    },
    getIntersectingNodes: (node: TNode) => TNode[]
  ): void;
  handleNodeDragStop(
    params: {
      targetNode: TNode | null;
      event?: MouseEvent | TouchEvent;
    },
    getIntersectingNodes: (node: TNode) => TNode[],
    updateNodePosition?: (nodeId: string, position: XYPosition) => void
  ): void;
  handleConnectStart(
    params: {
      nodeId: string | null;
      handleId?: string | null;
      handleType: 'source' | 'target' | null;
    },
    getNode: (id: string) => TNode | undefined
  ): void;
  handleConnectEnd(): void;
  reset(): void;
};

/**
 * Attaches keyboard shortcut handlers for canvas interaction.
 * Automatically ignores shortcuts when the user is typing into text inputs, textareas, or rich editors.
 *
 * @returns A cleanup function to remove event listeners.
 */
export declare function createCanvasShortcuts<TNode extends CanvasNode = CanvasNode>(
  options: CanvasShortcutsOptions<TNode>
): () => void;

export interface CreateCanvasInteractionsOptions {
  targetElement?: HTMLElement | Window;
  onPanModeChange?: (active: boolean) => void;
  onTrackpadDetected?: () => void;
}

/**
 * Headless Svelte 5 rune managing canvas pan interactions (spacebar panning, trackpad pinch detection).
 */
export declare function createCanvasInteractions(
  options?: CreateCanvasInteractionsOptions
): {
  readonly isSpacebarPanning: boolean;
  readonly trackpadDetected: boolean;
  attachListeners(target?: HTMLElement | Window): () => void;
  destroy: () => void;
};

/**
 * Default interaction configuration presets for SvelteFlow.
 */
export declare const defaultSvelteFlowPreset: CanvasInteractionPresetConfig;

/**
 * Miro-compatible interaction preset (middle/right drag to pan, left drag to select).
 */
export declare const miroCompatiblePreset: CanvasInteractionPresetConfig;

/**
 * Helper to ensure panels restore pointer events after selection rectangle releases.
 */
export declare function restorePanelPointerEvents(panelSelector?: string): void;

/**
 * Standard linear trajectory: straight line interpolation with linear scale & opacity progression.
 */
export declare const linearTrajectory: TrajectoryFunction;

/**
 * Creates a fan-out trajectory where nodes arc outward from origin to target.
 */
export declare function createFanOutTrajectory(options?: FanOutTrajectoryOptions): TrajectoryFunction;

/**
 * Creates a custom quadratic Bezier trajectory with a specified or dynamically calculated control point.
 */
export declare function createBezierTrajectory(
  getControlPoint: (origin: XYPosition, target: XYPosition) => XYPosition
): TrajectoryFunction;

/**
 * Coordinates and animates multiple node transitions simultaneously with zero per-frame array allocations.
 */
export declare function runMultiNodeTransition<TNode extends CanvasNode = CanvasNode>(
  transitions: NodeTransition<TNode>[],
  options?: {
    defaultDuration?: number;
    defaultEasing?: (t: number) => number;
    onUpdate?: () => void;
    onComplete?: () => void;
  }
): () => void;

/**
 * Calculates a bounding rectangle for a set of nodes.
 */
export declare function computeNodesBoundingBox<TNode extends CanvasNode = CanvasNode>(
  nodes: TNode[],
  defaultWidth?: number,
  defaultHeight?: number
): Rect;

/**
 * Pure directional displacement calculation.
 */
export declare function calculateDirectionalDisplacement<TNode extends CanvasNode = CanvasNode>(params: {
  existingNodes: TNode[];
  originNode: TNode;
  childNodes: TNode[];
  getNodesBounds?: (nodes: TNode[]) => Rect;
  options?: DirectionalDisplacementOptions;
}): Map<string, XYPosition>;

/**
 * Pure hierarchical Dagre reflow displacement calculation.
 */
export declare function calculateReflowDisplacement<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
>(params: {
  existingNodes: TNode[];
  existingEdges: TEdge[];
  originNode: TNode;
  childNodes: TNode[];
  childEdges?: TEdge[];
  getNodesBounds?: (nodes: TNode[]) => Rect;
  options?: CanvasLayoutOptions;
}): Map<string, XYPosition>;

export interface CanvasGraphTarget<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
> {
  nodes: TNode[];
  edges: TEdge[];
  setNodes: (nodes: TNode[], triggerCallback?: boolean) => void;
  setEdges: (edges: TEdge[], triggerCallback?: boolean) => void;
  addNodeOrNodes: (nodes: TNode | TNode[], animateFrom?: XYPosition, save?: boolean) => void;
  addEdges: (edges: TEdge[], save?: boolean) => void;
  removeNodes: (nodes: TNode[], save?: boolean) => void;
  removeEdges: (edges: TEdge[], save?: boolean) => void;
  createEdge?: (sourceId: string, targetId: string, options?: any) => TEdge;
  onSave?: () => void;
}

export interface CreateCanvasExplosionOptions<TNode extends CanvasNode = CanvasNode> {
  getNodesBounds?: (nodes: TNode[]) => Rect;
  onSave?: () => void;
}

/**
 * Headless Svelte 5 rune managing canvas node explosion, spatial layout displacement,
 * coordinated multi-node animation paths, and reversible collapsing.
 */
export declare function createCanvasExplosion<
  TNode extends CanvasNode = CanvasNode,
  TEdge extends CanvasEdge = CanvasEdge
>(
  graph: CanvasGraphTarget<TNode, TEdge>,
  options?: CreateCanvasExplosionOptions<TNode>
): {
  readonly explodedNodeIds: string[];
  isExploded(nodeId: string): boolean;
  explodeNode(parentId: string, explodeOptions: ExplodeNodeOptions<TNode, TEdge>): boolean;
  collapseNode(parentId: string, collapseOptions?: CollapseNodeOptions): boolean;
  toggleExplode(
    parentId: string,
    explodeOptions: ExplodeNodeOptions<TNode, TEdge>,
    collapseOptions?: CollapseNodeOptions
  ): boolean;
  getSnapshot(parentId: string): ExplosionSnapshot<TNode, TEdge> | undefined;
};

