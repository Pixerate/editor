import { calculateDirectionalDisplacement, calculateReflowDisplacement, computeNodesBoundingBox } from './displacement.js';
import type {
	CanvasEdge,
	CanvasLayoutOptions,
	CanvasNode,
	DirectionalDisplacementOptions,
	ExplosionDisplacementStrategy,
	Rect,
	XYPosition
} from './types.js';

export interface ComputeCanvasExplosionLayoutParams<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	/** Every node on the canvas, including the origin. Never mutated. */
	existingNodes: TNode[];
	/** Every edge on the canvas (only read by the `dagre` strategy). */
	existingEdges?: TEdge[];
	/** The node that explodes. */
	originNode: TNode;
	/** The child nodes at their final positions. Never mutated: the result holds copies. */
	childNodes: TNode[];
	/** Edges between children (or from children to existing nodes). */
	childEdges?: TEdge[];
	/** How existing nodes make room. Default `directional`. */
	strategy?: ExplosionDisplacementStrategy;
	/** Options for the `directional` strategy. */
	options?: DirectionalDisplacementOptions;
	/** Options for the `dagre` strategy. */
	reflowOptions?: CanvasLayoutOptions;
	/** Add parent-to-child edges: every child (`true` / `'all'`), the first child only, or none. Default `false`. */
	connectParentToChildren?: boolean | 'first' | 'all';
	/** Builds a parent-to-child edge. Default `{ id: 'explode:<parent>:<child>', source, target, type: 'default' }`. */
	createEdge?: (sourceId: string, targetId: string) => TEdge;
	/** Bounds of a set of nodes (e.g. the flow instance's `getNodesBounds`). Default: measured sizes. */
	getNodesBounds?: (nodes: TNode[]) => Rect;
}

export interface CanvasExplosionLayoutResult<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	/** New positions of the existing nodes that move to make room, by id. */
	displacedPositions: Map<string, XYPosition>;
	/** Where each displaced node was before, by id (what a collapse restores). */
	originalPositions: Map<string, XYPosition>;
	/** Copies of the child nodes at their final positions. */
	childNodes: TNode[];
	/** The child edges plus any parent-to-child edges (deduplicated). */
	childEdges: TEdge[];
	/** Bounds of the child cluster. */
	childBounds: Rect;
	/** The largest distance any displaced node moves along either axis (0 when nothing moves). */
	totalDisplacementDelta: number;
}

/** The default id of a parent-to-child edge added by an explosion. */
export const explosionEdgeId = (sourceId: string, targetId: string) => `explode:${sourceId}:${targetId}`;

/**
 * Pure explosion layout: works out where existing nodes move to make room for a child cluster
 * and which edges the explosion adds, without touching the inputs. Feed the result to a
 * declarative derivation (`$derived`, `useMemo`) or to an imperative graph coordinator.
 *
 * @throws Error when the origin is not in `existingNodes`, or a child id is already on the canvas
 *   or repeated.
 */
export function computeCanvasExplosionLayout<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(params: ComputeCanvasExplosionLayoutParams<TNode, TEdge>): CanvasExplosionLayoutResult<TNode, TEdge> {
	const {
		existingNodes,
		existingEdges = [],
		originNode,
		childNodes,
		childEdges = [],
		strategy = 'directional',
		options,
		reflowOptions,
		connectParentToChildren = false,
		createEdge,
		getNodesBounds
	} = params;

	const existingIds = new Set(existingNodes.map((n) => n.id));
	if (!existingIds.has(originNode.id)) {
		throw new Error(`The origin node "${originNode.id}" is not in existingNodes; pass the canvas nodes including the origin.`);
	}
	const childIds = new Set<string>();
	for (const child of childNodes) {
		if (existingIds.has(child.id)) {
			throw new Error(`Child node id "${child.id}" is already on the canvas; give exploded children unique ids.`);
		}
		if (childIds.has(child.id)) throw new Error(`Child node id "${child.id}" is repeated; give exploded children unique ids.`);
		childIds.add(child.id);
	}

	const children = childNodes.map((child) => ({ ...child, position: { ...child.position } }) as TNode);

	// Edges first: the dagre reflow ranks children by the parent edges too.
	const edges: TEdge[] = [...childEdges];
	const makeEdge =
		createEdge ??
		((source: string, target: string) => ({ id: explosionEdgeId(source, target), type: 'default', source, target }) as unknown as TEdge);
	const connect = (child: TNode) => {
		if (!edges.some((e) => e.source === originNode.id && e.target === child.id)) edges.push(makeEdge(originNode.id, child.id));
	};
	if (connectParentToChildren === true || connectParentToChildren === 'all') children.forEach(connect);
	else if (connectParentToChildren === 'first' && children.length > 0) connect(children[0]);

	let displacedPositions: Map<string, XYPosition>;
	if (children.length === 0 || strategy === 'none') {
		displacedPositions = new Map();
	} else if (strategy === 'dagre') {
		displacedPositions = calculateReflowDisplacement({
			existingNodes,
			existingEdges,
			originNode,
			childNodes: children,
			childEdges: edges,
			options: reflowOptions
		});
	} else {
		displacedPositions = calculateDirectionalDisplacement({
			existingNodes,
			originNode,
			childNodes: children,
			getNodesBounds,
			options
		});
	}

	const byId = new Map(existingNodes.map((n) => [n.id, n]));
	const originalPositions = new Map<string, XYPosition>();
	let totalDisplacementDelta = 0;
	for (const [id, to] of displacedPositions) {
		const from = byId.get(id)!.position;
		originalPositions.set(id, { ...from });
		totalDisplacementDelta = Math.max(totalDisplacementDelta, Math.abs(to.x - from.x), Math.abs(to.y - from.y));
	}

	return {
		displacedPositions,
		originalPositions,
		childNodes: children,
		childEdges: edges,
		childBounds: getNodesBounds ? getNodesBounds(children) : computeNodesBoundingBox(children),
		totalDisplacementDelta
	};
}
