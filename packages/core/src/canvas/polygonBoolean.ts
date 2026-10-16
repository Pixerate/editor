/**
 * Polygon boolean operations (union, intersection, difference, xor and divide) on
 * multi-polygons with holes.
 *
 * Algorithm (overlay + winding classification):
 * 1. Every input edge is collected into one segment set. Vertices are merged through a
 *    tolerance-aware point pool, so points closer than `epsilon` become one vertex.
 * 2. Segments are split at every crossing, T-junction and collinear overlap until no two
 *    segments cross (a planar arrangement). Splitting is repeated because snapping a new
 *    vertex can move a segment by up to `epsilon`.
 * 3. Coincident segments (shared edges) are merged, keeping for every operand the signed
 *    number of its edges that run along the segment.
 * 4. For every segment the winding number of each operand on its right side is computed
 *    with a ray cast from the segment midpoint (the segment itself excluded), and the left
 *    side follows from the signed multiplicities. The fill rule turns windings into
 *    inside / outside flags and the operation decides whether each side is in the result.
 * 5. Segments with the result on exactly one side are kept, oriented with the result on
 *    their left, and traced into rings (taking the sharpest left turn at shared vertices,
 *    so rings that touch at a vertex stay separate simple rings). Rings with a positive
 *    signed area are outer rings; negative ones are holes, assigned to the smallest outer
 *    ring that contains them.
 *
 * Handles shared edges, touching vertices, collinear overlaps, holes, nested and disjoint
 * inputs and self-intersecting input rings (resolved by the operand's fill rule).
 *
 * Limits: the overlay is O(n²) in the number of edges (pruned by a sweep on x), which is
 * comfortable for canvas shapes (thousands of edges) but not for GIS-scale data. Features
 * narrower than `epsilon` collapse. Coordinates must be finite.
 */
import type { Point } from './types.js';

/** A closed ring of points. The closing point may be repeated or omitted. */
export type PolygonRing = Point[];
/** A polygon: the outer ring followed by its holes. */
export type PolygonWithHoles = PolygonRing[];
/** A set of polygons. */
export type MultiPolygon = PolygonWithHoles[];

/** SVG fill rule used to decide which areas of a ring set are inside. */
export type PolygonFillRule = 'nonzero' | 'evenodd';

/** Boolean operations. `xor` is Freeform's Exclude. */
export type PolygonBooleanOperation = 'union' | 'intersection' | 'difference' | 'xor';

/**
 * A raw ring set with a fill rule (e.g. flattened SVG path data). Ring orientation is
 * significant for `nonzero`.
 */
export interface PolygonOperand {
	rings: PolygonRing[];
	fillRule?: PolygonFillRule;
}

export type PolygonInput = MultiPolygon | PolygonOperand;

export interface PolygonBooleanOptions {
	/**
	 * Distance below which points are treated as equal. Defaults to `1e-9` times the
	 * largest coordinate magnitude of the inputs (at least `1e-9`).
	 */
	epsilon?: number;
}

/** One region of `dividePolygons`, with the indices of the operands that cover it. */
export interface PolygonPiece {
	polygon: PolygonWithHoles;
	operands: number[];
}

// ---------------------------------------------------------------------------
// Basic measures
// ---------------------------------------------------------------------------

/** Signed shoelace area of a ring (positive when counter-clockwise in a y-up frame). */
export function ringSignedArea(ring: readonly Point[]): number {
	let sum = 0;
	const n = ring.length;
	for (let i = 0; i < n; i++) {
		const [x1, y1] = ring[i];
		const [x2, y2] = ring[(i + 1) % n];
		sum += x1 * y2 - x2 * y1;
	}
	return sum / 2;
}

/** Area of a polygon (outer ring minus holes). */
export function polygonArea(polygon: PolygonWithHoles): number {
	if (polygon.length === 0) return 0;
	let area = Math.abs(ringSignedArea(polygon[0]));
	for (let i = 1; i < polygon.length; i++) area -= Math.abs(ringSignedArea(polygon[i]));
	return area;
}

/** Total area of a multi-polygon (holes subtracted). */
export function multiPolygonArea(multi: MultiPolygon): number {
	let total = 0;
	for (const polygon of multi) total += polygonArea(polygon);
	return total;
}

/** Axis-aligned bounds of a multi-polygon (or ring list), or `null` when empty. */
export function multiPolygonBounds(
	input: MultiPolygon | PolygonRing[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const visit = (ring: PolygonRing) => {
		for (const [x, y] of ring) {
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x > maxX) maxX = x;
			if (y > maxY) maxY = y;
		}
	};
	for (const item of input as any[]) {
		if (item.length > 0 && Array.isArray(item[0]) && Array.isArray(item[0][0])) {
			for (const ring of item as PolygonRing[]) visit(ring);
		} else {
			visit(item as PolygonRing);
		}
	}
	return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/**
 * Whether a point is inside a ring set under a fill rule. Points exactly on an edge may
 * report either side.
 */
export function pointInRings(
	point: Point,
	rings: readonly (readonly Point[])[],
	fillRule: PolygonFillRule = 'nonzero'
): boolean {
	const [px, py] = point;
	let winding = 0;
	for (const ring of rings) {
		const n = ring.length;
		for (let i = 0; i < n; i++) {
			const [ax, ay] = ring[i];
			const [bx, by] = ring[(i + 1) % n];
			if (ay <= py && by > py) {
				if (ax + ((py - ay) / (by - ay)) * (bx - ax) > px) winding++;
			} else if (by <= py && ay > py) {
				if (ax + ((py - ay) / (by - ay)) * (bx - ax) > px) winding--;
			}
		}
	}
	return fillRule === 'evenodd' ? (winding & 1) === 1 : winding !== 0;
}

/** Whether a point is inside a multi-polygon (holes excluded). */
export function pointInMultiPolygon(point: Point, multi: MultiPolygon): boolean {
	return multi.some((polygon) => pointInRings(point, polygon, 'evenodd'));
}

// ---------------------------------------------------------------------------
// Operand normalisation
// ---------------------------------------------------------------------------

function cleanRing(ring: readonly Point[]): Point[] {
	const out: Point[] = [];
	for (const p of ring) {
		if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
		const last = out[out.length - 1];
		if (last && last[0] === p[0] && last[1] === p[1]) continue;
		out.push([p[0], p[1]]);
	}
	while (out.length > 1) {
		const first = out[0];
		const last = out[out.length - 1];
		if (first[0] === last[0] && first[1] === last[1]) out.pop();
		else break;
	}
	return out;
}

function isOperand(input: PolygonInput): input is PolygonOperand {
	return !Array.isArray(input) && typeof input === 'object' && input !== null && Array.isArray(input.rings);
}

interface NormalizedOperand {
	rings: Point[][];
	fillRule: PolygonFillRule;
}

/**
 * Multi-polygons are re-oriented (outer rings positive, holes negative) and filled with
 * `nonzero`, so overlapping polygons in one operand behave as their union.
 */
function normalizeInput(input: PolygonInput): NormalizedOperand {
	if (isOperand(input)) {
		return {
			rings: input.rings.map(cleanRing).filter((r) => r.length >= 3),
			fillRule: input.fillRule ?? 'nonzero'
		};
	}
	const rings: Point[][] = [];
	for (const polygon of input ?? []) {
		polygon.forEach((raw, index) => {
			const ring = cleanRing(raw);
			if (ring.length < 3) return;
			const area = ringSignedArea(ring);
			if (area === 0) return;
			const wantPositive = index === 0;
			rings.push(area > 0 === wantPositive ? ring : ring.reverse());
		});
	}
	return { rings, fillRule: 'nonzero' };
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

interface Vertex {
	id: number;
	x: number;
	y: number;
}

/** Merges points closer than `eps` (grid hash with neighbour lookup). */
class PointPool {
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
		const vertex: Vertex = { id: this.vertices.length, x, y };
		this.vertices.push(vertex);
		const key = `${cx},${cy}`;
		const bucket = this.cells.get(key);
		if (bucket) bucket.push(vertex.id);
		else this.cells.set(key, [vertex.id]);
		return vertex;
	}
}

interface RawSegment {
	a: Vertex;
	b: Vertex;
	operand: number;
}

interface Splits {
	segment: RawSegment;
	points: Map<number, { t: number; v: Vertex }>;
}

/** Projection parameter of `p` on `a→b` and its distance to the segment line. */
function project(a: Vertex, b: Vertex, p: Vertex): { t: number; dist: number } {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
	const cx = a.x + t * dx;
	const cy = a.y + t * dy;
	return { t, dist: Math.hypot(p.x - cx, p.y - cy) };
}

function addSplit(splits: Splits, t: number, v: Vertex) {
	const { a, b } = splits.segment;
	if (v.id === a.id || v.id === b.id) return;
	if (!splits.points.has(v.id)) splits.points.set(v.id, { t, v });
}

/** One pass: splits every segment at crossings / touches with other segments. */
function splitPass(segments: RawSegment[], pool: PointPool, eps: number): { segments: RawSegment[]; changed: boolean } {
	const order = segments
		.map((s, i) => ({
			i,
			minX: Math.min(s.a.x, s.b.x),
			maxX: Math.max(s.a.x, s.b.x),
			minY: Math.min(s.a.y, s.b.y),
			maxY: Math.max(s.a.y, s.b.y)
		}))
		.sort((p, q) => p.minX - q.minX);
	const splits: Splits[] = segments.map((segment) => ({ segment, points: new Map() }));

	for (let oi = 0; oi < order.length; oi++) {
		const bi = order[oi];
		const s1 = segments[bi.i];
		for (let oj = oi + 1; oj < order.length; oj++) {
			const bj = order[oj];
			if (bj.minX > bi.maxX + eps) break;
			if (bj.minY > bi.maxY + eps || bj.maxY < bi.minY - eps) continue;
			const s2 = segments[bj.i];
			const sharedA = s1.a.id === s2.a.id || s1.a.id === s2.b.id;
			const sharedB = s1.b.id === s2.a.id || s1.b.id === s2.b.id;
			if (sharedA && sharedB) continue; // identical (or reversed) segment

			let touched = false;
			// Endpoints of one segment lying on the other: T-junctions and collinear overlaps.
			for (const [seg, other, split] of [
				[s1, s2, splits[bi.i]],
				[s2, s1, splits[bj.i]]
			] as const) {
				for (const p of [other.a, other.b]) {
					if (p.id === seg.a.id || p.id === seg.b.id) continue;
					const { t, dist } = project(seg.a, seg.b, p);
					const len = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
					if (dist <= eps && t * len > eps && (1 - t) * len > eps) {
						addSplit(split, t, p);
						touched = true;
					}
				}
			}
			if (touched) continue;

			// Proper crossing.
			const d1x = s1.b.x - s1.a.x;
			const d1y = s1.b.y - s1.a.y;
			const d2x = s2.b.x - s2.a.x;
			const d2y = s2.b.y - s2.a.y;
			const denom = d1x * d2y - d1y * d2x;
			const len1 = Math.hypot(d1x, d1y);
			const len2 = Math.hypot(d2x, d2y);
			if (Math.abs(denom) <= 1e-12 * len1 * len2) continue; // parallel
			const ex = s2.a.x - s1.a.x;
			const ey = s2.a.y - s1.a.y;
			const t = (ex * d2y - ey * d2x) / denom;
			const u = (ex * d1y - ey * d1x) / denom;
			const tolT = eps / len1;
			const tolU = eps / len2;
			if (t < -tolT || t > 1 + tolT || u < -tolU || u > 1 + tolU) continue;
			if (sharedA || sharedB) continue; // they meet at the shared endpoint only
			const v = pool.get(s1.a.x + t * d1x, s1.a.y + t * d1y);
			addSplit(splits[bi.i], project(s1.a, s1.b, v).t, v);
			addSplit(splits[bj.i], project(s2.a, s2.b, v).t, v);
		}
	}

	let changed = false;
	const out: RawSegment[] = [];
	for (const { segment, points } of splits) {
		if (points.size === 0) {
			out.push(segment);
			continue;
		}
		changed = true;
		const ordered = [...points.values()].sort((p, q) => p.t - q.t);
		let prev = segment.a;
		for (const { v } of ordered) {
			if (v.id !== prev.id) out.push({ a: prev, b: v, operand: segment.operand });
			prev = v;
		}
		if (prev.id !== segment.b.id) out.push({ a: prev, b: segment.b, operand: segment.operand });
	}
	return { segments: out, changed };
}

interface Edge {
	a: Vertex;
	b: Vertex;
	/** Signed multiplicity per operand (+1 per edge running a→b, −1 per edge running b→a). */
	mult: number[];
}

interface Overlay {
	edges: Edge[];
	/** Winding number per operand on the right of each edge. */
	right: number[][];
	/** Winding number per operand on the left of each edge. */
	left: number[][];
	fillRules: PolygonFillRule[];
	eps: number;
}

function defaultEpsilon(operands: NormalizedOperand[]): number {
	let max = 0;
	for (const op of operands) {
		for (const ring of op.rings) {
			for (const [x, y] of ring) {
				const m = Math.max(Math.abs(x), Math.abs(y));
				if (m > max) max = m;
			}
		}
	}
	return Math.max(1e-9, max * 1e-9);
}

function buildOverlay(inputs: PolygonInput[], options: PolygonBooleanOptions): Overlay {
	const operands = inputs.map(normalizeInput);
	const eps = options.epsilon && options.epsilon > 0 ? options.epsilon : defaultEpsilon(operands);
	const pool = new PointPool(eps);
	let segments: RawSegment[] = [];
	operands.forEach((op, operand) => {
		for (const ring of op.rings) {
			const verts = ring.map(([x, y]) => pool.get(x, y));
			for (let i = 0; i < verts.length; i++) {
				const a = verts[i];
				const b = verts[(i + 1) % verts.length];
				if (a.id !== b.id) segments.push({ a, b, operand });
			}
		}
	});

	for (let pass = 0; pass < 8; pass++) {
		const result = splitPass(segments, pool, eps);
		segments = result.segments;
		if (!result.changed) break;
	}

	// Merge coincident segments.
	const count = operands.length;
	const byKey = new Map<string, Edge>();
	for (const s of segments) {
		const forward = s.a.id < s.b.id;
		const a = forward ? s.a : s.b;
		const b = forward ? s.b : s.a;
		const key = `${a.id},${b.id}`;
		let edge = byKey.get(key);
		if (!edge) {
			edge = { a, b, mult: new Array(count).fill(0) };
			byKey.set(key, edge);
		}
		edge.mult[s.operand] += forward ? 1 : -1;
	}
	const edges = [...byKey.values()].filter((e) => e.mult.some((m) => m !== 0));

	const right: number[][] = [];
	const left: number[][] = [];
	// Rays only meet edges whose span on the ray's axis covers the ray: index the edges in bands
	// along each of the two axes rays run across, so each ray tests one band, not every edge.
	const bandCount = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(edges.length))));
	const bandIndex = (horizontal: boolean) => {
		const lo = (e: Overlay['edges'][number]) => (horizontal ? Math.min(-e.a.x, -e.b.x) : Math.min(e.a.y, e.b.y));
		const hi = (e: Overlay['edges'][number]) => (horizontal ? Math.max(-e.a.x, -e.b.x) : Math.max(e.a.y, e.b.y));
		let min = Infinity;
		let max = -Infinity;
		for (const e of edges) {
			min = Math.min(min, lo(e));
			max = Math.max(max, hi(e));
		}
		const size = max > min ? (max - min) / bandCount : 1;
		const band = (v: number) => Math.min(bandCount - 1, Math.max(0, Math.floor((v - min) / size)));
		const bands: number[][] = Array.from({ length: bandCount }, () => []);
		edges.forEach((e, j) => {
			for (let k = band(lo(e)); k <= band(hi(e)); k++) bands[k].push(j);
		});
		return (v: number) => bands[band(v)];
	};
	const bandsFor = new Map<boolean, (v: number) => number[]>();
	for (let i = 0; i < edges.length; i++) {
		const edge = edges[i];
		// Cast the ray across the edge rather than along it: rotating by −90° keeps windings
		// and turns a mostly horizontal edge into a mostly vertical one.
		const horizontal = Math.abs(edge.b.y - edge.a.y) < Math.abs(edge.b.x - edge.a.x);
		const tx = (v: Vertex) => (horizontal ? v.y : v.x);
		const ty = (v: Vertex) => (horizontal ? -v.x : v.y);
		const ax = tx(edge.a);
		const ay = ty(edge.a);
		const bx = tx(edge.b);
		const by = ty(edge.b);
		const mx = (ax + bx) / 2;
		const my = (ay + by) / 2;
		const winding = new Array(count).fill(0);
		if (!bandsFor.has(horizontal)) bandsFor.set(horizontal, bandIndex(horizontal));
		for (const j of bandsFor.get(horizontal)!(my)) {
			if (j === i) continue;
			const other = edges[j];
			const oax = tx(other.a);
			const oay = ty(other.a);
			const obx = tx(other.b);
			const oby = ty(other.b);
			let dir = 0;
			if (oay <= my && oby > my) dir = 1;
			else if (oby <= my && oay > my) dir = -1;
			else continue;
			const x = oax + ((my - oay) / (oby - oay)) * (obx - oax);
			if (x <= mx) continue;
			for (let k = 0; k < count; k++) {
				if (other.mult[k] !== 0) winding[k] += dir * other.mult[k];
			}
		}
		// The ray starts just past the midpoint on the +x side, which is the right of the
		// edge when it points up (dy > 0) and its left otherwise.
		const sideIsRight = by > ay;
		const r = sideIsRight ? winding : winding.map((w, k) => w - edge.mult[k]);
		right.push(r);
		left.push(r.map((w, k) => w + edge.mult[k]));
	}
	return { edges, right, left, fillRules: operands.map((o) => o.fillRule), eps };
}

function insideFlags(windings: number[], fillRules: PolygonFillRule[]): boolean[] {
	return windings.map((w, k) => (fillRules[k] === 'evenodd' ? (w & 1) === 1 : w !== 0));
}

// ---------------------------------------------------------------------------
// Ring extraction
// ---------------------------------------------------------------------------

interface DirectedEdge {
	from: Vertex;
	to: Vertex;
	angle: number;
}

/** Traces the kept directed edges (result on the left) into rings. */
function traceRings(directed: DirectedEdge[]): Vertex[][] {
	const outgoing = new Map<number, DirectedEdge[]>();
	for (const e of directed) {
		const list = outgoing.get(e.from.id);
		if (list) list.push(e);
		else outgoing.set(e.from.id, [e]);
	}
	const TWO_PI = Math.PI * 2;
	const next = (incoming: DirectedEdge): DirectedEdge | undefined => {
		const candidates = outgoing.get(incoming.to.id);
		if (!candidates) return undefined;
		const back = Math.atan2(incoming.from.y - incoming.to.y, incoming.from.x - incoming.to.x);
		let best: DirectedEdge | undefined;
		let bestTurn = Infinity;
		for (const c of candidates) {
			// Clockwise sweep from the reversed incoming edge: the first hit is the sharpest
			// left turn, which keeps the result region on the left and splits rings at
			// vertices they merely touch.
			let turn = back - c.angle;
			turn -= Math.floor(turn / TWO_PI) * TWO_PI;
			if (turn <= 1e-15) turn = TWO_PI;
			if (turn < bestTurn) {
				bestTurn = turn;
				best = c;
			}
		}
		return best;
	};

	const used = new Set<DirectedEdge>();
	const rings: Vertex[][] = [];
	for (const start of directed) {
		if (used.has(start)) continue;
		const ring: Vertex[] = [];
		let edge: DirectedEdge | undefined = start;
		let guard = directed.length + 1;
		while (edge && !used.has(edge) && guard-- > 0) {
			used.add(edge);
			ring.push(edge.from);
			edge = next(edge);
		}
		if (ring.length >= 3) rings.push(ring);
	}
	return rings;
}

/** Removes vertices that lie on the straight line between their neighbours. */
function removeCollinear(ring: Point[], eps: number): Point[] {
	let points = ring;
	let changed = true;
	while (changed && points.length > 3) {
		changed = false;
		const out: Point[] = [];
		const n = points.length;
		for (let i = 0; i < n; i++) {
			const prev = out.length > 0 ? out[out.length - 1] : points[(i - 1 + n) % n];
			const cur = points[i];
			const nxt = points[(i + 1) % n];
			const dx = nxt[0] - prev[0];
			const dy = nxt[1] - prev[1];
			const len = Math.hypot(dx, dy);
			const cross = (cur[0] - prev[0]) * dy - (cur[1] - prev[1]) * dx;
			const dot = (cur[0] - prev[0]) * dx + (cur[1] - prev[1]) * dy;
			if (len > 0 && Math.abs(cross) / len <= eps && dot > 0 && dot < len * len) {
				changed = true;
				continue;
			}
			out.push(cur);
		}
		if (out.length < 3) return out;
		points = out;
	}
	return points;
}

function assemble(rings: Vertex[][], eps: number): MultiPolygon {
	const outers: { ring: Point[]; area: number }[] = [];
	const holes: { ring: Point[]; area: number }[] = [];
	const minArea = eps * eps;
	for (const vertices of rings) {
		const ring = removeCollinear(
			vertices.map((v) => [v.x, v.y] as Point),
			eps
		);
		if (ring.length < 3) continue;
		const area = ringSignedArea(ring);
		if (Math.abs(area) <= minArea) continue;
		(area > 0 ? outers : holes).push({ ring, area: Math.abs(area) });
	}
	outers.sort((a, b) => b.area - a.area);
	const polygons: PolygonWithHoles[] = outers.map((o) => [o.ring]);
	for (const hole of holes) {
		// Sample the midpoint of a hole edge: overlay edges are unique, so it is not on an
		// outer ring's boundary.
		const [p, q] = [hole.ring[0], hole.ring[1]];
		const sample: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
		let owner = -1;
		for (let i = outers.length - 1; i >= 0; i--) {
			// Iterating smallest-first finds the tightest container.
			if (outers[i].area >= hole.area && pointInRings(sample, [outers[i].ring], 'evenodd')) {
				owner = i;
				break;
			}
		}
		if (owner >= 0) polygons[owner].push(hole.ring);
	}
	return polygons;
}

function extract(overlay: Overlay, isInside: (flags: boolean[]) => boolean): MultiPolygon {
	const directed: DirectedEdge[] = [];
	overlay.edges.forEach((edge, i) => {
		const l = isInside(insideFlags(overlay.left[i], overlay.fillRules));
		const r = isInside(insideFlags(overlay.right[i], overlay.fillRules));
		if (l === r) return;
		const [from, to] = l ? [edge.a, edge.b] : [edge.b, edge.a];
		directed.push({ from, to, angle: Math.atan2(to.y - from.y, to.x - from.x) });
	});
	return assemble(traceRings(directed), overlay.eps);
}

function predicate(operation: PolygonBooleanOperation): (flags: boolean[]) => boolean {
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
// Public operations
// ---------------------------------------------------------------------------

/**
 * Applies a boolean operation to any number of operands.
 * - `union`: covered by any operand.
 * - `intersection`: covered by every operand.
 * - `difference`: the first operand minus all others.
 * - `xor`: covered by an odd number of operands (Exclude).
 *
 * Returns simple rings: outer rings have a positive signed area, holes a negative one.
 * Rings may touch at vertices but never cross.
 */
export function polygonBoolean(
	operation: PolygonBooleanOperation,
	operands: PolygonInput[],
	options: PolygonBooleanOptions = {}
): MultiPolygon {
	if (operands.length === 0) return [];
	return extract(buildOverlay(operands, options), predicate(operation));
}

export const unionPolygons = (a: PolygonInput, b: PolygonInput, options?: PolygonBooleanOptions) =>
	polygonBoolean('union', [a, b], options);
export const intersectPolygons = (a: PolygonInput, b: PolygonInput, options?: PolygonBooleanOptions) =>
	polygonBoolean('intersection', [a, b], options);
export const subtractPolygons = (a: PolygonInput, b: PolygonInput, options?: PolygonBooleanOptions) =>
	polygonBoolean('difference', [a, b], options);
export const xorPolygons = (a: PolygonInput, b: PolygonInput, options?: PolygonBooleanOptions) =>
	polygonBoolean('xor', [a, b], options);

/**
 * Splits the overlay of the operands into its distinct regions (Freeform's Divide): every
 * connected area covered by the same set of operands becomes one piece. Pieces are ordered
 * by their operand set, then by size (largest first).
 */
export function dividePolygons(operands: PolygonInput[], options: PolygonBooleanOptions = {}): PolygonPiece[] {
	if (operands.length === 0) return [];
	const overlay = buildOverlay(operands, options);
	const signatures = new Map<string, number[]>();
	const note = (windings: number[]) => {
		const flags = insideFlags(windings, overlay.fillRules);
		if (!flags.some(Boolean)) return;
		const key = flags.map((f) => (f ? '1' : '0')).join('');
		if (!signatures.has(key)) signatures.set(key, flags.flatMap((f, k) => (f ? [k] : [])));
	};
	overlay.edges.forEach((_, i) => {
		note(overlay.left[i]);
		note(overlay.right[i]);
	});
	const pieces: PolygonPiece[] = [];
	const keys = [...signatures.keys()].sort();
	for (const key of keys) {
		const polygons = extract(overlay, (flags) => flags.map((f) => (f ? '1' : '0')).join('') === key);
		polygons.sort((a, b) => polygonArea(b) - polygonArea(a));
		for (const polygon of polygons) pieces.push({ polygon, operands: signatures.get(key)! });
	}
	return pieces;
}
