import { describe, expect, it } from 'vitest';
import { fitText, staggerRows, type MeasureText } from '../src/typography/fit.js';

/** Every character 0.6 em wide, letter spacing after each character but the last. */
const fixed: MeasureText = (word, size, spacing) => word.length * size * 0.6 + Math.max(0, word.length - 1) * spacing;

describe('fitText', () => {
	it('finds the largest half-pixel size at which the longest word fits', () => {
		// "category" is 8 characters: 4.8 × size ≤ 72 → size ≤ 15.
		expect(fitText(['tag', 'category', 'axis'], 72, { measure: fixed })).toEqual({ size: 15, letterSpacing: 0, fits: true, word: 'category' });
		// 4.8 × size ≤ 70 → 14.58…, so 14.5 on the half-pixel grid.
		expect(fitText(['category'], 70, { measure: fixed }).size).toBe(14.5);
	});

	it('stops at max and steps from min', () => {
		expect(fitText(['a'], 1000, { measure: fixed, max: 24 }).size).toBe(24);
		expect(fitText(['category'], 70, { measure: fixed, min: 9.25, step: 1 }).size).toBe(14.25);
	});

	it('tightens tracking at min down to the floor before giving up', () => {
		// At 10 px "category" is 48 px; each -0.01 em takes 7 × 0.1 = 0.7 px.
		const r = fitText(['category'], 46.5, { measure: fixed, min: 10, tracking: { floor: -0.05 } });
		expect(r.fits).toBe(true);
		expect(r.size).toBe(10);
		expect(r.letterSpacing).toBeCloseTo(-0.3, 12);
		const none = fitText(['category'], 40, { measure: fixed, min: 10, tracking: { floor: -0.05 } });
		expect(none).toMatchObject({ fits: false, size: 10, word: 'category' });
		expect(none.letterSpacing).toBeCloseTo(-0.5, 12);
	});

	it('reports fits: false at min without tracking', () => {
		expect(fitText(['supercalifragilistic'], 50, { measure: fixed })).toEqual({ size: 8, letterSpacing: 0, fits: false, word: 'supercalifragilistic' });
	});

	it('handles no words and bad steps', () => {
		expect(fitText([], 10, { measure: fixed })).toEqual({ size: 32, letterSpacing: 0, fits: true, word: null });
		expect(() => fitText(['a'], 10, { measure: fixed, step: 0 })).toThrow('step must be a positive number of px.');
		expect(() => fitText(['a'], 1, { measure: fixed, tracking: { floor: -0.1, step: 0 } })).toThrow('tracking.step');
	});

	it('names the first of equally wide words', () => {
		expect(fitText(['abc', 'xyz'], 30, { measure: fixed }).word).toBe('abc');
	});
});

describe('staggerRows', () => {
	it('keeps one row when the words clear each other', () => {
		expect(staggerRows(['one', 'two', 'six'], [0, 40, 80], { measure: fixed, size: 10 })).toEqual({ rows: [0, 0, 0], count: 1, fits: true });
	});

	it('alternates rows in position order when one row is too tight', () => {
		const r = staggerRows(['alpha', 'gamma', 'beta'], [0, 50, 25], { measure: fixed, size: 10 });
		expect(r).toEqual({ rows: [0, 0, 1], count: 2, fits: true });
	});

	it('reports when even two rows overlap', () => {
		expect(staggerRows(['category', 'category', 'category'], [0, 10, 20], { measure: fixed, size: 10 }).fits).toBe(false);
	});
});
