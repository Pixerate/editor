import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
	createCanvasChangeFeed,
	createCanvasProposals,
	type CanvasChange,
	type CanvasChangeFeed,
	type CanvasEdge,
	type CanvasEdgeLike,
	type CanvasNode,
	type CanvasProposal,
	type CanvasProposals,
	type CanvasProposalsOptions
} from '@pixerate/editor/canvas';
import type { HistoryCommitEvent } from '@pixerate/editor/history';

export interface UseCanvasProposalsOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>
	extends Pick<CanvasProposalsOptions<TNode, TEdge>, 'history' | 'origin' | 'readOnly' | 'defaultNodeSize' | 'visibleRect' | 'defaultNodeType' | 'idGenerator'> {
	nodes: TNode[];
	edges: TEdge[];
	setNodes: (nodes: TNode[]) => void;
	setEdges: (edges: TEdge[]) => void;
}

export interface CanvasProposalsHandle<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	/** The framework-free store (for `createCanvasProposalToolProvider` and agents). */
	readonly store: CanvasProposals<TNode, TEdge>;
	/** Pending proposals. */
	proposals: readonly CanvasProposal<TNode, TEdge>[];
	/** The canvas with the proposals drawn in as ghosts: render these instead of `nodes` / `edges`. */
	view: { nodes: TNode[]; edges: TEdge[] };
	propose: CanvasProposals<TNode, TEdge>['propose'];
	accept: CanvasProposals<TNode, TEdge>['accept'];
	reject: CanvasProposals<TNode, TEdge>['reject'];
	clear: CanvasProposals<TNode, TEdge>['clear'];
}

/**
 * Agent-suggested canvas additions for nodes and edges held in React state: ghosts the user
 * accepts (one undo step on `history`, made by the proposer) or rejects. Render `view` instead of
 * your nodes and edges so the ghosts show; changes React Flow reports for ghost ids are no-ops in
 * `applyNodeChanges`. The same API as the Svelte `createCanvasProposalState`. Pass a stable
 * `history`; the other options are read when used.
 */
export function useCanvasProposals<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: UseCanvasProposalsOptions<TNode, TEdge>
): CanvasProposalsHandle<TNode, TEdge> {
	const latest = useRef(options);
	latest.current = options;
	// What the store last wrote, so a second change before React re-renders builds on the first.
	const live = useRef({ nodes: options.nodes, edges: options.edges });
	live.current = { nodes: options.nodes, edges: options.edges };

	const storeRef = useRef<CanvasProposals<TNode, TEdge> | null>(null);
	if (storeRef.current === null) {
		storeRef.current = createCanvasProposals<TNode, TEdge>({
			getNodes: () => live.current.nodes,
			getEdges: () => live.current.edges,
			setNodes: (nodes) => {
				live.current = { ...live.current, nodes };
				latest.current.setNodes(nodes);
			},
			setEdges: (edges) => {
				live.current = { ...live.current, edges };
				latest.current.setEdges(edges);
			},
			history: options.history,
			origin: options.origin,
			readOnly: () => latest.current.readOnly?.() ?? false,
			defaultNodeSize: options.defaultNodeSize,
			visibleRect: () => latest.current.visibleRect?.(),
			defaultNodeType: options.defaultNodeType,
			idGenerator: options.idGenerator
		});
	}
	const store = storeRef.current;
	const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
	const view = useMemo(() => store.withGhosts(options.nodes, options.edges), [store, state, options.nodes, options.edges]);

	return useMemo(
		() => ({
			store,
			proposals: state.proposals,
			view,
			propose: store.propose,
			accept: store.accept,
			reject: store.reject,
			clear: store.clear
		}),
		[store, state, view]
	);
}

export interface UseCanvasChangeFeedOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	nodes: TNode[];
	edges: TEdge[];
	/** The canvas history, for each change's origin (`user` or `agent:<id>`). Pass a stable one. */
	history?: { onCommit(listener: (event: HistoryCommitEvent) => void): () => void };
	/** Node fields to ignore besides the runtime ones. Read once. */
	ignoreNodeKeys?: readonly string[];
	/** Called with each change, after the render that shows it. */
	onChange?: (change: CanvasChange<TNode, TEdge>) => void;
}

/**
 * What changed on a canvas held in React state, after each render: nodes and edges added,
 * removed or edited, the selection, and who made it. For agents that follow what the user does.
 * Returns the latest change and the feed. The same API as the Svelte `createCanvasChangeWatcher`.
 */
export function useCanvasChangeFeed<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: UseCanvasChangeFeedOptions<TNode, TEdge>
): { feed: CanvasChangeFeed<TNode, TEdge>; last: CanvasChange<TNode, TEdge> | null } {
	const latest = useRef(options);
	latest.current = options;
	const [last, setLast] = useState<CanvasChange<TNode, TEdge> | null>(null);
	const feed = useMemo(
		() =>
			createCanvasChangeFeed<TNode, TEdge>({
				getNodes: () => latest.current.nodes,
				getEdges: () => latest.current.edges,
				ignoreNodeKeys: options.ignoreNodeKeys
			}),
		[]
	);
	// The history listener lives in an effect, not in the feed: StrictMode's unmount and remount
	// would otherwise leave the feed without one.
	useEffect(() => options.history?.onCommit(feed.noteCommit), [feed, options.history]);
	useEffect(() => {
		const change = feed.check();
		if (!change) return;
		setLast(change);
		latest.current.onChange?.(change);
	}, [feed, options.nodes, options.edges]);
	return { feed, last };
}
