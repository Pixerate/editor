/**
 * Variable-width stroke profiles: stroke widths at positions along a path (each subpath on its
 * own), interpolated smoothly and held flat before the first and after the last point. Each
 * point has a left and a right side scale (looking along the path on screen, y down), so a
 * stroke can grow on one side only.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, see THIRD_PARTY_NOTICES.md):
 * - figcraft `crates/doc/src/props.rs` — `WidthProfile` / `WidthPoint`: sanitising, side
 *   scales, inserting and moving points, and the monotone cubic (Fritsch–Carlson) interpolation
 *   that never overshoots its neighbouring points.
 * - vectorcraft `crates/doc/src/appearance.rs` — `WidthProfile` as `(t, left, right)` points,
 *   discontinuous points (two points at one `t` make a step) and the profile presets.
 * - effectcraft `crates/path/src/varstroke.rs` — `width_factor`: the parametric Taper (lengths,
 *   end widths, ease) and Wave (amount, cycles, phase) shapes, used here as profile generators.
 */
import type { VectorWidthPoint } from './types.js';

/** The most points a profile keeps. */
export const VECTOR_WIDTH_PROFILE_MAX_POINTS = 64;
/** The widest a side can be, as a multiple of the stroke width. */
export const VECTOR_WIDTH_PROFILE_MAX_SCALE = 1000;
/** Positions closer than this are the same place (the two sides of a discontinuous point). */
export const VECTOR_WIDTH_SAME_T = 1e-6;

/** Built-in profiles. `uniform` is the plain stroke (no profile). */
export type VectorWidthPreset = 'uniform' | 'taperStart' | 'taperEnd' | 'taperBoth' | 'bulge' | 'pinch' | 'teardrop' | 'wave' | 'pressure';

/** One preset as a menu shows it. */
export interface VectorWidthPresetInfo {
	id: VectorWidthPreset;
	label: string;
	points: readonly VectorWidthPoint[];
}

const sym = (t: number, s: number): VectorWidthPoint => ({ t, left: s, right: s });

/** The built-in profiles, in menu order. */
export const VECTOR_WIDTH_PRESETS: readonly VectorWidthPresetInfo[] = [
	{ id: 'uniform', label: 'Uniform', points: [] },
	{ id: 'taperStart', label: 'Taper start', points: [sym(0, 0), sym(1, 1)] },
	{ id: 'taperEnd', label: 'Taper end', points: [sym(0, 1), sym(1, 0)] },
	{ id: 'taperBoth', label: 'Taper both', points: [sym(0, 0), sym(0.5, 1), sym(1, 0)] },
	// Full width at the ends, swelling to twice the width in the middle.
	{ id: 'bulge', label: 'Bulge', points: [sym(0, 1), sym(0.5, 2), sym(1, 1)] },
	// Full width at the ends, pinched to a quarter in the middle.
	{ id: 'pinch', label: 'Pinch', points: [sym(0, 1), sym(0.5, 0.25), sym(1, 1)] },
	// A round head a fifth of the way along, then a long taper to the end.
	{ id: 'teardrop', label: 'Teardrop', points: [sym(0, 0), sym(0.2, 1), sym(1, 0)] },
	// Two swells between narrow necks.
	{ id: 'wave', label: 'Wave', points: [sym(0, 0.3), sym(0.25, 1), sym(0.5, 0.3), sym(0.75, 1), sym(1, 0.3)] },
	// A pen stroke: a quick press, a slow lift.
	{ id: 'pressure', label: 'Pressure', points: [sym(0, 0.15), sym(0.12, 0.85), sym(0.45, 1), sym(0.8, 0.7), sym(1, 0.05)] }
];

export const VECTOR_WIDTH_PRESET_IDS: readonly VectorWidthPreset[] = VECTOR_WIDTH_PRESETS.map((p) => p.id);

const clean = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : null);

/**
 * A profile as the outline uses it: finite points only, `t` in 0–1, side scales in 0–1000,
 * sorted by `t` (stable, so a step keeps its order), at most 64 points. Points missing a side
 * take the other side's scale.
 */
export function sanitizeWidthProfile(points: readonly Partial<VectorWidthPoint>[] | null | undefined): VectorWidthPoint[] {
	if (!Array.isArray(points)) return [];
	const out: VectorWidthPoint[] = [];
	for (const p of points) {
		if (!p || typeof p !== 'object') continue;
		const t = clean(p.t, 1);
		const l = clean(p.left, VECTOR_WIDTH_PROFILE_MAX_SCALE);
		const r = clean(p.right, VECTOR_WIDTH_PROFILE_MAX_SCALE);
		if (t === null || (l === null && r === null)) continue;
		out.push({ t, left: l ?? r!, right: r ?? l! });
		if (out.length >= VECTOR_WIDTH_PROFILE_MAX_POINTS) break;
	}
	return out.map((p, i) => [p, i] as const).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([p]) => p);
}

/** True when the profile draws a plain stroke: no points, or every side at scale 1. */
export function isUniformWidthProfile(points: readonly VectorWidthPoint[] | null | undefined): boolean {
	return !points?.length || points.every((p) => p.left === 1 && p.right === 1);
}

/** Slope of side `k` from point `i` to `i + 1` (0 when they share a position). */
function secant(pts: readonly VectorWidthPoint[], i: number, k: 'left' | 'right'): number {
	const a = pts[i];
	const b = pts[i + 1];
	return a && b && b.t - a.t > 1e-12 ? (b[k] - a[k]) / (b.t - a.t) : 0;
}

/** Fritsch–Carlson tangent: one-sided at the ends, the harmonic mean of the slopes inside, flat at local extremes. */
function tangent(pts: readonly VectorWidthPoint[], i: number, k: 'left' | 'right'): number {
	const last = pts.length - 1;
	if (i <= 0) return secant(pts, 0, k);
	if (i >= last) return secant(pts, last - 1, k);
	const d0 = secant(pts, i - 1, k);
	const d1 = secant(pts, i, k);
	return d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
}

function interp(pts: readonly VectorWidthPoint[], t: number, k: 'left' | 'right'): number {
	const first = pts[0];
	const last = pts[pts.length - 1];
	if (!(t > first.t)) return first[k];
	if (t >= last.t) return last[k];
	// The last point at or before t (the second of a step at exactly t).
	let i = 0;
	while (i + 1 < pts.length && pts[i + 1].t <= t) i++;
	const a = pts[i];
	const b = pts[i + 1];
	const h = b.t - a.t;
	if (h <= 1e-12) return b[k];
	const u = (t - a.t) / h;
	const u2 = u * u;
	const u3 = u2 * u;
	const w = (2 * u3 - 3 * u2 + 1) * a[k] + (u3 - 2 * u2 + u) * h * tangent(pts, i, k) + (3 * u2 - 2 * u3) * b[k] + (u3 - u2) * h * tangent(pts, i + 1, k);
	return Math.max(0, w);
}

/**
 * The left and right side scales at `t` (0–1 along the subpath by length). Each side is
 * interpolated on its own with a monotone cubic, so the width never overshoots its points;
 * a profile without points is uniform (1, 1).
 */
export function widthProfileAt(points: readonly VectorWidthPoint[] | null | undefined, t: number): { left: number; right: number } {
	if (!points?.length) return { left: 1, right: 1 };
	return { left: interp(points, t, 'left'), right: interp(points, t, 'right') };
}

/** The largest side scale (the interpolation never exceeds its points); 1 without a profile. */
export function widthProfileMaxScale(points: readonly VectorWidthPoint[] | null | undefined): number {
	if (!points?.length) return 1;
	return points.reduce((m, p) => Math.max(m, p.left, p.right), 0);
}

/** The points of a preset (empty for `uniform`), or null for an unknown id. */
export function widthProfilePreset(id: string): VectorWidthPoint[] | null {
	const p = VECTOR_WIDTH_PRESETS.find((q) => q.id === id);
	return p ? p.points.map((q) => ({ ...q })) : null;
}

/** The preset a profile matches: `uniform` without one (or all at scale 1), `custom` when none matches. */
export function widthProfilePresetId(points: readonly VectorWidthPoint[] | null | undefined): VectorWidthPreset | 'custom' {
	if (isUniformWidthProfile(points)) return 'uniform';
	const same = (a: readonly VectorWidthPoint[], b: readonly VectorWidthPoint[]) =>
		a.length === b.length && a.every((p, i) => Math.abs(p.t - b[i].t) < 1e-9 && Math.abs(p.left - b[i].left) < 1e-9 && Math.abs(p.right - b[i].right) < 1e-9);
	return VECTOR_WIDTH_PRESETS.find((p) => p.points.length && same(points!, p.points))?.id ?? 'custom';
}

/** The profile of the reversed path: positions mirrored and the sides swapped. */
export function reverseWidthProfile(points: readonly VectorWidthPoint[]): VectorWidthPoint[] {
	return points.map((p) => ({ t: 1 - p.t, left: p.right, right: p.left })).reverse();
}

/** The profile of a mirrored path (it runs the same way, but its sides swap). */
export function mirrorWidthProfile(points: readonly VectorWidthPoint[]): VectorWidthPoint[] {
	return points.map((p) => ({ t: p.t, left: p.right, right: p.left }));
}

/** The points a profile edit starts from: the profile, or a uniform one with a point at each end. */
function editable(points: readonly VectorWidthPoint[] | null | undefined): VectorWidthPoint[] {
	return points?.length ? points.map((p) => ({ ...p })) : [sym(0, 1), sym(1, 1)];
}

/**
 * Adds a width point at `t` (side scales `left` / `right`, default: as wide as the stroke is
 * there) and returns the new profile and the point's index. Inserting at the position of an
 * existing point replaces it, unless `step` is set (which makes a discontinuous point).
 */
export function insertWidthPoint(
	points: readonly VectorWidthPoint[] | null | undefined,
	t: number,
	sides: { left?: number; right?: number } = {},
	options: { step?: boolean } = {}
): { points: VectorWidthPoint[]; index: number } {
	const pts = editable(points);
	const tt = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), 1);
	const here = widthProfileAt(points?.length ? points : null, tt);
	const p: VectorWidthPoint = {
		t: tt,
		left: clean(sides.left, VECTOR_WIDTH_PROFILE_MAX_SCALE) ?? here.left,
		right: clean(sides.right, VECTOR_WIDTH_PROFILE_MAX_SCALE) ?? here.right
	};
	const same = pts.findIndex((q) => Math.abs(q.t - tt) <= VECTOR_WIDTH_SAME_T);
	if (same >= 0 && !options.step) {
		pts[same] = { ...p, t: pts[same].t };
		return { points: pts, index: same };
	}
	let i = 0;
	while (i < pts.length && pts[i].t <= tt) i++;
	if (pts.length >= VECTOR_WIDTH_PROFILE_MAX_POINTS) return { points: pts, index: Math.max(0, i - 1) };
	pts.splice(i, 0, p);
	return { points: pts, index: i };
}

/**
 * Changes point `index`: moves it to `t` (kept between its neighbours, so indices stay put)
 * and / or sets its side scales. Out-of-range indices leave the profile as it is.
 */
export function setWidthPoint(points: readonly VectorWidthPoint[], index: number, patch: Partial<VectorWidthPoint>): VectorWidthPoint[] {
	const pts = points.map((p) => ({ ...p }));
	const p = pts[index];
	if (!p) return pts;
	if (typeof patch.t === 'number' && Number.isFinite(patch.t)) {
		const lo = index > 0 ? pts[index - 1].t : 0;
		const hi = index < pts.length - 1 ? pts[index + 1].t : 1;
		p.t = Math.min(Math.max(patch.t, lo), Math.max(hi, lo));
	}
	const l = clean(patch.left, VECTOR_WIDTH_PROFILE_MAX_SCALE);
	const r = clean(patch.right, VECTOR_WIDTH_PROFILE_MAX_SCALE);
	if (l !== null) p.left = l;
	if (r !== null) p.right = r;
	return pts;
}

/** Removes the points at `indices`. */
export function removeWidthPoints(points: readonly VectorWidthPoint[], indices: readonly number[]): VectorWidthPoint[] {
	const drop = new Set(indices);
	return points.filter((_, i) => !drop.has(i)).map((p) => ({ ...p }));
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** effectcraft's ease from the tip (`u = 0`) to full width (`u = 1`): linear at 0, a quarter circle at 1. */
function ease(u: number, e: number): number {
	const x = Math.min(Math.max(u, 0), 1);
	const round = Math.sqrt(Math.max(0, 1 - (1 - x) * (1 - x)));
	return x + (round - x) * Math.min(Math.max(e, 0), 1);
}

/** A parametric taper (effectcraft's Stroke Taper), lengths as fractions of the path. */
export interface VectorTaperOptions {
	/** Fraction of the path the start taper covers (default 0). */
	startLength?: number;
	/** Fraction the end taper covers (default 0). */
	endLength?: number;
	/** Width at the start as a fraction of the stroke width (default 0: a point). */
	startWidth?: number;
	endWidth?: number;
	/** 0 linear, 1 a quarter circle bulging outwards (default 0). */
	startEase?: number;
	endEase?: number;
}

/** A width wave (effectcraft's Stroke Wave): the width swings between `1 − amount` and 1. */
export interface VectorWaveOptions {
	/** 0–1 (default 0.5). */
	amount?: number;
	/** Whole cycles along the path (default 4). */
	cycles?: number;
	/** Degrees (default 0). */
	phase?: number;
}

/** The width factor at fraction `t` of a taper and / or a wave (effectcraft `width_factor`). */
export function taperWaveFactor(t: number, taper?: VectorTaperOptions | null, wave?: VectorWaveOptions | null): number {
	let k = 1;
	if (taper) {
		let ls = Math.max(0, taper.startLength ?? 0);
		let le = Math.max(0, taper.endLength ?? 0);
		// Overlapping tapers share the path in proportion.
		if (ls + le > 1) {
			const f = 1 / (ls + le);
			ls *= f;
			le *= f;
		}
		const sw = Math.min(Math.max(taper.startWidth ?? 0, 0), 1);
		const ew = Math.min(Math.max(taper.endWidth ?? 0, 0), 1);
		if (ls > 0 && t < ls) k = Math.min(k, sw + (1 - sw) * ease(t / ls, taper.startEase ?? 0));
		if (le > 0 && t > 1 - le) k = Math.min(k, ew + (1 - ew) * ease((1 - t) / le, taper.endEase ?? 0));
	}
	if (wave) {
		const cycles = wave.cycles ?? 4;
		const amount = Math.min(Math.max(wave.amount ?? 0.5, 0), 1);
		if (cycles > 0 && amount > 0) {
			const ph = 2 * Math.PI * t * cycles + ((wave.phase ?? 0) * Math.PI) / 180;
			k *= 1 - amount * (0.5 - 0.5 * Math.cos(ph));
		}
	}
	return k;
}

/**
 * Samples a taper and / or wave into profile points (symmetric), simplified to within
 * `tolerance` of the factor (default 0.01). The monotone interpolation draws them back smoothly.
 */
export function generateWidthProfile(options: { taper?: VectorTaperOptions | null; wave?: VectorWaveOptions | null; samples?: number; tolerance?: number }): VectorWidthPoint[] {
	const cycles = options.wave ? Math.max(0, options.wave.cycles ?? 4) : 0;
	const n = Math.max(8, Math.min(VECTOR_WIDTH_PROFILE_MAX_POINTS * 4, options.samples ?? Math.ceil(32 + cycles * 16)));
	const raw: [number, number][] = [];
	for (let i = 0; i <= n; i++) raw.push([i / n, taperWaveFactor(i / n, options.taper, options.wave)]);
	// Keep the taper ends exactly.
	const ts = [options.taper?.startLength, options.taper?.endLength !== undefined ? 1 - options.taper.endLength : undefined];
	for (const t of ts) if (typeof t === 'number' && t > 0 && t < 1) raw.push([t, taperWaveFactor(t, options.taper, options.wave)]);
	raw.sort((a, b) => a[0] - b[0]);
	const kept = simplifySamples(raw, options.tolerance ?? 0.01, VECTOR_WIDTH_PROFILE_MAX_POINTS);
	return kept.map(([t, k]) => sym(t, k));
}

/** Douglas–Peucker on (t, value) samples (vertical distance), then thinned to at most `max`. */
function simplifySamples(samples: readonly [number, number][], tolerance: number, max: number): [number, number][] {
	if (samples.length <= 2) return samples.slice();
	const keep = new Array(samples.length).fill(false);
	keep[0] = keep[samples.length - 1] = true;
	const stack: [number, number][] = [[0, samples.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const [ta, va] = samples[a];
		const [tb, vb] = samples[b];
		let worst = -1;
		let err = tolerance;
		for (let i = a + 1; i < b; i++) {
			const [t, v] = samples[i];
			const lin = tb - ta > 1e-12 ? va + ((vb - va) * (t - ta)) / (tb - ta) : va;
			const e = Math.abs(v - lin);
			if (e > err) {
				err = e;
				worst = i;
			}
		}
		if (worst >= 0) {
			keep[worst] = true;
			stack.push([a, worst], [worst, b]);
		}
	}
	let out = samples.filter((_, i) => keep[i]);
	while (out.length > max) out = out.filter((_, i) => i === 0 || i === out.length - 1 || i % 2 === 0);
	return out;
}

/** Pen pressure that draws the stroke's own width (a mouse reports 0.5 while a button is down). */
export const VECTOR_PRESSURE_NOMINAL = 0.5;

/**
 * A profile from pen pressure recorded along a stroke: `(t, pressure 0–1)` samples in order.
 * The width scale is pressure ÷ 0.5 (so half pressure draws the stroke's width, full pressure
 * twice it), at least 0.05; the samples are simplified to within `tolerance` (default 0.02).
 * Returns an empty (uniform) profile when every sample is the same.
 */
export function pressureWidthProfile(samples: readonly { t: number; pressure: number }[], options: { tolerance?: number } = {}): VectorWidthPoint[] {
	const raw: [number, number][] = samples
		.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.pressure))
		.map((s) => [Math.min(Math.max(s.t, 0), 1), Math.max(0.05, Math.min(1, Math.max(0, s.pressure)) / VECTOR_PRESSURE_NOMINAL)] as [number, number]);
	if (raw.length < 2) return [];
	if (raw.every((s) => Math.abs(s[1] - raw[0][1]) < 1e-6)) return [];
	return simplifySamples(raw, options.tolerance ?? 0.02, VECTOR_WIDTH_PROFILE_MAX_POINTS).map(([t, k]) => sym(t, Math.round(k * 1000) / 1000));
}
