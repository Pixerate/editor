import type { Node, Edge, XYPosition, Rect, ColorMode, Position } from '@xyflow/svelte';

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

