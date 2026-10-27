/**
 * Measure (line length), line spacing and other readability checks for body text.
 */

import type { FontCategory, FontSpec, ReadabilityAuditResult } from './types.js';
import { countGraphemes } from './segment.js';

/** Comfortable measure for body text, in characters per line. */
export const OPTIMAL_MEASURE = { min: 45, max: 75 } as const;
/** WCAG 1.4.8 (AAA) line spacing and the WCAG 1.4.12 test value: 1.5× the font size. */
export const RECOMMENDED_LINE_HEIGHT = 1.5;
/** Silent reading speed used for reading time (words per minute). */
export const READING_WORDS_PER_MINUTE = 238;
/** Line-height browsers use for `normal` with most fonts, assumed when none is given. */
export const ASSUMED_NORMAL_LINE_HEIGHT = 1.2;

/** Average advance of a character, as a fraction of the font size, by category. */
const CHARACTER_WIDTH: Readonly<Record<FontCategory, number>> = {
	'sans-serif': 0.5,
	serif: 0.47,
	monospace: 0.6,
	display: 0.55,
	handwriting: 0.5
};

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/** Estimated characters per line for a container width (px) at a font size, from average glyph widths. */
export function estimateCharactersPerLine(width: number, font: { size: number; category?: FontCategory; letterSpacing?: number }): number {
	if (!(width > 0) || !(font.size > 0)) throw new Error('width and size must be positive numbers of px.');
	const advance = font.size * (CHARACTER_WIDTH[font.category ?? 'sans-serif'] + (font.letterSpacing ?? 0));
	return Math.max(1, Math.floor(width / advance));
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu;

export interface ReadabilityOptions extends Partial<FontSpec> {
	/** Container width in px; when given with `size`, line length is estimated from it instead of the text's own line breaks. */
	width?: number;
}

/**
 * Audits body text: line length against 45–75 characters, line spacing against 1.5, text set in
 * capitals, and reading time. Line length comes from the text's own lines, or from `width` and
 * `size` when both are given.
 */
export function auditTextReadability(text: string, font: ReadabilityOptions = {}): ReadabilityAuditResult {
	if (typeof text !== 'string') throw new Error('text must be a string.');
	const issues: string[] = [];
	const words = text.match(WORD) ?? [];
	const lines = text.split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean);

	let characters: number;
	let wordsPerLine: number;
	let source: 'lines' | 'width';
	if (font.width !== undefined && font.size !== undefined) {
		source = 'width';
		characters = estimateCharactersPerLine(font.width, { size: font.size, category: font.category, letterSpacing: font.letterSpacing });
		const avgWordLength = words.length ? countGraphemes(words.join(' ')) / words.length : 5;
		wordsPerLine = round(characters / (avgWordLength + 1));
	} else {
		source = 'lines';
		characters = lines.length ? round(lines.reduce((n, l) => n + countGraphemes(l), 0) / lines.length) : 0;
		wordsPerLine = lines.length ? round(lines.reduce((n, l) => n + (l.match(WORD)?.length ?? 0), 0) / lines.length) : 0;
	}
	const status = characters < OPTIMAL_MEASURE.min ? 'too-short' : characters > OPTIMAL_MEASURE.max ? 'too-long' : 'optimal';
	let lineRecommendation: string | undefined;
	if (status === 'too-long') {
		lineRecommendation = `Lines average ${characters} characters; keep body text to ${OPTIMAL_MEASURE.min}–${OPTIMAL_MEASURE.max} (about 66 is ideal) by narrowing the column, e.g. max-width: 66ch.`;
		issues.push(lineRecommendation);
	} else if (status === 'too-short' && source === 'width') {
		lineRecommendation = `Lines fit about ${characters} characters; short lines break reading rhythm. Widen the column or reduce the font size to reach ${OPTIMAL_MEASURE.min}–${OPTIMAL_MEASURE.max}.`;
		issues.push(lineRecommendation);
	} else if (status === 'too-short' && lines.length > 1) {
		lineRecommendation = `Lines average ${characters} characters; for body text aim for ${OPTIMAL_MEASURE.min}–${OPTIMAL_MEASURE.max}. Short lines are fine for headings, captions and lists.`;
		issues.push(lineRecommendation);
	} else if (status === 'too-short') {
		lineRecommendation = `A single line of ${characters} characters: the ${OPTIMAL_MEASURE.min}–${OPTIMAL_MEASURE.max} range applies to wrapped paragraphs; pass width and size to estimate their measure.`;
	}

	const assumed = font.lineHeight === undefined;
	const ratio = font.lineHeight ?? ASSUMED_NORMAL_LINE_HEIGHT;
	const meetsRecommended = ratio >= RECOMMENDED_LINE_HEIGHT;
	const spacingRecommendation = meetsRecommended
		? undefined
		: `Line height ${ratio}${assumed ? ' (assumed browser normal)' : ''} is below ${RECOMMENDED_LINE_HEIGHT}; set at least ${RECOMMENDED_LINE_HEIGHT} for paragraphs (WCAG 1.4.8), and make sure the layout survives 1.5 line height, 0.12em letter spacing and 0.16em word spacing (WCAG 1.4.12).`;
	if (spacingRecommendation && (lines.length > 1 || source === 'width' || words.length > 12)) issues.push(spacingRecommendation);

	const letters = text.match(/\p{L}/gu) ?? [];
	const allCaps = letters.length >= 2 && !/\p{Ll}/u.test(text) && /\p{Lu}/u.test(text);
	if (allCaps && words.length > 5) issues.push('Long runs of capitals are slower to read; set body text in sentence case and use text-transform or small caps only for short labels.');

	if (font.size !== undefined && font.size < 12) issues.push(`Font size ${font.size}px is below 12px; most body text should be 16px or more.`);
	if (font.letterSpacing !== undefined && font.letterSpacing < -0.05) issues.push(`Letter spacing ${font.letterSpacing}em is very tight; letters may collide below -0.05em.`);

	return {
		lineLength: { characters, words: wordsPerLine, source, status, ...(lineRecommendation ? { recommendation: lineRecommendation } : {}) },
		lineSpacing: { ratio, assumed, meetsRecommended, ...(spacingRecommendation ? { recommendation: spacingRecommendation } : {}) },
		allCaps,
		wordCount: words.length,
		estimatedReadingTimeSeconds: Math.round((words.length / READING_WORDS_PER_MINUTE) * 60),
		issues
	};
}
