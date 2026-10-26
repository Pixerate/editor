import type { HistoryManager } from '../history/HistoryManager.js';
import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import { isValidCanvasEdge, isValidCanvasNode } from './clipboard.js';
import type { CanvasScene, CanvasScenesStore } from './scenes.js';
import type { CanvasEdge, CanvasNode } from './types.js';

/** What the document needs of an edge (React Flow's and Svelte Flow's edges fit). */
export type CanvasEdgeLike = Pick<CanvasEdge, 'id' | 'source' | 'target'> & { selected?: boolean };

/** A canvas as it is saved: its nodes, edges and (with a scenes store) scenes. */
export interface CanvasEditorDocument<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	nodes: TNode[];
	edges: TEdge[];
	scenes?: CanvasScene[];
}

export interface CanvasEditorDocumentOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	getEdges: () => TEdge[];
	setEdges: (edges: TEdge[]) => void;
	/** The canvas's undo history, shared with its arrange, draw and effects controllers. */
	history: Pick<HistoryManager, 'execute' | 'undo' | 'redo' | 'getState' | 'subscribe' | 'clear'>;
	/** Saved viewports, saved and loaded with the nodes. */
	scenes?: CanvasScenesStore;
	/**
	 * Changes the history does not see (e.g. the host's node state changing during a drag).
	 * React's `useCanvasEditorDocument` and Svelte's `createCanvasEditorDocument` supply it.
	 */
	subscribe?: (listener: () => void) => () => void;
	/** Why the canvas cannot be changed (a sentence), or `false`. */
	readOnly?: () => string | false;
}

/** Fields the flow library sets while the canvas is used; they are not part of the document. */
const RUNTIME_NODE_KEYS = ['selected', 'dragging', 'measured', 'resizing'] as const;

const stripNode = <T extends CanvasNode>(node: T): T => {
	const copy: Record<string, unknown> = { ...node };
	for (const key of RUNTIME_NODE_KEYS) delete copy[key];
	return copy as T;
};
const stripEdge = <T extends CanvasEdgeLike>(edge: T): T => {
	const { selected: _selected, ...rest } = edge;
	return rest as T;
};

function checkCanvasDocument(document: unknown): asserts document is CanvasEditorDocument {
	const hint = 'A canvas document is { nodes: [{ id, position: { x, y }, data }], edges: [{ id, source, target }], scenes? } as get_canvas_document returns it.';
	const value = document as Partial<CanvasEditorDocument> | null;
	if (!value || typeof value !== 'object' || !Array.isArray(value.nodes)) throw new Error(`nodes must be an array. ${hint}`);
	if (!Array.isArray(value.edges)) throw new Error(`edges must be an array. ${hint}`);
	const ids = new Set<string>();
	value.nodes.forEach((node, i) => {
		if (!isValidCanvasNode(node)) throw new Error(`nodes[${i}] needs a string id and a numeric position { x, y }. ${hint}`);
		if (ids.has(node.id)) throw new Error(`Node id "${node.id}" is used twice.`);
		ids.add(node.id);
	});
	value.nodes.forEach((node) => {
		if (node.parentId !== undefined && !ids.has(node.parentId)) throw new Error(`Node "${node.id}" has parentId "${node.parentId}", which is not a node in the document.`);
	});
	const edgeIds = new Set<string>();
	value.edges.forEach((edge, i) => {
		if (!isValidCanvasEdge(edge)) throw new Error(`edges[${i}] needs string id, source and target. ${hint}`);
		if (edgeIds.has(edge.id)) throw new Error(`Edge id "${edge.id}" is used twice.`);
		edgeIds.add(edge.id);
		for (const end of [edge.source, edge.target]) {
			if (!ids.has(end)) throw new Error(`Edge "${edge.id}" connects to "${end}", which is not a node in the document.`);
		}
	});
	if (value.scenes !== undefined && !Array.isArray(value.scenes)) throw new Error(`scenes must be an array. ${hint}`);
}

/**
 * The save / load / undo contract for a canvas whose nodes and edges live in the host (React
 * Flow or Svelte Flow state), kind `canvas`. The document is the nodes and edges without
 * selection or measurement, plus the scenes when a store is given. Recorded loads are one
 * undo step in the shared `history`; opening (`history: "reset"`) clears it.
 */
export function createCanvasEditorDocument<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CanvasEditorDocumentOptions<TNode, TEdge>
): EditorDocument<CanvasEditorDocument<TNode, TEdge>> {
	const { history, scenes } = options;
	const snapshot = (): CanvasEditorDocument<TNode, TEdge> => ({
		nodes: options.getNodes().map(stripNode),
		edges: options.getEdges().map(stripEdge),
		...(scenes ? { scenes: scenes.toJSON().scenes } : {})
	});
	const apply = (doc: CanvasEditorDocument<TNode, TEdge>) => {
		options.setNodes(doc.nodes.map((n) => ({ ...n })));
		options.setEdges(doc.edges.map((e) => ({ ...e })));
		if (scenes) scenes.load(doc.scenes ?? []);
	};
	return defineEditorDocument<CanvasEditorDocument<TNode, TEdge>>({
		kind: 'canvas',
		get: snapshot,
		load: (document, { history: mode }) => {
			checkCanvasDocument(document);
			const next = document as CanvasEditorDocument<TNode, TEdge>;
			if (mode === 'record') {
				const before = snapshot();
				history.execute({ name: 'Load canvas', execute: () => apply(next), undo: () => apply(before) });
				return;
			}
			apply(next);
			history.clear();
		},
		subscribe: (listener) => {
			const offs = [history.subscribe(() => listener())];
			if (scenes) offs.push(scenes.subscribe(() => listener()));
			if (options.subscribe) offs.push(options.subscribe(listener));
			return () => offs.forEach((off) => off());
		},
		history: {
			undo: () => history.undo(),
			redo: () => history.redo(),
			getState: () => history.getState()
		},
		readOnly: options.readOnly
	});
}

export interface CanvasGestureRecorderOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	getNodes: () => TNode[];
	setNodes: (nodes: TNode[]) => void;
	getEdges?: () => TEdge[];
	setEdges?: (edges: TEdge[]) => void;
	history: Pick<HistoryManager, 'execute'>;
}

/**
 * Makes a gesture the flow library applies directly (a node drag, a resize) one undo step:
 * call `begin()` when it starts (e.g. `onNodeDragStart`) and `end("Move")` when it stops. If
 * the nodes or edges changed in between, the change is recorded; otherwise nothing is.
 */
export function createCanvasGestureRecorder<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CanvasGestureRecorderOptions<TNode, TEdge>
) {
	let before: { nodes: TNode[]; edges?: TEdge[] } | null = null;
	const take = () => ({ nodes: options.getNodes(), edges: options.getEdges?.() });
	const key = (s: { nodes: TNode[]; edges?: TEdge[] }) => JSON.stringify([s.nodes.map(stripNode), s.edges?.map(stripEdge)]);
	const restore = (s: { nodes: TNode[]; edges?: TEdge[] }) => {
		options.setNodes(s.nodes);
		if (s.edges && options.setEdges) options.setEdges(s.edges);
	};
	return {
		/** Remembers the canvas as it is before the gesture. */
		begin() {
			before = take();
		},
		/** Records the gesture as one undo step named `name`, if it changed anything. Returns whether it did. */
		end(name = 'Move'): boolean {
			const start = before;
			before = null;
			if (!start) return false;
			const after = take();
			if (key(start) === key(after)) return false;
			options.history.execute({ name, execute: () => restore(after), undo: () => restore(start) });
			return true;
		},
		/** Forgets a gesture without recording it. */
		cancel() {
			before = null;
		}
	};
}

export type CanvasGestureRecorder = ReturnType<typeof createCanvasGestureRecorder>;
