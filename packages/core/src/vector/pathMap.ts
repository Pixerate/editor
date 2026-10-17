/**
 * Non-affine maps of paths, so shapes stay Bézier paths through Free Distort (a projective map)
 * and envelope warps.
 *
 * - `mapVectorPoints` sends every anchor and handle through the map and keeps the anchors as they
 *   are. Under a projective map straight segments stay exactly straight; a curve keeps its exact
 *   end tangents and approximates the (rational) image between.
 * - `mapVectorSubpaths` follows any smooth map: each segment is halved until its mapped control
 *   points follow the mapped curve within a tolerance, so the result gains anchors where the map
 *   bends it. Runs of pieces are then refitted with fewer cubics (`fitCubicRun`) where that stays
 *   within the tolerance.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): photocraft `crates/vector/src/map.rs` (`map_points`, `map_path`,
 * `map_subpath`, `map_segment`, `split_mapped`, `halves`, `off_line`).
 */
import { fitCubicRun, type CubicSegment } from '../canvas/curveFit.js';
import { segmentNearest, type BezierPath, type BezierPathInput } from '../canvas/pathops/bezier.js';
import { bezierToSubpaths, subpathsToBezier } from './geometry.js';
import type { Vec2, VectorAnchor, VectorSubpath } from './types.js';

/** A map of the plane (document or node space). */
export type VectorPointMap = (p: Vec2) => Vec2;

type Cubic = [Vec2, Vec2, Vec2, Vec2];

/** Pieces a path may be split into in total: bounds the work on hostile input. */
const MAX_PIECES = 1 << 20;
/** Deepest split of one segment (2^6 = 64 pieces). */
const MAX_DEPTH = 6;
const PROBES = [0.25, 0.5, 0.75];

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

function evalCubic(s: Cubic, t: number): Vec2 {
	const ab = lerp(s[0], s[1], t);
	const bc = lerp(s[1], s[2], t);
	const cd = lerp(s[2], s[3], t);
	return lerp(lerp(ab, bc, t), lerp(bc, cd, t), t);
}

/** De Casteljau split at t = ½. */
function halves(s: Cubic): [Cubic, Cubic] {
	const ab = lerp(s[0], s[1], 0.5);
	const bc = lerp(s[1], s[2], 0.5);
	const cd = lerp(s[2], s[3], 0.5);
	const abc = lerp(ab, bc, 0.5);
	const bcd = lerp(bc, cd, 0.5);
	const m = lerp(abc, bcd, 0.5);
	return [
		[s[0], ab, abc, m],
		[m, bcd, cd, s[3]]
	];
}

/** Distance from `p` to the line through `a` and `b` (to `a` when they coincide). */
function offLine(p: Vec2, a: Vec2, b: Vec2): number {
	const l = dist(a, b);
	return l < 1e-12 ? dist(p, a) : Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / l;
}

const mapAnchorPoints = (a: VectorAnchor, f: VectorPointMap): VectorAnchor => {
	const p = f(a);
	return {
		x: p.x,
		y: p.y,
		...(a.in ? { in: f(a.in) } : {}),
		...(a.out ? { out: f(a.out) } : {}),
		...(a.type && a.type !== 'corner' ? { type: a.type } : {}),
		...(a.corner ? { corner: { ...a.corner } } : {})
	};
};

/** Every anchor and handle of `subpaths` through `f` (no subdivision). */
export function mapVectorPoints(subpaths: readonly VectorSubpath[], f: VectorPointMap): VectorSubpath[] {
	return subpaths.map((sp) => ({ closed: sp.closed, anchors: sp.anchors.map((a) => mapAnchorPoints(a, f)) }));
}

function splitMapped(seg: Cubic, f: VectorPointMap, tol: number, depth: number, out: Cubic[]) {
	const mapped = seg.map(f) as Cubic;
	const fits = PROBES.every((t) => dist(f(evalCubic(seg, t)), evalCubic(mapped, t)) <= tol);
	if (fits || depth === 0) {
		out.push(mapped);
		return;
	}
	const [a, b] = halves(seg);
	splitMapped(a, f, tol, depth - 1, out);
	splitMapped(b, f, tol, depth - 1, out);
}

const toPoint = (p: Vec2): [number, number] => [p.x, p.y];
const toVec = (p: readonly number[]): Vec2 => ({ x: p[0], y: p[1] });

/**
 * The image of `seg` through `f` as fewer cubics than `pieces` when they stay within `tol` of it
 * (fitted to samples of the mapped curve with the pieces' end tangents), else `pieces`.
 */
function refit(seg: Cubic, pieces: Cubic[], f: VectorPointMap, tol: number): Cubic[] {
	if (pieces.length < 3) return pieces;
	const n = pieces.length * 4;
	const samples: [number, number][] = [];
	for (let i = 0; i <= n; i++) samples.push(toPoint(f(evalCubic(seg, i / n))));
	const first = pieces[0];
	const last = pieces[pieces.length - 1];
	const t0 = !same(first[1], first[0]) ? first[1] : first[2];
	const t1 = !same(last[2], last[3]) ? last[2] : last[1];
	const fitted: CubicSegment[] = fitCubicRun(samples, tol / 2, [t0.x - first[0].x, t0.y - first[0].y], [last[3].x - t1.x, last[3].y - t1.y]);
	if (!fitted.length || fitted.length >= pieces.length) return pieces;
	// Check between the fitted samples too.
	const chain = fitted.map((c) => [c.p0, c.p1, c.p2, c.p3]);
	for (let i = 0; i < n; i++) {
		const q = toPoint(f(evalCubic(seg, (i + 0.5) / n)));
		let best = Infinity;
		for (const c of chain) best = Math.min(best, segmentNearest(c, q).distance);
		if (best > tol) return pieces;
	}
	return fitted.map((c) => [toVec(c.p0), toVec(c.p1), toVec(c.p2), toVec(c.p3)]);
}

function mapSegment(seg: Cubic, f: VectorPointMap, tol: number, depth: number, fit: boolean): Cubic[] {
	// A straight segment whose image is straight stays one.
	if (same(seg[1], seg[0]) && same(seg[2], seg[3])) {
		const a = f(seg[0]);
		const b = f(seg[3]);
		if (PROBES.every((t) => offLine(f(lerp(seg[0], seg[3], t)), a, b) <= tol)) return [[a, a, b, b]];
		// Bent by the map: the same line as an evenly parametrised cubic, then split.
		const line: Cubic = [seg[0], lerp(seg[0], seg[3], 1 / 3), lerp(seg[0], seg[3], 2 / 3), seg[3]];
		const out: Cubic[] = [];
		splitMapped(line, f, tol, depth, out);
		return fit ? refit(line, out, f, tol) : out;
	}
	const out: Cubic[] = [];
	splitMapped(seg, f, tol, depth, out);
	return fit ? refit(seg, out, f, tol) : out;
}

/** Makes a smooth anchor's handles collinear again (a curved map can kink them slightly), keeping their lengths. */
function realign(a: VectorAnchor): VectorAnchor {
	if (!a.in || !a.out || same(a.in, a) || same(a.out, a)) return a;
	const li = dist(a.in, a);
	const lo = dist(a.out, a);
	const dx = (a.x - a.in.x) / li + (a.out.x - a.x) / lo;
	const dy = (a.y - a.in.y) / li + (a.out.y - a.y) / lo;
	const l = Math.hypot(dx, dy);
	if (l < 1e-12) return a;
	const u = { x: dx / l, y: dy / l };
	const type = a.type === 'symmetric' && Math.abs(li - lo) > 1e-6 * Math.max(li, lo) ? 'smooth' : a.type;
	return { ...a, in: { x: a.x - u.x * li, y: a.y - u.y * li }, out: { x: a.x + u.x * lo, y: a.y + u.y * lo }, ...(type ? { type } : {}) };
}

const segmentOf = (sp: VectorSubpath, i: number): Cubic => {
	const a = sp.anchors[i];
	const b = sp.anchors[(i + 1) % sp.anchors.length];
	return [{ x: a.x, y: a.y }, a.out ?? { x: a.x, y: a.y }, b.in ?? { x: b.x, y: b.y }, { x: b.x, y: b.y }];
};

function mapSubpath(sp: VectorSubpath, f: VectorPointMap, tol: number, depth: number, fit: boolean): VectorSubpath {
	const n = sp.anchors.length;
	const count = n < 2 ? 0 : sp.closed ? n : n - 1;
	if (!count) return mapVectorPoints([sp], f)[0];
	const pieces: Cubic[][] = [];
	for (let i = 0; i < count; i++) pieces.push(mapSegment(segmentOf(sp, i), f, tol, depth, fit));
	const anchors: VectorAnchor[] = [];
	const put = (a: VectorAnchor) => {
		if (a.in && same(a.in, a)) delete a.in;
		if (a.out && same(a.out, a)) delete a.out;
		anchors.push(a.type === 'smooth' || a.type === 'symmetric' ? realign(a) : a);
	};
	sp.anchors.forEach((k, i) => {
		const incoming = i > 0 ? pieces[i - 1] : sp.closed ? pieces[n - 1] : undefined;
		const outgoing = pieces[i];
		const p = f(k);
		const a: VectorAnchor = { x: p.x, y: p.y };
		const inCtrl = incoming ? incoming[incoming.length - 1][2] : k.in ? f(k.in) : null;
		const outCtrl = outgoing ? outgoing[0][1] : k.out ? f(k.out) : null;
		if (inCtrl) a.in = inCtrl;
		if (outCtrl) a.out = outCtrl;
		if (k.type && k.type !== 'corner') a.type = k.type;
		if (k.corner) a.corner = { ...k.corner };
		put(a);
		// The anchors a split added inside segment i: smooth, as the curve runs through them.
		if (outgoing) for (let w = 1; w < outgoing.length; w++) put({ x: outgoing[w][0].x, y: outgoing[w][0].y, in: outgoing[w - 1][2], out: outgoing[w][1], type: 'smooth' });
	});
	return { closed: sp.closed, anchors };
}

export interface MapVectorSubpathsOptions {
	/** Refit runs of split pieces with fewer cubics where they stay within the tolerance (default true). */
	refit?: boolean;
}

/**
 * `subpaths` through a smooth, possibly non-linear map `f`: each segment is split in halves until
 * its mapped control points follow the mapped curve within `tolerance` (at most 64 pieces a
 * segment, fewer for huge paths), then refitted with fewer cubics where possible. A straight
 * segment whose image is straight stays a straight segment; anchors keep their types and live
 * corners, and the anchors added are smooth.
 */
export function mapVectorSubpaths(subpaths: readonly VectorSubpath[], f: VectorPointMap, tolerance = 0.1, options: MapVectorSubpathsOptions = {}): VectorSubpath[] {
	const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0.1;
	const segments = subpaths.reduce((s, sp) => s + sp.anchors.length, 0);
	let depth = MAX_DEPTH;
	while (depth > 0 && segments * 2 ** depth > MAX_PIECES) depth--;
	return subpaths.map((sp) => mapSubpath(sp, f, tol, depth, options.refit !== false));
}

/** `mapVectorSubpaths` for Bézier commands (live corners are not involved). */
export function mapBezierPath(path: BezierPathInput, f: VectorPointMap, tolerance = 0.1, options: MapVectorSubpathsOptions = {}): BezierPath {
	return subpathsToBezier(mapVectorSubpaths(bezierToSubpaths(path), f, tolerance, options), { corners: false });
}
