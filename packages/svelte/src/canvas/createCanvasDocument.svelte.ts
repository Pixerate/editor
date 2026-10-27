import {
	createCanvasEditorDocument,
	type CanvasEdge,
	type CanvasEdgeLike,
	type CanvasEditorDocument,
	type CanvasEditorDocumentOptions,
	type CanvasNode
} from '@pixerate/editor/canvas';
import type { EditorDocument } from '@pixerate/editor/persistence';

export type CreateCanvasDocumentOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> = Omit<
	CanvasEditorDocumentOptions<TNode, TEdge>,
	'subscribe'
>;

const contentKey = (nodes: readonly CanvasNode[], edges: readonly CanvasEdgeLike[]) =>
	JSON.stringify([
		nodes.map(({ selected: _s, dragging: _d, measured: _m, resizing: _r, ...rest }: any) => rest),
		edges.map(({ selected: _s, ...rest }) => rest)
	]);

/**
 * Svelte 5 rune: the save / load / undo contract (kind `canvas`) for nodes and edges held in
 * `$state`, for `createEditorAutosave` or `createDocumentToolProvider`. Reads `getNodes()` /
 * `getEdges()` reactively, so changes the history does not see (a finished drag, an edge
 * removed by Svelte Flow) count too; selection, measuring and drag frames do not. Parity with
 * React's `useCanvasEditorDocument`. Call `destroy()` when done.
 */
export function createCanvasDocument<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CreateCanvasDocumentOptions<TNode, TEdge>
): EditorDocument<CanvasEditorDocument<TNode, TEdge>> {
	const listeners = new Set<() => void>();
	const doc = createCanvasEditorDocument<TNode, TEdge>({
		...options,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	});
	let lastKey: string | null = null;
	const stop = $effect.root(() => {
		$effect(() => {
			const nodes = options.getNodes();
			const edges = options.getEdges();
			if (nodes.some((n) => (n as { dragging?: boolean }).dragging)) return;
			const key = contentKey(nodes, edges);
			if (lastKey !== null && key !== lastKey) listeners.forEach((listener) => listener());
			lastKey = key;
		});
	});
	return {
		...doc,
		destroy() {
			stop();
			doc.destroy();
		}
	};
}
