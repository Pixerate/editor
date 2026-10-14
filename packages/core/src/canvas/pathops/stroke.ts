/**
 * Offset Path and Outline Stroke on Bézier paths.
 *
 * The stroker offsets every segment by ± half the width (lines exactly, curves by cubic
 * approximations refined until they stay within `tolerance` of the true offset), joins the
 * pieces (miter with a miter limit, round or bevel on the outer side of a turn; through the
 * vertex on the inner side) and adds caps (butt, round, square) to open subpaths. Dashes
 * follow arc length, restart on every subpath and join across the start of a closed
 * subpath. The raw outline overlaps itself, so it is filled with the non-zero rule and
 * normalised with the curve boolean engine.
 *
 * When the stroke is wider than a curve's radius of curvature the inner offset turns inside
 * out and its loops cancel winding, leaving holes that are really covered. Every face of
 * the true result is bounded by the arrangement, so a face is spurious exactly when a point
 * deep inside it is closer to the path than the offset distance (holes when growing,
 * islands when insetting); such faces are dropped.
 *
 * Portions ported from vectorcraft-main/crates/pathops/src/offset.rs,
 * vectorcraft-main/crates/pathops/src/boolean.rs (`try_merge`) and
 * vectorcraft-main/crates/effects/src/stroke/dash.rs (MIT OR Apache-2.0, © ArtCraft Team
 * and contributors). See THIRD_PARTY_NOTICES.md.
 */
import type { Point } from '../types.js';
import type { PolygonFillRule } from '../polygonBoolean.js';
import { fitCubicRun } from '../curveFit.js';
import {
	add,
	closeContour,
	contoursToPath,
	cross,
	dist,
	distanceToBezierPath,
	dot,
	flattenChain,
	pathToContours,
	samePoint,
	scale,
	segmentCurvature,
	segmentLength,
	segmentNearest,
	segmentPoint,
	segmentTangent,
	splitSegment,
	sub,
	trimSegments,
	type BezierContour,
	type BezierPath,
	type BezierPathInput,
	type BezierSegment
} from './bezier.js';
import {
	nestedRingsToPath,
	pathBoolean,
	pathBooleanRings,
	type NestedRing,
	type PathOperandInput,
	type PathOpsOptions
} from './boolean.js';

/** Line join (as SVG `stroke-linejoin`). */
export type StrokeJoin = 'miter' | 'round' | 'bevel';
/** Line cap (as SVG `stroke-linecap`). */
export type StrokeCap = 'butt' | 'round' | 'square';

export interface OutlineStrokeOptions extends PathOpsOptions {
	/** Stroke width. Non-positive or non-finite widths give an empty result. */
	width: number;
	/** Default `miter` (as SVG). */
	join?: StrokeJoin;
	/** Default `butt` (as SVG). */
	cap?: StrokeCap;
	/** Miter length / stroke width above which a miter join is bevelled (default 4, as SVG). */
	miterLimit?: number;
	/** Dash pattern (as SVG `stroke-dasharray`); odd patterns repeat twice. */
	dash?: readonly number[];
	/** Distance into the dash pattern at the start of each subpath (as `stroke-dashoffset`). */
	dashOffset?: number;
	/** Maximum distance between the approximated and the true offset curve (default 0.01). */
	tolerance?: number;
}

export interface OffsetPathOptions extends PathOpsOptions {
	/** Corner style of the grown / shrunk outline (default `miter`). */
	join?: StrokeJoin;
	/** Miter limit (default 4). */
	miterLimit?: number;
	/** Fill rule of the input (default `nonzero`). */
	fillRule?: PolygonFillRule;
	/** Maximum distance between the approximated and the true offset curve (default 0.01). */
	tolerance?: number;
}

const DEFAULT_TOLERANCE = 0.01;

const normal = (t: Point): Point => [-t[1], t[0]];

function raise(seg: BezierSegment): Point[] {
	if (seg.length !== 3) return [...seg];
	const [p0, p1, p2] = seg;
	return [p0, [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])], [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])], p2];
}

function isDegenerate(seg: BezierSegment, tol: number): boolean {
	return seg.every((p) => dist(p, seg[0]) <= tol);
}

// ---------------------------------------------------------------------------
// Offsetting segments
// ---------------------------------------------------------------------------

/** Appends cubic / line approximations of the curve offset by `d` (left in a y-up frame). */
function offsetSegment(seg: BezierSegment, d: number, tol: number, out: Point[][], depth = 0) {
	if (seg.length === 2) {
		const n = normal(segmentTangent(seg, 0));
		out.push([add(seg[0], scale(n, d)), add(seg[1], scale(n, d))]);
		return;
	}
	const c = raise(seg);
	const t0 = segmentTangent(c, 0);
	const t1 = segmentTangent(c, 1);
	const q0 = add(c[0], scale(normal(t0), d));
	const q3 = add(c[3], scale(normal(t1), d));
	const k0 = segmentCurvature(c, 0);
	const k1 = segmentCurvature(c, 1);
	const f0 = Number.isFinite(k0) ? 1 - d * k0 : 1;
	const f1 = Number.isFinite(k1) ? 1 - d * k1 : 1;
	const q1 = add(q0, scale(sub(c[1], c[0]), f0));
	const q2 = add(q3, scale(sub(c[2], c[3]), f1));
	const approx: Point[] = [q0, q1, q2, q3];
	if (depth < 10) {
		let err = 0;
		for (const t of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
			const target = add(segmentPoint(c, t), scale(normal(segmentTangent(c, t)), d));
			err = Math.max(err, segmentNearest(approx, target).distance);
			if (err > tol) break;
		}
		// The approximation must not wander off either: check its midpoint against the curve.
		if (err <= tol) {
			const m = segmentPoint(approx, 0.5);
			const back = segmentNearest(c, m).distance;
			err = Math.max(err, Math.abs(back - Math.abs(d)));
		}
		if (err > tol) {
			const [a, b] = splitSegment(c, 0.5);
			offsetSegment(a, d, tol, out, depth + 1);
			offsetSegment(b, d, tol, out, depth + 1);
			return;
		}
	}
	out.push(approx);
}

/** Appends a circular arc (center, radius, start angle, sweep) as cubics, at most 90° each. */
function pushArc(out: Point[][], center: Point, radius: number, start: number, sweep: number, from: Point, to: Point) {
	const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
	const step = sweep / n;
	const k = (4 / 3) * Math.tan(step / 4);
	let prev = from;
	for (let i = 0; i < n; i++) {
		const a0 = start + step * i;
		const a1 = a0 + step;
		const c0 = Math.cos(a0);
		const s0 = Math.sin(a0);
		const c1 = Math.cos(a1);
		const s1 = Math.sin(a1);
		const end: Point = i === n - 1 ? to : [center[0] + radius * c1, center[1] + radius * s1];
		out.push([
			prev,
			[center[0] + radius * (c0 - k * s0), center[1] + radius * (s0 + k * c0)],
			[center[0] + radius * (c1 + k * s1), center[1] + radius * (s1 - k * c1)],
			end
		]);
		prev = end;
	}
}

function lineTo(out: Point[][], from: Point, to: Point) {
	if (!samePoint(from, to)) out.push([from, to]);
}

interface JoinStyle {
	join: StrokeJoin;
	miterLimit: number;
}

/** Joins the offset at vertex `p` from the incoming tangent `tin` to the outgoing `tout`. */
function addJoin(out: Point[][], p: Point, tin: Point, tout: Point, d: number, style: JoinStyle) {
	const from = add(p, scale(normal(tin), d));
	const to = add(p, scale(normal(tout), d));
	const turn = cross(tin, tout);
	const cos = dot(tin, tout);
	if (Math.abs(turn) < 1e-9 && cos > 0) {
		lineTo(out, from, to);
		return;
	}
	const reversal = Math.abs(turn) < 1e-9 && cos < 0;
	const inner = !reversal && turn > 0 === d > 0;
	if (inner) {
		lineTo(out, from, p);
		lineTo(out, p, to);
		return;
	}
	const theta = reversal ? (d > 0 ? -Math.PI : Math.PI) : Math.atan2(turn, cos);
	if (style.join === 'round') {
		const v = sub(from, p);
		pushArc(out, p, Math.abs(d), Math.atan2(v[1], v[0]), theta, from, to);
		return;
	}
	if (style.join === 'miter' && !reversal) {
		// Miter length / width = 1 / sin(φ / 2), φ the angle between the segments.
		const phi = Math.PI - Math.abs(theta);
		const ratio = 1 / Math.max(Math.sin(phi / 2), 1e-12);
		if (ratio <= style.miterLimit) {
			const nin = normal(tin);
			const nout = normal(tout);
			const s = d / (1 + dot(nin, nout));
			const miter = add(p, scale(add(nin, nout), s));
			lineTo(out, from, miter);
			lineTo(out, miter, to);
			return;
		}
	}
	lineTo(out, from, to);
}

/** One side of a segment chain offset by `d`, with joins; closed chains join their ends too. */
function offsetChain(segs: BezierSegment[], d: number, closed: boolean, style: JoinStyle, tol: number): Point[][] {
	const out: Point[][] = [];
	const pen = () => (out.length > 0 ? out[out.length - 1][out[out.length - 1].length - 1] : null);
	for (let i = 0; i < segs.length; i++) {
		if (i > 0) addJoin(out, segs[i][0], segmentTangent(segs[i - 1], 1), segmentTangent(segs[i], 0), d, style);
		const pieces: Point[][] = [];
		offsetSegment(segs[i], d, tol, pieces);
		for (const piece of pieces) {
			const at = pen();
			if (at && !samePoint(at, piece[0])) lineTo(out, at, piece[0]);
			out.push(piece);
		}
	}
	if (closed && segs.length > 0) {
		const last = segs[segs.length - 1];
		addJoin(out, segs[0][0], segmentTangent(last, 1), segmentTangent(segs[0], 0), d, style);
		const at = pen();
		if (at && out.length > 0 && !samePoint(at, out[0][0])) lineTo(out, at, out[0][0]);
	}
	return out;
}

function reverseChain(chain: Point[][]): Point[][] {
	return chain.map((s) => [...s].reverse()).reverse();
}

function addCap(out: Point[][], p: Point, t: Point, h: number, cap: StrokeCap) {
	// From p + h·n (left) round the end to p − h·n (right), t pointing out of the stroke.
	const n = normal(t);
	const from = add(p, scale(n, h));
	const to = add(p, scale(n, -h));
	if (cap === 'round') {
		pushArc(out, p, h, Math.atan2(n[1], n[0]), -Math.PI, from, to);
	} else if (cap === 'square') {
		const a = add(from, scale(t, h));
		const b = add(to, scale(t, h));
		lineTo(out, from, a);
		lineTo(out, a, b);
		lineTo(out, b, to);
	} else {
		lineTo(out, from, to);
	}
}

/** Closed outline rings painting a dot (zero-length dash or subpath) with a cap. */
function dotRings(p: Point, t: Point, h: number, cap: StrokeCap): Point[][][] {
	if (cap === 'butt') return [];
	const ring: Point[][] = [];
	addCap(ring, p, t, h, cap);
	addCap(ring, p, [-t[0], -t[1]], h, cap);
	return [ring];
}

interface StrokeStyle extends JoinStyle {
	cap: StrokeCap;
}

/** Raw outline rings (overlapping, to be filled with `nonzero`) of one subpath. */
function strokeContour(contour: BezierContour, h: number, style: StrokeStyle, tol: number): Point[][][] {
	const tiny = Math.max(1e-12, tol * 1e-6);
	const all = contour.closed ? closeContour(contour) : contour.segments;
	const segs = all.filter((s) => !isDegenerate(s, tiny));
	if (segs.length === 0) {
		const p = contour.segments[0]?.[0];
		return p ? dotRings(p, [1, 0], h, style.cap) : [];
	}
	if (contour.closed) {
		const left = offsetChain(segs, h, true, style, tol);
		const right = offsetChain(segs, -h, true, style, tol);
		return [left, reverseChain(right)];
	}
	const left = offsetChain(segs, h, false, style, tol);
	const right = reverseChain(offsetChain(segs, -h, false, style, tol));
	const ring: Point[][] = [...left];
	const last = segs[segs.length - 1];
	addCap(ring, last[last.length - 1], segmentTangent(last, 1), h, style.cap);
	const joinTo = (p: Point) => {
		const at = ring[ring.length - 1][ring[ring.length - 1].length - 1];
		lineTo(ring, at, p);
	};
	if (right.length > 0) joinTo(right[0][0]);
	ring.push(...right);
	const first = segs[0];
	const t0 = segmentTangent(first, 0);
	addCap(ring, first[0], [-t0[0], -t0[1]], h, style.cap);
	if (ring.length > 0) joinTo(ring[0][0]);
	return [ring];
}

function ringsToPath(rings: Point[][][]): BezierPath {
	return contoursToPath(rings.filter((r) => r.length > 0).map((segments) => ({ segments, closed: true })));
}

// ---------------------------------------------------------------------------
// Dashes
// ---------------------------------------------------------------------------

/** More dashes than this draws the line solid (a tiny pattern on a long path). */
const MAX_DASHES = 200_000;
const MIN_ENTRY = 1e-6;

export interface DashedPath {
	/** The dashes, as open subpaths. */
	contours: BezierContour[];
	/** Zero-length dashes: where they sit and the path direction there. */
	dots: { point: Point; tangent: Point }[];
}

/**
 * Applies a dash pattern (SVG `stroke-dasharray` / `stroke-dashoffset` semantics) to the
 * subpaths. Returns `null` when the pattern is invalid (negative or non-finite entries),
 * has no positive entry, or would make more than 200,000 dashes: the line is solid.
 */
export function dashContours(contours: readonly BezierContour[], pattern: readonly number[], offset = 0): DashedPath | null {
	if (pattern.length === 0 || pattern.some((v) => !Number.isFinite(v) || v < 0) || !Number.isFinite(offset)) return null;
	if (!pattern.some((v) => v > MIN_ENTRY)) return null;
	const pat = pattern.length % 2 === 1 ? [...pattern, ...pattern] : [...pattern];
	const period = pat.reduce((s, v) => s + v, 0);
	const chains = contours.map((c) => {
		const segs = closeContour(c);
		const lengths = segs.map((s) => segmentLength(s));
		return { segs, lengths, total: lengths.reduce((s, v) => s + v, 0), closed: c.closed };
	});
	const totalLength = chains.reduce((s, c) => s + c.total, 0);
	if ((totalLength / period) * pat.length > MAX_DASHES) return null;
	let off = ((offset % period) + period) % period;
	let ix0 = 0;
	while (off > pat[ix0]) {
		off -= pat[ix0];
		ix0 = (ix0 + 1) % pat.length;
	}
	const out: DashedPath = { contours: [], dots: [] };
	for (const chain of chains) {
		if (chain.segs.length === 0 || !(chain.total > 0)) continue;
		let ix = ix0;
		let rem = pat[ix0] - off;
		let pos = 0;
		const dashes: { from: number; to: number }[] = [];
		let guard = 0;
		while (pos < chain.total && guard++ < MAX_DASHES * 2) {
			const step = Math.min(rem, chain.total - pos);
			const on = ix % 2 === 0;
			if (on) dashes.push({ from: pos, to: pos + step });
			pos += step;
			rem -= step;
			if (rem <= 1e-12) {
				ix = (ix + 1) % pat.length;
				rem = pat[ix];
			}
		}
		// A closed subpath's last dash runs on into its first one.
		if (chain.closed && dashes.length > 1) {
			const first = dashes[0];
			const last = dashes[dashes.length - 1];
			if (first.from <= 1e-9 && last.to >= chain.total - 1e-9 && first.to > first.from && last.to > last.from) {
				dashes.pop();
				const tail = trimSegments(chain.segs, last.from, chain.total, chain.lengths);
				const head = trimSegments(chain.segs, 0, first.to, chain.lengths);
				dashes.shift();
				out.contours.push({ segments: [...tail, ...head], closed: false });
			}
		}
		for (const dash of dashes) {
			if (dash.to - dash.from <= 1e-12) {
				const at = locate(chain.segs, chain.lengths, dash.from);
				out.dots.push(at);
				continue;
			}
			const segments = trimSegments(chain.segs, dash.from, dash.to, chain.lengths);
			if (segments.length > 0) out.contours.push({ segments, closed: false });
		}
	}
	return out;
}

function locate(segs: BezierSegment[], lengths: number[], at: number): { point: Point; tangent: Point } {
	let acc = 0;
	for (let i = 0; i < segs.length; i++) {
		if (at <= acc + lengths[i] || i === segs.length - 1) {
			const piece = trimSegments([segs[i]], 0, Math.max(0, at - acc), [lengths[i]]);
			const t = piece.length > 0 ? 1 : 0;
			const point = piece.length > 0 ? piece[piece.length - 1][piece[piece.length - 1].length - 1] : segs[i][0];
			const tangent = segmentTangent(piece.length > 0 ? piece[piece.length - 1] : segs[i], t);
			return { point, tangent };
		}
		acc += lengths[i];
	}
	return { point: segs[0][0], tangent: segmentTangent(segs[0], 0) };
}

// ---------------------------------------------------------------------------
// Result cleanup
// ---------------------------------------------------------------------------

/** A point deep inside a face (ring plus its direct child rings): the middle of its widest span. */
function deepPoint(rings: BezierSegment[][]): Point | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of rings[0].flat()) {
		minX = Math.min(minX, p[0]);
		maxX = Math.max(maxX, p[0]);
		minY = Math.min(minY, p[1]);
		maxY = Math.max(maxY, p[1]);
	}
	const w = maxX - minX;
	const h = maxY - minY;
	if (!(w > 0 && h > 0)) return null;
	const tolerance = Math.max(1e-6, 0.002 * Math.min(w, h));
	const polys = rings.map((r) => flattenChain(r, tolerance));
	let best: { span: number; p: Point } | null = null;
	for (const f of [0.5, 0.3, 0.7, 0.15, 0.85]) {
		const y = minY + h * f;
		const xs: number[] = [];
		for (const poly of polys) {
			for (let i = 0; i < poly.length; i++) {
				const a = poly[i];
				const b = poly[(i + 1) % poly.length];
				if (a[1] <= y !== b[1] <= y) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
			}
		}
		xs.sort((p, q) => p - q);
		for (let i = 0; i + 1 < xs.length; i += 2) {
			const span = xs[i + 1] - xs[i];
			if (!best || span > best.span) best = { span, p: [(xs[i] + xs[i + 1]) / 2, y] };
		}
	}
	return best?.p ?? null;
}

/** Keeps the faces that `spurious` does not flag (a flagged face drops its descendants too). */
function dropSpurious(rings: NestedRing[], spurious: (face: BezierSegment[][], ring: NestedRing) => boolean): BezierPath {
	const children = rings.map(() => [] as number[]);
	rings.forEach((r, i) => {
		if (r.parent >= 0) children[r.parent].push(i);
	});
	const marked = rings.map((r, i) => spurious([r.segments, ...children[i].map((c) => rings[c].segments)], r));
	const hasMarkedAncestor = (i: number): boolean => {
		for (let k = i; k >= 0; k = rings[k].parent) if (marked[k]) return true;
		return false;
	};
	return nestedRingsToPath(rings, (i) => !hasMarkedAncestor(i));
}

/**
 * Merges runs of tangent-continuous curve segments that one cubic fits within `tolerance`
 * (the stroker's many small offset pieces), keeping corners.
 */
function mergeSmoothRuns(path: BezierPath, tolerance: number): BezierPath {
	const contours = pathToContours(path).map((contour) => {
		const segs = closeContour(contour, true).map((s) => (s.length === 3 ? raise(s) : [...s]));
		const n = segs.length;
		if (n < 2) return { segments: segs, closed: true };
		const smooth = (a: BezierSegment, b: BezierSegment) => {
			if (a.length !== 4 || b.length !== 4) return false;
			const ta = segmentTangent(a, 1);
			const tb = segmentTangent(b, 0);
			return dot(ta, tb) > 0.9998 && Math.abs(cross(ta, tb)) < 0.02;
		};
		let start = 0;
		for (let k = 0; k < n; k++) {
			if (!smooth(segs[(k + n - 1) % n], segs[k])) {
				start = k;
				break;
			}
		}
		const ordered = [...segs.slice(start), ...segs.slice(0, start)];
		const out: BezierSegment[] = [];
		let i = 0;
		while (i < ordered.length) {
			let current = ordered[i];
			let j = i + 1;
			while (j < ordered.length && smooth(ordered[j - 1], ordered[j])) {
				const run = ordered.slice(i, j + 1);
				const pts: Point[] = [];
				run.forEach((s, k) => {
					for (let q = k === 0 ? 0 : 1; q <= 12; q++) pts.push(segmentPoint(s, q / 12));
				});
				const fit = fitCubicRun(pts, tolerance, segmentTangent(run[0], 0), segmentTangent(run[run.length - 1], 1));
				if (fit.length !== 1) break;
				const c = fit[0];
				current = [run[0][0], c.p1, c.p2, run[run.length - 1][3]];
				j++;
			}
			out.push(current);
			i = j;
		}
		return { segments: out, closed: true };
	});
	return contoursToPath(contours);
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

function joinStyle(join: StrokeJoin | undefined, miterLimit: number | undefined): JoinStyle {
	return {
		join: join ?? 'miter',
		miterLimit: miterLimit !== undefined && Number.isFinite(miterLimit) ? Math.max(1, miterLimit) : 4
	};
}

/**
 * The raw (overlapping) outline of a stroke as closed subpaths to fill with `nonzero`.
 * `outlineStroke` normalises it; this is useful for previews.
 */
export function strokeOutlineRings(input: BezierPathInput, options: OutlineStrokeOptions): BezierPath {
	const h = options.width / 2;
	if (!(h > 0) || !Number.isFinite(h)) return [];
	const tol = options.tolerance && options.tolerance > 0 ? options.tolerance : DEFAULT_TOLERANCE;
	const style: StrokeStyle = { ...joinStyle(options.join, options.miterLimit), cap: options.cap ?? 'butt' };
	let contours = pathToContours(input);
	const rings: Point[][][] = [];
	if (options.dash && options.dash.length > 0) {
		const dashed = dashContours(contours, options.dash, options.dashOffset ?? 0);
		if (dashed) {
			contours = dashed.contours;
			for (const dot of dashed.dots) rings.push(...dotRings(dot.point, dot.tangent, h, style.cap));
		}
	}
	for (const contour of contours) rings.push(...strokeContour(contour, h, style, tol));
	return ringsToPath(rings);
}

/**
 * Outline Stroke: the filled area painted by stroking `path`, as one clean path (overlaps
 * removed, consistently oriented). Joins, caps, miter limit and dashes follow SVG.
 */
export function outlineStroke(input: BezierPathInput, options: OutlineStrokeOptions): BezierPath {
	const h = options.width / 2;
	if (!(h > 0) || !Number.isFinite(h)) return [];
	let source: BezierPath;
	try {
		source = contoursToPath(pathToContours(input));
	} catch {
		return [];
	}
	if (source.some((c) => c.type !== 'Z' && Object.values(c).some((v) => typeof v === 'number' && !Number.isFinite(v)))) return [];
	const raw = strokeOutlineRings(source, options);
	if (raw.length === 0) return [];
	const tol = options.tolerance && options.tolerance > 0 ? options.tolerance : DEFAULT_TOLERANCE;
	const sourceContours = pathToContours(source);
	const operand: PathOperandInput = { path: raw, fillRule: 'nonzero' };
	try {
		const rings = pathBooleanRings('union', [operand], options);
		const cleaned = dropSpurious(rings, (face, ring) => {
			if (ring.area >= 0) return false;
			const p = deepPoint(face);
			return !!p && distanceToBezierPath(sourceContours, p) < h * (1 - 1e-4) - 1e-6;
		});
		return mergeSmoothRuns(cleaned, tol);
	} catch {
		return pathBoolean('union', [operand], options).path;
	}
}

/**
 * Offset Path: grows (`distance > 0`) or shrinks (`distance < 0`) the filled area by
 * `distance`. Closed subpaths are a filled region (read with `fillRule`); open subpaths are
 * outlined with a stroke of width `2·|distance|` and butt caps (when growing). Loops of the
 * offset curves are removed.
 */
export function offsetPath(input: BezierPathInput, distance: number, options: OffsetPathOptions = {}): BezierPath {
	if (!Number.isFinite(distance)) return [];
	const contours = pathToContours(input);
	if (contours.some((c) => c.segments.some((s) => s.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))))) return [];
	const closed = contours.filter((c) => c.closed && c.segments.length > 0);
	const open = contours.filter((c) => !c.closed && c.segments.length > 0);
	const fillRule = options.fillRule ?? 'nonzero';
	const fill: PathOperandInput = { path: contoursToPath(closed), fillRule };
	const d = Math.abs(distance);
	const tol = options.tolerance && options.tolerance > 0 ? options.tolerance : DEFAULT_TOLERANCE;
	if (d === 0) return pathBoolean('union', [fill], options).path;
	const strokeOptions: OutlineStrokeOptions = { width: 2 * d, join: options.join ?? 'miter', miterLimit: options.miterLimit, cap: 'butt', tolerance: tol };
	const ring: PathOperandInput = { path: strokeOutlineRings(contoursToPath(closed), strokeOptions), fillRule: 'nonzero' };
	const openRing: PathOperandInput = {
		path: distance > 0 ? strokeOutlineRings(contoursToPath(open), strokeOptions) : [],
		fillRule: 'nonzero'
	};
	const grow = distance > 0;
	const operands = [fill, ring, openRing];
	try {
		const rings = pathBooleanRings(grow ? (m) => m[0] || m[1] || m[2] : (m) => m[0] && !m[1], operands, options);
		const sourceContours = contours;
		const cleaned = dropSpurious(rings, (face, r) => {
			if (grow ? r.area >= 0 : r.area <= 0) return false;
			const p = deepPoint(face);
			return !!p && distanceToBezierPath(sourceContours, p) < d * (1 - 1e-4) - 1e-6;
		});
		return mergeSmoothRuns(cleaned, tol);
	} catch {
		return grow
			? pathBoolean('union', operands, options).path
			: pathBoolean('difference', [fill, ring], options).path;
	}
}
