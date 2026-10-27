/**
 * Host-agnostic text segmentation (graphemes, words, sentences, lines) with UTF-16 offsets, so
 * live text can be split for staggered animation without converting it to outlines.
 */

import type { SegmentGranularity, TextSegment } from './types.js';

export interface SegmentTextOptions {
	/** BCP 47 locale for `Intl.Segmenter` (default: the runtime's). */
	locale?: string;
	/** For `word`: return only word-like segments, dropping white space and punctuation (default false). */
	wordsOnly?: boolean;
	/**
	 * For `line`: wrap each hard line greedily at word boundaries so no line exceeds this many
	 * characters (a word longer than that gets a line of its own). Omit to split on line breaks only.
	 */
	maxCharacters?: number;
}

type IntlSegmenter = {
	segment(text: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }>;
};

function segmenter(granularity: 'grapheme' | 'word' | 'sentence', locale?: string): IntlSegmenter | null {
	const Ctor = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => IntlSegmenter }).Segmenter;
	return Ctor ? new Ctor(locale, { granularity }) : null;
}

/** Grapheme clusters as strings (falls back to code points without `Intl.Segmenter`). */
export function graphemes(text: string, locale?: string): string[] {
	const seg = segmenter('grapheme', locale);
	return seg ? Array.from(seg.segment(text), (s) => s.segment) : Array.from(text);
}

/** Number of user-perceived characters (grapheme clusters). */
export function countGraphemes(text: string, locale?: string): number {
	return graphemes(text, locale).length;
}

function rawSegments(text: string, granularity: 'grapheme' | 'word' | 'sentence', locale?: string): Omit<TextSegment, 'index'>[] {
	const seg = segmenter(granularity, locale);
	if (seg) {
		return Array.from(seg.segment(text), (s) => ({
			text: s.segment,
			start: s.index,
			end: s.index + s.segment.length,
			...(granularity === 'word' ? { isWordLike: !!s.isWordLike } : {})
		}));
	}
	// Fallbacks for runtimes without Intl.Segmenter.
	const out: Omit<TextSegment, 'index'>[] = [];
	if (granularity === 'grapheme') {
		let i = 0;
		for (const ch of text) {
			out.push({ text: ch, start: i, end: i + ch.length });
			i += ch.length;
		}
		return out;
	}
	const re = granularity === 'word' ? /[\p{L}\p{N}\p{M}'’_-]+|\s+|[^\p{L}\p{N}\p{M}\s]/gu : /[^.!?]*(?:[.!?]+|$)\s*/g;
	for (const m of text.matchAll(re)) {
		if (!m[0]) continue;
		out.push({
			text: m[0],
			start: m.index!,
			end: m.index! + m[0].length,
			...(granularity === 'word' ? { isWordLike: /[\p{L}\p{N}]/u.test(m[0]) } : {})
		});
	}
	return out;
}

function lineSegments(text: string, maxCharacters: number | undefined, locale?: string): Omit<TextSegment, 'index'>[] {
	const out: Omit<TextSegment, 'index'>[] = [];
	const re = /\r\n|\n|\r|\u2028|\u2029/g;
	let lineStart = 0;
	const hardLines: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(re)) {
		hardLines.push({ start: lineStart, end: m.index! });
		lineStart = m.index! + m[0].length;
	}
	hardLines.push({ start: lineStart, end: text.length });
	for (const { start, end } of hardLines) {
		const line = text.slice(start, end);
		if (!maxCharacters || countGraphemes(line, locale) <= maxCharacters) {
			out.push({ text: line, start, end });
			continue;
		}
		// Greedy wrap at word boundaries: a break goes before a word, and trailing spaces stay on the line they end.
		const words = rawSegments(line, 'word', locale);
		let segStart = 0;
		let length = 0;
		let lastEnd = 0;
		for (const w of words) {
			const n = countGraphemes(w.text, locale);
			const isSpace = !w.isWordLike && /^\s+$/.test(w.text);
			if (!isSpace && length > 0 && length + n > maxCharacters) {
				out.push({ text: line.slice(segStart, w.start), start: start + segStart, end: start + w.start });
				segStart = w.start;
				length = 0;
			}
			length += n;
			lastEnd = w.end;
		}
		out.push({ text: line.slice(segStart, lastEnd), start: start + segStart, end: start + lastEnd });
	}
	return out;
}

/**
 * Splits text into graphemes, words, sentences or lines. Offsets are UTF-16 indexes into `text`,
 * so `text.slice(start, end) === segment.text`. `line` splits on line breaks (and wraps when
 * `maxCharacters` is set); it cannot know how a renderer will wrap without a measure.
 */
export function segmentText(text: string, granularity: SegmentGranularity, options: SegmentTextOptions = {}): TextSegment[] {
	if (typeof text !== 'string') throw new Error('text must be a string.');
	let segments: Omit<TextSegment, 'index'>[];
	if (granularity === 'line') {
		if (options.maxCharacters !== undefined && (!Number.isInteger(options.maxCharacters) || options.maxCharacters < 1)) {
			throw new Error(`maxCharacters must be a positive integer (got ${options.maxCharacters}).`);
		}
		segments = lineSegments(text, options.maxCharacters, options.locale);
	} else if (granularity === 'grapheme' || granularity === 'word' || granularity === 'sentence') {
		segments = rawSegments(text, granularity, options.locale);
		if (granularity === 'word' && options.wordsOnly) segments = segments.filter((s) => s.isWordLike);
	} else {
		throw new Error(`Unknown granularity "${String(granularity)}"; use grapheme, word, sentence or line.`);
	}
	return segments.map((s, index) => ({ ...s, index }));
}
