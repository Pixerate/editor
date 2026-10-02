import dagre from '@dagrejs/dagre';
import type {
	CanvasEdge,
	CanvasLayoutOptions,
	CanvasNode,
	IncrementalLayoutOptions,
	PlaceBesideOptions,
	Rect,
	Side,
	XYPosition
} from './types.js';

export const DEFAULT_NODE_WIDTH = 200;
export const DEFAULT_NODE_HEIGHT = 60;
export const DEFAULT_PLACEMENT_GAP = 48;

/**
 * Calculates upper-left flow coordinate for an element to be centered in the viewport.
 */
export function getCenteredNodePosition(
	width = 0,
	height = 0,
	screenToFlowPosition: (position: XYPosition) => XYPosition,
	screenDimensions?: { width: number; height: number }
): XYPosition {
	const rect =
		screenDimensions ??
		(typeof document !== 'undefined'
			? { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
			: { width: 1920, height: 1080 });

	const flowPos = screenToFlowPosition({ x: rect.width / 2, y: rect.height / 2 });
	return {
		x: flowPos.x - width / 2,
		y: flowPos.y - height / 2
	};
}

/**
 * Updates positions of nodes so their collective bounding box is centered in the current viewport.
 */
export function centerNodes<TNode extends CanvasNode = CanvasNode>(
	nodes: TNode[],
	screenToFlowPosition: (position: XYPosition) => XYPosition,
	getNodesBounds: (nodes: TNode[]) => Rect,
	screenDimensions?: { width: number; height: number }
): TNode[] {
	if (nodes.length === 0) {
		return [];
	}

	const bounds = getNodesBounds(nodes);
	const boundingBoxOrigin = { x: bounds.x, y: bounds.y };

	const centeredPosition = getCenteredNodePosition(
		bounds.width,
		bounds.height,
		screenToFlowPosition,
		screenDimensions
	);

	const deltaX = centeredPosition.x - boundingBoxOrigin.x;
	const deltaY = centeredPosition.y - boundingBoxOrigin.y;

	return nodes.map((node) => ({
		...node,
		position: {
			x: node.position.x + deltaX,
			y: node.position.y + deltaY
		}
	}));
}

/**
 * Automatically calculates directed hierarchical layout of nodes and edges using Dagre.
 */
export function getLayoutedNodes<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	nodes: TNode[],
	edges: TEdge[],
	getNodesBounds?: (nodes: TNode[]) => Rect,
	options: CanvasLayoutOptions = {}
): TNode[] {
	if (nodes.length === 0) return [];

	const {
		direction = 'LR',
		ranksep = 100,
		nodesep = 25,
		defaultNodeWidth = DEFAULT_NODE_WIDTH,
		defaultNodeHeight = DEFAULT_NODE_HEIGHT
	} = options;

	const dagreGraph = new dagre.graphlib.Graph();
	dagreGraph.setDefaultEdgeLabel(() => ({}));
	dagreGraph.setGraph({ rankdir: direction, ranksep, nodesep });

	const nodeIds = new Set(nodes.map((node) => node.id));

	nodes.forEach((node) => {
		const nodeWidth = node.measured?.width ?? (node as any).width ?? defaultNodeWidth;
		const nodeHeight = node.measured?.height ?? (node as any).height ?? defaultNodeHeight;
		dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
	});

	edges.forEach((edge) => {
		if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
			dagreGraph.setEdge(edge.source, edge.target);
		}
	});

	dagre.layout(dagreGraph);

	return nodes.map((node) => {
		const nodeWithPosition = dagreGraph.node(node.id);
		const nodeWidth = node.measured?.width ?? (node as any).width ?? defaultNodeWidth;
		const nodeHeight = node.measured?.height ?? (node as any).height ?? defaultNodeHeight;

		return {
			...node,
			position: {
				x: nodeWithPosition.x - nodeWidth / 2,
				y: nodeWithPosition.y - nodeHeight / 2
			}
		};
	});
}

/**
 * Heuristic text-based node size estimator when DOM measurement is not available.
 */
export function estimateNodeSize(
	node: CanvasNode,
	defaultWidth = DEFAULT_NODE_WIDTH,
	defaultHeight = DEFAULT_NODE_HEIGHT
): { width: number; height: number } {
	const label = String(node.data?.label ?? node.data?.title ?? node.id ?? '');
	const lines = label.split(/\n|<br\s*\/?>/);
	const longest = Math.max(...lines.map((l) => l.replace(/<[^>]+>/g, '').length), 1);
	const width = Math.min(480, Math.max(defaultWidth, longest * 8 + 48));
	const height = Math.max(defaultHeight, lines.length * 20 + 24);
	return { width, height };
}

/**
 * Computes bounding rectangle of an array of rectangles.
 */
export function boundsOf(rects: Rect[]): Rect | null {
	if (!rects.length) return null;
	const minX = Math.min(...rects.map((r) => r.x));
	const minY = Math.min(...rects.map((r) => r.y));
	const maxX = Math.max(...rects.map((r) => r.x + r.width));
	const maxY = Math.max(...rects.map((r) => r.y + r.height));
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Center coordinate of a rectangle.
 */
export function centre(r: Rect): XYPosition {
	return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * Determines whether two rectangles overlap, including an optional padding distance.
 */
export function overlaps(a: Rect, b: Rect, pad = 16): boolean {
	return (
		a.x < b.x + b.width + pad &&
		a.x + a.width + pad > b.x &&
		a.y < b.y + b.height + pad &&
		a.y + a.height + pad > b.y
	);
}

/**
 * Maps directed layout flow to its natural forward growth side.
 */
export function flowSide(direction: 'LR' | 'TB' | 'RL' | 'BT' = 'LR'): Side {
	switch (direction) {
		case 'LR':
			return 'right';
		case 'RL':
			return 'left';
		case 'BT':
			return 'above';
		case 'TB':
		default:
			return 'below';
	}
}

/**
 * Incremental layout blending:
 * Keeps established/manual node positions intact. Runs Dagre on the entire graph,
 * computes the centroid translation offset between auto and stored positions of existing nodes,
 * and places unpositioned/new nodes at (auto + offset).
 */
export function ensureLayout<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(
	nodes: TNode[],
	edges: TEdge[],
	options: IncrementalLayoutOptions = {}
): TNode[] {
	if (nodes.length === 0) return [];

	const stored = options.storedPositions ?? {};
	const missing = nodes.filter((n) => !stored[n.id]);

	// Case 1: Every node has an established coordinate -> preserve verbatim
	if (missing.length === 0) {
		return nodes.map((n) => ({
			...n,
			position: { ...stored[n.id]! }
		}));
	}

	// Calculate full dagre auto-layout
	const autoLayouted = getLayoutedNodes(nodes, edges, undefined, options);
	const autoMap = new Map<string, XYPosition>(
		autoLayouted.map((n) => [n.id, n.position])
	);

	// Case 2: No nodes have stored coordinates -> return auto layout directly
	const both = nodes.filter((n) => stored[n.id] && autoMap.has(n.id));
	if (both.length === 0) {
		return autoLayouted;
	}

	// Case 3: Blend! Align on centroid translation offset of overlapping nodes
	let dx = 0;
	let dy = 0;
	for (const n of both) {
		const s = stored[n.id]!;
		const a = autoMap.get(n.id)!;
		dx += s.x - a.x;
		dy += s.y - a.y;
	}
	dx /= both.length;
	dy /= both.length;

	return nodes.map((node) => {
		if (stored[node.id]) {
			return {
				...node,
				position: { ...stored[node.id]! }
			};
		}
		const autoPos = autoMap.get(node.id) ?? { x: 0, y: 0 };
		return {
			...node,
			position: {
				x: Math.round(autoPos.x + dx),
				y: Math.round(autoPos.y + dy)
			}
		};
	});
}

/**
 * Finds a free top-left coordinate for a node of `size` adjacent to `nearNodeId` (or the cluster),
 * sliding along the perpendicular axis past any intersecting bounding boxes to guarantee non-overlapping placement.
 */
export function placeBeside(
	rects: Record<string, Rect>,
	size: { width: number; height: number },
	side: Side,
	nearNodeId?: string,
	options: PlaceBesideOptions = {}
): XYPosition {
	const {
		gap = DEFAULT_PLACEMENT_GAP,
		ignore = [],
		maxAttempts = 32
	} = options;

	const skip = new Set([nearNodeId, ...ignore].filter(Boolean));
	const obstacles = Object.entries(rects)
		.filter(([id]) => !skip.has(id))
		.map(([, r]) => r);

	const anchor =
		(nearNodeId && rects[nearNodeId]) ||
		boundsOf(Object.values(rects)) ||
		{ x: 0, y: 0, width: 0, height: 0 };

	const anchorCenter = centre(anchor);

	let baseX: number;
	let baseY: number;

	switch (side) {
		case 'right':
			baseX = anchor.x + anchor.width + gap;
			baseY = anchorCenter.y - size.height / 2;
			break;
		case 'left':
			baseX = anchor.x - gap - size.width;
			baseY = anchorCenter.y - size.height / 2;
			break;
		case 'above':
			baseX = anchorCenter.x - size.width / 2;
			baseY = anchor.y - gap - size.height;
			break;
		case 'below':
		default:
			baseX = anchorCenter.x - size.width / 2;
			baseY = anchor.y + anchor.height + gap;
			break;
	}

	// Slide perpendicular to growth direction, alternating positive and negative steps (+1, -1, +2, -2...)
	const isHorizontal = side === 'right' || side === 'left';
	const step = (isHorizontal ? size.height : size.width) + 20;

	for (let i = 0; i < maxAttempts; i++) {
		const offset = i === 0 ? 0 : Math.ceil(i / 2) * step * (i % 2 === 1 ? 1 : -1);
		const candidateBox: Rect = {
			x: isHorizontal ? baseX : baseX + offset,
			y: isHorizontal ? baseY + offset : baseY,
			width: size.width,
			height: size.height
		};

		if (!obstacles.some((obstacle) => overlaps(candidateBox, obstacle, 8))) {
			return {
				x: Math.round(candidateBox.x),
				y: Math.round(candidateBox.y)
			};
		}
	}

	return {
		x: Math.round(baseX),
		y: Math.round(baseY)
	};
}
