import dagre from '@dagrejs/dagre';
import type { Rect, XYPosition } from '@xyflow/svelte';
import type {
	CanvasEdge,
	CanvasLayoutOptions,
	CanvasNode,
	DirectionalDisplacementOptions
} from './types.js';

/**
 * Calculates a bounding rectangle for a set of nodes if not provided by getNodesBounds.
 */
export function computeNodesBoundingBox<TNode extends CanvasNode = CanvasNode>(
	nodes: TNode[],
	defaultWidth = 200,
	defaultHeight = 60
): Rect {
	if (nodes.length === 0) {
		return { x: 0, y: 0, width: 0, height: 0 };
	}

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	for (const node of nodes) {
		const width = node.measured?.width ?? (node as any).width ?? defaultWidth;
		const height = node.measured?.height ?? (node as any).height ?? defaultHeight;

		minX = Math.min(minX, node.position.x);
		minY = Math.min(minY, node.position.y);
		maxX = Math.max(maxX, node.position.x + width);
		maxY = Math.max(maxY, node.position.y + height);
	}

	return {
		x: minX,
		y: minY,
		width: maxX - minX,
		height: maxY - minY
	};
}

/**
 * Pure directional displacement calculation.
 * Shifts downstream or surrounding nodes along an axis to clear space for newly inserted child nodes.
 */
export function calculateDirectionalDisplacement<TNode extends CanvasNode = CanvasNode>(params: {
	existingNodes: TNode[];
	originNode: TNode;
	childNodes: TNode[];
	getNodesBounds?: (nodes: TNode[]) => Rect;
	options?: DirectionalDisplacementOptions;
}): Map<string, XYPosition> {
	const {
		existingNodes,
		originNode,
		childNodes,
		getNodesBounds,
		options = {}
	} = params;

	const {
		direction = 'right',
		gap = 40,
		spreadSiblingLanes = false,
		siblingTolerance = 50,
		minY
	} = options;

	const displacedMap = new Map<string, XYPosition>();
	if (childNodes.length === 0 || existingNodes.length === 0) {
		return displacedMap;
	}

	const childBounds = getNodesBounds
		? getNodesBounds(childNodes)
		: computeNodesBoundingBox(childNodes);

	const originWidth = originNode.measured?.width ?? (originNode as any).width ?? 200;
	const originHeight = originNode.measured?.height ?? (originNode as any).height ?? 60;

	// The delta space required along primary axis
	const deltaPrimary = (direction === 'right' || direction === 'left')
		? childBounds.width + gap
		: childBounds.height + gap;

	// Vertical displacement parameters: upward and downward row clearance
	const deltaUp = Math.max(0, originNode.position.y - childBounds.y + gap);
	const deltaDown = Math.max(
		0,
		childBounds.y + childBounds.height - (originNode.position.y + originHeight) + gap
	);

	// Both above and below displace equally so the row expands symmetrically
	const equalDelta = Math.max(deltaUp, deltaDown);

	for (const node of existingNodes) {
		if (node.id === originNode.id) continue;

		let newX = node.position.x;
		let newY = node.position.y;
		let moved = false;

		if (direction === 'right') {
			// Downstream nodes strictly to the right of the origin
			if (node.position.x >= originNode.position.x + originWidth * 0.5) {
				newX += deltaPrimary;
				moved = true;
			} else if (spreadSiblingLanes) {
				// Sibling nodes occupying the same vertical space as the exploded cluster
				const isVerticallyOverlapping =
					node.position.y + ((node as any).height ?? 60) >= childBounds.y - gap &&
					node.position.y <= childBounds.y + childBounds.height + gap;

				if (isVerticallyOverlapping && Math.abs(node.position.x - originNode.position.x) <= siblingTolerance) {
					const pushDirection = node.position.y >= originNode.position.y ? 1 : -1;
					newY += pushDirection * (childBounds.height * 0.5 + gap);
					moved = true;
				}
			}
		} else if (direction === 'left') {
			if (node.position.x <= originNode.position.x) {
				newX -= deltaPrimary;
				moved = true;
			}
		} else if (direction === 'down') {
			if (node.position.y >= originNode.position.y + originHeight * 0.5) {
				newY += deltaPrimary;
				moved = true;
			}
		} else if (direction === 'up') {
			if (node.position.y <= originNode.position.y) {
				newY -= deltaPrimary;
				moved = true;
			}
		} else if (direction === 'vertical') {
			// Row grows vertically:
			// Nodes strictly above the origin node move up by equalDelta
			// Nodes strictly below the origin node move down by equalDelta
			// Both above and below displace equally; horizontal position (x) is strictly preserved
			if (node.position.y < originNode.position.y) {
				if (equalDelta > 0) {
					newY -= equalDelta;
					moved = true;
				}
			} else if (node.position.y >= originNode.position.y + originHeight * 0.5) {
				if (equalDelta > 0) {
					newY += equalDelta;
					moved = true;
				}
			}
		}

		if (moved) {
			displacedMap.set(node.id, { x: newX, y: newY });
		}
	}

	return displacedMap;
}

/**
 * Pure hierarchical Dagre reflow displacement calculation.
 * Calculates new coordinates for surrounding nodes using Dagre hierarchical layout,
 * anchoring the origin node at its current position to eliminate layout jumping.
 */
export function calculateReflowDisplacement<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(params: {
	existingNodes: TNode[];
	existingEdges: TEdge[];
	originNode: TNode;
	childNodes: TNode[];
	childEdges?: TEdge[];
	getNodesBounds?: (nodes: TNode[]) => Rect;
	options?: CanvasLayoutOptions;
}): Map<string, XYPosition> {
	const {
		existingNodes,
		existingEdges,
		originNode,
		childNodes,
		childEdges = [],
		options = {}
	} = params;

	const {
		direction = 'LR',
		ranksep = 80,
		nodesep = 30,
		defaultNodeWidth = 200,
		defaultNodeHeight = 60
	} = options;

	const displacedMap = new Map<string, XYPosition>();
	if (existingNodes.length === 0) return displacedMap;

	const allNodes = [...existingNodes, ...childNodes];
	const allEdges = [...existingEdges, ...childEdges];

	const dagreGraph = new dagre.graphlib.Graph();
	dagreGraph.setDefaultEdgeLabel(() => ({}));
	dagreGraph.setGraph({ rankdir: direction, ranksep, nodesep });

	const allNodeIds = new Set(allNodes.map((n) => n.id));

	allNodes.forEach((node) => {
		const nodeWidth = node.measured?.width ?? (node as any).width ?? defaultNodeWidth;
		const nodeHeight = node.measured?.height ?? (node as any).height ?? defaultNodeHeight;
		dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
	});

	allEdges.forEach((edge) => {
		if (allNodeIds.has(edge.source) && allNodeIds.has(edge.target)) {
			dagreGraph.setEdge(edge.source, edge.target);
		}
	});

	dagre.layout(dagreGraph);

	const dagreOrigin = dagreGraph.node(originNode.id);
	if (!dagreOrigin) return displacedMap;

	const originWidth = originNode.measured?.width ?? (originNode as any).width ?? defaultNodeWidth;
	const originHeight = originNode.measured?.height ?? (originNode as any).height ?? defaultNodeHeight;

	// Calculate offset so origin node remains anchored at its exact initial coordinates
	const anchorOffsetX = originNode.position.x - (dagreOrigin.x - originWidth / 2);
	const anchorOffsetY = originNode.position.y - (dagreOrigin.y - originHeight / 2);

	existingNodes.forEach((node) => {
		if (node.id === originNode.id) return;

		const dagreNode = dagreGraph.node(node.id);
		if (!dagreNode) return;

		const nodeWidth = node.measured?.width ?? (node as any).width ?? defaultNodeWidth;
		const nodeHeight = node.measured?.height ?? (node as any).height ?? defaultNodeHeight;

		const targetX = dagreNode.x - nodeWidth / 2 + anchorOffsetX;
		const targetY = dagreNode.y - nodeHeight / 2 + anchorOffsetY;

		// Only include if position actually shifted
		if (Math.abs(targetX - node.position.x) > 0.5 || Math.abs(targetY - node.position.y) > 0.5) {
			displacedMap.set(node.id, { x: targetX, y: targetY });
		}
	});

	return displacedMap;
}
