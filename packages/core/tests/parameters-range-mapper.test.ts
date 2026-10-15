import { describe, it, expect } from 'vitest';
import { createRangeMapper, mapRange } from '../src/parameters/rangeMapper.js';

describe('createRangeMapper & mapRange', () => {
	it('maps linearly with default [0, 1] bounds', () => {
		const map = createRangeMapper();
		expect(map(0)).toBe(0);
		expect(map(0.5)).toBe(0.5);
		expect(map(1)).toBe(1);
	});

	it('maps arbitrary numeric ranges with clamping', () => {
		const map = createRangeMapper({
			from: [0, 100],
			to: [0, 1],
			clamp: true
		});
		expect(map(0)).toBe(0);
		expect(map(50)).toBe(0.5);
		expect(map(100)).toBe(1);
		// Clamped
		expect(map(-50)).toBe(0);
		expect(map(150)).toBe(1);
	});

	it('supports unclamped mapping', () => {
		const map = createRangeMapper({
			from: [0, 10],
			to: [0, 100],
			clamp: false
		});
		expect(map(-5)).toBe(-50);
		expect(map(15)).toBe(150);
	});

	it('supports inverted ranges', () => {
		const map = createRangeMapper({
			from: [0, 100],
			to: [100, 0]
		});
		expect(map(0)).toBe(100);
		expect(map(50)).toBe(50);
		expect(map(100)).toBe(0);
	});

	it('applies easing presets to normalized progress', () => {
		const mapLinear = createRangeMapper({ from: [0, 100], to: [0, 100], easing: 'linear' });
		const mapEaseIn = createRangeMapper({ from: [0, 100], to: [0, 100], easing: 'ease-in' });

		expect(mapLinear(50)).toBe(50);
		// Ease-in is slower in the beginning, so at 50% normalized time it is less than 50
		expect(mapEaseIn(50)).toBeLessThan(50);
	});

	it('applies elastic easing to create bounce/overshoot', () => {
		const mapElastic = createRangeMapper({
			from: [0, 100],
			to: [0, 100],
			easing: 'elastic'
		});
		// Elastic overshoots the target value at some point
		let overshoots = false;
		for (let i = 0; i <= 100; i++) {
			if (mapElastic(i) > 100) {
				overshoots = true;
				break;
			}
		}
		expect(overshoots).toBe(true);
	});

	it('supports custom easing callback functions', () => {
		const square = (t: number) => t * t;
		const map = createRangeMapper({
			from: [0, 10],
			to: [0, 100],
			easing: square
		});
		expect(map(5)).toBe(25); // 0.5^2 = 0.25 -> 25
	});

	it('safely handles degenerate from ranges (division by zero)', () => {
		const map = createRangeMapper({
			from: [50, 50],
			to: [0, 100]
		});
		expect(map(50)).toBe(0);
		expect(map(10)).toBe(0);
	});

	it('safely handles non-finite inputs', () => {
		const map = createRangeMapper({
			from: [0, 10],
			to: [20, 80]
		});
		expect(map(NaN)).toBe(20);
		expect(map(Infinity)).toBe(20);
		expect(map(-Infinity)).toBe(20);
	});

	it('works as a one-off helper with mapRange', () => {
		const val = mapRange(25, [0, 100], [0, 360]);
		expect(val).toBe(90);

		const clamped = mapRange(150, [0, 100], [0, 10]);
		expect(clamped).toBe(10);
	});
});
