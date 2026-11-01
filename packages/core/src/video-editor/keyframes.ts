/**
 * Keyframes for a clip's opacity, volume and transform. A property is either a plain number or
 * `{ keys }`: values at clip-relative times (ms from the clip's start), each with the easing of the
 * segment that leaves it. Pure functions only, so previews, renders and exports agree.
 *
 * Easing is stored as CSS `cubic-bezier(x1, y1, x2, y2)` control points (named easings are the CSS
 * ones), which is also what After Effects / Lottie speed-and-influence handles convert to exactly.
 */

/** How a segment moves from its key to the next: a named curve, `hold` (jump at the next key) or CSS cubic-bezier points. */
export type VideoEase = 'linear' | 'hold' | 'ease-in' | 'ease-out' | 'ease-in-out' | [number, number, number, number];
export const VIDEO_EASE_NAMES = ['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out'] as const;

export interface VideoKey {
	/** Clip-relative time (ms from the clip's start). */
	t: number;
	v: number;
	/** The segment from this key to the next (default linear). Ignored on the last key. */
	ease?: VideoEase;
}

export interface VideoKeyframes {
	/** In time order, at least one. Two keys at one time make a jump: the value just before, then the value from there on. */
	keys: VideoKey[];
}

/** A number, or keyframes for it. */
export type VideoAnimatable = number | VideoKeyframes;

/** The clip properties that can be keyframed: `opacity`, `volume` (media) and the transform's fields. */
export type VideoKeyframeProperty = 'opacity' | 'volume' | 'x' | 'y' | 'scale' | 'rotation';
export const VIDEO_KEYFRAME_PROPERTIES = ['opacity', 'volume', 'x', 'y', 'scale', 'rotation'] as const;
export const VIDEO_TRANSFORM_PROPERTIES = ['x', 'y', 'scale', 'rotation'] as const;

/** Each property's default and allowed range. */
export const VIDEO_KEYFRAME_LIMITS: Record<VideoKeyframeProperty, { default: number; min?: number; max?: number }> = {
	opacity: { default: 1, min: 0, max: 1 },
	volume: { default: 1, min: 0, max: 4 },
	x: { default: 0 },
	y: { default: 0 },
	scale: { default: 1, min: 0 },
	rotation: { default: 0 }
};

const NAMED: Record<'ease-in' | 'ease-out' | 'ease-in-out', [number, number, number, number]> = {
	'ease-in': [0.42, 0, 1, 1],
	'ease-out': [0, 0, 0.58, 1],
	'ease-in-out': [0.42, 0, 0.58, 1]
};

export const isVideoKeyframes = (v: unknown): v is VideoKeyframes => typeof v === 'object' && v !== null && Array.isArray((v as VideoKeyframes).keys);

/** The cubic-bezier points for an ease (`null` for linear and hold). */
export function videoEaseBezier(ease: VideoEase | undefined): [number, number, number, number] | null {
	if (ease === undefined || ease === 'linear' || ease === 'hold') return null;
	return Array.isArray(ease) ? ease : NAMED[ease];
}

const bez = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - s) * s + 3 * b * (1 - s) * s * s + s * s * s;
const bezSlope = (a: number, b: number, s: number) => 3 * a * (1 - s) * (1 - s) + 6 * (b - a) * (1 - s) * s + 3 * (1 - b) * s * s;

/** The curve parameter where a cubic-bezier's x is `x`: Newton's method, then bisection if that fails. */
function bezierParam(x1: number, x2: number, x: number): number {
	let s = x;
	for (let i = 0; i < 8; i++) {
		const err = bez(x1, x2, s) - x;
		if (Math.abs(err) < 1e-7) return s;
		const d = bezSlope(x1, x2, s);
		if (Math.abs(d) < 1e-6) break;
		s -= err / d;
		if (s < 0 || s > 1) break;
	}
	let lo = 0;
	let hi = 1;
	s = x;
	for (let i = 0; i < 60; i++) {
		const v = bez(x1, x2, s);
		if (Math.abs(v - x) < 1e-9) break;
		if (v < x) lo = s;
		else hi = s;
		s = (lo + hi) / 2;
	}
	return s;
}

/** How far (0–1 in, any y out) an ease has got at progress `p` (0–1) through its segment. */
export function videoEaseProgress(ease: VideoEase | undefined, p: number): number {
	if (p <= 0) return 0;
	if (p >= 1) return ease === 'hold' ? 0 : 1;
	if (ease === 'hold') return 0;
	const b = videoEaseBezier(ease);
	if (!b) return p;
	return bez(b[1], b[3], bezierParam(b[0], b[2], p));
}

/** The index of the last key at or before `t` (-1 before the first). */
function keyBefore(keys: readonly VideoKey[], t: number): number {
	let lo = 0;
	let hi = keys.length - 1;
	if (t < keys[0].t) return -1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (keys[mid].t <= t) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * A property's value at clip-relative time `clipTime` (ms): the number itself, or the keys
 * interpolated (held before the first and after the last). `fallback` is used when it is unset.
 */
export function videoValueAt(prop: VideoAnimatable | undefined, clipTime: number, fallback = 0): number {
	if (prop === undefined) return fallback;
	if (typeof prop === 'number') return prop;
	const { keys } = prop;
	if (!keys.length) return fallback;
	const i = keyBefore(keys, clipTime);
	if (i < 0) return keys[0].v;
	if (i >= keys.length - 1) return keys[keys.length - 1].v;
	const a = keys[i];
	const b = keys[i + 1];
	if (a.ease === 'hold') return a.v;
	return a.v + (b.v - a.v) * videoEaseProgress(a.ease, (clipTime - a.t) / (b.t - a.t));
}

/** A property's keys (a plain number or unset gives none). */
export const videoKeysOf = (prop: VideoAnimatable | undefined): VideoKey[] => (isVideoKeyframes(prop) ? prop.keys : []);

/** Shifts every key by `dt` ms (or scales times by `k` first); numbers pass through. */
export function retimeVideoAnimatable<T extends VideoAnimatable | undefined>(prop: T, dt: number, k = 1): T {
	if (!isVideoKeyframes(prop)) return prop;
	return { keys: prop.keys.map((key) => ({ ...key, t: key.t * k + dt })) } as T;
}

/** Splits a cubic-bezier ease at progress `p`, giving the eases of the two halves (renormalised). */
function splitEase(ease: VideoEase | undefined, p: number): [VideoEase | undefined, VideoEase | undefined] {
	if (ease === 'hold') return ['hold', 'hold'];
	const b = videoEaseBezier(ease);
	if (!b) return [ease, ease];
	const s = bezierParam(b[0], b[2], p);
	const lerp = (u: [number, number], v: [number, number], k: number): [number, number] => [u[0] + (v[0] - u[0]) * k, u[1] + (v[1] - u[1]) * k];
	const P0: [number, number] = [0, 0];
	const P1: [number, number] = [b[0], b[1]];
	const P2: [number, number] = [b[2], b[3]];
	const P3: [number, number] = [1, 1];
	const A = lerp(P0, P1, s);
	const B = lerp(P1, P2, s);
	const C = lerp(P2, P3, s);
	const AB = lerp(A, B, s);
	const BC = lerp(B, C, s);
	const M = lerp(AB, BC, s);
	const r = (v: number) => Math.round(v * 1e6) / 1e6;
	// Each half is rescaled to run 0–1 in both x and y; one with no rise has nothing to ease.
	const left: VideoEase | undefined = Math.abs(M[1]) < 1e-9 ? 'linear' : [r(A[0] / M[0]), r(A[1] / M[1]), r(AB[0] / M[0]), r(AB[1] / M[1])];
	const dx = 1 - M[0];
	const dy = 1 - M[1];
	const right: VideoEase | undefined = Math.abs(dy) < 1e-9 ? 'linear' : [r((BC[0] - M[0]) / dx), r((BC[1] - M[1]) / dy), r((C[0] - M[0]) / dx), r((C[1] - M[1]) / dy)];
	return [left, right];
}

/**
 * Splits keyframes at clip time `at`: the keys before it (with a key added at `at`) and the keys
 * after it, moved to start at 0 (with a key added at 0). Eased segments across the cut are split
 * into two curves that trace the same path, so the two halves play exactly as the whole did.
 */
export function splitVideoAnimatable<T extends VideoAnimatable | undefined>(prop: T, at: number): [T, T] {
	if (!isVideoKeyframes(prop)) return [prop, prop];
	const keys = prop.keys;
	const eps = 1e-6;
	const v = videoValueAt(prop, at);
	const i = keyBefore(keys, at);
	const exact = i >= 0 && Math.abs(keys[i].t - at) < eps;
	let leftEase: VideoEase | undefined;
	let rightEase: VideoEase | undefined;
	if (exact) rightEase = keys[i].ease;
	else if (i >= 0 && i < keys.length - 1) {
		const a = keys[i];
		[leftEase, rightEase] = splitEase(a.ease, (at - a.t) / (keys[i + 1].t - a.t));
	}
	const before = keys.slice(0, exact ? i : i + 1).map((k) => ({ ...k }));
	if (before.length && leftEase !== undefined) before[before.length - 1] = withEase(before[before.length - 1], leftEase);
	const left: VideoKey[] = [...before, { t: at, v }];
	const right: VideoKey[] = [withEase({ t: 0, v }, rightEase), ...keys.slice(i + 1).map((k) => ({ ...k, t: k.t - at }))];
	return [{ keys: left } as T, { keys: right } as T];
}

const withEase = (key: VideoKey, ease: VideoEase | undefined): VideoKey => {
	const { ease: _old, ...rest } = key;
	return ease === undefined || ease === 'linear' ? rest : { ...rest, ease };
};

/**
 * The keys sorted by time. Two keys may share a time (a jump, as at a camera move's cut: the
 * value just before, then the value from there on) unless `jumps` is false; three never can.
 */
export function sortVideoKeys(keys: readonly VideoKey[], options: { jumps?: boolean } = {}): VideoKey[] {
	// A stable sort keeps a jump's two keys in the order given.
	const sorted = [...keys].sort((a, b) => a.t - b.t);
	const problem = videoKeyTimesProblem(sorted, options.jumps !== false);
	if (problem) throw new Error(problem);
	return sorted;
}

/** What is wrong with sorted keys' times (more than two at a time, or two when `jumps` is false), or null. */
export function videoKeyTimesProblem(keys: readonly VideoKey[], jumps = true): string | null {
	for (let i = 1; i < keys.length; i++) {
		if (Math.abs(keys[i].t - keys[i - 1].t) >= 1e-6) continue;
		if (!jumps) return `Two keys are at ${keys[i].t} ms; give each key its own time.`;
		if (i >= 2 && Math.abs(keys[i].t - keys[i - 2].t) < 1e-6) return `Three keys are at ${keys[i].t} ms; a time takes one key, or two for a jump (the value just before, then the value after).`;
	}
	return null;
}

/**
 * Keys with one set (or replaced) at `t`: a plain value becomes keys holding it and the new one.
 * For a keyframe toggle or "add key at playhead".
 */
export function setVideoKey(prop: VideoAnimatable | undefined, key: VideoKey, fallback: number): VideoKeyframes {
	const keys = isVideoKeyframes(prop) ? prop.keys.filter((k) => Math.abs(k.t - key.t) >= 1e-6) : [];
	if (!isVideoKeyframes(prop)) {
		const v = prop ?? fallback;
		if (key.t !== 0) keys.push({ t: 0, v });
	}
	return { keys: sortVideoKeys([...keys, key]) };
}

/** Keys with the one at `t` removed; the value it then holds when none are left. */
export function removeVideoKey(prop: VideoKeyframes, t: number): VideoAnimatable {
	const keys = prop.keys.filter((k) => Math.abs(k.t - t) >= 1e-6);
	return keys.length ? { keys } : prop.keys[0].v;
}

// ---------------------------------------------------------------------------------------------
// ffmpeg expressions
// ---------------------------------------------------------------------------------------------

const fmt = (v: number) => {
	const r = Math.round(v * 1e4) / 1e4;
	return Object.is(r, -0) ? '0' : String(r);
};

/** `+n` or `-n`, so expressions never read `--n`. */
const signed = (v: number) => (fmt(v).startsWith('-') ? fmt(v) : `+${fmt(v)}`);

/**
 * Breakpoints `[clipTime, value]` tracing a property as straight lines: linear segments as they
 * are, holds as steps, eased segments sampled every `step` ms (about two frames).
 */
export function videoKeyframeBreakpoints(prop: VideoKeyframes, step: number): { points: [number, number][]; holds: Set<number> } {
	const { keys } = prop;
	const points: [number, number][] = [];
	const holds = new Set<number>();
	for (let i = 0; i < keys.length; i++) {
		const a = keys[i];
		points.push([a.t, a.v]);
		const b = keys[i + 1];
		if (!b) break;
		if (a.ease === 'hold') {
			holds.add(points.length - 1);
			continue;
		}
		if (!videoEaseBezier(a.ease)) continue;
		const n = Math.max(1, Math.ceil((b.t - a.t) / step));
		for (let k = 1; k < n; k++) {
			const t = a.t + ((b.t - a.t) * k) / n;
			points.push([t, videoValueAt(prop, t)]);
		}
	}
	return { points, holds };
}

/**
 * An ffmpeg expression for a property, given `time`: an expression for the clip-relative time in
 * ms (e.g. `(t*1000-1500)`). Piecewise linear `if(lt(…))` chains; eased segments are baked to
 * breakpoints every `step` ms.
 */
export function videoKeyframeFfmpegExpr(prop: VideoAnimatable | undefined, time: string, fallback: number, step: number): string {
	if (!isVideoKeyframes(prop)) return fmt(prop ?? fallback);
	const { points, holds } = videoKeyframeBreakpoints(prop, step);
	if (points.length === 1 || points.every(([, v]) => v === points[0][1])) return fmt(points[0][1]);
	let expr = fmt(points[points.length - 1][1]);
	for (let i = points.length - 2; i >= 0; i--) {
		const [t0, v0] = points[i];
		const [t1, v1] = points[i + 1];
		// A jump (two keys at one time) is never inside its own zero-length segment.
		const seg = holds.has(i) || v0 === v1 || t1 <= t0 ? fmt(v0) : `${fmt(v0)}${signed((v1 - v0) / (t1 - t0))}*(${time}${signed(-t0)})`;
		expr = `if(lt(${time},${fmt(t1)}),${seg},${expr})`;
	}
	return `if(lt(${time},${fmt(points[0][0])}),${fmt(points[0][1])},${expr})`;
}
