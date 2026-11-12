/**
 * Text case for headings, titles and labels (sentence, title or upper case) that keeps
 * acronyms, words with digits or inner capitals, and proper nouns. Dependency-free; the
 * rich-text, spreadsheet and diagram house styles share it.
 */

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'over', 'per', 'so', 'the', 'to', 'up', 'via', 'vs', 'with', 'yet']);

/** `text` in `kind` case, keeping acronyms, words with digits or inner capitals, and `properNouns`. */
export function applyTextCase(text: string, kind: 'sentence' | 'title' | 'upper', properNouns: readonly string[] = []): string {
	if (kind === 'upper') return text.toUpperCase();
	const nouns = new Map(properNouns.map((n) => [n.toLowerCase(), n]));
	const words = text.split(/(\s+)/);
	const wordIndexes = words.map((w, i) => (/\S/.test(w) ? i : -1)).filter((i) => i >= 0);
	const first = wordIndexes[0];
	const last = wordIndexes[wordIndexes.length - 1];
	let afterColon = false;
	return words
		.map((w, i) => {
			if (!/\S/.test(w)) return w;
			const startsSentence = i === first || afterColon;
			afterColon = /[:.!?]$/.test(w);
			const bare = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
			const lower = bare.toLowerCase();
			if (!bare) return w;
			if (nouns.has(lower)) return w.replace(bare, nouns.get(lower)!);
			// Acronyms (API, NASA), words with digits or inner capitals (iOS, Q3) stay as written.
			if ((bare.length > 1 && bare === bare.toUpperCase() && /\p{L}/u.test(bare)) || /\d/.test(bare) || /^\p{Ll}+\p{Lu}/u.test(bare) || /\p{Ll}\p{Lu}/u.test(bare.slice(1))) return w;
			const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
			if (kind === 'sentence') return w.replace(bare, startsSentence ? cap(lower) : lower);
			const small = SMALL_WORDS.has(lower) && i !== first && i !== last && !startsSentence;
			return w.replace(bare, small ? lower : cap(bare));
		})
		.join('');
}


/** The cases {@link applyTextCase} writes. */
export const TEXT_CASES = ['sentence', 'title', 'upper'] as const;
