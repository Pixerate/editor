// Portions ported from filmcraft-main/crates/project/src/keyframe.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import type { CanvasNode } from '../types.js';
import { mixColorsOklab } from './color.js';
import { evaluateEasing } from './easing.js';
import {
	ANIMATABLE_PROPERTIES,
	clampAnimationValue,
	getNodeAnimation,
	normalizeKeyframes,
	type AnimatableProperty,
	type AnimationKeyframe,
	type AnimationPropertyOptions,
	type AnimationTrack,
	type AnimationValue,
	type AnimationValueType
} from './model.js';

/** How time past the end of the timeline maps back into it. */
export type AnimationLoopMode = 'none' | 'loop' | 'ping-pong';

/** Nodes, or a document holding them. */
export type AnimationDocument = readonly CanvasNode[] | { readonly nodes: readonly CanvasNode[] };

/** Evaluated values: node id → property key → value. */
export type AnimationOverrides = Record<string, Record<string, AnimationValue>>;

const nodesOf = (doc: AnimationDocument): readonly CanvasNode[] => (Array.isArray(doc) ? doc : (doc as { nodes: readonly CanvasNode[] }).nodes);

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

/** The last keyframe time over the enabled tracks of the nodes (0 when nothing is animated). */
export function getAnimationDuration(doc: AnimationDocument): number {
	let end = 0;
	for (const node of nodesOf(doc)) {
		const animation = getNodeAnimation(node);
		if (!animation) continue;
		for (const track of Object.values(animation.tracks)) {
			if (!track || track.enabled === false) continue;
			const keys = normalizeKeyframes(track.keyframes);
			if (keys.length > 0) end = Math.max(end, keys[keys.length - 1].time);
		}
	}
	return end;
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

export interface EvaluateAnimationOptions extends AnimationPropertyOptions {
	/** Only evaluate these nodes. */
	ids?: Iterable<string>;
}

/**
 * Evaluates every enabled track at `time`: node id → property → value. The nodes are not
 * touched; apply the result with `applyAnimationOverrides` (or use `applyAnimation`).
 */
export function evaluateAnimation(doc: AnimationDocument, time: number, options: EvaluateAnimationOptions = {}): AnimationOverrides {
	const only = options.ids ? new Set(options.ids) : null;
	const out: AnimationOverrides = {};
	for (const node of nodesOf(doc)) {
		if (only && !only.has(node.id)) continue;
		const animation = getNodeAnimation(node);
		if (!animation) continue;
		let values: Record<string, AnimationValue> | undefined;
		for (const [key, track] of Object.entries(animation.tracks)) {
			if (!track || track.enabled === false) continue;
			const property = (options.properties ?? ANIMATABLE_PROPERTIES).find((p) => p.key === key);
			const value = evaluateTrack(track, time, property?.type ?? 'number');
			if (value === undefined) continue;
			(values ??= {})[key] = clampAnimationValue(property, value);
		}
		if (values) out[node.id] = values;
	}
	return out;
}

/**
 * Writes evaluated values into copies of the nodes (in the registry's order). Nodes without
 * overrides keep their identity, and the input array is returned when nothing changes.
 */
export function applyAnimationOverrides<TNode extends CanvasNode>(nodes: readonly TNode[], overrides: AnimationOverrides, options: AnimationPropertyOptions = {}): TNode[] {
	const properties: readonly AnimatableProperty[] = options.properties ?? ANIMATABLE_PROPERTIES;
	let changed = false;
	const out = nodes.map((node) => {
		const values = overrides[node.id];
		if (!values) return node;
		let next: CanvasNode = node;
		for (const property of properties) {
			if (!(property.key in values)) continue;
			next = property.write(next, values[property.key]);
		}
		if (next !== node) changed = true;
		return next as TNode;
	});
	return changed ? out : (nodes as TNode[]);
}

/**
 * The nodes as they look at `time`: `applyAnimationOverrides(nodes, evaluateAnimation(nodes, time))`.
 * Run it after `resolveCanvasTokens` so animated values win over token values while playing.
 */
export function applyAnimation<TNode extends CanvasNode>(nodes: readonly TNode[], time: number, options: EvaluateAnimationOptions = {}): TNode[] {
	return applyAnimationOverrides(nodes, evaluateAnimation(nodes, time, options), options);
}
