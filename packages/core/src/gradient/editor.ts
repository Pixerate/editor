import { gradientToCss } from './model.js';
import type { Gradient, GradientStop } from './types.js';

export interface GradientKeyStepResult {
	stopId?: string;
	offset?: number;
	remove?: boolean;
}

/**
 * Returns the stop offset (0..1) corresponding to a track x position (0..1).
 */
export function stopFromTrackPosition(g: Gradient, x: number): number {
	return Math.max(0, Math.min(1, Math.round(x * 1000) / 1000));
}

/**
 * Returns the track x position (0..1) corresponding to a stop.
 */
export function trackPositionFromStop(stop: GradientStop): number {
	return Math.max(0, Math.min(1, stop.offset));
}

/**
 * Handles keyboard navigation on a stop handle.
 * ArrowLeft / ArrowRight moves by 0.01 (or 0.1 with shiftKey).
 * Delete / Backspace requests removal (remove: true).
 * Returns null if the key is unhandled.
 */
export function gradientKeyStep(
	g: Gradient,
	id: string,
	key: string,
	shift = false
): GradientKeyStepResult | null {
	const stop = g.stops.find((s) => s.id === id);
	if (!stop) return null;

	const step = shift ? 0.1 : 0.01;

	switch (key) {
		case 'ArrowLeft':
		case 'ArrowDown': {
			const offset = Math.max(0, Math.round((stop.offset - step) * 1000) / 1000);
			return { stopId: id, offset };
		}
		case 'ArrowRight':
		case 'ArrowUp': {
			const offset = Math.min(1, Math.round((stop.offset + step) * 1000) / 1000);
			return { stopId: id, offset };
		}
		case 'Delete':
		case 'Backspace': {
			return { stopId: id, remove: true };
		}
		default:
			return null;
	}
}

/**
 * Calculates angle in degrees (CSS convention: 0 = up, 90 = right, 180 = down, 270 = left)
 * from a center coordinate to a pointer coordinate.
 * Optional snapStep snaps to nearest multiple (e.g. 15 deg).
 */
export function angleFromPointer(
	center: { x: number; y: number },
	point: { x: number; y: number },
	snapStep?: number
): number {
	const dx = point.x - center.x;
	const dy = point.y - center.y;
	// atan2(dy, dx) returns angle from +X axis clockwise in standard screen coords
	// In CSS gradients: 0deg points UP (-Y), 90deg points RIGHT (+X), 180deg points DOWN (+Y).
	// So angle = atan2(dx, -dy) in degrees
	let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
	if (deg < 0) deg += 360;

	if (snapStep && snapStep > 0) {
		deg = Math.round(deg / snapStep) * snapStep;
		if (deg >= 360) deg -= 360;
	}

	return Math.round(deg);
}

/**
 * Returns a linear 90deg CSS gradient string suitable for rendering the stop track
 * across the horizontal slider, regardless of the underlying gradient's type.
 */
export function gradientTrackBackground(g: Gradient): string {
	const linearCopy: Gradient = {
		...g,
		type: 'linear',
		angle: 90
	};
	return gradientToCss(linearCopy);
}
