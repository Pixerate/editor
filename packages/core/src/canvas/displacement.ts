import dagre from '@dagrejs/dagre';
import type {
	CanvasEdge,
	CanvasNode,
	DirectionalDisplacementOptions,
	Rect,
	ReflowDisplacementOptions,
	XYPosition
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
	const deltaPrimary =
		direction === 'right' || direction === 'left'
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

		const isSiblingRow =
			Math.abs(node.position.y - originNode.position.y) < siblingTolerance;

		switch (direction) {
			case 'right': {
				if (node.position.x > originNode.position.x) {
					displacedMap.set(node.id, {
						x: node.position.x + deltaPrimary,
						y: node.position.y
					});
				}
				break;
			}
			case 'left': {
				if (node.position.x < originNode.position.x) {
					displacedMap.set(node.id, {
						x: node.position.x - deltaPrimary,
						y: node.position.y
					});
				}
				break;
			}
			case 'down': {
				if (node.position.y > originNode.position.y) {
					displacedMap.set(node.id, {
						x: node.position.x,
						y: node.position.y + deltaPrimary
					});
				}
				break;
			}
			case 'up': {
				if (node.position.y < originNode.position.y) {
					displacedMap.set(node.id, {
						x: node.position.x,
						y: node.position.y - deltaPrimary
					});
				}
				break;
			}
			case 'vertical': {
				if (isSiblingRow) break;

				if (node.position.y < originNode.position.y) {
					displacedMap.set(node.id, {
						x: node.position.x,
						y: node.position.y - equalDelta
					});
				} else if (node.position.y > originNode.position.y) {
					displacedMap.set(node.id, {
						x: node.position.x,
						y: node.position.y + equalDelta
					});
				}
				break;
			}
		}
	}

	// Sibling lane spreading to avoid overlap among child nodes
	if (spreadSiblingLanes && (direction === 'right' || direction === 'left')) {
		for (const [nodeId, pos] of displacedMap.entries()) {
			const node = existingNodes.find((n) => n.id === nodeId);
			if (node && Math.abs(node.position.y - originNode.position.y) < siblingTolerance) {
				const isAbove = node.position.y < originNode.position.y;
				displacedMap.set(nodeId, {
					x: pos.x,
					y: pos.y + (isAbove ? -deltaUp : deltaDown)
				});
			}
		}
	}

	// Floor constraint
	if (minY !== undefined) {
		for (const [nodeId, pos] of displacedMap.entries()) {
			if (pos.y < minY) {
				displacedMap.set(nodeId, { x: pos.x, y: minY });
			}
		}
	}

	return displacedMap;
}

/**
 * Calculates Dagre reflow displacement preserving the position of an anchor node.
 */
export function calculateDagreReflowDisplacement<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(params: {
	currentNodes: TNode[];
	currentEdges: TEdge[];
	futureNodes: TNode[];
	futureEdges: TEdge[];
	options: ReflowDisplacementOptions;
	getNodesBounds?: (nodes: TNode[]) => Rect;
}): Map<string, XYPosition> {
	const {
		currentNodes,
		futureNodes,
		futureEdges,
		options
	} = params;

	const {
		anchorNodeId,
		direction = 'LR',
		ranksep = 100,
		nodesep = 25,
		defaultNodeWidth = 200,
		defaultNodeHeight = 60
	} = options;

	const anchorNode = currentNodes.find((n) => n.id === anchorNodeId);
	if (!anchorNode) return new Map();

	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: direction, ranksep, nodesep });

	const nodeIds = new Set(futureNodes.map((n) => n.id));

	futureNodes.forEach((node) => {
		const nodeWidth = node.measured?.width ?? (node as any).width ?? defaultNodeWidth;
		const nodeHeight = node.measured?.height ?? (node as any).height ?? defaultNodeHeight;
		g.setNode(node.id, { width: nodeWidth, height: nodeHeight });
	});

	futureEdges.forEach((edge) => {
		if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
			g.setEdge(edge.source, edge.target);
		}
	});

	dagre.layout(g);

	const anchorLayoutPos = g.node(anchorNodeId);
	if (!anchorLayoutPos) return new Map();

	const anchorWidth = anchorNode.measured?.width ?? (anchorNode as any).width ?? defaultNodeWidth;
	const anchorHeight = anchorNode.measured?.height ?? (anchorNode as any).height ?? defaultNodeHeight;

	const anchorLayoutUpperLeft = {
		x: anchorLayoutPos.x - anchorWidth / 2,
		y: anchorLayoutPos.y - anchorHeight / 2
	};

	const deltaX = anchorNode.position.x - anchorLayoutUpperLeft.x;
	const deltaY = anchorNode.position.y - anchorLayoutUpperLeft.y;

	const displacementMap = new Map<string, XYPosition>();

	currentNodes.forEach((node) => {
		if (node.id === anchorNodeId) return;

		const layoutNode = g.node(node.id);
		if (!layoutNode) return;

		const nodeWidth = node.measured?.width ?? (node as any).width ?? defaultNodeWidth;
		const nodeHeight = node.measured?.height ?? (node as any).height ?? defaultNodeHeight;

		const upperLeftX = layoutNode.x - nodeWidth / 2 + deltaX;
		const upperLeftY = layoutNode.y - nodeHeight / 2 + deltaY;

		if (
			Math.abs(upperLeftX - node.position.x) > 1 ||
			Math.abs(upperLeftY - node.position.y) > 1
		) {
			displacementMap.set(node.id, { x: upperLeftX, y: upperLeftY });
		}
	});

	return displacementMap;
}
