/**
 * WCAG 2 contrast calculations, relative luminance and readability checks.
 */

import { srgbToLinear } from './convert.js';
import type { Rgba, ContrastLevel } from './types.js';

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };

function composite(fg: Rgba, bg: Rgba): Rgba {
	const a = fg.a + bg.a * (1 - fg.a);
	if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
	return {
		r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
		g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
		b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
		a
	};
}

/** Computes WCAG 2 relative luminance (0 for black, 1 for white). */
export function relativeLuminance(c: Rgba): number {
	const r = srgbToLinear(c.r);
	const g = srgbToLinear(c.g);
	const b = srgbToLinear(c.b);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Computes the WCAG 2 contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
	let bg = background;
	if (bg.a < 1) {
		bg = composite(bg, WHITE);
	}
	let fg = foreground;
	if (fg.a < 1) {
		fg = composite(fg, bg);
	}

	const lum1 = relativeLuminance(fg);
	const lum2 = relativeLuminance(bg);
	const brighter = Math.max(lum1, lum2);
	const darker = Math.min(lum1, lum2);
	return (brighter + 0.05) / (darker + 0.05);
}

/** Returns the WCAG contrast compliance level: 'AAA', 'AA', or 'fail'. */
export function contrastLevel(ratio: number, options?: { large?: boolean }): ContrastLevel {
	const large = options?.large ?? false;
	if (large) {
		if (ratio >= 4.5) return 'AAA';
		if (ratio >= 3) return 'AA';
		return 'fail';
	}
	if (ratio >= 7) return 'AAA';
	if (ratio >= 4.5) return 'AA';
	return 'fail';
}

/** Selects the candidate colour that has the highest contrast ratio against the background. */
export function readableTextColor(
	background: Rgba,
	candidates: readonly Rgba[] = [BLACK, WHITE]
): Rgba {
	let bestCandidate = candidates[0] ?? BLACK;
	let bestRatio = -1;
	for (const candidate of candidates) {
		const ratio = contrastRatio(candidate, background);
		if (ratio > bestRatio) {
			bestRatio = ratio;
			bestCandidate = candidate;
		}
	}
	return bestCandidate;
}
