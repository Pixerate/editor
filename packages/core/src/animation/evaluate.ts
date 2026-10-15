// Portions ported from filmcraft-main/crates/project/src/keyframe.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { mixColorsOklab } from './color.js';
import { evaluateEasing } from './easing.js';
import { normalizeKeyframes, type AnimationKeyframe, type AnimationTrack, type AnimationValue, type AnimationValueType } from './keyframes.js';

/** How time past the end of the timeline maps back into it. */
export type AnimationLoopMode = 'none' | 'loop' | 'ping-pong';

/**
 * Interpolates between two keyframe values: numbers linearly, colours in OKLab (premultiplied
 * alpha). Mismatched or unreadable values hold `from` until `t` reaches 1.
 */
export function interpolateAnimationValue(from: AnimationValue, to: AnimationValue, t: number, type: AnimationValueType = 'number'): AnimationValue {
	// Numbers extrapolate, so overshooting easings (back, spring) overshoot the value too.
	if (typeof from === 'number' && typeof to === 'number') return from + (to - from) * t;
	if (t <= 0) return from;
	if (t >= 1) return to;
	if (type === 'color' || (typeof from === 'string' && typeof to === 'string')) {
		const mixed = mixColorsOklab(from, to, t);
		if (mixed !== null) return mixed;
	}
	return from;
}

/** Index of the last keyframe at or before `time` (-1 before the first). Binary search. */
function segmentIndex(keys: readonly AnimationKeyframe[], time: number): number {
	let lo = 0;
	let hi = keys.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (keys[mid].time <= time) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return found;
}

/**
 * A track's value at `time`. Before the first keyframe it holds the first value, after the
 * last the last value. Keyframes may be unsorted or share times (see `normalizeKeyframes`).
 * Returns `undefined` for a track without valid keyframes.
 */
export function evaluateTrack(track: AnimationTrack | readonly AnimationKeyframe[] | undefined | null, time: number, type: AnimationValueType = 'number'): AnimationValue | undefined {
	const keyframes = Array.isArray(track) ? track : (track as AnimationTrack | undefined)?.keyframes;
	const keys = normalizeKeyframes(keyframes as AnimationKeyframe[]);
	if (keys.length === 0) return undefined;
	if (!(time > keys[0].time)) return keys[0].value;
	const last = keys[keys.length - 1];
	if (time >= last.time) return last.value;
	const i = segmentIndex(keys, time);
	const a = keys[i];
	const b = keys[i + 1];
	if (time === a.time) return a.value;
	const span = b.time - a.time;
	const u = (time - a.time) / span;
	if (a.easing === 'hold') return a.value;
	return interpolateAnimationValue(a.value, b.value, evaluateEasing(a.easing, u, span), type);
}

/**
 * Maps a running time onto the timeline `[0, duration]`: clamped (`none`), wrapped (`loop`)
 * or bounced (`ping-pong`).
 */
export function wrapAnimationTime(time: number, duration: number, loop: AnimationLoopMode = 'none'): number {
	if (!Number.isFinite(time)) return 0;
	if (!(duration > 0)) return 0;
	if (loop === 'loop') return ((time % duration) + duration) % duration;
	if (loop === 'ping-pong') {
		const period = duration * 2;
		const m = ((time % period) + period) % period;
		return m <= duration ? m : period - m;
	}
	return Math.min(duration, Math.max(0, time));
}
