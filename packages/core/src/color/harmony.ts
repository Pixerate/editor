/**
 * Colour harmonies on the RGB and painter's RYB colour wheels.
 */

import { hslToRgb, hsvToRgb, rgbToHsl, rgbToHsv } from './convert.js';
import type { Rgba } from './types.js';

export type ColorWheel = 'ryb' | 'rgb';

export type HarmonyKind =
	| 'complementary'
	| 'split-complementary'
	| 'analogous'
	| 'triadic'
	| 'tetradic'
	| 'square'
	| 'monochromatic';

export const HARMONY_KINDS: readonly HarmonyKind[] = [
	'complementary',
	'split-complementary',
	'analogous',
	'triadic',
	'tetradic',
	'square',
	'monochromatic'
];

export interface HarmonyColor {
	color: string;
	/** Position on the wheel, degrees. */
	angle: number;
}

const HEX_6 = /^#?([0-9a-f]{6})$/i;

/** Reads `#rrggbb`; throws (as the paint editor always has) on anything else. */
function parseHex(value: unknown, what = 'color'): Rgba {
	const m = typeof value === 'string' ? HEX_6.exec(value.trim()) : null;
	if (!m) throw new Error(`${what} is ${JSON.stringify(value)}; use #rrggbb, e.g. "#2a4b8d".`);
	const n = parseInt(m[1], 16);
	return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

function toHex(c: Rgba): string {
	return '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

// RYB wheel angle → RGB hue (a piecewise-linear map through red, orange, yellow, green, blue, violet).
const RYB_STOPS: ReadonlyArray<[number, number]> = [
	[0, 0],
	[60, 30],
	[120, 60],
	[180, 120],
	[240, 240],
	[300, 280],
	[360, 360]
];

function piecewise(v: number, from: 0 | 1): number {
	const x = ((v % 360) + 360) % 360;
	const to = from === 0 ? 1 : 0;
	for (let i = 1; i < RYB_STOPS.length; i++) {
		const a = RYB_STOPS[i - 1];
		const b = RYB_STOPS[i];
		if (x <= b[from]) return a[to] + ((x - a[from]) / (b[from] - a[from])) * (b[to] - a[to]);
	}
	return x;
}

/** Converts a wheel angle in degrees to an RGB hue. */
export function wheelToHue(angle: number, wheel: ColorWheel): number {
	return wheel === 'rgb' ? ((angle % 360) + 360) % 360 : piecewise(angle, 0);
}

/** Converts an RGB hue in degrees to its angle on the selected wheel. */
export function hueToWheel(hue: number, wheel: ColorWheel): number {
	return wheel === 'rgb' ? ((hue % 360) + 360) % 360 : piecewise(hue, 1);
}

/**
 * Computes harmony colours around a base hex colour, with the base colour first.
 */
export function colorHarmony(
	base: string,
	kind: HarmonyKind,
	options: { wheel?: ColorWheel; spread?: number } = {}
): HarmonyColor[] {
	const wheel = options.wheel ?? 'ryb';
	const rgb = parseHex(base, 'base');
	const hsv = rgbToHsv(rgb);
	const start = hueToWheel(hsv.h, wheel);

	const at = (angle: number): HarmonyColor => {
		const a = ((angle % 360) + 360) % 360;
		return { color: toHex(hsvToRgb({ ...hsv, h: wheelToHue(a, wheel) })), angle: Math.round(a * 10) / 10 };
	};

	const spread = options.spread ?? 30;
	const offsets: Record<Exclude<HarmonyKind, 'monochromatic'>, number[]> = {
		complementary: [0, 180],
		'split-complementary': [0, 180 - spread, 180 + spread],
		analogous: [0, -spread, spread],
		triadic: [0, 120, 240],
		tetradic: [0, 60, 180, 240],
		square: [0, 90, 180, 270]
	};

	if (kind === 'monochromatic') {
		const hsl = rgbToHsl(rgb);
		const steps = [0, -0.3, -0.15, 0.15, 0.3];
		return steps.map((d) => {
			const c = d === 0 ? rgb : hslToRgb({ ...hsl, l: Math.min(0.97, Math.max(0.03, hsl.l + d)) });
			return { color: toHex(c), angle: Math.round(start * 10) / 10 };
		});
	}

	return offsets[kind].map((o, i) =>
		i === 0 ? { color: toHex(rgb), angle: Math.round(start * 10) / 10 } : at(start + o)
	);
}
