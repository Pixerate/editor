import { getConnectedEdges, type XYPosition } from '@xyflow/svelte';
import { cubicOut } from 'svelte/easing';
import type { CanvasNode, CanvasEdge, GraphDifferences } from './types.js';

/**
 * Pure calculation of graph differences between a current state and a baseline state.
 */
export function calculateGraphDifferences<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	currentState: { nodes?: TNode[]; edges?: TEdge[] },
	baselineState: { nodes?: TNode[]; edges?: TEdge[] }
): GraphDifferences<TNode, TEdge> {
	const currentNodes = currentState.nodes ?? [];
	const currentEdges = currentState.edges ?? [];
	const baselineNodes = baselineState.nodes ?? [];
	const baselineEdges = baselineState.edges ?? [];

	// Map baseline for fast O(1) lookup
	const baselineNodeMap = new Map(baselineNodes.map((n) => [n.id, n]));
	const baselineEdgeMap = new Map(baselineEdges.map((e) => [e.id, e]));
	const currentNodeMap = new Map(currentNodes.map((n) => [n.id, n]));
	const currentEdgeMap = new Map(currentEdges.map((e) => [e.id, e]));

	const removedNodes = baselineNodes.filter((oldNode) => !currentNodeMap.has(oldNode.id));
	const removedEdges = baselineEdges.filter((oldEdge) => !currentEdgeMap.has(oldEdge.id));

	const changedNodes = currentNodes.filter((newNode) => {
		const oldNode = baselineNodeMap.get(newNode.id);
		if (!oldNode) return true;
		return JSON.stringify(newNode) !== JSON.stringify(oldNode);
	});

	const changedEdges = currentEdges.filter((newEdge) => {
		const oldEdge = baselineEdgeMap.get(newEdge.id);
		if (!oldEdge) return true;
		return JSON.stringify(newEdge) !== JSON.stringify(oldEdge);
	});

	return { changedNodes, changedEdges, removedNodes, removedEdges };
}

/**
 * Pure function to replace a node in a graph, optionally preserving its connected edges.
 */
export function replaceNodeInGraph<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	nodes: TNode[],
	edges: TEdge[],
	oldNode: TNode,
	newNode: TNode,
	keepEdges = false
): { nodes: TNode[]; edges: TEdge[] } {
	const updatedNodes = nodes.map((n) => (n.id === oldNode.id ? newNode : n));

	if (!keepEdges) {
		return { nodes: updatedNodes, edges };
	}

	const updatedEdges = edges.map((edge) => {
		if (edge.source === oldNode.id || edge.target === oldNode.id) {
			return {
				...edge,
				id: crypto.randomUUID(),
				source: edge.source === oldNode.id ? newNode.id : edge.source,
				target: edge.target === oldNode.id ? newNode.id : edge.target
			};
		}
		return edge;
	});

	return {
		nodes: updatedNodes,
		edges: updatedEdges
	};
}

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
export function createCanvasGraph<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: CreateCanvasGraphOptions<TNode, TEdge> = {}) {
	let nodes = $state.raw<TNode[]>(options.initialNodes ?? []);
	let edges = $state.raw<TEdge[]>(options.initialEdges ?? []);

	function setNodes(newNodes: TNode[], triggerCallback = true) {
		nodes = newNodes;
		if (triggerCallback) {
			options.onNodesChange?.(nodes);
		}
	}

	function setEdges(newEdges: TEdge[], triggerCallback = true) {
		edges = newEdges;
		if (triggerCallback) {
			options.onEdgesChange?.(edges);
		}
	}

	function animateNodePosition(
		node: TNode,
		targetPosition: XYPosition,
		duration = 400,
		easing: (t: number) => number = cubicOut
	) {
		const delay = (node.data as any)?.animationDelay ?? 0;
		const startPosition = { ...node.position };
		const startTime = Date.now() + delay;

		function step() {
			const currentTime = Date.now();
			if (currentTime < startTime) {
				if (typeof requestAnimationFrame !== 'undefined') {
					requestAnimationFrame(step);
				}
				return;
			}

			const progress = Math.min((currentTime - startTime) / duration, 1);
			const eased = easing(progress);

			const currentPos = {
				x: startPosition.x + (targetPosition.x - startPosition.x) * eased,
				y: startPosition.y + (targetPosition.y - startPosition.y) * eased
			};

			// Mutate position in place without recreating the entire array every frame
			const targetNode = nodes.find((n) => n.id === node.id);
			if (targetNode) {
				targetNode.position = currentPos;
			}

			if (progress < 1) {
				if (typeof requestAnimationFrame !== 'undefined') {
					requestAnimationFrame(step);
				}
			} else {
				// Animation completed: trigger final reactive update and change event
				setNodes([...nodes]);
			}
		}

		step();
	}

	function addNodeOrNodes(
		nodeOrNodesToAdd: TNode | TNode[],
		animateFromPosition?: XYPosition,
		save = true
	): void {
		const toAdd = Array.isArray(nodeOrNodesToAdd) ? nodeOrNodesToAdd : [nodeOrNodesToAdd];
		const existingMap = new Map(nodes.map((n) => [n.id, n]));

		toAdd.forEach((node) => {
			if (!existingMap.has(node.id)) {
				existingMap.set(node.id, node);
			}
		});

		setNodes(Array.from(existingMap.values()));

		if (animateFromPosition) {
			toAdd.forEach((node) => {
				const target = { ...node.position };
				node.position = { ...animateFromPosition };
				animateNodePosition(node, target);
			});
		}

		if (save) options.onSave?.();
	}

	function addEdge(edgeToAdd: TEdge, save = true): void {
		setEdges([...edges, edgeToAdd]);
		if (save) options.onSave?.();
	}

	function addEdges(edgesToAdd: TEdge[], save = true): void {
		setEdges([...edges, ...edgesToAdd]);
		if (save) options.onSave?.();
	}

	function removeNodes(nodesToRemove: TNode[], save = true): void {
		const idsToRemove = new Set(nodesToRemove.map((n) => n.id));
		setNodes(nodes.filter((n) => !idsToRemove.has(n.id)));
		if (save) options.onSave?.();
	}

	function removeEdges(edgesToRemove: TEdge[], save = true): void {
		const idsToRemove = new Set(edgesToRemove.map((e) => e.id));
		setEdges(edges.filter((e) => !idsToRemove.has(e.id)));
		if (save) options.onSave?.();
	}

	function replaceNode(
		oldNode: TNode,
		newNode: TNode,
		save = true,
		keepEdges = false
	): void {
		const result = replaceNodeInGraph(nodes, edges, oldNode, newNode, keepEdges);
		setNodes(result.nodes);
		if (result.edges !== edges) {
			setEdges(result.edges);
		}
		if (save) options.onSave?.();
	}

	function addConnectedNodes(params: {
		nodesToAdd: TNode[];
		inboundNodes?: TNode[];
		outboundNodes?: TNode[];
		animatedEdges?: boolean;
		animateFromPosition?: XYPosition;
		inboundEdgeData?: any;
		outboundEdgeData?: any;
		getEdgeLabel?: (source: TNode, target: TNode) => string;
	}): void {
		const {
			nodesToAdd,
			inboundNodes = [],
			outboundNodes = [],
			animatedEdges = false,
			animateFromPosition,
			inboundEdgeData = {},
			outboundEdgeData = {},
			getEdgeLabel
		} = params;

		const defaultCreateEdge = (
			sourceId: string,
			targetId: string,
			opt?: { label?: string; animated?: boolean; data?: any }
		): TEdge => {
			if (options.createEdge) {
				return options.createEdge(sourceId, targetId, opt);
			}
			return {
				id: crypto.randomUUID(),
				type: 'default',
				source: sourceId,
				target: targetId,
				label: opt?.label ?? '',
				animated: opt?.animated ?? false,
				data: opt?.data ?? {}
			} as unknown as TEdge;
		};

		nodesToAdd.forEach((addedNode) => {
			addNodeOrNodes(addedNode, animateFromPosition, false);

			inboundNodes.forEach((sourceNode) => {
				const label = getEdgeLabel ? getEdgeLabel(sourceNode, addedNode) : '';
				addEdge(
					defaultCreateEdge(sourceNode.id, addedNode.id, {
						label,
						animated: animatedEdges,
						data: inboundEdgeData
					}),
					false
				);
			});

			outboundNodes.forEach((targetNode) => {
				const label = getEdgeLabel ? getEdgeLabel(addedNode, targetNode) : '';
				addEdge(
					defaultCreateEdge(addedNode.id, targetNode.id, {
						label,
						animated: animatedEdges,
						data: outboundEdgeData
					}),
					false
				);
			});
		});

		options.onSave?.();
	}

	function getDifferences(baseline: { nodes?: TNode[]; edges?: TEdge[] }) {
		return calculateGraphDifferences({ nodes, edges }, baseline);
	}

	return {
		get nodes() {
			return nodes;
		},
		set nodes(val: TNode[]) {
			setNodes(val);
		},
		get edges() {
			return edges;
		},
		set edges(val: TEdge[]) {
			setEdges(val);
		},
		setNodes,
		setEdges,
		addNodeOrNodes,
		addEdge,
		addEdges,
		removeNodes,
		removeEdges,
		replaceNode,
		addConnectedNodes,
		animateNodePosition,
		getDifferences
	};
}
