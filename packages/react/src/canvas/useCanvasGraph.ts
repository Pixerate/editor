import { useState, useCallback, useRef } from 'react';
import type { CanvasNode, CanvasEdge, GraphDifferences } from '@pixerate/editor/canvas';

export interface UseCanvasGraphOptions<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
> {
	initialNodes?: TNode[];
	initialEdges?: TEdge[];
	onNodesChange?: (nodes: TNode[]) => void;
	onEdgesChange?: (edges: TEdge[]) => void;
}

/**
 * React hook managing canvas graph state (nodes, edges, selection, and structural differences).
 */
export function useCanvasGraph<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdge = CanvasEdge
>(options: UseCanvasGraphOptions<TNode, TEdge> = {}) {
	const [nodes, setNodesState] = useState<TNode[]>(options.initialNodes ?? []);
	const [edges, setEdgesState] = useState<TEdge[]>(options.initialEdges ?? []);

	const baselineNodesRef = useRef<TNode[]>(options.initialNodes ?? []);
	const baselineEdgesRef = useRef<TEdge[]>(options.initialEdges ?? []);

	const setNodes = useCallback(
		(updater: TNode[] | ((prev: TNode[]) => TNode[])) => {
			setNodesState((prev) => {
				const next = typeof updater === 'function' ? updater(prev) : updater;
				options.onNodesChange?.(next);
				return next;
			});
		},
		[options.onNodesChange]
	);

	const setEdges = useCallback(
		(updater: TEdge[] | ((prev: TEdge[]) => TEdge[])) => {
			setEdgesState((prev) => {
				const next = typeof updater === 'function' ? updater(prev) : updater;
				options.onEdgesChange?.(next);
				return next;
			});
		},
		[options.onEdgesChange]
	);

	const addNode = useCallback(
		(node: TNode) => {
			setNodes((prev) => [...prev, node]);
		},
		[setNodes]
	);

	const removeNodes = useCallback(
		(ids: string[]) => {
			const idSet = new Set(ids);
			setNodes((prev) => prev.filter((n) => !idSet.has(n.id)));
			setEdges((prev) => prev.filter((e) => !idSet.has(e.source) && !idSet.has(e.target)));
		},
		[setNodes, setEdges]
	);

	const updateNodeData = useCallback(
		(id: string, patch: Partial<TNode['data']>) => {
			setNodes((prev) =>
				prev.map((node) => {
					if (node.id !== id) return node;
					return {
						...node,
						data: { ...node.data, ...patch }
					};
				})
			);
		},
		[setNodes]
	);

	const updateNodePosition = useCallback(
		(id: string, position: { x: number; y: number }) => {
			setNodes((prev) =>
				prev.map((node) => {
					if (node.id !== id) return node;
					return {
						...node,
						position: { ...position }
					};
				})
			);
		},
		[setNodes]
	);

	const addEdge = useCallback(
		(edge: TEdge) => {
			setEdges((prev) => [...prev, edge]);
		},
		[setEdges]
	);

	const removeEdges = useCallback(
		(ids: string[]) => {
			const idSet = new Set(ids);
			setEdges((prev) => prev.filter((e) => !idSet.has(e.id)));
		},
		[setEdges]
	);

	const resetBaseline = useCallback(() => {
		baselineNodesRef.current = nodes;
		baselineEdgesRef.current = edges;
	}, [nodes, edges]);

	const getDifferences = useCallback((): GraphDifferences<TNode, TEdge> => {
		const currentNodesMap = new Map(nodes.map((n) => [n.id, n]));
		const currentEdgesMap = new Map(edges.map((e) => [e.id, e]));
		const baselineNodesMap = new Map(baselineNodesRef.current.map((n) => [n.id, n]));
		const baselineEdgesMap = new Map(baselineEdgesRef.current.map((e) => [e.id, e]));

		const changedNodes: TNode[] = [];
		const removedNodes: TNode[] = [];
		const changedEdges: TEdge[] = [];
		const removedEdges: TEdge[] = [];

		for (const [id, node] of currentNodesMap) {
			const base = baselineNodesMap.get(id);
			if (!base || base.position.x !== node.position.x || base.position.y !== node.position.y) {
				changedNodes.push(node);
			}
		}

		for (const [id, node] of baselineNodesMap) {
			if (!currentNodesMap.has(id)) {
				removedNodes.push(node);
			}
		}

		for (const [id, edge] of currentEdgesMap) {
			const base = baselineEdgesMap.get(id);
			if (!base || base.source !== edge.source || base.target !== edge.target) {
				changedEdges.push(edge);
			}
		}

		for (const [id, edge] of baselineEdgesMap) {
			if (!currentEdgesMap.has(id)) {
				removedEdges.push(edge);
			}
		}

		return { changedNodes, changedEdges, removedNodes, removedEdges };
	}, [nodes, edges]);

	return {
		nodes,
		edges,
		setNodes,
		setEdges,
		addNode,
		removeNodes,
		updateNodeData,
		updateNodePosition,
		addEdge,
		removeEdges,
		resetBaseline,
		getDifferences
	};
}
