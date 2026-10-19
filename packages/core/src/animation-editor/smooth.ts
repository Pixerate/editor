// Clamped tangents after Blender's auto-clamped handles (ideas only) and Fritsch–Carlson monotone cubic interpolation.
import type { AnimationEasing } from '../animation/easing.js';

/** One leg of a smooth path on one axis: from → to over [start, end] (ms), eased so velocity carries across legs. */
export interface MotionSmoothLeg {
	start: number;
	end: number;
	from: number;
	to: number;
	ease: AnimationEasing;
}

/**
 * A value passing through `values` at `times` (ms) with continuous velocity and no overshoot:
 * a monotone cubic (Fritsch–Carlson) whose slopes are zero at the ends, at turning points and on
 * flat stretches, so it never goes past a waypoint. Each leg is one cubic-bezier ease per axis;
 * x and y ease differently, so exports to Flair or Lottie (one ease per transform) sample them.
 */
export function smoothMotionLegs(times: readonly number[], values: readonly number[]): MotionSmoothLeg[] {
	const n = values.length;
	const slope: number[] = new Array(n).fill(0);
	const secant = (i: number) => (values[i + 1] - values[i]) / Math.max(1e-9, times[i + 1] - times[i]);
	for (let i = 1; i < n - 1; i++) {
		const a = secant(i - 1);
		const b = secant(i);
		// A turning point or a flat stretch stays put (Blender's clamped handles); otherwise the harmonic-weighted mean.
		if (a * b <= 0) continue;
		const ha = times[i] - times[i - 1];
		const hb = times[i + 1] - times[i];
		slope[i] = (3 * (ha + hb)) / ((2 * hb + ha) / a + (hb + 2 * ha) / b);
	}
	const legs: MotionSmoothLeg[] = [];
	for (let i = 0; i + 1 < n; i++) {
		const dt = times[i + 1] - times[i];
		const dv = values[i + 1] - values[i];
		if (Math.abs(dv) < 1e-9) {
			legs.push({ start: times[i], end: times[i + 1], from: values[i], to: values[i + 1], ease: 'linear' });
			continue;
		}
		// The Hermite leg as a cubic-bezier ease: handles at thirds of the time, heights from the slopes.
		const y1 = (slope[i] * dt) / (3 * dv);
		const y2 = 1 - (slope[i + 1] * dt) / (3 * dv);
		legs.push({ start: times[i], end: times[i + 1], from: values[i], to: values[i + 1], ease: { type: 'cubic-bezier', x1: 1 / 3, y1, x2: 2 / 3, y2 } });
	}
	return legs;
}

/** When each point of a path is reached over `duration` (ms): in proportion to distance (`even`) or a leg each (`equal`). */
export function smoothMotionTimes(points: readonly { x: number; y: number }[], start: number, duration: number, pacing: 'even' | 'equal' = 'even'): number[] {
	const legs = points.slice(1).map((p, i) => (pacing === 'equal' ? 1 : Math.hypot(p.x - points[i].x, p.y - points[i].y)));
	const total = legs.reduce((a, b) => a + b, 0) || legs.length || 1;
	const times = [start];
	let acc = 0;
	for (const l of legs) {
		acc += total > 0 ? l : 1;
		times.push(start + (duration * acc) / total);
	}
	return times;
}
