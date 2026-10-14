/**
 * Least-squares cubic Bézier fitting of point sequences (Schneider-style: fit one cubic with
 * fixed end tangents, reparameterise with Newton steps, split at the worst point), with
 * corner preservation by a turning-angle test.
 *
 * Portions ported from vectorcraft-main/crates/pathops/src/fit.rs and
 * vectorcraft-main/crates/pathops/src/edit.rs (MIT OR Apache-2.0, © ArtCraft Team and
 * contributors). See THIRD_PARTY_NOTICES.md.
 */
import type { Point } from './types.js';

/** Same as `formatNumber` in shapeGeometry (kept local to avoid an import cycle). */
function formatNumber(value: number, precision: number): string {
	const factor = 10 ** precision;
	const rounded = Math.round(value * factor) / factor;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** One cubic Bézier segment. */
export interface CubicSegment {
	p0: Point;
	p1: Point;
	p2: Point;
	p3: Point;
}

export interface FitCubicsOptions {
	/**
	 * Vertices where the polyline turns by more than this many degrees stay sharp corners
	 * (default 30). Use 180 to smooth through every vertex.
	 */
	cornerAngleDeg?: number;
	/** Treat the points as a closed ring (the last point connects back to the first). */
	closed?: boolean;
}

/** Maximum Newton reparameterisation rounds per fit. */
const MAX_REPARAM = 6;

type Vec = [number, number];

const sub = (a: Point, b: Point): Vec => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, v: Vec, s = 1): Vec => [a[0] + v[0] * s, a[1] + v[1] * s];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function unit(v: Vec): Vec | null {
	const l = Math.hypot(v[0], v[1]);
	return l > 1e-12 && Number.isFinite(l) ? [v[0] / l, v[1] / l] : null;
}

function evalCubic(c: CubicSegment, t: number): Vec {
	const s = 1 - t;
	const b0 = s * s * s;
	const b1 = 3 * s * s * t;
	const b2 = 3 * s * t * t;
	const b3 = t * t * t;
	return [
		b0 * c.p0[0] + b1 * c.p1[0] + b2 * c.p2[0] + b3 * c.p3[0],
		b0 * c.p0[1] + b1 * c.p1[1] + b2 * c.p2[1] + b3 * c.p3[1]
	];
}

/** Evaluates a cubic segment at `t` ∈ [0, 1]. */
export function cubicPointAt(c: CubicSegment, t: number): Point {
	return evalCubic(c, t);
}

function dedup(points: readonly Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
		if (out.length === 0 || dist(out[out.length - 1], p) > 1e-12) out.push(p);
	}
	return out;
}

/** Chord-length parameters (0 to 1), one per point. */
function chordParams(pts: Point[]): number[] {
	const u = [0];
	let acc = 0;
	for (let i = 1; i < pts.length; i++) {
		acc += dist(pts[i - 1], pts[i]);
		u.push(acc);
	}
	return acc > 0 ? u.map((x) => x / acc) : u;
}

/** Solves the 2×2 normal equations for the handle lengths along the fixed tangents. */
function generate(pts: Point[], u: number[], t0: Vec, t1: Vec): CubicSegment {
	const p0 = pts[0];
	const p3 = pts[pts.length - 1];
	const dirIn: Vec = [-t1[0], -t1[1]];
	let c00 = 0;
	let c01 = 0;
	let c11 = 0;
	let x0 = 0;
	let x1 = 0;
	for (let i = 0; i < pts.length; i++) {
		const t = u[i];
		const s = 1 - t;
		const b0 = s * s * s;
		const b1 = 3 * s * s * t;
		const b2 = 3 * s * t * t;
		const b3 = t * t * t;
		const a0: Vec = [t0[0] * b1, t0[1] * b1];
		const a1: Vec = [dirIn[0] * b2, dirIn[1] * b2];
		c00 += dot(a0, a0);
		c01 += dot(a0, a1);
		c11 += dot(a1, a1);
		const tmp: Vec = [
			pts[i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3)),
			pts[i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3))
		];
		x0 += dot(a0, tmp);
		x1 += dot(a1, tmp);
	}
	const det = c00 * c11 - c01 * c01;
	const seg = dist(p0, p3);
	const eps = 1e-6 * seg;
	let al = seg / 3;
	let ar = seg / 3;
	if (Math.abs(det) > 1e-12) {
		al = (x0 * c11 - x1 * c01) / det;
		ar = (c00 * x1 - c01 * x0) / det;
	}
	if (!Number.isFinite(al) || !Number.isFinite(ar) || al < eps || ar < eps) {
		al = seg / 3;
		ar = seg / 3;
	}
	// Guard against wild handles on nearly degenerate data.
	const cap = seg * 4 + 1e-9;
	al = Math.min(al, cap);
	ar = Math.min(ar, cap);
	return { p0, p1: add(p0, t0, al), p2: add(p3, dirIn, ar), p3 };
}

/** Largest distance between a point and the curve at its parameter, and that point's index. */
function maxError(pts: Point[], c: CubicSegment, u: number[]): [number, number] {
	let e = 0;
	let idx = pts.length >> 1;
	for (let i = 0; i < pts.length; i++) {
		const d = dist(evalCubic(c, u[i]), pts[i]);
		if (d > e) {
			e = d;
			idx = i;
		}
	}
	return [e, idx];
}

/** One Newton–Raphson step towards the parameter of the point on `c` nearest `p`. */
function newton(c: CubicSegment, p: Point, t: number): number {
	const s = 1 - t;
	const q = evalCubic(c, t);
	const d1: Vec = [
		3 * (s * s * (c.p1[0] - c.p0[0]) + 2 * s * t * (c.p2[0] - c.p1[0]) + t * t * (c.p3[0] - c.p2[0])),
		3 * (s * s * (c.p1[1] - c.p0[1]) + 2 * s * t * (c.p2[1] - c.p1[1]) + t * t * (c.p3[1] - c.p2[1]))
	];
	const d2: Vec = [
		6 * (s * (c.p2[0] - 2 * c.p1[0] + c.p0[0]) + t * (c.p3[0] - 2 * c.p2[0] + c.p1[0])),
		6 * (s * (c.p2[1] - 2 * c.p1[1] + c.p0[1]) + t * (c.p3[1] - 2 * c.p2[1] + c.p1[1]))
	];
	const diff: Vec = [q[0] - p[0], q[1] - p[1]];
	const num = dot(diff, d1);
	const den = dot(d1, d1) + dot(diff, d2);
	if (Math.abs(den) < 1e-12) return t;
	const nt = t - num / den;
	return Number.isFinite(nt) ? Math.min(1, Math.max(0, nt)) : t;
}

/**
 * Best single cubic through `pts` with the given unit end tangents (`t1` points forward at
 * the end), starting from parameters `u`. Returns the curve, its max error and the index of
 * the worst point.
 */
function fitSingleFrom(pts: Point[], u: number[], t0: Vec, t1: Vec): [CubicSegment, number, number] {
	let best = generate(pts, u, t0, t1);
	let [bestErr, bestSplit] = maxError(pts, best, u);
	const params = u.slice();
	for (let round = 0; round < MAX_REPARAM; round++) {
		for (let i = 0; i < params.length; i++) params[i] = newton(best, pts[i], params[i]);
		const c = generate(pts, params, t0, t1);
		const [e, s] = maxError(pts, c, params);
		if (e < bestErr) {
			best = c;
			bestErr = e;
			bestSplit = s;
		} else break;
	}
	return [best, bestErr, bestSplit];
}

function fitRec(pts: Point[], t0: Vec, t1: Vec, tol: number, out: CubicSegment[], depth: number) {
	const n = pts.length;
	if (n === 2) {
		const d = dist(pts[0], pts[1]) / 3;
		out.push({ p0: pts[0], p1: add(pts[0], t0, d), p2: add(pts[1], t1, -d), p3: pts[1] });
		return;
	}
	const [c, err, splitAt] = fitSingleFrom(pts, chordParams(pts), t0, t1);
	if (err <= tol || depth > 40) {
		out.push(c);
		return;
	}
	// Split at the worst point with a centre tangent estimated from its neighbours.
	const split = Math.min(n - 2, Math.max(1, splitAt));
	const tc = unit(sub(pts[split + 1], pts[split - 1])) ?? t0;
	fitRec(pts.slice(0, split + 1), t0, tc, tol, out, depth + 1);
	fitRec(pts.slice(split), tc, t1, tol, out, depth + 1);
}

/**
 * Unit tangent at `a` estimated from the parabola through `a`, `b`, `c` (chord-length
 * parameters): second-order accurate, so polylines sampled from curves get their true end
 * direction rather than the first chord's.
 */
function tangentFrom(a: Point, b: Point, c: Point | undefined): Vec | null {
	const chord = unit(sub(b, a));
	if (!c) return chord;
	const d1 = dist(a, b);
	const d2 = dist(b, c);
	if (!(d1 > 0) || !(d2 > 0)) return chord;
	const ka = -(2 * d1 + d2) / (d1 * (d1 + d2));
	const kb = (d1 + d2) / (d1 * d2);
	const kc = -d1 / (d2 * (d1 + d2));
	const est = unit([ka * a[0] + kb * b[0] + kc * c[0], ka * a[1] + kb * b[1] + kc * c[1]]);
	// Fall back to the chord when the estimate swings too far (noisy or sharp data).
	return est && chord && dot(est, chord) > Math.cos(Math.PI / 4) ? est : chord;
}

/**
 * Fits a G1-continuous chain of cubics through `points` (an open run) with the unit
 * tangents `t0` (leaving the first point) and `t1` (arriving at the last point, forward);
 * both are estimated from the end points when omitted. Every point lies within `tolerance`
 * of the curve at its fitted parameter.
 */
export function fitCubicRun(points: readonly Point[], tolerance: number, t0?: Point, t1?: Point): CubicSegment[] {
	const pts = dedup(points);
	const out: CubicSegment[] = [];
	if (pts.length < 2) return out;
	const n = pts.length;
	const start = (t0 && unit([t0[0], t0[1]])) ?? tangentFrom(pts[0], pts[1], pts[2]) ?? [1, 0];
	const back = tangentFrom(pts[n - 1], pts[n - 2], pts[n - 3]);
	const end = (t1 && unit([t1[0], t1[1]])) ?? (back ? ([-back[0], -back[1]] as Vec) : [1, 0]);
	fitRec(pts, start, end, Math.max(tolerance, 1e-9), out, 0);
	return out;
}

/** Turning angle in degrees between the directions `a`→`b` and `b`→`c`. */
function turnDeg(a: Point, b: Point, c: Point): number {
	const u = unit(sub(b, a));
	const v = unit(sub(c, b));
	if (!u || !v) return 0;
	return (Math.acos(Math.min(1, Math.max(-1, dot(u, v)))) * 180) / Math.PI;
}

/**
 * Corner vertices of a polyline. The turn at each vertex is measured to the nearest
 * neighbours at least `span` away on each side (so sample noise smaller than the fitting
 * tolerance does not read as corners), and only the sharpest vertex of a neighbourhood is
 * kept. End points of open polylines are not included.
 */
function findCorners(pts: Point[], closed: boolean, cornerAngle: number, span: number): number[] {
	const n = pts.length;
	const at = (i: number) => pts[closed ? ((i % n) + n) % n : i];
	const reach = (i: number, step: 1 | -1): number | null => {
		for (let k = 1; k < (closed ? n : Infinity); k++) {
			const j = i + step * k;
			if (!closed && (j < 0 || j >= n)) return k > 1 ? j - step : null;
			if (dist(at(j), pts[i]) >= span) return j;
		}
		return null;
	};
	const turns = new Float64Array(n);
	const windows: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		windows.push([i, i]);
		if (!closed && (i === 0 || i === n - 1)) continue;
		const prev = reach(i, -1);
		const next = reach(i, 1);
		if (prev === null || next === null) continue;
		windows[i] = [prev, next];
		turns[i] = turnDeg(at(prev), pts[i], at(next));
	}
	const corners: number[] = [];
	for (let i = 0; i < n; i++) {
		if (!(turns[i] > cornerAngle)) continue;
		const [lo, hi] = windows[i];
		let sharpest = true;
		for (let j = lo; j <= hi && sharpest; j++) {
			const k = closed ? ((j % n) + n) % n : j;
			if (k === i || dist(pts[k], pts[i]) >= span) continue;
			if (turns[k] > turns[i] || (turns[k] === turns[i] && k < i)) sharpest = false;
		}
		if (sharpest) corners.push(i);
	}
	return corners;
}

/**
 * Points to fit for a run of polyline vertices: the vertices, plus extra samples along edges
 * much longer than the run's typical edge so straight stretches stay straight.
 */
function densify(run: Point[]): Point[] {
	if (run.length < 3) return run;
	const lengths: number[] = [];
	for (let i = 1; i < run.length; i++) lengths.push(dist(run[i - 1], run[i]));
	const sorted = [...lengths].sort((a, b) => a - b);
	const median = sorted[sorted.length >> 1];
	if (!(median > 0)) return run;
	const out: Point[] = [run[0]];
	for (let i = 1; i < run.length; i++) {
		const len = lengths[i - 1];
		if (len > 2 * median) {
			const steps = Math.min(64, Math.ceil(len / median));
			const a = run[i - 1];
			const b = run[i];
			for (let k = 1; k < steps; k++) {
				const t = k / steps;
				out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
			}
		}
		out.push(run[i]);
	}
	return out;
}

/**
 * Fits cubic Bézier segments to a polyline (`closed` for a ring), keeping vertices that turn
 * by more than `cornerAngleDeg` (default 30°) as sharp corners. Each stretch between corners
 * is fitted Schneider-style so that every input point is within `tolerance` of the result.
 *
 * Returns the segments in order (consecutive segments share end points; a closed result ends
 * where it starts). Fewer than two distinct points give an empty array.
 */
export function fitCubics(points: readonly Point[], tolerance: number, options: FitCubicsOptions = {}): CubicSegment[] {
	let pts = dedup(points);
	const closed = options.closed === true;
	if (closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) <= 1e-12) pts = pts.slice(0, -1);
	if (pts.length < 2) return [];
	const tol = Math.max(tolerance, 1e-6);
	const cornerAngle = options.cornerAngleDeg ?? 30;
	const n = pts.length;
	const span = 4 * tol;

	if (!closed || n < 3) {
		const corners = [0, ...(n > 2 ? findCorners(pts, false, cornerAngle, span) : []), n - 1];
		const out: CubicSegment[] = [];
		for (let k = 1; k < corners.length; k++) {
			const run = pts.slice(corners[k - 1], corners[k] + 1);
			out.push(...fitCubicRun(densify(run), tol));
		}
		if (closed && n === 2) out.push(...fitCubicRun([pts[1], pts[0]], tol));
		return out;
	}

	const corners = findCorners(pts, true, cornerAngle, span);
	if (corners.length === 0) {
		// Smooth ring: start anywhere, with the same tangent leaving and arriving.
		const ring = [...pts, pts[0]];
		const t = unit(sub(pts[1], pts[n - 1])) ?? [1, 0];
		// (A central difference: already second-order accurate at the seam.)
		return fitCubicRun(densify(ring), tol, t, t);
	}
	const out: CubicSegment[] = [];
	for (let k = 0; k < corners.length; k++) {
		const from = corners[k];
		const to = corners[(k + 1) % corners.length];
		const run: Point[] = [];
		for (let i = from; ; i = (i + 1) % n) {
			run.push(pts[i]);
			if (run.length > 1 && i === to) break;
		}
		out.push(...fitCubicRun(densify(run), tol));
	}
	return out;
}

/** Whether a cubic is (within `tol`) the straight line from `p0` to `p3`. */
export function isStraightCubic(c: CubicSegment, tol: number): boolean {
	const chord = sub(c.p3, c.p0);
	const len = Math.hypot(chord[0], chord[1]);
	if (len < 1e-12) return dist(c.p1, c.p0) <= tol && dist(c.p2, c.p0) <= tol;
	const dir: Vec = [chord[0] / len, chord[1] / len];
	return [c.p1, c.p2].every((h) => {
		const v = sub(h, c.p0);
		const along = dot(v, dir);
		const across = Math.abs(v[0] * dir[1] - v[1] * dir[0]);
		return across <= tol && along >= -tol && along <= len + tol;
	});
}

export interface FitPathDataOptions extends FitCubicsOptions {
	/** Fitting tolerance in path units (default 0.5). */
	tolerance?: number;
	/** Decimal places (default 3). */
	precision?: number;
	/** Added to every point before formatting. */
	offset?: { x: number; y: number };
	/**
	 * Keep the original polyline when fitting would need more segments than it has edges
	 * (default `true`), so fitting never makes a path heavier.
	 */
	noWorse?: boolean;
}

/** SVG `d` for fitted segments (`L` for straight ones, `C` otherwise). */
export function cubicsToPathData(
	segments: readonly CubicSegment[],
	options: { precision?: number; offset?: { x: number; y: number }; closed?: boolean; straightTolerance?: number } = {}
): string {
	if (segments.length === 0) return '';
	const f = (n: number) => formatNumber(n, options.precision ?? 3);
	const dx = options.offset?.x ?? 0;
	const dy = options.offset?.y ?? 0;
	const pt = (p: Point) => `${f(p[0] + dx)} ${f(p[1] + dy)}`;
	const straight = options.straightTolerance ?? 1e-3;
	let d = `M${pt(segments[0].p0)}`;
	segments.forEach((c, i) => {
		const last = options.closed && i === segments.length - 1;
		if (isStraightCubic(c, straight)) {
			if (!last) d += `L${pt(c.p3)}`;
		} else d += `C${pt(c.p1)} ${pt(c.p2)} ${pt(c.p3)}`;
	});
	return options.closed ? `${d}Z` : d;
}

function polylineToPathData(points: readonly Point[], closed: boolean, options: FitPathDataOptions): string {
	if (points.length < 2) return '';
	const f = (n: number) => formatNumber(n, options.precision ?? 3);
	const dx = options.offset?.x ?? 0;
	const dy = options.offset?.y ?? 0;
	let d = `M${f(points[0][0] + dx)} ${f(points[0][1] + dy)}`;
	for (let i = 1; i < points.length; i++) d += `L${f(points[i][0] + dx)} ${f(points[i][1] + dy)}`;
	return closed ? `${d}Z` : d;
}

/**
 * Fits smooth curves to a polygon ring (closed by default) and returns SVG path data with
 * `C` curves for smooth stretches, `L` lines for straight ones and sharp corners kept.
 * Use it for boolean results of curved shapes or to smooth freehand strokes
 * (`{ closed: false }`, see `fitFreehandPath`).
 */
export function fitPathData(ring: readonly Point[], options: FitPathDataOptions = {}): string {
	const closed = options.closed ?? true;
	const tolerance = options.tolerance ?? 0.5;
	const pts = dedup(ring);
	const segments = fitCubics(pts, tolerance, { ...options, closed });
	if (segments.length === 0) return '';
	const edges = closed ? pts.length : pts.length - 1;
	if (options.noWorse !== false) {
		const straight = segments.filter((c) => isStraightCubic(c, tolerance * 0.02)).length;
		// Fitting only pays off when it removes vertices.
		if (segments.length >= edges && straight === segments.length) return polylineToPathData(pts, closed, options);
		if (segments.length > edges) return polylineToPathData(pts, closed, options);
	}
	return cubicsToPathData(segments, {
		precision: options.precision,
		offset: options.offset,
		closed,
		straightTolerance: tolerance * 0.02
	});
}

/**
 * Smooths a freehand stroke (pointer samples) into an open SVG path of cubic curves.
 * `tolerance` is the largest distance (in the points' units) a sample may be from the
 * curve (default 1); sharp turns above `cornerAngleDeg` (default 30) stay corners.
 */
export function fitFreehandPath(
	points: readonly Point[],
	options: Omit<FitPathDataOptions, 'closed'> = {}
): string {
	return fitPathData(points, { tolerance: 1, ...options, closed: false });
}
