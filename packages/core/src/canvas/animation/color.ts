import { hexToRgba, normalizeTokenColor, rgbaToHex } from '../../tokens/color.js';

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

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.sign(c) * Math.abs(c) ** (1 / 2.4) - 0.055);

/** sRGB channels (0–1) to OKLab. */
export function rgbToOklab(r: number, g: number, b: number, alpha = 1): OklabColor {
	const lr = toLinear(r);
	const lg = toLinear(g);
	const lb = toLinear(b);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
		alpha
	};
}

/** OKLab to sRGB channels (0–1, clamped into gamut). */
export function oklabToRgb(color: OklabColor): { r: number; g: number; b: number; a: number } {
	const l_ = color.l + 0.3963377774 * color.a + 0.2158037573 * color.b;
	const m_ = color.l - 0.1055613458 * color.a - 0.0638541728 * color.b;
	const s_ = color.l - 0.0894841775 * color.a - 1.291485548 * color.b;
	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;
	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	return {
		r: clamp01(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
		g: clamp01(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
		b: clamp01(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
		a: clamp01(color.alpha)
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
	const a = parseOklab(from);
	const b = parseOklab(to);
	if (!a || !b) return null;
	const alpha = a.alpha + (b.alpha - a.alpha) * t;
	const premul = (k: 'l' | 'a' | 'b') => a[k] * a.alpha + (b[k] * b.alpha - a[k] * a.alpha) * t;
	if (alpha <= 1e-9) return formatOklab({ l: a.l + (b.l - a.l) * t, a: 0, b: 0, alpha: 0 });
	return formatOklab({ l: premul('l') / alpha, a: premul('a') / alpha, b: premul('b') / alpha, alpha });
}
