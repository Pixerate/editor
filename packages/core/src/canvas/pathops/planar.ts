/**
 * Planar maps: the faces and edges a set of paths divides the plane into (Shape Builder, fill
 * regions, Pathfinder Outline).
 *
 * Unlike `dividePaths`, which splits the *filled areas* of closed shapes, every path here is an
 * edge, open ones included: three crossing lines enclose a triangle, a line across a rectangle
 * splits it in two, and an area enclosed by paths is a face whether or not anything fills it.
 *
 * 1. `planarSplit` (the boolean engine's intersection search) cuts every input segment wherever
 *    it meets another one; coincident pieces become one edge.
 * 2. Each edge gives two half-edges. Around every vertex the half-edges leaving it are sorted by
 *    the direction in which they cross a small circle around it (half the shortest edge there),
 *    which orders tangent curves correctly.
 * 3. A face walk takes, at each vertex, the half-edge just clockwise of the way back — the
 *    sharpest left turn. Bounded faces come out counter-clockwise (positive area in a y-up
 *    frame), the outer boundary of every connected piece clockwise; spurs (loose line ends) are
 *    dropped. Each outer boundary becomes a hole of the smallest face of another piece around
 *    it, so nesting is decided face by face, never by an even-odd rule over the whole network.
 * 4. Faces learn which inputs fill them from a point well inside each face.
 *
 * Adjacency is kept in per-vertex lists and half-edge slots (no scans over all edges per step).
 *
 * Ported from vectorcraft-main/crates/pathops/src/planar.rs (`map`, `Map::merge`, `build`,
 * `interior_point`, `without_spurs`, `leaving_angle`), figcraft-main/crates/doc/src/vector_faces.rs
 * (`faces`: half-edge walk with an angle-sorted next edge, the winding deciding inside or
 * outside) and cadcraft-main/crates/geom/src/region.rs (`enclosing_loop`, `boundary_at_gap`:
 * a ray from the point, the sharpest left turn, islands as holes, gaps between open ends
 * closed). MIT OR Apache-2.0, © ArtCraft Team and contributors. See THIRD_PARTY_NOTICES.md.
 */
import type { Point } from '../types.js';
import type { PolygonFillRule } from '../polygonBoolean.js';
import {
	closeContour,
	contourSignedArea,
	contoursToPath,
	dist,
	flattenChain,
	pathToContours,
	segmentLength,
	segmentPoint,
	segmentTangent,
	solveMonotone,
	subSegment,
	windingNumber,
	type BezierContour,
	type BezierPath,
	type BezierPathInput,
	type BezierSegment
} from './bezier.js';
import { planarSplit, type PathOpsOptions, type PlanarSplitEdge } from './boolean.js';

/** One input of a planar map. */
export interface PlanarInput {
	/** Its subpaths: closed ones bound faces and the area the input fills, open ones are edges only. */
	path: BezierPathInput;
	/** How its closed subpaths fill (default `nonzero`). */
	fillRule?: PolygonFillRule;
	/** Whether its closed subpaths count as filling the faces inside them (default true). */
	fills?: boolean;
}

export interface PlanarMapOptions extends PathOpsOptions {
	/**
	 * Close gaps up to this distance between loose ends (vertices with one edge): each one joins
	 * the nearest other loose end within reach by a straight edge (default 0, off).
	 */
	gap?: number;
	/** Most input segments mapped (default 4096); a bigger input gives no map. */
	maxSegments?: number;
}

/** A bounded face: an outer outline with the holes other pieces of the map make in it. */
export interface PlanarFace {
	/** Outer subpath (counter-clockwise in a y-up frame) followed by its holes (clockwise). */
	path: BezierPath;
	/** Area (holes taken out). */
	area: number;
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** A run of edges between junctions (vertices where paths meet or a path ends). */
export interface PlanarChain {
	segments: BezierSegment[];
	/** A loop with no junction on it. */
	closed: boolean;
	/** The input it lies on: the front-most (highest index) where several coincide. */
	source: number;
}

interface Edge extends PlanarSplitEdge {
	/** Front-most input along it (-1: an edge closing a gap). */
	source: number;
}

interface Cycle {
	halves: number[];
	segments: BezierSegment[];
	area: number;
	bounds: PlanarFace['bounds'];
}

const twin = (h: number) => h ^ 1;

function boundsOf(segs: readonly BezierSegment[]): PlanarFace['bounds'] {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const s of segs) {
		for (const [x, y] of s) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	return { minX, minY, maxX, maxY };
}

const inBounds = (b: PlanarFace['bounds'], p: Point) => p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY;

/** `cycle` without the spurs it runs out and back along (a line's loose end). */
function withoutSpurs(cycle: readonly number[]): number[] {
	const out: number[] = [];
	for (const h of cycle) {
		if (out.length && out[out.length - 1] === twin(h)) out.pop();
		else out.push(h);
	}
	while (out.length >= 2 && twin(out[0]) === out[out.length - 1]) {
		out.pop();
		out.shift();
	}
	return out;
}

/** Moves the end points of a segment onto `a` and `b`, the handles next to them moving along. */
function pinEnds(pts: readonly Point[], a: Point, b: Point): Point[] {
	const n = pts.length;
	if (n === 2) return [a, b];
	const out = pts.map((p) => [p[0], p[1]] as Point);
	const d0: Point = [a[0] - pts[0][0], a[1] - pts[0][1]];
	const d1: Point = [b[0] - pts[n - 1][0], b[1] - pts[n - 1][1]];
	out[0] = a;
	out[n - 1] = b;
	if (n === 3) {
		out[1] = [pts[1][0] + (d0[0] + d1[0]) / 2, pts[1][1] + (d0[1] + d1[1]) / 2];
	} else {
		out[1] = [pts[1][0] + d0[0], pts[1][1] + d0[1]];
		out[2] = [pts[2][0] + d1[0], pts[2][1] + d1[1]];
	}
	return out;
}

/**
 * A point strictly inside a filled path (nonzero), well away from its edges where it can be:
 * the middle of the widest span of a few horizontal lines through it. Null for an empty path.
 * Ported from vectorcraft's `interior_point` (cadcraft's `interior_point` for polygons).
 */
export function interiorPoint(path: BezierPathInput | readonly (readonly BezierSegment[])[]): Point | null {
	const chains: BezierSegment[][] =
		Array.isArray(path) && path.length > 0 && Array.isArray(path[0]) && Array.isArray((path[0] as BezierSegment[])[0]?.[0])
			? (path as BezierSegment[][])
			: pathToContours(path as BezierPathInput).map((c) => closeContour(c, true));
	const b = boundsOf(chains.flat());
	if (!(b.maxX > b.minX) || !(b.maxY > b.minY)) return null;
	const tol = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 1e-3;
	const rings = chains.filter((c) => c.length).map((c) => flattenChain(c, tol));
	let best: { width: number; p: Point } | null = null;
	for (const f of [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875, 0.0625, 0.9375]) {
		// A little off round fractions, which on art drawn to a grid fall on the height of a corner.
		const y = b.minY + (b.maxY - b.minY) * (f + 0.0061803);
		const xs: number[] = [];
		for (const ring of rings) {
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i];
				const c = ring[(i + 1) % ring.length];
				if (a[1] <= y !== c[1] <= y) xs.push(a[0] + ((y - a[1]) / (c[1] - a[1])) * (c[0] - a[0]));
			}
		}
		xs.sort((p, q) => p - q);
		for (let i = 0; i + 1 < xs.length; i++) {
			const width = xs[i + 1] - xs[i];
			if (!(width > (best?.width ?? 0))) continue;
			const m: Point = [(xs[i] + xs[i + 1]) / 2, y];
			if (windingNumber(chains, m) !== 0) best = { width, p: m };
		}
	}
	return best?.p ?? null;
}

/**
 * The planar map of a set of paths. Build it with `PlanarMap.build`; faces, chains and fills
 * are computed on first use.
 */
export class PlanarMap {
	private readonly around: number[][];
	private readonly slot: number[];
	private readonly component: number[];
	private cyclesCache: { faces: Cycle[]; holes: Cycle[]; faceHoles: number[][]; faceOf: Int32Array } | null = null;
	private sourcesCache: (number[] | null)[] = [];
	private readonly fills: { chains: BezierSegment[][]; fillRule: PolygonFillRule; bounds: PlanarFace['bounds'] }[];

	private constructor(
		readonly vertices: Point[],
		private readonly edges: Edge[],
		private readonly sources: BezierSegment[],
		readonly eps: number,
		readonly inputCount: number,
		inputs: readonly PlanarInput[]
	) {
		this.fills = inputs.map((input) => {
			const chains = input.fills === false ? [] : pathToContours(input.path).filter((c) => c.closed).map((c) => closeContour(c));
			return { chains, fillRule: input.fillRule ?? 'nonzero', bounds: boundsOf(chains.flat()) };
		});
		const nv = vertices.length;
		this.around = Array.from({ length: nv }, () => []);
		for (let h = 0; h < edges.length * 2; h++) this.around[this.origin(h)].push(h);
		this.slot = new Array(edges.length * 2).fill(0);
		this.around.forEach((list, v) => {
			if (list.length === 0) return;
			const at = vertices[v];
			// Half the shortest chord here: every edge gets that far from the vertex.
			let r = Infinity;
			for (const h of list) r = Math.min(r, dist(at, vertices[this.origin(twin(h))]));
			r *= 0.5;
			const keyed = list.map((h) => ({ h, angle: this.leavingAngle(h, at, r) }));
			keyed.sort((a, b) => a.angle - b.angle);
			list.length = 0;
			keyed.forEach(({ h }, k) => {
				list.push(h);
				this.slot[h] = k;
			});
		});
		// Connected pieces (union-find over the edges).
		const parent = Array.from({ length: nv }, (_, i) => i);
		const find = (v: number): number => {
			while (parent[v] !== v) {
				parent[v] = parent[parent[v]];
				v = parent[v];
			}
			return v;
		};
		for (const e of edges) parent[find(e.a)] = find(e.b);
		this.component = Array.from({ length: nv }, (_, v) => find(v));
	}

	/**
	 * Maps `inputs` (their subpaths as given: open ones stay open). Null when they cannot be mapped
	 * (non-finite points, more than `maxSegments` segments or an intersection search that does
	 * not settle) or have no edges.
	 */
	static build(inputs: readonly PlanarInput[], options: PlanarMapOptions = {}): PlanarMap | null {
		const chains = inputs.map((input) => pathToContours(input.path).map((c) => closeContour(c)).filter((c) => c.length));
		const count = chains.reduce((n, cs) => n + cs.reduce((m, c) => m + c.length, 0), 0);
		if (count === 0 || count > (options.maxSegments ?? 4096)) return null;
		let split;
		try {
			split = planarSplit(chains, options);
		} catch {
			return null;
		}
		const edges: Edge[] = split.edges.filter((e) => e.a !== e.b).map((e) => ({ ...e, source: e.operands[e.operands.length - 1] ?? -1 }));
		if (!edges.length) return null;
		const gap = options.gap ?? 0;
		if (gap > split.eps) closeGaps(split.vertices, edges, gap);
		return new PlanarMap(split.vertices, edges, split.sources, split.eps, inputs.length, inputs);
	}

	// -- half-edges ------------------------------------------------------------

	private origin(h: number): number {
		const e = this.edges[h >> 1];
		return h & 1 ? e.b : e.a;
	}

	private halfPts(h: number): Point[] {
		const pts = this.edges[h >> 1].pts;
		return h & 1 ? [...pts].reverse() : pts;
	}

	/** The half-edge after `h` on the face to its left: the sharpest left turn at its end. */
	private next(h: number): number {
		const back = twin(h);
		const list = this.around[this.origin(back)];
		return list[(this.slot[back] + list.length - 1) % list.length];
	}

	/** Direction (angle) in which half-edge `h`, leaving `at`, first gets `r` away from it. */
	private leavingAngle(h: number, at: Point, r: number): number {
		const pts = this.halfPts(h);
		const d = (t: number) => dist(segmentPoint(pts, t), at);
		let lo = 0;
		let hi = 1;
		const steps = pts.length === 2 ? 1 : 16;
		for (let k = 1; k <= steps; k++) {
			if (d(k / steps) >= r) {
				hi = k / steps;
				break;
			}
			lo = k / steps;
		}
		for (let i = 0; i < 40 && hi - lo > 1e-12; i++) {
			const m = (lo + hi) / 2;
			if (d(m) >= r) hi = m;
			else lo = m;
		}
		const p = segmentPoint(pts, hi);
		if (dist(p, at) > 0) return Math.atan2(p[1] - at[1], p[0] - at[0]);
		const t = segmentTangent(pts, 0);
		return Math.atan2(t[1], t[0]);
	}

	/** Segments of a run of half-edges (a loop unless `closed` is false), pieces of one input segment joined again. */
	private cycleSegments(halves: readonly number[], closed = true): BezierSegment[] {
		interface Run {
			h: number;
			src: number;
			from: number;
			to: number;
		}
		const runs: Run[] = halves.map((h) => {
			const e = this.edges[h >> 1];
			return { h, src: e.source < 0 ? -1 : e.src, from: h & 1 ? e.sb : e.sa, to: h & 1 ? e.sa : e.sb };
		});
		const joins = (a: Run, b: Run) => a.src >= 0 && a.src === b.src && Math.abs(a.to - b.from) < 1e-9 && a.to - a.from > 0 === b.to - b.from > 0;
		const n = runs.length;
		let start = 0;
		for (let k = 0; closed && k < n; k++) {
			if (!joins(runs[(k + n - 1) % n], runs[k])) {
				start = k;
				break;
			}
		}
		const ordered = [...runs.slice(start), ...runs.slice(0, start)];
		const out: BezierSegment[] = [];
		let i = 0;
		while (i < ordered.length) {
			let j = i + 1;
			while (j < ordered.length && joins(ordered[j - 1], ordered[j])) j++;
			const first = ordered[i];
			const last = ordered[j - 1];
			if (j - i === 1) out.push(this.halfPts(first.h));
			else {
				const a = this.vertices[this.origin(first.h)];
				const b = this.vertices[this.origin(twin(last.h))];
				const seg = this.sources[first.src];
				out.push(seg.length === 2 ? [a, b] : pinEnds(subSegment(seg, first.from, last.to), a, b));
			}
			i = j;
		}
		return out;
	}

	private cycles() {
		if (this.cyclesCache) return this.cyclesCache;
		const halves = this.edges.length * 2;
		const seen = new Uint8Array(halves);
		const faces: Cycle[] = [];
		const holes: Cycle[] = [];
		const sliver = this.eps * 10;
		for (let start = 0; start < halves; start++) {
			if (seen[start]) continue;
			const walk: number[] = [];
			let h = start;
			while (!seen[h]) {
				seen[h] = 1;
				walk.push(h);
				h = this.next(h);
			}
			const cycle = withoutSpurs(walk);
			if (!cycle.length) continue;
			const segments = this.cycleSegments(cycle);
			const area = contourSignedArea(segments);
			let perimeter = 0;
			for (const s of segments) perimeter += s.length === 2 ? dist(s[0], s[1]) : segmentLength(s, 0, 1, 1e-6);
			if (!(perimeter > 0)) continue;
			const entry: Cycle = { halves: cycle, segments, area, bounds: boundsOf(segments) };
			if (area > 0 && (2 * area) / perimeter >= sliver) faces.push(entry);
			else if (area < 0 && (-2 * area) / perimeter >= sliver) holes.push(entry);
		}
		// Each outer boundary is a hole in the smallest face of another piece around it.
		const faceHoles: number[][] = faces.map(() => []);
		holes.forEach((hole, k) => {
			const v = this.origin(hole.halves[0]);
			const p = this.vertices[v];
			const own = this.component[v];
			let best = -1;
			faces.forEach((face, i) => {
				if (this.component[this.origin(face.halves[0])] === own || !inBounds(face.bounds, p)) return;
				if (best >= 0 && faces[best].area <= face.area) return;
				if (windingNumber([face.segments], p) !== 0) best = i;
			});
			if (best >= 0) faceHoles[best].push(k);
		});
		const faceOf = new Int32Array(halves).fill(-1);
		faces.forEach((face, i) => {
			for (const h of face.halves) faceOf[h] = i;
			for (const k of faceHoles[i]) for (const h of holes[k].halves) faceOf[h] = i;
		});
		this.cyclesCache = { faces, holes, faceHoles, faceOf };
		this.sourcesCache = faces.map(() => null);
		return this.cyclesCache;
	}

	private faceChains(i: number): BezierSegment[][] {
		const { faces, holes, faceHoles } = this.cycles();
		return [faces[i].segments, ...faceHoles[i].map((k) => holes[k].segments)];
	}

	/** The bounded faces of the map. */
	get faces(): PlanarFace[] {
		const { faces, holes, faceHoles } = this.cycles();
		return faces.map((f, i) => {
			const chains = this.faceChains(i);
			const area = f.area + faceHoles[i].reduce((sum, k) => sum + holes[k].area, 0);
			return { path: contoursToPath(chains.map((segments) => ({ segments, closed: true }))), area, bounds: f.bounds };
		});
	}

	/** The inputs whose fill covers face `i`, ascending (empty for an area only outlines enclose). */
	faceSources(i: number): number[] {
		this.cycles();
		const cached = this.sourcesCache[i];
		if (cached) return cached;
		const p = interiorPoint(this.faceChains(i));
		const out: number[] = [];
		if (p) {
			this.fills.forEach((fill, k) => {
				if (!fill.chains.length || !inBounds(fill.bounds, p)) return;
				const w = windingNumber(fill.chains, p);
				if (fill.fillRule === 'evenodd' ? (w & 1) === 1 : w !== 0) out.push(k);
			});
		}
		this.sourcesCache[i] = out;
		return out;
	}

	/** A point well inside face `i`. */
	faceInterior(i: number): Point | null {
		return interiorPoint(this.faceChains(i));
	}

	/** The face under `p` (the smallest one around it), or -1. */
	faceAt(p: Point): number {
		const { faces } = this.cycles();
		let best = -1;
		faces.forEach((face, i) => {
			if (!inBounds(face.bounds, p) || (best >= 0 && faces[best].area <= face.area)) return;
			if (windingNumber(this.faceChains(i), p) !== 0) best = i;
		});
		return best;
	}

	/**
	 * The union of faces, traced along the map's own edges: those between two merged faces drop
	 * out exactly, so no seam or sliver is left where a boolean union of their outlines could
	 * round shared corners apart. Outer subpaths come out counter-clockwise (y-up), holes clockwise.
	 */
	merge(faceIndices: readonly number[]): BezierPath {
		const { faceOf } = this.cycles();
		const picked = new Set(faceIndices);
		const merged = (h: number) => faceOf[h] >= 0 && picked.has(faceOf[h]);
		const boundary = (h: number) => merged(h) && !merged(twin(h));
		const used = new Uint8Array(this.edges.length * 2);
		const contours: BezierContour[] = [];
		for (let start = 0; start < used.length; start++) {
			if (used[start] || !boundary(start)) continue;
			const cycle: number[] = [];
			let h = start;
			let ok = true;
			while (!used[h]) {
				used[h] = 1;
				cycle.push(h);
				// Turn from the way back as a face walk does, past edges inside the merged faces.
				const back = twin(h);
				const list = this.around[this.origin(back)];
				const k = this.slot[back];
				const n = list.length;
				let found = -1;
				for (let j = 1; j <= n; j++) {
					const g = list[(k - j + n * 2) % n];
					if (boundary(g)) {
						found = g;
						break;
					}
				}
				if (found < 0) {
					ok = false;
					break;
				}
				h = found;
			}
			if (!ok || h !== start) continue;
			contours.push({ segments: this.cycleSegments(cycle), closed: true });
		}
		return contoursToPath(contours);
	}

	/**
	 * The edges joined into runs between junctions: vertices where other than two edges meet, or
	 * where the two edges lie on different inputs. Each run is keyed by its input.
	 */
	chains(): PlanarChain[] {
		const passes = (v: number): [number, number] | null => {
			const list = this.around[v];
			if (list.length !== 2) return null;
			return this.edges[list[0] >> 1].source === this.edges[list[1] >> 1].source ? [list[0], list[1]] : null;
		};
		const used = new Uint8Array(this.edges.length);
		const out: PlanarChain[] = [];
		const walk = (h0: number) => {
			const source = this.edges[h0 >> 1].source;
			const halves: number[] = [];
			let h = h0;
			let closed = false;
			for (;;) {
				if (used[h >> 1]) {
					closed = true;
					break;
				}
				used[h >> 1] = 1;
				halves.push(h);
				const v = this.origin(twin(h));
				const pass = passes(v);
				if (!pass) {
					closed = v === this.origin(h0);
					break;
				}
				h = pass[0] === twin(h) ? pass[1] : pass[0];
			}
			if (source < 0) return;
			const segments = this.cycleSegments(halves, closed);
			out.push({ segments, closed, source });
		};
		this.around.forEach((list, v) => {
			if (passes(v)) return;
			for (const h of list) if (!used[h >> 1]) walk(h);
		});
		for (let e = 0; e < this.edges.length; e++) if (!used[e]) walk(e * 2);
		return out;
	}

	// -- fill regions (cadcraft `boundary_at_gap`) -------------------------------

	/**
	 * The region enclosing `p`, traced as cadcraft does it: a ray from `p` towards +x meets the
	 * edges in order; for each, the half-edge with `p` on its left is followed by always taking the
	 * sharpest left turn, until a loop that runs counter-clockwise round `p` comes back. The pieces
	 * of the map nested inside that loop (islands) become its holes. Null when nothing encloses `p`.
	 */
	regionAt(p: Point): BezierPath | null {
		const { faces, faceOf } = this.cycles();
		const hits: { x: number; e: number }[] = [];
		this.edges.forEach((e, i) => {
			const ay = this.vertices[e.a][1];
			const by = this.vertices[e.b][1];
			if (ay > p[1] === by > p[1]) return;
			// Edges are monotone pieces, so the ray crosses each at most once.
			const t = solveMonotone(e.pts, 1, p[1]);
			const x = segmentPoint(e.pts, t)[0];
			if (x > p[0]) hits.push({ x, e: i });
		});
		hits.sort((a, b) => a.x - b.x);
		for (const { e } of hits.slice(0, 64)) {
			const ay = this.vertices[this.edges[e].a][1];
			const by = this.vertices[this.edges[e].b][1];
			// `p` lies west of the edge, which is the left side (y-up frame) of the half-edge running towards +y.
			const h = by > ay ? e * 2 : e * 2 + 1;
			const walk: number[] = [];
			const seen = new Set<number>();
			let g = h;
			while (!seen.has(g)) {
				seen.add(g);
				walk.push(g);
				g = this.next(g);
			}
			if (g !== h) continue;
			const cycle = withoutSpurs(walk);
			if (!cycle.length) continue;
			const segments = this.cycleSegments(cycle);
			if (!(contourSignedArea(segments) > 0) || windingNumber([segments], p) === 0) continue;
			// The loop is one of the map's faces: take its holes.
			const face = faceOf[cycle[0]];
			if (face >= 0 && faces[face].halves.includes(cycle[0])) {
				return contoursToPath(this.faceChains(face).map((s) => ({ segments: s, closed: true })));
			}
			return contoursToPath([{ segments, closed: true }]);
		}
		return null;
	}
}

/** Joins loose ends (degree-one vertices) to the nearest other loose end within `gap`. */
function closeGaps(vertices: Point[], edges: Edge[], gap: number) {
	const degree = new Array(vertices.length).fill(0);
	const linked = new Set<string>();
	for (const e of edges) {
		degree[e.a]++;
		degree[e.b]++;
		linked.add(`${Math.min(e.a, e.b)},${Math.max(e.a, e.b)}`);
	}
	const ends = degree.flatMap((d, v) => (d === 1 ? [v] : [])).sort((a, b) => vertices[a][0] - vertices[b][0]);
	const joined = new Set<number>();
	let lo = 0;
	for (let i = 0; i < ends.length; i++) {
		const u = ends[i];
		if (joined.has(u)) continue;
		const pu = vertices[u];
		while (lo < ends.length && vertices[ends[lo]][0] < pu[0] - gap) lo++;
		let best = -1;
		let bestD = Infinity;
		for (let j = lo; j < ends.length; j++) {
			const v = ends[j];
			const pv = vertices[v];
			if (pv[0] > pu[0] + gap) break;
			if (v === u || joined.has(v) || linked.has(`${Math.min(u, v)},${Math.max(u, v)}`)) continue;
			const d = dist(pu, pv);
			if (d <= gap && d < bestD) {
				best = v;
				bestD = d;
			}
		}
		if (best < 0) continue;
		const a = Math.min(u, best);
		const b = Math.max(u, best);
		edges.push({ a, b, pts: [vertices[a], vertices[b]], operands: [], src: -1, sa: 0, sb: 1, source: -1 });
		joined.add(u);
		joined.add(best);
	}
}
