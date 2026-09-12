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
import {
	calculateDirectionalDisplacement,
	calculateReflowDisplacement
} from './createCanvasDisplacement.js';
import {
	createFanOutTrajectory,
	linearPositionTrajectory,
	linearTrajectory,
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
 * Headless Svelte 5 rune managing canvas node explosion, spatial layout displacement,
 * coordinated multi-node animation paths, and reversible collapsing.
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

	function isExploded(nodeId: string): boolean {
		return explodedNodeIds.includes(nodeId);
	}

	function explodeNode(
		parentId: string,
		explodeOptions: ExplodeNodeOptions<TNode, TEdge>
	): boolean {
		if (isExploded(parentId)) {
			return false;
		}

		const parentNode = graph.nodes.find((n) => n.id === parentId);
		if (!parentNode) {
			return false;
		}

		const {
			childNodes,
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

		if (childNodes.length === 0) {
			return false;
		}

		// 1. Calculate displacement for existing nodes
		let displacementMap: Map<string, XYPosition>;
		if (displacementStrategy === 'dagre') {
			displacementMap = calculateReflowDisplacement({
				existingNodes: graph.nodes,
				existingEdges: graph.edges,
				originNode: parentNode,
				childNodes,
				childEdges,
				getNodesBounds: options.getNodesBounds,
				options: {
					...reflowOptions,
					direction: (reflowOptions.direction as any) ?? 'LR'
				}
			});
		} else if (displacementStrategy === 'none') {
			displacementMap = new Map();
		} else {
			displacementMap = calculateDirectionalDisplacement({
				existingNodes: graph.nodes,
				originNode: parentNode,
				childNodes,
				getNodesBounds: options.getNodesBounds,
				options: directionalOptions
			});
		}

		// 2. Build snapshot of displaced nodes before mutating positions
		const displacedNodesSnapshot = Array.from(displacementMap.entries()).map(([id]) => {
			const node = graph.nodes.find((n) => n.id === id);
			return {
				id,
				originalPosition: { ...(node?.position ?? { x: 0, y: 0 }) }
			};
		});

		// 3. Prepare child edges & parent connection edges
		const edgesToAdd: TEdge[] = [...childEdges];
		const defaultCreateEdge = (sourceId: string, targetId: string): TEdge => {
			if (graph.createEdge) {
				return graph.createEdge(sourceId, targetId);
			}
			return {
				id: crypto.randomUUID(),
				type: 'default',
				source: sourceId,
				target: targetId
			} as unknown as TEdge;
		};

		if (connectParentToChildren === 'all' || connectParentToChildren === true) {
			childNodes.forEach((child) => {
				const exists = edgesToAdd.some((e) => e.source === parentId && e.target === child.id);
				if (!exists) {
					edgesToAdd.push(defaultCreateEdge(parentId, child.id));
				}
			});
		} else if (connectParentToChildren === 'first' && childNodes.length > 0) {
			const firstChild = childNodes[0];
			const exists = edgesToAdd.some((e) => e.source === parentId && e.target === firstChild.id);
			if (!exists) {
				edgesToAdd.push(defaultCreateEdge(parentId, firstChild.id));
			}
		}

		const snapshot: ExplosionSnapshot<TNode, TEdge> = {
			parentId,
			childNodeIds: childNodes.map((n) => n.id),
			childEdgeIds: edgesToAdd.map((e) => e.id),
			displacedNodes: displacedNodesSnapshot,
			timestamp: Date.now()
		};
		snapshots.set(parentId, snapshot);

		// 4. Position child nodes initially at origin node coordinate
		const originPos = { ...parentNode.position };
		const targetPositions = childNodes.map((child) => ({ ...child.position }));

		childNodes.forEach((child) => {
			child.position = { ...originPos };
			if (!child.data) child.data = {} as any;
			(child.data as any).scale = 0;
			(child.data as any).opacity = 0;
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
			onUpdate: () => {
				if (edgesToAdd.length > 0) {
					const childIdSet = new Set(childNodes.map((c) => c.id));
					const childEdgesInGraph = graph.edges.filter((e) => childIdSet.has(e.target));
					if (childEdgesInGraph.length > 0) {
						childEdgesInGraph.forEach((edge) => {
							const child = childNodes.find((c) => c.id === edge.target);
							const childOpacity = (child?.data as any)?.opacity ?? 1;
							const currentStyle = (edge.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim();
							edge.style = `${currentStyle ? currentStyle + '; ' : ''}opacity: ${childOpacity};`;
						});
						graph.setEdges(
							graph.edges.map((e) => (childIdSet.has(e.target) ? { ...e } : e))
						);
					}
				}

				graph.setNodes(
					graph.nodes.map((node) => {
						const isTransitioning = transitions.some((t) => t.node.id === node.id);
						return isTransitioning ? { ...node, data: { ...node.data } } : node;
					})
				);
			},
			onComplete: () => {
				childNodes.forEach((child) => {
					const node = graph.nodes.find((n) => n.id === child.id);
					if (node) {
						node.style = (node.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim() || undefined;
						if (node.data) {
							(node.data as any).opacity = 1;
						}
					}
				});
				edgesToAdd.forEach((edge) => {
					const graphEdge = graph.edges.find((e) => e.id === edge.id);
					if (graphEdge) {
						graphEdge.style = (graphEdge.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim() || undefined;
					}
				});
				graph.setNodes(graph.nodes.map((node) => ({ ...node, data: { ...node.data } })));
				graph.setEdges(graph.edges.map((edge) => ({ ...edge })));
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
			onUpdate: () => {
				const edgeIdSet = new Set(snapshot.childEdgeIds);
				const childEdgesInGraph = graph.edges.filter((e) => edgeIdSet.has(e.id));
				if (childEdgesInGraph.length > 0) {
					childEdgesInGraph.forEach((edge) => {
						const child = activeChildNodes.find((c) => c.id === edge.target);
						const childOpacity = (child?.data as any)?.opacity ?? 0;
						const currentStyle = (edge.style || '').replace(/opacity:\s*[^;]+;?/g, '').trim();
						edge.style = `${currentStyle ? currentStyle + '; ' : ''}opacity: ${childOpacity};`;
					});
					graph.setEdges(
						graph.edges.map((e) => (edgeIdSet.has(e.id) ? { ...e } : e))
					);
				}

				graph.setNodes(
					graph.nodes.map((node) => {
						const isTransitioning = transitions.some((t) => t.node.id === node.id);
						return isTransitioning ? { ...node, data: { ...node.data } } : node;
					})
				);
			},
			onComplete: () => {
				// Animation completed: prune child nodes and edges
				graph.removeNodes(activeChildNodes, false);

				const edgeIdSet = new Set(snapshot.childEdgeIds);
				const edgesToRemove = graph.edges.filter((e) => edgeIdSet.has(e.id));
				if (edgesToRemove.length > 0) {
					graph.removeEdges(edgesToRemove, false);
				}

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
		if (isExploded(parentId)) {
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
