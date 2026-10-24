/**
 * Gamut checking and gamut mapping using CSS Color 4 OKLCH chroma binary search.
 */

import { rgbToOklab, oklabToOklch, oklchToOklab, oklabToRgb } from './convert.js';
import type { Rgba } from './types.js';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Checks whether all sRGB channels are within [0, 1] within a tolerance epsilon. */
export function inSrgbGamut(c: Rgba, epsilon = 1e-5): boolean {
	return (
		c.r >= -epsilon &&
		c.r <= 1 + epsilon &&
		c.g >= -epsilon &&
		c.g <= 1 + epsilon &&
		c.b >= -epsilon &&
		c.b <= 1 + epsilon
	);
}

/** Euclidean colour distance in OKLab space. */
export function deltaEOK(a: Rgba, b: Rgba): number {
	const la = rgbToOklab(a);
	const lb = rgbToOklab(b);
	return Math.hypot(la.l - lb.l, la.a - lb.a, la.b - lb.b);
}

/**
 * Maps an out-of-gamut colour into the sRGB gamut using the CSS Color 4 binary search on OKLCH chroma.
 */
export function toSrgbGamut(c: Rgba): Rgba {
	const lch = oklabToOklch(rgbToOklab(c));

	if (lch.l >= 1) return { r: 1, g: 1, b: 1, a: c.a };
	if (lch.l <= 0) return { r: 0, g: 0, b: 0, a: c.a };

	if (inSrgbGamut(c)) {
		return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: c.a };
	}

	let low = 0;
	let high = lch.c;
	let clippedCandidate: Rgba = { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: c.a };
	const JND = 0.02;
	const EPS = 0.0001;

	for (let i = 0; i < 30; i++) {
		const mid = (low + high) / 2;
		const candidate = oklabToRgb(oklchToOklab({ l: lch.l, c: mid, h: lch.h, alpha: c.a }));
		const clipped: Rgba = {
			r: clamp01(candidate.r),
			g: clamp01(candidate.g),
			b: clamp01(candidate.b),
			a: c.a
		};
		clippedCandidate = clipped;
		const dE = deltaEOK(candidate, clipped);

		if (dE < JND) {
			if (JND - dE < EPS) {
				return clipped;
			}
			low = mid;
		} else {
			high = mid;
		}

		if (high - low < 1e-4) {
			break;
		}
	}

	return clippedCandidate;
}
