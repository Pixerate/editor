/**
 * Knife and eraser on Bézier paths, built on the curve booleans and `outlineStroke`.
 *
 * The knife cuts filled regions along a polyline with no gap: each stretch of the polyline
 * that crosses a region from boundary to boundary (a chord) splits the boundary loop it starts
 * and ends on into two loops sharing that chord, or, when it joins two loops (an outline and a
 * hole), merges them into one. Crossings are exact (line–cubic roots), and the pieces share
 * the cut edge exactly.
 *
 * The eraser removes the area of a round-capped stroke along a polyline: filled shapes lose it
 * by a boolean difference; outlines are cut where they cross the stroke's outline (exact
 * curve–curve intersections) and keep the parts outside it.
 *
 * Modelled on vectorcraft-main/crates/engine/src/cmd/draw2.rs (`knife`, `erase_region`,
 * `erase_outline`, `cut_subpath`; MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md), without its fixed knife slit and its sampled crossing search.
 */
import type { Point } from '../canvas/types.js';
import {
	bezierPathBounds,
	closeContour,
	contourSignedArea,
	contoursToPath,
	pathToContours,
	pointInBezierPath,
	segmentBounds,
	segmentPoint,
	subSegment,
	windingNumber,
	type BezierPath,
	type BezierPathInput
} from '../canvas/pathops/bezier.js';
import { normalizeBezierPath, pathBoolean, segmentIntersections } from '../canvas/pathops/boolean.js';
import { outlineStroke } from '../canvas/pathops/stroke.js';
import { inferAnchorType, subpathSegment, subpathSegmentCount } from './geometry.js';
import type { VectorAnchor, VectorSubpath } from './types.js';

type FillRule = 'nonzero' | 'evenodd';

// ---------------------------------------------------------------------------
// Faces: an outer loop with its holes
// ---------------------------------------------------------------------------

interface Loop {
	segs: Point[][];
	/** Which segments came from a knife chord (not sampled for containment). */
	chord: boolean[];
}

interface Face {
	loops: Loop[];
}

const loopArea = (l: Loop) => contourSignedArea(l.segs);

/** A point on the loop that is not on a chord (chords are shared with a neighbouring piece). */
function loopSample(l: Loop): Point {
	const k = l.chord.findIndex((c) => !c);
	return segmentPoint(l.segs[k >= 0 ? k : 0], 0.5);
}

const contains = (l: Loop, p: Point) => windingNumber([l.segs], p) !== 0;

/**
 * Groups non-crossing loops into faces: loops turning like the largest one are outlines, the
 * others holes of the smallest outline around them.
 */
function groupFaces(loops: Loop[]): Face[] {
	const usable = loops.filter((l) => l.segs.length && Math.abs(loopArea(l)) > 1e-12);
	if (!usable.length) return [];
	const largest = usable.reduce((a, b) => (Math.abs(loopArea(b)) > Math.abs(loopArea(a)) ? b : a));
	const sign = Math.sign(loopArea(largest));
	const outers = usable.filter((l) => Math.sign(loopArea(l)) === sign).sort((a, b) => Math.abs(loopArea(a)) - Math.abs(loopArea(b)));
	const faces = new Map<Loop, Face>(outers.map((o) => [o, { loops: [o] }]));
	for (const hole of usable.filter((l) => Math.sign(loopArea(l)) !== sign)) {
		const p = loopSample(hole);
		const parent = outers.find((o) => Math.abs(loopArea(o)) > Math.abs(loopArea(hole)) && contains(o, p));
		if (parent) faces.get(parent)!.loops.push(hole);
	}
	return outers.reverse().map((o) => faces.get(o)!);
}

function faceToPath(face: Face): BezierPath {
	return contoursToPath(face.loops.map((l) => ({ segments: l.segs, closed: true })));
}

/** Simple, consistently oriented faces of a filled path. */
function facesOf(path: BezierPathInput, fillRule: FillRule): Face[] {
	const normalized = normalizeBezierPath(path, fillRule);
	const loops = pathToContours(normalized).map((c) => {
		const segs = closeContour(c, true).map((s) => s.slice());
		return { segs, chord: segs.map(() => false) };
	});
	return groupFaces(loops);
}

/** One path per face (an outline with its holes) of a filled path, largest first. */
export function splitIntoFaces(path: BezierPathInput, fillRule: FillRule = 'nonzero'): BezierPath[] {
	return facesOf(path, fillRule).map(faceToPath);
}

// ---------------------------------------------------------------------------
// Line × segment crossings
// ---------------------------------------------------------------------------

/** Real roots in [0, 1] of `a·t³ + b·t² + c·t + d` (monotone pieces, bisection). */
function rootsInUnit(a: number, b: number, c: number, d: number, scale: number): number[] {
	const f = (t: number) => ((a * t + b) * t + c) * t + d;
	const tol = 1e-12 * Math.max(1, scale);
	// Critical points split [0, 1] into monotone pieces.
	const cuts = [0];
	const qa = 3 * a;
	const qb = 2 * b;
	if (Math.abs(qa) > 1e-18) {
		const disc = qb * qb - 4 * qa * c;
		if (disc >= 0) {
			const r = Math.sqrt(disc);
			for (const t of [(-qb - r) / (2 * qa), (-qb + r) / (2 * qa)].sort((x, y) => x - y)) if (t > 0 && t < 1) cuts.push(t);
		}
	} else if (Math.abs(qb) > 1e-18) {
		const t = -c / qb;
		if (t > 0 && t < 1) cuts.push(t);
	}
	cuts.push(1);
	const roots: number[] = [];
	const push = (t: number) => {
		if (!roots.some((r) => Math.abs(r - t) < 1e-9)) roots.push(t);
	};
	for (let i = 0; i < cuts.length - 1; i++) {
		let lo = cuts[i];
		let hi = cuts[i + 1];
		let flo = f(lo);
		const fhi = f(hi);
		if (Math.abs(flo) <= tol) push(lo);
		if (Math.abs(fhi) <= tol) push(hi);
		if (flo * fhi >= 0) continue;
		for (let k = 0; k < 80; k++) {
			const m = (lo + hi) / 2;
			const fm = f(m);
			if (fm === 0) {
				lo = hi = m;
				break;
			}
			if (fm * flo < 0) hi = m;
			else {
				lo = m;
				flo = fm;
			}
		}
		push((lo + hi) / 2);
	}
	return roots.sort((x, y) => x - y);
}

/** Where the line `p → q` crosses a segment: `s` on the line (0–1), `t` on the segment. Parallel overlaps are not crossings. */
function lineHits(p: Point, q: Point, seg: readonly Point[]): { s: number; t: number; point: Point }[] {
	const dx = q[0] - p[0];
	const dy = q[1] - p[1];
	const len2 = dx * dx + dy * dy;
	if (len2 < 1e-24) return [];
	// Signed distance (times |d|) of the segment from the line, as a polynomial in t.
	const h = (pt: Point) => (pt[0] - p[0]) * -dy + (pt[1] - p[1]) * dx;
	let coeffs: [number, number, number, number];
	if (seg.length === 2) coeffs = [0, 0, h(seg[1]) - h(seg[0]), h(seg[0])];
	else {
		const [h0, h1, h2, h3] = seg.map(h);
		coeffs = [-h0 + 3 * h1 - 3 * h2 + h3, 3 * h0 - 6 * h1 + 3 * h2, -3 * h0 + 3 * h1, h0];
	}
	if (coeffs.every((c) => Math.abs(c) < 1e-12 * Math.max(1, len2))) return [];
	const scale = Math.sqrt(len2) * Math.max(1, ...seg.map((pt) => Math.abs(pt[0]) + Math.abs(pt[1])));
	const out: { s: number; t: number; point: Point }[] = [];
	for (const t of rootsInUnit(...coeffs, scale)) {
		const point = segmentPoint(seg, t);
		const s = ((point[0] - p[0]) * dx + (point[1] - p[1]) * dy) / len2;
		if (s >= -1e-9 && s <= 1 + 1e-9) out.push({ s: Math.min(1, Math.max(0, s)), t, point });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Knife
// ---------------------------------------------------------------------------

interface Hit {
	/** Knife position: segment index + parameter. */
	s: number;
	loop: number;
	seg: number;
	t: number;
	point: Point;
}

const near = (a: Point, b: Point, eps: number) => Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
const degenerate = (seg: readonly Point[], eps: number) => seg.every((p) => near(p, seg[0], eps));

/** The loop's pieces from (seg a, t a) forward to (seg b, t b); `full` goes all the way round when they coincide. */
function arc(l: Loop, a: { seg: number; t: number }, b: { seg: number; t: number }, eps: number): { segs: Point[][]; chord: boolean[] } {
	const n = l.segs.length;
	const segs: Point[][] = [];
	const chord: boolean[] = [];
	const push = (k: number, t0: number, t1: number) => {
		const piece = t0 <= 0 && t1 >= 1 ? l.segs[k].slice() : subSegment(l.segs[k], t0, t1);
		if (!degenerate(piece, eps)) {
			segs.push(piece);
			chord.push(l.chord[k]);
		}
	};
	if (a.seg === b.seg && b.t >= a.t + 1e-12) {
		push(a.seg, a.t, b.t);
		return { segs, chord };
	}
	push(a.seg, a.t, 1);
	for (let k = (a.seg + 1) % n; k !== b.seg; k = (k + 1) % n) push(k, 0, 1);
	push(b.seg, 0, b.t);
	return { segs, chord };
}

/** Line segments through `points`. */
function polySegs(points: readonly Point[], eps: number): Point[][] {
	const out: Point[][] = [];
	for (let i = 1; i < points.length; i++) if (!near(points[i - 1], points[i], eps)) out.push([points[i - 1], points[i]]);
	return out;
}

/**
 * Cuts the filled path along the open polyline `knife`. Returns one path per resulting face
 * (an outline with its holes), or null when the knife crossed nothing from edge to edge. A
 * stretch of the knife that starts or ends inside the shape does not cut.
 */
export function knifePath(path: BezierPathInput, fillRule: FillRule, knife: readonly Point[]): BezierPath[] | null {
	const pts = knife.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
	if (pts.length < 2) return null;
	let faces = facesOf(path, fillRule);
	if (!faces.length) return null;
	const b = bezierPathBounds(path);
	const size = b ? Math.max(b.maxX - b.minX, b.maxY - b.minY, 1) : 1;
	const eps = size * 1e-9;
	let cursor = -Infinity;
	let cuts = 0;
	for (let guard = 0; guard < 512; guard++) {
		let best: { face: number; from: Hit; to: Hit } | null = null;
		faces.forEach((face, fi) => {
			const hits: Hit[] = [];
			for (let m = 0; m < pts.length - 1; m++) {
				if (m + 1 < cursor - 1e-9) continue;
				const kb = { minX: Math.min(pts[m][0], pts[m + 1][0]), maxX: Math.max(pts[m][0], pts[m + 1][0]), minY: Math.min(pts[m][1], pts[m + 1][1]), maxY: Math.max(pts[m][1], pts[m + 1][1]) };
				face.loops.forEach((l, li) =>
					l.segs.forEach((seg, si) => {
						const sb = segmentBounds(seg);
						if (sb.maxX < kb.minX - eps || sb.minX > kb.maxX + eps || sb.maxY < kb.minY - eps || sb.minY > kb.maxY + eps) return;
						for (const h of lineHits(pts[m], pts[m + 1], seg)) {
							const s = m + h.s;
							if (s >= cursor - 1e-9) hits.push({ s, loop: li, seg: si, t: h.t, point: h.point });
						}
					})
				);
			}
			hits.sort((x, y) => x.s - y.s);
			const unique = hits.filter((h, i) => i === 0 || h.s - hits[i - 1].s > 1e-9 || !near(h.point, hits[i - 1].point, eps * 10));
			const inside = (s: number) => {
				const m = Math.min(pts.length - 2, Math.floor(s));
				const u = s - m;
				const q: Point = [pts[m][0] + (pts[m + 1][0] - pts[m][0]) * u, pts[m][1] + (pts[m + 1][1] - pts[m][1]) * u];
				return windingNumber(face.loops.map((l) => l.segs), q) !== 0;
			};
			for (let i = 0; i < unique.length - 1; i++) {
				const from = unique[i];
				const to = unique[i + 1];
				if (near(from.point, to.point, eps * 10) || !inside((from.s + to.s) / 2)) continue;
				if (!best || from.s < best.from.s) best = { face: fi, from, to };
				break;
			}
		});
		if (!best) break;
		const { face: fi, from, to } = best as { face: number; from: Hit; to: Hit };
		const face = faces[fi];
		// The chord: the crossing points with the knife's corners between them.
		const corners: Point[] = [from.point];
		for (let m = Math.floor(from.s) + 1; m <= to.s - 1e-12 && m < pts.length; m++) if (m > from.s) corners.push(pts[m]);
		corners.push(to.point);
		const forward = polySegs(corners, eps);
		const back = polySegs(corners.slice().reverse(), eps);
		const la = face.loops[from.loop];
		const loops = face.loops.filter((_, i) => i !== from.loop && i !== to.loop);
		if (from.loop === to.loop) {
			const ab = arc(la, from, to, eps);
			const ba = arc(la, to, from, eps);
			loops.push(
				{ segs: [...ab.segs, ...back], chord: [...ab.chord, ...back.map(() => true)] },
				{ segs: [...ba.segs, ...forward], chord: [...ba.chord, ...forward.map(() => true)] }
			);
		} else {
			// The chord joins two loops into one, with the chord on both sides of a zero-width slit.
			const lb = face.loops[to.loop];
			const roundA = arc(la, from, from, eps);
			const roundB = arc(lb, to, to, eps);
			loops.push({
				segs: [...roundA.segs, ...forward, ...roundB.segs, ...back],
				chord: [...roundA.chord, ...forward.map(() => true), ...roundB.chord, ...back.map(() => true)]
			});
		}
		faces = [...faces.slice(0, fi), ...groupFaces(loops), ...faces.slice(fi + 1)];
		cursor = to.s;
		cuts++;
	}
	return cuts ? faces.map(faceToPath) : null;
}

// ---------------------------------------------------------------------------
// Eraser
// ---------------------------------------------------------------------------

/** The area a round eraser of diameter `width` covers along `points` (a disc for one point). */
export function eraserRegion(points: readonly Point[], width: number): BezierPath {
	const pts = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
	const r = width / 2;
	if (!pts.length || !(r > 0)) return [];
	const moved = pts.some((p) => !near(p, pts[0], 1e-9));
	if (!moved) {
		const [cx, cy] = pts[0];
		const k = r * 0.5522847498307936;
		return [
			{ type: 'M', x: cx, y: cy - r },
			{ type: 'C', x1: cx + k, y1: cy - r, x2: cx + r, y2: cy - k, x: cx + r, y: cy },
			{ type: 'C', x1: cx + r, y1: cy + k, x2: cx + k, y2: cy + r, x: cx, y: cy + r },
			{ type: 'C', x1: cx - k, y1: cy + r, x2: cx - r, y2: cy + k, x: cx - r, y: cy },
			{ type: 'C', x1: cx - r, y1: cy - k, x2: cx - k, y2: cy - r, x: cx, y: cy - r },
			{ type: 'Z' }
		];
	}
	const line: BezierPath = [{ type: 'M', x: pts[0][0], y: pts[0][1] }, ...pts.slice(1).map((p) => ({ type: 'L' as const, x: p[0], y: p[1] }))];
	return outlineStroke(line, { width, cap: 'round', join: 'round' });
}

/**
 * A filled path with `region` removed: one path per remaining face, or null when the region
 * does not overlap the fill.
 */
export function eraseFromFill(path: BezierPathInput, fillRule: FillRule, region: BezierPathInput): BezierPath[] | null {
	const overlap = pathBoolean('intersection', [{ path, fillRule }, { path: region }]).path;
	if (!pathToContours(overlap).some((c) => Math.abs(contourSignedArea(closeContour(c, true))) > 1e-9)) return null;
	const rest = pathBoolean('difference', [{ path, fillRule }, { path: region }]).path;
	return splitIntoFaces(rest);
}

/**
 * The parts of a subpath's outline outside `region`, as open subpaths that keep the original
 * curves exactly; null when the outline does not enter the region. A closed subpath's last
 * and first parts join at its first anchor.
 */
export function eraseFromOutline(sp: VectorSubpath, region: BezierPathInput): VectorSubpath[] | null {
	const regionSegs = pathToContours(region).flatMap((c) => closeContour(c, true));
	if (!regionSegs.length) return null;
	const rb = bezierPathBounds(region);
	const count = subpathSegmentCount(sp);
	if (!rb || count === 0) return null;
	const removed = (p: Point) => pointInBezierPath(region, p, 'nonzero');
	type Piece = { seg: number; t0: number; t1: number };
	const runs: Piece[][] = [];
	let cur: Piece[] = [];
	let any = false;
	for (let i = 0; i < count; i++) {
		const seg = subpathSegment(sp, i);
		const sb = segmentBounds(seg);
		const ts = [0, 1];
		if (!(sb.maxX < rb.minX || sb.minX > rb.maxX || sb.maxY < rb.minY || sb.minY > rb.maxY)) {
			for (const r of regionSegs) {
				const b = segmentBounds(r);
				if (b.maxX < sb.minX || b.minX > sb.maxX || b.maxY < sb.minY || b.minY > sb.maxY) continue;
				for (const hit of segmentIntersections(seg, r)) if (hit.ta > 1e-9 && hit.ta < 1 - 1e-9) ts.push(hit.ta);
			}
		}
		ts.sort((a, b) => a - b);
		for (let k = 0; k < ts.length - 1; k++) {
			const t0 = ts[k];
			const t1 = ts[k + 1];
			if (t1 - t0 < 1e-9) continue;
			if (removed(segmentPoint(seg, (t0 + t1) / 2))) {
				any = true;
				if (cur.length) runs.push(cur);
				cur = [];
			} else cur.push({ seg: i, t0, t1 });
		}
	}
	if (cur.length) runs.push(cur);
	if (!any) return null;
	// A closed path's last and first runs meet at anchor 0.
	if (sp.closed && runs.length >= 2) {
		const first = runs[0][0];
		const lastRun = runs[runs.length - 1];
		const last = lastRun[lastRun.length - 1];
		if (first.seg === 0 && first.t0 === 0 && last.seg === count - 1 && last.t1 === 1) lastRun.push(...runs.shift()!);
	}
	const out: VectorSubpath[] = [];
	for (const run of runs) {
		const anchors: VectorAnchor[] = [];
		for (const { seg, t0, t1 } of run) {
			const c = subSegment(subpathSegment(sp, seg), t0, t1);
			const line = c.length === 2;
			const start = c[0];
			const end = c[c.length - 1];
			if (!anchors.length) anchors.push({ x: start[0], y: start[1] });
			if (!line) anchors[anchors.length - 1].out = { x: c[1][0], y: c[1][1] };
			const next: VectorAnchor = { x: end[0], y: end[1] };
			if (!line) next.in = { x: c[2][0], y: c[2][1] };
			anchors.push(next);
		}
		if (anchors.length < 2) continue;
		for (const a of anchors) {
			const type = inferAnchorType(a);
			if (type !== 'corner') a.type = type;
		}
		out.push({ anchors, closed: false });
	}
	return out;
}

/** Bounds of a point list (for picking the paths a knife or eraser stroke can reach). */
export function polylineBounds(points: readonly Point[], pad = 0): { x: number; y: number; width: number; height: number } | null {
	if (!points.length) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of points) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { x: minX - pad, y: minY - pad, width: maxX - minX + 2 * pad, height: maxY - minY + 2 * pad };
}

/** Ramer–Douglas–Peucker reduction of a polyline (keeps both ends). */
export function simplifyPolyline(points: readonly Point[], tolerance: number): Point[] {
	const n = points.length;
	if (n < 3) return points.slice();
	const keep = new Array<boolean>(n).fill(false);
	keep[0] = keep[n - 1] = true;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const [ax, ay] = points[a];
		const dx = points[b][0] - ax;
		const dy = points[b][1] - ay;
		const len = Math.hypot(dx, dy);
		let far = -1;
		let farD = 0;
		for (let i = a + 1; i < b; i++) {
			const [px, py] = points[i];
			const d = len < 1e-12 ? Math.hypot(px - ax, py - ay) : Math.abs((px - ax) * dy - (py - ay) * dx) / len;
			if (d > farD) {
				farD = d;
				far = i;
			}
		}
		if (far >= 0 && farD > tolerance) {
			keep[far] = true;
			stack.push([a, far], [far, b]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

