// Portions ported from effectcraft-main/crates/path/src/interp.rs, vectorcraft-main/crates/doc/src/blend.rs and deckcraft-main/crates/geom/src/morph.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
/**
 * Morphing between vector paths: bring two shapes to matching anchors, then compute in-betweens.
 *
 * - **Contours** pair up in order. A contour without a partner grows out of (or shrinks into) a
 *   point at the same place relative to the other shape's box. Straight segments become cubics
 *   with handles at a third of the way, so a line bends smoothly into a curve.
 * - **Anchors** are inserted by arc length with de Casteljau splits, so both contours of a pair
 *   keep their exact outline and get the same number of segments, spread over the segments in
 *   proportion to their length.
 * - **Correspondence**: the closed side of each pair is turned to the cyclic start that costs
 *   least — the position differences left after the best-fit rotation (both shapes centred and
 *   scaled to unit size), a little for the turn, plus the χ² distance of log-polar
 *   shape-context histograms (Belongie, Malik & Puzicha, PAMI 2002; angles taken from the
 *   contour's direction) — and the winding is chosen once for all contours (the first closed
 *   pair turns the same way), so a nonzero fill keeps its holes.
 * - **In-betweens** follow the shapes' best-fit rotation and scale (Procrustes), with the
 *   leftover difference blended in linearly, so a turning shape turns instead of collapsing.
 * - **Paint**: colours mix in OKLab, gradients of one style resample their stops to a common
 *   set, a missing paint fades from transparent; stroke width, opacity, dashes, arrowhead
 *   scales and width profiles interpolate, and the rest switches halfway.
 * - **Transforms**: both shapes are blended in their parent's space; the in-between's rigid
 *   `transform` interpolates as a rotation (the short way round) plus a translation.
 *
 * Live corners are cut into the geometry first, so rounded corners morph as curves.
 */
import type { Point } from '../canvas/types.js';
import { segmentLength, segmentParamAtLength, splitSegment } from '../canvas/pathops/bezier.js';
import { expandVectorGradientStops, explicitVectorGradient, hasExplicitGradientGeometry, isVectorGradient, sampleVectorGradient, sortedVectorGradientStops, vectorGradientPoints } from './gradient.js';
import { mixColorsOklab } from '../animation/color.js';
import { evaluateEasing, type AnimationEasing } from '../animation/easing.js';
import { expandVectorCorners } from './corners.js';
import {
	applyMatrix,
	hasPaint,
	IDENTITY_MATRIX,
	inferAnchorType,
	invertMatrix,
	isIdentityMatrix,
	multiplyMatrices,
	nodeMatrix,
	unionBounds,
	type AffineMatrix
} from './geometry.js';
import { reverseWidthProfile, widthProfileAt } from './width.js';
import { expandVectorAppearance } from './appearance.js';
import type { Vec2, VectorAnchor, VectorBounds, VectorGradient, VectorGradientStop, VectorGroupNode, VectorNode, VectorPaint, VectorPathNode, VectorStyle, VectorSubpath, VectorWidthPoint } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface VectorMorphOptions {
	/**
	 * Move anchors in straight lines instead of following the shapes' best-fit rotation and
	 * scale. Default `false`.
	 */
	linear?: boolean;
	/** 0–1: how much the rotation-aware path outweighs the straight one (default 1). */
	rigidity?: number;
	/** Fewest segments each contour pair gets (default 16). */
	minSegments?: number;
	/** At most this far apart (document units) along the longer contour, when set. */
	spacing?: number | null;
	/** Most segments a contour pair gets (default 400). */
	maxSegments?: number;
	/** Search the start anchor of closed contours (default `true`); off keeps the stored starts. */
	matchStart?: boolean;
	/** Compare shape-context histograms when choosing starts (default `true`). */
	shapeContext?: boolean;
	/**
	 * The anchor each shape's first subpath starts from (the Blend tool's clicks). A closed
	 * subpath turns round to it; an open one clicked at its last anchor runs backwards.
	 */
	starts?: readonly [number | null | undefined, number | null | undefined];
	/** Id of the in-between (default: the first shape's id). */
	id?: string;
}

/** Two shapes prepared once; `at(t)` interpolates (0 = `a`, 1 = `b`). */
export interface VectorMorph {
	at(t: number): VectorNode;
}

// ---------------------------------------------------------------------------
// Point helpers
// ---------------------------------------------------------------------------

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpP = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const toP = (v: { x: number; y: number }): Point => [v.x, v.y];
const mapP = (m: AffineMatrix, p: Point): Point => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

// ---------------------------------------------------------------------------
// Contours: a start anchor, then three points (handle, handle, anchor) per cubic segment
// ---------------------------------------------------------------------------

/** A subpath as cubics. A closed contour's last point repeats its first. */
export interface VectorMorphContour {
	closed: boolean;
	pts: Point[];
}

const curvesOf = (c: VectorMorphContour) => Math.max(0, (c.pts.length - 1) / 3) | 0;

/** A subpath mapped by `m` as cubics (lines with handles at thirds), or null when empty. */
export function subpathToMorphContour(sp: VectorSubpath, m: AffineMatrix = IDENTITY_MATRIX): VectorMorphContour | null {
	const n = sp.anchors.length;
	if (!n) return null;
	const first = mapP(m, toP(sp.anchors[0]));
	const pts: Point[] = [first];
	const count = n < 2 ? 0 : sp.closed ? n : n - 1;
	for (let i = 0; i < count; i++) {
		const a = sp.anchors[i];
		const b = sp.anchors[(i + 1) % n];
		const pa = toP(a);
		const pb = toP(b);
		const straight = (!a.out || (a.out.x === a.x && a.out.y === a.y)) && (!b.in || (b.in.x === b.x && b.in.y === b.y));
		const c1 = straight ? lerpP(pa, pb, 1 / 3) : toP(a.out ?? a);
		const c2 = straight ? lerpP(pa, pb, 2 / 3) : toP(b.in ?? b);
		pts.push(mapP(m, c1), mapP(m, c2), i === count - 1 && sp.closed ? first : mapP(m, pb));
	}
	return { closed: sp.closed && count > 0, pts };
}

/** Whether the cubic's handles lie on its chord (it draws a straight line). */
function isStraight(p0: Point, p1: Point, p2: Point, p3: Point): boolean {
	const dx = p3[0] - p0[0];
	const dy = p3[1] - p0[1];
	const len = Math.hypot(dx, dy);
	const tol = Math.max(1e-7, len * 1e-7);
	if (len < 1e-12) return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < tol && Math.hypot(p2[0] - p0[0], p2[1] - p0[1]) < tol;
	const off = (p: Point) => Math.abs((p[0] - p0[0]) * dy - (p[1] - p0[1]) * dx) / len;
	const along = (p: Point) => ((p[0] - p0[0]) * dx + (p[1] - p0[1]) * dy) / (len * len);
	const u1 = along(p1);
	const u2 = along(p2);
	return off(p1) < tol && off(p2) < tol && u1 >= -1e-9 && u1 <= 1 + 1e-9 && u2 >= -1e-9 && u2 <= 1 + 1e-9;
}

/** A contour back to a subpath (`m` maps it out of the morph's space). Straight cubics become lines. */
export function morphContourToSubpath(c: VectorMorphContour, m: AffineMatrix = IDENTITY_MATRIX, closed = c.closed): VectorSubpath {
	const pts = isIdentityMatrix(m) ? c.pts : c.pts.map((p) => mapP(m, p));
	const curves = curvesOf(c);
	// A closed contour drops its repeated last anchor; one opened mid-morph keeps it.
	const dropLast = closed && c.closed && curves > 0;
	const count = dropLast ? curves : curves + 1;
	const anchors: VectorAnchor[] = [];
	for (let k = 0; k < count; k++) anchors.push({ x: pts[3 * k][0], y: pts[3 * k][1] });
	for (let k = 0; k < curves; k++) {
		const p0 = pts[3 * k];
		const p1 = pts[3 * k + 1];
		const p2 = pts[3 * k + 2];
		const p3 = pts[3 * k + 3];
		if (isStraight(p0, p1, p2, p3)) continue;
		anchors[k].out = { x: p1[0], y: p1[1] };
		anchors[(k + 1) % count].in = { x: p2[0], y: p2[1] };
	}
	for (const a of anchors) {
		const type = inferAnchorType(a);
		if (type !== 'corner') a.type = type;
	}
	const isClosed = closed && curves > 0;
	return { anchors: dropCollinear(anchors, isClosed), closed: isClosed };
}

/** Anchors without the ones that sit inside a straight run (no handles, in line with both neighbours). */
function dropCollinear(anchors: VectorAnchor[], closed: boolean): VectorAnchor[] {
	const out = anchors.slice();
	const min = closed ? 3 : 2;
	let i = closed ? 0 : 1;
	while (out.length > min && i < out.length - (closed ? 0 : 1)) {
		const n = out.length;
		const a = out[(i - 1 + n) % n];
		const b = out[i];
		const c = out[(i + 1) % n];
		const plain = !b.in && !b.out && !a.out && !c.in;
		const ux = b.x - a.x;
		const uy = b.y - a.y;
		const vx = c.x - b.x;
		const vy = c.y - b.y;
		const len = Math.hypot(ux, uy) + Math.hypot(vx, vy);
		if (plain && Math.abs(ux * vy - uy * vx) <= 1e-9 * Math.max(1, len * len) && ux * vx + uy * vy >= 0) out.splice(i, 1);
		else i++;
	}
	return out;
}

const segOf = (c: VectorMorphContour, k: number): Point[] => c.pts.slice(3 * k, 3 * k + 4);

/**
 * Exactly the same outline with `segments` cubics (at least as many as it has), the new
 * anchors spread over its segments in proportion to their arc length (largest remainder)
 * and each segment split into pieces of equal arc length. Also returns where each original
 * anchor went.
 */
export function refineMorphContour(c: VectorMorphContour, segments: number): { contour: VectorMorphContour; anchors: number[] } {
	const have = curvesOf(c);
	if (have === 0) return { contour: { closed: c.closed, pts: Array.from({ length: 1 + 3 * segments }, () => [c.pts[0][0], c.pts[0][1]] as Point) }, anchors: [0] };
	const identity = Array.from({ length: c.closed ? have : have + 1 }, (_, i) => i);
	if (have >= segments) return { contour: c, anchors: identity };
	const segs = Array.from({ length: have }, (_, k) => segOf(c, k));
	const lens = segs.map((s) => segmentLength(s));
	const sum = lens.reduce((a, b) => a + b, 0);
	const extra = segments - have;
	const want = lens.map((l) => (sum > 1e-12 ? (l / sum) * extra : extra / have));
	const parts = want.map((w) => 1 + Math.floor(w));
	let left = segments - parts.reduce((a, b) => a + b, 0);
	// Remainders that differ by rounding noise tie, so congruent shapes split alike.
	const frac = want.map((w) => w - Math.floor(w));
	const order = parts.map((_, i) => i).sort((a, b) => (Math.abs(frac[b] - frac[a]) > 1e-9 ? frac[b] - frac[a] : a - b));
	for (let i = 0; left > 0; i = (i + 1) % order.length, left--) parts[order[i]]++;
	const pts: Point[] = [c.pts[0]];
	const anchors: number[] = [0];
	let at = 0;
	segs.forEach((seg, k) => {
		const pieces = parts[k];
		let rest: Point[] = seg.slice();
		let t0 = 0;
		for (let j = 1; j < pieces; j++) {
			const t = segmentParamAtLength(seg, (lens[k] * j) / pieces, lens[k]);
			const u = Math.min(1, Math.max(0, (t - t0) / (1 - t0 || 1)));
			const [l, r] = splitSegment(rest, u);
			pts.push(l[1], l[2], l[3]);
			rest = r;
			t0 = t;
		}
		pts.push(rest[1], rest[2], k === have - 1 && c.closed ? c.pts[0] : rest[3]);
		at += pieces;
		if (k < have - 1 || !c.closed) anchors.push(at);
	});
	return { contour: { closed: c.closed, pts }, anchors };
}

/** The same contour run backwards (a closed one keeps its start anchor). */
export function reverseMorphContour(c: VectorMorphContour): VectorMorphContour {
	return { closed: c.closed, pts: c.pts.slice().reverse() };
}

/** A closed contour starting at anchor `s` (deckcraft's `turn`). */
export function turnMorphContour(c: VectorMorphContour, s: number): VectorMorphContour {
	const n = curvesOf(c);
	if (!c.closed || n === 0) return c;
	const k = ((s % n) + n) % n;
	if (k === 0) return c;
	const body = c.pts.slice(1);
	return { closed: true, pts: [c.pts[3 * k], ...body.slice(3 * k), ...body.slice(0, 3 * k)] };
}

/** Anchor positions of a contour (a closed one without its repeated end). */
function anchorPoints(c: VectorMorphContour): Point[] {
	const n = curvesOf(c);
	const count = c.closed ? n : n + 1;
	return Array.from({ length: Math.max(1, count) }, (_, k) => c.pts[3 * k]);
}

/** Signed area of a contour's anchor polygon. */
function polygonArea(pts: readonly Point[]): number {
	let s = 0;
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % pts.length];
		s += a[0] * b[1] - b[0] * a[1];
	}
	return s / 2;
}

// ---------------------------------------------------------------------------
// Correspondence
// ---------------------------------------------------------------------------

/** Centroid and RMS radius. */
function frame(v: readonly Point[]): { c: Point; r: number } {
	const n = Math.max(1, v.length);
	let cx = 0;
	let cy = 0;
	for (const p of v) {
		cx += p[0];
		cy += p[1];
	}
	cx /= n;
	cy /= n;
	let s = 0;
	for (const p of v) s += (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
	return { c: [cx, cy], r: Math.max(1e-9, Math.sqrt(s / n)) };
}

const RBINS = 5;
const ABINS = 12;
/** Weight of the turn a start implies: among starts that fit equally well, the least turning wins. */
const TURN_WEIGHT = 0.1;

/**
 * Log-polar shape-context histograms of every point, distances normalised by the RMS radius and
 * angles measured from the contour's direction at the point, so turning a shape leaves them
 * unchanged (only the fit below decides how far it turns).
 */
function shapeContexts(v: readonly Point[], closed: boolean): Float64Array[] {
	const { r } = frame(v);
	const n = v.length;
	return v.map((p, i) => {
		const prev = v[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
		const next = v[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
		const dir = Math.atan2(next[1] - prev[1], next[0] - prev[0]);
		const h = new Float64Array(RBINS * ABINS);
		let total = 0;
		for (let j = 0; j < n; j++) {
			if (i === j) continue;
			const dx = v[j][0] - p[0];
			const dy = v[j][1] - p[1];
			const d = Math.hypot(dx, dy) / r;
			// log radius in [1/8, 2] → five bins.
			const lr = ((Math.log2(Math.max(d, 1e-6)) + 3) / 4) * RBINS;
			if (!(lr >= 0 && lr < RBINS)) continue;
			let ang = Math.atan2(dy, dx) - dir;
			ang = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
			h[Math.floor(lr) * ABINS + Math.min(ABINS - 1, Math.floor((ang / (2 * Math.PI)) * ABINS))] += 1;
			total++;
		}
		if (total > 0) for (let k = 0; k < h.length; k++) h[k] /= total;
		return h;
	});
}

function chi2(a: Float64Array, b: Float64Array): number {
	let s = 0;
	for (let k = 0; k < a.length; k++) {
		const t = a[k] + b[k];
		if (t > 1e-12) s += ((a[k] - b[k]) * (a[k] - b[k])) / t;
	}
	return s / 2;
}

/**
 * The cyclic start of the closed `free` contour that matches `fixed` best, and its cost. Both
 * shapes are centred and scaled to unit RMS radius (where and how big they are does not
 * matter); a start costs what is left after the best rotation maps one onto the other, plus a
 * little for how far that rotation turns, plus (optionally) the mean χ² shape-context
 * distance. So a turned copy of a shape matches by turning rather than by squashing.
 */
function bestStart(fixed: VectorMorphContour, free: VectorMorphContour, useShapeContext: boolean): { start: number; cost: number } {
	const fa = anchorPoints(fixed);
	const ga = anchorPoints(free);
	const n = ga.length;
	const ff = frame(fa);
	const gf = frame(ga);
	const fn = fa.map((p): Point => [(p[0] - ff.c[0]) / ff.r, (p[1] - ff.c[1]) / ff.r]);
	const gn = ga.map((p): Point => [(p[0] - gf.c[0]) / gf.r, (p[1] - gf.c[1]) / gf.r]);
	const fsc = useShapeContext ? shapeContexts(fa, fixed.closed) : null;
	const gsc = useShapeContext ? shapeContexts(ga, free.closed) : null;
	const m = Math.max(1, fn.length);
	const cost = (s: number) => {
		let dot = 0;
		let cross = 0;
		let sc = 0;
		for (let i = 0; i < fn.length; i++) {
			const j = free.closed ? (i + s) % n : i;
			const p = fn[i];
			const q = gn[j];
			dot += p[0] * q[0] + p[1] * q[1];
			cross += p[0] * q[1] - p[1] * q[0];
			if (fsc && gsc) sc += chi2(fsc[i], gsc[j]);
		}
		// Unit RMS on both sides: what the best rotation and scale leave over, as a fraction.
		const residual = Math.max(0, 1 - (dot * dot + cross * cross) / (m * m));
		const turn = 1 - Math.cos(Math.atan2(cross, dot));
		return residual + TURN_WEIGHT * turn + sc / m;
	};
	if (!free.closed) return { start: 0, cost: cost(0) };
	// Long contours: every few starts first, then the neighbours of the best.
	const stride = n > 96 ? Math.ceil(n / 48) : 1;
	let best = { start: 0, cost: Infinity };
	for (let s = 0; s < n; s += stride) {
		const c = cost(s);
		if (c < best.cost - 1e-12) best = { start: s, cost: c };
	}
	if (stride > 1) {
		const s0 = best.start;
		for (let d = 1; d < stride; d++)
			for (const s of [(s0 + d) % n, (s0 - d + n) % n]) {
				const c = cost(s);
				if (c < best.cost - 1e-12) best = { start: s, cost: c };
			}
	}
	return best;
}

/** The spot a contour without partner grows from: the same place relative to the other shape's box. */
function placeIn(c: VectorMorphContour, from: VectorBounds | null, to: VectorBounds | null): Point {
	const b = unionBounds([boundsOfPoints(c.pts)]);
	const p: Point = b ? [b.x + b.width / 2, b.y + b.height / 2] : c.pts[0];
	if (!from || !to) return p;
	const fx = from.width > 0 ? (p[0] - from.x) / from.width : 0.5;
	const fy = from.height > 0 ? (p[1] - from.y) / from.height : 0.5;
	return [to.x + to.width * fx, to.y + to.height * fy];
}

function boundsOfPoints(pts: readonly Point[]): VectorBounds | null {
	if (!pts.length) return null;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of pts) {
		x0 = Math.min(x0, p[0]);
		y0 = Math.min(y0, p[1]);
		x1 = Math.max(x1, p[0]);
		y1 = Math.max(y1, p[1]);
	}
	return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Two shapes' contours with matching structure: same count, and per pair the same segments. */
export interface VectorMorphCorrespondence {
	a: VectorMorphContour[];
	b: VectorMorphContour[];
	/** Whether `b` runs backwards relative to its stored direction. */
	reversed: boolean;
}

/**
 * Gives two lists of contours the same structure with matching anchors (see the module notes).
 * Contours pair in order; one without a partner meets a point.
 */
export function correspondMorphContours(a: readonly VectorMorphContour[], b: readonly VectorMorphContour[], options: VectorMorphOptions = {}): VectorMorphCorrespondence {
	const minSeg = Math.max(1, Math.round(options.minSegments ?? 16));
	const maxSeg = Math.max(minSeg, Math.round(options.maxSegments ?? 400));
	const spacing = options.spacing && options.spacing > 0 ? options.spacing : null;
	const useSC = options.shapeContext !== false;
	const match = options.matchStart !== false;
	const ba = boundsOfPoints(a.flatMap((c) => c.pts));
	const bb = boundsOfPoints(b.flatMap((c) => c.pts));
	const contourLength = (c: VectorMorphContour) => {
		let l = 0;
		for (let k = 0; k < curvesOf(c); k++) l += segmentLength(segOf(c, k));
		return l;
	};
	type Pair = { x: VectorMorphContour; y: VectorMorphContour; point: boolean; startX: number | null; startY: number | null };
	const pairs: Pair[] = [];
	const [sa, sb] = options.starts ?? [];
	for (let k = 0; k < Math.max(a.length, b.length); k++) {
		const ca = a[k];
		const cb = b[k];
		const explicitA = k === 0 && sa !== null && sa !== undefined ? sa : null;
		const explicitB = k === 0 && sb !== null && sb !== undefined ? sb : null;
		const counts = [ca ? curvesOf(ca) : 0, cb ? curvesOf(cb) : 0];
		const longest = Math.max(ca ? contourLength(ca) : 0, cb ? contourLength(cb) : 0);
		let n = Math.max(counts[0], counts[1], minSeg, spacing ? Math.ceil(longest / spacing) : 0);
		n = Math.max(counts[0], counts[1], Math.min(n, maxSeg));
		const point = (c: VectorMorphContour, from: VectorBounds | null, to: VectorBounds | null): VectorMorphContour => {
			const p = placeIn(c, from, to);
			return { closed: c.closed, pts: Array.from({ length: 1 + 3 * n }, () => [p[0], p[1]] as Point) };
		};
		if (ca && cb) {
			const ra = refineMorphContour(ca, n);
			const rb = refineMorphContour(cb, n);
			pairs.push({
				x: ra.contour,
				y: rb.contour,
				point: false,
				startX: explicitA === null ? null : (ra.anchors[explicitA] ?? null),
				startY: explicitB === null ? null : explicitB === rb.anchors.length - 1 && !cb.closed ? -1 : (rb.anchors[explicitB] ?? null)
			});
			if (explicitA !== null && !ca.closed && explicitA === ra.anchors.length - 1 && explicitA > 0) pairs[pairs.length - 1].startX = -1;
		} else if (ca) pairs.push({ x: refineMorphContour(ca, n).contour, y: point(ca, ba, bb), point: true, startX: null, startY: null });
		else if (cb) pairs.push({ x: point(cb, bb, ba), y: refineMorphContour(cb, n).contour, point: true, startX: null, startY: null });
	}
	// Explicit starts: closed contours turn to the clicked anchor; an open one clicked at its end runs backwards.
	const startAt = (c: VectorMorphContour, s: number | null): VectorMorphContour => {
		if (s === null) return c;
		if (s === -1) return reverseMorphContour(c);
		return c.closed ? turnMorphContour(c, s) : c;
	};
	const explicit = pairs.length > 0 && (pairs[0].startX !== null || pairs[0].startY !== null);
	// Winding: closed shapes keep the same turning direction (effectcraft), judged on the first
	// pair of closed contours and applied to every contour so a nonzero fill keeps its holes;
	// open paths take whichever direction costs less (deckcraft), unless a click fixed it.
	const ref = pairs.find((p) => !p.point && p.x.closed && p.y.closed);
	const fixedBack = ref
		? Math.sign(polygonArea(anchorPoints(ref.x))) !== Math.sign(polygonArea(anchorPoints(ref.y))) && Math.abs(polygonArea(anchorPoints(ref.y))) > 1e-12
		: explicit
			? false
			: null;
	let best: { xs: VectorMorphContour[]; ys: VectorMorphContour[]; cost: number; back: boolean } | null = null;
	for (const back of fixedBack === null ? [false, true] : [fixedBack]) {
		const xs: VectorMorphContour[] = [];
		const ys: VectorMorphContour[] = [];
		let cost = 0;
		pairs.forEach((p, k) => {
			let x = k === 0 ? startAt(p.x, p.startX) : p.x;
			let y = k === 0 ? startAt(p.y, p.startY) : p.y;
			if (back) y = reverseMorphContour(y);
			if (p.point) {
				xs.push(x);
				ys.push(y);
				return;
			}
			const pinned = k === 0 && explicit;
			// The closed side turns: `b` when it is closed, else `a`.
			const turnX = !y.closed && x.closed;
			if (match && !pinned && (y.closed || turnX)) {
				const r = turnX ? bestStart(y, x, useSC) : bestStart(x, y, useSC);
				if (turnX) x = turnMorphContour(x, r.start);
				else y = turnMorphContour(y, r.start);
				cost += r.cost;
			} else cost += bestStart(x, { ...y, closed: false }, useSC).cost;
			xs.push(x);
			ys.push(y);
		});
		if (!best || cost < best.cost - 1e-9) best = { xs, ys, cost, back };
	}
	return best ? { a: best.xs, b: best.ys, reversed: best.back } : { a: [], b: [], reversed: false };
}

/**
 * How many pairs of straight anchor paths (from `a`'s anchor i to `b`'s anchor i) cross: a
 * sanity measure of a correspondence — good matches don't make anchors pass through each other.
 */
export function morphPathsCross(a: readonly VectorMorphContour[], b: readonly VectorMorphContour[]): number {
	let count = 0;
	const d = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	for (let k = 0; k < Math.min(a.length, b.length); k++) {
		const pa = anchorPoints(a[k]);
		const pb = anchorPoints(b[k]);
		const n = Math.min(pa.length, pb.length);
		for (let i = 0; i < n; i++)
			for (let j = i + 1; j < n; j++) {
				const d1 = d(pa[j], pb[j], pa[i]);
				const d2 = d(pa[j], pb[j], pb[i]);
				const d3 = d(pa[i], pb[i], pa[j]);
				const d4 = d(pa[i], pb[i], pb[j]);
				if (d1 * d2 < 0 && d3 * d4 < 0) count++;
			}
	}
	return count;
}

// ---------------------------------------------------------------------------
// In-betweens
// ---------------------------------------------------------------------------

/** The similarity (rotation θ, scale s, centroids) that best maps `a`'s anchors onto `b`'s. */
interface Similarity {
	ca: Point;
	cb: Point;
	theta: number;
	s: number;
}

function procrustes(a: readonly VectorMorphContour[], b: readonly VectorMorphContour[]): Similarity {
	const pa = a.flatMap(anchorPoints);
	const pb = b.flatMap(anchorPoints);
	const ca = frame(pa).c;
	const cb = frame(pb).c;
	let ss = 0;
	let dot = 0;
	let cross = 0;
	for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
		const p: Point = [pa[i][0] - ca[0], pa[i][1] - ca[1]];
		const q: Point = [pb[i][0] - cb[0], pb[i][1] - cb[1]];
		ss += p[0] * p[0] + p[1] * p[1];
		dot += p[0] * q[0] + p[1] * q[1];
		cross += p[0] * q[1] - p[1] * q[0];
	}
	return { ca, cb, theta: Math.atan2(cross, dot), s: ss > 1e-12 ? Math.hypot(dot, cross) / ss : 1 };
}

/**
 * Corresponded contours at `u`: each point carried by the similarity interpolated to `u`
 * (rotation θu, scale sᵘ, centroid moving straight), plus `u` of what the full similarity
 * leaves over, blended with the straight path by `rigidity`.
 */
export function interpolateMorphContours(
	a: readonly VectorMorphContour[],
	b: readonly VectorMorphContour[],
	u: number,
	options: Pick<VectorMorphOptions, 'linear' | 'rigidity'> & { similarity?: Similarity } = {}
): VectorMorphContour[] {
	const w = options.linear ? 0 : Math.min(1, Math.max(0, options.rigidity ?? 1));
	const sim = w > 0 ? (options.similarity ?? procrustes(a, b)) : null;
	const rot = (p: Point, ang: number, k: number): Point => {
		const c = Math.cos(ang);
		const s = Math.sin(ang);
		return [k * (c * p[0] - s * p[1]), k * (s * p[0] + c * p[1])];
	};
	const thetaU = sim ? sim.theta * u : 0;
	const sU = sim ? Math.max(1e-9, sim.s) ** u : 1;
	const cU = sim ? lerpP(sim.ca, sim.cb, u) : ([0, 0] as Point);
	return a.map((ca, k) => {
		const cb = b[k];
		const pts = ca.pts.map((p, i) => {
			const q = cb.pts[i] ?? p;
			const linear = lerpP(p, q, u);
			if (!sim) return linear;
			const d: Point = [p[0] - sim.ca[0], p[1] - sim.ca[1]];
			const full = rot(d, sim.theta, sim.s);
			const resid: Point = [q[0] - (full[0] + sim.cb[0]), q[1] - (full[1] + sim.cb[1])];
			const part = rot(d, thetaU, sU);
			const rigid: Point = [part[0] + cU[0] + resid[0] * u, part[1] + cU[1] + resid[1] * u];
			return lerpP(linear, rigid, w);
		});
		return { closed: ca.closed && cb.closed, pts };
	});
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * Interpolates two rigid matrices as a rotation (the shorter way round) plus a translation.
 * Any scale or skew is interpolated linearly in the rotated frame.
 */
export function interpolateRigidMatrix(a: AffineMatrix, b: AffineMatrix, t: number): AffineMatrix {
	const decompose = (m: AffineMatrix) => {
		const sx = Math.hypot(m[0], m[1]);
		const ang = sx > 1e-12 ? Math.atan2(m[1], m[0]) : 0;
		const c = Math.cos(ang);
		const s = Math.sin(ang);
		return { e: m[4], f: m[5], ang, sx, sh: c * m[2] + s * m[3], sy: -s * m[2] + c * m[3] };
	};
	const p = decompose(a);
	const q = decompose(b);
	let turn = q.ang - p.ang;
	turn = ((((turn + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
	const ang = p.ang + turn * t;
	const sx = lerpN(p.sx, q.sx, t);
	const sh = lerpN(p.sh, q.sh, t);
	const sy = lerpN(p.sy, q.sy, t);
	const c = Math.cos(ang);
	const s = Math.sin(ang);
	return [c * sx, s * sx, c * sh - s * sy, s * sh + c * sy, lerpN(p.e, q.e, t), lerpN(p.f, q.f, t)];
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/** Two colours mixed in OKLab (premultiplied alpha); unreadable colours switch halfway. */
export function interpolateVectorColor(a: string, b: string, t: number): string {
	if (t <= 0) return a;
	if (t >= 1) return b;
	return mixColorsOklab(a, b, t) ?? (t < 0.5 ? a : b);
}

/**
 * A gradient's stops resampled at `offsets`, each painting what the gradient paints there (its
 * midpoints, smoothness and interpolation space included).
 */
export function resampleGradientStops(g: VectorGradient, offsets: readonly number[]): VectorGradientStop[] {
	return offsets.map((offset) => {
		const s = sampleVectorGradient(g, offset);
		return s.opacity < 1 ? { offset, color: s.color, opacity: Math.round(s.opacity * 1e4) / 1e4 } : { offset, color: s.color };
	});
}

function lerpAngle(a: number, b: number, t: number): number {
	const d = ((((b - a + 180) % 360) + 360) % 360) - 180;
	return a + d * t;
}

const lerpPoint = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerpN(a.x, b.x, t), y: lerpN(a.y, b.y, t) });
const sameColourModel = (a: VectorGradient, b: VectorGradient) => (a.interpolation ?? 'srgb') === (b.interpolation ?? 'srgb') && (a.smoothness ?? 0) === (b.smoothness ?? 0);

/** Stops of two gradients mixed: stop by stop (midpoints too) when they match, else resampled to a common set. */
function lerpStops(a: VectorGradient, b: VectorGradient, t: number): { stops: VectorGradientStop[]; resampled: boolean } {
	let stopsA = sortedVectorGradientStops(a);
	let stopsB = sortedVectorGradientStops(b);
	const resampled = stopsA.length !== stopsB.length || !sameColourModel(a, b);
	if (resampled) {
		// Where either gradient bends (its own stops and the extra stops its midpoints and colour space need).
		const offs = [...expandVectorGradientStops(a), ...expandVectorGradientStops(b), ...stopsA, ...stopsB].map((s) => s.offset).filter(Number.isFinite).sort((x, y) => x - y);
		const common = offs.filter((o, i) => i === 0 || o - offs[i - 1] > 1e-4);
		stopsA = resampleGradientStops(a, common);
		stopsB = resampleGradientStops(b, common);
	}
	const stops = stopsA.map((x, i) => {
		const y = stopsB[i];
		const opacity = lerpN(x.opacity ?? 1, y.opacity ?? 1, t);
		const stop: VectorGradientStop = { offset: lerpN(x.offset, y.offset, t), color: interpolateVectorColor(x.color, y.color, t) };
		if (opacity < 1) stop.opacity = opacity;
		const mid = lerpN(x.midpoint ?? 0.5, y.midpoint ?? 0.5, t);
		if (Math.abs(mid - 0.5) > 1e-6) stop.midpoint = mid;
		return stop;
	});
	return { stops, resampled };
}

/**
 * Two gradients of one style: stops mixed, then the placement — the shorthand angle / centre /
 * radius, or the start, end, aspect and focal points when both carry them in the same units
 * (one in the box and one in the node's space switch halfway). Null for different styles.
 */
function lerpGradient(a: VectorGradient, b: VectorGradient, t: number): VectorGradient | null {
	if (a.type !== b.type) return null;
	const { stops, resampled } = lerpStops(a, b, t);
	const near = t < 0.5 ? a : b;
	const out: VectorGradient = { type: a.type, stops };
	if (!resampled) {
		if (a.interpolation && a.interpolation !== 'srgb') out.interpolation = a.interpolation;
		if (a.smoothness) out.smoothness = a.smoothness;
	}
	if (near.spread && near.spread !== 'pad') out.spread = near.spread;
	if (near.strokeMode && near.strokeMode !== 'within') out.strokeMode = near.strokeMode;
	const ea = hasExplicitGradientGeometry(a);
	const eb = hasExplicitGradientGeometry(b);
	if (!ea && !eb) {
		if (a.angle !== undefined || b.angle !== undefined || a.type === 'linear' || a.type === 'reflected') {
			const fallback = a.type === 'linear' || a.type === 'reflected' ? 180 : 90;
			out.angle = lerpAngle(a.angle ?? fallback, b.angle ?? fallback, t);
		}
		if (a.type !== 'linear' && a.type !== 'reflected') {
			out.cx = lerpN(a.cx ?? 0.5, b.cx ?? 0.5, t);
			out.cy = lerpN(a.cy ?? 0.5, b.cy ?? 0.5, t);
			out.r = lerpN(a.r ?? 0.5, b.r ?? 0.5, t);
		}
		return out;
	}
	const pa = vectorGradientPoints(a);
	const pb = vectorGradientPoints(b);
	if (pa.units !== pb.units) {
		const src = explicitVectorGradient(near);
		return { ...src, stops: out.stops, ...(out.interpolation ? { interpolation: out.interpolation } : {}), ...(out.smoothness ? { smoothness: out.smoothness } : {}) };
	}
	out.start = lerpPoint(pa.start, pb.start, t);
	out.end = lerpPoint(pa.end, pb.end, t);
	out.width = lerpPoint(pa.width, pb.width, t);
	out.units = pa.units;
	if (a.type === 'radial') {
		if (pa.focal || pb.focal) out.focal = lerpPoint(pa.focal ?? pa.start, pb.focal ?? pb.start, t);
		const fr = lerpN(pa.focalRadius, pb.focalRadius, t);
		if (fr > 0) out.focalRadius = fr;
	}
	return out;
}

/** A gradient shaped like `like` painting one colour (or nothing). */
function solidLike(color: string | null, like: VectorGradient): VectorGradient {
	return { ...like, stops: like.stops.map((s) => (color === null ? { offset: s.offset, color: s.color, opacity: 0 } : { offset: s.offset, color })) };
}

/**
 * Interpolates paints: colours in OKLab, gradients of one kind with their stops resampled to a
 * common set, a colour and a gradient through a gradient of that colour, and a missing paint
 * fading from transparent. Gradients of different kinds switch halfway.
 */
export function interpolateVectorPaint(a: VectorPaint | undefined, b: VectorPaint | undefined, t: number): VectorPaint | undefined {
	if (t <= 0) return a;
	if (t >= 1) return b;
	const pa = hasPaint(a);
	const pb = hasPaint(b);
	if (!pa && !pb) return t < 0.5 ? a : b;
	if (typeof a === 'string' && pa && typeof b === 'string' && pb) return interpolateVectorColor(a, b, t);
	if (!pa && typeof b === 'string') return interpolateVectorColor('transparent', b, t);
	if (!pb && typeof a === 'string') return interpolateVectorColor(a, 'transparent', t);
	const ga = pa && isVectorGradient(a) ? a : null;
	const gb = pb && isVectorGradient(b) ? b : null;
	if (ga && gb) return lerpGradient(ga, gb, t) ?? (t < 0.5 ? a : b);
	if (gb) return lerpGradient(solidLike(pa ? (a as string) : null, gb), gb, t) ?? b;
	if (ga) return lerpGradient(ga, solidLike(pb ? (b as string) : null, ga), t) ?? a;
	return t < 0.5 ? a : b;
}

/** Width profiles at every position either has a point (no profile is uniform). */
export function interpolateWidthProfiles(a: readonly VectorWidthPoint[] | null | undefined, b: readonly VectorWidthPoint[] | null | undefined, t: number): VectorWidthPoint[] | null {
	if (!a?.length && !b?.length) return null;
	const at = [...(a ?? []), ...(b ?? []), { t: 0 }, { t: 1 }].map((p) => p.t).sort((x, y) => x - y);
	const ts = at.filter((v, i) => i === 0 || v - at[i - 1] > 1e-6);
	return ts.map((pos) => {
		const x = widthProfileAt(a, pos);
		const y = widthProfileAt(b, pos);
		return { t: pos, left: lerpN(x.left, y.left, t), right: lerpN(x.right, y.right, t) };
	});
}

/** Dash patterns: equal lengths mix; a solid stroke counts as the other's pattern with its gaps closed. */
function lerpDashes(a: number[] | undefined, b: number[] | undefined, t: number): number[] | undefined {
	const dashed = (d: number[] | undefined) => !!d?.length && d.some((v) => v > 0);
	if (!dashed(a) && !dashed(b)) return t < 0.5 ? a : b;
	const even = (p: number[]) => (p.length % 2 ? [...p, ...p] : p);
	const solid = (p: number[]) => {
		const e = even(p);
		const out: number[] = [];
		for (let i = 0; i < e.length; i += 2) out.push(e[i] + e[i + 1], 0);
		return out;
	};
	const x = dashed(a) ? even(a!) : solid(b!);
	const y = dashed(b) ? even(b!) : solid(a!);
	if (x.length !== y.length) return t < 0.5 ? a : b;
	return x.map((v, i) => lerpN(v, y[i], t));
}

const SWITCHED_KEYS = ['strokeLinecap', 'strokeLinejoin', 'fillRule', 'strokeAlign', 'startArrow', 'endArrow', 'arrowAlign'] as const;

/**
 * Interpolated style of two paths: paints, stroke width, dashes, arrowhead scales and width
 * profiles mix; caps, joins, the fill rule, alignment and arrowheads switch halfway.
 */
export function interpolateVectorStyle(a: VectorStyle, b: VectorStyle, t: number): VectorStyle {
	const near = t < 0.5 ? a : b;
	const out: VectorStyle = {};
	const fill = interpolateVectorPaint(a.fill, b.fill, t);
	if (fill !== undefined) out.fill = fill;
	const stroke = interpolateVectorPaint(a.stroke, b.stroke, t);
	if (stroke !== undefined) out.stroke = stroke;
	if (a.strokeWidth !== undefined || b.strokeWidth !== undefined) out.strokeWidth = lerpN(a.strokeWidth ?? 1, b.strokeWidth ?? 1, t);
	for (const key of SWITCHED_KEYS) if (near[key] !== undefined && near[key] !== null) (out as Record<string, unknown>)[key] = near[key];
	for (const key of ['startArrowScale', 'endArrowScale'] as const)
		if (a[key] !== undefined || b[key] !== undefined) out[key] = lerpN(a[key] ?? 1, b[key] ?? 1, t);
	const dash = lerpDashes(a.strokeDasharray, b.strokeDasharray, t);
	if (dash?.length) out.strokeDasharray = dash;
	const profile = interpolateWidthProfiles(a.strokeWidthProfile, b.strokeWidthProfile, t);
	if (profile) out.strokeWidthProfile = profile;
	return out;
}

/** A path's style as seen running backwards: arrowheads swap ends and width profiles reverse. */
function reversedStyle(s: VectorStyle): VectorStyle {
	const out: VectorStyle = { ...s };
	out.startArrow = s.endArrow;
	out.endArrow = s.startArrow;
	out.startArrowScale = s.endArrowScale;
	out.endArrowScale = s.startArrowScale;
	if (s.strokeWidthProfile?.length) out.strokeWidthProfile = reverseWidthProfile(s.strokeWidthProfile);
	for (const k of ['startArrow', 'endArrow', 'startArrowScale', 'endArrowScale'] as const) if (out[k] === undefined) delete out[k];
	return out;
}

const STYLE_KEYS = [
	'fill',
	'stroke',
	'strokeWidth',
	'strokeLinecap',
	'strokeLinejoin',
	'strokeDasharray',
	'fillRule',
	'strokeAlign',
	'startArrow',
	'endArrow',
	'arrowAlign',
	'startArrowScale',
	'endArrowScale',
	'strokeWidthProfile'
] as const;

function styleOf(n: VectorPathNode): VectorStyle {
	const out: VectorStyle = {};
	for (const k of STYLE_KEYS) if (n[k] !== undefined) (out as Record<string, unknown>)[k] = n[k];
	return out;
}

// ---------------------------------------------------------------------------
// Path and node morphs
// ---------------------------------------------------------------------------

function contoursOf(node: VectorPathNode, m: AffineMatrix): VectorMorphContour[] {
	return expandVectorCorners(node.subpaths)
		.map((sp) => subpathToMorphContour(sp, m))
		.filter((c): c is VectorMorphContour => !!c);
}

/**
 * Two paths (each placed by `ma` / `mb` into a common space: by default their own
 * transforms, i.e. their parent's space) prepared for interpolation.
 */
function preparePathMorph(
	a: VectorPathNode,
	b: VectorPathNode,
	options: VectorMorphOptions,
	ma: AffineMatrix = nodeMatrix(a),
	mb: AffineMatrix = nodeMatrix(b)
): (t: number) => VectorPathNode {
	const corr = correspondMorphContours(contoursOf(a, ma), contoursOf(b, mb), options);
	const sim = procrustes(corr.a, corr.b);
	const styleA = styleOf(a);
	const styleB = corr.reversed ? reversedStyle(styleOf(b)) : styleOf(b);
	const rigid = !isIdentityMatrix(ma) || !isIdentityMatrix(mb);
	const id = options.id ?? a.id;
	return (t) => {
		const contours = interpolateMorphContours(corr.a, corr.b, t, { linear: options.linear, rigidity: options.rigidity, similarity: sim });
		const m = rigid ? interpolateRigidMatrix(ma, mb, t) : IDENTITY_MATRIX;
		const back = rigid ? invertMatrix(m) : IDENTITY_MATRIX;
		const subpaths = contours.map((c, k) => {
			// A pair of one closed and one open contour is open in between and takes each key's state at the ends.
			const closed = t <= 0 ? corr.a[k].closed : t >= 1 ? corr.b[k].closed : corr.a[k].closed && corr.b[k].closed;
			return morphContourToSubpath({ closed: corr.a[k].closed && corr.b[k].closed, pts: c.pts }, back, closed);
		});
		const node: VectorPathNode = { id, type: 'path', subpaths, ...interpolateVectorStyle(styleA, styleB, t) };
		const opacity = lerpN(a.opacity ?? 1, b.opacity ?? 1, t);
		if (opacity < 1) node.opacity = opacity;
		if (rigid && !isIdentityMatrix(m)) node.transform = m;
		return node;
	};
}

/** Path nodes of a subtree with their matrices into the subtree's parent space. */
function flattenPaths(node: VectorNode, parent: AffineMatrix = IDENTITY_MATRIX): { path: VectorPathNode; m: AffineMatrix; opacity: number }[] {
	const m = multiplyMatrices(nodeMatrix(node), parent);
	if (node.type === 'path') return [{ path: node, m, opacity: 1 }];
	// Text blends as its glyphs.
	if (node.type === 'text') return flattenPaths(expandVectorAppearance(node), parent);
	const o = node.opacity ?? 1;
	return node.children
		.filter((c) => c.visible !== false)
		.flatMap((c) => flattenPaths(c, m))
		.map((e) => ({ ...e, opacity: e.opacity * o }));
}

/** Bounds of a path placed by `m`. */
const placedBounds = (path: VectorPathNode, m: AffineMatrix) => boundsOfPoints(contoursOf(path, m).flatMap((c) => c.pts));

/** A copy of `path` shrunk to the point that matches it in the other shape's box (placed by the identity). */
function collapsedPath(path: VectorPathNode, m: AffineMatrix, from: VectorBounds | null, to: VectorBounds | null): VectorPathNode {
	const own = placedBounds(path, m);
	const c: Point = own ? [own.x + own.width / 2, own.y + own.height / 2] : [0, 0];
	const fx = from && from.width > 0 ? (c[0] - from.x) / from.width : 0.5;
	const fy = from && from.height > 0 ? (c[1] - from.y) / from.height : 0.5;
	const p = to ? { x: to.x + to.width * fx, y: to.y + to.height * fy } : { x: c[0], y: c[1] };
	const subpaths = path.subpaths.map((sp) => ({ closed: sp.closed, anchors: sp.anchors.map(() => ({ x: p.x, y: p.y })) }));
	const { transform: _t, ...rest } = path;
	return { ...rest, subpaths };
}

/**
 * Prepares two shapes for interpolation. Two paths morph directly; with a group on either side
 * the paths inside pair up in stacking order and those without a partner grow out of a point.
 * Shapes are blended in their parent's space.
 */
export function createVectorMorph(a: VectorNode, b: VectorNode, options: VectorMorphOptions = {}): VectorMorph {
	if (a.type === 'path' && b.type === 'path') {
		const at = preparePathMorph(a, b, options);
		return { at };
	}
	const pa = flattenPaths(a);
	const pb = flattenPaths(b);
	const ba = unionBounds(pa.map((e) => placedBounds(e.path, e.m)));
	const bb = unionBounds(pb.map((e) => placedBounds(e.path, e.m)));
	const id = options.id ?? a.id;
	const parts: ((t: number) => VectorPathNode)[] = [];
	const opacities: [number, number][] = [];
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i];
		const y = pb[i];
		const sub = { ...options, id: `${id}-${i}`, starts: undefined };
		if (x && y) {
			parts.push(preparePathMorph(x.path, y.path, sub, x.m, y.m));
			opacities.push([x.opacity, y.opacity]);
		} else if (x) {
			parts.push(preparePathMorph(x.path, collapsedPath(x.path, x.m, ba, bb), sub, x.m, IDENTITY_MATRIX));
			opacities.push([x.opacity, x.opacity]);
		} else if (y) {
			parts.push(preparePathMorph(collapsedPath(y.path, y.m, bb, ba), y.path, sub, IDENTITY_MATRIX, y.m));
			opacities.push([y.opacity, y.opacity]);
		}
	}
	return {
		at: (t) => {
			const children = parts.map((p, i) => {
				const n = p(t);
				const o = lerpN(opacities[i][0], opacities[i][1], t) * (n.opacity ?? 1);
				if (o < 1) n.opacity = o;
				else delete n.opacity;
				return n;
			});
			const group: VectorGroupNode = { id, type: 'group', children };
			return group;
		}
	};
}

/**
 * The in-between of two shapes at `t` (0 = `a`, 1 = `b`). Prepare once with
 * `createVectorMorph` when interpolating the same pair at many `t`.
 */
export function interpolateVectorPaths(a: VectorNode, b: VectorNode, t: number, options: VectorMorphOptions = {}): VectorNode {
	return createVectorMorph(a, b, options).at(t);
}

/** A keyframe of a path track: a shape at a time (ms), with the easing of the segment leaving it. */
export interface VectorPathKeyframe {
	time: number;
	value: VectorNode;
	easing?: AnimationEasing;
}

const keyframeMorphs = new WeakMap<VectorNode, WeakMap<VectorNode, VectorMorph>>();

/**
 * A path track's shape at `time`: before the first keyframe its shape, after the last the
 * last; in between the two keyframes morph (prepared once per pair and cached) at the eased
 * fraction. Easings that overshoot are clamped to the keys. `null` without keyframes.
 */
export function evaluateVectorPathKeyframes(keyframes: readonly VectorPathKeyframe[], time: number, options: VectorMorphOptions = {}): VectorNode | null {
	const keys = keyframes.filter((k) => Number.isFinite(k.time)).sort((x, y) => x.time - y.time);
	if (!keys.length) return null;
	if (!(time > keys[0].time)) return keys[0].value;
	const last = keys[keys.length - 1];
	if (time >= last.time) return last.value;
	let i = 0;
	while (i + 1 < keys.length && keys[i + 1].time <= time) i++;
	const a = keys[i];
	const b = keys[i + 1];
	if (time === a.time) return a.value;
	if (a.easing === 'hold') return a.value;
	const span = b.time - a.time;
	const u = Math.min(1, Math.max(0, evaluateEasing(a.easing, (time - a.time) / span, span)));
	let inner = keyframeMorphs.get(a.value);
	if (!inner) keyframeMorphs.set(a.value, (inner = new WeakMap()));
	let morph = inner.get(b.value);
	if (!morph) inner.set(b.value, (morph = createVectorMorph(a.value, b.value, options)));
	return morph.at(u);
}
