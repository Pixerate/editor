import { hexToRgba, normalizeTokenColor, rgbaToHex } from '../tokens/color.js';
import { rgbToOklab as coreRgbToOklab, oklabToRgb as coreOklabToRgb, mixColors } from '../color/index.js';

/**
 * Colour interpolation in OKLab (Björn Ottosson's perceptual space, as CSS Color 4 uses for
 * `color-mix(in oklab, …)`), with premultiplied alpha so a fade to `transparent` does not
 * darken through black.
 */

export interface OklabColor {
	/** Lightness, 0–1. */
	l: number;
	a: number;
	b: number;
	/** Alpha, 0–1. */
	alpha: number;
}

/** sRGB channels (0–1) to OKLab. */
export function rgbToOklab(r: number, g: number, b: number, alpha = 1): OklabColor {
	const lab = coreRgbToOklab({ r, g, b, a: alpha });
	return { l: lab.l, a: lab.a, b: lab.b, alpha: lab.alpha };
}

/** OKLab to sRGB channels (0–1, clamped into gamut). */
export function oklabToRgb(color: OklabColor): { r: number; g: number; b: number; a: number } {
	const c = coreOklabToRgb({ l: color.l, a: color.a, b: color.b, alpha: color.alpha });
	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	return {
		r: clamp01(c.r),
		g: clamp01(c.g),
		b: clamp01(c.b),
		a: clamp01(c.a)
	};
}

/** Parses a CSS colour (hex, `rgb()` / `rgba()`, `transparent`, `black`, `white`) to OKLab, or `null`. */
export function parseOklab(input: unknown): OklabColor | null {
	const hex = normalizeTokenColor(input);
	if (hex === null) return null;
	const c = hexToRgba(hex)!;
	return rgbToOklab(c.r, c.g, c.b, c.a);
}

/** Formats OKLab as `#rrggbb` (or `#rrggbbaa` when translucent). */
export function formatOklab(color: OklabColor): string {
	const { r, g, b, a } = oklabToRgb(color);
	return rgbaToHex(r, g, b, a);
}

/**
 * Mixes two colours at `t` (0 = `from`, 1 = `to`) in OKLab with premultiplied alpha.
 * Returns `null` when either is not a readable colour.
 */
export function mixColorsOklab(from: unknown, to: unknown, t: number): string | null {
	return mixColors(from, to, t, { space: 'oklab' });
}
