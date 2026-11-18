import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
	createTextChangeFeed,
	createTextProposals,
	type TextChange,
	type TextChangeFeed,
	type TextProposal,
	type TextProposals,
	type TextProposalsOptions,
	type TextSelection
} from '@pixerate/editor/tools';
import type { HistoryCommitEvent } from '@pixerate/editor/history';

export interface UseTextProposalsOptions extends Pick<TextProposalsOptions, 'applyEdit' | 'origin' | 'readOnly' | 'idGenerator' | 'now'> {
	/** The text as it is now. Proposals follow it on each render. */
	text: string;
}

export interface TextProposalsHandle {
	/** The framework-free store (for `createTextProposalToolProvider` and agents). */
	readonly store: TextProposals;
	/** Pending proposals, with their current ranges. */
	proposals: readonly TextProposal[];
	propose: TextProposals['propose'];
	accept: TextProposals['accept'];
	reject: TextProposals['reject'];
	clear: TextProposals['clear'];
}

/**
 * Agent-suggested replacements for a text held in React state: suggestions the person accepts
 * (one undo step made by the proposer, through `applyEdit`) or dismisses. Proposals move as the
 * person writes before them and are dropped when they edit the text a proposal would replace.
 * The same API as the Svelte `createTextProposalState`. The options are read when used.
 */
export function useTextProposals(options: UseTextProposalsOptions): TextProposalsHandle {
	const latest = useRef(options);
	latest.current = options;
	const storeRef = useRef<TextProposals | null>(null);
	if (storeRef.current === null) {
		storeRef.current = createTextProposals({
			getText: () => latest.current.text,
			applyEdit: (edit, step) => latest.current.applyEdit(edit, step),
			readOnly: () => latest.current.readOnly?.() ?? false,
			origin: options.origin,
			idGenerator: options.idGenerator,
			now: options.now
		});
	}
	const store = storeRef.current;
	const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
	useEffect(() => {
		store.sync();
	}, [store, options.text]);
	return useMemo(
		() => ({
			store,
			proposals: state.proposals,
			propose: store.propose,
			accept: store.accept,
			reject: store.reject,
			clear: store.clear
		}),
		[store, state]
	);
}

export interface UseTextChangeFeedOptions {
	/** The text as it is now. */
	text: string;
	/** The selection, when the host has one (a caret is `from === to`). */
	selection?: TextSelection | null;
	/** The text's history, for each change's origin (`user` or `agent:<id>`). Pass a stable one. */
	history?: { onCommit(listener: (event: HistoryCommitEvent) => void): () => void };
	/** How long the person must stop typing for their burst to end (ms, default 1500; 0: no bursts). Read once. */
	burstMs?: number;
	/** Called with each change, after the render that shows it, and when a typing burst ends. */
	onChange?: (change: TextChange) => void;
}

/**
 * What changed in a text held in React state, after each render: the range, what it held and
 * what replaced it, the selection, who made it, word and line boundaries, and when a typing
 * burst ends. For agents that follow what the person writes. Returns the latest change and the
 * feed. The same API as the Svelte `createTextChangeWatcher`.
 */
export function useTextChangeFeed(options: UseTextChangeFeedOptions): { feed: TextChangeFeed; last: TextChange | null } {
	const latest = useRef(options);
	latest.current = options;
	const [last, setLast] = useState<TextChange | null>(null);
	const feed = useMemo(
		() =>
			createTextChangeFeed({
				getText: () => latest.current.text,
				getSelection: () => latest.current.selection ?? null,
				burstMs: options.burstMs
			}),
		[]
	);
	// Changes the feed reports by itself (a burst ending) reach the host too.
	useEffect(
		() =>
			feed.subscribe((change) => {
				setLast(change);
				latest.current.onChange?.(change);
			}),
		[feed]
	);
	// The history listener lives in an effect, not in the feed: StrictMode's unmount and remount
	// would otherwise leave the feed without one.
	useEffect(() => options.history?.onCommit(feed.noteCommit), [feed, options.history]);
	// A burst still open on unmount ends there (and its timer stops).
	useEffect(
		() => () => {
			feed.endGesture();
		},
		[feed]
	);
	useEffect(() => {
		feed.check();
	}, [feed, options.text, options.selection?.from, options.selection?.to]);
	return { feed, last };
}
