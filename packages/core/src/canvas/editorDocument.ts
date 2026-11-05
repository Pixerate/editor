import type { HistoryManager } from '../history/HistoryManager.js';
import type { EditorAssetRegistry } from '../persistence/assets.js';
import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import { isValidCanvasEdge, isValidCanvasNode } from './clipboard.js';
import type { CanvasScene, CanvasScenesStore, CanvasViewport } from './scenes.js';
import type { CanvasEdge, CanvasNode } from './types.js';

/** What the document needs of an edge (React Flow's and Svelte Flow's edges fit). */
export type CanvasEdgeLike = Pick<CanvasEdge, 'id' | 'source' | 'target'> & { selected?: boolean };

/** A canvas as it is saved: its nodes, edges, (with a scenes store) scenes and (with `getViewport`) the view. */
export interface CanvasEditorDocument<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	nodes: TNode[];
	edges: TEdge[];
	scenes?: CanvasScene[];
	/** Where the canvas was looking when it was saved. */
	viewport?: CanvasViewport;
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
	/**
	 * The view saved with the document and restored on load. Panning and zooming are not
	 * document changes: they do not bump the revision, so they alone do not trigger a save.
	 */
	getViewport?: () => CanvasViewport;
	setViewport?: (viewport: CanvasViewport) => void;
	/** Node fields left out of the document, besides `selected`, `dragging`, `measured` and `resizing`. */
	omitNodeKeys?: readonly string[];
	/** Edge fields left out of the document, besides `selected`. */
	omitEdgeKeys?: readonly string[];
	/**
	 * Checks a node of a document being loaded, after the built-in checks. Return what is wrong
	 * (a sentence) to refuse the whole load, or nothing to accept the node.
	 */
	validateNode?: (node: TNode, index: number) => string | void;
	/**
	 * Turns any document handed to `loadDocument` (a raw one or a migrated file) into the current
	 * shape before it is checked, e.g. an older layout the host stored without a file envelope.
	 */
	normalize?: (document: unknown) => unknown;
	/** The host's format version of the document (default 1); files with an older one are migrated. */
	formatVersion?: number;
	/** `migrations[v]` turns a version `v` file's document into version `v + 1`. Only files carry a version. */
	migrations?: Record<number, (document: unknown) => unknown>;
	/**
	 * Keeps inline binary data in node and edge data (image data URLs, long base64) out of the
	 * document as asset references; autosave and the document store save the bytes with it.
	 */
	assets?: EditorAssetRegistry;
}

/** Fields the flow library sets while the canvas is used; they are not part of the document. */
const RUNTIME_NODE_KEYS = ['selected', 'dragging', 'measured', 'resizing'] as const;
const RUNTIME_EDGE_KEYS = ['selected'] as const;

const omit = <T extends object>(value: T, keys: readonly string[]): T => {
	const copy = { ...value } as Record<string, unknown>;
	for (const key of keys) delete copy[key];
	return copy as T;
};

/** What to leave out of canvas nodes and edges: the runtime fields plus the host's own. */
export interface CanvasDocumentOmitOptions {
	omitNodeKeys?: readonly string[];
	omitEdgeKeys?: readonly string[];
}

const omitKeys = (options: CanvasDocumentOmitOptions = {}) => ({
	node: [...RUNTIME_NODE_KEYS, ...(options.omitNodeKeys ?? [])],
	edge: [...RUNTIME_EDGE_KEYS, ...(options.omitEdgeKeys ?? [])]
});

/**
 * A string that changes only when the saved part of the nodes or edges changes (not selection,
 * measuring or the omitted fields). The React and Svelte document bindings compare it to count
 * changes the history does not see.
 */
export function canvasDocumentContentKey(nodes: readonly CanvasNode[], edges: readonly CanvasEdgeLike[], options?: CanvasDocumentOmitOptions): string {
	const keys = omitKeys(options);
	return JSON.stringify([nodes.map((n) => omit(n, keys.node)), edges.map((e) => omit(e, keys.edge))]);
}

const isViewport = (value: unknown): value is CanvasViewport => {
	const v = value as Partial<CanvasViewport> | null;
	return !!v && typeof v === 'object' && [v.x, v.y, v.zoom].every((n) => typeof n === 'number' && Number.isFinite(n)) && (v.zoom as number) > 0;
};

function checkCanvasDocument(document: unknown): asserts document is CanvasEditorDocument {
	const hint = 'A canvas document is { nodes: [{ id, position: { x, y }, data }], edges: [{ id, source, target }], scenes?, viewport? } as get_canvas_document returns it.';
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
	if (value.viewport !== undefined && !isViewport(value.viewport)) throw new Error(`viewport must be { x, y, zoom } with finite numbers and a zoom above 0. ${hint}`);
}

/**
 * The save / load / undo contract for a canvas whose nodes and edges live in the host (React
 * Flow or Svelte Flow state), kind `canvas`. The document is the nodes and edges without
 * selection, measurement or `omitNodeKeys` / `omitEdgeKeys`, plus the scenes when a store is
 * given and the viewport with `getViewport`. Loads are normalized, then checked (built-in
 * checks, then `validateNode`) before anything changes. Recorded loads are one undo step in the
 * shared `history`; opening (`history: "reset"`) clears it.
 */
export function createCanvasEditorDocument<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CanvasEditorDocumentOptions<TNode, TEdge>
): EditorDocument<CanvasEditorDocument<TNode, TEdge>> {
	const { history, scenes } = options;
	const keys = omitKeys(options);
	const snapshot = (): CanvasEditorDocument<TNode, TEdge> => ({
		nodes: options.getNodes().map((n) => omit(n, keys.node)),
		edges: options.getEdges().map((e) => omit(e, keys.edge)),
		...(scenes ? { scenes: scenes.toJSON().scenes } : {}),
		...(options.getViewport ? { viewport: { ...options.getViewport() } } : {})
	});
	const apply = (doc: CanvasEditorDocument<TNode, TEdge>) => {
		options.setNodes(doc.nodes.map((n) => ({ ...n })));
		options.setEdges(doc.edges.map((e) => ({ ...e })));
		if (scenes) scenes.load(doc.scenes ?? []);
		if (doc.viewport) options.setViewport?.({ ...doc.viewport });
	};
	const check = (document: unknown): CanvasEditorDocument<TNode, TEdge> => {
		checkCanvasDocument(document);
		const next = document as CanvasEditorDocument<TNode, TEdge>;
		if (options.validateNode) {
			next.nodes.forEach((node, i) => {
				const problem = options.validateNode!(node, i);
				if (problem) throw new Error(`Node "${node.id}" (nodes[${i}]): ${problem}`);
			});
		}
		return next;
	};
	return defineEditorDocument<CanvasEditorDocument<TNode, TEdge>>({
		kind: 'canvas',
		formatVersion: options.formatVersion,
		migrations: options.migrations,
		assets: options.assets,
		get: snapshot,
		load: (document, { history: mode }) => {
			const next = check(options.normalize ? options.normalize(document) : document);
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

/** What a gesture did to one node or edge: its saved form before and after (absent = not there). */
interface GestureChange<T> {
	before?: T;
	after?: T;
	beforeIndex: number;
	afterIndex: number;
}

/** The nodes or edges a gesture added, removed or changed (runtime fields aside), by id. */
function gestureChanges<T extends { id: string }>(
	before: readonly T[],
	after: readonly T[],
	runtimeKeys: readonly string[]
): Map<string, GestureChange<T>> {
	const key = (item: T) => JSON.stringify(omit(item, runtimeKeys));
	const changes = new Map<string, GestureChange<T>>();
	before.forEach((item, i) => changes.set(item.id, { before: item, beforeIndex: i, afterIndex: -1 }));
	after.forEach((item, i) => {
		const change = changes.get(item.id);
		if (!change) changes.set(item.id, { after: item, beforeIndex: -1, afterIndex: i });
		else if (key(change.before!) === key(item)) changes.delete(item.id);
		else Object.assign(change, { after: item, afterIndex: i });
	});
	return changes;
}

/**
 * Puts the gesture's `side` back into `current`, touching only what the gesture changed: a node
 * it changed is replaced if it is still there, one it added or removed is removed or put back at
 * its index. Everything else (added, moved or deleted since by a collaborator or an agent) stays.
 */
function applyGestureSide<T extends { id: string }>(
	current: readonly T[],
	changes: Map<string, GestureChange<T>>,
	side: 'before' | 'after'
): T[] {
	const next = current
		.filter((item) => {
			const change = changes.get(item.id);
			return !change || change[side] !== undefined;
		})
		.map((item) => changes.get(item.id)?.[side] ?? item);
	const present = new Set(next.map((item) => item.id));
	const index = side === 'before' ? 'beforeIndex' : 'afterIndex';
	const missing = [...changes.values()]
		.filter((c) => c[side] !== undefined && !present.has(c[side]!.id) && (side === 'before' ? !c.after : !c.before))
		.sort((a, b) => a[index] - b[index]);
	for (const change of missing) next.splice(Math.min(change[index], next.length), 0, change[side]!);
	return next;
}

/**
 * Makes a gesture the flow library applies directly (a node drag, a resize) one undo step:
 * call `begin()` when it starts (e.g. `onNodeDragStart`) and `end("Move")` when it stops. If
 * the nodes or edges changed in between, the change is recorded; otherwise nothing is. Undo and
 * redo put back only the nodes and edges the gesture changed, so work added since by a
 * collaborator or an agent is kept.
 */
export function createCanvasGestureRecorder<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CanvasGestureRecorderOptions<TNode, TEdge>
) {
	let before: { nodes: TNode[]; edges?: TEdge[] } | null = null;
	const take = () => ({ nodes: options.getNodes(), edges: options.getEdges?.() });
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
			const nodes = gestureChanges(start.nodes, after.nodes, RUNTIME_NODE_KEYS);
			const edges =
				start.edges && after.edges && options.setEdges
					? gestureChanges(start.edges, after.edges, RUNTIME_EDGE_KEYS)
					: new Map<string, GestureChange<TEdge>>();
			if (nodes.size === 0 && edges.size === 0) return false;
			const apply = (side: 'before' | 'after') => {
				if (nodes.size) options.setNodes(applyGestureSide(options.getNodes(), nodes, side));
				if (edges.size && options.getEdges && options.setEdges) {
					options.setEdges(applyGestureSide(options.getEdges(), edges, side));
				}
			};
			options.history.execute({ name, execute: () => apply('after'), undo: () => apply('before') });
			return true;
		},
		/** Forgets a gesture without recording it. */
		cancel() {
			before = null;
		}
	};
}

export type CanvasGestureRecorder = ReturnType<typeof createCanvasGestureRecorder>;
