/**
 * CSS `font-family` stacks: parsing, formatting and cross-platform fallbacks.
 */

import type { FontCategory } from './types.js';
import { guessFontCategory } from './catalog.js';

/** Generic family keywords; these must stay unquoted in `font-family`. */
export const GENERIC_FONT_FAMILIES: readonly string[] = [
	'serif',
	'sans-serif',
	'monospace',
	'cursive',
	'fantasy',
	'system-ui',
	'ui-serif',
	'ui-sans-serif',
	'ui-monospace',
	'ui-rounded',
	'math',
	'emoji',
	'fangsong'
];

export type FontStackName = 'system-ui' | 'humanist-sans' | 'geometric-sans' | 'editorial-serif' | 'transitional-serif' | 'code-mono' | 'handwriting' | 'display';

/** Tested cross-platform stacks, each ending in a generic family. */
export const FONT_STACKS: Readonly<Record<FontStackName, string>> = {
	'system-ui': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
	'humanist-sans': 'Optima, Candara, Calibri, "Trebuchet MS", "Noto Sans", sans-serif',
	'geometric-sans': '"Century Gothic", Futura, "Avenir Next", Avenir, "URW Gothic L", sans-serif',
	'editorial-serif': 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif',
	'transitional-serif': 'Baskerville, "Baskerville Old Face", "Hoefler Text", Garamond, "Times New Roman", Times, serif',
	'code-mono': 'ui-monospace, "SFMono-Regular", "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
	handwriting: '"Segoe Print", "Bradley Hand", Chilanka, "Comic Sans MS", cursive',
	display: 'Impact, Haettenschweiler, "Arial Narrow Bold", "Franklin Gothic Bold", sans-serif'
};

export const FONT_STACK_NAMES = Object.keys(FONT_STACKS) as FontStackName[];

/** The stack used as a fallback for each category. */
export const CATEGORY_FALLBACK_STACK: Readonly<Record<FontCategory, FontStackName>> = {
	'sans-serif': 'system-ui',
	serif: 'editorial-serif',
	monospace: 'code-mono',
	display: 'system-ui',
	handwriting: 'handwriting'
};

const GENERIC = new Set(GENERIC_FONT_FAMILIES);

/**
 * Splits a CSS `font-family` value into unquoted family names. Handles single and double quotes,
 * backslash escapes and commas inside quotes; collapses white space in unquoted names.
 */
export function parseFontFamily(stack: string): string[] {
	const out: string[] = [];
	let current = '';
	let quote: string | null = null;
	let quoted = false;
	const push = () => {
		const name = quoted ? current : current.trim().replace(/\s+/g, ' ');
		if (name) out.push(name);
		current = '';
		quoted = false;
	};
	for (let i = 0; i < stack.length; i++) {
		const ch = stack[i]!;
		if (ch === '\\' && i + 1 < stack.length) {
			current += stack[++i];
			continue;
		}
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			quoted = true;
			current = '';
			continue;
		}
		if (ch === ',') {
			push();
			continue;
		}
		if (quoted) continue; // text after a closing quote before the comma is ignored
		current += ch;
	}
	push();
	return out;
}

/** Quotes a family name for CSS when it needs it (generic keywords are never quoted). */
export function quoteFontFamily(name: string): string {
	if (GENERIC.has(name)) return name;
	// Every space-separated word must be a CSS identifier for the name to stay unquoted.
	const ident = /^-?[_a-zA-Z\u00a0-\uffff][_a-zA-Z0-9\u00a0-\uffff-]*$/;
	if (!name.includes(' ') && ident.test(name)) return name;
	return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Joins family names into a CSS `font-family` value, dropping duplicates (case-insensitive). */
export function formatFontFamily(families: readonly string[]): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const f of families) {
		const key = f.toLowerCase();
		if (!f || seen.has(key)) continue;
		seen.add(key);
		out.push(quoteFontFamily(f));
	}
	return out.join(', ');
}

/**
 * A resilient `font-family` value for a family: the family (or every family of a stack passed
 * in), then the stack for its category, ending in a generic family.
 */
export function resolveFontFallback(family: string, category?: FontCategory): string {
	const families = parseFontFamily(family);
	if (!families.length) throw new Error('family must name at least one font.');
	// A stack that already ends in a generic family is complete.
	if (GENERIC.has(families[families.length - 1]!)) return formatFontFamily(families);
	const cat = category ?? guessFontCategory(families[0]!);
	return formatFontFamily([...families, ...parseFontFamily(FONT_STACKS[CATEGORY_FALLBACK_STACK[cat]])]);
}
