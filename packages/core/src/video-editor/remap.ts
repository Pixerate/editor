import type { VideoEdit } from './edit.js';
import { splitVideoAnimatable, videoEaseBezier, videoKeyframeBreakpoints, videoValueAt, type VideoEase, type VideoKey, type VideoKeyframes } from './keyframes.js';
import type { VideoClip, VideoMediaClip } from './types.js';

/**
 * Speed ramps and freeze frames: a media clip's `timeRemap` keys map clip time to source time after
 * its in point. The slope between two keys is the speed there; equal values are a freeze; an eased
 * segment changes speed smoothly. These helpers read and build them.
 */

/** Where in the source (ms) a media clip is at clip time `clipTime`, through its speed or its ramp. */
export function videoClipSourceTime(clip: VideoMediaClip, clipTime: number): number {
	const base = clip.in ?? 0;
	return clip.timeRemap ? base + videoValueAt(clip.timeRemap, clipTime, 0) : base + clipTime * (clip.speed ?? 1);
}

/** The speed a media clip plays at at clip time `clipTime` (0 in a freeze), measured over a millisecond. */
export function videoClipSpeedAt(clip: VideoClip, clipTime: number): number {
	if (clip.type !== 'media') return 1;
	if (!clip.timeRemap) return clip.speed ?? 1;
	const t = Math.min(Math.max(clipTime, 0), Math.max(0, clip.duration - 1));
	return Math.max(0, videoClipSourceTime(clip, t + 1) - videoClipSourceTime(clip, t));
}

/** One stretch of a ramp: `duration` ms of the clip at `speed`, or easing from `speed` to `toSpeed`. 0 is a freeze. */
export interface VideoSpeedSegment {
	duration: number;
	speed: number;
	/** Ramp smoothly to this speed by the end of the stretch (default: stay at `speed`). */
	toSpeed?: number;
}

/**
 * Remap keys for stretches of speed, from the clip's start: steady stretches are linear segments,
 * ramps a cubic-bezier ease that changes the speed evenly from one to the other (the source moves
 * the average of the two speeds over the stretch). Returns the keys and the source the clip plays.
 */
export function videoSpeedRampKeys(segments: readonly VideoSpeedSegment[]): { keys: VideoKey[]; duration: number; source: number } {
	if (!segments.length) throw new Error('Give at least one stretch { duration, speed }.');
	const keys: VideoKey[] = [];
	let t = 0;
	let v = 0;
	segments.forEach((s, i) => {
		if (!(s.duration > 0)) throw new Error(`Stretch ${i + 1} needs a duration above 0 ms.`);
		for (const [name, x] of [['speed', s.speed], ['toSpeed', s.toSpeed]] as const)
			if (x !== undefined && !(x >= 0 && x <= 20)) throw new Error(`Stretch ${i + 1}'s ${name} must be from 0 (a freeze) to 20; got ${x}.`);
		const a = s.speed;
		const b = s.toSpeed ?? s.speed;
		const avg = (a + b) / 2;
		let ease: VideoEase = 'linear';
		if (a !== b && avg > 0) {
			// The source position is quadratic in time; as a cubic bezier its handles sit a third of the way along, at the end slopes.
			ease = [1 / 3, (2 * a) / (3 * (a + b)), 2 / 3, 1 - (2 * b) / (3 * (a + b))].map((n) => Math.round(n * 1e6) / 1e6) as [number, number, number, number];
		}
		keys.push({ t, v, ...(ease === 'linear' ? {} : { ease }) });
		t += s.duration;
		v += avg * s.duration;
	});
	keys.push({ t, v });
	return { keys: mergeLinear(keys), duration: t, source: v };
}

/** Drops keys in the middle of a straight line, so steady speed is one segment. */
function mergeLinear(keys: VideoKey[]): VideoKey[] {
	const out: VideoKey[] = [keys[0]];
	for (let i = 1; i < keys.length; i++) {
		const prev = out[out.length - 1];
		const k = keys[i];
		const before = out.length > 1 ? out[out.length - 2] : null;
		// prev sits on a straight line from before to k: drop it (k keeps its own ease onward).
		if (before && !before.ease && !prev.ease) {
			const s1 = (prev.v - before.v) / (prev.t - before.t);
			const s2 = (k.v - prev.v) / (k.t - prev.t);
			if (Math.abs(s1 - s2) < 1e-9) {
				out[out.length - 1] = k;
				continue;
			}
		}
		out.push(k);
	}
	return out;
}

/**
 * Checks remap keys: in time order and never going back in the source, eased segments included
 * (each is sampled, so a curve that overshoots and would play backwards is caught). Throws a
 * readable error.
 */
export function checkVideoTimeRemap(remap: VideoKeyframes, path = 'timeRemap'): void {
	const { keys } = remap;
	if (!keys.length) throw new Error(`${path} needs at least one key.`);
	keys.forEach((k, i) => {
		if (k.v < 0) throw new Error(`${path}.keys[${i}].v must be at least 0 (ms after the in point).`);
		const next = keys[i + 1];
		if (!next) return;
		if (next.v < k.v - 1e-6) throw new Error(`${path}.keys[${i + 1}] goes back in the source (${next.v} ms after ${k.v} ms); a ramp only plays forwards, so make each value at least the one before.`);
		if (!videoEaseBezier(k.ease)) return;
		let prev = k.v;
		for (let n = 1; n <= 32; n++) {
			const v = videoValueAt(remap, k.t + ((next.t - k.t) * n) / 32);
			if (v < prev - 1e-3) throw new Error(`${path}.keys[${i}].ease overshoots, which would play backwards; use a curve that only moves forwards (or linear).`);
			prev = v;
		}
	});
}

/** The stretch of source (ms, from the in point) a ramp plays: from its first key's value to its last's. */
export function videoTimeRemapSpan(remap: VideoKeyframes): { from: number; to: number } {
	return { from: remap.keys[0].v, to: remap.keys[remap.keys.length - 1].v };
}

/** Clip time and source time pairs tracing a ramp as straight lines (eased stretches sampled every `step` ms), with freezes marked. */
export function videoTimeRemapBreakpoints(remap: VideoKeyframes, step: number): { t: number; v: number }[] {
	const { points, holds } = videoKeyframeBreakpoints(remap, step);
	const out: { t: number; v: number }[] = [];
	points.forEach(([t, v], i) => {
		out.push({ t, v });
		// A hold keeps its value up to the next key, then jumps forward.
		if (holds.has(i) && points[i + 1]) out.push({ t: points[i + 1][0], v });
	});
	return out;
}

/** The edit that plays a media clip through stretches of speed from the moment it shows at its start (see `videoSpeedRampKeys`). */
export function videoSpeedRampEdit(clip: VideoMediaClip, segments: readonly VideoSpeedSegment[], ripple = true): VideoEdit {
	const ramp = videoSpeedRampKeys(segments);
	const offset = videoClipSourceTime(clip, 0) - (clip.in ?? 0);
	return { op: 'set_time_remap', clip: clip.id, keys: ramp.keys.map((k) => ({ ...k, v: k.v + offset })), duration: ramp.duration, ripple };
}

/** The edit that holds the frame a media clip shows at clip time `at` for `duration` ms, then plays on (the clip gets longer). */
export function videoFreezeFrameEdit(clip: VideoMediaClip, at: number, duration: number, ripple = true): VideoEdit {
	if (at < 0 || at > clip.duration) throw new Error(`${Math.round(at)} ms is outside clip "${clip.id}" (0–${clip.duration} ms of clip time).`);
	const remap: VideoKeyframes = clip.timeRemap ?? { keys: [{ t: 0, v: 0 }, { t: clip.duration, v: clip.duration * (clip.speed ?? 1) }] };
	const [left, right] = splitVideoAnimatable(remap, at);
	const keys: VideoKey[] = [...left.keys.slice(0, -1), { ...left.keys[left.keys.length - 1], ease: 'linear' }, ...right.keys.map((k) => ({ ...k, t: k.t + at + duration }))];
	return { op: 'set_time_remap', clip: clip.id, keys, duration: clip.duration + duration, ripple };
}

/** A slow-motion ramp preset for a clip of `duration` ms: normal speed for half of it, a 500 ms glide down to 0.3×, then 1.5 s at 0.3×. */
export const videoSlowMotionRamp = (duration: number): VideoSpeedSegment[] => [
	{ duration: Math.max(1, duration / 2), speed: 1 },
	{ duration: 500, speed: 1, toSpeed: 0.3 },
	{ duration: 1500, speed: 0.3 }
];
