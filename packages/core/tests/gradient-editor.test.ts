import { describe, it, expect } from 'vitest';
import {
	createGradient,
	gradientKeyStep,
	stopFromTrackPosition,
	trackPositionFromStop,
	angleFromPointer,
	gradientTrackBackground
} from '../src/gradient/index.js';

describe('gradient editor headless helpers', () => {
	const grad = createGradient(['#ff0000', '#00ff00', '#0000ff']);

	it('maps track positions and stop offsets accurately', () => {
		expect(stopFromTrackPosition(grad, 0.4567)).toBe(0.457);
		expect(stopFromTrackPosition(grad, -0.2)).toBe(0);
		expect(stopFromTrackPosition(grad, 1.5)).toBe(1);

		expect(trackPositionFromStop(grad.stops[1])).toBe(0.5);
	});

	it('steps stop positions with keyboard arrow keys', () => {
		const s1 = grad.stops[0].id;
		const s2 = grad.stops[1].id;

		// ArrowRight increases by 0.01
		const r1 = gradientKeyStep(grad, s2, 'ArrowRight', false);
		expect(r1).toEqual({ stopId: s2, offset: 0.51 });

		// ArrowRight with shift increases by 0.1
		const r2 = gradientKeyStep(grad, s2, 'ArrowRight', true);
		expect(r2).toEqual({ stopId: s2, offset: 0.6 });

		// ArrowLeft decreases by 0.01
		const r3 = gradientKeyStep(grad, s2, 'ArrowLeft', false);
		expect(r3).toEqual({ stopId: s2, offset: 0.49 });

		// ArrowLeft with shift decreases by 0.1
		const r4 = gradientKeyStep(grad, s2, 'ArrowLeft', true);
		expect(r4).toEqual({ stopId: s2, offset: 0.4 });

		// Clamps to [0, 1]
		const rClamp = gradientKeyStep(grad, s1, 'ArrowLeft', true);
		expect(rClamp).toEqual({ stopId: s1, offset: 0 });

		// Delete and Backspace trigger remove
		expect(gradientKeyStep(grad, s2, 'Delete')).toEqual({ stopId: s2, remove: true });
		expect(gradientKeyStep(grad, s2, 'Backspace')).toEqual({ stopId: s2, remove: true });

		// Unhandled keys return null
		expect(gradientKeyStep(grad, s2, 'Enter')).toBeNull();
		expect(gradientKeyStep(grad, 'non-existent', 'ArrowRight')).toBeNull();
	});

	it('computes CSS angle from pointer relative to center', () => {
		const center = { x: 100, y: 100 };

		// Point directly above center -> 0 deg
		expect(angleFromPointer(center, { x: 100, y: 50 })).toBe(0);

		// Point directly to the right of center -> 90 deg
		expect(angleFromPointer(center, { x: 150, y: 100 })).toBe(90);

		// Point directly below center -> 180 deg
		expect(angleFromPointer(center, { x: 100, y: 150 })).toBe(180);

		// Point directly to the left of center -> 270 deg
		expect(angleFromPointer(center, { x: 50, y: 100 })).toBe(270);

		// Point with 15 deg snapping: dy=10, dx=50 -> deg ~ 101.3 deg -> snaps to 105 deg
		expect(angleFromPointer(center, { x: 150, y: 110 }, 15)).toBe(105);
		// dy=3, dx=50 -> deg ~ 93.4 deg -> snaps to 90 deg
		expect(angleFromPointer(center, { x: 150, y: 103 }, 15)).toBe(90);
	});

	it('generates a horizontal track background for any gradient', () => {
		const radial = { ...grad, type: 'radial' as const };
		const bg = gradientTrackBackground(radial);
		expect(bg).toContain('linear-gradient(');
		expect(bg).toContain('90deg');
	});
});
