/**
 * Colour harmonies on the RGB and painter's RYB colour wheels.
 */

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

function parseHex(value: unknown, what = 'color'): [number, number, number] {
	const m = typeof value === 'string' ? HEX_6.exec(value.trim()) : null;
	if (!m) throw new Error(`${what} is ${JSON.stringify(value)}; use #rrggbb, e.g. "#2a4b8d".`);
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
	return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

function localRgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
	const R = r / 255;
	const G = g / 255;
	const B = b / 255;
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	const d = max - min;
	let h = 0;
	if (d > 0) {
		if (max === R) h = 60 * (((G - B) / d) % 6);
		else if (max === G) h = 60 * ((B - R) / d + 2);
		else h = 60 * ((R - G) / d + 4);
	}
	if (h < 0) h += 360;
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

function localHsvToRgb(h: number, s: number, v: number): [number, number, number] {
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
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function localRgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
	const { h } = localRgbToHsv(r, g, b);
	const max = Math.max(r, g, b) / 255;
	const min = Math.min(r, g, b) / 255;
	const l = (max + min) / 2;
	const d = max - min;
	return { h, s: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)), l };
}

function localHslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const v = l + c / 2;
	return localHsvToRgb(h, v === 0 ? 0 : c / v, v);
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
	const [r, g, b] = parseHex(base, 'base');
	const hsv = localRgbToHsv(r, g, b);
	const start = hueToWheel(hsv.h, wheel);

	const at = (angle: number): HarmonyColor => {
		const a = ((angle % 360) + 360) % 360;
		const [rr, gg, bb] = localHsvToRgb(wheelToHue(a, wheel), hsv.s, hsv.v);
		return { color: toHex(rr, gg, bb), angle: Math.round(a * 10) / 10 };
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
		const hsl = localRgbToHsl(r, g, b);
		const steps = [0, -0.3, -0.15, 0.15, 0.3];
		return steps.map((d) => {
			const [rr, gg, bb] = d === 0 ? [r, g, b] : localHslToRgb(hsl.h, hsl.s, Math.min(0.97, Math.max(0.03, hsl.l + d)));
			return { color: toHex(rr, gg, bb), angle: Math.round(start * 10) / 10 };
		});
	}

	return offsets[kind].map((o, i) =>
		i === 0 ? { color: toHex(r, g, b), angle: Math.round(start * 10) / 10 } : at(start + o)
	);
}
