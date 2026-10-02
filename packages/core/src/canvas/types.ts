/**
 * Generic coordinate and boundary primitives.
 */
export interface XYPosition {
	x: number;
	y: number;
}

export type Point = readonly [number, number];

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type Position = 'top' | 'right' | 'bottom' | 'left';

export type Side = 'right' | 'below' | 'left' | 'above';

/**
 * Generic canvas node structure compatible across SvelteFlow and ReactFlow.
 */
export interface CanvasNode<
	TData extends Record<string, any> = Record<string, any>,
	TType extends string | undefined = string | undefined
> {
	id: string;
	position: XYPosition;
	data: TData;
	type?: TType;
	selected?: boolean;
	draggable?: boolean;
	selectable?: boolean;
	deletable?: boolean;
	parentId?: string;
	width?: number;
	height?: number;
	measured?: { width?: number; height?: number };
	style?: string;
	className?: string;
	class?: string;
	[key: string]: any;
}

/**
 * Generic canvas edge structure.
 */
export interface CanvasEdge<
	TData extends Record<string, any> = Record<string, any>,
	TType extends string | undefined = string | undefined
> {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string | null;
	targetHandle?: string | null;
	data?: TData;
	type?: TType;
	label?: string;
	selected?: boolean;
	animated?: boolean;
	style?: string;
	[key: string]: any;
}

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
 * Incremental layout options.
 */
export interface IncrementalLayoutOptions extends CanvasLayoutOptions {
	/**
	 * Stored known coordinates for nodes, e.g. from user manual layout or persistence.
	 */
	storedPositions?: Record<string, XYPosition>;
}

/**
 * Options for directional collision-aware placement.
 */
export interface PlaceBesideOptions {
	gap?: number;
	ignore?: string[];
	stepIncrement?: number;
	maxAttempts?: number;
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
export type DisplacementDirection = 'right' | 'left' | 'down' | 'up' | 'vertical';

/**
 * Options for directional displacement calculation.
 */
export interface DirectionalDisplacementOptions {
	direction?: DisplacementDirection;
	gap?: number;
	spreadSiblingLanes?: boolean;
	siblingTolerance?: number;
	minY?: number;
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
 * Strategy used to resolve the primary dock target when multiple targets intersect a dragged node.
 */
export type DockStrategy = 'center-point' | 'max-overlap' | 'pointer' | 'first';

/**
 * Docking and intersection callbacks.
 */
export interface CanvasDockingCallbacks<TNode extends CanvasNode = CanvasNode> {
	onDockHover?: (dockTarget: TNode, draggedNode: TNode) => void;
	onDockLeave?: (dockTarget: TNode, draggedNode: TNode) => void;
	onDockDrop?: (dockTarget: TNode, draggedNode: TNode) => void;
}
