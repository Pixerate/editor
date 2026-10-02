import { useCallback } from 'react';
import {
	centerNodes,
	ensureLayout,
	getCenteredNodePosition,
	getLayoutedNodes,
	placeBeside,
	type CanvasEdge,
	type CanvasLayoutOptions,
	type CanvasNode,
	type IncrementalLayoutOptions,
	type PlaceBesideOptions,
	type Rect,
	type Side,
	type XYPosition
} from '@pixerate/editor/canvas';

export interface UseCanvasLayoutOptions<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	nodes: TNode[];
	edges: TEdge[];
	setNodes: (updater: TNode[] | ((prev: TNode[]) => TNode[])) => void;
	getNodesBounds?: (nodes: TNode[]) => Rect;
	screenToFlowPosition?: (position: XYPosition) => XYPosition;
}

/**
 * React hook providing layout automation: Dagre hierarchy, incremental layout blending,
 * collision-aware directional placement, and viewport centering.
 */
export function useCanvasLayout<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: UseCanvasLayoutOptions<TNode, TEdge>) {
	const { nodes, edges, setNodes, getNodesBounds, screenToFlowPosition } = options;

	/**
	 * Runs standard hierarchical Dagre layout across all nodes and edges.
	 */
	const applyLayout = useCallback(
		(layoutOptions: CanvasLayoutOptions = {}) => {
			const layouted = getLayoutedNodes(nodes, edges, getNodesBounds, layoutOptions);
			setNodes(layouted);
			return layouted;
		},
		[nodes, edges, getNodesBounds, setNodes]
	);

	/**
	 * Incremental layout blending:
	 * Preserves manual positions of established nodes and positions new/unplaced nodes
	 * relative to the Dagre layout using mean centroid translation.
	 */
	const applyIncrementalLayout = useCallback(
		(incrementalOptions: IncrementalLayoutOptions = {}) => {
			const storedPositions =
				incrementalOptions.storedPositions ??
				Object.fromEntries(nodes.map((n) => [n.id, n.position]));

			const blended = ensureLayout(nodes, edges, {
				...incrementalOptions,
				storedPositions
			});
			setNodes(blended);
			return blended;
		},
		[nodes, edges, setNodes]
	);

	/**
	 * Centers the collective bounding box of nodes within the viewport.
	 */
	const center = useCallback(
		(screenDimensions?: { width: number; height: number }) => {
			if (!screenToFlowPosition || !getNodesBounds) {
				console.warn(
					'[useCanvasLayout] Centering requires screenToFlowPosition and getNodesBounds options.'
				);
				return;
			}
			const centered = centerNodes(nodes, screenToFlowPosition, getNodesBounds, screenDimensions);
			setNodes(centered);
		},
		[nodes, screenToFlowPosition, getNodesBounds, setNodes]
	);

	/**
	 * Finds a collision-free position for a new node adjacent to an existing anchor node.
	 */
	const getPlacementPosition = useCallback(
		(
			size: { width: number; height: number },
			side: Side = 'right',
			nearNodeId?: string,
			placementOptions: PlaceBesideOptions = {}
		): XYPosition => {
			const rects: Record<string, Rect> = {};
			for (const node of nodes) {
				const width = node.measured?.width ?? (node as any).width ?? 200;
				const height = node.measured?.height ?? (node as any).height ?? 60;
				rects[node.id] = {
					x: node.position.x,
					y: node.position.y,
					width,
					height
				};
			}
			return placeBeside(rects, size, side, nearNodeId, placementOptions);
		},
		[nodes]
	);

	return {
		applyLayout,
		applyIncrementalLayout,
		center,
		getPlacementPosition,
		getCenteredNodePosition
	};
}
