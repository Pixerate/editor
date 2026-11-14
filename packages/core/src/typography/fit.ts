/**
 * Fitting words to a column (#813): the largest font size, and if asked a tighter letter spacing,
 * at which every word of a set of labels fits a width without breaking. For rows of tag, axis and
 * category labels. The caller measures text (canvas, SVG, CoreText or a fixed-width stand-in in
 * tests), so the steps are pure and port line for line (`PixerateGeometry/FitText.swift`).
 */

import { averageCharacterWidth } from './metrics.js';
import type { FontCategory } from './types.js';

/** Width in px of `word` set at `size` px with `letterSpacing` px added after each character. */
export type MeasureText = (word: string, size: number, letterSpacing: number) => number;

export interface FitTextOptions {
	measure: MeasureText;
	/** Smallest size in px (default 8). */
	min?: number;
	/** Largest size in px (default 32). */
	max?: number;
	/** Sizes tried, in px up from `min` (default 0.5: whole and half pixels). */
	step?: number;
	/**
	 * Tighten letter spacing at `min` before giving up: down to `floor` em (negative, e.g. -0.05)
	 * in steps of `step` em (default 0.01). Off unless given.
	 */
	tracking?: { floor: number; step?: number };
}

export interface FitTextResult {
	/** The size in px. */
	size: number;
	/** Letter spacing in px (0 unless tracking was needed). */
	letterSpacing: number;
	/** Every word fits at this size and spacing. */
	fits: boolean;
	/** The widest word at the result, which set the limit (null with no words). */
	word: string | null;
}

function widest(words: readonly string[], measure: MeasureText, size: number, spacing: number): { word: string | null; width: number } {
	let word: string | null = null;
	let width = -Infinity;
	for (const w of words) {
		const m = measure(w, size, spacing);
		if (m > width) {
			width = m;
			word = w;
		}
	}
	return { word, width };
}

/**
 * The largest size (on the `step` grid from `min` up to `max`) at which the widest word fits
 * `width`, found by binary search on the assumption that wider sizes measure wider. When nothing
 * fits at `min`, tightens tracking if allowed; otherwise reports `fits: false` at `min`, so the
 * caller can wrap, abbreviate or stagger the row (`staggerRows`).
 */
export function fitText(words: readonly string[], width: number, options: FitTextOptions): FitTextResult {
	const { measure } = options;
	const min = options.min ?? 8;
	const max = Math.max(min, options.max ?? 32);
	const step = options.step ?? 0.5;
	if (!(step > 0)) throw new Error('step must be a positive number of px.');
	if (words.length === 0) return { size: max, letterSpacing: 0, fits: true, word: null };
	const fitsAt = (size: number, spacing: number) => widest(words, measure, size, spacing).width <= width;
	const top = Math.floor((max - min) / step + 1e-9);
	if (fitsAt(min, 0)) {
		let lo = 0;
		let hi = top;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (fitsAt(min + mid * step, 0)) lo = mid;
			else hi = mid - 1;
		}
		const size = min + lo * step;
		return { size, letterSpacing: 0, fits: true, word: widest(words, measure, size, 0).word };
	}
	if (options.tracking) {
		const floor = Math.min(0, options.tracking.floor);
		const tStep = options.tracking.step ?? 0.01;
		if (!(tStep > 0)) throw new Error('tracking.step must be a positive number of em.');
		const count = Math.floor(-floor / tStep + 1e-9);
		for (let k = 1; k <= count; k++) {
			const spacing = -k * tStep * min;
			if (fitsAt(min, spacing)) return { size: min, letterSpacing: spacing, fits: true, word: widest(words, measure, min, spacing).word };
		}
		const spacing = count > 0 ? -count * tStep * min : 0;
		return { size: min, letterSpacing: spacing, fits: false, word: widest(words, measure, min, spacing).word };
	}
	return { size: min, letterSpacing: 0, fits: false, word: widest(words, measure, min, 0).word };
}

export interface StaggerRowsOptions {
	measure: MeasureText;
	/** Size in px the words are set at. */
	size: number;
	/** Letter spacing in px (default 0). */
	letterSpacing?: number;
	/** Space kept between neighbouring words in a row (default 4). */
	gap?: number;
}

export interface StaggerRowsResult {
	/** Row of each word, in the words' order: 0, or 1 for the second row. */
	rows: number[];
	/** 1 when one row fits, otherwise 2. */
	count: 1 | 2;
	/** No two words in a row overlap (with the gap). */
	fits: boolean;
}

/**
 * Whether words centred at `positions` (px along the row) fit in one row, and if not, alternating
 * rows: each word then only has to clear the word two places away.
 */
export function staggerRows(words: readonly string[], positions: readonly number[], options: StaggerRowsOptions): StaggerRowsResult {
	const n = Math.min(words.length, positions.length);
	const gap = options.gap ?? 4;
	const spacing = options.letterSpacing ?? 0;
	const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => positions[a] - positions[b] || a - b);
	const half = order.map((i) => options.measure(words[i], options.size, spacing) / 2);
	const clear = (stride: number) => {
		for (let k = 0; k + stride < n; k++) {
			if (positions[order[k]] + half[k] + gap > positions[order[k + stride]] - half[k + stride]) return false;
		}
		return true;
	};
	const rows: number[] = new Array(n).fill(0);
	if (clear(1)) return { rows, count: 1, fits: true };
	for (let k = 0; k < n; k++) rows[order[k]] = k % 2;
	return { rows, count: 2, fits: clear(2) };
}

/**
 * A `MeasureText` from average glyph widths for a font category: no renderer needed, so agents
 * and servers can use it, but it only estimates proportional fonts. Hosts with a renderer should
 * measure for real.
 */
export function estimatedMeasure(category: FontCategory = 'sans-serif'): MeasureText {
	const advance = averageCharacterWidth(category);
	return (word, size, spacing) => {
		const count = Array.from(word).length;
		return count * size * advance + Math.max(0, count - 1) * spacing;
	};
}
