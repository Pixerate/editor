/**
 * A feed of what changed on a canvas: nodes and edges added, removed or edited, and the
 * selection, each change tagged with who made it (the history origin, else `user`). It diffs
 * snapshots, so it sees every change however it was made: history steps, drags the history
 * does not record, or a host replacing its state. Agents that work alongside the user read it
 * to follow what they are doing.
 */

import type { HistoryCommitEvent } from '../history/types.js';
import type { CanvasEdgeLike } from './editorDocument.js';
import type { CanvasEdge, CanvasNode } from './types.js';

/** Fields the flow library sets while the canvas is used; changing only these is not an edit. */
const RUNTIME_NODE_KEYS = new Set(['selected', 'dragging', 'measured', 'resizing']);
const RUNTIME_EDGE_KEYS = new Set(['selected']);

export interface CanvasNodeChange<TNode extends CanvasNode = CanvasNode> {
	before: TNode;
	after: TNode;
	/** Top-level fields that differ (`position`, `data`, `width`, ...). */
	fields: string[];
}

export interface CanvasEdgeChange<TEdge extends CanvasEdgeLike = CanvasEdge> {
	before: TEdge;
	after: TEdge;
	fields: string[];
}

export interface CanvasChange<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	/** Counts up from 1 for each change the feed reports. */
	seq: number;
	/** `user`, or `agent:<id>` when the change came from an agent's history step. */
	origin: string;
	/** The history step behind the change, when there was one. */
	commit?: HistoryCommitEvent;
	addedNodes: TNode[];
	removedNodes: TNode[];
	changedNodes: CanvasNodeChange<TNode>[];
	addedEdges: TEdge[];
	removedEdges: TEdge[];
	changedEdges: CanvasEdgeChange<TEdge>[];
	/** Set when the selected node ids changed. */
	selection?: { before: string[]; after: string[] };
	/** A node is being dragged or resized: more changes of the same gesture will follow. */
	inGesture: boolean;
	/**
	 * The drag or resize that earlier changes reported (`inGesture`) has ended. Set on the first
	 * change after it, which the feed reports even when nothing else changed: a drop often only
	 * clears the runtime `dragging` flag, and followers need to know the gesture is over.
	 */
	gestureEnded?: true;
	/** Milliseconds since the epoch. */
	at: number;
}

export interface CanvasChangeFeedOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	getNodes: () => readonly TNode[];
	getEdges: () => readonly TEdge[];
	/** The canvas history, for each change's origin. */
	history?: { onCommit(listener: (event: HistoryCommitEvent) => void): () => void };
	/** Calls `check` when the canvas may have changed (e.g. the canvas document's `subscribe`). */
	subscribe?: (listener: () => void) => () => void;
	/** Node fields to ignore besides the runtime ones (`selected`, `dragging`, `measured`, `resizing`). */
	ignoreNodeKeys?: readonly string[];
	now?: () => number;
}

export interface CanvasChangeFeed<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	/** Compares the canvas with the last snapshot and reports the change, if any. */
	check(): CanvasChange<TNode, TEdge> | null;
	/** Hears each change. Returns an unsubscribe function. */
	subscribe(listener: (change: CanvasChange<TNode, TEdge>) => void): () => void;
	/** Takes a new snapshot without reporting the difference (e.g. after loading a document). */
	reset(): void;
	/** Tells the feed about a history step, for the next change's origin (what `history` does for you). */
	noteCommit(event: HistoryCommitEvent): void;
	/** Stops listening to the history and the canvas. */
	dispose(): void;
}

const selectedIds = (nodes: readonly CanvasNode[]) => nodes.filter((n) => n.selected).map((n) => n.id);

function diffFields(before: Record<string, unknown>, after: Record<string, unknown>, ignore: Set<string>): string[] {
	if (before === after) return [];
	const fields: string[] = [];
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (ignore.has(key)) continue;
		const a = before[key];
		const b = after[key];
		if (a === b) continue;
		if (a && b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b)) continue;
		fields.push(key);
	}
	return fields;
}

/** A change feed for a canvas (see the module comment). Call `check` after the canvas renders. */
export function createCanvasChangeFeed<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CanvasChangeFeedOptions<TNode, TEdge>
): CanvasChangeFeed<TNode, TEdge> {
	const now = options.now ?? Date.now;
	const nodeIgnore = new Set([...RUNTIME_NODE_KEYS, ...(options.ignoreNodeKeys ?? [])]);
	const listeners = new Set<(change: CanvasChange<TNode, TEdge>) => void>();
	let nodes = options.getNodes();
	let edges = options.getEdges();
	let seq = 0;
	/** The latest history step not yet matched to a change. */
	let pending: HistoryCommitEvent | undefined;
	const gesturing = (list: readonly TNode[]) => list.some((n) => n.dragging || n.resizing);
	/** Whether the last snapshot was mid-gesture, to report when the gesture ends. */
	let wasInGesture = gesturing(nodes);

	const check = (): CanvasChange<TNode, TEdge> | null => {
		const nextNodes = options.getNodes();
		const nextEdges = options.getEdges();
		if (nextNodes === nodes && nextEdges === edges) return null;
		const beforeNodes = new Map(nodes.map((n) => [n.id, n]));
		const afterNodes = new Map(nextNodes.map((n) => [n.id, n]));
		const beforeEdges = new Map(edges.map((e) => [e.id, e]));
		const afterEdges = new Map(nextEdges.map((e) => [e.id, e]));

		const addedNodes = nextNodes.filter((n) => !beforeNodes.has(n.id));
		const removedNodes = nodes.filter((n) => !afterNodes.has(n.id));
		const changedNodes: CanvasNodeChange<TNode>[] = [];
		for (const after of nextNodes) {
			const before = beforeNodes.get(after.id);
			if (!before) continue;
			const fields = diffFields(before, after, nodeIgnore);
			if (fields.length) changedNodes.push({ before, after, fields });
		}
		const addedEdges = nextEdges.filter((e) => !beforeEdges.has(e.id));
		const removedEdges = edges.filter((e) => !afterEdges.has(e.id));
		const changedEdges: CanvasEdgeChange<TEdge>[] = [];
		for (const after of nextEdges) {
			const before = beforeEdges.get(after.id);
			if (!before) continue;
			const fields = diffFields(before, after, RUNTIME_EDGE_KEYS);
			if (fields.length) changedEdges.push({ before, after, fields });
		}
		const selBefore = selectedIds(nodes);
		const selAfter = selectedIds(nextNodes);
		const selectionChanged = selBefore.length !== selAfter.length || selBefore.some((id, i) => id !== selAfter[i]);

		nodes = nextNodes;
		edges = nextEdges;
		const inGesture = gesturing(nextNodes);
		const gestureEnded = wasInGesture && !inGesture;
		wasInGesture = inGesture;
		const edited = addedNodes.length + removedNodes.length + changedNodes.length + addedEdges.length + removedEdges.length + changedEdges.length > 0;
		if (!edited && !selectionChanged && !gestureEnded) return null;

		const commit = edited ? pending : undefined;
		if (edited) pending = undefined;
		const change: CanvasChange<TNode, TEdge> = {
			seq: ++seq,
			origin: commit?.kind === 'execute' || commit?.kind === 'merge' ? commit.origin : 'user',
			...(commit ? { commit } : {}),
			addedNodes,
			removedNodes,
			changedNodes,
			addedEdges,
			removedEdges,
			changedEdges,
			...(selectionChanged ? { selection: { before: selBefore, after: selAfter } } : {}),
			inGesture,
			...(gestureEnded ? { gestureEnded: true as const } : {}),
			at: now()
		};
		listeners.forEach((l) => l(change));
		return change;
	};

	const noteCommit = (event: HistoryCommitEvent) => {
		pending = event;
	};
	const offHistory = options.history?.onCommit(noteCommit);
	const offCanvas = options.subscribe?.(() => {
		check();
	});

	return {
		check,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		reset: () => {
			nodes = options.getNodes();
			edges = options.getEdges();
			pending = undefined;
			wasInGesture = gesturing(nodes);
		},
		noteCommit,
		dispose: () => {
			offHistory?.();
			offCanvas?.();
			listeners.clear();
		}
	};
}
