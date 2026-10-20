/**
 * Path operators of live path effects (After Effects' "Add ▸" path operations). Each maps a list
 * of paths to a list of the same length (one per shape above the operator), except `mergePaths`,
 * which combines them into one, and `repeatPaths`, which makes copies. Paths are in the space of
 * the node the effect belongs to.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): effectcraft `crates/path/src/ops.rs` — `trim`, `trim_individually`,
 * `trim_intervals`, `Measured::append`, `pucker_bloat`, `round_corners`, `offset`, `twist`,
 * `resample`, `emit`, `zigzag`, `WiggleParams`, `splitmix`, `hash`, `noise`, `wiggle`, `MergeMode`
 * and `merge`; and the `"repeater"` branch of `collect()` in `crates/render/src/shapes.rs` (copy
 * transforms, opacity ramp, fractional last copy, offset and composite order). Arc lengths come
 * from our own `segmentLength` / `segmentParamAtLength` / `trimSegments`, offsets from
 * `offsetPath`, booleans from `pathBoolean`, and Round Corners uses the live-corner maths in
 * `corners.ts` (a true radius, exact at any angle, where a curve meets a corner too).
 */
import type { Point } from '../canvas/types.js';
import {
	bezierPathBounds,
	closeContour,
	contoursToPath,
	flattenChain,
	pathToContours,
	segmentDerivative,
	segmentLength,
	segmentParamAtLength,
	segmentPoint,
	subSegment,
	transformBezierPath,
	trimSegments,
	type AffineMatrix,
	type BezierPath,
	type BezierSegment
} from '../canvas/pathops/bezier.js';
import { pathBoolean } from '../canvas/pathops/boolean.js';
import { offsetPath } from '../canvas/pathops/stroke.js';
import { setSubpathCorners } from './corners.js';
import { bezierToSubpaths, multiplyMatrices, rotateMatrix, scaleMatrix, subpathsToBezier, translateMatrix } from './geometry.js';
import type { Vec2, VectorEffectParamsMap, VectorLineJoin, VectorMergeMode } from './types.js';

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Subpath helpers
// ---------------------------------------------------------------------------

/** One subpath as cubic or line segments (quadratics raised), the closing line included. */
interface Sub {
	segs: Point[][];
	closed: boolean;
}

const degenerate = (s: BezierSegment) => s.every((p) => Math.abs(p[0] - s[0][0]) < EPS && Math.abs(p[1] - s[0][1]) < EPS);

function raise(seg: BezierSegment): Point[] {
	if (seg.length !== 3) return seg.map((p) => [p[0], p[1]] as Point);
	const [p0, p1, p2] = seg;
	return [p0, [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])], [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])], p2];
}

/** The path's subpaths with at least one segment (a closed one's closing line included). */
function subsOf(path: BezierPath): Sub[] {
	return pathToContours(path)
		.map((c) => ({ segs: closeContour(c).filter((s) => !degenerate(s)).map(raise), closed: c.closed }))
		.filter((s) => s.segs.length > 0);
}

const subsToPath = (subs: readonly Sub[]): BezierPath => contoursToPath(subs.map((s) => ({ segments: s.segs, closed: s.closed })));

const unit = (x: number, y: number): Point | null => {
	const l = Math.hypot(x, y);
	return l > 1e-12 && Number.isFinite(l) ? [x / l, y / l] : null;
};

/** Direction a segment leaves its start in (robust at a handle on its anchor). */
function startTangent(s: BezierSegment): Point {
	for (let i = 1; i < s.length; i++) {
		const u = unit(s[i][0] - s[0][0], s[i][1] - s[0][1]);
		if (u) return u;
	}
	return [1, 0];
}

/** Direction a segment arrives at its end in. */
function endTangent(s: BezierSegment): Point {
	const end = s[s.length - 1];
	for (let i = s.length - 2; i >= 0; i--) {
		const u = unit(end[0] - s[i][0], end[1] - s[i][1]);
		if (u) return u;
	}
	return [1, 0];
}

function tangentAt(s: BezierSegment, t: number): Point {
	if (t <= 1e-9) return startTangent(s);
	if (t >= 1 - 1e-9) return endTangent(s);
	const d = segmentDerivative(s, t);
	return unit(d[0], d[1]) ?? startTangent(s);
}

const perp = (v: Point): Point => [-v[1], v[0]];

/** Total arc length of a path (closing lines included). */
export function effectPathLength(path: BezierPath): number {
	let total = 0;
	for (const s of subsOf(path)) for (const seg of s.segs) total += segmentLength(seg);
	return total;
}

/** Number of on-curve points of a path (a closed subpath's start counted once). */
export function effectPathVertexCount(path: BezierPath): number {
	return subsOf(path).reduce((n, s) => n + s.segs.length + (s.closed ? 0 : 1), 0);
}

// ---------------------------------------------------------------------------
// Trim Paths
// ---------------------------------------------------------------------------

/** A path measured for trimming: its segments end to end and their lengths. */
class Measured {
	readonly segs: Point[][];
	readonly lens: number[];
	readonly total: number;
	constructor(path: BezierPath) {
		this.segs = subsOf(path).flatMap((s) => s.segs);
		this.lens = this.segs.map((s) => segmentLength(s));
		this.total = this.lens.reduce((a, b) => a + b, 0);
	}

	/**
	 * Appends the part between lengths `sa` and `sb`, continuing the last piece when this one
	 * starts where it ends (across the start of a closed path).
	 */
	append(sa: number, sb: number, out: Sub[]) {
		for (const piece of trimSegments(this.segs, sa, sb, this.lens)) {
			if (degenerate(piece)) continue;
			const last = out[out.length - 1]?.segs;
			const end = last?.[last.length - 1]?.at(-1);
			if (!end || Math.hypot(end[0] - piece[0][0], end[1] - piece[0][1]) > 1e-6) out.push({ segs: [piece], closed: false });
			else last!.push(piece);
		}
	}
}

/** The fractions of the length a trim keeps, or null when it keeps everything. */
export function trimIntervals(start: number, end: number, offsetDegrees: number): [number, number][] | null {
	let s = start / 100;
	let e = end / 100;
	if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
	if (s > e) [s, e] = [e, s];
	s = Math.min(1, Math.max(0, s));
	e = Math.min(1, Math.max(0, e));
	if (e - s >= 1 - 1e-9) return null;
	if (e - s <= 1e-9) return [];
	const off = Number.isFinite(offsetDegrees) ? (((offsetDegrees / 360) % 1) + 1) % 1 : 0;
	s += off;
	e += off;
	if (e <= 1) return [[s, e]];
	if (s >= 1) return [[s - 1, e - 1]];
	return [
		[s, 1],
		[0, e - 1]
	];
}

/**
 * Trim Paths, simultaneously: every path is trimmed by the same fractions of its own length.
 * `start` / `end` in percent, `offset` in degrees. Paths trimmed away entirely come back empty.
 */
export function trimPaths(paths: readonly BezierPath[], start: number, end: number, offsetDegrees = 0): BezierPath[] {
	const iv = trimIntervals(start, end, offsetDegrees);
	if (!iv) return paths.slice();
	return paths.map((p) => {
		const m = new Measured(p);
		const out: Sub[] = [];
		if (m.total > 0) for (const [a, b] of iv) m.append(a * m.total, b * m.total, out);
		return subsToPath(out);
	});
}

/**
 * Trim Paths, individually: the paths are laid end to end in stacking order and trimmed as one
 * length, so they draw on one after another.
 */
export function trimPathsIndividually(paths: readonly BezierPath[], start: number, end: number, offsetDegrees = 0): BezierPath[] {
	const iv = trimIntervals(start, end, offsetDegrees);
	if (!iv) return paths.slice();
	const ms = paths.map((p) => new Measured(p));
	const total = ms.reduce((n, m) => n + m.total, 0);
	let base = 0;
	return ms.map((m) => {
		const out: Sub[] = [];
		for (const [a, b] of iv) {
			const la = Math.max(0, a * total - base);
			const lb = Math.min(m.total, b * total - base);
			if (lb > la) m.append(la, lb, out);
		}
		base += m.total;
		return subsToPath(out);
	});
}

// ---------------------------------------------------------------------------
// Pucker & Bloat
// ---------------------------------------------------------------------------

/**
 * Pucker & Bloat (`amount` in percent, −100 to 100). Positive (bloat) moves the points towards
 * the mean of a path's points and pushes the handles away from it, so the segments bulge
 * outwards; negative (pucker) does the opposite, giving spiky shapes.
 */
export function puckerBloatPaths(paths: readonly BezierPath[], amount: number): BezierPath[] {
	const a = amount / 100;
	if (!a || !Number.isFinite(a)) return paths.slice();
	return paths.map((p) => {
		const verts = p.filter((c) => c.type !== 'Z') as Exclude<BezierPath[number], { type: 'Z' }>[];
		if (!verts.length) return p;
		const cx = verts.reduce((s, c) => s + c.x, 0) / verts.length;
		const cy = verts.reduce((s, c) => s + c.y, 0) / verts.length;
		const mv = (x: number, y: number) => ({ x: x + (cx - x) * a, y: y + (cy - y) * a });
		const mvh = (x: number, y: number) => ({ x: x + (x - cx) * a, y: y + (y - cy) * a });
		const out: BezierPath = [];
		let prev = { x: 0, y: 0 };
		let start = { x: 0, y: 0 };
		const curve = (c1: Vec2, c2: Vec2, q: Vec2) => {
			const h1 = mvh(c1.x, c1.y);
			const h2 = mvh(c2.x, c2.y);
			const e = mv(q.x, q.y);
			out.push({ type: 'C', x1: h1.x, y1: h1.y, x2: h2.x, y2: h2.y, x: e.x, y: e.y });
		};
		for (const c of p) {
			switch (c.type) {
				case 'M': {
					const e = mv(c.x, c.y);
					out.push({ type: 'M', x: e.x, y: e.y });
					prev = start = { x: c.x, y: c.y };
					break;
				}
				case 'L':
					curve(prev, c, c);
					prev = { x: c.x, y: c.y };
					break;
				case 'Q': {
					const c1 = { x: prev.x + (2 / 3) * (c.x1 - prev.x), y: prev.y + (2 / 3) * (c.y1 - prev.y) };
					const c2 = { x: c.x + (2 / 3) * (c.x1 - c.x), y: c.y + (2 / 3) * (c.y1 - c.y) };
					curve(c1, c2, c);
					prev = { x: c.x, y: c.y };
					break;
				}
				case 'C':
					curve({ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, c);
					prev = { x: c.x, y: c.y };
					break;
				case 'Z':
					// The implicit closing line becomes a curve too.
					if (Math.hypot(prev.x - start.x, prev.y - start.y) > EPS) curve(prev, start, start);
					out.push({ type: 'Z' });
					prev = start;
					break;
			}
		}
		return out;
	});
}

// ---------------------------------------------------------------------------
// Round Corners
// ---------------------------------------------------------------------------

/**
 * Round Corners: every corner (where the direction jumps) gets a circular arc of `radius`,
 * shrunk to fit where the sides are short. Smooth points and the ends of open paths are kept.
 */
export function roundCornerPaths(paths: readonly BezierPath[], radius: number): BezierPath[] {
	if (!(radius > 0) || !Number.isFinite(radius)) return paths.slice();
	return paths.map((p) => subpathsToBezier(bezierToSubpaths(p).map((sp) => setSubpathCorners(sp, radius))));
}

// ---------------------------------------------------------------------------
// Offset Paths
// ---------------------------------------------------------------------------

/**
 * Offset Paths: grows (positive `amount`) or shrinks (negative) every path with the given join.
 * `copies` copies are made, copy i offset by `amount · (i + 1 + copyOffset)`, all in one path.
 */
export function offsetPaths(paths: readonly BezierPath[], amount: number, join: VectorLineJoin = 'miter', miterLimit = 4, copies = 1, copyOffset = 0): BezierPath[] {
	const n = Math.min(1000, Math.max(1, Math.round(Number.isFinite(copies) ? copies : 1)));
	return paths.map((p) => {
		const out: BezierPath = [];
		for (let i = 0; i < n; i++) out.push(...offsetPath(p, amount * (i + 1 + copyOffset), { join, miterLimit }));
		return out;
	});
}

/**
 * The area a path covers when it slides `dx, dy` (its Minkowski sum with that segment): the path,
 * its moved copy and, for every edge (curves flattened within `tolerance`), the band the edge
 * sweeps, united into one path. Block and long shadows are drawn with it. Open subpaths are
 * closed, as for filling.
 */
export function sweepPath(path: BezierPath, dx: number, dy: number, fillRule: 'nonzero' | 'evenodd' = 'nonzero', tolerance = 0.25): BezierPath {
	if (!path.length) return [];
	if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-9) return path.slice();
	// Every band runs the same way round, so nonzero unites the overlapping ones.
	const bands: BezierPath = [];
	for (const contour of pathToContours(path)) {
		const ring = flattenChain(closeContour(contour, true), Math.max(1e-3, tolerance));
		for (let i = 0; i < ring.length; i++) {
			let p = ring[i];
			let q = ring[(i + 1) % ring.length];
			const turn = (q[0] - p[0]) * dy - (q[1] - p[1]) * dx;
			if (Math.abs(turn) < 1e-9) continue;
			if (turn < 0) [p, q] = [q, p];
			bands.push({ type: 'M', x: p[0], y: p[1] }, { type: 'L', x: q[0], y: q[1] }, { type: 'L', x: q[0] + dx, y: q[1] + dy }, { type: 'L', x: p[0] + dx, y: p[1] + dy }, { type: 'Z' });
		}
	}
	const moved = transformBezierPath(path, [1, 0, 0, 1, dx, dy]);
	return pathBoolean('union', [{ path, fillRule }, { path: moved, fillRule }, ...(bands.length ? [{ path: bands, fillRule: 'nonzero' as const }] : [])]).path;
}

// ---------------------------------------------------------------------------
// Twist
// ---------------------------------------------------------------------------

/**
 * Twist: turns the paths about `center` by an angle growing with the distance from it, from 0
 * at the centre to `angle` degrees at the farthest point. Segments are subdivided and their
 * handles mapped through the warp's derivative, which keeps the result smooth.
 */
export function twistPaths(paths: readonly BezierPath[], angle: number, center: Vec2): BezierPath[] {
	let rmax = 0;
	for (const p of paths) for (const c of p) if (c.type !== 'Z') rmax = Math.max(rmax, Math.hypot(c.x - center.x, c.y - center.y));
	const a = (angle * Math.PI) / 180;
	if (!a || rmax <= 1e-9 || !Number.isFinite(a)) return paths.slice();
	const k = a / rmax;
	const rot = (v: Point, th: number): Point => {
		const s = Math.sin(th);
		const co = Math.cos(th);
		return [v[0] * co - v[1] * s, v[0] * s + v[1] * co];
	};
	const map = (p: Point): Point => {
		const v: Point = [p[0] - center.x, p[1] - center.y];
		const r = rot(v, k * Math.hypot(v[0], v[1]));
		return [center.x + r[0], center.y + r[1]];
	};
	// The warp's derivative at `p` applied to `dv`.
	const jac = (p: Point, dv: Point): Point => {
		const v: Point = [p[0] - center.x, p[1] - center.y];
		const r = Math.hypot(v[0], v[1]);
		let w = dv;
		if (r > 1e-12) {
			const f = (k * (v[0] * dv[0] + v[1] * dv[1])) / r;
			w = [dv[0] - v[1] * f, dv[1] + v[0] * f];
		}
		return rot(w, k * r);
	};
	return paths.map((p) => {
		const out: Sub[] = [];
		for (const sub of subsOf(p)) {
			const segs: Point[][] = [];
			for (const seg of sub.segs) {
				const cubic = seg.length === 2 ? [seg[0], seg[0], seg[1], seg[1]] : seg;
				const len = segmentLength(seg);
				const m = Math.min(64, Math.max(1, Math.ceil((Math.abs(a) * len) / rmax / 0.15 + len / 50)));
				for (let i = 0; i < m; i++) {
					const q = subSegment(cubic, i / m, (i + 1) / m);
					const p0 = map(q[0]);
					const p3 = map(q[3]);
					const h1 = jac(q[0], [q[1][0] - q[0][0], q[1][1] - q[0][1]]);
					const h2 = jac(q[3], [q[2][0] - q[3][0], q[2][1] - q[3][1]]);
					segs.push([p0, [p0[0] + h1[0], p0[1] + h1[1]], [p3[0] + h2[0], p3[1] + h2[1]], p3]);
				}
			}
			out.push({ segs, closed: sub.closed });
		}
		return subsToPath(out);
	});
}

// ---------------------------------------------------------------------------
// Resampling (Zig Zag, Wiggle Paths)
// ---------------------------------------------------------------------------

interface Sample {
	p: Point;
	tan: Point;
	/** Length of the piece before / after this sample. */
	lenPrev: number;
	lenNext: number;
}

/**
 * Splits every segment into `m` pieces of equal arc length. Original points get the average
 * of their incoming and outgoing directions (so a corner's normal is its bisector).
 */
function resample(sub: Sub, m: number): Sample[] {
	const segs = sub.segs;
	const n = segs.length;
	const lens = segs.map((s) => segmentLength(s));
	const out: Sample[] = [];
	for (let j = 0; j < n; j++) {
		const piece = lens[j] / m;
		for (let k = 0; k < m; k++) {
			if (k === 0) {
				const tout = startTangent(segs[j]);
				const prev = sub.closed || j > 0 ? (j + n - 1) % n : null;
				let tan = tout;
				if (prev !== null) {
					const tin = endTangent(segs[prev]);
					tan = unit(tin[0] + tout[0], tin[1] + tout[1]) ?? tout;
				}
				out.push({ p: segs[j][0], tan, lenPrev: prev === null ? 0 : lens[prev] / m, lenNext: piece });
			} else {
				const t = segmentParamAtLength(segs[j], piece * k, lens[j]);
				out.push({ p: segmentPoint(segs[j], t), tan: tangentAt(segs[j], t), lenPrev: piece, lenNext: piece });
			}
		}
	}
	if (!sub.closed) {
		const last = segs[n - 1];
		out.push({ p: last[last.length - 1], tan: endTangent(last), lenPrev: lens[n - 1] / m, lenNext: 0 });
	}
	return out;
}

/** Displaced samples as corner (polyline) or smooth (tangent-aligned cubic) points; `handle` is a fraction of the pieces. */
function emit(samples: readonly Sample[], disp: readonly Point[], closed: boolean, smooth: boolean, handle: number): Sub | null {
	const n = samples.length;
	if (!n) return null;
	const pt = (i: number): Point => [samples[i].p[0] + disp[i][0], samples[i].p[1] + disp[i][1]];
	const segs: Point[][] = [];
	const count = closed ? n : n - 1;
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % n;
		const a = samples[i];
		const b = samples[j];
		const p = pt(i);
		const q = pt(j);
		if (smooth) segs.push([p, [p[0] + a.tan[0] * a.lenNext * handle, p[1] + a.tan[1] * a.lenNext * handle], [q[0] - b.tan[0] * b.lenPrev * handle, q[1] - b.tan[1] * b.lenPrev * handle], q]);
		else segs.push([p, q]);
	}
	if (!segs.length) return null;
	return { segs, closed };
}

/**
 * Zig Zag: every segment gets `ridges` ridges: it is split into `ridges + 1` equal pieces and the
 * points (original ones included) are pushed alternately `size` to either side of the path.
 * `smooth` makes rounded waves. A closed path of n segments ends up with `n · (ridges + 1)` points
 * (an open one, one more).
 */
export function zigzagPaths(paths: readonly BezierPath[], size: number, ridges: number, smooth = false): BezierPath[] {
	const m = Math.min(1000, Math.max(0, Math.round(Number.isFinite(ridges) ? ridges : 0))) + 1;
	return paths.map((p) => {
		const out: Sub[] = [];
		for (const sub of subsOf(p)) {
			const s = resample(sub, m);
			const disp = s.map((x, i) => {
				const n = perp(x.tan);
				const d = i % 2 === 0 ? size : -size;
				return [n[0] * d, n[1] * d] as Point;
			});
			const e = emit(s, disp, sub.closed, smooth, 0.36);
			if (e) out.push(e);
		}
		return subsToPath(out);
	});
}

// ---------------------------------------------------------------------------
// Wiggle Paths
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

function splitmix(x: bigint): bigint {
	x = (x + 0x9e3779b97f4a7c15n) & MASK64;
	let z = x;
	z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
	z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
	return z ^ (z >> 31n);
}

/** Deterministic hash → [−1, 1]. */
function hash(seed: bigint, idx: bigint, t: number): number {
	const h = splitmix(splitmix(splitmix(seed) ^ idx) ^ BigInt.asUintN(64, BigInt(t)));
	return (Number(h >> 11n) / 2 ** 53) * 2 - 1;
}

/** Smooth 1D value noise in [−1, 1]: Catmull-Rom through hashed lattice values (C1 in time). */
function noise(seed: bigint, idx: bigint, t: number): number {
	const i = Math.floor(t);
	const f = t - i;
	const p0 = hash(seed, idx, i - 1);
	const p1 = hash(seed, idx, i);
	const p2 = hash(seed, idx, i + 1);
	const p3 = hash(seed, idx, i + 2);
	const v = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
	return Math.min(1, Math.max(-1, v));
}

/**
 * Wiggle Paths: subdivides the paths (`detail` points per segment) and moves every point by
 * smooth noise of up to `size` that evolves over `time` seconds at `speed` wiggles per second.
 * The same parameters always give the same result.
 */
export function wigglePaths(paths: readonly BezierPath[], w: VectorEffectParamsMap['wiggle']): BezierPath[] {
	if (!w.size || !Number.isFinite(w.size)) return paths.slice();
	const m = Math.min(1000, Math.max(0, Math.round(Number.isFinite(w.detail) ? w.detail : 0))) + 1;
	const seed = BigInt.asUintN(64, BigInt(Math.round(Number.isFinite(w.seed) ? w.seed : 0)));
	const t = (Number.isFinite(w.time) ? w.time : 0) * (Number.isFinite(w.speed) ? w.speed : 0) + (Number.isFinite(w.phase) ? w.phase : 0) / 360;
	const corr = Math.min(1, Math.max(0, (Number.isFinite(w.correlation) ? w.correlation : 0) / 100));
	const sx = noise(seed, MASK64, t);
	const sy = noise(seed, MASK64 - 1n, t);
	let idx = 0;
	return paths.map((p) => {
		const out: Sub[] = [];
		for (const sub of subsOf(p)) {
			const s = resample(sub, m);
			const disp = s.map(() => {
				const i = BigInt(idx);
				const ox = noise(seed, i * 2n, t + idx * 0.37);
				const oy = noise(seed, i * 2n + 1n, t + idx * 0.61);
				idx++;
				return [(sx * corr + ox * (1 - corr)) * w.size, (sy * corr + oy * (1 - corr)) * w.size] as Point;
			});
			const e = emit(s, disp, sub.closed, w.smooth, 1 / 3);
			if (e) out.push(e);
		}
		return subsToPath(out);
	});
}

// ---------------------------------------------------------------------------
// Merge Paths
// ---------------------------------------------------------------------------

const MERGE_OPS = { add: 'union', subtract: 'difference', intersect: 'intersection', exclude: 'xor' } as const;

/** Merge Paths: the paths (in stacking order, each filled non-zero) combined into one path. */
export function mergePaths(paths: readonly BezierPath[], mode: VectorMergeMode = 'merge'): BezierPath {
	if (mode === 'merge' || !(mode in MERGE_OPS)) return paths.flat();
	const inputs = paths.filter((p) => p.length > 0).map((path) => ({ path, fillRule: 'nonzero' as const }));
	if (!inputs.length) return [];
	return pathBoolean(MERGE_OPS[mode as keyof typeof MERGE_OPS], inputs).path;
}

// ---------------------------------------------------------------------------
// Repeater
// ---------------------------------------------------------------------------

/** One copy a repeater makes: its transform (node space) and opacity factor. */
export interface VectorRepeaterCopy {
	/** Copy number (0 is the original). */
	index: number;
	matrix: AffineMatrix;
	opacity: number;
}

/**
 * The copies of a repeater around `pivot` (the anchor point in node space), in copy order.
 * Copy i is moved by `translate(position·k) · rotate(rotation·k) · scale^k` about the pivot with
 * `k = i + offset`; opacity runs from the start to the end opacity across the copies, and a
 * fractional copy count fades the last copy by its fraction.
 */
export function vectorRepeaterCopies(r: VectorEffectParamsMap['repeater'], pivot: Vec2): VectorRepeaterCopy[] {
	const copies = Math.max(0, Number.isFinite(r.copies) ? Math.min(r.copies, 1000) : 0);
	const n = Math.ceil(copies);
	const offset = Number.isFinite(r.offset) ? r.offset : 0;
	const so = (r.startOpacity ?? 100) / 100;
	const eo = (r.endOpacity ?? 100) / 100;
	const fract = copies - Math.floor(copies);
	const out: VectorRepeaterCopy[] = [];
	for (let i = 0; i < n; i++) {
		const k = i + offset;
		let m = translateMatrix(-pivot.x, -pivot.y);
		m = multiplyMatrices(m, scaleMatrix(Math.pow((r.scale?.x ?? 100) / 100, k), Math.pow((r.scale?.y ?? 100) / 100, k)));
		m = multiplyMatrices(m, rotateMatrix((r.rotation ?? 0) * k));
		m = multiplyMatrices(m, translateMatrix(pivot.x + (r.position?.x ?? 0) * k, pivot.y + (r.position?.y ?? 0) * k));
		const t = n > 1 ? i / (n - 1) : 0;
		const partial = i + 1 === n && fract > 0 ? fract : 1;
		out.push({ index: i, matrix: m, opacity: Math.min(1, Math.max(0, (so + (eo - so) * t) * partial)) });
	}
	return out;
}

/** Each path repeated by `vectorRepeaterCopies` (copy order, the original first). */
export function repeatPaths(paths: readonly BezierPath[], r: VectorEffectParamsMap['repeater'], pivot: Vec2): { copy: VectorRepeaterCopy; paths: BezierPath[] }[] {
	return vectorRepeaterCopies(r, pivot).map((copy) => ({ copy, paths: paths.map((p) => transformBezierPath(p, copy.matrix)) }));
}

/** The middle of the paths' bounds (the origin when they are empty). */
export function pathsCenter(paths: readonly BezierPath[]): Vec2 {
	const b = bezierPathBounds(paths.flat());
	return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : { x: 0, y: 0 };
}
