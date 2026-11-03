import {
	createCanvasChangeFeed,
	createCanvasProposals,
	type CanvasChange,
	type CanvasChangeFeed,
	type CanvasChangeFeedOptions,
	type CanvasEdge,
	type CanvasEdgeLike,
	type CanvasNode,
	type CanvasProposal,
	type CanvasProposals,
	type CanvasProposalsOptions
} from '@pixerate/editor/canvas';

export interface CanvasProposalStateRune<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	/** The framework-free store (for `createCanvasProposalToolProvider` and agents). */
	readonly store: CanvasProposals<TNode, TEdge>;
	/** Pending proposals (reactive). */
	readonly proposals: readonly CanvasProposal<TNode, TEdge>[];
	/** The canvas with the proposals drawn in as ghosts (reactive): render these instead of your nodes and edges. */
	readonly view: { nodes: TNode[]; edges: TEdge[] };
	propose: CanvasProposals<TNode, TEdge>['propose'];
	accept: CanvasProposals<TNode, TEdge>['accept'];
	reject: CanvasProposals<TNode, TEdge>['reject'];
	clear: CanvasProposals<TNode, TEdge>['clear'];
}

/**
 * Agent-suggested canvas additions as a Svelte 5 rune: ghosts the user accepts (one undo step
 * on `history`, made by the proposer) or rejects. Render `view` instead of your nodes and edges so
 * the ghosts show. The same API as React's `useCanvasProposals`; pass getters and setters for the
 * canvas state.
 */
export function createCanvasProposalState<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CanvasProposalsOptions<TNode, TEdge>
): CanvasProposalStateRune<TNode, TEdge> {
	const store = createCanvasProposals<TNode, TEdge>(options);
	let state = $state.raw(store.getState());
	store.subscribe((next) => {
		state = next;
	});
	const view = $derived.by(() => {
		void state;
		return store.withGhosts(options.getNodes(), options.getEdges());
	});
	return {
		store,
		get proposals() {
			return state.proposals;
		},
		get view() {
			return view;
		},
		propose: store.propose,
		accept: store.accept,
		reject: store.reject,
		clear: store.clear
	};
}

export interface CanvasChangeWatcherOptions<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>
	extends Omit<CanvasChangeFeedOptions<TNode, TEdge>, 'subscribe'> {
	/** Called with each change. */
	onChange?: (change: CanvasChange<TNode, TEdge>) => void;
}

export interface CanvasChangeWatcherRune<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge> {
	readonly feed: CanvasChangeFeed<TNode, TEdge>;
	/** The latest change (reactive). */
	readonly last: CanvasChange<TNode, TEdge> | null;
}

/**
 * What changed on a canvas, as a Svelte 5 rune: nodes and edges added, removed or edited, the
 * selection, and who made it, checked whenever `getNodes` / `getEdges` change. For agents that
 * follow what the user does. Call during component initialisation; the feed stops on unmount.
 * The same API as React's `useCanvasChangeFeed`.
 */
export function createCanvasChangeWatcher<TNode extends CanvasNode = CanvasNode, TEdge extends CanvasEdgeLike = CanvasEdge>(
	options: CanvasChangeWatcherOptions<TNode, TEdge>
): CanvasChangeWatcherRune<TNode, TEdge> {
	const feed = createCanvasChangeFeed<TNode, TEdge>(options);
	let last = $state.raw<CanvasChange<TNode, TEdge> | null>(null);
	$effect(() => {
		options.getNodes();
		options.getEdges();
		const change = feed.check();
		if (!change) return;
		last = change;
		options.onChange?.(change);
	});
	$effect(() => () => feed.dispose());
	return {
		feed,
		get last() {
			return last;
		}
	};
}
