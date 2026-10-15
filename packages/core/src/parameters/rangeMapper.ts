import { evaluateEasing, type AnimationEasing } from '../animation/easing.js';

export interface RangeMapperOptions {
	/**
	 * Input domain [min, max]. Defaults to [0, 1].
	 */
	from?: readonly [number, number];

	/**
	 * Output range [min, max]. Defaults to [0, 1].
	 */
	to?: readonly [number, number];

	/**
	 * Optional easing function, preset name, or descriptor applied to normalized progress.
	 */
	easing?: AnimationEasing | string | ((t: number) => number);

	/**
	 * Whether to clamp input values to the [from[0], from[1]] domain before mapping.
	 * Defaults to true.
	 */
	clamp?: boolean;
}

export type RangeMapper = (value: number) => number;

/**
 * Creates a reusable function that maps numbers from an input interval to an output interval,
 * with optional clamping and easing curve application (inspired by Rive's DataConverterRangeMapper).
 */
export function createRangeMapper(options: RangeMapperOptions = {}): RangeMapper {
	const [inMin, inMax] = options.from ?? [0, 1];
	const [outMin, outMax] = options.to ?? [0, 1];
	const shouldClamp = options.clamp ?? true;
	const easing = options.easing;

	const inSpan = inMax - inMin;
	const outSpan = outMax - outMin;

	return function map(value: number): number {
		if (!Number.isFinite(value)) return outMin;

		// Degenerate input range: avoid division by zero
		if (Math.abs(inSpan) < 1e-12) {
			return outMin;
		}

		let normalized = (value - inMin) / inSpan;

		if (shouldClamp) {
			normalized = Math.min(1, Math.max(0, normalized));
		}

		let progress = normalized;
		if (easing !== undefined && easing !== null) {
			if (typeof easing === 'function') {
				progress = easing(normalized);
			} else {
				progress = evaluateEasing(easing, normalized);
			}
		}

		return outMin + progress * outSpan;
	};
}

/**
 * One-off helper to map a value from one interval to another with optional clamping and easing.
 */
export function mapRange(
	value: number,
	from: readonly [number, number],
	to: readonly [number, number],
	options?: Omit<RangeMapperOptions, 'from' | 'to'>
): number {
	return createRangeMapper({ from, to, ...options })(value);
}
