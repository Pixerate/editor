/**
 * A feed of what changed in a text (#890): the range that changed, what it held and what
 * replaced it, the selection, who made the change (`user`, or `agent:<id>`), and when a typing
 * burst ends. It diffs snapshots of the text, so it sees every change however it was made: typing,
 * undo, an agent's edit or a host replacing the text. Agents that work alongside a writer read it
 * to follow what they are doing (the text counterpart of `createCanvasChangeFeed`).
 *
 * Positions are UTF-16 offsets, as JavaScript strings and `NSString` count them.
 */

import type { HistoryCommitEvent } from '../history/types.js';

/** A selection: `from === to` is a caret. */
export interface TextSelection {
	from: number;
	to: number;
}

/** One replaced range: `from..to` of the text before held `removed`, and now holds `inserted`. */
export interface TextChangeEdit {
	from: number;
	to: number;
	removed: string;
	inserted: string;
}

export interface TextChange {
	/** Counts up from 1 for each change the feed reports. */
	seq: number;
	/** `user`, or `agent:<id>` when an agent made the change. */
	origin: string;
	/** The history step behind the change, when there was one. */
	commit?: HistoryCommitEvent;
	/** What changed. Absent when only the selection changed or a typing burst ended. */
	edit?: TextChangeEdit;
	/** Set when the selection changed. */
	selection?: { before: TextSelection | null; after: TextSelection | null };
	/**
	 * The edit finished a word (it typed a space or punctuation after one) or a line (a line
	 * break): a good moment for a check of what was just written.
	 */
	boundary?: 'word' | 'line';
	/** The person is typing: more changes of the same burst will follow. */
	inGesture: boolean;
	/**
	 * The typing burst that earlier changes reported (`inGesture`) has ended: the person paused for
	 * `burstMs`, an agent changed the text, or the host called `endGesture`. Reported even when
	 * nothing else changed.
	 */
	gestureEnded?: true;
	/** Length of the text after the change. */
	length: number;
	/** Milliseconds since the epoch. */
	at: number;
}

export interface TextChangeFeedOptions {
	getText: () => string;
	/** The selection, if the host has one. */
	getSelection?: () => TextSelection | null | undefined;
	/** The text's history, for each change's origin. */
	history?: { onCommit(listener: (event: HistoryCommitEvent) => void): () => void };
	/**
	 * Calls the listener when the text may have changed (e.g. an editor's update event). The feed
	 * checks in a microtask, so a history step that reports its commit after changing the text
	 * still gives the change its origin.
	 */
	subscribe?: (listener: () => void) => () => void;
	/**
	 * How long the person must stop typing for their burst to end, in milliseconds (default 1500).
	 * `0` turns bursts off: no change is `inGesture`.
	 */
	burstMs?: number;
	now?: () => number;
	/** Runs `fn` after `ms` and returns a cancel function (default `setTimeout`). */
	schedule?: (fn: () => void, ms: number) => () => void;
}

export interface TextChangeFeed {
	/**
	 * Compares the text and selection with the last snapshot and reports the change, if any.
	 * Pass `origin` when the host knows who made it (an agent's edit applied outside a history).
	 */
	check(origin?: string): TextChange | null;
	/** Hears each change. Returns an unsubscribe function. */
	subscribe(listener: (change: TextChange) => void): () => void;
	/** Takes a new snapshot without reporting the difference (e.g. after loading a document). */
	reset(): void;
	/** Tells the feed about a history step, for the next change's origin (what `history` does for you). */
	noteCommit(event: HistoryCommitEvent): void;
	/** Makes `origin` the origin of the next change (for hosts with their own undo, like `NSUndoManager`). */
	noteOrigin(origin: string): void;
	/** Ends the current typing burst now, reporting `gestureEnded` (e.g. when the editor loses focus). */
	endGesture(): TextChange | null;
	/** The last text the feed saw. */
	text(): string;
	/** Stops listening to the history, the text and the burst timer. */
	dispose(): void;
}

/**
 * The single range that turns `before` into `after`. With the caret after the change, an
 * ambiguous edit (typing `a` into `aa`) is placed where the caret says it was made.
 */
export function diffText(before: string, after: string, caret?: number): TextChangeEdit | null {
	if (before === after) return null;
	const delta = after.length - before.length;
	let pre = 0;
	const maxPre = Math.min(before.length, after.length, caret === undefined ? Infinity : Math.max(0, caret - Math.max(0, delta)));
	while (pre < maxPre && before.charCodeAt(pre) === after.charCodeAt(pre)) pre++;
	// Never split a surrogate pair.
	if (pre > 0 && pre < before.length && isLowSurrogate(before.charCodeAt(pre))) pre--;
	let suf = 0;
	const maxSuf = Math.min(before.length, after.length) - pre;
	while (suf < maxSuf && before.charCodeAt(before.length - 1 - suf) === after.charCodeAt(after.length - 1 - suf)) suf++;
	if (suf > 0 && suf < before.length - pre && isHighSurrogate(before.charCodeAt(before.length - suf - 1))) suf--;
	return { from: pre, to: before.length - suf, removed: before.slice(pre, before.length - suf), inserted: after.slice(pre, after.length - suf) };
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** A replacement widened to whole words ("utilize" → "use", not "tiliz" → "s"); typing and deleting stay as they are. */
function wholeWords(before: string, after: string, edit: TextChangeEdit | null): TextChangeEdit | null {
	if (!edit || !edit.removed || !edit.inserted) return edit;
	let from = edit.from;
	while (from > 0 && isWordChar(before[from - 1])) from--;
	let tail = before.length - edit.to;
	while (tail > 0 && isWordChar(before[before.length - tail])) tail--;
	return { from, to: before.length - tail, removed: before.slice(from, before.length - tail), inserted: after.slice(from, after.length - tail) };
}

/** Whether an edit finished a word or a line. */
export function textChangeBoundary(edit: TextChangeEdit): 'word' | 'line' | undefined {
	const last = edit.inserted[edit.inserted.length - 1];
	if (last === undefined) return undefined;
	if (last === '\n' || last === '\r') return 'line';
	if (/[\s.,;:!?)\]}"'”’…]/u.test(last)) return 'word';
	return undefined;
}

const sameSelection = (a: TextSelection | null, b: TextSelection | null) => (a === null || b === null ? a === b : a.from === b.from && a.to === b.to);

/** A change feed for a text (see the module comment). Call `check` after the text changes. */
export function createTextChangeFeed(options: TextChangeFeedOptions): TextChangeFeed {
	const now = options.now ?? Date.now;
	const burstMs = options.burstMs ?? 1500;
	const schedule =
		options.schedule ??
		((fn: () => void, ms: number) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		});
	const listeners = new Set<(change: TextChange) => void>();
	const selectionNow = () => options.getSelection?.() ?? null;
	let text = options.getText();
	let selection = selectionNow();
	let seq = 0;
	let pendingCommit: HistoryCommitEvent | undefined;
	let pendingOrigin: string | undefined;
	let inBurst = false;
	let cancelTimer: (() => void) | undefined;

	const emit = (change: Omit<TextChange, 'seq' | 'at' | 'length'>): TextChange => {
		const full: TextChange = { seq: ++seq, ...change, length: text.length, at: now() };
		listeners.forEach((l) => l(full));
		return full;
	};

	const stopTimer = () => {
		cancelTimer?.();
		cancelTimer = undefined;
	};

	const endGesture = (): TextChange | null => {
		stopTimer();
		if (!inBurst) return null;
		inBurst = false;
		return emit({ origin: 'user', inGesture: false, gestureEnded: true });
	};

	const check = (origin?: string): TextChange | null => {
		const nextText = options.getText();
		const nextSelection = selectionNow();
		const selectionChanged = !sameSelection(selection, nextSelection);
		const edit = nextText === text ? null : wholeWords(text, nextText, diffText(text, nextText, nextSelection?.to));
		if (!edit && !selectionChanged) return null;
		const beforeSelection = selection;
		text = nextText;
		selection = nextSelection;
		let who = origin;
		let commit: HistoryCommitEvent | undefined;
		if (edit) {
			commit = pendingCommit;
			pendingCommit = undefined;
			who ??= pendingOrigin ?? (commit?.kind === 'execute' || commit?.kind === 'merge' ? commit.origin : 'user');
			pendingOrigin = undefined;
		}
		who ??= 'user';
		// The person's edits make a burst; anyone else's edit ends it.
		const typing = !!edit && who === 'user' && burstMs > 0;
		let gestureEnded = false;
		if (edit && !typing && inBurst) {
			inBurst = false;
			stopTimer();
			gestureEnded = true;
		}
		if (typing) {
			inBurst = true;
			stopTimer();
			cancelTimer = schedule(() => {
				cancelTimer = undefined;
				endGesture();
			}, burstMs);
		}
		const boundary = edit ? textChangeBoundary(edit) : undefined;
		return emit({
			origin: who,
			...(commit ? { commit } : {}),
			...(edit ? { edit } : {}),
			...(selectionChanged ? { selection: { before: beforeSelection, after: nextSelection } } : {}),
			...(boundary ? { boundary } : {}),
			inGesture: inBurst,
			...(gestureEnded ? { gestureEnded: true as const } : {})
		});
	};

	const noteCommit = (event: HistoryCommitEvent) => {
		pendingCommit = event;
	};
	const offHistory = options.history?.onCommit(noteCommit);
	let queued = false;
	let disposed = false;
	const offText = options.subscribe?.(() => {
		if (queued) return;
		queued = true;
		queueMicrotask(() => {
			queued = false;
			if (!disposed) check();
		});
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
			text = options.getText();
			selection = selectionNow();
			pendingCommit = undefined;
			pendingOrigin = undefined;
			inBurst = false;
			stopTimer();
		},
		noteCommit,
		noteOrigin: (origin) => {
			pendingOrigin = origin;
		},
		endGesture,
		text: () => text,
		dispose: () => {
			disposed = true;
			offHistory?.();
			offText?.();
			stopTimer();
			listeners.clear();
		}
	};
}
