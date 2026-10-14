// Portions ported from photocraft-main/crates/ui-egui/src/palette.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/** The fields `rankCommands` searches (a `CommandEntry` satisfies it). */
export interface RankableCommand {
	id: string;
	label: string;
	group?: string;
	keywords?: readonly string[];
	enabled?: boolean;
}

export interface FuzzyMatch {
	score: number;
	/** Indices of the matched characters in the text (for highlighting). */
	indices: number[];
}

const WORD_SEPARATORS = new Set([' ', '-', '_', '.', '/', ':', '›', '(']);

/**
 * Subsequence fuzzy match: every query character must appear in order. Consecutive
 * matches score 8, others 1; a match at a word start adds 5; longer texts lose
 * `length / 8`. Case-insensitive. Returns `null` when the query does not match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
	const q = query.trim().toLowerCase();
	if (!q) return { score: 0, indices: [] };
	const t = text.toLowerCase();
	let score = 0;
	let ti = 0;
	let last = -2;
	const indices: number[] = [];
	for (const qc of q) {
		if (qc === ' ') continue;
		let found = false;
		while (ti < t.length) {
			if (t[ti] === qc) {
				score += last === ti - 1 ? 8 : 1;
				if (ti === 0 || WORD_SEPARATORS.has(t[ti - 1])) score += 5;
				last = ti;
				indices.push(ti);
				ti++;
				found = true;
				break;
			}
			ti++;
		}
		if (!found) return null;
	}
	return { score: score - Math.floor(t.length / 8), indices };
}

/** `fuzzyMatch(query, text)?.score ?? null`. */
export function fuzzyScore(query: string, text: string): number | null {
	return fuzzyMatch(query, text)?.score ?? null;
}

/**
 * Bonus that puts a command whose name is exactly the query ahead of every fuzzy match
 * ("undo" finds Undo before "Undo Selection Change"). Trailing ellipses are ignored.
 */
export function exactBonus(query: string, names: readonly string[]): number {
	const q = query.trim().toLowerCase();
	if (!q) return 0;
	return names.some((n) => n.replace(/(…|\.\.\.)$/, '').trim().toLowerCase() === q) ? 1000 : 0;
}

/** Default number of recently run commands a palette remembers. */
export const DEFAULT_RECENT_LIMIT = 8;

/** Moves `id` to the front of `list` (deduplicated, newest first, at most `cap`). Returns a new array. */
export function pushRecent(list: readonly string[], id: string, cap: number = DEFAULT_RECENT_LIMIT): string[] {
	return [id, ...list.filter((x) => x !== id)].slice(0, Math.max(0, cap));
}

export interface RankedCommand<T extends RankableCommand = RankableCommand> {
	entry: T;
	score: number;
	/** Matched character indices in `entry.label` (empty when another field matched). */
	labelIndices: number[];
	/** The entry was shown because it was run recently (empty query). */
	recent: boolean;
}

export interface RankCommandsOptions {
	/** Recently run ids, newest first. Shown first for an empty query and boosted slightly otherwise. */
	recents?: readonly string[];
	/** Maximum number of recents shown for an empty query (default 8). */
	recentLimit?: number;
	/** Maximum number of results. */
	limit?: number;
	/** Sort disabled commands after enabled ones (default `true`). */
	disabledLast?: boolean;
	/** With an empty query: `all` (default) lists recents then every other command; `recents` lists only recents. */
	emptyQuery?: 'all' | 'recents';
}

/**
 * Ranks commands for a palette query. Searches the label, `group label`, keywords and id;
 * an exact label or keyword match always wins. An empty query lists recent commands
 * first (deduplicated and capped), then the rest in their original order.
 */
export function rankCommands<T extends RankableCommand>(
	query: string,
	entries: readonly T[],
	options: RankCommandsOptions = {}
): RankedCommand<T>[] {
	const recents = options.recents ?? [];
	const disabledLast = options.disabledLast ?? true;
	const q = query.trim();
	let ranked: Array<RankedCommand<T> & { order: number }>;

	if (!q) {
		const byId = new Map(entries.map((e) => [e.id, e]));
		const recentIds = [...new Set(recents)].filter((id) => byId.has(id)).slice(0, options.recentLimit ?? DEFAULT_RECENT_LIMIT);
		const recentSet = new Set(recentIds);
		ranked = recentIds.map((id, i) => ({ entry: byId.get(id)!, score: 1000 - i, labelIndices: [], recent: true, order: i }));
		if ((options.emptyQuery ?? 'all') === 'all') {
			entries.forEach((entry, i) => {
				if (!recentSet.has(entry.id)) ranked.push({ entry, score: 0, labelIndices: [], recent: false, order: recentIds.length + i });
			});
		}
	} else {
		ranked = [];
		entries.forEach((entry, order) => {
			const label = fuzzyMatch(q, entry.label);
			const candidates: number[] = [];
			if (label) candidates.push(label.score);
			if (entry.group) {
				const grouped = fuzzyScore(q, `${entry.group} ${entry.label}`);
				if (grouped !== null) candidates.push(grouped - 1);
			}
			for (const keyword of entry.keywords ?? []) {
				const s = fuzzyScore(q, keyword);
				if (s !== null) candidates.push(s - 2);
			}
			const byId = fuzzyScore(q, entry.id);
			if (byId !== null) candidates.push(byId - 3);
			if (candidates.length === 0) return;
			const recentIndex = recents.indexOf(entry.id);
			const score =
				Math.max(...candidates) +
				exactBonus(q, [entry.label, ...(entry.keywords ?? [])]) +
				(recentIndex >= 0 ? Math.max(1, 4 - recentIndex) : 0);
			ranked.push({ entry, score, labelIndices: label?.indices ?? [], recent: false, order });
		});
		ranked.sort((a, b) => b.score - a.score || a.entry.label.length - b.entry.label.length || a.order - b.order);
	}

	if (disabledLast) {
		// Stable partition: enabled first, keeping the ranking within each half.
		ranked = [...ranked.filter((r) => r.entry.enabled !== false), ...ranked.filter((r) => r.entry.enabled === false)];
	}
	const out = ranked.map(({ order: _order, ...rest }) => rest);
	return options.limit !== undefined ? out.slice(0, options.limit) : out;
}
