/**
 * Dual colours: paired colour values for light mode and dark mode,
 * with CSS light-dark() parsing and generation, contrast checks, and scheme derivation.
 */

import { parseColor } from './parse.js';
import { formatHex, normalizeColor } from './format.js';
import { rgbToOklab, oklabToOklch, oklchToOklab, oklabToRgb } from './convert.js';
import { toSrgbGamut } from './gamut.js';
import { contrastRatio, contrastLevel } from './contrast.js';
import type { ContrastLevel } from './types.js';

export type ColorScheme = 'light' | 'dark';

/** A colour for each scheme. Both are any CSS colour; `normalizeDualColor` stores them as hex. */
export interface DualColor {
	light: string;
	dark: string;
}

/** Either a plain colour (the same in both schemes) or a dual colour. */
export type ColorValue = string | DualColor;

/** Default surface backgrounds used for scheme derivation and contrast evaluations. */
export const DEFAULT_SCHEME_SURFACES: DualColor = {
	light: '#ffffff',
	dark: '#0b0b0f'
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Returns true if the value is an object with string `light` and `dark` properties.
 */
export function isDualColor(value: unknown): value is DualColor {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as Record<string, unknown>).light === 'string' &&
		typeof (value as Record<string, unknown>).dark === 'string'
	);
}

/**
 * Parses a dual colour value.
 *
 * Accepts:
 * - A `DualColor` object `{ light, dark }`
 * - A CSS `light-dark(<light>, <dark>)` string
 * - A plain CSS colour (which resolves to `{ light: c, dark: c }`)
 *
 * Note: `parseColor` returns `null` for `light-dark(...)` because a single Rgba
 * cannot hold two colours. Use `parseDualColor` or `resolveColor` when handling dual colours.
 *
 * Returns `null` if either half cannot be parsed, or if `light-dark()` is nested. Never throws.
 */
export function parseDualColor(input: unknown): DualColor | null {
	if (input === null || input === undefined) return null;

	if (isDualColor(input)) {
		if (parseColor(input.light) === null || parseColor(input.dark) === null) {
			return null;
		}
		return { light: input.light, dark: input.dark };
	}

	if (typeof input === 'string') {
		const trimmed = input.trim();
		if (trimmed.toLowerCase().startsWith('light-dark(') && trimmed.endsWith(')')) {
			const inner = trimmed.slice('light-dark('.length, -1).trim();

			// Disallow nested light-dark
			if (inner.toLowerCase().includes('light-dark(')) {
				return null;
			}

			// Scan for top-level comma by counting parenthesis depth
			let depth = 0;
			let commaIndex = -1;
			for (let i = 0; i < inner.length; i++) {
				const char = inner[i];
				if (char === '(') {
					depth++;
				} else if (char === ')') {
					depth--;
					if (depth < 0) return null;
				} else if (char === ',' && depth === 0) {
					if (commaIndex !== -1) {
						// Multiple top-level commas is invalid
						return null;
					}
					commaIndex = i;
				}
			}

			if (depth !== 0 || commaIndex === -1) {
				return null;
			}

			const lightPart = inner.slice(0, commaIndex).trim();
			const darkPart = inner.slice(commaIndex + 1).trim();

			if (!lightPart || !darkPart) return null;
			if (parseColor(lightPart) === null || parseColor(darkPart) === null) {
				return null;
			}

			return { light: lightPart, dark: darkPart };
		}

		// Try plain colour
		if (parseColor(trimmed) !== null) {
			return { light: trimmed, dark: trimmed };
		}
	}

	return null;
}

/**
 * Parses and normalises a dual colour, converting both halves to lowercase hex.
 */
export function normalizeDualColor(input: unknown): DualColor | null {
	const parsed = parseDualColor(input);
	if (!parsed) return null;
	const light = normalizeColor(parsed.light);
	const dark = normalizeColor(parsed.dark);
	if (!light || !dark) return null;
	return { light, dark };
}

/**
 * Resolves a colour value (plain colour, dual colour object, or light-dark() CSS string)
 * to a normalised hex string for the specified scheme ('light' or 'dark').
 *
 * Use this when drawing to Canvas, SVG presentation attributes, or exporting to formats
 * that do not support CSS `light-dark()`.
 */
export function resolveColor(value: unknown, scheme: ColorScheme): string | null {
	const normalized = normalizeDualColor(value);
	if (!normalized) return null;
	return scheme === 'dark' ? normalized.dark : normalized.light;
}

/**
 * Formats a DualColor into CSS syntax: `light-dark(#a, #b)`, or `#a` if both halves are equal.
 */
export function formatDualColor(value: DualColor): string {
	const light = normalizeColor(value.light) ?? value.light;
	const dark = normalizeColor(value.dark) ?? value.dark;
	if (light === dark) {
		return light;
	}
	return `light-dark(${light}, ${dark})`;
}

/**
 * Returns true if both halves of the dual colour normalise to the same value.
 */
export function isSameInBothSchemes(value: DualColor): boolean {
	const light = normalizeColor(value.light);
	const dark = normalizeColor(value.dark);
	if (!light || !dark) return value.light === value.dark;
	return light === dark;
}

/**
 * Changes one half of a dual colour, returning a normalised DualColor.
 * If given a plain colour, it first expands to a pair of that colour before updating the side.
 */
export function setDualColorSide(
	value: ColorValue,
	scheme: ColorScheme,
	color: string
): DualColor {
	const base = normalizeDualColor(value) ?? { light: '#000000', dark: '#000000' };
	const normColor = normalizeColor(color) ?? color;
	return {
		light: scheme === 'light' ? normColor : base.light,
		dark: scheme === 'dark' ? normColor : base.dark
	};
}

/**
 * Derives the opposing scheme half automatically from a given base colour.
 *
 * Options:
 * - `from`: which scheme the input colour belongs to (default `'light'`).
 * - `surfaces`: background surfaces for light and dark schemes. When provided,
 *   matches the contrast ratio against the target surface.
 */
export function deriveDualColor(
	color: string,
	options?: { from?: ColorScheme; surfaces?: DualColor }
): DualColor {
	const fromScheme: ColorScheme = options?.from ?? 'light';
	const baseRgba = parseColor(color);
	if (!baseRgba) {
		const fallback = normalizeColor(color) ?? '#000000';
		return { light: fallback, dark: fallback };
	}

	const baseHex = formatHex(baseRgba);
	const lab = rgbToOklab(baseRgba);
	const lch = oklabToOklch(lab);

	// Starting guess
	const startL = clamp(1.05 - lch.l, 0.12, 0.95);
	const targetC = lch.c * 0.9;
	const targetH = lch.h;

	let derivedHex: string;

	if (options?.surfaces) {
		const surfaces = options.surfaces;
		const fromSurfaceRgba = parseColor(surfaces[fromScheme]) ?? { r: 1, g: 1, b: 1, a: 1 };
		const targetScheme: ColorScheme = fromScheme === 'light' ? 'dark' : 'light';
		const targetSurfaceRgba = parseColor(surfaces[targetScheme]) ?? { r: 0, g: 0, b: 0, a: 1 };

		const targetRatio = contrastRatio(baseRgba, fromSurfaceRgba);
		const targetSurfaceL = oklabToOklch(rgbToOklab(targetSurfaceRgba)).l;
		const preferHigherL = targetSurfaceL < 0.5;

		let bestDiff = Infinity;
		let bestL = startL;

		// Search OKLCH lightness in steps of 0.005
		for (let candL = 0.05; candL <= 0.98; candL += 0.005) {
			const candRgb = toSrgbGamut(
				oklabToRgb(oklchToOklab({ l: candL, c: targetC, h: targetH, alpha: baseRgba.a }))
			);
			const ratio = contrastRatio(candRgb, targetSurfaceRgba);
			const diff = Math.abs(ratio - targetRatio);

			// Tie-breaking preference for the side away from the background
			const isBetter =
				diff < bestDiff - 1e-4 ||
				(Math.abs(diff - bestDiff) <= 1e-4 &&
					(preferHigherL ? candL > bestL : candL < bestL));

			if (isBetter) {
				bestDiff = diff;
				bestL = candL;
			}
		}

		const finalRgba = toSrgbGamut(
			oklabToRgb(oklchToOklab({ l: bestL, c: targetC, h: targetH, alpha: baseRgba.a }))
		);
		derivedHex = formatHex(finalRgba);
	} else {
		const finalRgba = toSrgbGamut(
			oklabToRgb(oklchToOklab({ l: startL, c: targetC, h: targetH, alpha: baseRgba.a }))
		);
		derivedHex = formatHex(finalRgba);
	}

	return fromScheme === 'light'
		? { light: baseHex, dark: derivedHex }
		: { light: derivedHex, dark: baseHex };
}

/**
 * Checks contrast compliance of a foreground/background dual colour pair across both modes.
 */
export function checkDualColorContrast(
	foreground: ColorValue,
	background: ColorValue,
	options?: { large?: boolean }
): {
	light: { ratio: number; level: ContrastLevel };
	dark: { ratio: number; level: ContrastLevel };
	issues: string[];
} {
	const large = options?.large ?? false;
	const requiredRatio = large ? 3 : 4.5;

	const lightFgHex = resolveColor(foreground, 'light') ?? '#000000';
	const lightBgHex = resolveColor(background, 'light') ?? '#ffffff';
	const darkFgHex = resolveColor(foreground, 'dark') ?? '#000000';
	const darkBgHex = resolveColor(background, 'dark') ?? '#000000';

	const lightFg = parseColor(lightFgHex)!;
	const lightBg = parseColor(lightBgHex)!;
	const darkFg = parseColor(darkFgHex)!;
	const darkBg = parseColor(darkBgHex)!;

	const lightRatio = Math.round(contrastRatio(lightFg, lightBg) * 100) / 100;
	const darkRatio = Math.round(contrastRatio(darkFg, darkBg) * 100) / 100;

	const lightLevel = contrastLevel(lightRatio, { large });
	const darkLevel = contrastLevel(darkRatio, { large });

	const issues: string[] = [];

	if (lightLevel === 'fail') {
		issues.push(
			`In light mode, ${lightFgHex} on ${lightBgHex} has a contrast of ${lightRatio.toFixed(1)} (needs ${requiredRatio} for AA).`
		);
	}

	if (darkLevel === 'fail') {
		issues.push(
			`In dark mode, ${darkFgHex} on ${darkBgHex} has a contrast of ${darkRatio.toFixed(1)} (needs ${requiredRatio} for AA).`
		);
	}

	return {
		light: { ratio: lightRatio, level: lightLevel },
		dark: { ratio: darkRatio, level: darkLevel },
		issues
	};
}

/**
 * Formats a dictionary of dual colours as CSS custom properties according to a strategy.
 */
export function dualColorsToCss(
	colors: Record<string, ColorValue>,
	options?: {
		selector?: string;
		strategy?: 'light-dark' | 'media' | 'class';
		darkSelector?: string;
	}
): string {
	const selector = options?.selector ?? ':root';
	const strategy = options?.strategy ?? 'light-dark';
	const darkSelector = options?.darkSelector ?? '.dark';

	const sortedKeys = Object.keys(colors).sort();

	switch (strategy) {
		case 'light-dark': {
			const lines = [
				`${selector} {`,
				...(selector === ':root' ? ['  color-scheme: light dark;'] : []),
				...sortedKeys.map((k) => {
					const norm = normalizeDualColor(colors[k]);
					const val = norm ? formatDualColor(norm) : String(colors[k]);
					return `  --${k}: ${val};`;
				}),
				'}'
			];
			return lines.join('\n');
		}

		case 'media': {
			const lightLines = [
				`${selector} {`,
				...sortedKeys.map((k) => `  --${k}: ${resolveColor(colors[k], 'light') ?? colors[k]};`),
				'}'
			];
			const darkLines = [
				`@media (prefers-color-scheme: dark) {`,
				`  ${selector} {`,
				...sortedKeys.map((k) => `    --${k}: ${resolveColor(colors[k], 'dark') ?? colors[k]};`),
				`  }`,
				`}`
			];
			return `${lightLines.join('\n')}\n\n${darkLines.join('\n')}`;
		}

		case 'class': {
			const lightLines = [
				`${selector} {`,
				...sortedKeys.map((k) => `  --${k}: ${resolveColor(colors[k], 'light') ?? colors[k]};`),
				'}'
			];
			const darkLines = [
				`${darkSelector} {`,
				...sortedKeys.map((k) => `  --${k}: ${resolveColor(colors[k], 'dark') ?? colors[k]};`),
				'}'
			];
			return `${lightLines.join('\n')}\n\n${darkLines.join('\n')}`;
		}
	}
}
