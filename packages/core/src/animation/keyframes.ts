// Portions ported from filmcraft-main/crates/project/src/keyframe.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { isAnimationEasing, type AnimationEasing } from './easing.js';

/**
 * Keyframe tracks, independent of what they animate: each track is a list of keyframes
 * `{ time (ms), value, easing }`, where the easing governs the segment *leaving* the keyframe
 * (filmcraft / After Effects convention).
 */

/** Keyframe times closer than this (ms) are the same time. */
export const ANIMATION_TIME_EPSILON = 1e-6;

/** A keyframe value: a number, or a CSS colour for colour properties. */
export type AnimationValue = number | string;

export interface AnimationKeyframe {
	/** Time in milliseconds from the start of the timeline. */
	time: number;
	value: AnimationValue;
	/** Easing of the segment from this keyframe to the next (default `linear`). */
	easing?: AnimationEasing;
}

export interface AnimationTrack {
	keyframes: AnimationKeyframe[];
	/** Disabled tracks keep their keyframes but do not animate (default `true`). */
	enabled?: boolean;
}

/** How a track's values interpolate: numbers linearly, colours in OKLab. */
export type AnimationValueType = 'number' | 'color';

function isValue(value: unknown): value is AnimationValue {
	return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string';
}

/** Whether `value` is a well-formed keyframe. */
export function isAnimationKeyframe(value: unknown): value is AnimationKeyframe {
	if (typeof value !== 'object' || value === null) return false;
	const k = value as Record<string, unknown>;
	return (
		typeof k.time === 'number' &&
		Number.isFinite(k.time) &&
		isValue(k.value) &&
		(k.easing === undefined || isAnimationEasing(k.easing))
	);
}

const sortedCache = new WeakMap<readonly AnimationKeyframe[], { items: AnimationKeyframe[]; out: AnimationKeyframe[] }>();

/**
 * Keyframes sorted by time, invalid entries dropped and duplicate times merged (the *later*
 * entry in the array wins, so appending a keyframe replaces one at the same time). Cached per
 * array (revalidated by element identity), so evaluating every frame does not re-sort; treat
 * keyframe objects as immutable.
 */
export function normalizeKeyframes(keyframes: readonly AnimationKeyframe[] | undefined | null): AnimationKeyframe[] {
	if (!Array.isArray(keyframes)) return [];
	const cached = sortedCache.get(keyframes);
	// The array may have been edited in place since: reuse only while it holds the same keyframes.
	if (cached && cached.items.length === keyframes.length && cached.items.every((k, i) => k === keyframes[i])) return cached.out;
	const indexed = keyframes
		.map((k, i) => ({ k, i }))
		.filter(({ k }) => isAnimationKeyframe(k))
		.sort((a, b) => a.k.time - b.k.time || a.i - b.i);
	const out: AnimationKeyframe[] = [];
	let lastIndex = -1;
	for (const { k, i } of indexed) {
		const prev = out[out.length - 1];
		if (prev && Math.abs(k.time - prev.time) <= ANIMATION_TIME_EPSILON) {
			if (i > lastIndex) {
				out[out.length - 1] = k;
				lastIndex = i;
			}
			continue;
		}
		out.push(k);
		lastIndex = i;
	}
	sortedCache.set(keyframes, { items: [...keyframes], out });
	return out;
}
