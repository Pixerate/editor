/**
 * The outline of a variable-width stroke, as a clean filled Bézier path.
 *
 * Each subpath is flattened (finely enough for the width to vary smoothly) and the stroke is
 * the union of positively wound pieces: one trapezoid per flattened segment (its ends at the
 * local side widths), a wedge on the outer side of every bend (the style's join at the path's
 * own corners, round inside curves) and the caps. Filled with the non-zero rule the union is
 * exact whatever the profile does; it is built as the boundary those pieces add up to (see
 * `variableStrokeRings`), normalised with the polygon boolean engine, and every ring is refitted
 * with cubics (`fitCubics`) to within the tolerance — a real Bézier outline, not a polyline.
 *
 * Ported from ArtCraft effectcraft `crates/path/src/varstroke.rs` (`outline`, `dash_intervals`)
 * (MIT OR Apache-2.0, see THIRD_PARTY_NOTICES.md), with one-sided widths after figcraft
 * `crates/pathops/src/width.rs` (`variable_outline`).
 */
import type { Point } from '../canvas/types.js';
import { fitCubics, isStraightCubic } from '../canvas/curveFit.js';
import { polygonBoolean } from '../canvas/polygonBoolean.js';
import {
	flattenChain,
	pathToContours,
	segmentLength,
	segmentNearest,
	segmentTangent,
	type BezierPath,
	type BezierSegment
} from '../canvas/pathops/bezier.js';
import type { StrokeCap, StrokeJoin } from '../canvas/pathops/stroke.js';
import type { VectorWidthPoint } from './types.js';
import { widthProfileAt } from './width.js';

export interface VariableStrokeOptions {
	/** Stroke width: a side scale of 1 reaches half of it from the centre line. */
	width: number;
	profile: readonly VectorWidthPoint[];
	/** Joins at the path's own corners (default `miter`); bends inside curves are always round. */
	join?: StrokeJoin;
	/** Default `butt`. */
	cap?: StrokeCap;
	/** Default 4 (as SVG). */
	miterLimit?: number;
	/** Dash pattern (as SVG); the profile still runs along the whole subpath. */
	dash?: readonly number[];
	dashOffset?: number;
	/** Largest distance of the result from the exact outline (default 0.05). */
	tolerance?: number;
}

/** Width samples per subpath at least (so the width varies smoothly along long straight runs). */
const SAMPLES_PER_SUBPATH = 128;
/** The most dashes one subpath makes. */
const MAX_DASHES = 5000;

type Vec = [number, number];
const sub = (a: Point, b: Point): Vec => [a[0] - b[0], a[1] - b[1]];
const along = (p: Point, v: Vec, k: number): Point => [p[0] + v[0] * k, p[1] + v[1] * k];
const lerp = (a: Point, b: Point, u: number): Point => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const unitOf = (v: Vec): Vec => {
	const l = Math.hypot(v[0], v[1]);
	return l > 0 ? [v[0] / l, v[1] / l] : [1, 0];
};
/** The left normal of a direction on screen (y down): `(dy, −dx)`. */
const leftNormal = (d: Vec): Vec => [d[1], -d[0]];

/** A flattened subpath: points, their arc lengths, and which are the path's own vertices. */
interface Poly {
	pts: Point[];
	s: number[];
	corner: boolean[];
	closed: boolean;
}

function flatten(segments: readonly BezierSegment[], closed: boolean, tol: number): Poly | null {
	const pts: Point[] = [];
	const corner: boolean[] = [];
	const push = (p: Point, isCorner: boolean) => {
		const last = pts[pts.length - 1];
		if (last && dist(last, p) <= 1e-9) {
			corner[corner.length - 1] ||= isCorner;
			return;
		}
		pts.push(p);
		corner.push(isCorner);
	};
	for (const seg of segments) {
		const flat = flattenChain([seg], tol);
		// flattenChain drops a closing duplicate; segments that end where they start keep it.
		if (dist(seg[0], seg[seg.length - 1]) <= 1e-12 && flat.length > 1) flat.push(seg[seg.length - 1]);
		flat.forEach((p, i) => push(p, i === 0 || i === flat.length - 1));
	}
	if (closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) > 1e-9) push(pts[0], true);
	if (pts.length < 2) return null;
	// Subdivide so no piece is longer than the width sampling step.
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
	if (!(total > 0)) return null;
	const step = Math.max(total / SAMPLES_PER_SUBPATH, tol);
	const fine: Point[] = [pts[0]];
	const fineCorner: boolean[] = [corner[0]];
	for (let i = 1; i < pts.length; i++) {
		const n = Math.max(1, Math.ceil(dist(pts[i - 1], pts[i]) / step));
		for (let k = 1; k <= n; k++) {
			fine.push(k === n ? pts[i] : lerp(pts[i - 1], pts[i], k / n));
			fineCorner.push(k === n ? corner[i] : false);
		}
	}
	const s = [0];
	for (let i = 1; i < fine.length; i++) s.push(s[i - 1] + dist(fine[i - 1], fine[i]));
	return { pts: fine, s, corner: fineCorner, closed };
}

/** Arc-length intervals that are "on" for a dash pattern on a path `len` long (effectcraft `dash_intervals`). */
export function dashIntervals(pattern: readonly number[], offset: number, len: number): [number, number][] {
	let pat = pattern.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
	if (pat.length % 2 === 1) pat = [...pat, ...pat];
	const period = pat.reduce((a, b) => a + b, 0);
	if (pat.length < 2 || !(period > 1e-9) || !(len > 0)) return [[0, len]];
	let pos = (((Number.isFinite(offset) ? offset : 0) % period) + period) % period;
	let idx = 0;
	while (pos >= pat[idx]) {
		pos -= pat[idx];
		idx = (idx + 1) % pat.length;
	}
	const out: [number, number][] = [];
	let s = 0;
	let guard = 0;
	while (s < len && guard++ < MAX_DASHES * pat.length) {
		const e = Math.min(s + pat[idx] - pos, len);
		if (idx % 2 === 0 && e >= s) out.push([s, e]);
		s += pat[idx] - pos;
		pos = 0;
		idx = (idx + 1) % pat.length;
	}
	return out;
}

/** The point at arc length `t` of a polyline and the index of the segment it lies on. */
function at(poly: Poly, t: number): [Point, number] {
	let i = 1;
	while (i < poly.pts.length - 1 && poly.s[i] <= t) i++;
	const a = poly.s[i - 1];
	const b = poly.s[i];
	const u = b > a ? Math.min(Math.max((t - a) / (b - a), 0), 1) : 0;
	return [lerp(poly.pts[i - 1], poly.pts[i], u), i];
}

/** Points of an arc around `c` from angle `a0` turning by `sweep`, radius going from `r0` to `r1` (ends excluded). */
function arcPoints(c: Point, a0: number, sweep: number, r0: number, r1: number, tol: number): Point[] {
	const r = Math.max(r0, r1);
	if (!(r > tol * 0.5) || !Number.isFinite(sweep)) return [];
	const stepAngle = 2 * Math.acos(Math.min(Math.max(1 - tol / r, -1), 1));
	const n = Math.min(128, Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(stepAngle, 1e-3))));
	const out: Point[] = [];
	for (let k = 1; k < n; k++) {
		const f = k / n;
		const a = a0 + sweep * f;
		const rr = r0 + (r1 - r0) * f;
		out.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]);
	}
	return out;
}

/** Where segments `a0 → a1` and `b0 → b1` cross, if they do (strictly inside `b`, anywhere past the start of `a`). */
function crossing(a0: Point, a1: Point, b0: Point, b1: Point): Point | null {
	const r = sub(a1, a0);
	const q = sub(b1, b0);
	const den = r[0] * q[1] - r[1] * q[0];
	if (Math.abs(den) < 1e-12) return null;
	const w = sub(b0, a0);
	const t = (w[0] * q[1] - w[1] * q[0]) / den;
	const u = (w[0] * r[1] - w[1] * r[0]) / den;
	return t > 1e-9 && t <= 1 && u >= 0 && u < 1 - 1e-9 ? [a0[0] + r[0] * t, a0[1] + r[1] * t] : null;
}

/**
 * The rings of a variable-width stroke in the path's own space; filled with the non-zero rule
 * they are the stroke.
 *
 * effectcraft builds the stroke as a union of positively wound pieces: a trapezoid per flattened
 * segment (its ends at the local side widths), a wedge on the outer side of every bend and the
 * caps. Unioning thousands of overlapping pieces is slow, so each run is emitted as the boundary
 * those pieces add up to instead (winding numbers add, so the non-zero fill is the same): the
 * offset sides with the outer join between them, and on the inner side of a bend either the point
 * where the two offsets cross (the region cut off is covered by both trapezoids) or, when they do
 * not cross, a detour through the centre point (which keeps the winding right when segments are
 * shorter than the width). A closed subpath gives two rings, an open run one.
 */
export function variableStrokeRings(path: BezierPath, options: VariableStrokeOptions): Point[][] {
	const half = options.width / 2;
	if (!(half > 0) || !Number.isFinite(half)) return [];
	const tol = options.tolerance && options.tolerance > 0 ? options.tolerance : 0.05;
	const join = options.join ?? 'miter';
	const cap = options.cap ?? 'butt';
	const miterLimit = options.miterLimit && options.miterLimit >= 1 ? options.miterLimit : 4;
	const rings: Point[][] = [];
	const push = (out: Point[], p: Point) => {
		const last = out[out.length - 1];
		if (!last || dist(last, p) > 1e-12) out.push(p);
	};
	for (const contour of pathToContours(path)) {
		if (!contour.segments.length) continue;
		// Chords of the offsets lose area on the outer side of a curve; a quarter of the tolerance keeps that well inside it.
		const poly = flatten(contour.segments, contour.closed, Math.min(tol, half) / 4);
		if (!poly) continue;
		const len = poly.s[poly.s.length - 1];
		const sides = (s: number): [number, number] => {
			const w = widthProfileAt(options.profile, s / len);
			return [w.left * half, w.right * half];
		};
		const intervals = options.dash?.some((v) => v > 0) ? dashIntervals(options.dash, options.dashOffset ?? 0, len) : [[0, len] as [number, number]];
		const whole = intervals.length === 1 && intervals[0][0] <= 0 && intervals[0][1] >= len;
		for (const [a, b] of intervals) {
			const [pa, ia] = at(poly, a);
			const [pb, ib] = at(poly, b);
			const pts: { p: Point; s: number; corner: boolean }[] = [{ p: pa, s: a, corner: poly.corner[0] && a <= 0 }];
			for (let i = ia; i < ib; i++) pts.push({ p: poly.pts[i], s: poly.s[i], corner: poly.corner[i] });
			pts.push({ p: pb, s: b, corner: false });
			const run = pts.filter((q, i) => i === 0 || dist(q.p, pts[i - 1].p) > 1e-9);
			if (run.length < 2) {
				// A zero-length dash: only its caps show.
				const [l, r] = sides(a);
				const w = (l + r) / 2;
				if (cap === 'round' && w > 0) rings.push([[pa[0] + w, pa[1]], ...arcPoints(pa, 0, 2 * Math.PI, w, w, tol)]);
				continue;
			}
			const closed = whole && poly.closed;
			const m = run.length - 1;
			const dirs: Vec[] = [];
			for (let i = 0; i < m; i++) dirs.push(unitOf(sub(run[i + 1].p, run[i].p)));
			const normals = dirs.map(leftNormal);
			const w = run.map((q) => sides(q.s));

			/** One side (`sigma` +1 left, −1 right) along the run, joins included. */
			const side = (sigma: 1 | -1): Point[] => {
				const k = sigma > 0 ? 0 : 1;
				const S = (i: number) => along(run[i].p, normals[i], sigma * w[i][k]);
				const E = (i: number) => along(run[i + 1].p, normals[i], sigma * w[i + 1][k]);
				const out: Point[] = [S(0)];
				for (let i = 0; i < m; i++) {
					const seam = i === m - 1;
					if (seam && !closed) {
						push(out, E(i));
						break;
					}
					const j = seam ? 0 : i + 1;
					const p = run[i + 1].p;
					const d0 = dirs[i];
					const d1 = dirs[j];
					const cross = d0[0] * d1[1] - d0[1] * d1[0];
					const dot = d0[0] * d1[0] + d0[1] * d1[1];
					const r0 = w[i + 1][k];
					const r1 = w[j][k];
					const e = E(i);
					const st = S(j);
					if (Math.abs(cross) < 1e-12 && dot > 0) {
						push(out, e);
						if (!seam) push(out, st);
						continue;
					}
					const uturn = Math.abs(cross) < 1e-12;
					// Turning right on screen puts the left side outside the bend (a U-turn: the left side).
					const outer = uturn ? sigma > 0 : cross * sigma > 0;
					if (!outer) {
						const x = seam ? null : crossing(out[out.length - 1], e, st, E(j));
						if (x) push(out, x);
						else {
							push(out, e);
							push(out, p);
							if (!seam) push(out, st);
						}
						continue;
					}
					push(out, e);
					const theta = uturn ? Math.PI : Math.atan2(cross, dot);
					const r = (r0 + r1) / 2;
					const kind: StrokeJoin = run[i + 1].corner || (seam && poly.corner[0]) ? join : 'round';
					if (r > 1e-9) {
						if (kind === 'round') {
							if (r * (1 - Math.cos(Math.abs(theta) / 2)) > tol * 0.25) {
								for (const q of arcPoints(p, Math.atan2(e[1] - p[1], e[0] - p[0]), theta, r0, r1, tol)) push(out, q);
							}
						} else if (kind === 'miter') {
							const halfCos = Math.cos(theta / 2);
							const bis: Vec = [normals[i][0] + normals[j][0], normals[i][1] + normals[j][1]];
							const bl = Math.hypot(bis[0], bis[1]);
							if (halfCos > 1e-6 && 1 / halfCos <= miterLimit && bl > 1e-9) push(out, along(p, bis, (sigma * r) / halfCos / bl));
						}
					}
					if (!seam) push(out, st);
				}
				if (closed && out.length > 1 && dist(out[0], out[out.length - 1]) <= 1e-12) out.pop();
				return out;
			};
			const left = side(1);
			const right = side(-1);
			if (closed) {
				rings.push(left, right.reverse());
				continue;
			}
			// Caps: round or square around each end, from one side to the other.
			const capPoints = (atStart: boolean): Point[] => {
				if (cap === 'butt') return [];
				const i = atStart ? 0 : m;
				const d = atStart ? dirs[0] : dirs[m - 1];
				const [l, r] = w[i];
				if (!(l + r > 1e-9)) return [];
				const p = run[i].p;
				const n = leftNormal(d);
				const L = along(p, n, l);
				const R = along(p, n, -r);
				if (cap === 'round') {
					// Half a turn around the outside: right side to left at the start, left to right at the end.
					const a0 = Math.atan2(d[1], d[0]) + (atStart ? Math.PI / 2 : -Math.PI / 2);
					return arcPoints(p, a0, Math.PI, atStart ? r : l, atStart ? l : r, tol);
				}
				const ext = (l + r) / 2;
				const o: Vec = atStart ? [-d[0], -d[1]] : d;
				return atStart ? [along(R, o, ext), along(L, o, ext)] : [along(L, o, ext), along(R, o, ext)];
			};
			const ring: Point[] = [];
			for (const q of [...left, ...capPoints(false), ...right.reverse(), ...capPoints(true)]) push(ring, q);
			if (ring.length > 2) rings.push(ring);
		}
	}
	return rings;
}

/**
 * The outline of a variable-width stroke of `path` (side widths from `profile`), as a clean
 * Bézier path: overlaps removed, outer rings and holes, each refitted with cubics to within
 * `tolerance` of the exact outline. Fill it with the non-zero rule (either rule works).
 */
export function variableStrokeOutline(path: BezierPath, options: VariableStrokeOptions): BezierPath {
	const pieces = variableStrokeRings(path, options);
	if (!pieces.length) return [];
	const tol = options.tolerance && options.tolerance > 0 ? options.tolerance : 0.05;
	let polygons;
	try {
		polygons = polygonBoolean('union', [{ rings: pieces, fillRule: 'nonzero' }]);
	} catch {
		return [];
	}
	const out: BezierPath = [];
	for (const polygon of polygons) {
		for (const ring of polygon) {
			if (ring.length < 3) continue;
			const cubics = fitCubics(ring, tol, { closed: true, cornerAngleDeg: 25 });
			if (!cubics.length) continue;
			out.push({ type: 'M', x: cubics[0].p0[0], y: cubics[0].p0[1] });
			cubics.forEach((c, i) => {
				if (isStraightCubic(c, tol * 0.02)) {
					if (i < cubics.length - 1) out.push({ type: 'L', x: c.p3[0], y: c.p3[1] });
				} else out.push({ type: 'C', x1: c.p1[0], y1: c.p1[1], x2: c.p2[0], y2: c.p2[1], x: c.p3[0], y: c.p3[1] });
			});
			out.push({ type: 'Z' });
		}
	}
	return out;
}

/**
 * Where point `p` lies relative to the stroke's centre line: the nearest point's contour,
 * its position `t` by length (0–1), the distance, and the side (`left` looking along the
 * path on screen) — what hit-testing and the width tool need.
 */
export function nearestStrokePosition(
	path: BezierPath,
	p: Point,
	/** Only this contour (subpath) of the path. */
	only?: number
): { contour: number; t: number; distance: number; side: 'left' | 'right'; point: Point; tangent: Vec; length: number } | null {
	let best: ReturnType<typeof nearestStrokePosition> = null;
	pathToContours(path).forEach((c, ci) => {
		if (!c.segments.length || (only !== undefined && ci !== only)) return;
		const lengths = c.segments.map((s) => segmentLength(s));
		const total = lengths.reduce((a, b) => a + b, 0);
		if (!(total > 0)) return;
		let acc = 0;
		c.segments.forEach((seg, si) => {
			const near = segmentNearest(seg, p);
			if (!best || near.distance < best.distance) {
				const s = acc + segmentLength(seg, 0, near.t);
				const tan = segmentTangent(seg, near.t);
				const pt = seg.length === 2 ? lerp(seg[0], seg[1], near.t) : evalSeg(seg, near.t);
				const n = leftNormal([tan[0], tan[1]]);
				const side = (p[0] - pt[0]) * n[0] + (p[1] - pt[1]) * n[1] >= 0 ? 'left' : 'right';
				best = { contour: ci, t: Math.min(Math.max(s / total, 0), 1), distance: near.distance, side, point: pt, tangent: [tan[0], tan[1]], length: total };
			}
			acc += lengths[si];
		});
	});
	return best;
}

function evalSeg(seg: BezierSegment, t: number): Point {
	// de Casteljau
	let pts = seg.map((q) => [q[0], q[1]] as Point);
	while (pts.length > 1) pts = pts.slice(1).map((q, i) => lerp(pts[i], q, t));
	return pts[0];
}

/** The point and unit tangent at position `t` (0–1 by length) of contour `index` of `path`. */
export function strokePositionPoint(path: BezierPath, index: number, t: number): { point: Point; tangent: Vec } | null {
	const c = pathToContours(path)[index];
	if (!c?.segments.length) return null;
	const lengths = c.segments.map((s) => segmentLength(s));
	const total = lengths.reduce((a, b) => a + b, 0);
	let want = Math.min(Math.max(t, 0), 1) * total;
	for (let i = 0; i < c.segments.length; i++) {
		const seg = c.segments[i];
		if (want <= lengths[i] + 1e-12 || i === c.segments.length - 1) {
			// Bisect the parameter for the remaining length.
			let lo = 0;
			let hi = 1;
			const target = Math.min(want, lengths[i]);
			for (let k = 0; k < 40; k++) {
				const mid = (lo + hi) / 2;
				if (segmentLength(seg, 0, mid) < target) lo = mid;
				else hi = mid;
			}
			const u = (lo + hi) / 2;
			const tan = segmentTangent(seg, u);
			return { point: evalSeg(seg, u), tangent: [tan[0], tan[1]] };
		}
		want -= lengths[i];
	}
	return null;
}
