/**
 * CSS colour parsing for hex, rgb, hsl, oklab, oklch, Display P3 and CSS named colours.
 */

import { NAMED_COLORS } from './named.js';
import {
	hslToRgb,
	oklabToRgb,
	oklchToOklab,
	srgbToLinear,
	linearToSrgb,
	displayP3ToLinearSrgb
} from './convert.js';
import type { Rgba } from './types.js';

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(([^()]*)\)$/i;
const HSL_RE = /^hsla?\(([^()]*)\)$/i;
const OKLAB_RE = /^oklab\(([^()]*)\)$/i;
const OKLCH_RE = /^oklch\(([^()]*)\)$/i;
const COLOR_FN_RE = /^color\(([^()]*)\)$/i;

function parsePercentOrNumber(v: string, scale: number): number | null {
	const text = v.trim();
	const isPct = text.endsWith('%');
	const num = Number(isPct ? text.slice(0, -1) : text);
	if (!Number.isFinite(num)) return null;
	return isPct ? num / 100 : num / scale;
}

function parseAlpha(v: string | undefined): number | null {
	if (v === undefined || v.trim() === '') return 1;
	const text = v.trim();
	const isPct = text.endsWith('%');
	const num = Number(isPct ? text.slice(0, -1) : text);
	if (!Number.isFinite(num)) return null;
	return isPct ? num / 100 : num;
}

function parseAngle(v: string): number | null {
	const text = v.trim().toLowerCase();
	if (text.endsWith('deg')) {
		const num = Number(text.slice(0, -3));
		return Number.isFinite(num) ? num : null;
	}
	if (text.endsWith('turn')) {
		const num = Number(text.slice(0, -4));
		return Number.isFinite(num) ? num * 360 : null;
	}
	if (text.endsWith('rad')) {
		const num = Number(text.slice(0, -3));
		return Number.isFinite(num) ? (num * 180) / Math.PI : null;
	}
	const num = Number(text);
	return Number.isFinite(num) ? num : null;
}

function splitParts(inner: string): { parts: string[]; alphaPart?: string } {
	const slashIndex = inner.indexOf('/');
	let mainStr = inner;
	let alphaPart: string | undefined;
	if (slashIndex !== -1) {
		mainStr = inner.slice(0, slashIndex);
		alphaPart = inner.slice(slashIndex + 1);
	}
	const parts = mainStr.trim().split(/[\s,]+/).filter(Boolean);
	return { parts, alphaPart };
}

/**
 * Parses any supported CSS colour string or token object into an unclamped Rgba structure.
 * Returns null for unrecognised syntax or invalid values without throwing.
 */
export function parseColor(input: unknown): Rgba | null {
	if (typeof input === 'string') {
		const text = input.trim();
		if (text.length === 0 || text.length > 200) return null;
		const lower = text.toLowerCase();

		// Fast path: named colours
		const namedHex = NAMED_COLORS[lower];
		if (namedHex) {
			return parseHex(namedHex);
		}

		// Hex
		const hexMatch = HEX_RE.exec(text);
		if (hexMatch) {
			return parseHex(hexMatch[0]);
		}

		// rgb() / rgba()
		const rgbMatch = RGB_RE.exec(text);
		if (rgbMatch) {
			const { parts, alphaPart } = splitParts(rgbMatch[1]);
			let alphaVal: number | null = 1;
			if (alphaPart !== undefined) {
				alphaVal = parseAlpha(alphaPart);
			} else if (parts.length === 4) {
				alphaVal = parseAlpha(parts.pop());
			}
			if (parts.length !== 3 || alphaVal === null) return null;
			const r = parsePercentOrNumber(parts[0], 255);
			const g = parsePercentOrNumber(parts[1], 255);
			const b = parsePercentOrNumber(parts[2], 255);
			if (r === null || g === null || b === null) return null;
			return { r, g, b, a: alphaVal };
		}

		// hsl() / hsla()
		const hslMatch = HSL_RE.exec(text);
		if (hslMatch) {
			const { parts, alphaPart } = splitParts(hslMatch[1]);
			let alphaVal: number | null = 1;
			if (alphaPart !== undefined) {
				alphaVal = parseAlpha(alphaPart);
			} else if (parts.length === 4) {
				alphaVal = parseAlpha(parts.pop());
			}
			if (parts.length !== 3 || alphaVal === null) return null;
			const h = parseAngle(parts[0]);
			const s = parsePercentOrNumber(parts[1], 100);
			const l = parsePercentOrNumber(parts[2], 100);
			if (h === null || s === null || l === null) return null;
			return hslToRgb({ h, s, l, alpha: alphaVal });
		}

		// oklab()
		const oklabMatch = OKLAB_RE.exec(text);
		if (oklabMatch) {
			const { parts, alphaPart } = splitParts(oklabMatch[1]);
			let alphaVal: number | null = 1;
			if (alphaPart !== undefined) {
				alphaVal = parseAlpha(alphaPart);
			} else if (parts.length === 4) {
				alphaVal = parseAlpha(parts.pop());
			}
			if (parts.length !== 3 || alphaVal === null) return null;
			const l = parsePercentOrNumber(parts[0], 1);
			const a = parsePercentOrNumber(parts[1], 1);
			const b = parsePercentOrNumber(parts[2], 1);
			if (l === null || a === null || b === null) return null;
			return oklabToRgb({ l, a, b, alpha: alphaVal });
		}

		// oklch()
		const oklchMatch = OKLCH_RE.exec(text);
		if (oklchMatch) {
			const { parts, alphaPart } = splitParts(oklchMatch[1]);
			let alphaVal: number | null = 1;
			if (alphaPart !== undefined) {
				alphaVal = parseAlpha(alphaPart);
			} else if (parts.length === 4) {
				alphaVal = parseAlpha(parts.pop());
			}
			if (parts.length !== 3 || alphaVal === null) return null;
			const l = parsePercentOrNumber(parts[0], 1);
			const c = parsePercentOrNumber(parts[1], 1);
			const h = parseAngle(parts[2]);
			if (l === null || c === null || h === null) return null;
			return oklabToRgb(oklchToOklab({ l, c, h, alpha: alphaVal }));
		}

		// color()
		const colorMatch = COLOR_FN_RE.exec(text);
		if (colorMatch) {
			const { parts, alphaPart } = splitParts(colorMatch[1]);
			if (parts.length < 4) return null;
			const space = parts[0].toLowerCase();
			let alphaVal: number | null = 1;
			if (alphaPart !== undefined) {
				alphaVal = parseAlpha(alphaPart);
			} else if (parts.length === 5) {
				alphaVal = parseAlpha(parts.pop());
			}
			if (parts.length !== 4 || alphaVal === null) return null;
			const c1 = parsePercentOrNumber(parts[1], 1);
			const c2 = parsePercentOrNumber(parts[2], 1);
			const c3 = parsePercentOrNumber(parts[3], 1);
			if (c1 === null || c2 === null || c3 === null) return null;

			if (space === 'srgb') {
				return { r: c1, g: c2, b: c3, a: alphaVal };
			}
			if (space === 'srgb-linear') {
				return {
					r: linearToSrgb(c1),
					g: linearToSrgb(c2),
					b: linearToSrgb(c3),
					a: alphaVal
				};
			}
			if (space === 'display-p3') {
				const linP3R = srgbToLinear(c1);
				const linP3G = srgbToLinear(c2);
				const linP3B = srgbToLinear(c3);
				const linSrgb = displayP3ToLinearSrgb({ r: linP3R, g: linP3G, b: linP3B, a: alphaVal });
				return {
					r: linearToSrgb(linSrgb.r),
					g: linearToSrgb(linSrgb.g),
					b: linearToSrgb(linSrgb.b),
					a: alphaVal
				};
			}
			return null;
		}

		return null;
	}

	if (typeof input === 'object' && input !== null) {
		const obj = input as Record<string, unknown>;
		// W3C tokens object
		if (Array.isArray(obj.components)) {
			const space = obj.colorSpace;
			if (space === undefined || space === 'srgb') {
				const [r, g, b] = obj.components as unknown[];
				const a = typeof obj.alpha === 'number' && Number.isFinite(obj.alpha) ? obj.alpha : 1;
				if ([r, g, b].every((v) => typeof v === 'number' && Number.isFinite(v))) {
					return { r: r as number, g: g as number, b: b as number, a };
				}
			}
			if (typeof obj.hex === 'string') {
				const base = parseColor(obj.hex);
				if (!base) return null;
				const a = typeof obj.alpha === 'number' && Number.isFinite(obj.alpha) ? obj.alpha : 1;
				return { r: base.r, g: base.g, b: base.b, a };
			}
			return null;
		}

		// Plain { r, g, b, a? }
		const { r, g, b } = obj;
		const a = obj.a === undefined ? 1 : obj.a;
		if ([r, g, b, a].every((v) => typeof v === 'number' && Number.isFinite(v))) {
			return { r: r as number, g: g as number, b: b as number, a: a as number };
		}
	}

	return null;
}

function parseHex(hex: string): Rgba | null {
	let raw = hex.trim();
	if (raw.startsWith('#')) raw = raw.slice(1);
	if (raw.length === 3 || raw.length === 4) {
		raw = [...raw].map((c) => c + c).join('');
	}
	if (raw.length !== 6 && raw.length !== 8) return null;
	const r = parseInt(raw.slice(0, 2), 16) / 255;
	const g = parseInt(raw.slice(2, 4), 16) / 255;
	const b = parseInt(raw.slice(4, 6), 16) / 255;
	const a = raw.length === 8 ? parseInt(raw.slice(6, 8), 16) / 255 : 1;
	return { r, g, b, a };
}

/** Returns true when the input can be parsed as a valid colour. */
export function isColor(input: unknown): boolean {
	return parseColor(input) !== null;
}
