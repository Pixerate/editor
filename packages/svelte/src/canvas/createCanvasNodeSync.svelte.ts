import { untrack } from 'svelte';
import type { Position } from '@xyflow/svelte';
import type { CanvasNode, CanvasEdge } from './types.js';

export interface HandleConfig {
	id?: string | null;
	type: 'source' | 'target';
	position: Position;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

export interface NodeMeasurement {
	width: number;
	height: number;
}

/**
 * Preserves cached .measured dimensions from existing nodes to newly constructed nodes.
 * Resolves measurements without subscribing to reactive updates on the existing collection.
 */
export function preserveNodeMeasurements<TNode extends CanvasNode = CanvasNode>(
	newNodes: TNode[],
	existingNodes: TNode[] | Map<string, TNode>
): TNode[] {
	const map =
		existingNodes instanceof Map
			? existingNodes
			: new Map(existingNodes.map((n) => [n.id, n]));

	for (const node of newNodes) {
		const prev = map.get(node.id);
		if (prev && (prev as any).measured) {
			(node as any).measured = { ...(prev as any).measured };
		}
	}
	return newNodes;
}

/**
 * Pre-populates handle geometry on a node to prevent @xyflow/system's getNodesInside
 * from evaluating `forceInitialRender = !node.internals.handleBounds` and triggering
 * a false full-canvas selection on the first frame of marquee drag-selection.
 */
export function normalizeNodeHandles<TNode extends CanvasNode = CanvasNode>(
	node: TNode,
	handles: HandleConfig[] = []
): TNode {
	(node as any).handles = handles;
	return node;
}

export interface CreateCanvasNodeSyncOptions<
	TItem,
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	/**
	 * Reactive getter returning raw domain items.
	 */
	items: () => TItem[];
	/**
	 * Factory function converting a domain item into a CanvasNode.
	 */
	toNode: (
		item: TItem,
		index: number,
		context: { existingNode?: TNode; prevNodesMap: Map<string, TNode> }
	) => TNode;
	/**
	 * Optional factory function converting domain items and generated nodes into CanvasEdges.
	 */
	toEdges?: (items: TItem[], nodes: TNode[]) => TEdge[];
	/**
	 * Optional default handle configuration provider for connectable nodes.
	 */
	defaultHandles?: (node: TNode) => HandleConfig[] | undefined;
}

/**
 * Headless Svelte 5 rune that synchronizes reactive domain items with SvelteFlow nodes/edges,
 * automatically untracking previous node reads, caching .measured dimensions, and normalizing
 * handle bounds to prevent Svelte 5 effect_update_depth_exceeded and marquee drag flashes.
 */
export function createCanvasNodeSync<
	TItem,
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: CreateCanvasNodeSyncOptions<TItem, TNode, TEdge>) {
	let nodes = $state<TNode[]>([]);
	let edges = $state<TEdge[]>([]);

	$effect.pre(() => {
		const rawItems = options.items();

		// Untrack the read of current nodes to avoid recursive effect loops
		const existingNodesMap = untrack(() => new Map(nodes.map((n) => [n.id, n])));

		const newNodes = rawItems.map((item, index) => {
			const existing = existingNodesMap.get((item as any)?.id);
			const node = options.toNode(item, index, {
				existingNode: existing,
				prevNodesMap: existingNodesMap
			});

			// Automatically preserve measured dimensions if available
			if (existing && (existing as any).measured && !(node as any).measured) {
				(node as any).measured = { ...(existing as any).measured };
			}

			// Pre-populate handles if provided
			if (options.defaultHandles && !(node as any).handles) {
				const handles = options.defaultHandles(node);
				if (handles) {
					(node as any).handles = handles;
				}
			}

			return node;
		});

		const newEdges = options.toEdges ? options.toEdges(rawItems, newNodes) : [];

		nodes = newNodes;
		edges = newEdges;
	});

	return {
		get nodes() {
			return nodes;
		},
		set nodes(value: TNode[]) {
			nodes = value;
		},
		get edges() {
			return edges;
		},
		set edges(value: TEdge[]) {
			edges = value;
		},
		updateNodeMeasurements(id: string, width: number, height: number) {
			const node = nodes.find((n) => n.id === id);
			if (node) {
				(node as any).measured = { width, height };
			}
		}
	};
}
