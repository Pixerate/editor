import { useEffect, useMemo, useRef } from 'react';
import {
	createCanvasEditorDocument,
	type CanvasEdge,
	type CanvasEdgeLike,
	type CanvasEditorDocument,
	type CanvasEditorDocumentOptions,
	type CanvasNode
} from '@pixerate/editor/canvas';
import type { EditorDocument } from '@pixerate/editor/persistence';

export interface UseCanvasEditorDocumentOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>
	extends Pick<CanvasEditorDocumentOptions<TNode, TEdge>, 'history' | 'scenes' | 'readOnly'> {
	nodes: TNode[];
	edges: TEdge[];
	setNodes: (nodes: TNode[]) => void;
	setEdges: (edges: TEdge[]) => void;
}

const contentKey = (nodes: readonly CanvasNode[], edges: readonly CanvasEdgeLike[]) =>
	JSON.stringify([
		nodes.map(({ selected: _s, dragging: _d, measured: _m, resizing: _r, ...rest }: any) => rest),
		edges.map(({ selected: _s, ...rest }) => rest)
	]);

/**
 * The save / load / undo contract (kind `canvas`) for nodes and edges held in React state, for
 * `useEditorAutosave` or `createDocumentToolProvider`. Besides the history, it counts changes
 * the history does not see (a finished drag, an edge removed by React Flow), but not selection
 * or measuring, and not the frames of a drag in progress. Pass a stable `history` and `scenes`.
 */
export function useCanvasEditorDocument<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: UseCanvasEditorDocumentOptions<TNode, TEdge>
): EditorDocument<CanvasEditorDocument<TNode, TEdge>> {
	const latest = useRef(options);
	latest.current = options;
	const listeners = useRef(new Set<() => void>());
	const doc = useMemo(
		() =>
			createCanvasEditorDocument<TNode, TEdge>({
				getNodes: () => latest.current.nodes,
				setNodes: (nodes) => latest.current.setNodes(nodes),
				getEdges: () => latest.current.edges,
				setEdges: (edges) => latest.current.setEdges(edges),
				history: options.history,
				scenes: options.scenes,
				readOnly: () => latest.current.readOnly?.() ?? false,
				subscribe: (listener) => {
					listeners.current.add(listener);
					return () => listeners.current.delete(listener);
				}
			}),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[options.history, options.scenes]
	);
	// Subscribing again reconnects it, so a StrictMode remount keeps working.
	useEffect(() => () => doc.destroy(), [doc]);

	const lastKey = useRef<string | null>(null);
	useEffect(() => {
		if (options.nodes.some((n) => (n as { dragging?: boolean }).dragging)) return;
		const key = contentKey(options.nodes, options.edges);
		if (lastKey.current !== null && key !== lastKey.current) listeners.current.forEach((listener) => listener());
		lastKey.current = key;
	}, [options.nodes, options.edges]);
	return doc;
}
