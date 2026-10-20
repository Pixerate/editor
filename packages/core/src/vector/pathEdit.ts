/**
 * Path editing on subpaths in a node's own space: anchor deletion that keeps the shape,
 * segment bending, Curvature-tool anchor moves, cutting at anchors (Scissors), Join, Average,
 * Remove Redundant Points and Smooth.
 *
 * Portions ported from (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md):
 * - vectorcraft-main/crates/pathops/src/edit.rs (`remove_anchor`, `golden_min`, `smooth`,
 *   `remove_redundant_points`, `merge_pair`, `average`, `join`)
 * - vectorcraft-main/crates/geom/src/path.rs (`SubPath::cut_at`)
 * - vectorcraft-main/crates/tools/src/draw2/curvature.rs (`curvature_move`)
 * - figcraft-main/crates/engine/src/vectoredit/ops.rs (`bend`)
 */
import type { Point } from '../canvas/types.js';
import { fitCubicWithTangents } from '../canvas/curveFit.js';
import { segmentPoint } from '../canvas/pathops/bezier.js';
import { cloneAnchor, inferAnchorType, insertAnchor, moveAnchorHandle, subpathSegment, subpathSegmentCount } from './geometry.js';
import type { VectorAnchor, VectorSubpath, Vec2 } from './types.js';

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const unit = (x: number, y: number): Point | null => {
	const l = Math.hypot(x, y);
	return l > 1e-12 && Number.isFinite(l) ? [x / l, y / l] : null;
};

/** Segment `i` as four control points (a line has its controls at the thirds of its chord). */
function cubicOf(sp: VectorSubpath, i: number): Point[] {
	const s = subpathSegment(sp, i);
	if (s.length === 4) return s;
	const [a, b] = s;
	return [a, [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3], [a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3], b];
}

const isLine = (sp: VectorSubpath, i: number) => subpathSegment(sp, i).length === 2;

/** Direction the curve leaves `c[0]`. */
function startTangent(c: readonly Point[]): Point {
	for (let k = 1; k < 4; k++) {
		const u = unit(c[k][0] - c[0][0], c[k][1] - c[0][1]);
		if (u) return u;
	}
	return [1, 0];
}

/** Direction the curve arrives at `c[3]` (forward along the curve). */
function endTangent(c: readonly Point[]): Point {
	for (let k = 2; k >= 0; k--) {
		const u = unit(c[3][0] - c[k][0], c[3][1] - c[k][1]);
		if (u) return u;
	}
	return [1, 0];
}

/** `n + 1` points of a cubic at even parameters (`withStart` false skips the first). */
function sample(c: readonly Point[], n: number, out: Point[], withStart: boolean) {
	for (let i = withStart ? 0 : 1; i <= n; i++) out.push(segmentPoint(c, i / n));
}

const onAnchor = (a: VectorAnchor, h: Vec2 | null | undefined) => !h || (Math.abs(h.x - a.x) < EPS && Math.abs(h.y - a.y) < EPS);

/** Drops handles that sit on their anchor and sets the type the handles show (a symmetric pair that is no longer equal becomes smooth). */
function tidy(a: VectorAnchor, keepType = true): VectorAnchor {
	const next = cloneAnchor(a);
	if (onAnchor(next, next.in)) delete next.in;
	if (onAnchor(next, next.out)) delete next.out;
	const shown = inferAnchorType(next);
	const type = keepType && a.type ? (a.type === 'symmetric' && shown !== 'symmetric' ? (shown === 'corner' ? 'corner' : 'smooth') : a.type === 'smooth' && shown === 'corner' ? 'corner' : a.type) : shown;
	if (type === 'corner') delete next.type;
	else next.type = type;
	return next;
}

/** Index of the anchor before / after `i` (round the start of a closed subpath), or -1. */
function neighbours(sp: VectorSubpath, i: number): [number, number] {
	const n = sp.anchors.length;
	const wrap = sp.closed && n > 1;
	return [i > 0 ? i - 1 : wrap ? n - 1 : -1, i < n - 1 ? i + 1 : wrap ? 0 : -1];
}

// ---------------------------------------------------------------------------
// Deleting anchors without changing the shape
// ---------------------------------------------------------------------------

/**
 * The value of `f` with the least error for an argument in [a, b], by a golden-section search
 * (a fixed number of steps). An error that is not a number never wins.
 */
function goldenMin<T extends { error: number }>(f: (x: number) => T, a: number, b: number): T {
	const R = 0.618033988749895;
	let x1 = b - R * (b - a);
	let x2 = a + R * (b - a);
	let f1 = f(x1);
	let f2 = f(x2);
	for (let i = 0; i < 40; i++) {
		if (f1.error < f2.error || Number.isNaN(f2.error)) {
			b = x2;
			x2 = x1;
			f2 = f1;
			x1 = b - R * (b - a);
			f1 = f(x1);
		} else {
			a = x1;
			x1 = x2;
			f1 = f2;
			x2 = a + R * (b - a);
			f2 = f(x2);
		}
	}
	return f1.error <= f2.error ? f1 : f2;
}

/**
 * One cubic through `pts`: `N + 1` samples of a left curve then `N` of a right one. The new
 * curve passes their joint at some parameter k: the left samples sit at k·i/N, the right ones
 * at k + (1 − k)·i/N. Searches k for the closest fit.
 */
function fitAcross(pts: Point[], N: number, t0: Point, t1: Point) {
	const fit = (k: number) => {
		const u: number[] = [];
		for (let i = 0; i <= N; i++) u.push((k * i) / N);
		for (let i = 1; i <= N; i++) u.push(k + ((1 - k) * i) / N);
		return fitCubicWithTangents(pts, u, t0, t1);
	};
	return goldenMin(fit, 0, 1);
}

/**
 * Removes anchor `index` without opening the path: its neighbours keep their handle directions
 * and their facing handles are refitted so one cubic follows the two segments that met there
 * as closely as possible (least maximum error over where the new curve passes the removed
 * point). Two straight segments become one; removing an end of an open subpath drops its
 * segment. Returns the subpath unchanged (a copy) when `index` is out of range.
 */
export function removeAnchorKeepingShape(sp: VectorSubpath, index: number): VectorSubpath {
	const anchors = sp.anchors.map(cloneAnchor);
	const n = anchors.length;
	if (index < 0 || index >= n) return { anchors, closed: sp.closed };
	if ((sp.closed || (index > 0 && index < n - 1)) && n >= 3) {
		const pi = (index + n - 1) % n;
		const ni = (index + 1) % n;
		if (!(isLine(sp, pi) && isLine(sp, index))) {
			const left = cubicOf(sp, pi);
			const right = cubicOf(sp, index);
			const N = 16;
			const pts: Point[] = [];
			sample(left, N, pts, true);
			sample(right, N, pts, false);
			const t0 = startTangent(left);
			const t1 = endTangent(right);
			const { curve } = fitAcross(pts, N, t0, t1);
			if ([curve.p1, curve.p2].every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
				anchors[pi] = tidy({ ...anchors[pi], out: { x: curve.p1[0], y: curve.p1[1] } });
				anchors[ni] = tidy({ ...anchors[ni], in: { x: curve.p2[0], y: curve.p2[1] } });
			}
		}
	}
	anchors.splice(index, 1);
	let closed = sp.closed;
	if (!closed && anchors.length) {
		// A new end has nothing beyond it.
		anchors[0] = tidy({ ...anchors[0], in: null });
		const last = anchors.length - 1;
		anchors[last] = tidy({ ...anchors[last], out: null });
	}
	if (anchors.length < 3) closed = closed && anchors.length === 2 && anchors.some((a) => a.in || a.out);
	return { anchors, closed };
}

/** Removes several anchors of a subpath, keeping the shape (see `removeAnchorKeepingShape`). */
export function removeAnchorsKeepingShape(sp: VectorSubpath, indices: readonly number[]): VectorSubpath {
	const order = [...new Set(indices)].filter((i) => i >= 0 && i < sp.anchors.length).sort((a, b) => b - a);
	return order.reduce((acc, i) => removeAnchorKeepingShape(acc, i), { anchors: sp.anchors.map(cloneAnchor), closed: sp.closed });
}

// ---------------------------------------------------------------------------
// Bending a segment
// ---------------------------------------------------------------------------

/**
 * Bends segment `segment` so the curve passes through `p` at parameter `t` (clamped to
 * 0.05–0.95): its handles go to the thirds of the chord plus one shared offset, so
 * `B(t) = L(t) + 3t(1 − t)·offset` exactly. The end anchors keep their types (a smooth or
 * symmetric end turns its other handle to stay in line).
 */
export function bendSegment(sp: VectorSubpath, segment: number, t: number, p: Vec2): VectorSubpath {
	const anchors = sp.anchors.map(cloneAnchor);
	const n = anchors.length;
	if (segment < 0 || segment >= subpathSegmentCount(sp) || !Number.isFinite(t) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return { anchors, closed: sp.closed };
	const tc = Math.min(0.95, Math.max(0.05, t));
	const ia = segment;
	const ib = (segment + 1) % n;
	const a = anchors[ia];
	const b = anchors[ib];
	const k = 3 * tc * (1 - tc);
	const ox = (p.x - (a.x + (b.x - a.x) * tc)) / k;
	const oy = (p.y - (a.y + (b.y - a.y) * tc)) / k;
	const c1 = { x: a.x + (b.x - a.x) / 3 + ox, y: a.y + (b.y - a.y) / 3 + oy };
	const c2 = { x: b.x + (a.x - b.x) / 3 + ox, y: b.y + (a.y - b.y) / 3 + oy };
	anchors[ia] = moveAnchorHandle(a, 'out', c1);
	anchors[ib] = moveAnchorHandle(b, 'in', c2);
	return { anchors, closed: sp.closed };
}

/** The point at parameter `t` of segment `segment` (for tests and previews). */
export function subpathPointAt(sp: VectorSubpath, segment: number, t: number): Vec2 {
	const [x, y] = segmentPoint(subpathSegment(sp, segment), t);
	return { x, y };
}

// ---------------------------------------------------------------------------
// Curvature-tool anchor move
// ---------------------------------------------------------------------------

/**
 * Moves anchor `index` to `q` the way the Curvature tool drags a point: only the two segments
 * at it change. A smooth or symmetric anchor turns its handles along the line through its
 * neighbours; the neighbours' handles on those segments, and a corner's own handles, keep
 * their directions while their lengths scale with their segment's chord, so the segments
 * beyond don't move and a corner without handles keeps none.
 */
export function curvatureMoveAnchor(sp: VectorSubpath, index: number, q: Vec2): VectorSubpath {
	const anchors = sp.anchors.map(cloneAnchor);
	const a = sp.anchors[index];
	if (!a) return { anchors, closed: sp.closed };
	const own: [Vec2 | null, Vec2 | null] = [
		a.in && !onAnchor(a, a.in) ? { x: a.in.x - a.x, y: a.in.y - a.y } : null,
		a.out && !onAnchor(a, a.out) ? { x: a.out.x - a.x, y: a.out.y - a.y } : null
	];
	const ends: [Vec2 | null, Vec2 | null] = [null, null];
	neighbours(sp, index).forEach((j, side) => {
		if (j < 0 || j === index) return;
		const b = anchors[j];
		const old = Math.hypot(a.x - b.x, a.y - b.y);
		const s = old > 1e-9 ? Math.hypot(q.x - b.x, q.y - b.y) / old : 1;
		const key = side === 0 ? 'out' : 'in';
		const h = b[key];
		if (h) b[key] = { x: b.x + (h.x - b.x) * s, y: b.y + (h.y - b.y) * s };
		const o = own[side];
		if (o) own[side] = { x: o.x * s, y: o.y * s };
		ends[side] = { x: b.x, y: b.y };
	});
	const moved: VectorAnchor = { x: q.x, y: q.y };
	if (own[0]) moved.in = { x: q.x + own[0].x, y: q.y + own[0].y };
	if (own[1]) moved.out = { x: q.x + own[1].x, y: q.y + own[1].y };
	if (a.type) moved.type = a.type;
	if (a.corner) moved.corner = { ...a.corner };
	if (a.id) moved.id = a.id;
	const [prev, next] = ends;
	if (a.type && a.type !== 'corner' && prev && next) {
		const dx = next.x - prev.x;
		const dy = next.y - prev.y;
		const l = Math.hypot(dx, dy);
		if (l > 1e-9) {
			// A handle it lacks comes out a third of the way to that side's neighbour.
			const len = (h: Vec2 | null, to: Vec2) => (h ? Math.hypot(h.x, h.y) : Math.hypot(q.x - to.x, q.y - to.y) / 3);
			let li = len(own[0], prev);
			let lo = len(own[1], next);
			if (a.type === 'symmetric') li = lo = (li + lo) / 2;
			moved.in = { x: q.x - (dx * li) / l, y: q.y - (dy * li) / l };
			moved.out = { x: q.x + (dx * lo) / l, y: q.y + (dy * lo) / l };
		}
	}
	anchors[index] = moved;
	return { anchors, closed: sp.closed };
}

// ---------------------------------------------------------------------------
// Scissors
// ---------------------------------------------------------------------------

/**
 * Cuts a subpath at the anchors `at`: each becomes the end of one open piece and the start of
 * the next, its handle off each piece dropped (the shape doesn't change). A closed subpath
 * opens at its first cut, so one cut leaves one piece whose ends coincide. The ends of an open
 * subpath and indices out of range don't cut; with no cut left the subpath comes back as it is.
 */
export function cutSubpathAt(sp: VectorSubpath, at: readonly number[]): VectorSubpath[] {
	const n = sp.anchors.length;
	const cuts = [...new Set(at)].filter((i) => Number.isInteger(i) && i >= 0 && i < n && (sp.closed || (i > 0 && i < n - 1))).sort((a, b) => a - b);
	if (!cuts.length || n < 2) return [{ anchors: sp.anchors.map(cloneAnchor), closed: sp.closed }];
	const first = cuts[0];
	// A closed subpath's anchors from the first cut round to it again; an open one's as they are.
	const run = sp.closed ? Array.from({ length: n + 1 }, (_, i) => sp.anchors[(first + i) % n]) : sp.anchors;
	const cutSet = new Set(sp.closed ? [...cuts.map((c) => (c - first + n) % n), n] : cuts);
	const pieces: VectorSubpath[] = [];
	let cur: VectorAnchor[] = [];
	run.forEach((a, i) => {
		if (!cutSet.has(i)) {
			cur.push(cloneAnchor(a));
			return;
		}
		if (cur.length) {
			cur.push(tidy({ ...a, out: null }, false));
			pieces.push({ anchors: cur, closed: false });
			cur = [];
		}
		if (i < n) cur.push(tidy({ ...a, in: null }, false));
	});
	if (cur.length > 1) pieces.push({ anchors: cur, closed: false });
	return pieces;
}

/**
 * Cuts a subpath at parameter `t` of segment `segment` (Scissors on a segment): an anchor is
 * inserted there without changing the shape, then cut. Within `endTolerance` of the segment's
 * ends (in parameter) the existing anchor is cut instead.
 */
export function splitSubpathAt(sp: VectorSubpath, segment: number, t: number, endTolerance = 1e-6): VectorSubpath[] {
	const n = sp.anchors.length;
	if (segment < 0 || segment >= subpathSegmentCount(sp)) return [{ anchors: sp.anchors.map(cloneAnchor), closed: sp.closed }];
	if (t <= endTolerance) return cutSubpathAt(sp, [segment]);
	if (t >= 1 - endTolerance) return cutSubpathAt(sp, [(segment + 1) % n]);
	const { subpath, index } = insertAnchor(sp, segment, t);
	return cutSubpathAt(subpath, [index]);
}

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

const endOf = (sp: VectorSubpath, last: boolean): VectorAnchor => sp.anchors[last ? sp.anchors.length - 1 : 0];
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function reverse(sp: VectorSubpath): VectorSubpath {
	return {
		closed: sp.closed,
		anchors: sp.anchors
			.slice()
			.reverse()
			.map((a) => {
				const next: VectorAnchor = { x: a.x, y: a.y };
				if (a.out) next.in = { ...a.out };
				if (a.in) next.out = { ...a.in };
				if (a.type) next.type = a.type;
				if (a.corner) next.corner = { ...a.corner };
				if (a.id) next.id = a.id;
				return next;
			})
	};
}

/**
 * Join: open subpaths are joined nearest-endpoints-first into one open subpath (endpoints
 * within `tolerance` merge into one anchor, otherwise a straight segment connects them). A
 * single open subpath is closed instead (its ends merged when they meet). Closed subpaths and
 * lone anchors pass through unchanged, before the joined one.
 */
export function joinSubpaths(subpaths: readonly VectorSubpath[], tolerance: number): VectorSubpath[] {
	const closed: VectorSubpath[] = [];
	let open: VectorSubpath[] = [];
	for (const sp of subpaths) {
		const copy = { anchors: sp.anchors.map(cloneAnchor), closed: sp.closed };
		if (sp.closed || sp.anchors.length < 2) {
			if (sp.anchors.length) closed.push(copy);
		} else open.push(copy);
	}
	if (open.length === 1) {
		const sp = open[0];
		const first = sp.anchors[0];
		const last = sp.anchors[sp.anchors.length - 1];
		if (sp.anchors.length > 2 && dist(first, last) <= tolerance) {
			sp.anchors.pop();
			sp.anchors[0] = tidy({ ...first, in: last.in ?? null }, false);
		} else {
			sp.anchors[0] = tidy({ ...first, in: null }, false);
			sp.anchors[sp.anchors.length - 1] = tidy({ ...sp.anchors[sp.anchors.length - 1], out: null }, false);
		}
		sp.closed = true;
		return [...closed, sp];
	}
	while (open.length > 1) {
		// The closest pair of endpoints on different subpaths.
		let best = { d: Infinity, i: 0, j: 1, ei: true, ej: false };
		for (let i = 0; i < open.length; i++) {
			for (let j = i + 1; j < open.length; j++) {
				for (const ei of [false, true]) {
					for (const ej of [false, true]) {
						const d = dist(endOf(open[i], ei), endOf(open[j], ej));
						if (d < best.d) best = { d, i, j, ei, ej };
					}
				}
			}
		}
		let a = open[best.i];
		let b = open[best.j];
		open = open.filter((_, k) => k !== best.j);
		// `a` ends at the meeting point, `b` starts there.
		if (!best.ei) a = reverse(a);
		if (best.ej) b = reverse(b);
		const anchors = a.anchors;
		if (best.d <= tolerance) {
			const [head, ...rest] = b.anchors;
			const l = anchors[anchors.length - 1];
			anchors[anchors.length - 1] = tidy({ ...l, out: head.out ?? null }, false);
			anchors.push(...rest);
		} else {
			const l = anchors[anchors.length - 1];
			anchors[anchors.length - 1] = tidy({ ...l, out: null }, false);
			anchors.push(tidy({ ...b.anchors[0], in: null }, false), ...b.anchors.slice(1));
		}
		open[best.i > best.j ? best.i - 1 : best.i] = { anchors, closed: false };
	}
	return [...closed, ...open];
}

// ---------------------------------------------------------------------------
// Smooth and Remove Redundant Points
// ---------------------------------------------------------------------------

/**
 * Smooth: pulls handles towards Catmull-Rom-like tangents (a third of the way to each
 * neighbour along the line through both). `amount` 0–1 (0 = unchanged, 1 = fully smooth).
 * Only the anchors in `only` change when it is given; endpoints of open subpaths keep their
 * handles. Subpaths of fewer than three anchors are unchanged.
 */
export function smoothSubpath(sp: VectorSubpath, amount = 1, only?: ReadonlySet<number>): VectorSubpath {
	const t = Math.min(1, Math.max(0, amount));
	const orig = sp.anchors;
	const n = orig.length;
	const anchors = orig.map(cloneAnchor);
	if (n < 3 || t === 0) return { anchors, closed: sp.closed };
	for (let i = 0; i < n; i++) {
		if (!sp.closed && (i === 0 || i === n - 1)) continue;
		if (only && !only.has(i)) continue;
		const prev = orig[(i + n - 1) % n];
		const next = orig[(i + 1) % n];
		const p = orig[i];
		const dir = unit(next.x - prev.x, next.y - prev.y);
		if (!dir) continue;
		const li = dist(p, prev) / 3;
		const lo = dist(p, next) / 3;
		const hin = p.in ?? p;
		const hout = p.out ?? p;
		const target = (h: Vec2, x: number, y: number) => ({ x: h.x + (x - h.x) * t, y: h.y + (y - h.y) * t });
		anchors[i] = tidy(
			{
				x: p.x,
				y: p.y,
				in: target(hin, p.x - dir[0] * li, p.y - dir[1] * li),
				out: target(hout, p.x + dir[0] * lo, p.y + dir[1] * lo)
			},
			false
		);
	}
	return { anchors, closed: sp.closed };
}

interface Seg {
	c: Point[];
	line: boolean;
}

function segsOf(sp: VectorSubpath): Seg[] {
	const out: Seg[] = [];
	for (let i = 0; i < subpathSegmentCount(sp); i++) {
		const s = subpathSegment(sp, i);
		out.push(s.length === 2 ? { c: s, line: true } : { c: s, line: false });
	}
	return out;
}

/** A subpath from consecutive segments (anchor types inferred; original types kept where they still hold). */
function segsToSubpath(segs: readonly Seg[], closed: boolean, types: Map<string, VectorAnchor['type']>): VectorSubpath | null {
	if (!segs.length) return null;
	const anchors: VectorAnchor[] = [];
	const at = (p: Point): VectorAnchor => ({ x: p[0], y: p[1] });
	anchors.push(at(segs[0].c[0]));
	for (const s of segs) {
		const end = s.c[s.c.length - 1];
		if (!s.line) anchors[anchors.length - 1].out = { x: s.c[1][0], y: s.c[1][1] };
		const next = at(end);
		if (!s.line) next.in = { x: s.c[2][0], y: s.c[2][1] };
		anchors.push(next);
	}
	if (closed) {
		const last = anchors.pop()!;
		if (last.in) anchors[0].in = last.in;
	}
	const typed = anchors.map((a) => {
		const type = types.get(`${a.x},${a.y}`);
		return tidy(type ? { ...a, type } : a, !!type);
	});
	return { anchors: typed, closed };
}

const isZeroSeg = (s: Seg) => s.c.every((p) => Math.abs(p[0] - s.c[0][0]) < 1e-9 && Math.abs(p[1] - s.c[0][1]) < 1e-9);

/** One segment replacing `a` then `b` within `tol`, or null. */
function mergePair(a: Seg, b: Seg, tol: number): Seg | null {
	const a0 = a.c[0];
	const a3 = a.c[a.c.length - 1];
	const b3 = b.c[b.c.length - 1];
	if (a.line && b.line) {
		const cx = b3[0] - a0[0];
		const cy = b3[1] - a0[1];
		const len = Math.hypot(cx, cy);
		if (len < 1e-12) return null;
		const mx = a3[0] - a0[0];
		const my = a3[1] - a0[1];
		const along = (mx * cx + my * cy) / len;
		return Math.abs((mx * cy - my * cx) / len) <= tol && along >= 0 && along <= len ? { c: [a0, b3], line: true } : null;
	}
	const ca = a.line ? [a0, a0, a3, a3] : a.c;
	const cb = b.line ? [a3, a3, b3, b3] : b.c;
	const ta = endTangent(ca);
	const tb = startTangent(cb);
	// Only merge across (near-)smooth joints.
	if (ta[0] * tb[0] + ta[1] * tb[1] < 0.99) return null;
	const pts: Point[] = [];
	sample(ca, 16, pts, true);
	sample(cb, 16, pts, false);
	const { curve, error } = fitAcross(pts, 16, startTangent(ca), endTangent(cb));
	return error <= tol ? { c: [curve.p0, curve.p1, curve.p2, curve.p3], line: false } : null;
}

/**
 * Remove Redundant Points: drops anchors that can go without changing the shape by more than
 * `tolerance` (collinear corners, duplicate points, and smooth joints that one cubic can
 * replace).
 */
export function removeRedundantPoints(sp: VectorSubpath, tolerance: number): VectorSubpath {
	const tol = Math.max(tolerance, 1e-9);
	const types = new Map(sp.anchors.filter((a) => a.type).map((a) => [`${a.x},${a.y}`, a.type] as const));
	const segs = segsOf(sp).filter((s) => !isZeroSeg(s));
	if (!segs.length) return { anchors: sp.anchors.map(cloneAnchor), closed: sp.closed };
	const minSegs = sp.closed ? 2 : 1;
	let changed = true;
	while (changed && segs.length > minSegs) {
		changed = false;
		const n = segs.length;
		const joints = sp.closed ? n : n - 1;
		for (let j = 0; j < joints; j++) {
			const [i0, i1] = sp.closed ? [(j + n - 1) % n, j] : [j, j + 1];
			const m = mergePair(segs[i0], segs[i1], tol);
			if (!m) continue;
			segs[i0] = m;
			segs.splice(i1, 1);
			// The merged segment now starts the loop.
			if (sp.closed && i1 === 0) segs.unshift(segs.pop()!);
			changed = true;
			break;
		}
	}
	return segsToSubpath(segs, sp.closed, types) ?? { anchors: sp.anchors.map(cloneAnchor), closed: sp.closed };
}
