import { useCallback, useEffect, useRef, useState } from 'react';
import {
	computeCanvasExplosionLayout,
	createFanOutTrajectory,
	linearPositionTrajectory,
	runMultiNodeTransition,
	type CanvasEdge,
	type CanvasNode,
	type CollapseNodeOptions,
	type ExplodeNodeOptions,
	type ExplosionSnapshot,
	type NodeTransition,
	type Rect,
	type XYPosition
} from '@pixerate/editor/canvas';

export interface CanvasGraphTarget<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	nodes: TNode[];
	edges: TEdge[];
	setNodes: (updater: TNode[] | ((prev: TNode[]) => TNode[])) => void;
	setEdges: (updater: TEdge[] | ((prev: TEdge[]) => TEdge[])) => void;
	/** Builds a parent-to-child edge. Default `{ id: 'explode:<parent>:<child>', source, target }`. */
	createEdge?: (sourceId: string, targetId: string) => TEdge;
}

export interface UseCanvasExplosionOptions<TNode extends CanvasNode = CanvasNode> {
	/** Bounds of a set of nodes (e.g. React Flow's `getNodesBounds`). Default: measured sizes. */
	getNodesBounds?: (nodes: TNode[]) => Rect;
	/** Called after an explosion or collapse finishes (e.g. to persist). */
	onSave?: () => void;
}

/**
 * Replaces nodes in `base` with the same-id node from `updated` (transition frame copies).
 */
function mergeById<TNode extends CanvasNode>(base: TNode[], updated: TNode[]): TNode[] {
	if (updated.length === 0) return [...base];
	const byId = new Map(updated.map((n) => [n.id, n]));
	return base.map((n) => byId.get(n.id) ?? n);
}

/**
 * Imperative explosion coordinator for a React Flow graph held in state (whiteboards, diagrams):
 * adds child nodes and edges, animates them out along a trajectory while surrounding nodes slide
 * aside, and collapses back exactly. The layout math is `computeCanvasExplosionLayout`; several
 * nodes can be exploded at once. The same API as the Svelte `createCanvasExplosion`. For a canvas
 * derived from state (`useMemo`), use `useCanvasExplosionState` and the layout functions instead.
 *
 * `explodeNode` throws when a child id is already on the canvas or repeated.
 */
export function useCanvasExplosion<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(target: CanvasGraphTarget<TNode, TEdge>, hookOptions: UseCanvasExplosionOptions<TNode> = {}) {
	const snapshotsRef = useRef<Map<string, ExplosionSnapshot<TNode, TEdge>>>(new Map());
	const cancelRef = useRef<(() => void) | null>(null);
	const [explodedNodeIds, setExplodedNodeIds] = useState<string[]>([]);
	const optionsRef = useRef(hookOptions);
	optionsRef.current = hookOptions;

	useEffect(() => () => cancelRef.current?.(), []);

	const run = (transitions: NodeTransition<TNode>[], base: TNode[], duration: number, onComplete: () => void) => {
		cancelRef.current?.();
		cancelRef.current = runMultiNodeTransition(transitions, {
			styleFormat: 'object',
			defaultDuration: duration,
			onUpdate: (updated) => target.setNodes(mergeById(base, updated)),
			onComplete: () => {
				cancelRef.current = null;
				onComplete();
			}
		});
	};

	const explodeNode = useCallback(
		(parentNodeId: string, options: ExplodeNodeOptions<TNode, TEdge>): boolean => {
			const { nodes, edges, setNodes, setEdges } = target;
			if (snapshotsRef.current.has(parentNodeId)) return false;
			const parent = nodes.find((n) => n.id === parentNodeId);
			if (!parent || options.childNodes.length === 0) return false;

			const {
				connectParentToChildren = 'all',
				displacementStrategy = 'directional',
				duration = 500,
				staggerDelay = 20,
				easing
			} = options;

			const layout = computeCanvasExplosionLayout<TNode, TEdge>({
				existingNodes: nodes,
				existingEdges: edges,
				originNode: parent,
				childNodes: options.childNodes,
				childEdges: options.childEdges,
				strategy: displacementStrategy,
				options: options.directionalOptions,
				reflowOptions: options.reflowOptions,
				connectParentToChildren,
				createEdge: target.createEdge,
				getNodesBounds: optionsRef.current.getNodesBounds
			});

			snapshotsRef.current.set(parentNodeId, {
				parentId: parentNodeId,
				childNodeIds: layout.childNodes.map((c) => c.id),
				childEdgeIds: layout.childEdges.map((e) => e.id),
				displacedNodes: [...layout.originalPositions].map(([id, originalPosition]) => ({ id, originalPosition })),
				timestamp: Date.now()
			});

			// Children start at the parent and fan out to their layout positions
			const originPos: XYPosition = { ...parent.position };
			const initialChildren = layout.childNodes.map((child) => ({ ...child, position: { ...originPos } }));
			const mergedNodes = [...nodes, ...initialChildren];
			setNodes(mergedNodes);
			if (layout.childEdges.length > 0) setEdges((prev) => [...prev, ...layout.childEdges]);

			const trajectory = options.trajectory ?? createFanOutTrajectory({ curvature: 0.35 });
			const stagger = duration === 0 ? 0 : staggerDelay;
			const transitions: NodeTransition<TNode>[] = [];
			layout.childNodes.forEach((child, index) => {
				transitions.push({
					node: initialChildren[index],
					from: originPos,
					to: child.position,
					trajectory,
					delay: index * stagger,
					index,
					total: layout.childNodes.length,
					duration,
					easing
				});
			});
			layout.displacedPositions.forEach((to, nodeId) => {
				const node = mergedNodes.find((n) => n.id === nodeId);
				if (node) transitions.push({ node, from: { ...node.position }, to, trajectory: linearPositionTrajectory, duration, easing });
			});

			run(transitions, mergedNodes, duration, () => {
				setExplodedNodeIds((prev) => (prev.includes(parentNodeId) ? prev : [...prev, parentNodeId]));
				optionsRef.current.onSave?.();
				options.onComplete?.();
			});
			return true;
		},
		[target]
	);

	const collapseNode = useCallback(
		(parentNodeId: string, options: CollapseNodeOptions = {}): boolean => {
			const { nodes, setNodes, setEdges } = target;
			const snapshot = snapshotsRef.current.get(parentNodeId);
			if (!snapshot) return false;

			const parent = nodes.find((n) => n.id === parentNodeId);
			const originPos: XYPosition = parent ? { ...parent.position } : { x: 0, y: 0 };
			const childIdSet = new Set(snapshot.childNodeIds);
			const edgeIdSet = new Set(snapshot.childEdgeIds);
			const { duration = 400, staggerDelay = 15, easing } = options;
			const trajectory =
				options.trajectory ??
				createFanOutTrajectory({ curvature: 0.2, startScale: 1, endScale: 0, startOpacity: 1, endOpacity: 0 });
			const stagger = duration === 0 ? 0 : staggerDelay;

			const children = nodes.filter((n) => childIdSet.has(n.id));
			const transitions: NodeTransition<TNode>[] = children.map((node, i) => ({
				node,
				from: { ...node.position },
				to: originPos,
				trajectory,
				delay: (children.length - 1 - i) * stagger,
				index: i,
				total: children.length,
				duration,
				easing
			}));
			snapshot.displacedNodes.forEach((disp) => {
				const node = nodes.find((n) => n.id === disp.id);
				if (node) {
					transitions.push({ node, from: { ...node.position }, to: disp.originalPosition, trajectory: linearPositionTrajectory, duration, easing });
				}
			});

			run(transitions, nodes, duration, () => {
				// Remove children and put displaced nodes back exactly
				const restore = new Map(snapshot.displacedNodes.map((d) => [d.id, d.originalPosition]));
				setNodes((prev) =>
					prev
						.filter((n) => !childIdSet.has(n.id))
						.map((n) => (restore.has(n.id) ? { ...n, position: { ...restore.get(n.id)! } } : n))
				);
				setEdges((prev) => prev.filter((e) => !edgeIdSet.has(e.id)));
				snapshotsRef.current.delete(parentNodeId);
				setExplodedNodeIds((prev) => prev.filter((id) => id !== parentNodeId));
				optionsRef.current.onSave?.();
				options.onComplete?.();
			});
			return true;
		},
		[target]
	);

	const toggleExplode = useCallback(
		(parentNodeId: string, explodeOptions: ExplodeNodeOptions<TNode, TEdge>, collapseOptions?: CollapseNodeOptions): boolean =>
			snapshotsRef.current.has(parentNodeId) ? collapseNode(parentNodeId, collapseOptions) : explodeNode(parentNodeId, explodeOptions),
		[explodeNode, collapseNode]
	);

	return {
		/** Ids of nodes whose explosion animation has finished (and not yet collapsed). */
		explodedNodeIds,
		explodeNode,
		collapseNode,
		toggleExplode,
		/** True once the node's explosion has finished, until a collapse finishes. */
		isExploded: (parentNodeId: string) => explodedNodeIds.includes(parentNodeId),
		getSnapshot: (parentNodeId: string) => snapshotsRef.current.get(parentNodeId)
	};
}
