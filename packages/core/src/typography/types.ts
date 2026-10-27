/**
 * Core typography types: font specs, weights, categories, scales and readability results.
 */

/** Numeric CSS font weights, 100–900 in steps of 100. */
export type NumericFontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
/** A CSS font weight: numeric, or the `normal` (400) and `bold` (700) keywords. */
export type FontWeight = NumericFontWeight | 'normal' | 'bold';
export type FontStyle = 'normal' | 'italic' | 'oblique';
/** Broad classification used for filtering and for choosing a fallback stack. */
export type FontCategory = 'sans-serif' | 'serif' | 'monospace' | 'display' | 'handwriting';
/** Where a font comes from: installed on the system, loaded over the web, or supplied by the host. */
export type FontSource = 'system' | 'web' | 'custom';

export const FONT_CATEGORIES: readonly FontCategory[] = ['sans-serif', 'serif', 'monospace', 'display', 'handwriting'];
/** Display names for categories (and `all`), for filters and badges. */
export const FONT_CATEGORY_LABELS: Readonly<Record<FontCategory | 'all', string>> = {
	all: 'All',
	'sans-serif': 'Sans serif',
	serif: 'Serif',
	monospace: 'Monospace',
	display: 'Display',
	handwriting: 'Handwriting'
};
export const FONT_WEIGHTS: readonly NumericFontWeight[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];
export const FONT_STYLES: readonly FontStyle[] = ['normal', 'italic', 'oblique'];

/** Normalized specification for a typographic style. */
export interface FontSpec {
	/** Primary family name, unquoted (e.g. `Inter`). Use `resolveFontFallback` for a CSS stack. */
	family: string;
	/** Default 400. */
	weight?: FontWeight;
	/** Default `normal`. */
	style?: FontStyle;
	/** Font size in CSS px. */
	size: number;
	/** Unitless line-height multiplier (1.5 = 150 % of `size`). */
	lineHeight?: number;
	/** Tracking in em (0.05 = 5 % of `size`). */
	letterSpacing?: number;
	category?: FontCategory;
}

/** Named modular scale ratios. */
export type ModularScaleRatio =
	| 'minor-second'
	| 'major-second'
	| 'minor-third'
	| 'major-third'
	| 'perfect-fourth'
	| 'augmented-fourth'
	| 'perfect-fifth'
	| 'golden-ratio';

export interface TypeScaleStep {
	/** Token name, e.g. `body`, `h1`, or `step-3` for an unnamed step. */
	name: string;
	/** Integer exponent; 0 is the base size. */
	step: number;
	/** Computed size in px (rounded to 0.01). */
	size: number;
	/** Recommended unitless line-height. */
	lineHeight: number;
	/** Recommended tracking in em. */
	letterSpacing: number;
}

export interface TypeHierarchy {
	ratio: number;
	/** The named ratio, when one was used. */
	ratioName?: ModularScaleRatio;
	baseSize: number;
	steps: Record<string, TypeScaleStep>;
}

export interface ReadabilityAuditResult {
	lineLength: {
		/** Average characters (grapheme clusters) per line. */
		characters: number;
		/** Average words per line. */
		words: number;
		/** `lines` when measured from the text's own line breaks, `width` when estimated from a container width. */
		source: 'lines' | 'width';
		/** Optimal is 45–75 characters. */
		status: 'optimal' | 'too-short' | 'too-long';
		recommendation?: string;
	};
	lineSpacing: {
		/** Line-height multiplier used (1.2 when none was given: the browser `normal` approximation). */
		ratio: number;
		/** True when `ratio` was not given. */
		assumed: boolean;
		/** Line spacing is at least 1.5 (WCAG 1.4.8 / 1.4.12 body-text value). */
		meetsRecommended: boolean;
		recommendation?: string;
	};
	/** The text is set in capitals (two or more letters, none lower case). */
	allCaps: boolean;
	wordCount: number;
	/** Silent reading at 238 words per minute. */
	estimatedReadingTimeSeconds: number;
	/** Human-readable findings, empty when nothing needs attention. */
	issues: string[];
}

/** One piece of text from `segmentText`, with UTF-16 offsets into the original string. */
export interface TextSegment {
	text: string;
	/** UTF-16 offset of the first code unit. */
	start: number;
	/** UTF-16 offset just past the last code unit. */
	end: number;
	/** Position in the returned list. */
	index: number;
	/** For `word` granularity: whether the segment is a word (not white space or punctuation). */
	isWordLike?: boolean;
}

export type SegmentGranularity = 'grapheme' | 'word' | 'sentence' | 'line';
