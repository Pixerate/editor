/**
 * Pathfinder operands, the Shape Builder and fill regions over a vector document.
 *
 * Everything works in document space: each path is mapped through its own transform and its
 * parents', with live corners cut (`subpathsToBezier`), so rotated nodes and nodes inside
 * rotated groups take part as drawn. The controller maps results back into the space of the node
 * that receives them.
 *
 * - **Pathfinder operands**: a filled path is its fill area (every subpath closed); an unfilled
 *   path with a stroke is the area its stroke paints (alignment, caps, joins and arrowheads
 *   included) and results from it are filled with the stroke's paint; for Divide an unfilled open
 *   path is a cutting line instead.
 * - **Shape Builder**: the planar map of the selected paths (`PlanarMap`). Closed subpaths bound
 *   faces whatever their paint (a stroke-only shape's inside is a face), filled open subpaths that
 *   enclose an area are closed by an invisible edge, and unfilled open paths cut the faces they
 *   cross; their pieces between junctions can be erased. Merging faces unites them along the
 *   map's own edges and takes the area away from every shape covering them.
 * - **Fill regions** (paint bucket): the planar map of every visible outline; the region around a
 *   point is traced from a ray (`PlanarMap.regionAt`).
 *
 * The Shape Builder follows vectorcraft-main/crates/tools/src/builder.rs (`BuilderMap`, `hit`,
 * `sides`, `line_between`, `shape_builder_shapes`, `sample_polyline`) and
 * crates/engine/src/cmd/buildcmds.rs (`sb_merge`), with figcraft-main/crates/engine/src/shapebuilder.rs
 * (strokes as their outlined area). MIT OR Apache-2.0, © ArtCraft Team and contributors. See
 * THIRD_PARTY_NOTICES.md.
 */
import type { Point } from '../canvas/types.js';
import {
	bezierPathBounds,
	contourSignedArea,
	closeContour,
	distanceToBezierPath,
	pathToContours,
	segmentPoint,
	segmentTangent,
	contoursToPath,
	type BezierPath,
	type BezierSegment
} from '../canvas/pathops/bezier.js';
import { PlanarMap } from '../canvas/pathops/planar.js';
import type { PathfinderOperation, PathfinderShape } from '../canvas/pathops/pathfinder.js';
import { hasPaint, multiplyMatrices, nodeMatrix, subpathsToBezier, vectorPathWorldBezier, vectorStrokeOutline, IDENTITY_MATRIX, type AffineMatrix } from './geometry.js';
import type { Vec2, VectorDocument, VectorNode, VectorPaint, VectorPathNode, VectorSubpath } from './types.js';

/** A path node with the matrix of its parent space (parent → document). */
export interface VectorPathEntry {
	node: VectorPathNode;
	parent: AffineMatrix;
}

/**
 * The path nodes inside `roots` (or every node when `roots` is null), bottom to top, with their
 * parent matrices. Hidden nodes are skipped, and locked ones unless `locked` is true.
 */
export function vectorPathEntries(doc: VectorDocument, roots: readonly string[] | null, options: { locked?: boolean } = {}): VectorPathEntry[] {
	const out: VectorPathEntry[] = [];
	const visit = (node: VectorNode, parent: AffineMatrix, inside: boolean) => {
		if (node.visible === false || (node.locked && !options.locked)) return;
		const picked = inside || roots === null || roots.includes(node.id);
		if (node.type === 'group') {
			const m = multiplyMatrices(nodeMatrix(node), parent);
			for (const c of node.children) visit(c, m, picked);
		} else if (picked) out.push({ node, parent });
	};
	for (const n of doc.nodes) visit(n, IDENTITY_MATRIX, false);
	return out;
}

const usable = (sp: VectorSubpath) => sp.anchors.length > 1;

/** The entry's outline in document space with the given subpaths. */
function worldOf(entry: VectorPathEntry, subpaths: VectorSubpath[]): BezierPath {
	return vectorPathWorldBezier({ ...entry.node, subpaths }, entry.parent);
}

/** Whether a subpath, closed, encloses an area (rather than retracing itself). */
export function subpathEnclosesArea(sp: VectorSubpath): boolean {
	const contour = pathToContours(subpathsToBezier([{ ...sp, closed: true }]))[0];
	if (!contour) return false;
	const segs = closeContour(contour, true);
	const b = bezierPathBounds(contoursToPath([{ segments: segs, closed: true }]));
	if (!b) return false;
	const w = b.maxX - b.minX;
	const h = b.maxY - b.minY;
	return Math.abs(contourSignedArea(segs)) > 1e-9 * (w * w + h * h);
}

/** How an operand takes part in a Pathfinder operation: its fill, its stroke's area, a cutting line or its bare outline. */
export type VectorPathfinderPaint = 'fill' | 'stroke' | 'line' | 'outline';

const paintKey = (paint: VectorPaint | undefined) => (typeof paint === 'string' ? paint.trim().toLowerCase() : JSON.stringify(paint ?? null));

/** The Pathfinder shape of a path (document space), and what it stands for. */
export function vectorPathfinderShape(entry: VectorPathEntry, op: PathfinderOperation): PathfinderShape & { paint: VectorPathfinderPaint } {
	const { node } = entry;
	const subpaths = node.subpaths.filter(usable);
	const closed = subpaths.map((s) => ({ ...s, closed: true }));
	const fillRule = node.fillRule ?? 'nonzero';
	if (hasPaint(node.fill)) return { path: worldOf(entry, closed), fillRule, key: `fill:${paintKey(node.fill)}`, paint: 'fill' };
	const open = subpaths.length > 0 && subpaths.every((s) => !s.closed);
	if (op === 'divide' && open) return { path: worldOf(entry, subpaths), line: true, paint: 'line' };
	if (hasPaint(node.stroke) && (node.strokeWidth ?? 1) > 0) {
		// Node transforms are rigid, so the stroke laid out in document space keeps its width.
		const path = vectorStrokeOutline({ ...node, subpaths }, entry.parent);
		return { path, fillRule: 'nonzero', key: `fill:${paintKey(node.stroke)}`, paint: 'stroke' };
	}
	return { path: worldOf(entry, closed), fillRule, key: 'none', paint: 'outline' };
}

const STROKE_KEYS = [
	'stroke',
	'strokeWidth',
	'strokeLinecap',
	'strokeLinejoin',
	'strokeDasharray',
	'strokeAlign',
	'startArrow',
	'endArrow',
	'arrowAlign',
	'startArrowScale',
	'endArrowScale',
	'strokeWidthProfile'
] as const;

/**
 * Style of a Pathfinder or Shape Builder result taken from `node`: the node's own style for a
 * filled area, the stroke's paint as a fill for a stroke's area, or (for Outline edges) a stroke
 * in the paint of the area the edge bounds. Never carries the node's id, transform or geometry.
 */
export function vectorResultStyle(node: VectorPathNode, paint: VectorPathfinderPaint, edge = false): Omit<VectorPathNode, 'id' | 'subpaths'> {
	const { id: _id, subpaths: _s, transform: _t, ...rest } = node;
	const base: Omit<VectorPathNode, 'id' | 'subpaths'> = { ...rest, fillRule: 'nonzero' };
	if (edge) {
		for (const k of STROKE_KEYS) delete (base as Record<string, unknown>)[k];
		const stroke = paint === 'stroke' || !hasPaint(node.fill) ? node.stroke : node.fill;
		return { ...base, fill: null, stroke: stroke ?? '#000000', strokeWidth: node.strokeWidth ?? 1 };
	}
	if (paint === 'stroke') {
		for (const k of STROKE_KEYS) delete (base as Record<string, unknown>)[k];
		return { ...base, fill: node.stroke ?? null, stroke: null };
	}
	return base;
}

// ---------------------------------------------------------------------------
// Shape Builder
// ---------------------------------------------------------------------------

/** A piece of an unfilled open path between the points where other paths meet it. */
export interface VectorBuilderLinePiece {
	path: BezierPath;
	segments: BezierSegment[];
	/** Index of the entry it belongs to. */
	source: number;
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** The Shape Builder's planar map of a set of paths. */
export interface VectorShapeBuilderMap {
	entries: VectorPathEntry[];
	map: PlanarMap;
	/** Entries with no closed subpath (cutting lines; their pieces can be erased). */
	lines: boolean[];
	pieces: VectorBuilderLinePiece[];
}

/** What a Shape Builder gesture touches at a point. */
export type VectorBuilderHit = { face: number } | { line: number };

/** The faces and line pieces a gesture touched, in the order touched. */
export interface VectorBuilderTouched {
	faces: number[];
	lines: number[];
}

/**
 * The Shape Builder map of `entries` (bottom to top). Filled open subpaths that enclose an area
 * are closed. Null when nothing can be mapped.
 */
export function vectorShapeBuilderMap(entries: readonly VectorPathEntry[]): VectorShapeBuilderMap | null {
	const lines: boolean[] = [];
	const inputs = entries.map((entry) => {
		const filled = hasPaint(entry.node.fill);
		const subpaths = entry.node.subpaths.filter(usable).map((sp) => (!sp.closed && filled && subpathEnclosesArea(sp) ? { ...sp, closed: true } : sp));
		lines.push(!subpaths.some((s) => s.closed));
		return { path: worldOf(entry, subpaths), fillRule: entry.node.fillRule ?? 'nonzero' };
	});
	const map = PlanarMap.build(inputs);
	if (!map) return null;
	const pieces = map
		.chains()
		.filter((c) => lines[c.source] && !c.closed)
		.map((c) => {
			const path = contoursToPath([{ segments: c.segments, closed: false }]);
			return { path, segments: c.segments, source: c.source, bounds: bezierPathBounds(path)! };
		});
	return { entries: [...entries], map, lines, pieces };
}

/** The face under `p`, or with `lineTolerance` (erasing) first the line piece that close. */
export function vectorShapeBuilderHit(m: VectorShapeBuilderMap, p: Vec2, lineTolerance: number | null = null): VectorBuilderHit | null {
	const point: Point = [p.x, p.y];
	if (lineTolerance !== null && lineTolerance > 0) {
		let best = -1;
		let bestD = lineTolerance;
		m.pieces.forEach((piece, i) => {
			const b = piece.bounds;
			if (p.x < b.minX - bestD || p.x > b.maxX + bestD || p.y < b.minY - bestD || p.y > b.maxY + bestD) return;
			const d = distanceToBezierPath(piece.path, point);
			if (d <= bestD) {
				best = i;
				bestD = d;
			}
		});
		if (best >= 0) return { line: best };
	}
	const face = m.map.faceAt(point);
	return face >= 0 ? { face } : null;
}

/** Points along a polyline no more than `step` apart (the pointer's path through faces). */
export function samplePolyline(points: readonly Vec2[], step: number): Vec2[] {
	const out: Vec2[] = [];
	const s = Math.max(step, 1e-3);
	points.forEach((p, i) => {
		if (i > 0) {
			const a = points[i - 1];
			const n = Math.min(4000, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / s));
			for (let k = 1; k < n; k++) out.push({ x: a.x + ((p.x - a.x) * k) / n, y: a.y + ((p.y - a.y) * k) / n });
		}
		out.push(p);
	});
	return out;
}

/** Adds what a point hits to `touched` (each face or piece once). */
export function addBuilderHit(touched: VectorBuilderTouched, hit: VectorBuilderHit | null): boolean {
	if (!hit) return false;
	const [list, i] = 'face' in hit ? [touched.faces, hit.face] : [touched.lines, hit.line];
	if (list.includes(i)) return false;
	list.push(i);
	return true;
}

/** The faces just either side of the middle of a line piece (-1 outside every face). */
function sides(m: VectorShapeBuilderMap, piece: VectorBuilderLinePiece): [number, number] {
	const seg = piece.segments[Math.floor(piece.segments.length / 2)];
	const mid = segmentPoint(seg, 0.5);
	const t = segmentTangent(seg, 0.5);
	const chord = Math.hypot(seg[seg.length - 1][0] - seg[0][0], seg[seg.length - 1][1] - seg[0][1]);
	const off = Math.max(1e-6, Math.min(0.05, 0.05 * chord));
	return [m.map.faceAt([mid[0] - t[1] * off, mid[1] + t[0] * off]), m.map.faceAt([mid[0] + t[1] * off, mid[1] - t[0] * off])];
}

/** What becomes of one entry: unchanged (absent), removed (`null`), or new outlines (document space). */
export type VectorBuilderReplacement = { kind: 'fill'; path: BezierPath } | { kind: 'pieces'; paths: BezierPath[] } | null;

export interface VectorShapeBuilderPlan {
	replace: Map<number, VectorBuilderReplacement>;
	/** The merged shape (document space), styled like entry `style`; `currentFill` when only outlines enclosed it. */
	merged: { path: BezierPath; style: number; currentFill: boolean } | null;
}

/**
 * What a gesture does: merging (or with `erase`, deleting) the touched faces takes them away
 * from every shape covering them; line pieces touched (erasing) or lying between touched faces
 * go; merging adds the union of the faces as a new shape styled like the top-most shape over the
 * first face touched (or, for a face only outlines enclose, the top-most shape with the current
 * fill).
 */
export function planShapeBuilder(m: VectorShapeBuilderMap, touched: VectorBuilderTouched, erase: boolean): VectorShapeBuilderPlan {
	const replace = new Map<number, VectorBuilderReplacement>();
	const picked = new Set(touched.faces);
	const faces = m.map.faces;
	const sourcesOf = faces.map((_, i) => m.map.faceSources(i));
	m.entries.forEach((_, i) => {
		if (m.lines[i]) {
			const own = m.pieces.flatMap((piece, k) => (piece.source === i ? [k] : []));
			const keep = own.filter((k) => !touched.lines.includes(k) && !sides(m, m.pieces[k]).every((f) => f >= 0 && picked.has(f)));
			if (keep.length === own.length) return;
			replace.set(i, keep.length ? { kind: 'pieces', paths: keep.map((k) => m.pieces[k].path) } : null);
			return;
		}
		if (!touched.faces.some((f) => sourcesOf[f].includes(i))) return;
		const kept = faces.flatMap((_, f) => (sourcesOf[f].includes(i) && !picked.has(f) ? [f] : []));
		const rest = kept.length ? m.map.merge(kept) : [];
		replace.set(i, rest.length ? { kind: 'fill', path: rest } : null);
	});
	let merged: VectorShapeBuilderPlan['merged'] = null;
	if (!erase && touched.faces.length) {
		const path = m.map.merge(touched.faces);
		const covered = touched.faces.map((f) => sourcesOf[f]).find((s) => s.length);
		const lastShape = m.lines.lastIndexOf(false);
		const style = covered ? covered[covered.length - 1] : lastShape >= 0 ? lastShape : m.entries.length - 1;
		if (path.length) merged = { path, style, currentFill: !covered };
	}
	return { replace, merged };
}

// ---------------------------------------------------------------------------
// Fill regions
// ---------------------------------------------------------------------------

/**
 * The planar map of every visible path's outline as drawn (locked ones included), for the paint
 * bucket. `gap` closes gaps up to that distance between loose ends.
 */
export function vectorFillMap(doc: VectorDocument, gap = 0): PlanarMap | null {
	const entries = vectorPathEntries(doc, null, { locked: true });
	return PlanarMap.build(
		entries.map((e) => ({ path: worldOf(e, e.node.subpaths.filter(usable)), fills: false })),
		{ gap, maxSegments: 20000 }
	);
}
