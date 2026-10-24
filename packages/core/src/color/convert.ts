/**
 * Colour space conversion math: sRGB ↔ linear, HSL, HSV, OKLab, OKLCH and Display P3.
 */

import { rgbToXyzMatrix, invert, mul, apply, D65_XY, xyToXyz } from '../cms/math.js';
import type { Rgba, Hsla, Hsva, Oklab, Oklch } from './types.js';

/** Converts an sRGB gamma-encoded channel (0–1 nominally) to linear sRGB, keeping sign. */
export function srgbToLinear(v: number): number {
	const sign = Math.sign(v);
	const abs = Math.abs(v);
	return sign * (abs <= 0.04045 ? abs / 12.92 : ((abs + 0.055) / 1.055) ** 2.4);
}

/** Converts a linear sRGB channel to sRGB gamma-encoded, keeping sign. */
export function linearToSrgb(v: number): number {
	const sign = Math.sign(v);
	const abs = Math.abs(v);
	return sign * (abs <= 0.0031308 ? 12.92 * abs : 1.055 * abs ** (1 / 2.4) - 0.055);
}

/** Converts sRGB channels (0–1) to HSL with h in 0–360, s and l in 0–1. */
export function rgbToHsl(rgba: Rgba): Hsla {
	const { r, g, b, a } = rgba;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const l = (max + min) / 2;
	let h = 0;
	if (d > 0) {
		if (max === r) h = 60 * (((g - b) / d) % 6);
		else if (max === g) h = 60 * ((b - r) / d + 2);
		else h = 60 * ((r - g) / d + 4);
	}
	if (h < 0) h += 360;
	const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	return { h, s, l, alpha: a };
}

/** Converts HSL with h in 0–360, s and l in 0–1 to sRGB channels (0–1). */
export function hslToRgb(hsla: Hsla): Rgba {
	const { h, s, l, alpha } = hsla;
	const hh = (((h % 360) + 360) % 360) / 60;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs((hh % 2) - 1));
	const m = l - c / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (hh < 1) { r = c; g = x; b = 0; }
	else if (hh < 2) { r = x; g = c; b = 0; }
	else if (hh < 3) { r = 0; g = c; b = x; }
	else if (hh < 4) { r = 0; g = x; b = c; }
	else if (hh < 5) { r = x; g = 0; b = c; }
	else { r = c; g = 0; b = x; }
	return { r: r + m, g: g + m, b: b + m, a: alpha };
}

/** Converts sRGB channels (0–1) to HSV with h in 0–360, s and v in 0–1. */
export function rgbToHsv(rgba: Rgba): Hsva {
	const { r, g, b, a } = rgba;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	let h = 0;
	if (d > 0) {
		if (max === r) h = 60 * (((g - b) / d) % 6);
		else if (max === g) h = 60 * ((b - r) / d + 2);
		else h = 60 * ((r - g) / d + 4);
	}
	if (h < 0) h += 360;
	const s = max === 0 ? 0 : d / max;
	return { h, s, v: max, alpha: a };
}

/** Converts HSV with h in 0–360, s and v in 0–1 to sRGB channels (0–1). */
export function hsvToRgb(hsva: Hsva): Rgba {
	const { h, s, v, alpha } = hsva;
	const hh = (((h % 360) + 360) % 360) / 60;
	const c = v * s;
	const x = c * (1 - Math.abs((hh % 2) - 1));
	const m = v - c;
	let r = 0;
	let g = 0;
	let b = 0;
	if (hh < 1) { r = c; g = x; b = 0; }
	else if (hh < 2) { r = x; g = c; b = 0; }
	else if (hh < 3) { r = 0; g = c; b = x; }
	else if (hh < 4) { r = 0; g = x; b = c; }
	else if (hh < 5) { r = x; g = 0; b = c; }
	else { r = c; g = 0; b = x; }
	return { r: r + m, g: g + m, b: b + m, a: alpha };
}

/** Converts sRGB channels (0–1) to OKLab. Wide-gamut inputs are unclamped. */
export function rgbToOklab(rgba: Rgba): Oklab {
	const lr = srgbToLinear(rgba.r);
	const lg = srgbToLinear(rgba.g);
	const lb = srgbToLinear(rgba.b);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return {
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
		alpha: rgba.a
	};
}

/** Converts OKLab to sRGB channels without clamping. */
export function oklabToRgb(lab: Oklab): Rgba {
	const l_ = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
	const m_ = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
	const s_ = lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b;
	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;
	return {
		r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
		a: lab.alpha
	};
}

/** Converts OKLab to OKLCH with h in degrees 0–360 (0 when c < 1e-6). */
export function oklabToOklch(lab: Oklab): Oklch {
	const c = Math.hypot(lab.a, lab.b);
	let h = 0;
	if (c >= 1e-6) {
		h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
		if (h < 0) h += 360;
		if (h >= 360) h -= 360;
	}
	return { l: lab.l, c, h, alpha: lab.alpha };
}

/** Converts OKLCH with h in degrees to OKLab. */
export function oklchToOklab(lch: Oklch): OklchToOklabResult {
	const rad = (lch.h * Math.PI) / 180;
	return {
		l: lch.l,
		a: lch.c * Math.cos(rad),
		b: lch.c * Math.sin(rad),
		alpha: lch.alpha
	};
}
type OklchToOklabResult = Oklab;

// Precompute linear sRGB ↔ Display P3 matrices relative to D65.
const D65_XYZ = xyToXyz(D65_XY);
const SRGB_TO_XYZ = rgbToXyzMatrix([0.64, 0.33], [0.30, 0.60], [0.15, 0.06], D65_XYZ)!;
const P3_TO_XYZ = rgbToXyzMatrix([0.680, 0.320], [0.265, 0.690], [0.150, 0.060], D65_XYZ)!;
const XYZ_TO_SRGB = invert(SRGB_TO_XYZ)!;
const XYZ_TO_P3 = invert(P3_TO_XYZ)!;
const P3_TO_SRGB_MAT = mul(XYZ_TO_SRGB, P3_TO_XYZ);
const SRGB_TO_P3_MAT = mul(XYZ_TO_P3, SRGB_TO_XYZ);

/** Converts linear sRGB channels to linear Display P3 channels (linear in, linear out). */
export function linearSrgbToDisplayP3(rgb: Rgba): Rgba {
	const out = apply(SRGB_TO_P3_MAT, [rgb.r, rgb.g, rgb.b]);
	return { r: out[0], g: out[1], b: out[2], a: rgb.a };
}

/** Converts linear Display P3 channels to linear sRGB channels (linear in, linear out). */
export function displayP3ToLinearSrgb(rgb: Rgba): Rgba {
	const out = apply(P3_TO_SRGB_MAT, [rgb.r, rgb.g, rgb.b]);
	return { r: out[0], g: out[1], b: out[2], a: rgb.a };
}
