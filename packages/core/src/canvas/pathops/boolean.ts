/**
 * Curve-preserving boolean operations (union, intersection, difference, xor and divide) on
 * Bézier paths.
 *
 * Algorithm (planar arrangement of curve pieces + winding classification):
 * 1. Every segment of every operand (open subpaths closed for filling) is a *source*; it is
 *    cut into pieces monotone in x and y. Each piece remembers its source and its parameter
 *    range there, so results can be rebuilt from exact sub-curves of the inputs.
 * 2. Pieces are intersected pairwise (pruned by a sweep on x): lines analytically, curves by
 *    recursive subdivision down to flat sub-curves, chord intersection and Newton polishing.
 *    Endpoints lying on another piece (T-junctions, tangent touches), collinear / coincident
 *    overlaps and clusters of hits along a tangency are resolved first. Points closer than
 *    `epsilon` share one vertex. Splitting repeats until no piece crosses another.
 * 3. Coincident pieces (shared edges, identical curves) merge into one edge carrying every
 *    operand's signed multiplicity.
 * 4. Each edge is classified by casting a horizontal or vertical ray from its midpoint (the
 *    pieces are monotone, so a ray crosses each at most once); the operands' fill rules turn
 *    the winding numbers on both sides into inside flags and the operation picks the edges
 *    with the result on exactly one side.
 * 5. The kept edges are traced into rings, taking the sharpest left turn at each vertex
 *    (ties between tangent curves broken by a short chord along each curve), and consecutive
 *    pieces of one source are merged back into one exact sub-curve, so circles stay four
 *    cubics and rectangles four lines.
 *
 * When the curve engine fails (non-converging intersections on near-coincident curves,
 * an inconsistent arrangement) the operation falls back to the polygon engine
 * (`polygonBoolean`) on flattened input and reports it (`engine: 'polygon'`).
 *
 * Portions ported from vectorcraft-main/crates/pathops/src/boolean.rs (MIT OR Apache-2.0,
 * © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
 */
import type { Point } from '../types.js';
import {
	polygonBoolean,
	dividePolygons,
	type MultiPolygon,
	type PolygonBooleanOperation,
	type PolygonFillRule
} from '../polygonBoolean.js';
import { polygonToSvgPath } from '../shapeGeometry.js';
import {
	closeContour,
	contourSignedArea,
	contoursToPath,
	cross,
	dist,
	dot,
	flattenChain,
	isStraightSegment,
	monotoneParams,
	pathToContours,
	segmentDerivative,
	segmentLength,
	segmentNearest,
	segmentPoint,
	segmentTangent,
	solveMonotone,
	sub,
	subSegment,
	toBezierPath,
	windingNumber,
	type BezierContour,
	type BezierPath,
	type BezierPathInput,
	type BezierSegment
} from './bezier.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Boolean operations (same names as `polygonBoolean`). `xor` is Exclude. */
export type PathBooleanOperation = PolygonBooleanOperation;

/** A path with the fill rule it is read with (default `nonzero`). */
export interface PathOperand {
	path: BezierPathInput;
	fillRule?: PolygonFillRule;
}

export type PathOperandInput = BezierPathInput | PathOperand;

export interface PathOpsOptions {
	/**
	 * Distance below which points are treated as equal. Defaults to `1e-9` times the
	 * largest coordinate magnitude (at least `1e-9`).
	 */
	epsilon?: number;
	/** Fall back to the polygon engine when the curve engine fails (default `true`). */
	fallback?: boolean;
	/** Flattening tolerance used by the polygon fallback (default 0.05). */
	fallbackTolerance?: number;
	/** Called with the reason whenever the polygon fallback is used. */
	onFallback?: (reason: string) => void;
	/**
	 * Work budget of the curve–curve intersection search (flat sub-curve pairs per pair of
	 * pieces, default 20,000). Exceeding it (nearly coincident curves) falls back.
	 */
	subdivisionBudget?: number;
}

/** Which engine produced a result, and why the curve engine was not used. */
export interface PathOpsReport {
	engine: 'curve' | 'polygon';
	fallbackReason?: string;
	/** Set when the input cannot be processed at all (non-finite coordinates); the result is empty. */
	error?: string;
}

export interface PathBooleanResult extends PathOpsReport {
	path: BezierPath;
}

/** One region of `dividePaths`, with the indices of the operands that cover it. */
export interface PathPiece {
	path: BezierPath;
	operands: number[];
}

export interface DividePathsResult extends PathOpsReport {
	pieces: PathPiece[];
}

/** Raised by the curve engine when it cannot produce a reliable arrangement. */
export class PathOpsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PathOpsError';
	}
}

// ---------------------------------------------------------------------------
// Operands
// ---------------------------------------------------------------------------

interface NormalizedOperand {
	chains: BezierSegment[][];
	fillRule: PolygonFillRule;
}

function isOperandObject(input: PathOperandInput): input is PathOperand {
	return !!input && typeof input === 'object' && !Array.isArray(input) && 'path' in input;
}

function normalizeOperand(input: PathOperandInput): NormalizedOperand {
	const path = isOperandObject(input) ? input.path : input;
	const fillRule = isOperandObject(input) ? input.fillRule ?? 'nonzero' : 'nonzero';
	const chains: BezierSegment[][] = [];
	for (const contour of pathToContours(path ?? '')) {
		const chain = closeContour(contour, true);
		if (chain.length === 0) continue;
		for (const seg of chain) {
			for (const p of seg) {
				if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new PathOpsError(NON_FINITE);
			}
		}
		chains.push(chain);
	}
	return { chains, fillRule };
}

function scaleOf(operandChains: readonly (readonly (readonly BezierSegment[])[])[]): number {
	let max = 0;
	for (const chains of operandChains) {
		for (const chain of chains) {
			for (const seg of chain) {
				for (const [x, y] of seg) max = Math.max(max, Math.abs(x), Math.abs(y));
			}
		}
	}
	return Math.max(1, max);
}

// ---------------------------------------------------------------------------
// Arrangement data
// ---------------------------------------------------------------------------

interface Vertex {
	id: number;
	x: number;
	y: number;
	p: Point;
}

/** Merges points closer than `eps` (grid hash with neighbour lookup). */
class VertexPool {
	readonly vertices: Vertex[] = [];
	private readonly cells = new Map<string, number[]>();
	constructor(private readonly eps: number) {}

	get(x: number, y: number): Vertex {
		const cx = Math.floor(x / this.eps);
		const cy = Math.floor(y / this.eps);
		let best: Vertex | null = null;
		let bestDist = Infinity;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				const ids = this.cells.get(`${cx + dx},${cy + dy}`);
				if (!ids) continue;
				for (const id of ids) {
					const v = this.vertices[id];
					const d = Math.hypot(v.x - x, v.y - y);
					if (d <= this.eps && d < bestDist) {
						best = v;
						bestDist = d;
					}
				}
			}
		}
		if (best) return best;
		const vertex: Vertex = { id: this.vertices.length, x, y, p: [x, y] };
		this.vertices.push(vertex);
		const key = `${cx},${cy}`;
		const bucket = this.cells.get(key);
		if (bucket) bucket.push(vertex.id);
		else this.cells.set(key, [vertex.id]);
		return vertex;
	}
}

interface Source {
	seg: BezierSegment;
	line: boolean;
}

interface Piece {
	pts: Point[];
	a: Vertex;
	b: Vertex;
	operand: number;
	src: number;
	/** Source parameters at `a` and `b` (`s0 < s1`). */
	s0: number;
	s1: number;
	dirty: boolean;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

function hull(pts: readonly Point[]) {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const [x, y] of pts) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, maxX, minY, maxY };
}

/** Moves the end points of a segment onto two vertices, dragging the handles along. */
function snapEnds(pts: readonly Point[], a: Point, b: Point): Point[] {
	const n = pts.length;
	if (n === 2) return [a, b];
	const d0 = sub(a, pts[0]);
	const d1 = sub(b, pts[n - 1]);
	if (n === 3) {
		return [a, [pts[1][0] + (d0[0] + d1[0]) / 2, pts[1][1] + (d0[1] + d1[1]) / 2], b];
	}
	return [a, [pts[1][0] + d0[0], pts[1][1] + d0[1]], [pts[2][0] + d1[0], pts[2][1] + d1[1]], b];
}

function makePiece(
	pts: Point[],
	a: Vertex,
	b: Vertex,
	operand: number,
	src: number,
	s0: number,
	s1: number
): Piece {
	const snapped = snapEnds(pts, a.p, b.p);
	return { pts: snapped, a, b, operand, src, s0, s1, dirty: true, ...hull(snapped) };
}

// ---------------------------------------------------------------------------
// Intersections
// ---------------------------------------------------------------------------

interface PairEvent {
	tp: number;
	tq: number;
	point: Point;
	/** Set for shared end points and end points lying on the other piece. */
	anchor?: boolean;
	/** Shared vertex: nothing to split. */
	shared?: boolean;
}

interface IntersectContext {
	eps: number;
	leaves: number;
	budget: number;
}

const NON_FINITE = 'non-finite coordinates';

function flatness(pts: readonly Point[]): number {
	if (pts.length === 2) return 0;
	const a = pts[0];
	const b = pts[pts.length - 1];
	const chord = sub(b, a);
	const len = Math.hypot(chord[0], chord[1]);
	let worst = 0;
	for (let i = 1; i < pts.length - 1; i++) {
		const v = sub(pts[i], a);
		const d = len > 0 ? Math.abs(cross(chord, v)) / len : Math.hypot(v[0], v[1]);
		const along = len > 0 ? dot(chord, v) / len : 0;
		const over = Math.max(0, -along, along - len);
		worst = Math.max(worst, d, over);
	}
	return worst;
}

function split2(pts: readonly Point[]): [Point[], Point[]] {
	const n = pts.length;
	const mid = (p: Point, q: Point): Point => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
	if (n === 2) {
		const m = mid(pts[0], pts[1]);
		return [
			[pts[0], m],
			[m, pts[1]]
		];
	}
	if (n === 3) {
		const a = mid(pts[0], pts[1]);
		const b = mid(pts[1], pts[2]);
		const m = mid(a, b);
		return [
			[pts[0], a, m],
			[m, b, pts[2]]
		];
	}
	const a = mid(pts[0], pts[1]);
	const b = mid(pts[1], pts[2]);
	const c = mid(pts[2], pts[3]);
	const ab = mid(a, b);
	const bc = mid(b, c);
	const m = mid(ab, bc);
	return [
		[pts[0], a, ab, m],
		[m, bc, c, pts[3]]
	];
}

/** Closest points of two segments: parameters and distance. */
function closestSegmentPoints(a0: Point, a1: Point, b0: Point, b1: Point): { s: number; u: number; d: number } {
	const d1 = sub(a1, a0);
	const d2 = sub(b1, b0);
	const r = sub(a0, b0);
	const a = dot(d1, d1);
	const e = dot(d2, d2);
	const f = dot(d2, r);
	let s = 0;
	let u = 0;
	if (a <= 1e-300 && e <= 1e-300) return { s: 0, u: 0, d: dist(a0, b0) };
	if (a <= 1e-300) {
		u = Math.max(0, Math.min(1, f / e));
	} else {
		const c = dot(d1, r);
		if (e <= 1e-300) {
			s = Math.max(0, Math.min(1, -c / a));
		} else {
			const b = dot(d1, d2);
			const denom = a * e - b * b;
			s = denom > 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
			u = (b * s + f) / e;
			if (u < 0) {
				u = 0;
				s = Math.max(0, Math.min(1, -c / a));
			} else if (u > 1) {
				u = 1;
				s = Math.max(0, Math.min(1, (b - c) / a));
			}
		}
	}
	const pa: Point = [a0[0] + d1[0] * s, a0[1] + d1[1] * s];
	const pb: Point = [b0[0] + d2[0] * u, b0[1] + d2[1] * u];
	return { s, u, d: dist(pa, pb) };
}

/** Newton polishing of P(s) = Q(u). Returns the best parameters found. */
function polish(P: readonly Point[], Q: readonly Point[], s: number, u: number): { s: number; u: number; d: number } {
	let best = { s, u, d: dist(segmentPoint(P, s), segmentPoint(Q, u)) };
	for (let i = 0; i < 10 && best.d > 0; i++) {
		const f = sub(segmentPoint(P, s), segmentPoint(Q, u));
		const dp = segmentDerivative(P, s);
		const dq = segmentDerivative(Q, u);
		// Solve [dp, -dq] [ds, du]^T = -f
		const det = cross(dp, [-dq[0], -dq[1]]);
		if (!(Math.abs(det) > 1e-300)) break;
		const ds = cross([-f[0], -f[1]], [-dq[0], -dq[1]]) / det;
		const du = cross(dp, [-f[0], -f[1]]) / det;
		s = Math.max(0, Math.min(1, s + ds));
		u = Math.max(0, Math.min(1, u + du));
		const d = dist(segmentPoint(P, s), segmentPoint(Q, u));
		if (d < best.d) best = { s, u, d };
		else break;
	}
	return best;
}

function intersectSubdivided(
	P: Point[],
	p0: number,
	p1: number,
	Q: Point[],
	q0: number,
	q1: number,
	fullP: readonly Point[],
	fullQ: readonly Point[],
	ctx: IntersectContext,
	out: PairEvent[],
	depth: number
) {
	const hp = hull(P);
	const hq = hull(Q);
	const e = ctx.eps;
	if (hp.minX > hq.maxX + e || hq.minX > hp.maxX + e || hp.minY > hq.maxY + e || hq.minY > hp.maxY + e) return;
	const fp = flatness(P);
	const fq = flatness(Q);
	const flatTol = e * 0.5;
	if ((fp <= flatTol && fq <= flatTol) || depth >= 52) {
		if (++ctx.leaves > ctx.budget) throw new PathOpsError('curve intersection did not converge');
		const a0 = P[0];
		const a1 = P[P.length - 1];
		const b0 = Q[0];
		const b1 = Q[Q.length - 1];
		const d1 = sub(a1, a0);
		const d2 = sub(b1, b0);
		const denom = cross(d1, d2);
		let s = 0;
		let u = 0;
		let hit = false;
		const l1 = Math.hypot(d1[0], d1[1]);
		const l2 = Math.hypot(d2[0], d2[1]);
		if (Math.abs(denom) > 1e-12 * l1 * l2) {
			const r = sub(b0, a0);
			s = cross(r, d2) / denom;
			u = cross(r, d1) / denom;
			const ts = l1 > 0 ? e / l1 : 1;
			const tu = l2 > 0 ? e / l2 : 1;
			hit = s >= -ts && s <= 1 + ts && u >= -tu && u <= 1 + tu;
		}
		if (!hit) {
			// No crossing of the chords: a touch when they come within epsilon.
			const c = closestSegmentPoints(a0, a1, b0, b1);
			if (c.d > e) return;
			s = c.s;
			u = c.u;
		}
		s = Math.max(0, Math.min(1, s));
		u = Math.max(0, Math.min(1, u));
		const best = polish(fullP, fullQ, p0 + (p1 - p0) * s, q0 + (q1 - q0) * u);
		if (best.d > e * 2) return;
		const a = segmentPoint(fullP, best.s);
		const b = segmentPoint(fullQ, best.u);
		out.push({ tp: best.s, tq: best.u, point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
		return;
	}
	const splitP = fp > flatTol;
	const splitQ = fq > flatTol;
	const pm = (p0 + p1) / 2;
	const qm = (q0 + q1) / 2;
	if (splitP && splitQ) {
		const [pa, pb] = split2(P);
		const [qa, qb] = split2(Q);
		intersectSubdivided(pa, p0, pm, qa, q0, qm, fullP, fullQ, ctx, out, depth + 1);
		intersectSubdivided(pa, p0, pm, qb, qm, q1, fullP, fullQ, ctx, out, depth + 1);
		intersectSubdivided(pb, pm, p1, qa, q0, qm, fullP, fullQ, ctx, out, depth + 1);
		intersectSubdivided(pb, pm, p1, qb, qm, q1, fullP, fullQ, ctx, out, depth + 1);
	} else if (splitP) {
		const [pa, pb] = split2(P);
		intersectSubdivided(pa, p0, pm, Q, q0, q1, fullP, fullQ, ctx, out, depth + 1);
		intersectSubdivided(pb, pm, p1, Q, q0, q1, fullP, fullQ, ctx, out, depth + 1);
	} else {
		const [qa, qb] = split2(Q);
		intersectSubdivided(P, p0, p1, qa, q0, qm, fullP, fullQ, ctx, out, depth + 1);
		intersectSubdivided(P, p0, p1, qb, qm, q1, fullP, fullQ, ctx, out, depth + 1);
	}
}

/** A crossing or touch of two segments: the parameter on each and the point. */
export interface SegmentIntersection {
	ta: number;
	tb: number;
	point: Point;
}

/**
 * Every point where two segments (lines, quadratics or cubics, as control points) cross or
 * touch, by the same subdivision search the boolean operations use: flat sub-curves, chord
 * intersection, Newton polishing. Hits closer than `epsilon` (default: 1e-9 of the segments'
 * size) are one. Coincident stretches report the hits the search finds along them.
 */
export function segmentIntersections(a: BezierSegment, b: BezierSegment, options: { epsilon?: number; budget?: number } = {}): SegmentIntersection[] {
	let size = 1;
	for (const [x, y] of [...a, ...b]) size = Math.max(size, Math.abs(x), Math.abs(y));
	const eps = options.epsilon ?? size * 1e-9;
	const found: PairEvent[] = [];
	const ctx: IntersectContext = { eps, leaves: 0, budget: options.budget ?? 4096 };
	try {
		intersectSubdivided(a.slice(), 0, 1, b.slice(), 0, 1, a, b, ctx, found, 0);
	} catch (error) {
		if (!(error instanceof PathOpsError)) throw error;
	}
	const out: SegmentIntersection[] = [];
	for (const ev of found.sort((x, y) => x.tp - y.tp)) {
		if (out.some((o) => dist(o.point, ev.point) <= eps * 4)) continue;
		out.push({ ta: ev.tp, tb: ev.tq, point: ev.point });
	}
	return out;
}

function nearestOn(piece: Piece, p: Point, eps: number): { t: number; distance: number } | null {
	if (p[0] < piece.minX - eps || p[0] > piece.maxX + eps || p[1] < piece.minY - eps || p[1] > piece.maxY + eps) return null;
	return segmentNearest(piece.pts, p);
}

/** Whether the two pieces stay within `tol` of each other between two events. */
function staysClose(P: Piece, Q: Piece, e1: PairEvent, e2: PairEvent, tol: number): boolean {
	for (const f of [0.25, 0.5, 0.75]) {
		const tp = e1.tp + (e2.tp - e1.tp) * f;
		const q = segmentNearest(Q.pts, segmentPoint(P.pts, tp));
		if (q.distance > tol) return false;
	}
	return true;
}

function pairEvents(P: Piece, Q: Piece, ctx: IntersectContext): PairEvent[] {
	const eps = ctx.eps;
	const anchors: PairEvent[] = [];
	// Shared vertices.
	for (const [va, tp] of [
		[P.a, 0],
		[P.b, 1]
	] as const) {
		if (va === Q.a) anchors.push({ tp, tq: 0, point: va.p, anchor: true, shared: true });
		else if (va === Q.b) anchors.push({ tp, tq: 1, point: va.p, anchor: true, shared: true });
	}
	// End points lying on the other piece (T-junctions, overlaps).
	for (const [v, tq] of [
		[Q.a, 0],
		[Q.b, 1]
	] as const) {
		if (v === P.a || v === P.b) continue;
		const near = nearestOn(P, v.p, eps);
		if (near && near.distance <= eps) anchors.push({ tp: near.t, tq, point: v.p, anchor: true });
	}
	for (const [v, tp] of [
		[P.a, 0],
		[P.b, 1]
	] as const) {
		if (v === Q.a || v === Q.b) continue;
		const near = nearestOn(Q, v.p, eps);
		if (near && near.distance <= eps) anchors.push({ tp, tq: near.t, point: v.p, anchor: true });
	}

	// Coincident overlap: two anchors with the pieces running together between them.
	if (anchors.length >= 2) {
		const sorted = [...anchors].sort((x, y) => x.tp - y.tp);
		const first = sorted[0];
		const last = sorted[sorted.length - 1];
		if (dist(first.point, last.point) > eps && staysClose(P, Q, first, last, eps * 4)) {
			return anchors.filter((a) => !a.shared);
		}
	}

	const found: PairEvent[] = [];
	if (P.pts.length === 2 && Q.pts.length === 2) {
		const a0 = P.pts[0];
		const d1 = sub(P.pts[1], a0);
		const b0 = Q.pts[0];
		const d2 = sub(Q.pts[1], b0);
		const denom = cross(d1, d2);
		const l1 = Math.hypot(d1[0], d1[1]);
		const l2 = Math.hypot(d2[0], d2[1]);
		if (Math.abs(denom) > 1e-12 * l1 * l2) {
			const r = sub(b0, a0);
			const s = cross(r, d2) / denom;
			const u = cross(r, d1) / denom;
			const ts = eps / l1;
			const tu = eps / l2;
			if (s >= -ts && s <= 1 + ts && u >= -tu && u <= 1 + tu) {
				const sc = Math.max(0, Math.min(1, s));
				const uc = Math.max(0, Math.min(1, u));
				found.push({ tp: sc, tq: uc, point: [a0[0] + d1[0] * sc, a0[1] + d1[1] * sc] });
			}
		}
	} else {
		ctx.leaves = 0;
		intersectSubdivided(P.pts, 0, 1, Q.pts, 0, 1, P.pts, Q.pts, ctx, found, 0);
	}
	if (found.length === 0) return anchors.filter((a) => !a.shared);

	// Cluster hits along tangencies: consecutive events between which the pieces never
	// separate by more than a few epsilon are one contact.
	const all = [...anchors, ...found].sort((x, y) => x.tp - y.tp || x.tq - y.tq);
	const clusters: PairEvent[][] = [];
	for (const ev of all) {
		const cluster = clusters[clusters.length - 1];
		const prev = cluster?.[cluster.length - 1];
		if (prev && (dist(prev.point, ev.point) <= eps * 2 || staysClose(P, Q, prev, ev, eps * 2))) cluster.push(ev);
		else clusters.push([ev]);
	}
	const out: PairEvent[] = [];
	for (const cluster of clusters) {
		const shared = cluster.find((e) => e.shared);
		if (shared) continue;
		const anchor = cluster.find((e) => e.anchor);
		out.push(anchor ?? cluster[Math.floor(cluster.length / 2)]);
	}
	return out;
}

interface SplitPoint {
	t: number;
	v: Vertex;
}

function addSplit(map: Map<Piece, SplitPoint[]>, piece: Piece, t: number, v: Vertex) {
	if (v === piece.a || v === piece.b) return;
	const list = map.get(piece);
	if (list) list.push({ t, v });
	else map.set(piece, [{ t, v }]);
}

/** Resolves an event to a vertex, preferring the pieces' own end points. */
function eventVertex(P: Piece, Q: Piece, ev: PairEvent, pool: VertexPool, eps: number): Vertex {
	for (const v of [P.a, P.b, Q.a, Q.b]) if (dist(v.p, ev.point) <= eps) return v;
	return pool.get(ev.point[0], ev.point[1]);
}

function splitPass(pieces: Piece[], pool: VertexPool, ctx: IntersectContext): { pieces: Piece[]; changed: boolean } {
	const eps = ctx.eps;
	const order = pieces.map((_, i) => i).sort((i, j) => pieces[i].minX - pieces[j].minX);
	const splits = new Map<Piece, SplitPoint[]>();
	for (let oi = 0; oi < order.length; oi++) {
		const P = pieces[order[oi]];
		for (let oj = oi + 1; oj < order.length; oj++) {
			const Q = pieces[order[oj]];
			if (Q.minX > P.maxX + eps) break;
			if (!P.dirty && !Q.dirty) continue;
			if (Q.minY > P.maxY + eps || Q.maxY < P.minY - eps) continue;
			if (P.a === Q.a && P.b === Q.b && P.pts.length === 2 && Q.pts.length === 2) continue;
			if (P.a === Q.b && P.b === Q.a && P.pts.length === 2 && Q.pts.length === 2) continue;
			for (const ev of pairEvents(P, Q, ctx)) {
				const v = eventVertex(P, Q, ev, pool, eps);
				addSplit(splits, P, ev.tp, v);
				addSplit(splits, Q, ev.tq, v);
			}
		}
	}
	for (const p of pieces) p.dirty = false;
	if (splits.size === 0) return { pieces, changed: false };
	const out: Piece[] = [];
	for (const piece of pieces) {
		const list = splits.get(piece);
		if (!list) {
			out.push(piece);
			continue;
		}
		list.sort((x, y) => x.t - y.t);
		let prevT = 0;
		let prevV = piece.a;
		const range = piece.s1 - piece.s0;
		const emit = (t: number, v: Vertex) => {
			if (v === prevV || t <= prevT) return;
			const pts = subSegment(piece.pts, prevT, t);
			out.push(makePiece(pts, prevV, v, piece.operand, piece.src, piece.s0 + range * prevT, piece.s0 + range * t));
			prevT = t;
			prevV = v;
		};
		const seen = new Set<Vertex>();
		for (const { t, v } of list) {
			if (seen.has(v) || t <= 0 || t >= 1) continue;
			seen.add(v);
			emit(t, v);
		}
		if (prevV !== piece.b) {
			const pts = subSegment(piece.pts, prevT, 1);
			out.push(makePiece(pts, prevV, piece.b, piece.operand, piece.src, piece.s0 + range * prevT, piece.s1));
		}
	}
	return { pieces: out, changed: true };
}

// ---------------------------------------------------------------------------
// Edges and classification
// ---------------------------------------------------------------------------

interface Edge {
	a: Vertex;
	b: Vertex;
	/** Control points from `a` to `b`. */
	pts: Point[];
	mult: number[];
	src: number;
	/** Source parameters at `a` and at `b`. */
	sa: number;
	sb: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

interface Arrangement {
	edges: Edge[];
	left: number[][];
	right: number[][];
	fillRules: PolygonFillRule[];
	sources: Source[];
	eps: number;
	scale: number;
}

/** Cuts every chain of every operand into monotone pieces and splits them where they meet. */
function splitChains(
	operandChains: readonly (readonly (readonly BezierSegment[])[])[],
	options: PathOpsOptions
): { pieces: Piece[]; pool: VertexPool; sources: Source[]; eps: number; scale: number } {
	const scale = scaleOf(operandChains);
	const eps = options.epsilon && options.epsilon > 0 ? options.epsilon : 1e-9 * scale;
	const pool = new VertexPool(eps);
	const sources: Source[] = [];
	let pieces: Piece[] = [];
	operandChains.forEach((chains, operand) => {
		for (const chain of chains) {
			for (const raw of chain) {
				const straight = raw.length > 2 && isStraightSegment(raw, eps * 0.01);
				const seg: BezierSegment = straight ? [raw[0], raw[raw.length - 1]] : raw;
				const src = sources.length;
				sources.push({ seg, line: seg.length === 2 });
				const ts = [0, ...monotoneParams(seg), 1];
				for (let i = 0; i + 1 < ts.length; i++) {
					const pts = subSegment(seg, ts[i], ts[i + 1]);
					const a = pool.get(pts[0][0], pts[0][1]);
					const b = pool.get(pts[pts.length - 1][0], pts[pts.length - 1][1]);
					if (a === b) continue;
					pieces.push(makePiece(pts, a, b, operand, src, ts[i], ts[i + 1]));
				}
			}
		}
	});

	const ctx: IntersectContext = { eps, leaves: 0, budget: options.subdivisionBudget ?? 20000 };
	let settled = false;
	for (let pass = 0; pass < 6; pass++) {
		const result = splitPass(pieces, pool, ctx);
		pieces = result.pieces;
		if (!result.changed) {
			settled = true;
			break;
		}
	}
	if (!settled) throw new PathOpsError('intersections did not settle');
	return { pieces, pool, sources, eps, scale };
}

/** Whether two pieces between the same two vertices (`pts` in the same direction) coincide. */
function samePiece(e: readonly Point[], pts: readonly Point[], eps: number): boolean {
	if (e.length === 2 && pts.length === 2) return true;
	return segmentNearest(e, segmentPoint(pts, 0.5)).distance <= eps * 4 && segmentNearest(pts, segmentPoint(e, 0.5)).distance <= eps * 4;
}

function buildArrangement(inputs: PathOperandInput[], options: PathOpsOptions): Arrangement {
	const operands = inputs.map(normalizeOperand);
	const { pieces, sources, eps, scale } = splitChains(
		operands.map((o) => o.chains),
		options
	);

	// Merge coincident pieces.
	const count = operands.length;
	const groups = new Map<string, Edge[]>();
	const edges: Edge[] = [];
	for (const piece of pieces) {
		const forward = piece.a.id < piece.b.id;
		const a = forward ? piece.a : piece.b;
		const b = forward ? piece.b : piece.a;
		const pts = forward ? piece.pts : [...piece.pts].reverse();
		const key = `${a.id},${b.id}`;
		const group = groups.get(key) ?? [];
		if (!groups.has(key)) groups.set(key, group);
		let edge = group.find((e) => samePiece(e.pts, pts, eps));
		if (!edge) {
			edge = {
				a,
				b,
				pts,
				mult: new Array(count).fill(0),
				src: piece.src,
				sa: forward ? piece.s0 : piece.s1,
				sb: forward ? piece.s1 : piece.s0,
				...hull(pts)
			};
			group.push(edge);
			edges.push(edge);
		}
		edge.mult[piece.operand] += forward ? 1 : -1;
	}
	const live = edges.filter((e) => e.mult.some((m) => m !== 0));

	// Winding numbers on both sides of every edge. Rays only meet edges whose y range (x
	// range for vertical rays) holds the ray, so edges are bucketed into bands on each axis.
	const byY = new BandIndex(live, (e) => e.minY, (e) => e.maxY);
	const byX = new BandIndex(live, (e) => e.minX, (e) => e.maxX);
	const right: number[][] = [];
	const left: number[][] = [];
	for (let i = 0; i < live.length; i++) {
		const edge = live[i];
		const mid = segmentPoint(edge.pts, 0.5);
		const tan = segmentTangent(edge.pts, 0.5);
		const horizontal = Math.abs(tan[1]) < Math.abs(tan[0]);
		const winding = new Array(count).fill(0);
		const [mx, my] = mid;
		for (const j of horizontal ? byX.at(mx) : byY.at(my)) {
			if (j === i) continue;
			const o = live[j];
			let dir = 0;
			if (!horizontal) {
				// Ray towards +x.
				if (o.maxX <= mx) continue;
				const ay = o.a.y;
				const by = o.b.y;
				if (ay <= my && by > my) dir = 1;
				else if (by <= my && ay > my) dir = -1;
				else continue;
				if (o.minX <= mx) {
					const t = solveMonotone(o.pts, 1, my);
					if (!(segmentPoint(o.pts, t)[0] > mx)) continue;
				}
			} else {
				// Ray towards +y, in the frame rotated by −90° ((x, y) → (y, −x)).
				if (o.maxY <= my) continue;
				const ax = o.a.x;
				const bx = o.b.x;
				if (bx < mx && mx <= ax) dir = 1;
				else if (ax < mx && mx <= bx) dir = -1;
				else continue;
				if (o.minY <= my) {
					const t = solveMonotone(o.pts, 0, mx);
					if (!(segmentPoint(o.pts, t)[1] > my)) continue;
				}
			}
			for (let k = 0; k < count; k++) if (o.mult[k] !== 0) winding[k] += dir * o.mult[k];
		}
		const sideIsRight = horizontal ? edge.b.x < edge.a.x : edge.b.y > edge.a.y;
		const r = sideIsRight ? winding : winding.map((w, k) => w - edge.mult[k]);
		right.push(r);
		left.push(r.map((w, k) => w + edge.mult[k]));
	}
	return { edges: live, left, right, fillRules: operands.map((o) => o.fillRule), sources, eps, scale };
}

/** Edge indices bucketed into equal bands of one coordinate. */
class BandIndex {
	private readonly bands: number[][];
	private readonly min: number;
	private readonly size: number;
	constructor(edges: Edge[], lo: (e: Edge) => number, hi: (e: Edge) => number) {
		let min = Infinity;
		let max = -Infinity;
		for (const e of edges) {
			min = Math.min(min, lo(e));
			max = Math.max(max, hi(e));
		}
		const count = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(edges.length) * 2)));
		this.min = min;
		this.size = max > min ? (max - min) / count : 1;
		this.bands = Array.from({ length: count }, () => []);
		edges.forEach((e, i) => {
			const from = this.index(lo(e));
			const to = this.index(hi(e));
			for (let b = from; b <= to; b++) this.bands[b].push(i);
		});
	}
	private index(v: number): number {
		const k = Math.floor((v - this.min) / this.size);
		return Math.max(0, Math.min(this.bands.length - 1, Number.isFinite(k) ? k : 0));
	}
	at(v: number): readonly number[] {
		return this.bands[this.index(v)] ?? [];
	}
}

function insideFlags(windings: number[], fillRules: PolygonFillRule[]): boolean[] {
	return windings.map((w, k) => (fillRules[k] === 'evenodd' ? (w & 1) === 1 : w !== 0));
}

// ---------------------------------------------------------------------------
// Tracing and reconstruction
// ---------------------------------------------------------------------------

interface DirectedEdge {
	from: Vertex;
	to: Vertex;
	pts: Point[];
	src: number;
	sFrom: number;
	sTo: number;
	outAngle: number;
	backAngle: number;
	length: number;
}

const TWO_PI = Math.PI * 2;
const TIE = 1e-3;

function directed(edge: Edge, forward: boolean): DirectedEdge {
	const pts = forward ? edge.pts : [...edge.pts].reverse();
	const out = segmentTangent(pts, 0);
	const end = segmentTangent(pts, 1);
	return {
		from: forward ? edge.a : edge.b,
		to: forward ? edge.b : edge.a,
		pts,
		src: edge.src,
		sFrom: forward ? edge.sa : edge.sb,
		sTo: forward ? edge.sb : edge.sa,
		outAngle: Math.atan2(out[1], out[0]),
		backAngle: Math.atan2(-end[1], -end[0]),
		length: dist(pts[0], pts[pts.length - 1]) + (pts.length > 2 ? flatness(pts) : 0)
	};
}

/** Angle of the chord from the start of `pts` to the point at fraction `t` (by parameter). */
function chordAngle(pts: readonly Point[], t: number): number {
	const p = segmentPoint(pts, t);
	return Math.atan2(p[1] - pts[0][1], p[0] - pts[0][0]);
}

function mod2pi(a: number): number {
	const r = a - Math.floor(a / TWO_PI) * TWO_PI;
	return r >= TWO_PI ? 0 : r;
}

/** Traces the kept directed edges (result on the left) into rings. */
function traceRings(edges: DirectedEdge[], scale: number): DirectedEdge[][] {
	const outgoing = new Map<number, DirectedEdge[]>();
	for (const e of edges) {
		const list = outgoing.get(e.from.id);
		if (list) list.push(e);
		else outgoing.set(e.from.id, [e]);
	}
	const next = (incoming: DirectedEdge): DirectedEdge | undefined => {
		const candidates = outgoing.get(incoming.to.id)?.filter((c) => !used.has(c) || c === start);
		if (!candidates || candidates.length === 0) return undefined;
		if (candidates.length === 1) return candidates[0];
		const turns = candidates.map((c) => mod2pi(incoming.backAngle - c.outAngle));
		const tied = (x: number) => x < TIE || x > TWO_PI - TIE;
		let ambiguous = turns.some(tied);
		if (!ambiguous) {
			const sorted = [...turns].sort((a, b) => a - b);
			for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] < TIE) ambiguous = true;
		}
		if (ambiguous) {
			// Tangent directions tie (tangent curves): compare chords a short way along each
			// curve instead, which separates curves by their curvature.
			const back = [...incoming.pts].reverse();
			let delta = Math.min(incoming.length, ...candidates.map((c) => c.length));
			delta = Math.min(delta * 0.25, scale * 0.02);
			const frac = (e: DirectedEdge) => Math.min(1, Math.max(1e-6, delta / Math.max(e.length, 1e-300)));
			const backChord = chordAngle(back, frac(incoming));
			for (let i = 0; i < candidates.length; i++) {
				turns[i] = mod2pi(backChord - chordAngle(candidates[i].pts, frac(candidates[i])));
				if (turns[i] < 1e-12) turns[i] = TWO_PI;
			}
		} else {
			for (let i = 0; i < turns.length; i++) if (turns[i] < 1e-15) turns[i] = TWO_PI;
		}
		let best = 0;
		for (let i = 1; i < candidates.length; i++) if (turns[i] < turns[best]) best = i;
		return candidates[best];
	};

	const used = new Set<DirectedEdge>();
	const rings: DirectedEdge[][] = [];
	let start: DirectedEdge | null = null;
	for (const first of edges) {
		if (used.has(first)) continue;
		start = first;
		const ring: DirectedEdge[] = [];
		let edge: DirectedEdge | undefined = first;
		let guard = edges.length + 1;
		let closed = false;
		while (edge && guard-- > 0) {
			used.add(edge);
			ring.push(edge);
			edge = next(edge);
			if (edge === first) {
				closed = true;
				break;
			}
		}
		if (!closed) throw new PathOpsError('result outline does not close');
		rings.push(ring);
	}
	return rings;
}

function mergeable(a: DirectedEdge, b: DirectedEdge, sources: Source[], eps: number): boolean {
	if (a.src === b.src && Math.abs(a.sTo - b.sFrom) < 1e-9 && a.sTo - a.sFrom > 0 === b.sTo - b.sFrom > 0) return true;
	if (a.pts.length === 2 && b.pts.length === 2) {
		// Collinear lines from different sources (e.g. shared rectangle sides).
		const p = a.pts[0];
		const q = b.pts[1];
		const m = a.pts[1];
		const chord = sub(q, p);
		const len = Math.hypot(chord[0], chord[1]);
		if (len === 0) return false;
		const off = Math.abs(cross(chord, sub(m, p))) / len;
		const along = dot(chord, sub(m, p));
		return off <= eps && along > 0 && along < len * len;
	}
	void sources;
	return false;
}

/** Rebuilds a ring as segments: pieces of one source become one exact sub-curve. */
function rebuildRing(ring: DirectedEdge[], sources: Source[], eps: number): BezierSegment[] {
	const n = ring.length;
	let startIndex = 0;
	for (let k = 0; k < n; k++) {
		if (!mergeable(ring[(k + n - 1) % n], ring[k], sources, eps)) {
			startIndex = k;
			break;
		}
	}
	const ordered = [...ring.slice(startIndex), ...ring.slice(0, startIndex)];
	const out: BezierSegment[] = [];
	let i = 0;
	while (i < ordered.length) {
		const first = ordered[i];
		let j = i + 1;
		while (j < ordered.length && mergeable(ordered[j - 1], ordered[j], sources, eps)) j++;
		const last = ordered[j - 1];
		if (j - i === 1) {
			out.push(first.pts);
		} else if (first.pts.length === 2 && ordered.slice(i, j).every((e) => e.pts.length === 2)) {
			out.push([first.from.p, last.to.p]);
		} else {
			const source = sources[first.src];
			out.push(snapEnds(subSegment(source.seg, first.sFrom, last.sTo), first.from.p, last.to.p));
		}
		i = j;
	}
	return out;
}

interface Ring {
	segs: BezierSegment[];
	area: number;
}

function extractRings(arr: Arrangement, isInside: (flags: boolean[]) => boolean): Ring[] {
	const kept: DirectedEdge[] = [];
	arr.edges.forEach((edge, i) => {
		const l = isInside(insideFlags(arr.left[i], arr.fillRules));
		const r = isInside(insideFlags(arr.right[i], arr.fillRules));
		if (l === r) return;
		kept.push(directed(edge, l));
	});
	const rings: Ring[] = [];
	const sliver = Math.max(arr.eps * 10, 1e-7 * arr.scale);
	for (const ring of traceRings(kept, arr.scale)) {
		const segs = rebuildRing(ring, arr.sources, arr.eps);
		const area = contourSignedArea(segs);
		let perimeter = 0;
		for (const s of segs) perimeter += s.length === 2 ? dist(s[0], s[1]) : segmentLength(s, 0, 1, 1e-6);
		if (!(perimeter > 0) || (2 * Math.abs(area)) / perimeter < sliver) continue;
		rings.push({ segs, area });
	}
	return rings;
}

/** A point inside the region just left of a ring (for hole assignment). */
function ringSample(ring: Ring): Point {
	// The midpoint of the longest segment: never a vertex shared with another ring.
	let best = ring.segs[0];
	let bestLen = -1;
	for (const s of ring.segs) {
		const l = dist(s[0], s[s.length - 1]);
		if (l > bestLen) {
			best = s;
			bestLen = l;
		}
	}
	return segmentPoint(best, 0.5);
}

/** Groups rings into outer rings with their holes (counter-clockwise outers in a y-up frame). */
function groupRings(rings: Ring[]): Ring[][] {
	const outers = rings.filter((r) => r.area > 0).sort((a, b) => b.area - a.area);
	const holes = rings.filter((r) => r.area < 0);
	const groups: Ring[][] = outers.map((o) => [o]);
	for (const hole of holes) {
		const sample = ringSample(hole);
		for (let i = outers.length - 1; i >= 0; i--) {
			if (outers[i].area >= -hole.area && windingNumber([outers[i].segs], sample) !== 0) {
				groups[i].push(hole);
				break;
			}
		}
	}
	return groups;
}

function ringsToPath(rings: Ring[]): BezierPath {
	return contoursToPath(rings.map((r) => ({ segments: r.segs, closed: true })));
}

function predicate(operation: PathBooleanOperation): (flags: boolean[]) => boolean {
	switch (operation) {
		case 'union':
			return (f) => f.some(Boolean);
		case 'intersection':
			return (f) => f.length > 0 && f.every(Boolean);
		case 'difference':
			return (f) => f[0] === true && !f.slice(1).some(Boolean);
		case 'xor':
			return (f) => f.filter(Boolean).length % 2 === 1;
	}
}

// ---------------------------------------------------------------------------
// Polygon fallback
// ---------------------------------------------------------------------------

function flattenOperand(input: PathOperandInput, tolerance: number) {
	const path = isOperandObject(input) ? input.path : input;
	const fillRule = isOperandObject(input) ? input.fillRule ?? 'nonzero' : 'nonzero';
	const rings = pathToContours(path ?? '')
		.map((c) => flattenChain(closeContour(c, true), tolerance))
		.filter((r) => r.length >= 3 && r.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
	return { rings, fillRule };
}

function multiToPath(multi: MultiPolygon, tolerance: number): BezierPath {
	if (multi.length === 0) return [];
	return toBezierPath(polygonToSvgPath(multi, { curves: 'fit', curveTolerance: tolerance, precision: 9 }));
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/**
 * Applies a boolean operation to any number of path operands, keeping curves:
 * - `union`: covered by any operand.
 * - `intersection`: covered by every operand.
 * - `difference`: the first operand minus all others.
 * - `xor`: covered by an odd number of operands (Exclude).
 *
 * Open subpaths are closed for filling. Non-finite input gives an empty path (`error`); with
 * `fallback: false` a failure of the curve engine throws a `PathOpsError`. The result is a set of simple closed subpaths that
 * never cross (they may touch at points): outer subpaths run counter-clockwise in a y-up
 * frame (clockwise on screen), holes the other way, so it fills the same with `nonzero`
 * and `evenodd`. Segments of the inputs are kept as exact sub-curves.
 */
export function pathBoolean(
	operation: PathBooleanOperation,
	operands: PathOperandInput[],
	options: PathOpsOptions = {}
): PathBooleanResult {
	if (operands.length === 0) return { path: [], engine: 'curve' };
	try {
		const arr = buildArrangement(operands, options);
		return { path: ringsToPath(extractRings(arr, predicate(operation))), engine: 'curve' };
	} catch (error) {
		const reason = reasonOf(error);
		if (reason === NON_FINITE) return { path: [], engine: 'curve', error: reason };
		if (options.fallback === false) throw error;
		options.onFallback?.(reason);
		const tolerance = options.fallbackTolerance ?? 0.05;
		const multi = polygonBoolean(
			operation,
			operands.map((o) => flattenOperand(o, tolerance)),
			{ epsilon: options.epsilon }
		);
		return { path: multiToPath(multi, tolerance), engine: 'polygon', fallbackReason: reason };
	}
}

export const unitePaths = (a: PathOperandInput, b: PathOperandInput, options?: PathOpsOptions) =>
	pathBoolean('union', [a, b], options).path;
export const intersectPaths = (a: PathOperandInput, b: PathOperandInput, options?: PathOpsOptions) =>
	pathBoolean('intersection', [a, b], options).path;
export const subtractPaths = (a: PathOperandInput, b: PathOperandInput, options?: PathOpsOptions) =>
	pathBoolean('difference', [a, b], options).path;
export const excludePaths = (a: PathOperandInput, b: PathOperandInput, options?: PathOpsOptions) =>
	pathBoolean('xor', [a, b], options).path;

/**
 * Splits the arrangement of the operands into its regions (Divide): every connected area
 * covered by the same set of operands becomes one piece (an outer subpath with its holes).
 * Pieces are ordered by operand set, then by area (largest first).
 */
export function dividePaths(operands: PathOperandInput[], options: PathOpsOptions = {}): DividePathsResult {
	if (operands.length === 0) return { pieces: [], engine: 'curve' };
	try {
		const arr = buildArrangement(operands, options);
		const signatures = new Map<string, number[]>();
		const note = (windings: number[]) => {
			const flags = insideFlags(windings, arr.fillRules);
			if (!flags.some(Boolean)) return;
			const key = flags.map((f) => (f ? '1' : '0')).join('');
			if (!signatures.has(key)) signatures.set(key, flags.flatMap((f, k) => (f ? [k] : [])));
		};
		arr.edges.forEach((_, i) => {
			note(arr.left[i]);
			note(arr.right[i]);
		});
		const pieces: PathPiece[] = [];
		for (const key of [...signatures.keys()].sort()) {
			const rings = extractRings(arr, (flags) => flags.map((f) => (f ? '1' : '0')).join('') === key);
			const groups = groupRings(rings).sort((a, b) => b[0].area - a[0].area);
			for (const group of groups) pieces.push({ path: ringsToPath(group), operands: signatures.get(key)! });
		}
		return { pieces, engine: 'curve' };
	} catch (error) {
		const reason = reasonOf(error);
		if (reason === NON_FINITE) return { pieces: [], engine: 'curve', error: reason };
		if (options.fallback === false) throw error;
		options.onFallback?.(reason);
		const tolerance = options.fallbackTolerance ?? 0.05;
		const pieces = dividePolygons(
			operands.map((o) => flattenOperand(o, tolerance)),
			{ epsilon: options.epsilon }
		).map((p) => ({ path: multiToPath([p.polygon], tolerance), operands: p.operands }));
		return { pieces, engine: 'polygon', fallbackReason: reason };
	}
}

/**
 * Resolves self-intersections and overlaps of one filled path into simple, consistently
 * oriented subpaths (outer subpaths and holes) under its fill rule.
 */
export function normalizeBezierPath(
	path: BezierPathInput,
	fillRule: PolygonFillRule = 'nonzero',
	options: PathOpsOptions = {}
): BezierPath {
	return pathBoolean('union', [{ path, fillRule }], options).path;
}

/** Filled area of a path under its fill rule (overlaps counted once; exact for curves). */
export function bezierPathArea(path: BezierPathInput, fillRule: PolygonFillRule = 'nonzero', options: PathOpsOptions = {}): number {
	const normalized = normalizeBezierPath(path, fillRule, options);
	let sum = 0;
	for (const contour of pathToContours(normalized)) sum += contourSignedArea(closeContour(contour, true));
	return Math.abs(sum);
}

/**
 * Normalised rings of a filled path with their nesting: used by offset / outline stroke to
 * drop spurious contours. `parent` is the index of the smallest enclosing ring.
 */
export interface NestedRing {
	segments: BezierSegment[];
	area: number;
	parent: number;
}

/** Internal: rings of a boolean result with their containment tree. */
export function pathBooleanRings(
	operation: PathBooleanOperation | ((flags: boolean[]) => boolean),
	operands: PathOperandInput[],
	options: PathOpsOptions = {}
): NestedRing[] {
	const arr = buildArrangement(operands, options);
	const rings = extractRings(arr, typeof operation === 'function' ? operation : predicate(operation));
	const order = rings.map((_, i) => i).sort((a, b) => Math.abs(rings[a].area) - Math.abs(rings[b].area));
	return rings.map((ring, i) => {
		const sample = ringSample(ring);
		let parent = -1;
		for (const j of order) {
			if (j === i || Math.abs(rings[j].area) <= Math.abs(ring.area)) continue;
			if (windingNumber([rings[j].segs], sample) !== 0) {
				parent = j;
				break;
			}
		}
		return { segments: ring.segs, area: ring.area, parent };
	});
}

/** Contours of nested rings, keeping the ones `keep` accepts. */
export function nestedRingsToPath(rings: NestedRing[], keep: (index: number) => boolean = () => true): BezierPath {
	const contours: BezierContour[] = [];
	rings.forEach((r, i) => {
		if (keep(i)) contours.push({ segments: r.segments, closed: true });
	});
	return contoursToPath(contours);
}

// ---------------------------------------------------------------------------
// Planar split (for planar maps: Shape Builder, fill regions, Pathfinder Outline)
// ---------------------------------------------------------------------------

/** One edge of `planarSplit`: a piece of an input segment between two vertices. */
export interface PlanarSplitEdge {
	/** Vertex indices at the start and end of `pts`. */
	a: number;
	b: number;
	/** Control points from vertex `a` to vertex `b`. */
	pts: Point[];
	/** Inputs whose chains run along this edge, ascending (several where outlines coincide). */
	operands: number[];
	/** The source segment it is a piece of (index into `sources`) and its parameters there at `a` and `b`. */
	src: number;
	sa: number;
	sb: number;
}

export interface PlanarSplitResult {
	vertices: Point[];
	edges: PlanarSplitEdge[];
	/** The input segments, as `src` refers to them. */
	sources: BezierSegment[];
	eps: number;
	scale: number;
}

/**
 * The chains of every input (open or closed, as given: nothing is closed for filling) split
 * wherever they cross or touch each other or themselves, with the same intersection search as
 * the boolean operations. Coincident pieces become one edge that lists every input along it.
 * Throws a `PathOpsError` when the search does not settle or the input is not finite.
 */
export function planarSplit(inputs: readonly (readonly (readonly BezierSegment[])[])[], options: PathOpsOptions = {}): PlanarSplitResult {
	for (const chains of inputs) {
		for (const chain of chains) {
			for (const seg of chain) for (const p of seg) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new PathOpsError(NON_FINITE);
		}
	}
	const { pieces, pool, sources, eps, scale } = splitChains(inputs, options);
	const groups = new Map<string, PlanarSplitEdge[]>();
	const edges: PlanarSplitEdge[] = [];
	for (const piece of pieces) {
		const forward = piece.a.id < piece.b.id;
		const a = forward ? piece.a : piece.b;
		const b = forward ? piece.b : piece.a;
		const pts = forward ? piece.pts : [...piece.pts].reverse();
		const key = `${a.id},${b.id}`;
		let group = groups.get(key);
		if (!group) groups.set(key, (group = []));
		const edge = group.find((e) => samePiece(e.pts, pts, eps));
		if (edge) {
			if (!edge.operands.includes(piece.operand)) edge.operands = [...edge.operands, piece.operand].sort((x, y) => x - y);
			continue;
		}
		const created: PlanarSplitEdge = { a: a.id, b: b.id, pts, operands: [piece.operand], src: piece.src, sa: forward ? piece.s0 : piece.s1, sb: forward ? piece.s1 : piece.s0 };
		group.push(created);
		edges.push(created);
	}
	return { vertices: pool.vertices.map((v) => v.p), edges, sources: sources.map((s) => s.seg), eps, scale };
}

/** Result of `pathBooleanSelect`: per selector, its connected parts (each an outer subpath with its holes). */
export interface PathSelectResult extends PathOpsReport {
	parts: BezierPath[][];
}

/**
 * Several boolean selections over one arrangement of the operands (the Pathfinder panel's
 * Trim, Merge, Crop and Minus Back are each a selection per output). A selector gets the
 * ascending indices of the operands covering an area and keeps the area when it returns true.
 * Each selection comes back as its connected parts, largest first, built as `pathBoolean`
 * builds its result; areas that only touch at an edge are one part. Falls back to the
 * polygon engine like `pathBoolean`.
 */
export function pathBooleanSelect(
	operands: PathOperandInput[],
	selectors: readonly ((covering: readonly number[]) => boolean)[],
	options: PathOpsOptions = {}
): PathSelectResult {
	if (operands.length === 0) return { parts: selectors.map(() => []), engine: 'curve' };
	const covering = (flags: boolean[]) => flags.flatMap((f, k) => (f ? [k] : []));
	try {
		const arr = buildArrangement(operands, options);
		const parts = selectors.map((select) => {
			const rings = extractRings(arr, (flags) => select(covering(flags)));
			return groupRings(rings)
				.sort((a, b) => b[0].area - a[0].area)
				.map(ringsToPath);
		});
		return { parts, engine: 'curve' };
	} catch (error) {
		const reason = reasonOf(error);
		if (reason === NON_FINITE) return { parts: selectors.map(() => []), engine: 'curve', error: reason };
		if (options.fallback === false) throw error;
		options.onFallback?.(reason);
		const tolerance = options.fallbackTolerance ?? 0.05;
		const pieces = dividePolygons(
			operands.map((o) => flattenOperand(o, tolerance)),
			{ epsilon: options.epsilon }
		);
		const parts = selectors.map((select) => {
			const picked = pieces.filter((p) => select(p.operands));
			if (!picked.length) return [];
			const multi = polygonBoolean('union', [picked.map((p) => p.polygon)], { epsilon: options.epsilon });
			return multi.map((polygon) => multiToPath([polygon], tolerance));
		});
		return { parts, engine: 'polygon', fallbackReason: reason };
	}
}
