/**
 * Focus across linked marks (#812). Hovering or keyboard-focusing an item lights every mark linked
 * to it and dims the rest, including many-to-many links (an item and its tags, or a tag and its
 * items). Headless: the model says which marks are lit; React (`useLinkFocus`) and Svelte
 * (`linkFocusOf`) bind it to pointer and keyboard. Ports to Swift line for line
 * (`PixerateCore/LinkFocus.swift`).
 *
 * Each mark has keys: an item's dot has `[item]`, a tag's chip `[tag]`, a link between them
 * `[item, tag]`. Focusing a key puts it and every key linked to it in focus; a mark is lit when
 * all of its keys are in focus, so a link lights only when both its ends do.
 */

export interface LinkFocusOptions {
	/** Each mark's keys, in the marks' order (`[item]`, `[tag]`, `[item, tag]`, …). */
	marks: readonly (readonly string[])[];
	/** Links between keys, e.g. each item to its tags. Read both ways. */
	links: Readonly<Record<string, readonly string[]>>;
	/**
	 * The keyboard order: the keys arrow keys walk through (default: every key that has a mark of
	 * its own, in mark order). Put items first, then tags, as a reader would go.
	 */
	order?: readonly string[];
	/** Names for keys in descriptions (default the key). */
	labels?: Readonly<Record<string, string>>;
	/** Opacity of marks out of focus, 0–1 (default 0.25). Hosts pass their theme's value. */
	dim?: number;
}

export interface LinkFocusState {
	/** The focused key, or null when nothing is focused (every mark at full strength). */
	focus: string | null;
	/** Whether each mark is lit, in the marks' order (all true with no focus). */
	lit: readonly boolean[];
	/** The keys in focus: the focused key and the keys linked to it (empty with no focus). */
	inFocus: readonly string[];
}

/** A key press, as `handleKey` reads it. */
export interface LinkFocusKeyInput {
	key: string;
}

export interface LinkFocusModel {
	getState(): LinkFocusState;
	subscribe(listener: (state: LinkFocusState) => void): () => void;
	/** Focuses a key (or clears with null). Unknown keys throw, naming the known ones. */
	focus(key: string | null): LinkFocusState;
	clear(): LinkFocusState;
	/** The keys linked to `key`, in the order they were first named. */
	related(key: string): string[];
	/** Each mark's opacity now: 1 when lit, `dim` otherwise. */
	opacity(): number[];
	/**
	 * Arrow keys walk `order` (Right / Down forward, Left / Up back, wrapping), Home and End jump to
	 * its ends, Escape clears. Returns true when it handled the key (so the host stops the event).
	 */
	handleKey(event: LinkFocusKeyInput): boolean;
	/** A sentence for screen readers about a key and what it links to. */
	describe(key?: string | null): string;
	/** The keyboard order in use. */
	readonly order: readonly string[];
	readonly dim: number;
}

/** Keys in focus for `focus`: it and every key linked to it, either way. */
function adjacency(links: Readonly<Record<string, readonly string[]>>): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const add = (a: string, b: string) => {
		const list = out.get(a);
		if (!list) out.set(a, [b]);
		else if (!list.includes(b)) list.push(b);
	};
	for (const [from, tos] of Object.entries(links)) {
		if (!out.has(from)) out.set(from, []);
		for (const to of tos) {
			if (to === from) continue;
			add(from, to);
			add(to, from);
		}
	}
	return out;
}

/**
 * Which marks are lit when `focus` is focused: a mark is lit when every one of its keys is the
 * focused key or linked to it. With no focus, all are lit. Pure; `createLinkFocus` keeps state.
 */
export function linkFocusLit(marks: readonly (readonly string[])[], links: Readonly<Record<string, readonly string[]>>, focus: string | null): boolean[] {
	if (focus === null) return marks.map(() => true);
	const inFocus = new Set([focus, ...(adjacency(links).get(focus) ?? [])]);
	return marks.map((keys) => keys.length > 0 && keys.every((k) => inFocus.has(k)));
}

/** A headless linked-focus model for one picture. */
export function createLinkFocus(options: LinkFocusOptions): LinkFocusModel {
	const adj = adjacency(options.links);
	const known = new Set<string>();
	for (const keys of options.marks) for (const k of keys) known.add(k);
	for (const [from, tos] of adj) {
		known.add(from);
		for (const to of tos) known.add(to);
	}
	const own: string[] = [];
	for (const keys of options.marks) if (keys.length === 1 && !own.includes(keys[0])) own.push(keys[0]);
	const order = (options.order ?? own).filter((k, i, all) => all.indexOf(k) === i);
	for (const k of order) if (!known.has(k)) throw new Error(`order names "${k}", which no mark or link has. Known keys: ${[...known].join(', ')}.`);
	const dim = Math.min(1, Math.max(0, options.dim ?? 0.25));
	const label = (k: string) => options.labels?.[k] ?? k;
	const listeners = new Set<(state: LinkFocusState) => void>();
	const stateFor = (focus: string | null): LinkFocusState => ({
		focus,
		lit: linkFocusLit(options.marks, options.links, focus),
		inFocus: focus === null ? [] : [focus, ...(adj.get(focus) ?? [])]
	});
	let state = stateFor(null);
	const set = (focus: string | null) => {
		if (focus === state.focus) return state;
		state = stateFor(focus);
		for (const l of listeners) l(state);
		return state;
	};
	const model: LinkFocusModel = {
		order,
		dim,
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		focus(key) {
			if (key !== null && !known.has(key)) throw new Error(`Unknown key "${key}". Known keys: ${[...known].join(', ')}.`);
			return set(key);
		},
		clear: () => set(null),
		related: (key) => [...(adj.get(key) ?? [])],
		opacity: () => state.lit.map((lit) => (lit ? 1 : dim)),
		handleKey(event) {
			if (event.key === 'Escape') {
				if (state.focus === null) return false;
				set(null);
				return true;
			}
			if (order.length === 0) return false;
			const i = state.focus === null ? -1 : order.indexOf(state.focus);
			let next: number;
			switch (event.key) {
				case 'ArrowRight':
				case 'ArrowDown':
					next = i < 0 ? 0 : (i + 1) % order.length;
					break;
				case 'ArrowLeft':
				case 'ArrowUp':
					next = i < 0 ? order.length - 1 : (i - 1 + order.length) % order.length;
					break;
				case 'Home':
					next = 0;
					break;
				case 'End':
					next = order.length - 1;
					break;
				default:
					return false;
			}
			set(order[next]);
			return true;
		},
		describe(key = state.focus) {
			if (key === null) return 'Nothing focused.';
			const rel = adj.get(key) ?? [];
			const position = order.indexOf(key);
			const where = position >= 0 ? `, ${position + 1} of ${order.length}` : '';
			if (rel.length === 0) return `${label(key)}${where}: no links.`;
			return `${label(key)}${where}: linked to ${rel.length === 1 ? '1 other' : `${rel.length} others`}, ${rel.map(label).join(', ')}.`;
		}
	};
	return model;
}
