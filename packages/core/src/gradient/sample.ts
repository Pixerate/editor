/**
 * Gradients from sampled colours: `simplifyGradientStops` reduces a noisy run of colours (pixels
 * read along a line from a photo, a paint stroke or a shape) to the few stops that reproduce it
 * within a perceptual tolerance, and `sampleGradientFromLine` reads those colours from any pixel
 * reader and returns a linear gradient.
 *
 * Distances are Euclidean in OKLab (ΔE OK, about 0.02 is a just-noticeable step), against the
 * OKLab interpolation the returned gradients use, so what is measured is what is drawn.
 */

import { formatHex, parseColor, rgbToOklab, oklabToRgb, type Rgba } from '../color/index.js';
import { angleFromPointer } from './editor.js';
import { normalizeGradient } from './model.js';
import type { Gradient, GradientStop } from './types.js';

export interface SimplifyGradientStopsOptions {
	/** Largest perceptual error left between the samples and the stops, in OKLab ΔE (default 0.06). */
	tolerance?: number;
	/** Fewest stops to return (default 2, at least 2). */
	minStops?: number;
	/** Most stops to return (default 5, at least `minStops`). */
	maxStops?: number;
	/**
	 * Samples on each side averaged into each one before fitting, to ignore grain, JPEG noise and
	 * brush texture (default 2; 0 fits the raw samples).
	 */
	smoothing?: number;
}

export interface RawGradientSample {
	/** Position along the line, 0..1. */
	offset: number;
	/** Any CSS colour, or RGBA bytes `[r, g, b, a]` (0..255). */
	color: string | readonly [number, number, number, number];
}

export interface SimplifiedGradientStops {
	stops: GradientStop[];
	/** The largest OKLab distance left between a (smoothed) sample and the stops. */
	maxError: number;
}

/** A sample in OKLab with alpha, for fitting. */
interface LabSample {
	t: number;
	v: [number, number, number, number];
}

const DEFAULT_TOLERANCE = 0.06;

function toRgba(color: RawGradientSample['color']): Rgba | null {
	if (typeof color === 'string') return parseColor(color);
	if (Array.isArray(color) && color.length >= 4 && color.slice(0, 4).every((v) => Number.isFinite(v))) {
		return { r: color[0] / 255, g: color[1] / 255, b: color[2] / 255, a: color[3] / 255 };
	}
	return null;
}

const dist = (a: LabSample['v'], b: LabSample['v']) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], (a[3] - b[3]) * 0.5);

function lerpAt(a: LabSample, b: LabSample, t: number): LabSample['v'] {
	const u = b.t - a.t > 1e-9 ? (t - a.t) / (b.t - a.t) : 0;
	return [0, 1, 2, 3].map((k) => a.v[k] + (b.v[k] - a.v[k]) * u) as LabSample['v'];
}

/** The worst-fitting sample strictly between two stops (by index), or -1 when none. */
function worst(samples: readonly LabSample[], i0: number, i1: number): { index: number; error: number } {
	let index = -1;
	let error = 0;
	for (let i = i0 + 1; i < i1; i++) {
		const e = dist(samples[i].v, lerpAt(samples[i0], samples[i1], samples[i].t));
		if (e > error) {
			error = e;
			index = i;
		}
	}
	return { index, error };
}

function maxErrorOf(samples: readonly LabSample[], at: readonly number[]): number {
	let e = 0;
	for (let k = 0; k + 1 < at.length; k++) e = Math.max(e, worst(samples, at[k], at[k + 1]).error);
	return e;
}

/**
 * Like `simplifyGradientStops`, with the largest error left. Throws a sentence when the input
 * can't make a gradient (fewer than two readable samples, or options out of range).
 */
export function fitGradientStops(samples: readonly RawGradientSample[], options: SimplifyGradientStopsOptions = {}): SimplifiedGradientStops {
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
	if (!(tolerance > 0 && tolerance <= 1)) throw new Error(`tolerance ${tolerance} is out of range; use a ΔE above 0 and at most 1 (0.02 is a just-noticeable step).`);
	const minStops = Math.max(2, Math.floor(options.minStops ?? 2));
	const maxStops = Math.floor(options.maxStops ?? Math.max(5, minStops));
	if (!(maxStops >= minStops)) throw new Error(`maxStops ${options.maxStops} is below minStops ${minStops}.`);
	const smoothing = Math.max(0, Math.floor(options.smoothing ?? 2));

	const raw: LabSample[] = [];
	for (const s of samples) {
		if (!s || !Number.isFinite(s.offset)) continue;
		const c = toRgba(s.color);
		if (!c) continue;
		const lab = rgbToOklab({ ...c, a: c.a ?? 1 });
		raw.push({ t: Math.min(1, Math.max(0, s.offset)), v: [lab.l, lab.a, lab.b, c.a ?? 1] });
	}
	if (raw.length < 2) throw new Error(`Need at least two readable samples to make a gradient; got ${raw.length}.`);
	raw.sort((a, b) => a.t - b.t);

	// A moving average in OKLab (shrinking at the ends, so the end colours stay their own).
	const lab: LabSample[] = raw.map((s, i) => {
		const r = Math.min(smoothing, i, raw.length - 1 - i);
		const v: LabSample['v'] = [0, 0, 0, 0];
		for (let j = i - r; j <= i + r; j++) for (let k = 0; k < 4; k++) v[k] += raw[j].v[k] / (2 * r + 1);
		return { t: s.t, v };
	});

	// Recursive subdivision, worst segment first: add the sample furthest from the stops so far.
	const at = [0, lab.length - 1];
	while (at.length < maxStops) {
		let best = { index: -1, error: 0 };
		for (let k = 0; k + 1 < at.length; k++) {
			const w = worst(lab, at[k], at[k + 1]);
			if (w.error > best.error) best = w;
		}
		if (best.index < 0 && at.length < minStops) {
			// Nothing to fit (flat colour): split the widest gap to reach minStops.
			let k = 0;
			for (let j = 1; j + 1 < at.length; j++) if (at[j + 1] - at[j] > at[k + 1] - at[k]) k = j;
			if (at[k + 1] - at[k] > 1) best = { index: (at[k] + at[k + 1]) >> 1, error: 0 };
		}
		if (best.index < 0 || (best.error <= tolerance && at.length >= minStops)) break;
		at.push(best.index);
		at.sort((a, b) => a - b);
	}

	// Drop stops the blend between their neighbours already reproduces (subdivision can leave some
	// behind once later stops are in), keeping at least `minStops`.
	for (let k = 1; k + 1 < at.length && at.length > minStops; ) {
		if (worst(lab, at[k - 1], at[k + 1]).error <= tolerance) at.splice(k, 1);
		else k++;
	}

	const stops: GradientStop[] = at.map((i, k) => {
		const [l, a, b, alpha] = lab[i].v;
		// formatHex maps out-of-gamut blends back into sRGB.
		const color = formatHex(oklabToRgb({ l, a, b, alpha: Math.min(1, Math.max(0, alpha)) }));
		return { id: `s${k + 1}`, offset: k === 0 ? 0 : k === at.length - 1 ? 1 : Math.round(lab[i].t * 1000) / 1000, color };
	});
	return { stops, maxError: Math.round(maxErrorOf(lab, at) * 1e4) / 1e4 };
}

/**
 * Reduces colours sampled along a line (offsets 0..1) to a minimal set of gradient stops. The
 * first and last stops sit at 0 and 1; stops are added where the colour turns most until every
 * sample is within `tolerance` (OKLab ΔE) of the OKLab blend between its stops, or `maxStops` is
 * reached. Samples that can't be read (a bad colour string) are skipped. Throws when fewer than two
 * samples can be read.
 */
export function simplifyGradientStops(samples: readonly RawGradientSample[], options?: SimplifyGradientStopsOptions): GradientStop[] {
	return fitGradientStops(samples, options).stops;
}

export interface LineSamplingOptions extends SimplifyGradientStopsOptions {
	/** Colours read along the line, ends included (default 32, 2..1024). */
	sampleCount?: number;
	/** Snap the line's angle to multiples of this many degrees (e.g. 15, for Shift), keeping its length. */
	snapStep?: number;
}

/**
 * Reads colours along the line from `start` to `end` with `readPixel` (which returns a CSS colour,
 * RGBA bytes, or null where there is nothing to read) and returns a linear gradient (OKLab
 * interpolation) whose angle is the line's (CSS degrees) and whose stops are the simplified
 * colours, offsets measured along the line. Returns null when fewer than two points could be read.
 */
export function sampleGradientFromLine(
	readPixel: (point: { x: number; y: number }) => string | readonly [number, number, number, number] | null,
	start: { x: number; y: number },
	end: { x: number; y: number },
	options: LineSamplingOptions = {}
): Gradient | null {
	const count = Math.floor(options.sampleCount ?? 32);
	if (!(count >= 2 && count <= 1024)) throw new Error(`sampleCount ${options.sampleCount} is out of range; use 2..1024.`);
	if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) throw new Error('start and end need finite x and y.');
	const length = Math.hypot(end.x - start.x, end.y - start.y);
	if (length < 1e-9) throw new Error('start and end are the same point; drag a line to sample along.');
	const angle = angleFromPointer(start, end, options.snapStep);
	// With snapping, sample along the snapped direction, at the dragged length.
	const to = options.snapStep
		? { x: start.x + Math.sin((angle * Math.PI) / 180) * length, y: start.y - Math.cos((angle * Math.PI) / 180) * length }
		: end;
	const samples: RawGradientSample[] = [];
	for (let i = 0; i < count; i++) {
		const t = i / (count - 1);
		const color = readPixel({ x: start.x + (to.x - start.x) * t, y: start.y + (to.y - start.y) * t });
		if (color !== null && color !== undefined) samples.push({ offset: t, color });
	}
	if (samples.length < 2) return null;
	const { stops } = fitGradientStops(samples, options);
	const res = normalizeGradient({ type: 'linear', angle, stops, interpolation: 'oklab' });
	if ('error' in res) throw new Error(res.error);
	return res.gradient;
}
