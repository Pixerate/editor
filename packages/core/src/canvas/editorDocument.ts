import type { HistoryManager } from '../history/HistoryManager.js';
import type { EditorAssetRegistry } from '../persistence/assets.js';
import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument.js';
import { isValidCanvasEdge, isValidCanvasNode } from './clipboard.js';
import type { CanvasScene, CanvasScenesStore, CanvasViewport } from './scenes.js';
import type { CanvasEdge, CanvasNode } from './types.js';

/** What the document needs of an edge (React Flow's and Svelte Flow's edges fit). */
export type CanvasEdgeLike = Pick<CanvasEdge, 'id' | 'source' | 'target'> & { selected?: boolean };

/** Extra top-level fields stored alongside a canvas document (e.g. a companion paint layer). */
export interface CanvasDocumentExtras<TExtras extends Record<string, unknown> = Record<string, unknown>> {
	get: () => TExtras;
	load?: (document: Record<string, unknown>) => void;
	subscribe?: (listener: () => void) => () => void;
}

/** Incremental node and edge differences between two canvas snapshots. */
export interface CanvasGraphDifferences<TNode extends { id: string } = CanvasNode, TEdge extends { id: string } = CanvasEdge> {
	changedNodes: TNode[];
	changedEdges: TEdge[];
	removedNodes: TNode[];
	removedEdges: TEdge[];
}

/** A canvas as it is saved: its nodes, edges, (with a scenes store) scenes and (with `getViewport`) the view. */
export interface CanvasEditorDocument<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	nodes: TNode[];
	edges: TEdge[];
	scenes?: CanvasScene[];
	/** Where the canvas was looking when it was saved. */
	viewport?: CanvasViewport;
	[extraKey: string]: unknown;
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
	/**
	 * Companion top-level fields saved and loaded with the canvas (e.g. a full-canvas paint layer).
	 */
	extras?: CanvasDocumentExtras;
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

/**
 * Repairs a raw saved canvas document so it passes `checkCanvasDocument` without losing work:
 * coerces missing node positions/data, deduplicates node and edge ids, clears dangling or cyclic
 * `parentId` references, orders parent nodes before children, drops edges referencing missing
 * nodes, strips runtime keys, and drops invalid `viewport` values.
 */
export function sanitizeCanvasDocument<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	raw: unknown,
	options: CanvasDocumentOmitOptions & { normalizeNode?: (node: TNode) => TNode } = {}
): CanvasEditorDocument<TNode, TEdge> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { nodes: [], edges: [] };
	}
	const doc = raw as Record<string, unknown>;
	const keys = omitKeys(options);
	const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
	const rawEdges = Array.isArray(doc.edges) ? doc.edges : [];

	const nodeMap = new Map<string, TNode>();
	for (const candidate of rawNodes) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
		const item = candidate as Record<string, unknown>;
		if (typeof item.id !== 'string' || item.id.length === 0) continue;
		const pos = item.position as { x?: unknown; y?: unknown } | undefined;
		const position = {
			x: typeof pos?.x === 'number' && Number.isFinite(pos.x) ? pos.x : 0,
			y: typeof pos?.y === 'number' && Number.isFinite(pos.y) ? pos.y : 0
		};
		const data =
			item.data && typeof item.data === 'object' && !Array.isArray(item.data)
				? { ...(item.data as Record<string, unknown>) }
				: {};
		const cleaned = omit({ ...item, position, data } as unknown as TNode, keys.node);
		nodeMap.set(item.id, options.normalizeNode ? options.normalizeNode(cleaned) : cleaned);
	}

	const hasCycle = (nodeId: string, parentId: string): boolean => {
		let cur: string | undefined = parentId;
		const seen = new Set<string>([nodeId]);
		while (cur) {
			if (seen.has(cur)) return true;
			seen.add(cur);
			cur = nodeMap.get(cur)?.parentId;
		}
		return false;
	};

	// Detach one node per cycle and write it back, so later checks see the cycle already broken
	// (in A ⇄ B only A is detached, and a child of A keeps its parent).
	const sanitizedNodes: TNode[] = [];
	for (const node of nodeMap.values()) {
		if (node.parentId !== undefined && (typeof node.parentId !== 'string' || !nodeMap.has(node.parentId) || hasCycle(node.id, node.parentId))) {
			const copy = { ...node } as Record<string, unknown>;
			delete copy.parentId;
			delete copy.extent;
			nodeMap.set(node.id, copy as TNode);
			sanitizedNodes.push(copy as TNode);
		} else {
			sanitizedNodes.push(node);
		}
	}

	const orderedNodes: TNode[] = [];
	const placedIds = new Set<string>();
	const byId = new Map(sanitizedNodes.map((n) => [n.id, n]));
	const place = (node: TNode) => {
		if (placedIds.has(node.id)) return;
		if (node.parentId && byId.has(node.parentId)) {
			place(byId.get(node.parentId)!);
		}
		placedIds.add(node.id);
		orderedNodes.push(node);
	};
	for (const node of sanitizedNodes) place(node);

	const edgeMap = new Map<string, TEdge>();
	for (const candidate of rawEdges) {
		if (!isValidCanvasEdge(candidate)) continue;
		if (!placedIds.has(candidate.source) || !placedIds.has(candidate.target)) continue;
		edgeMap.set(candidate.id, omit({ ...(candidate as unknown as TEdge) }, keys.edge));
	}

	const extraEntries = Object.entries(doc).filter(
		([k, v]) => k !== 'nodes' && k !== 'edges' && k !== 'scenes' && k !== 'viewport' && v !== undefined
	);

	return {
		...Object.fromEntries(extraEntries),
		nodes: orderedNodes,
		edges: [...edgeMap.values()],
		...(Array.isArray(doc.scenes) ? { scenes: doc.scenes as CanvasScene[] } : {}),
		...(isViewport(doc.viewport) ? { viewport: { ...doc.viewport } } : {})
	};
}

/**
 * Pure calculation of graph differences between a current state and a baseline state,
 * ignoring transient runtime node/edge keys (`selected`, `dragging`, `measured`, `resizing`).
 */
export function calculateGraphDifferences<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdgeLike = CanvasEdge
>(
	currentState: { nodes?: readonly TNode[]; edges?: readonly TEdge[] },
	baselineState: { nodes?: readonly TNode[]; edges?: readonly TEdge[] },
	options?: CanvasDocumentOmitOptions
): CanvasGraphDifferences<TNode, TEdge> {
	const currentNodes = currentState.nodes ?? [];
	const currentEdges = currentState.edges ?? [];
	const baselineNodes = baselineState.nodes ?? [];
	const baselineEdges = baselineState.edges ?? [];
	const keys = omitKeys(options);

	const baselineNodeMap = new Map(baselineNodes.map((n) => [n.id, n]));
	const baselineEdgeMap = new Map(baselineEdges.map((e) => [e.id, e]));
	const currentNodeMap = new Map(currentNodes.map((n) => [n.id, n]));
	const currentEdgeMap = new Map(currentEdges.map((e) => [e.id, e]));

	const removedNodes = baselineNodes.filter((oldNode) => !currentNodeMap.has(oldNode.id));
	const removedEdges = baselineEdges.filter((oldEdge) => !currentEdgeMap.has(oldEdge.id));

	const changedNodes = currentNodes.filter((newNode) => {
		const oldNode = baselineNodeMap.get(newNode.id);
		if (!oldNode) return true;
		return JSON.stringify(omit(newNode, keys.node)) !== JSON.stringify(omit(oldNode, keys.node));
	});

	const changedEdges = currentEdges.filter((newEdge) => {
		const oldEdge = baselineEdgeMap.get(newEdge.id);
		if (!oldEdge) return true;
		return JSON.stringify(omit(newEdge, keys.edge)) !== JSON.stringify(omit(oldEdge, keys.edge));
	});

	return { changedNodes, changedEdges, removedNodes, removedEdges };
}

/**
 * Applies a `CanvasGraphDifferences` patch onto an existing `{ nodes, edges }` state,
 * preserving local selection and runtime measurement state on updated items.
 */
export function applyGraphDifferences<
	TNode extends CanvasNode = CanvasNode,
	TEdge extends CanvasEdgeLike = CanvasEdge
>(
	state: { nodes: readonly TNode[]; edges: readonly TEdge[] },
	diff: Partial<CanvasGraphDifferences<TNode, TEdge>>
): { nodes: TNode[]; edges: TEdge[] } {
	const removedNodeIds = new Set((diff.removedNodes ?? []).map((n) => n.id));
	const removedEdgeIds = new Set((diff.removedEdges ?? []).map((e) => e.id));
	const changedNodeMap = new Map((diff.changedNodes ?? []).map((n) => [n.id, n]));
	const changedEdgeMap = new Map((diff.changedEdges ?? []).map((e) => [e.id, e]));

	const existingNodeIds = new Set<string>();
	const nextNodes = state.nodes
		.filter((n) => !removedNodeIds.has(n.id))
		.map((n) => {
			existingNodeIds.add(n.id);
			const updated = changedNodeMap.get(n.id);
			if (!updated) return n;
			return {
				...updated,
				...(n.selected !== undefined ? { selected: n.selected } : {}),
				...(n.measured !== undefined && updated.measured === undefined ? { measured: n.measured } : {})
			};
		});
	for (const [id, node] of changedNodeMap) {
		if (!existingNodeIds.has(id) && !removedNodeIds.has(id)) {
			nextNodes.push({ ...node, selected: false });
		}
	}

	const existingEdgeIds = new Set<string>();
	const nextEdges = state.edges
		.filter((e) => !removedEdgeIds.has(e.id))
		.map((e) => {
			existingEdgeIds.add(e.id);
			const updated = changedEdgeMap.get(e.id);
			if (!updated) return e;
			return {
				...updated,
				...(e.selected !== undefined ? { selected: e.selected } : {})
			};
		});
	for (const [id, edge] of changedEdgeMap) {
		if (!existingEdgeIds.has(id) && !removedEdgeIds.has(id)) {
			nextEdges.push({ ...edge, selected: false });
		}
	}

	return { nodes: nextNodes, edges: nextEdges };
}

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
	const { history, scenes, extras } = options;
	const keys = omitKeys(options);
	const snapshotExtras = () => {
		if (!extras) return {};
		const raw = extras.get();
		if (!raw || typeof raw !== 'object') return {};
		return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
	};
	const snapshot = (): CanvasEditorDocument<TNode, TEdge> => ({
		...snapshotExtras(),
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
		extras?.load?.(doc as unknown as Record<string, unknown>);
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
			if (extras?.subscribe) offs.push(extras.subscribe(() => listener()));
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
