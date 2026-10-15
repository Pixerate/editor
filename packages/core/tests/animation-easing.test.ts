import { describe, it, expect } from 'vitest';
import {
	elasticAt,
	evaluateEasing,
	resolveEasing,
	isAnimationEasing,
	easingToCss,
	easingLabel,
	ANIMATION_EASING_PRESETS,
	ANIMATION_EASING_LABELS
} from '../src/animation/easing.js';

describe('Parametric Elastic Easing', () => {
	it('starts at 0 and ends at 1 for all modes', () => {
		for (const mode of ['out', 'in', 'in-out'] as const) {
			expect(elasticAt({ mode }, 0)).toBe(0);
			expect(elasticAt({ mode }, -0.1)).toBe(0);
			expect(elasticAt({ mode }, 1)).toBe(1);
			expect(elasticAt({ mode }, 1.1)).toBe(1);
		}
	});

	it('overshoots 1 in ease-out mode (amplitude > 0)', () => {
		let maxVal = 0;
		for (let i = 0; i <= 100; i++) {
			const val = elasticAt({ amplitude: 1, period: 0.3, mode: 'out' }, i / 100);
			if (val > maxVal) maxVal = val;
		}
		expect(maxVal).toBeGreaterThan(1);
	});

	it('undershoots 0 in ease-in mode', () => {
		let minVal = 0;
		for (let i = 0; i <= 100; i++) {
			const val = elasticAt({ amplitude: 1, period: 0.3, mode: 'in' }, i / 100);
			if (val < minVal) minVal = val;
		}
		expect(minVal).toBeLessThan(0);
	});

	it('smoothly connects midpoints in in-out mode', () => {
		const mid = elasticAt({ mode: 'in-out' }, 0.5);
		expect(mid).toBeCloseTo(0.5, 2);
	});

	it('resolves elastic presets and descriptors', () => {
		const out = resolveEasing('elastic');
		expect(out).toEqual({ type: 'elastic', amplitude: 1, period: 0.3, mode: 'out' });

		const inOut = resolveEasing('ease-in-out-elastic');
		expect(inOut).toEqual({ type: 'elastic', amplitude: 1, period: 0.3, mode: 'in-out' });

		const custom = resolveEasing({ type: 'elastic', amplitude: 2, period: 0.5 });
		expect(custom).toEqual({ type: 'elastic', amplitude: 2, period: 0.5, mode: 'out' });
	});

	it('evaluates easing with evaluateEasing', () => {
		expect(evaluateEasing('elastic', 0)).toBe(0);
		expect(evaluateEasing('elastic', 1)).toBe(1);
		expect(evaluateEasing({ type: 'elastic', amplitude: 1.2, period: 0.25 }, 0.5)).toBeGreaterThan(0.5);
	});

	it('generates CSS linear() timing function for elastic easing', () => {
		const css = easingToCss('elastic', 1000, 10);
		expect(css).toMatch(/^linear\(0, .+1\)$/);
	});

	it('identifies elastic as a valid animation easing', () => {
		expect(isAnimationEasing('elastic')).toBe(true);
		expect(isAnimationEasing('ease-out-elastic')).toBe(true);
		expect(isAnimationEasing({ type: 'elastic' })).toBe(true);
		expect(isAnimationEasing({ type: 'elastic', amplitude: 1.5 })).toBe(true);
	});

	it('returns Elastic label', () => {
		expect(easingLabel('elastic')).toBe('Elastic');
		expect(easingLabel({ type: 'elastic' })).toBe('Elastic');
		expect(ANIMATION_EASING_LABELS['elastic']).toBe('Elastic');
		expect(ANIMATION_EASING_PRESETS).toContain('elastic');
		expect(ANIMATION_EASING_PRESETS).toContain('ease-out-elastic');
	});
});
