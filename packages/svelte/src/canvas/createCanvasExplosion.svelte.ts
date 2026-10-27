import { cubicOut } from 'svelte/easing';
import type { Rect, XYPosition } from '@xyflow/svelte';
import type {
	CanvasEdge,
	CanvasNode,
	CollapseNodeOptions,
	ExplodeNodeOptions,
	ExplosionSnapshot,
	NodeTransition
} from './types.js';
import { computeCanvasExplosionLayout } from '@pixerate/editor/canvas';
import {
	createFanOutTrajectory,
	linearPositionTrajectory,
	runMultiNodeTransition
} from './createCanvasTrajectory.js';

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
 * Imperative explosion coordinator for a mutable graph (whiteboards, diagrams): adds child
 * nodes and edges, animates them out along a trajectory while surrounding nodes slide aside,
 * and collapses back exactly. The layout math is `computeCanvasExplosionLayout` from
 * `@pixerate/editor/canvas`; several nodes can be exploded at once. For a canvas derived from
 * state (`$derived`), use `createCanvasExplosionState` and the layout functions instead.
 *
 * `explodeNode` throws when a child id is already on the canvas or repeated.
 */
export function createCanvasExplosion<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	graph: CanvasGraphTarget<TNode, TEdge>,
	options: CreateCanvasExplosionOptions<TNode> = {}
) {
	let explodedNodeIds = $state<string[]>([]);
	const snapshots = new Map<string, ExplosionSnapshot<TNode, TEdge>>();
	let activeAnimationCancel: (() => void) | null = null;

	/**
	 * Applies one animation frame (node copies emitted by runMultiNodeTransition) onto the
	 * graph's live node objects and publishes the new node array.
	 */
	function syncTransitionFrame(byId: Map<string, TNode>) {
		for (const graphNode of graph.nodes) {
			const frameNode = byId.get(graphNode.id);
			if (!frameNode || frameNode === graphNode) continue;
			graphNode.position = { ...frameNode.position };
			graphNode.style = frameNode.style;
			const frameData = frameNode.data as Record<string, any> | undefined;
			if (frameData && ('scale' in frameData || 'opacity' in frameData)) {
				const data: Record<string, any> = { ...(graphNode.data ?? {}) };
				if ('scale' in frameData) data.scale = frameData.scale;
				if ('opacity' in frameData) data.opacity = frameData.opacity;
				graphNode.data = data as TNode['data'];
			}
		}
		graph.setNodes([...graph.nodes]);
	}

	function isExploded(nodeId: string): boolean {
		return explodedNodeIds.includes(nodeId);
	}

	function explodeNode(
		parentId: string,
		explodeOptions: ExplodeNodeOptions<TNode, TEdge>
	): boolean {
		// Already exploded, or its explosion is still animating
		if (isExploded(parentId) || snapshots.has(parentId)) {
			return false;
		}

		const parentNode = graph.nodes.find((n) => n.id === parentId);
		if (!parentNode) {
			return false;
		}

		const {
			childNodes: requestedChildren,
			childEdges = [],
			connectParentToChildren = 'all',
			displacementStrategy = 'directional',
			directionalOptions = {},
			reflowOptions = {},
			trajectory,
			duration = 500,
			staggerDelay = 20,
			easing = cubicOut,
			onComplete
		} = explodeOptions;

		if (requestedChildren.length === 0) {
			return false;
		}

		// 1-3. Pure layout: displacement of existing nodes, child copies and the edges to add
		// Loose type parameter: SvelteFlow `class` is ClassValue, core `CanvasNode.class` is a string (see GOTCHAS).
		const layout = computeCanvasExplosionLayout<any, TEdge>({
			existingNodes: graph.nodes,
			existingEdges: graph.edges,
			originNode: parentNode,
			childNodes: requestedChildren,
			childEdges,
			strategy: displacementStrategy,
			options: directionalOptions,
			reflowOptions,
			connectParentToChildren,
			createEdge: graph.createEdge ? (source, target) => graph.createEdge!(source, target) : undefined,
			getNodesBounds: options.getNodesBounds as ((nodes: any[]) => Rect) | undefined
		});
		const displacementMap = layout.displacedPositions;
		const childNodes = layout.childNodes as TNode[];
		const edgesToAdd: TEdge[] = layout.childEdges.map((edge) => ({ ...edge }));

		const snapshot: ExplosionSnapshot<TNode, TEdge> = {
			parentId,
			childNodeIds: childNodes.map((n) => n.id),
			childEdgeIds: edgesToAdd.map((e) => e.id),
			displacedNodes: [...layout.originalPositions].map(([id, originalPosition]) => ({ id, originalPosition })),
			timestamp: Date.now()
		};
		snapshots.set(parentId, snapshot);

		// 4. Position child nodes (copies, so the caller's objects stay untouched) at the origin
		const originPos = { ...parentNode.position };
		const targetPositions = childNodes.map((child) => ({ ...child.position }));

		childNodes.forEach((child) => {
			child.position = { ...originPos };
			child.data = { ...(child.data ?? {}), scale: 0, opacity: 0 } as TNode['data'];
			const currentStyle = (child.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim();
			child.style = `${currentStyle ? currentStyle + '; ' : ''}opacity: 0;`;
		});

		edgesToAdd.forEach((edge) => {
			const currentStyle = (edge.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim();
			edge.style = `${currentStyle ? currentStyle + '; ' : ''}opacity: 0;`;
		});

		// Add nodes and edges to graph without saving yet
		graph.addNodeOrNodes(childNodes, undefined, false);
		if (edgesToAdd.length > 0) {
			graph.addEdges(edgesToAdd, false);
		}

		// 5. Build transition list
		const chosenTrajectory = trajectory ?? createFanOutTrajectory({ curvature: 0.35 });
		const transitions: NodeTransition<TNode>[] = [];
		const effectiveStagger = duration === 0 ? 0 : staggerDelay;

		// Expanding child transitions
		childNodes.forEach((child, i) => {
			transitions.push({
				node: child,
				from: originPos,
				to: targetPositions[i],
				trajectory: chosenTrajectory,
				delay: i * effectiveStagger,
				duration,
				easing,
				index: i,
				total: childNodes.length
			});
		});

		// Displaced node transitions
		displacementMap.forEach((targetPos, nodeId) => {
			const node = graph.nodes.find((n) => n.id === nodeId);
			if (node) {
				transitions.push({
					node,
					from: { ...node.position },
					to: targetPos,
					trajectory: linearPositionTrajectory,
					duration,
					easing
				});
			}
		});

		// 6. Run coordinated animation
		if (activeAnimationCancel) {
			activeAnimationCancel();
		}

		activeAnimationCancel = runMultiNodeTransition(transitions, {
			defaultDuration: duration,
			defaultEasing: easing,
			onUpdate: (updated) => {
				// runMultiNodeTransition never mutates inputs; it hands us per-frame copies.
				const byId = new Map(updated.map((n) => [n.id, n]));
				if (edgesToAdd.length > 0) {
					const childIdSet = new Set(childNodes.map((c) => c.id));
					const childEdgesInGraph = graph.edges.filter((e) => childIdSet.has(e.target));
					if (childEdgesInGraph.length > 0) {
						childEdgesInGraph.forEach((edge) => {
							const child = byId.get(edge.target);
							const childOpacity = (child?.data as any)?.opacity ?? 1;
							const currentStyle = (edge.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim();
							edge.style = `${currentStyle ? currentStyle + '; ' : ''}opacity: ${childOpacity};`;
						});
						graph.setEdges([...graph.edges]);
					}
				}

				syncTransitionFrame(byId);
			},
			onComplete: () => {
				childNodes.forEach((child, i) => {
					const node = graph.nodes.find((n) => n.id === child.id);
					if (node) {
						node.position = { ...targetPositions[i] };
						node.style = (node.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim() || undefined;
						if (node.data) {
							(node.data as any).opacity = 1;
						}
					}
				});
				displacementMap.forEach((targetPos, nodeId) => {
					const graphNode = graph.nodes.find((n) => n.id === nodeId);
					if (graphNode) {
						graphNode.position = { ...targetPos };
					}
				});
				edgesToAdd.forEach((edge) => {
					const graphEdge = graph.edges.find((e) => e.id === edge.id);
					if (graphEdge) {
						graphEdge.style = (graphEdge.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim() || undefined;
					}
				});
				graph.setNodes([...graph.nodes]);
				graph.setEdges([...graph.edges]);
				explodedNodeIds = [...explodedNodeIds, parentId];
				activeAnimationCancel = null;
				options.onSave?.();
				graph.onSave?.();
				onComplete?.();
			}
		});

		return true;
	}

	function collapseNode(
		parentId: string,
		collapseOptions: CollapseNodeOptions = {}
	): boolean {
		const snapshot = snapshots.get(parentId);
		if (!snapshot) {
			return false;
		}

		const parentNode = graph.nodes.find((n) => n.id === parentId);
		if (!parentNode) {
			return false;
		}

		const {
			duration = 400,
			staggerDelay = 15,
			easing = cubicOut,
			trajectory,
			onComplete
		} = collapseOptions;

		const childIdSet = new Set(snapshot.childNodeIds);
		const activeChildNodes = graph.nodes.filter((n) => childIdSet.has(n.id));
		const originPos = { ...parentNode.position };

		// Reverse trajectory pulls nodes back toward parent while collapsing scale
		const reverseTrajectory = trajectory ?? createFanOutTrajectory({
			curvature: 0.2,
			startScale: 1,
			endScale: 0,
			startOpacity: 1,
			endOpacity: 0
		});

		const transitions: NodeTransition<TNode>[] = [];
		const effectiveStagger = duration === 0 ? 0 : staggerDelay;

		// Collapsing child transitions back into origin
		activeChildNodes.forEach((child, i) => {
			transitions.push({
				node: child,
				from: { ...child.position },
				to: originPos,
				trajectory: reverseTrajectory,
				delay: (activeChildNodes.length - 1 - i) * effectiveStagger,
				duration,
				easing,
				index: i,
				total: activeChildNodes.length
			});
		});

		// Displaced node restore transitions
		snapshot.displacedNodes.forEach(({ id, originalPosition }) => {
			const node = graph.nodes.find((n) => n.id === id);
			if (node) {
				transitions.push({
					node,
					from: { ...node.position },
					to: originalPosition,
					trajectory: linearPositionTrajectory,
					duration,
					easing
				});
			}
		});

		if (activeAnimationCancel) {
			activeAnimationCancel();
		}

		activeAnimationCancel = runMultiNodeTransition(transitions, {
			defaultDuration: duration,
			defaultEasing: easing,
			onUpdate: (updated) => {
				// runMultiNodeTransition never mutates inputs; it hands us per-frame copies.
				const byId = new Map(updated.map((n) => [n.id, n]));
				const edgeIdSet = new Set(snapshot.childEdgeIds);
				const childEdgesInGraph = graph.edges.filter((e) => edgeIdSet.has(e.id));
				if (childEdgesInGraph.length > 0) {
					childEdgesInGraph.forEach((edge) => {
						const child = byId.get(edge.target);
						const childOpacity = (child?.data as any)?.opacity ?? 0;
						const currentStyle = (edge.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim();
						edge.style = `${currentStyle ? currentStyle + '; ' : ''}opacity: ${childOpacity};`;
					});
					graph.setEdges([...graph.edges]);
				}

				syncTransitionFrame(byId);
			},
			onComplete: () => {
				// Animation completed: prune child nodes and edges
				graph.removeNodes(activeChildNodes, false);

				const edgeIdSet = new Set(snapshot.childEdgeIds);
				const edgesToRemove = graph.edges.filter((e) => edgeIdSet.has(e.id));
				if (edgesToRemove.length > 0) {
					graph.removeEdges(edgesToRemove, false);
				}

				snapshot.displacedNodes.forEach(({ id, originalPosition }) => {
					const graphNode = graph.nodes.find((n) => n.id === id);
					if (graphNode) {
						graphNode.position = { ...originalPosition };
					}
				});
				graph.setNodes([...graph.nodes]);

				snapshots.delete(parentId);
				explodedNodeIds = explodedNodeIds.filter((id) => id !== parentId);
				activeAnimationCancel = null;

				options.onSave?.();
				graph.onSave?.();
				onComplete?.();
			}
		});

		return true;
	}

	function toggleExplode(
		parentId: string,
		explodeOptions: ExplodeNodeOptions<TNode, TEdge>,
		collapseOptions?: CollapseNodeOptions
	): boolean {
		if (snapshots.has(parentId)) {
			return collapseNode(parentId, collapseOptions);
		}
		return explodeNode(parentId, explodeOptions);
	}

	function getSnapshot(parentId: string) {
		return snapshots.get(parentId);
	}

	return {
		get explodedNodeIds() {
			return explodedNodeIds;
		},
		isExploded,
		explodeNode,
		collapseNode,
		toggleExplode,
		getSnapshot
	};
}
