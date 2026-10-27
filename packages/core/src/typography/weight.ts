/**
 * Font weight normalisation and matching.
 */

import type { FontWeight, NumericFontWeight } from './types.js';

/** `normal` → 400, `bold` → 700, numbers rounded to the nearest 100 within 100–900. */
export function normalizeFontWeight(weight: FontWeight | number | undefined): NumericFontWeight {
	if (weight === undefined || weight === 'normal') return 400;
	if (weight === 'bold') return 700;
	if (typeof weight !== 'number' || !Number.isFinite(weight)) return 400;
	return (Math.min(9, Math.max(1, Math.round(weight / 100))) * 100) as NumericFontWeight;
}

/** Whether a value is a CSS font weight this module accepts. */
export function isFontWeight(value: unknown): value is FontWeight {
	return value === 'normal' || value === 'bold' || (typeof value === 'number' && value >= 100 && value <= 900 && value % 100 === 0);
}

/**
 * The available weight CSS font matching would pick for `wanted`: for 400 try 500 first, then
 * lighter, then heavier; below 400 lighter first; above 500 heavier first.
 */
export function nearestFontWeight(wanted: FontWeight | number, available: readonly FontWeight[]): NumericFontWeight {
	const target = normalizeFontWeight(wanted);
	const weights = [...new Set(available.map((w) => normalizeFontWeight(w)))].sort((a, b) => a - b);
	if (!weights.length) return target;
	if (weights.includes(target)) return target;
	const lighter = weights.filter((w) => w < target).reverse();
	const heavier = weights.filter((w) => w > target);
	if (target === 400 && weights.includes(500)) return 500;
	if (target === 500 && weights.includes(400)) return 400;
	if (target <= 500) return (lighter[0] ?? heavier[0])!;
	return (heavier[0] ?? lighter[0])!;
}
