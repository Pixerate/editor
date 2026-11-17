import {
	createTextChangeFeed,
	createTextProposals,
	type TextChange,
	type TextChangeFeed,
	type TextChangeFeedOptions,
	type TextProposal,
	type TextProposals,
	type TextProposalsOptions
} from '@pixerate/editor/tools';

export interface TextProposalStateRune {
	/** The framework-free store (for `createTextProposalToolProvider` and agents). */
	readonly store: TextProposals;
	/** Pending proposals, with their current ranges (reactive). */
	readonly proposals: readonly TextProposal[];
	propose: TextProposals['propose'];
	accept: TextProposals['accept'];
	reject: TextProposals['reject'];
	clear: TextProposals['clear'];
}

/**
 * Agent-suggested replacements for a text, as a Svelte 5 rune: suggestions the person accepts
 * (one undo step made by the proposer, through `applyEdit`) or dismisses. Proposals follow the
 * text whenever `getText` changes: they move as the person writes before them and are dropped
 * when they edit the text a proposal would replace. Call during component initialisation. The
 * same API as React's `useTextProposals`.
 */
export function createTextProposalState(options: Omit<TextProposalsOptions, 'subscribe'>): TextProposalStateRune {
	const store = createTextProposals(options);
	let state = $state.raw(store.getState());
	store.subscribe((next) => {
		state = next;
	});
	$effect(() => {
		options.getText();
		store.sync();
	});
	return {
		store,
		get proposals() {
			return state.proposals;
		},
		propose: store.propose,
		accept: store.accept,
		reject: store.reject,
		clear: store.clear
	};
}

export interface TextChangeWatcherOptions extends Omit<TextChangeFeedOptions, 'subscribe'> {
	/** Called with each change, and when a typing burst ends. */
	onChange?: (change: TextChange) => void;
}

export interface TextChangeWatcherRune {
	readonly feed: TextChangeFeed;
	/** The latest change (reactive). */
	readonly last: TextChange | null;
}

/**
 * What changed in a text, as a Svelte 5 rune: the range, what it held and what replaced it, the
 * selection, who made it, word and line boundaries, and when a typing burst ends, checked
 * whenever `getText` / `getSelection` change. For agents that follow what the person writes.
 * Call during component initialisation; the feed stops on unmount. The same API as React's
 * `useTextChangeFeed`.
 */
export function createTextChangeWatcher(options: TextChangeWatcherOptions): TextChangeWatcherRune {
	const feed = createTextChangeFeed(options);
	let last = $state.raw<TextChange | null>(null);
	feed.subscribe((change) => {
		last = change;
		options.onChange?.(change);
	});
	$effect(() => {
		options.getText();
		options.getSelection?.();
		feed.check();
	});
	$effect(() => () => feed.dispose());
	return {
		feed,
		get last() {
			return last;
		}
	};
}
