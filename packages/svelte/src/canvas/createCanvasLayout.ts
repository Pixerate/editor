import dagre from '@dagrejs/dagre';
import { Position, type XYPosition, type Rect } from '@xyflow/svelte';
import type { CanvasNode, CanvasEdge, CanvasLayoutOptions } from './types.js';

/**
 * Calculates upper-left flow coordinate for an element to be centered in the viewport.
 */
export function getCenteredNodePosition(
	width = 0,
	height = 0,
	screenToFlowPosition: (position: XYPosition) => XYPosition,
	screenDimensions?: { width: number; height: number }
): XYPosition {
	const rect = screenDimensions ?? (typeof document !== 'undefined'
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
	getNodesBounds: (nodes: TNode[]) => Rect,
	options: CanvasLayoutOptions = {}
): TNode[] {
	if (nodes.length === 0) return [];

	const {
		direction = 'LR',
		ranksep = 100,
		nodesep = 25,
		defaultNodeWidth = 200,
		defaultNodeHeight = 200
	} = options;

	const isHorizontal = direction === 'LR' || direction === 'RL';
	const bounds = getNodesBounds(nodes);

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
			targetPosition: isHorizontal ? Position.Left : Position.Top,
			sourcePosition: isHorizontal ? Position.Right : Position.Bottom,
			position: {
				x: bounds.x + (nodeWithPosition?.x ?? 0) - nodeWidth / 2,
				y: bounds.y + (nodeWithPosition?.y ?? 0) - nodeHeight / 2
			}
		};
	});
}
