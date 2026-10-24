/**
 * Colour formatting to hex, rgb, hsl, oklab, oklch and Display P3 strings.
 */

import { toSrgbGamut } from './gamut.js';
import { parseColor } from './parse.js';
import {
	rgbToHsl,
	rgbToOklab,
	oklabToOklch,
	srgbToLinear,
	linearToSrgb,
	linearSrgbToDisplayP3
} from './convert.js';
import type { Rgba, ColorFormat } from './types.js';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const byte = (v: number) => Math.round(clamp01(v) * 255);
const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const round2 = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * Gamut-maps to sRGB if needed, then formats as lowercase `#rrggbb` (or `#rrggbbaa` when alpha < 1).
 */
export function formatHex(c: Rgba): string {
	const mapped = toSrgbGamut(c);
	const head = `#${hex2(byte(mapped.r))}${hex2(byte(mapped.g))}${hex2(byte(mapped.b))}`;
	const alpha = byte(mapped.a);
	return alpha === 255 ? head : head + hex2(alpha);
}

/** Formats an Rgba value into the specified CSS colour format. */
export function formatColor(c: Rgba, format: ColorFormat): string {
	switch (format) {
		case 'hex':
			return formatHex(c);

		case 'rgb': {
			const inGamut = toSrgbGamut(c);
			const r = byte(inGamut.r);
			const g = byte(inGamut.g);
			const b = byte(inGamut.b);
			return c.a < 1
				? `rgb(${r} ${g} ${b} / ${round2(c.a)})`
				: `rgb(${r} ${g} ${b})`;
		}

		case 'hsl': {
			const hsl = rgbToHsl(toSrgbGamut(c));
			const h = (Math.round(hsl.h * 100) / 100).toString();
			const s = (Math.round(hsl.s * 10000) / 100).toString();
			const l = (Math.round(hsl.l * 10000) / 100).toString();
			return c.a < 1
				? `hsl(${h} ${s}% ${l}% / ${round2(c.a)})`
				: `hsl(${h} ${s}% ${l}%)`;
		}

		case 'oklch': {
			const lch = oklabToOklch(rgbToOklab(c));
			const l = (lch.l * 100).toFixed(2);
			const ch = lch.c.toFixed(4);
			const h = lch.h.toFixed(2);
			return c.a < 1
				? `oklch(${l}% ${ch} ${h} / ${round2(c.a)})`
				: `oklch(${l}% ${ch} ${h})`;
		}

		case 'oklab': {
			const lab = rgbToOklab(c);
			const l = (lab.l * 100).toFixed(2);
			const a = lab.a.toFixed(4);
			const b = lab.b.toFixed(4);
			return c.a < 1
				? `oklab(${l}% ${a} ${b} / ${round2(c.a)})`
				: `oklab(${l}% ${a} ${b})`;
		}

		case 'p3': {
			const linSrgb = {
				r: srgbToLinear(c.r),
				g: srgbToLinear(c.g),
				b: srgbToLinear(c.b),
				a: c.a
			};
			const linP3 = linearSrgbToDisplayP3(linSrgb);
			const r = linearToSrgb(linP3.r).toFixed(4);
			const g = linearToSrgb(linP3.g).toFixed(4);
			const b = linearToSrgb(linP3.b).toFixed(4);
			return c.a < 1
				? `color(display-p3 ${r} ${g} ${b} / ${round2(c.a)})`
				: `color(display-p3 ${r} ${g} ${b})`;
		}
	}
}

/** Parses the input and returns it as normalised lowercase hex, or null on failure. */
export function normalizeColor(input: unknown): string | null {
	const parsed = parseColor(input);
	return parsed ? formatHex(parsed) : null;
}
