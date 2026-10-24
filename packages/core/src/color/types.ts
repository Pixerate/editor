/**
 * Core colour types: channel values, spaces, formats and vision deficiency modes.
 */

/** sRGB, gamma-encoded. Channels are nominally 0–1 but may fall outside for wide-gamut input; alpha 0–1. */
export interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

/** OKLab: l 0–1; a and b roughly −0.4–0.4; alpha 0–1. Same shape as `OklabColor` in `animation/color.ts`. */
export interface Oklab {
	l: number;
	a: number;
	b: number;
	alpha: number;
}

/** OKLCH: l 0–1, c ≥ 0 (≈0.4 max in practice), h in degrees 0–360 (NaN-free: use 0 when c is 0); alpha 0–1. */
export interface Oklch {
	l: number;
	c: number;
	h: number;
	alpha: number;
}

/** h in degrees 0–360; s, l 0–1; alpha 0–1. */
export interface Hsla {
	h: number;
	s: number;
	l: number;
	alpha: number;
}

/** h in degrees 0–360; s, v 0–1; alpha 0–1. */
export interface Hsva {
	h: number;
	s: number;
	v: number;
	alpha: number;
}

export type ColorFormat = 'hex' | 'rgb' | 'hsl' | 'oklch' | 'oklab' | 'p3';
export type ColorVision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia';
export type ContrastLevel = 'AAA' | 'AA' | 'fail';
