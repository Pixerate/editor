import { useCallback, useRef } from 'react';
import {
	calculateDirectionalDisplacement,
	createFanOutTrajectory,
	linearPositionTrajectory,
	runMultiNodeTransition,
	type CanvasEdge,
	type CanvasNode,
	type CollapseNodeOptions,
	type ExplodeNodeOptions,
	type ExplosionSnapshot,
	type NodeTransition,
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
}

/**
 * React hook managing node explosion and collapse transitions with exact reversibility.
 */
export function useCanvasExplosion<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(target: CanvasGraphTarget<TNode, TEdge>) {
	const snapshotsRef = useRef<Map<string, ExplosionSnapshot<TNode, TEdge>>>(new Map());

	const explodeNode = useCallback(
		(parentNodeId: string, options: ExplodeNodeOptions<TNode, TEdge>) => {
			const { nodes, edges, setNodes, setEdges } = target;
			const parent = nodes.find((n) => n.id === parentNodeId);
			if (!parent || options.childNodes.length === 0) return;

			const originPos: XYPosition = { ...parent.position };
			const displacedMap =
				options.displacementStrategy === 'directional'
					? calculateDirectionalDisplacement({
							existingNodes: nodes,
							originNode: parent,
							childNodes: options.childNodes,
							options: options.directionalOptions
						})
					: new Map<string, XYPosition>();

			// Snapshot state for exact collapse
			const snapshot: ExplosionSnapshot<TNode, TEdge> = {
				parentId: parentNodeId,
				childNodeIds: options.childNodes.map((c) => c.id),
				childEdgeIds: (options.childEdges ?? []).map((e) => e.id),
				displacedNodes: Array.from(displacedMap.entries()).map(([id]) => {
					const node = nodes.find((n) => n.id === id)!;
					return { id, originalPosition: { ...node.position } };
				}),
				timestamp: Date.now()
			};
			snapshotsRef.current.set(parentNodeId, snapshot);

			// Position child nodes initially at parent position for animation
			const initialChildren = options.childNodes.map((child) => ({
				...child,
				position: { ...originPos }
			}));

			const mergedNodes = [...nodes, ...initialChildren];
			setNodes(mergedNodes);

			if (options.childEdges && options.childEdges.length > 0) {
				setEdges((prev) => [...prev, ...(options.childEdges as TEdge[])]);
			}

			// Animate child nodes outward & displaced existing nodes
			const trajectory = options.trajectory ?? createFanOutTrajectory();
			const transitions: NodeTransition<TNode>[] = [];

			// 1. Child nodes fan out
			options.childNodes.forEach((child, index) => {
				const liveChild = mergedNodes.find((n) => n.id === child.id);
				if (liveChild) {
					transitions.push({
						node: liveChild,
						from: originPos,
						to: child.position,
						trajectory,
						index,
						total: options.childNodes.length,
						duration: options.duration ?? 400,
						easing: options.easing
					});
				}
			});

			// 2. Displaced sibling nodes slide
			displacedMap.forEach((targetPos, nodeId) => {
				const node = mergedNodes.find((n) => n.id === nodeId);
				if (node) {
					transitions.push({
						node,
						from: { ...node.position },
						to: targetPos,
						trajectory: linearPositionTrajectory,
						duration: options.duration ?? 400,
						easing: options.easing
					});
				}
			});

			runMultiNodeTransition(transitions, {
				onUpdate: () => setNodes([...mergedNodes]),
				onComplete: options.onComplete
			});
		},
		[target]
	);

	const collapseNode = useCallback(
		(parentNodeId: string, options: CollapseNodeOptions = {}) => {
			const { nodes, setNodes, setEdges } = target;
			const snapshot = snapshotsRef.current.get(parentNodeId);
			if (!snapshot) return;

			const parent = nodes.find((n) => n.id === parentNodeId);
			const originPos: XYPosition = parent ? { ...parent.position } : { x: 0, y: 0 };

			const childIdSet = new Set(snapshot.childNodeIds);
			const edgeIdSet = new Set(snapshot.childEdgeIds);

			const transitions: NodeTransition<TNode>[] = [];

			// 1. Children animate back into parent
			nodes.forEach((node) => {
				if (childIdSet.has(node.id)) {
					transitions.push({
						node,
						from: { ...node.position },
						to: originPos,
						duration: options.duration ?? 300,
						easing: options.easing,
						trajectory: options.trajectory
					});
				}
			});

			// 2. Displaced nodes animate back to original positions
			snapshot.displacedNodes.forEach((disp) => {
				const node = nodes.find((n) => n.id === disp.id);
				if (node) {
					transitions.push({
						node,
						from: { ...node.position },
						to: disp.originalPosition,
						duration: options.duration ?? 300,
						easing: options.easing,
						trajectory: linearPositionTrajectory
					});
				}
			});

			runMultiNodeTransition(transitions, {
				onUpdate: () => setNodes([...nodes]),
				onComplete: () => {
					// Clean up child nodes and edges
					setNodes((prev) => prev.filter((n) => !childIdSet.has(n.id)));
					setEdges((prev) => prev.filter((e) => !edgeIdSet.has(e.id)));
					snapshotsRef.current.delete(parentNodeId);
					options.onComplete?.();
				}
			});
		},
		[target]
	);

	return {
		explodeNode,
		collapseNode,
		isExploded: (parentNodeId: string) => snapshotsRef.current.has(parentNodeId),
		getSnapshot: (parentNodeId: string) => snapshotsRef.current.get(parentNodeId)
	};
}
