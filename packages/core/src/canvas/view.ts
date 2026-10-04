import type { CanvasEdge, CanvasNode, Rect } from './types.js';

export interface CanvasHeightOptions {
	/** Smallest height returned (default 320). */
	min?: number;
	/** Largest height returned; taller content is scaled/zoomed (default 560). */
	max?: number;
	/** Extra padding around the content (default 48). */
	padding?: number;
}

function clampHeight(contentHeight: number, options: CanvasHeightOptions = {}): number {
	const { min = 320, max = 560, padding = 48 } = options;
	return Math.round(Math.min(max, Math.max(min, contentHeight + padding)));
}

/**
 * Calculates the bounding box extent of all positioned nodes, or `null` for an empty graph.
 */
export function layoutBounds<TNode extends CanvasNode = CanvasNode>(
	nodes: TNode[]
): Rect | null {
	if (nodes.length === 0) return null;

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const node of nodes) {
		const x = node.position.x;
		const y = node.position.y;
		const width = node.width ?? 180;
		const height = node.height ?? 80;

		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x + width);
		maxY = Math.max(maxY, y + height);
	}

	if (minX === Infinity) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Returns a clamped container height that fits the layout at 1:1 scale without overflow.
 */
export function canvasHeight<TNode extends CanvasNode = CanvasNode>(
	nodes: TNode[],
	options?: CanvasHeightOptions
): number {
	return clampHeight(layoutBounds(nodes)?.height ?? 0, options);
}

const DEFAULT_RANK_HEIGHT = 80 + 72; // Average node height + default rank separation
const NODES_PER_RANK = 2;

/**
 * Estimates the container height to reserve before layout calculation finishes,
 * based on node and edge counts alone. Prevents layout shift (CLS).
 */
export function estimateCanvasHeight<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	nodes: TNode[],
	edges: TEdge[],
	options?: CanvasHeightOptions
): number {
	const ranks = Math.max(1, Math.ceil(nodes.length / NODES_PER_RANK));
	return clampHeight(ranks * DEFAULT_RANK_HEIGHT, options);
}

function mix(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/**
 * Interpolates node positions and sizes between two layouts partway at progress `t` (0 = from, 1 = to).
 * Nodes present in both interpolate smoothly; nodes newly added in `to` snap to target.
 */
export function blendLayout<TNode extends CanvasNode = CanvasNode>(
	from: TNode[],
	to: TNode[],
	t: number
): TNode[] {
	if (t >= 1) return to;

	const fromMap = new Map<string, TNode>(from.map((n) => [n.id, n]));

	return to.map((target) => {
		const origin = fromMap.get(target.id);
		if (!origin) return target;

		return {
			...target,
			position: {
				x: mix(origin.position.x, target.position.x, t),
				y: mix(origin.position.y, target.position.y, t)
			},
			width:
				origin.width !== undefined && target.width !== undefined
					? mix(origin.width, target.width, t)
					: target.width,
			height:
				origin.height !== undefined && target.height !== undefined
					? mix(origin.height, target.height, t)
					: target.height
		};
	});
}

/**
 * Filters out nodes that are not touched by any edge.
 *
 * During LLM streaming, nodes often arrive a chunk or token before the edge
 * that connects them. Displaying them immediately causes them to be placed as root
 * nodes only to jump into their correct position once the edge arrives.
 * Hiding orphan nodes during active streaming keeps the layout calm and jitter-free.
 */
export function connectedOnly<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	nodes: TNode[],
	edges: TEdge[]
): TNode[] {
	if (edges.length === 0) return nodes;

	const linkedNodeIds = new Set<string>();
	for (const edge of edges) {
		linkedNodeIds.add(edge.source);
		linkedNodeIds.add(edge.target);
	}

	const filtered = nodes.filter((node) => linkedNodeIds.has(node.id));
	// If filtering would remove everything, return the original nodes
	return filtered.length > 0 ? filtered : nodes;
}
