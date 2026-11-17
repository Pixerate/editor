/**
 * Text proposals (#890): replacements an agent suggests for a range of a text, shown without
 * changing it until the person (or an agent) accepts one, as one undo step made by the proposer
 * (`agent:<id>`), or dismisses it. The text counterpart of `createCanvasProposals`.
 *
 * Proposals follow the text as it changes: an edit before a proposal moves it, and an edit that
 * touches the text a proposal would replace drops it as `stale` (or re-anchors it when that text
 * is still there, unchanged and unique, as when the person wraps it in `**`). Every proposal ends
 * with an outcome (`accepted`, `rejected`, `stale`, `cleared`) that `onOutcome` reports, for
 * whatever learns from the answers.
 *
 * Positions are UTF-16 offsets, as JavaScript strings and `NSString` count them.
 */

import { diffText } from './text-changes.js';

/** A replacement of `from..to` with `replacement`. */
export interface TextProposalEdit {
	from: number;
	to: number;
	replacement: string;
}

export interface TextProposalInput {
	/** Start of the range to replace (UTF-16 offset). */
	from: number;
	/** End of the range (exclusive); equal to `from` for an insertion. */
	to: number;
	/** What to put there; empty to delete the range. */
	replacement: string;
	/** The text the proposer read at `from..to`; the proposal is refused when the text there differs now. */
	expected?: string;
	/** What the suggestion is, in a few words. Also the undo step's name once accepted. Default: `Replace "…" with "…"`. */
	title?: string;
	/** Why it fits what the person is writing, in a sentence. */
	rationale?: string;
	/** The check or rule behind it (`terms`, `heading-case`, ...), for whatever learns from the outcomes. */
	check?: string;
	/** Who suggests it (`agent:<id>`); defaults to the store's `origin`. */
	origin?: string;
}

export interface TextProposal {
	id: string;
	/** The range it replaces, kept current as the text changes. */
	from: number;
	to: number;
	/** The text at `from..to` now. */
	original: string;
	replacement: string;
	title: string;
	rationale?: string;
	check?: string;
	origin: string;
	/** Milliseconds since the epoch (the store's `now`). */
	createdAt: number;
}

export interface TextProposalsState {
	proposals: readonly TextProposal[];
}

/** How a proposal ended. */
export type TextProposalOutcome = 'accepted' | 'rejected' | 'stale' | 'cleared';

export interface TextProposalOutcomeEvent {
	proposal: TextProposal;
	outcome: TextProposalOutcome;
	at: number;
}

/** What accepting a proposal changed. */
export interface TextProposalAcceptResult {
	proposalId: string;
	/** The range the replacement now occupies. */
	from: number;
	to: number;
	text: string;
	/** The name of the undo step it became. */
	historyLabel: string;
	origin: string;
}

export interface TextProposalsOptions {
	getText: () => string;
	/**
	 * Applies an accepted proposal as one undo step named `step.name`, made by `step.origin`
	 * (`agent:<id>`). The range is in the text as `getText` returns it.
	 */
	applyEdit: (edit: TextProposalEdit, step: { name: string; origin: string }) => void;
	/** Calls `listener` when the text may have changed, so proposals follow it (e.g. a change feed's `subscribe`). */
	subscribe?: (listener: () => void) => () => void;
	/** Why the text cannot be changed (a sentence), or `false`. Proposing still works; accepting does not. */
	readOnly?: () => string | false;
	/** Origin of proposals that name none (default `agent:anonymous`). */
	origin?: string;
	idGenerator?: () => string;
	now?: () => number;
}

export interface TextProposals {
	getState(): TextProposalsState;
	subscribe(listener: (state: TextProposalsState) => void): () => void;
	/** Hears how each proposal ends. Returns an unsubscribe function. */
	onOutcome(listener: (event: TextProposalOutcomeEvent) => void): () => void;
	/** Stages a proposal. Throws (changing nothing) when the range is out of bounds, the text there is not `expected`, or it changes nothing. */
	propose(input: TextProposalInput): TextProposal;
	/** Applies the proposal as one undo step by its origin and drops it. */
	accept(id: string): TextProposalAcceptResult;
	/** Drops the proposal without changing the text. */
	reject(id: string): TextProposal;
	/** Drops every proposal (or those of one origin). Returns the ids dropped. */
	clear(origin?: string): string[];
	get(id: string): TextProposal | undefined;
	/** Brings the proposals up to date with the text (what `subscribe` does for you). Returns the ids dropped as stale. */
	sync(): string[];
	/** Stops following the text. */
	dispose(): void;
}

let counter = 0;
const defaultId = () => `text-proposal-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The default title of a proposal. */
export function textProposalTitle(original: string, replacement: string): string {
	if (!original) return `Insert "${clip(replacement)}"`;
	if (!replacement) return `Delete "${clip(original)}"`;
	return `Replace "${clip(original)}" with "${clip(replacement)}"`;
}

/** A store of agent-suggested text replacements (see the module comment). */
export function createTextProposals(options: TextProposalsOptions): TextProposals {
	const makeId = options.idGenerator ?? defaultId;
	const now = options.now ?? Date.now;
	let state: TextProposalsState = { proposals: [] };
	let known = options.getText();
	const listeners = new Set<(state: TextProposalsState) => void>();
	const outcomeListeners = new Set<(event: TextProposalOutcomeEvent) => void>();

	const set = (proposals: TextProposal[]) => {
		state = { proposals };
		listeners.forEach((l) => l(state));
	};
	const report = (proposal: TextProposal, outcome: TextProposalOutcome) => {
		const event = { proposal, outcome, at: now() };
		outcomeListeners.forEach((l) => l(event));
	};

	const sync = (): string[] => {
		const text = options.getText();
		if (text === known) return [];
		const edit = diffText(known, text);
		known = text;
		if (!edit || !state.proposals.length) return [];
		const delta = edit.inserted.length - edit.removed.length;
		const changedTo = edit.from + edit.inserted.length;
		const kept: TextProposal[] = [];
		const stale: TextProposal[] = [];
		for (const p of state.proposals) {
			if (p.to < edit.from || (p.to === edit.from && (p.from < p.to || edit.to > edit.from))) {
				kept.push(p);
				continue;
			}
			if (p.from >= edit.to && !(p.from === edit.to && p.from === p.to && edit.from === edit.to)) {
				kept.push({ ...p, from: p.from + delta, to: p.to + delta });
				continue;
			}
			// The edit touched the proposal's text: keep it only if that text is still there, once, in what changed.
			const at = p.original.length >= 3 ? text.indexOf(p.original, Math.max(0, edit.from - p.original.length)) : -1;
			const unique = at >= 0 && at <= changedTo && text.indexOf(p.original, at + 1) < 0;
			if (unique) kept.push({ ...p, from: at, to: at + p.original.length });
			else stale.push(p);
		}
		set(kept);
		stale.forEach((p) => report(p, 'stale'));
		return stale.map((p) => p.id);
	};

	const find = (id: string): TextProposal => {
		const proposal = state.proposals.find((p) => p.id === id);
		if (!proposal) {
			const ids = state.proposals.map((p) => p.id);
			throw new Error(`No text proposal "${id}". ${ids.length ? `Pending proposals: ${ids.join(', ')}.` : 'There are no pending proposals.'} Call list_text_proposals for ids; a proposal is dropped when the text it would replace is edited.`);
		}
		return proposal;
	};

	const propose = (input: TextProposalInput): TextProposal => {
		sync();
		const text = known;
		const { from, to, replacement } = input;
		if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > text.length) {
			throw new Error(`The range ${from}–${to} is not in the text, which is ${text.length} UTF-16 code units long; from and to must be whole numbers with 0 ≤ from ≤ to ≤ ${text.length}.`);
		}
		if (typeof replacement !== 'string') throw new Error('A proposal needs a replacement string (empty to delete the range).');
		const original = text.slice(from, to);
		if (input.expected !== undefined && input.expected !== original) {
			throw new Error(`The text at ${from}–${to} is "${clip(original, 80)}", not "${clip(input.expected, 80)}": it changed since you read it. Read the text again and propose with the new range.`);
		}
		if (original === replacement) throw new Error(`The replacement is the text already at ${from}–${to}, so the proposal would change nothing.`);
		const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : textProposalTitle(original, replacement);
		let id = makeId();
		while (state.proposals.some((p) => p.id === id)) id = makeId();
		const proposal: TextProposal = {
			id,
			from,
			to,
			original,
			replacement,
			title,
			...(input.rationale ? { rationale: input.rationale } : {}),
			...(input.check ? { check: input.check } : {}),
			origin: input.origin ?? options.origin ?? 'agent:anonymous',
			createdAt: now()
		};
		set([...state.proposals, proposal]);
		return proposal;
	};

	const accept = (id: string): TextProposalAcceptResult => {
		sync();
		const proposal = find(id);
		const reason = options.readOnly?.();
		if (reason) throw new Error(reason);
		if (known.slice(proposal.from, proposal.to) !== proposal.original) {
			set(state.proposals.filter((p) => p.id !== id));
			report(proposal, 'stale');
			throw new Error(`The text proposal "${id}" would replace text that has changed, so it was dropped. Propose again from the current text.`);
		}
		set(state.proposals.filter((p) => p.id !== id));
		options.applyEdit({ from: proposal.from, to: proposal.to, replacement: proposal.replacement }, { name: proposal.title, origin: proposal.origin });
		sync();
		report(proposal, 'accepted');
		return {
			proposalId: id,
			from: proposal.from,
			to: proposal.from + proposal.replacement.length,
			text: proposal.replacement,
			historyLabel: proposal.title,
			origin: proposal.origin
		};
	};

	const reject = (id: string) => {
		sync();
		const proposal = find(id);
		set(state.proposals.filter((p) => p.id !== id));
		report(proposal, 'rejected');
		return proposal;
	};

	const clear = (origin?: string) => {
		const dropped = state.proposals.filter((p) => origin === undefined || p.origin === origin);
		if (dropped.length) {
			set(state.proposals.filter((p) => !dropped.includes(p)));
			dropped.forEach((p) => report(p, 'cleared'));
		}
		return dropped.map((p) => p.id);
	};

	const off = options.subscribe?.(() => {
		sync();
	});

	return {
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		onOutcome: (listener) => {
			outcomeListeners.add(listener);
			return () => {
				outcomeListeners.delete(listener);
			};
		},
		propose,
		accept,
		reject,
		clear,
		get: (id) => state.proposals.find((p) => p.id === id),
		sync,
		dispose: () => {
			off?.();
			listeners.clear();
			outcomeListeners.clear();
		}
	};
}
