/**
 * Accessible foreground suggestions: the nearest OKLCH lightness that meets WCAG 2 AA.
 */

import { contrastLevel, contrastRatio } from './contrast.js';
import { oklabToOklch, oklabToRgb, oklchToOklab, rgbToOklab } from './convert.js';
import { formatHex } from './format.js';
import { toSrgbGamut } from './gamut.js';
import { parseColor } from './parse.js';
import type { Rgba } from './types.js';

/**
 * The foreground colour (as hex) closest in OKLCH lightness to `foreground` that meets WCAG 2 AA
 * against `background`, keeping hue and chroma. `large` uses the 3:1 large-text threshold.
 * `undefined` when no lightness passes (only possible for mid-grey backgrounds at extreme targets).
 */
export function suggestAccessibleForeground(foreground: Rgba, background: Rgba, options: { large?: boolean } = {}): string | undefined {
	const large = options.large ?? false;
	const lch = oklabToOklch(rgbToOklab(foreground));
	// Judge the colour as returned: rounding to 8-bit hex can move a ratio by a few hundredths,
	// enough to drop a candidate that only just passed back below the threshold.
	const asHex = (l: number): Rgba => parseColor(formatHex(toSrgbGamut(oklabToRgb(oklchToOklab({ ...lch, l })))))!;
	for (let d = 0.01; d <= 1; d += 0.01) {
		const downCand = asHex(Math.max(0, lch.l - d));
		const upCand = asHex(Math.min(1, lch.l + d));
		const downRatio = contrastRatio(downCand, background);
		const upRatio = contrastRatio(upCand, background);
		const downPass = contrastLevel(downRatio, { large }) !== 'fail';
		const upPass = contrastLevel(upRatio, { large }) !== 'fail';
		if (downPass && upPass) return formatHex(downRatio >= upRatio ? downCand : upCand);
		if (downPass) return formatHex(downCand);
		if (upPass) return formatHex(upCand);
	}
	return undefined;
}
