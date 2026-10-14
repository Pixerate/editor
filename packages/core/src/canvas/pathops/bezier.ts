/**
 * Bézier path model shared by the curve-preserving path operations: absolute `M` / `L` /
 * `Q` / `C` / `Z` commands, conversion from SVG path data (arcs become cubics), segment
 * math (evaluation, splitting, extrema, nearest point), exact areas, winding numbers and
 * arc-length utilities.
 */
import type { Point } from '../types.js';
import { formatNumber, parseSvgPath, type PathCommand } from '../shapeGeometry.js';
import type { PolygonFillRule } from '../polygonBoolean.js';

// ---------------------------------------------------------------------------
// Public path model
// ---------------------------------------------------------------------------

/** One absolute path command. Every subpath starts with `M`; `Z` closes it. */
export type BezierCommand =
	| { type: 'M'; x: number; y: number }
	| { type: 'L'; x: number; y: number }
	| { type: 'Q'; x1: number; y1: number; x: number; y: number }
	| { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
	| { type: 'Z' };

/** A path as a list of absolute move / line / quadratic / cubic / close commands. */
export type BezierPath = BezierCommand[];

/** Anything the path operations accept as a path: SVG path data, parsed commands or a `BezierPath`. */
export type BezierPathInput = string | readonly BezierCommand[] | readonly PathCommand[];

/**
 * One segment as its control points: 2 points for a line, 3 for a quadratic and 4 for a
 * cubic Bézier.
 */
export type BezierSegment = readonly Point[];

/** A subpath as a chain of segments (each starts where the previous one ends). */
export interface BezierContour {
	segments: BezierSegment[];
	closed: boolean;
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

export const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
export const scale = (a: Point, s: number): Point => [a[0] * s, a[1] * s];
export const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
export const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
export const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const samePoint = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

export function unit(v: Point): Point | null {
	const l = Math.hypot(v[0], v[1]);
	return l > 0 && Number.isFinite(l) ? [v[0] / l, v[1] / l] : null;
}

// ---------------------------------------------------------------------------
// Segment math
// ---------------------------------------------------------------------------

/** Point at parameter `t` (de Casteljau, works for any degree). */
export function segmentPoint(seg: BezierSegment, t: number): Point {
	const n = seg.length;
	if (n === 2) return lerp(seg[0], seg[1], t);
	const mt = 1 - t;
	if (n === 3) {
		const a = mt * mt;
		const b = 2 * mt * t;
		const c = t * t;
		return [a * seg[0][0] + b * seg[1][0] + c * seg[2][0], a * seg[0][1] + b * seg[1][1] + c * seg[2][1]];
	}
	const a = mt * mt * mt;
	const b = 3 * mt * mt * t;
	const c = 3 * mt * t * t;
	const d = t * t * t;
	return [
		a * seg[0][0] + b * seg[1][0] + c * seg[2][0] + d * seg[3][0],
		a * seg[0][1] + b * seg[1][1] + c * seg[2][1] + d * seg[3][1]
	];
}

/** First derivative at `t`. */
export function segmentDerivative(seg: BezierSegment, t: number): Point {
	const n = seg.length;
	if (n === 2) return sub(seg[1], seg[0]);
	if (n === 3) {
		const a = sub(seg[1], seg[0]);
		const b = sub(seg[2], seg[1]);
		return [2 * ((1 - t) * a[0] + t * b[0]), 2 * ((1 - t) * a[1] + t * b[1])];
	}
	const a = sub(seg[1], seg[0]);
	const b = sub(seg[2], seg[1]);
	const c = sub(seg[3], seg[2]);
	const mt = 1 - t;
	return [
		3 * (mt * mt * a[0] + 2 * mt * t * b[0] + t * t * c[0]),
		3 * (mt * mt * a[1] + 2 * mt * t * b[1] + t * t * c[1])
	];
}

/** Second derivative at `t`. */
export function segmentSecondDerivative(seg: BezierSegment, t: number): Point {
	const n = seg.length;
	if (n === 2) return [0, 0];
	if (n === 3) return [2 * (seg[2][0] - 2 * seg[1][0] + seg[0][0]), 2 * (seg[2][1] - 2 * seg[1][1] + seg[0][1])];
	const a: Point = [seg[2][0] - 2 * seg[1][0] + seg[0][0], seg[2][1] - 2 * seg[1][1] + seg[0][1]];
	const b: Point = [seg[3][0] - 2 * seg[2][0] + seg[1][0], seg[3][1] - 2 * seg[2][1] + seg[1][1]];
	return [6 * ((1 - t) * a[0] + t * b[0]), 6 * ((1 - t) * a[1] + t * b[1])];
}

/**
 * Unit tangent at `t`. Where the derivative vanishes (a handle on its anchor) the direction
 * a hair further along is used, and the chord as the last resort.
 */
export function segmentTangent(seg: BezierSegment, t: number): Point {
	const d = unit(segmentDerivative(seg, t));
	if (d) return d;
	const h = t < 0.5 ? Math.min(1, t + 1e-6) : Math.max(0, t - 1e-6);
	const e = unit(segmentDerivative(seg, h));
	if (e) return e;
	return unit(sub(seg[seg.length - 1], seg[0])) ?? [1, 0];
}

/** Signed curvature at `t` (positive when turning counter-clockwise in a y-up frame). */
export function segmentCurvature(seg: BezierSegment, t: number): number {
	if (seg.length === 2) return 0;
	let d = segmentDerivative(seg, t);
	let tt = t;
	if (Math.hypot(d[0], d[1]) < 1e-12) {
		tt = t < 0.5 ? Math.min(1, t + 1e-6) : Math.max(0, t - 1e-6);
		d = segmentDerivative(seg, tt);
	}
	const dd = segmentSecondDerivative(seg, tt);
	const len = Math.hypot(d[0], d[1]);
	if (!(len > 0)) return 0;
	return cross(d, dd) / (len * len * len);
}

/** Splits a segment at `t` (de Casteljau). */
export function splitSegment(seg: BezierSegment, t: number): [Point[], Point[]] {
	const n = seg.length;
	if (n === 2) {
		const m = lerp(seg[0], seg[1], t);
		return [
			[seg[0], m],
			[m, seg[1]]
		];
	}
	if (n === 3) {
		const a = lerp(seg[0], seg[1], t);
		const b = lerp(seg[1], seg[2], t);
		const m = lerp(a, b, t);
		return [
			[seg[0], a, m],
			[m, b, seg[2]]
		];
	}
	const a = lerp(seg[0], seg[1], t);
	const b = lerp(seg[1], seg[2], t);
	const c = lerp(seg[2], seg[3], t);
	const ab = lerp(a, b, t);
	const bc = lerp(b, c, t);
	const m = lerp(ab, bc, t);
	return [
		[seg[0], a, ab, m],
		[m, bc, c, seg[3]]
	];
}

/** The part of a segment between parameters `t0` and `t1` (reversed when `t1 < t0`). */
export function subSegment(seg: BezierSegment, t0: number, t1: number): Point[] {
	if (t1 < t0) return subSegment(seg, t1, t0).reverse();
	if (t0 <= 0 && t1 >= 1) return [...seg];
	let s: Point[] = [...seg];
	if (t1 < 1) s = splitSegment(s, t1)[0];
	if (t0 > 0) s = splitSegment(s, t1 > 0 ? t0 / t1 : 0)[1];
	return s;
}

/** Whether every control point lies within `tol` of the chord (a line in disguise). */
export function isStraightSegment(seg: BezierSegment, tol: number): boolean {
	if (seg.length === 2) return true;
	const a = seg[0];
	const b = seg[seg.length - 1];
	const chord = sub(b, a);
	const len = Math.hypot(chord[0], chord[1]);
	for (let i = 1; i < seg.length - 1; i++) {
		const v = sub(seg[i], a);
		if (len === 0) {
			if (Math.hypot(v[0], v[1]) > tol) return false;
			continue;
		}
		if (Math.abs(cross(chord, v)) / len > tol) return false;
		const along = dot(chord, v) / len;
		if (along < -tol || along > len + tol) return false;
	}
	return true;
}

/** Real roots in the open interval (0, 1) of `a t² + b t + c`. */
function quadraticRoots(a: number, b: number, c: number, out: number[]) {
	const push = (t: number) => {
		if (t > 1e-12 && t < 1 - 1e-12) out.push(t);
	};
	const scaleAbs = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
	if (scaleAbs === 0) return;
	if (Math.abs(a) <= 1e-12 * scaleAbs) {
		if (b !== 0) push(-c / b);
		return;
	}
	const disc = b * b - 4 * a * c;
	if (disc < 0) return;
	const sq = Math.sqrt(disc);
	const q = -0.5 * (b + (b >= 0 ? sq : -sq));
	push(q / a);
	if (q !== 0) push(c / q);
}

/** Parameters in (0, 1) where the segment's `axis` coordinate has a local extremum. */
export function segmentExtrema(seg: BezierSegment, axis: 0 | 1): number[] {
	const out: number[] = [];
	if (seg.length === 3) {
		const d = seg[0][axis] - 2 * seg[1][axis] + seg[2][axis];
		if (d !== 0) {
			const t = (seg[0][axis] - seg[1][axis]) / d;
			if (t > 1e-12 && t < 1 - 1e-12) out.push(t);
		}
	} else if (seg.length === 4) {
		const p0 = seg[0][axis];
		const p1 = seg[1][axis];
		const p2 = seg[2][axis];
		const p3 = seg[3][axis];
		// B'(t)/3 = a t² + b t + c
		const a = -p0 + 3 * p1 - 3 * p2 + p3;
		const b = 2 * (p0 - 2 * p1 + p2);
		const c = p1 - p0;
		quadraticRoots(a, b, c, out);
	}
	return out.sort((x, y) => x - y);
}

/** Exact axis-aligned bounds of a segment. */
export function segmentBounds(seg: BezierSegment): { minX: number; minY: number; maxX: number; maxY: number } {
	const a = seg[0];
	const b = seg[seg.length - 1];
	let minX = Math.min(a[0], b[0]);
	let maxX = Math.max(a[0], b[0]);
	let minY = Math.min(a[1], b[1]);
	let maxY = Math.max(a[1], b[1]);
	for (const axis of [0, 1] as const) {
		for (const t of segmentExtrema(seg, axis)) {
			const p = segmentPoint(seg, t);
			if (axis === 0) {
				minX = Math.min(minX, p[0]);
				maxX = Math.max(maxX, p[0]);
			} else {
				minY = Math.min(minY, p[1]);
				maxY = Math.max(maxY, p[1]);
			}
		}
	}
	return { minX, minY, maxX, maxY };
}

/** Parameters splitting the segment into pieces monotone in x and y. */
export function monotoneParams(seg: BezierSegment): number[] {
	if (seg.length === 2) return [];
	const ts = [...segmentExtrema(seg, 0), ...segmentExtrema(seg, 1)].sort((a, b) => a - b);
	const out: number[] = [];
	for (const t of ts) if (out.length === 0 || t - out[out.length - 1] > 1e-9) out.push(t);
	return out;
}

/**
 * Signed area swept by the segment relative to the origin (½ ∫ x dy − y dx). Exact:
 * the integrand is a polynomial of degree at most 5, which 3-point Gauss–Legendre
 * integrates exactly.
 */
export function segmentAreaTerm(seg: BezierSegment): number {
	if (seg.length === 2) return (seg[0][0] * seg[1][1] - seg[1][0] * seg[0][1]) / 2;
	const nodes = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)];
	const weights = [5 / 9, 8 / 9, 5 / 9];
	let sum = 0;
	for (let i = 0; i < 3; i++) {
		const t = (nodes[i] + 1) / 2;
		const p = segmentPoint(seg, t);
		const d = segmentDerivative(seg, t);
		sum += weights[i] * (p[0] * d[1] - p[1] * d[0]);
	}
	// ½ for the area, ½ for mapping [-1, 1] onto [0, 1].
	return sum / 4;
}

// Gauss–Legendre nodes / weights (order 8) on [-1, 1].
const GL_X = [
	-0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498, 0.1834346424956498,
	0.525532409916329, 0.7966664774136267, 0.9602898564975363
];
const GL_W = [
	0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
	0.3137066458778873, 0.2223810344533745, 0.1012285362903763
];

function glLength(seg: BezierSegment, t0: number, t1: number): number {
	const half = (t1 - t0) / 2;
	const mid = (t0 + t1) / 2;
	let sum = 0;
	for (let i = 0; i < GL_X.length; i++) {
		const d = segmentDerivative(seg, mid + half * GL_X[i]);
		sum += GL_W[i] * Math.hypot(d[0], d[1]);
	}
	return sum * half;
}

function adaptiveLength(seg: BezierSegment, t0: number, t1: number, whole: number, tol: number, depth: number): number {
	const m = (t0 + t1) / 2;
	const left = glLength(seg, t0, m);
	const right = glLength(seg, m, t1);
	if (depth >= 18 || Math.abs(left + right - whole) <= tol) return left + right;
	return adaptiveLength(seg, t0, m, left, tol / 2, depth + 1) + adaptiveLength(seg, m, t1, right, tol / 2, depth + 1);
}

/** Arc length of the segment between `t0` and `t1` (default the whole segment). */
export function segmentLength(seg: BezierSegment, t0 = 0, t1 = 1, tolerance = 1e-9): number {
	if (t1 < t0) return segmentLength(seg, t1, t0, tolerance);
	if (seg.length === 2) return dist(seg[0], seg[1]) * (t1 - t0);
	const whole = glLength(seg, t0, t1);
	return adaptiveLength(seg, t0, t1, whole, Math.max(tolerance, whole * 1e-12), 0);
}

/** Parameter at arc length `length` from the segment start (clamped to [0, 1]). */
export function segmentParamAtLength(seg: BezierSegment, length: number, total = segmentLength(seg)): number {
	if (!(total > 0) || length <= 0) return 0;
	if (length >= total) return 1;
	if (seg.length === 2) return length / total;
	let lo = 0;
	let hi = 1;
	let t = length / total;
	for (let i = 0; i < 40; i++) {
		const err = segmentLength(seg, 0, t) - length;
		if (Math.abs(err) <= 1e-10 * Math.max(1, total)) break;
		if (err > 0) hi = t;
		else lo = t;
		const d = segmentDerivative(seg, t);
		const speed = Math.hypot(d[0], d[1]);
		let next = speed > 0 ? t - err / speed : (lo + hi) / 2;
		if (!(next > lo && next < hi)) next = (lo + hi) / 2;
		t = next;
	}
	return t;
}

/**
 * Nearest point of the segment to `p`: the parameter and the distance. Coarse sampling
 * followed by Newton refinement around the best samples.
 */
export function segmentNearest(seg: BezierSegment, p: Point): { t: number; distance: number } {
	if (seg.length === 2) {
		const d = sub(seg[1], seg[0]);
		const len2 = dot(d, d);
		const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, seg[0]), d) / len2));
		return { t, distance: dist(p, segmentPoint(seg, t)) };
	}
	const samples = 16;
	let best = { t: 0, distance: dist(p, seg[0]) };
	const candidates: number[] = [];
	let prev = Infinity;
	let prevT = 0;
	let descending = false;
	for (let i = 0; i <= samples; i++) {
		const t = i / samples;
		const d = dist(p, segmentPoint(seg, t));
		if (d < best.distance) best = { t, distance: d };
		if (i > 0 && d > prev && descending) candidates.push(prevT);
		descending = d < prev;
		prev = d;
		prevT = t;
	}
	candidates.push(best.t, 1);
	for (const start of candidates) {
		let t = start;
		for (let k = 0; k < 12; k++) {
			const q = segmentPoint(seg, t);
			const d1 = segmentDerivative(seg, t);
			const d2 = segmentSecondDerivative(seg, t);
			const diff = sub(q, p);
			const f = dot(diff, d1);
			const fp = dot(d1, d1) + dot(diff, d2);
			if (!(Math.abs(fp) > 1e-300)) break;
			const next = Math.max(0, Math.min(1, t - f / fp));
			if (Math.abs(next - t) < 1e-14) {
				t = next;
				break;
			}
			t = next;
		}
		const d = dist(p, segmentPoint(seg, t));
		if (d < best.distance) best = { t, distance: d };
	}
	return best;
}

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

/** Converts an SVG elliptical arc (SVG 1.1 F.6.5) to cubic segments, at most 90° each. */
export function arcToCubics(
	from: Point,
	cmd: { rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; x: number; y: number }
): Point[][] {
	const [x0, y0] = from;
	const { x, y } = cmd;
	if (x0 === x && y0 === y) return [];
	let rx = Math.abs(cmd.rx);
	let ry = Math.abs(cmd.ry);
	if (rx === 0 || ry === 0) return [[from, [x, y]]];
	const phi = (cmd.rotation * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (x0 - x) / 2;
	const dy = (y0 - y) / 2;
	const x1p = cos * dx + sin * dy;
	const y1p = -sin * dx + cos * dy;
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) {
		const s = Math.sqrt(lambda);
		rx *= s;
		ry *= s;
	}
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
	if (cmd.largeArc === cmd.sweep) coef = -coef;
	const cxp = (coef * rx * y1p) / ry;
	const cyp = (-coef * ry * x1p) / rx;
	const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
	const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!cmd.sweep && delta > 0) delta -= 2 * Math.PI;
	else if (cmd.sweep && delta < 0) delta += 2 * Math.PI;
	const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
	const step = delta / n;
	const k = (4 / 3) * Math.tan(step / 4);
	const map = (ux: number, uy: number): Point => {
		const ex = rx * ux;
		const ey = ry * uy;
		return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
	};
	const out: Point[][] = [];
	let prev: Point = from;
	for (let i = 0; i < n; i++) {
		const a0 = theta1 + step * i;
		const a1 = a0 + step;
		const c0 = Math.cos(a0);
		const s0 = Math.sin(a0);
		const c1 = Math.cos(a1);
		const s1 = Math.sin(a1);
		const end: Point = i === n - 1 ? [x, y] : map(c1, s1);
		out.push([prev, map(c0 - k * s0, s0 + k * c0), map(c1 + k * s1, s1 - k * c1), end]);
		prev = end;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

function isBezierCommandList(input: BezierPathInput): input is readonly BezierCommand[] {
	return Array.isArray(input) && !input.some((c: any) => c && c.type === 'A');
}

/**
 * Converts SVG path data or parsed commands to a `BezierPath` (absolute `M` / `L` / `Q` /
 * `C` / `Z`); elliptical arcs become cubic Béziers (at most 90° each).
 */
export function toBezierPath(input: BezierPathInput): BezierPath {
	const commands: readonly (PathCommand | BezierCommand)[] =
		typeof input === 'string' ? parseSvgPath(input) : isBezierCommandList(input) ? input : (input as readonly PathCommand[]);
	const out: BezierPath = [];
	let current: Point = [0, 0];
	let start: Point = [0, 0];
	let open = false;
	const ensureMove = () => {
		if (!open) {
			out.push({ type: 'M', x: start[0], y: start[1] });
			current = start;
			open = true;
		}
	};
	for (const cmd of commands) {
		switch (cmd.type) {
			case 'M':
				start = [cmd.x, cmd.y];
				current = start;
				out.push({ type: 'M', x: cmd.x, y: cmd.y });
				open = true;
				break;
			case 'L':
				ensureMove();
				out.push({ type: 'L', x: cmd.x, y: cmd.y });
				current = [cmd.x, cmd.y];
				break;
			case 'Q':
				ensureMove();
				out.push({ type: 'Q', x1: cmd.x1, y1: cmd.y1, x: cmd.x, y: cmd.y });
				current = [cmd.x, cmd.y];
				break;
			case 'C':
				ensureMove();
				out.push({ type: 'C', x1: cmd.x1, y1: cmd.y1, x2: cmd.x2, y2: cmd.y2, x: cmd.x, y: cmd.y });
				current = [cmd.x, cmd.y];
				break;
			case 'A': {
				ensureMove();
				for (const c of arcToCubics(current, cmd)) {
					if (c.length === 2) out.push({ type: 'L', x: c[1][0], y: c[1][1] });
					else out.push({ type: 'C', x1: c[1][0], y1: c[1][1], x2: c[2][0], y2: c[2][1], x: c[3][0], y: c[3][1] });
				}
				current = [cmd.x, cmd.y];
				break;
			}
			case 'Z':
				if (open) out.push({ type: 'Z' });
				open = false;
				current = start;
				break;
		}
	}
	return out;
}

/** Splits a path into contours of segments. Zero-length segments are dropped. */
export function pathToContours(input: BezierPathInput): BezierContour[] {
	const path = toBezierPath(input);
	const contours: BezierContour[] = [];
	let current: BezierContour | null = null;
	let pen: Point = [0, 0];
	let start: Point = [0, 0];
	const push = (seg: Point[]) => {
		if (!current) {
			current = { segments: [], closed: false };
			contours.push(current);
		}
		if (seg.every((p) => samePoint(p, seg[0]))) return;
		current.segments.push(seg);
	};
	for (const cmd of path) {
		switch (cmd.type) {
			case 'M':
				start = [cmd.x, cmd.y];
				pen = start;
				current = { segments: [], closed: false };
				contours.push(current);
				break;
			case 'L':
				push([pen, [cmd.x, cmd.y]]);
				pen = [cmd.x, cmd.y];
				break;
			case 'Q':
				push([pen, [cmd.x1, cmd.y1], [cmd.x, cmd.y]]);
				pen = [cmd.x, cmd.y];
				break;
			case 'C':
				push([pen, [cmd.x1, cmd.y1], [cmd.x2, cmd.y2], [cmd.x, cmd.y]]);
				pen = [cmd.x, cmd.y];
				break;
			case 'Z':
				if (current) (current as BezierContour).closed = true;
				current = null;
				pen = start;
				break;
		}
	}
	return contours;
}

/** Builds a path from contours (a closed contour's closing line is left to `Z`). */
export function contoursToPath(contours: readonly BezierContour[]): BezierPath {
	const out: BezierPath = [];
	for (const contour of contours) {
		const segs = contour.segments;
		if (segs.length === 0) continue;
		out.push({ type: 'M', x: segs[0][0][0], y: segs[0][0][1] });
		let count = segs.length;
		if (contour.closed && count > 1) {
			const last = segs[count - 1];
			if (last.length === 2 && samePoint(last[1], segs[0][0])) count--;
		}
		for (let i = 0; i < count; i++) {
			const s = segs[i];
			const end = s[s.length - 1];
			if (s.length === 2) out.push({ type: 'L', x: end[0], y: end[1] });
			else if (s.length === 3) out.push({ type: 'Q', x1: s[1][0], y1: s[1][1], x: end[0], y: end[1] });
			else out.push({ type: 'C', x1: s[1][0], y1: s[1][1], x2: s[2][0], y2: s[2][1], x: end[0], y: end[1] });
		}
		if (contour.closed) out.push({ type: 'Z' });
	}
	return out;
}

export interface BezierPathToSvgOptions {
	/** Decimal places (default 3). */
	precision?: number;
	/** Added to every point before formatting. */
	offset?: { x: number; y: number };
}

/** Writes a path as compact SVG path data. */
export function bezierPathToSvg(input: BezierPathInput, options: BezierPathToSvgOptions = {}): string {
	const path = toBezierPath(input);
	const precision = options.precision ?? 3;
	const dx = options.offset?.x ?? 0;
	const dy = options.offset?.y ?? 0;
	const fx = (n: number) => formatNumber(n + dx, precision);
	const fy = (n: number) => formatNumber(n + dy, precision);
	let d = '';
	for (const c of path) {
		switch (c.type) {
			case 'M':
				d += `M${fx(c.x)} ${fy(c.y)}`;
				break;
			case 'L':
				d += `L${fx(c.x)} ${fy(c.y)}`;
				break;
			case 'Q':
				d += `Q${fx(c.x1)} ${fy(c.y1)} ${fx(c.x)} ${fy(c.y)}`;
				break;
			case 'C':
				d += `C${fx(c.x1)} ${fy(c.y1)} ${fx(c.x2)} ${fy(c.y2)} ${fx(c.x)} ${fy(c.y)}`;
				break;
			case 'Z':
				d += 'Z';
				break;
		}
	}
	return d;
}

/** 2D affine matrix `[a, b, c, d, e, f]` mapping `(x, y)` to `(a x + c y + e, b x + d y + f)`. */
export type AffineMatrix = readonly [number, number, number, number, number, number];

/** Applies an affine transform to every point (exact for Bézier curves). */
export function transformBezierPath(input: BezierPathInput, m: AffineMatrix): BezierPath {
	const [a, b, c, d, e, f] = m;
	const X = (x: number, y: number) => a * x + c * y + e;
	const Y = (x: number, y: number) => b * x + d * y + f;
	return toBezierPath(input).map((cmd): BezierCommand => {
		switch (cmd.type) {
			case 'M':
			case 'L':
				return { type: cmd.type, x: X(cmd.x, cmd.y), y: Y(cmd.x, cmd.y) };
			case 'Q':
				return { type: 'Q', x1: X(cmd.x1, cmd.y1), y1: Y(cmd.x1, cmd.y1), x: X(cmd.x, cmd.y), y: Y(cmd.x, cmd.y) };
			case 'C':
				return {
					type: 'C',
					x1: X(cmd.x1, cmd.y1),
					y1: Y(cmd.x1, cmd.y1),
					x2: X(cmd.x2, cmd.y2),
					y2: Y(cmd.x2, cmd.y2),
					x: X(cmd.x, cmd.y),
					y: Y(cmd.x, cmd.y)
				};
			case 'Z':
				return cmd;
		}
	});
}

/** Number of drawing segments (`L` / `Q` / `C`, plus the closing line of `Z` when it has length). */
export function countPathSegments(input: BezierPathInput): { lines: number; quads: number; cubics: number } {
	const out = { lines: 0, quads: 0, cubics: 0 };
	for (const contour of pathToContours(input)) {
		const segs = closeContour(contour);
		for (const s of segs) {
			if (s.length === 2) out.lines++;
			else if (s.length === 3) out.quads++;
			else out.cubics++;
		}
	}
	return out;
}

/** The contour's segments, with the closing line added when the contour is closed (or filled). */
export function closeContour(contour: BezierContour, force = false): BezierSegment[] {
	const segs = contour.segments;
	if (segs.length === 0) return [];
	if (!contour.closed && !force) return segs;
	const first = segs[0][0];
	const lastSeg = segs[segs.length - 1];
	const last = lastSeg[lastSeg.length - 1];
	return samePoint(first, last) ? segs : [...segs, [last, first]];
}

// ---------------------------------------------------------------------------
// Measures
// ---------------------------------------------------------------------------

/** Exact bounds of a path, or `null` when it has no points. */
export function bezierPathBounds(input: BezierPathInput): { minX: number; minY: number; maxX: number; maxY: number } | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const path = toBezierPath(input);
	let pen: Point | null = null;
	for (const contour of pathToContours(path)) {
		for (const s of contour.segments) {
			const b = segmentBounds(s);
			minX = Math.min(minX, b.minX);
			minY = Math.min(minY, b.minY);
			maxX = Math.max(maxX, b.maxX);
			maxY = Math.max(maxY, b.maxY);
		}
	}
	for (const c of path) {
		if (c.type === 'M') pen = [c.x, c.y];
		if (pen) {
			minX = Math.min(minX, pen[0]);
			minY = Math.min(minY, pen[1]);
			maxX = Math.max(maxX, pen[0]);
			maxY = Math.max(maxY, pen[1]);
		}
	}
	return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/**
 * Signed area of the path as drawn: every subpath closed, contributions summed (positive
 * for counter-clockwise subpaths in a y-up frame). Exact for curves. Overlapping subpaths
 * count with their multiplicity; use `bezierPathArea` for the filled area.
 */
export function bezierPathSignedArea(input: BezierPathInput): number {
	let sum = 0;
	for (const contour of pathToContours(input)) sum += contourSignedArea(closeContour(contour, true));
	return sum;
}

/** Signed area of a closed chain of segments. */
export function contourSignedArea(segs: readonly BezierSegment[]): number {
	let sum = 0;
	for (const s of segs) sum += segmentAreaTerm(s);
	return sum;
}

/** Arc length of a path (closing lines of closed subpaths included). */
export function bezierPathLength(input: BezierPathInput): number {
	let total = 0;
	for (const contour of pathToContours(input)) for (const s of closeContour(contour)) total += segmentLength(s);
	return total;
}

/** Point, unit tangent and angle (radians) at an arc length along the path. */
export interface PathPointAtLength {
	point: Point;
	tangent: Point;
	angle: number;
	/** Subpath index. */
	contour: number;
	/** Segment index within the subpath (closing line last). */
	segment: number;
	/** Parameter within the segment. */
	t: number;
}

/**
 * The point at arc length `length` from the start of the path (clamped to the path). Arc
 * lengths run through the subpaths in order, as `bezierPathLength` counts them.
 */
export function bezierPathPointAtLength(input: BezierPathInput, length: number): PathPointAtLength | null {
	const contours = pathToContours(input);
	let remaining = Math.max(0, length);
	let last: PathPointAtLength | null = null;
	for (let ci = 0; ci < contours.length; ci++) {
		const segs = closeContour(contours[ci]);
		for (let si = 0; si < segs.length; si++) {
			const s = segs[si];
			const len = segmentLength(s);
			if (remaining <= len) {
				const t = segmentParamAtLength(s, remaining, len);
				const tangent = segmentTangent(s, t);
				return { point: segmentPoint(s, t), tangent, angle: Math.atan2(tangent[1], tangent[0]), contour: ci, segment: si, t };
			}
			remaining -= len;
			const tangent = segmentTangent(s, 1);
			last = { point: s[s.length - 1], tangent, angle: Math.atan2(tangent[1], tangent[0]), contour: ci, segment: si, t: 1 };
		}
	}
	return last;
}

/**
 * Splits a segment chain by arc length: the part between `from` and `to` (measured from the
 * chain's start) as new segments.
 */
export function trimSegments(segs: readonly BezierSegment[], from: number, to: number, lengths?: number[]): Point[][] {
	const lens = lengths ?? segs.map((s) => segmentLength(s));
	const out: Point[][] = [];
	let at = 0;
	for (let i = 0; i < segs.length; i++) {
		const len = lens[i];
		const s0 = at;
		const s1 = at + len;
		at = s1;
		if (s1 <= from || s0 >= to || len <= 0) continue;
		const t0 = from > s0 ? segmentParamAtLength(segs[i], from - s0, len) : 0;
		const t1 = to < s1 ? segmentParamAtLength(segs[i], to - s0, len) : 1;
		if (t1 > t0) out.push(subSegment(segs[i], t0, t1));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Winding numbers
// ---------------------------------------------------------------------------

/** Parameter where a y-monotone segment reaches height `y` (it must span `y`). */
export function solveMonotone(seg: BezierSegment, axis: 0 | 1, value: number): number {
	const a = seg[0][axis];
	const b = seg[seg.length - 1][axis];
	if (seg.length === 2) return b === a ? 0 : (value - a) / (b - a);
	const increasing = b > a;
	let lo = 0;
	let hi = 1;
	let t = b === a ? 0.5 : Math.max(0, Math.min(1, (value - a) / (b - a)));
	for (let i = 0; i < 60; i++) {
		const v = segmentPoint(seg, t)[axis] - value;
		if (v === 0) return t;
		if (v > 0 === increasing) hi = t;
		else lo = t;
		const d = segmentDerivative(seg, t)[axis];
		let next = d !== 0 ? t - v / d : (lo + hi) / 2;
		if (!(next > lo && next < hi)) next = (lo + hi) / 2;
		if (Math.abs(next - t) < 1e-15) return next;
		t = next;
	}
	return t;
}

/** Splits segments at their y extrema (pieces monotone in y). */
function yMonotonePieces(segs: readonly BezierSegment[]): BezierSegment[] {
	const out: BezierSegment[] = [];
	for (const s of segs) {
		if (s.length === 2) {
			out.push(s);
			continue;
		}
		const ts = segmentExtrema(s, 1);
		let prev = 0;
		for (const t of [...ts, 1]) {
			out.push(subSegment(s, prev, t));
			prev = t;
		}
	}
	return out;
}

/**
 * Winding number of a set of closed segment chains around `point` (ray to +x, half-open
 * crossing rule). Points exactly on the outline may report either side.
 */
export function windingNumber(chains: readonly (readonly BezierSegment[])[], point: Point): number {
	const [px, py] = point;
	let winding = 0;
	for (const chain of chains) {
		for (const s of yMonotonePieces(chain)) {
			const ay = s[0][1];
			const by = s[s.length - 1][1];
			let dir = 0;
			if (ay <= py && by > py) dir = 1;
			else if (by <= py && ay > py) dir = -1;
			else continue;
			let minX = Infinity;
			let maxX = -Infinity;
			for (const p of s) {
				if (p[0] < minX) minX = p[0];
				if (p[0] > maxX) maxX = p[0];
			}
			if (minX > px) {
				winding += dir;
				continue;
			}
			if (maxX <= px) continue;
			const t = solveMonotone(s, 1, py);
			if (segmentPoint(s, t)[0] > px) winding += dir;
		}
	}
	return winding;
}

/** Whether `point` is inside the filled path (every subpath closed for filling). */
export function pointInBezierPath(input: BezierPathInput, point: Point, fillRule: PolygonFillRule = 'nonzero'): boolean {
	const chains = pathToContours(input).map((c) => closeContour(c, true));
	const w = windingNumber(chains, point);
	return fillRule === 'evenodd' ? (w & 1) === 1 : w !== 0;
}

/** Distance from `point` to the path outline (closing lines of closed subpaths included). */
export function distanceToBezierPath(input: BezierPathInput | readonly BezierContour[], point: Point): number {
	const contours =
		Array.isArray(input) && input.length > 0 && (input[0] as BezierContour).segments
			? (input as readonly BezierContour[])
			: pathToContours(input as BezierPathInput);
	let best = Infinity;
	for (const contour of contours) {
		for (const s of closeContour(contour)) {
			// Skip segments whose control hull is farther than the best distance so far.
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const p of s) {
				minX = Math.min(minX, p[0]);
				minY = Math.min(minY, p[1]);
				maxX = Math.max(maxX, p[0]);
				maxY = Math.max(maxY, p[1]);
			}
			const dx = Math.max(minX - point[0], 0, point[0] - maxX);
			const dy = Math.max(minY - point[1], 0, point[1] - maxY);
			if (Math.hypot(dx, dy) >= best) continue;
			best = Math.min(best, segmentNearest(s, point).distance);
		}
		if (contour.segments.length === 0) continue;
	}
	return best;
}

/** Flattens a closed chain into a polygon ring (for classification only). */
export function flattenChain(segs: readonly BezierSegment[], tolerance: number): Point[] {
	const out: Point[] = [];
	for (const s of segs) {
		if (out.length === 0) out.push(s[0]);
		if (s.length === 2) {
			out.push(s[1]);
			continue;
		}
		let dd = 0;
		for (let i = 0; i + 2 < s.length; i++) {
			dd = Math.max(dd, Math.hypot(s[i][0] - 2 * s[i + 1][0] + s[i + 2][0], s[i][1] - 2 * s[i + 1][1] + s[i + 2][1]));
		}
		const deg = s.length - 1;
		const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((deg * (deg - 1) * dd) / (8 * tolerance)))));
		for (let k = 1; k <= n; k++) out.push(segmentPoint(s, k / n));
	}
	if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
	return out;
}
