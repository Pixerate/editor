/**
 * Contrast checks that know the type: WCAG 2 large-text eligibility comes from the font's size and
 * weight, so callers never have to decide whether text is "large".
 */

import { contrastLevel, contrastRatio } from '../color/contrast.js';
import { parseColor } from '../color/parse.js';
import { suggestAccessibleForeground } from '../color/suggest.js';
import type { ContrastLevel } from '../color/types.js';
import type { FontWeight } from './types.js';
import { normalizeFontWeight } from './weight.js';

/** WCAG 2 large text: 18pt (24px) regular, or 14pt (18.67px) bold. */
export const LARGE_TEXT_PX = 24;
export const LARGE_BOLD_TEXT_PX = (14 * 4) / 3;

/** Whether text counts as large for WCAG 2 contrast (size in CSS px). */
export function isLargeText(font: { size: number; weight?: FontWeight }): boolean {
	const bold = normalizeFontWeight(font.weight) >= 700;
	// Tolerate rounding of 18.67px (e.g. 18.66 or 18.7) for bold text.
	return font.size >= LARGE_TEXT_PX || (bold && font.size >= LARGE_BOLD_TEXT_PX - 0.01);
}

export interface TypographyAccessibilityResult {
	/** WCAG 2 contrast ratio, 1–21. */
	ratio: number;
	large: boolean;
	level: ContrastLevel;
	passesAA: boolean;
	passesAAA: boolean;
	/** Ratios this text needs: 4.5 / 7 for normal text, 3 / 4.5 for large text. */
	required: { AA: number; AAA: number };
	/** A foreground (hex) at the nearest OKLCH lightness that passes AA, when AA fails. */
	suggestion?: string;
	/** Smallest size in px that would count as large text at this weight. */
	largeTextMinSize: number;
	issues: string[];
}

/**
 * Checks text colour against its background using the type's real size and weight: decides large
 * text, reports the required ratios, and suggests a passing foreground when AA fails.
 */
export function checkTypographyAccessibility(options: {
	font: { size: number; weight?: FontWeight };
	foreground: string;
	background: string;
}): TypographyAccessibilityResult {
	const { font } = options;
	if (!Number.isFinite(font.size) || font.size <= 0) throw new Error(`Font size ${font.size} must be a positive number of px.`);
	const fg = parseColor(options.foreground);
	if (!fg) throw new Error(`"${options.foreground}" is not a colour I can read; use hex (#2a4b8d), rgb(), hsl(), oklch() or a CSS colour name.`);
	const bg = parseColor(options.background);
	if (!bg) throw new Error(`"${options.background}" is not a colour I can read; use hex (#ffffff), rgb(), hsl(), oklch() or a CSS colour name.`);

	const large = isLargeText(font);
	const ratio = Math.round(contrastRatio(fg, bg) * 100) / 100;
	const level = contrastLevel(ratio, { large });
	const passesAA = level !== 'fail';
	const bold = normalizeFontWeight(font.weight) >= 700;
	const issues: string[] = [];
	const required = large ? { AA: 3, AAA: 4.5 } : { AA: 4.5, AAA: 7 };
	if (!passesAA) issues.push(`Contrast ${ratio}:1 is below the ${required.AA}:1 AA minimum for ${large ? 'large' : 'normal'} text.`);
	if (font.size < 12) issues.push(`${font.size}px text is hard to read at any contrast; use 12px or more (16px for body text).`);
	const weight = normalizeFontWeight(font.weight);
	if (weight <= 300 && font.size < 24) issues.push(`Weight ${weight} at ${font.size}px has thin strokes that lower effective contrast; use 400 or heavier below 24px.`);
	const suggestion = passesAA ? undefined : suggestAccessibleForeground(fg, bg, { large });
	return {
		ratio,
		large,
		level,
		passesAA,
		passesAAA: level === 'AAA',
		required,
		...(suggestion ? { suggestion } : {}),
		largeTextMinSize: Math.round((bold ? LARGE_BOLD_TEXT_PX : LARGE_TEXT_PX) * 100) / 100,
		issues
	};
}
