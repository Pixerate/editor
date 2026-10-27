import dagre from '@dagrejs/dagre';
import type {
	CanvasEdge,
	CanvasLayoutOptions,
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

/** A node's size: measured, then explicit, then the defaults. */
export function nodeSizeOf<TNode extends CanvasNode = CanvasNode>(
	node: TNode,
	defaultWidth = 200,
	defaultHeight = 60
): { width: number; height: number } {
	return {
		width: node.measured?.width ?? node.width ?? defaultWidth,
		height: node.measured?.height ?? node.height ?? defaultHeight
	};
}

/**
 * Pure directional displacement calculation.
 *
 * Shifts surrounding nodes along an axis to clear space for a cluster of child nodes inserted
 * next to `originNode`, and returns the new positions of the nodes that move (nothing is mutated).
 *
 * - `right` / `left` push nodes on that side by the cluster's width plus `gap`; Y is preserved
 *   (except for `spreadSiblingLanes` with `right`).
 * - `up` / `down` push nodes on that side by the cluster's height plus `gap`; X is preserved.
 * - `vertical` opens the origin's row: nodes above move up and nodes below move down by the same
 *   amount (the larger of the two clearances); X is preserved and the origin's row stays put.
 * - `layoutMode: 'row-lane'` buckets nodes into lanes `rowSpacing` apart and rounds vertical
 *   deltas up to whole lanes.
 * - `minY` / `maxY` keep moved rows inside a band, stacking clamped rows `rowSpacing` apart.
 *
 * @throws RangeError when `gap`, `rowSpacing`, `minY` or `maxY` are not finite, `rowSpacing <= 0`,
 *   or `minY > maxY`.
 */
export function calculateDirectionalDisplacement<TNode extends CanvasNode = CanvasNode>(params: {
	existingNodes: TNode[];
	originNode: TNode;
	childNodes: TNode[];
	getNodesBounds?: (nodes: TNode[]) => Rect;
	options?: DirectionalDisplacementOptions;
}): Map<string, XYPosition> {
	const { existingNodes, originNode, childNodes, getNodesBounds, options = {} } = params;

	const {
		direction = 'right',
		gap = 40,
		spreadSiblingLanes = false,
		siblingTolerance = 50,
		minY,
		maxY,
		layoutMode = 'freeform',
		rowSpacing
	} = options;

	const finite = (name: string, value: number | undefined) => {
		if (value !== undefined && !Number.isFinite(value)) {
			throw new RangeError(`${name} must be a finite number (got ${value}).`);
		}
	};
	finite('gap', gap);
	finite('minY', minY);
	finite('maxY', maxY);
	finite('rowSpacing', rowSpacing);
	if (rowSpacing !== undefined && rowSpacing <= 0) {
		throw new RangeError(`rowSpacing must be greater than 0 (got ${rowSpacing}).`);
	}
	if (minY !== undefined && maxY !== undefined && minY > maxY) {
		throw new RangeError(`minY (${minY}) must not be greater than maxY (${maxY}).`);
	}

	const displacedMap = new Map<string, XYPosition>();
	if (childNodes.length === 0 || existingNodes.length === 0) {
		return displacedMap;
	}

	const childBounds = getNodesBounds ? getNodesBounds(childNodes) : computeNodesBoundingBox(childNodes);
	const { width: originWidth, height: originHeight } = nodeSizeOf(originNode);

	const rowLane = layoutMode === 'row-lane';
	const lane = rowSpacing ?? originHeight;
	/** Row-lane mode rounds a vertical delta up to whole lanes. */
	const quantize = (delta: number) => (rowLane && delta > 0 && lane > 0 ? Math.ceil(delta / lane) * lane : delta);
	/** Lane index relative to the origin's row: negative above, 0 the origin's own row, positive below. */
	const laneOf = (node: TNode) => (lane > 0 ? Math.round((node.position.y - originNode.position.y) / lane) : 0);
	const isAbove = (node: TNode) => (rowLane ? laneOf(node) < 0 : node.position.y < originNode.position.y);
	const isBelow = (node: TNode) =>
		rowLane ? laneOf(node) > 0 : node.position.y >= originNode.position.y + originHeight * 0.5;

	const horizontal = direction === 'right' || direction === 'left';
	// The delta space required along the primary axis
	const deltaPrimary = horizontal ? childBounds.width + gap : quantize(childBounds.height + gap);

	// Vertical displacement: upward and downward clearance of the cluster around the origin row
	const deltaUp = Math.max(0, originNode.position.y - childBounds.y + gap);
	const deltaDown = Math.max(0, childBounds.y + childBounds.height - (originNode.position.y + originHeight) + gap);
	// Both above and below displace equally so the row expands symmetrically
	const equalDelta = quantize(Math.max(deltaUp, deltaDown));

	for (const node of existingNodes) {
		if (node.id === originNode.id) continue;

		let newX = node.position.x;
		let newY = node.position.y;

		if (direction === 'right') {
			// Downstream nodes to the right of the origin's centre
			if (node.position.x >= originNode.position.x + originWidth * 0.5) {
				newX += deltaPrimary;
			} else if (spreadSiblingLanes) {
				// Nodes in the origin's column that overlap the exploded cluster vertically
				const { height } = nodeSizeOf(node);
				const overlapsCluster =
					node.position.y + height >= childBounds.y - gap &&
					node.position.y <= childBounds.y + childBounds.height + gap;
				if (overlapsCluster && Math.abs(node.position.x - originNode.position.x) <= siblingTolerance) {
					const push = node.position.y >= originNode.position.y ? 1 : -1;
					newY += push * (childBounds.height * 0.5 + gap);
				}
			}
		} else if (direction === 'left') {
			if (node.position.x < originNode.position.x) newX -= deltaPrimary;
		} else if (direction === 'down') {
			if (isBelow(node)) newY += deltaPrimary;
		} else if (direction === 'up') {
			if (isAbove(node)) newY -= deltaPrimary;
		} else if (direction === 'vertical') {
			// X is strictly preserved; the origin's own row stays put
			if (isAbove(node)) newY -= equalDelta;
			else if (isBelow(node)) newY += equalDelta;
		}

		if (newX !== node.position.x || newY !== node.position.y) {
			displacedMap.set(node.id, { x: newX, y: newY });
		}
	}

	if (minY !== undefined || maxY !== undefined) {
		const byId = new Map(existingNodes.map((n) => [n.id, n]));
		/** Groups moved nodes into rows (by lane in row-lane mode, else by their original y), top first. */
		const rowsOf = (moved: TNode[]) => {
			const rows = new Map<number, TNode[]>();
			for (const node of moved) {
				const key = rowLane ? laneOf(node) : node.position.y;
				rows.set(key, [...(rows.get(key) ?? []), node]);
			}
			return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, nodes]) => nodes);
		};
		const spacingFor = (nodes: TNode[]) => rowSpacing ?? Math.max(...nodes.map((n) => nodeSizeOf(n).height));
		const moved = (sign: 1 | -1) =>
			[...displacedMap.entries()]
				.filter(([id, pos]) => Math.sign(pos.y - byId.get(id)!.position.y) === sign)
				.map(([id]) => byId.get(id)!);

		if (minY !== undefined) {
			const up = moved(-1);
			if (up.length > 0) {
				const spacing = spacingFor(up);
				rowsOf(up).forEach((row, index) => {
					const floor = minY + index * spacing;
					for (const node of row) {
						const pos = displacedMap.get(node.id)!;
						// Clamp to the floor, but never move a node below where it started
						displacedMap.set(node.id, { x: pos.x, y: Math.min(node.position.y, Math.max(floor, pos.y)) });
					}
				});
			}
		}

		if (maxY !== undefined) {
			const down = moved(1);
			if (down.length > 0) {
				const spacing = spacingFor(down);
				rowsOf(down)
					.reverse()
					.forEach((row, index) => {
						for (const node of row) {
							const pos = displacedMap.get(node.id)!;
							const ceiling = maxY - index * spacing - nodeSizeOf(node).height;
							// Clamp to the ceiling, but never move a node above where it started
							displacedMap.set(node.id, { x: pos.x, y: Math.max(node.position.y, Math.min(ceiling, pos.y)) });
						}
					});
			}
		}

		// Rows clamped back to where they started did not move after all
		for (const [id, pos] of [...displacedMap.entries()]) {
			const node = byId.get(id)!;
			if (pos.x === node.position.x && pos.y === node.position.y) displacedMap.delete(id);
		}
	}

	return displacedMap;
}

/**
 * Hierarchical Dagre reflow displacement for an explosion: lays out the existing graph plus the
 * child cluster, anchoring the origin node at its current position so the layout does not jump,
 * and returns the new positions of existing nodes that move.
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
	options?: CanvasLayoutOptions;
}): Map<string, XYPosition> {
	const { existingNodes, existingEdges, originNode, childNodes, childEdges = [], options = {} } = params;
	const { direction = 'LR', ranksep = 80, nodesep = 30, defaultNodeWidth = 200, defaultNodeHeight = 60 } = options;

	const displacedMap = new Map<string, XYPosition>();
	if (existingNodes.length === 0) return displacedMap;

	const allNodes = [...existingNodes, ...childNodes];
	const allEdges = [...existingEdges, ...childEdges];

	const g = new dagre.graphlib.Graph();
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({ rankdir: direction, ranksep, nodesep });

	const allNodeIds = new Set(allNodes.map((n) => n.id));
	for (const node of allNodes) {
		g.setNode(node.id, nodeSizeOf(node, defaultNodeWidth, defaultNodeHeight));
	}
	for (const edge of allEdges) {
		if (allNodeIds.has(edge.source) && allNodeIds.has(edge.target)) g.setEdge(edge.source, edge.target);
	}

	dagre.layout(g);

	const dagreOrigin = g.node(originNode.id);
	if (!dagreOrigin) return displacedMap;

	const origin = nodeSizeOf(originNode, defaultNodeWidth, defaultNodeHeight);
	// Offset so the origin node stays anchored at its exact initial coordinates
	const anchorOffsetX = originNode.position.x - (dagreOrigin.x - origin.width / 2);
	const anchorOffsetY = originNode.position.y - (dagreOrigin.y - origin.height / 2);

	for (const node of existingNodes) {
		if (node.id === originNode.id) continue;
		const laidOut = g.node(node.id);
		if (!laidOut) continue;
		const { width, height } = nodeSizeOf(node, defaultNodeWidth, defaultNodeHeight);
		const targetX = laidOut.x - width / 2 + anchorOffsetX;
		const targetY = laidOut.y - height / 2 + anchorOffsetY;
		if (Math.abs(targetX - node.position.x) > 0.5 || Math.abs(targetY - node.position.y) > 0.5) {
			displacedMap.set(node.id, { x: targetX, y: targetY });
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
