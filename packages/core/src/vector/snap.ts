/**
 * Smart guides and object snapping for the vector editor. Targets — anchors, bounding-box
 * edges and centres, path segments and the artboard — are gathered once per gesture in
 * document space (rotated nodes included) and kept sorted by x and y, so each pointer move
 * finds the few near the pointer by bisection. A point snaps, in this order of priority: kept
 * to its Shift angle and slid into line with a target, onto an anchor or centre, onto an
 * intersection of two paths, onto the perpendicular foot or tangent point from where it
 * leaves, onto a path, onto a construction angle, then into line with targets on x and y. A
 * moved box lines its edges and centre up with targets, or spaces itself evenly in its row
 * and column; a resized box lands its moving edges on targets, or matches another object's
 * width or height. Every snap reports labelled guide lines in document units.
 *
 * Portions ported from vectorcraft-main/crates/tools/src/guides.rs (`Targets`, `within`,
 * `for_move`, `for_drawing`, `for_handle`, `for_anchor_drag`, `push_segments`, `snap_from`,
 * `slide`, `lined_up`, `on_segment`, `crossing`, `align_rects`, `snap_rects`, `even_spacing`,
 * `gap_marks`, `snap_scale`, `Leave`), figcraft-main/crates/engine/src/snap.rs (`spacings`,
 * `equal_spacing`, `spacing_guides`: equal-spacing cases and gap labels),
 * designcraft-main/crates/tools/src/snap.rs (`pass_dimensions`: matching other objects'
 * sizes) and cadcraft-main/crates/engine/src/snap/curves.rs (`Param::solve`: perpendicular and
 * tangent points by sign-change sampling and bisection) (MIT OR Apache-2.0, © ArtCraft Team
 * and contributors). See THIRD_PARTY_NOTICES.md.
 */
import { VectorRTree, VECTOR_SPATIAL_MIN } from './spatial.js';
import type { Point } from '../canvas/types.js';
import { expandVectorAppearance, vectorAppearanceNodes } from './appearance.js';
import { isVectorMaskActive } from './mask.js';
import { segmentDerivative, segmentNearest, segmentPoint, type BezierSegment } from '../canvas/pathops/bezier.js';
import { segmentIntersections } from '../canvas/pathops/boolean.js';
import {
	applyMatrix,
	IDENTITY_MATRIX,
	matrixRotation,
	multiplyMatrices,
	nodeMatrix,
	rotateMatrix,
	subpathSegment,
	subpathSegmentCount,
	vectorNodeBounds,
	type AffineMatrix
} from './geometry.js';
import type { VectorAnchorRef, VectorBounds, VectorDocument, VectorNode, VectorSubpath, VectorTransformHandle, Vec2 } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * What a guide line shows: `align` lines run from a target through the snapped point or box,
 * `construction` lines from where a drawn point leaves, `spacing` marks equal gaps and `size`
 * the side whose length matches another object's.
 */
export type VectorGuideKind = 'align' | 'construction' | 'spacing' | 'size';

/** A guide line in document units. */
export interface VectorGuideLine {
	kind: VectorGuideKind;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

/** What a point or box snapped to. */
export type VectorSnapKind = 'anchor' | 'centre' | 'intersect' | 'perpendicular' | 'tangent' | 'path' | 'construction' | 'align' | 'spacing' | 'size';

/** A guide label in document units: the snap kind's name, or a distance for gaps and sizes. */
export interface VectorGuideLabel {
	kind: VectorSnapKind;
	x: number;
	y: number;
	text: string;
}

export interface VectorSnapGuides {
	lines: VectorGuideLine[];
	labels: VectorGuideLabel[];
}

export interface VectorPointSnap extends VectorSnapGuides {
	point: Vec2;
	/** The rule that placed the point, or null when nothing was in reach. */
	kind: VectorSnapKind | null;
	/** Whether x / y were set by a target (for falling back to the grid on the other axis). */
	x: boolean;
	y: boolean;
}

export interface VectorRectSnap extends VectorSnapGuides {
	/** Correction to add to the move. */
	dx: number;
	dy: number;
	x: boolean;
	y: boolean;
}

export interface VectorScaleSnap extends VectorSnapGuides {
	sx: number;
	sy: number;
	snapped: boolean;
}

/**
 * The point a drawn point leaves from (the anchor before it, a shape's start, a handle's
 * anchor) and how it keeps to it.
 */
export interface VectorSnapLeave {
	at: Vec2;
	/**
	 * Shift held: keep to 45° steps round `at` (`angle`), to a diagonal (`square`, a box's
	 * corner) or to the nearer axis (`axis`, a dragged point).
	 */
	constrain?: 'angle' | 'square' | 'axis' | null;
	/** Construction guide angles through `at`, degrees counter-clockwise on screen. */
	angles?: readonly number[];
	/** Snap to the perpendicular foot and tangent points from `at` on paths (default true). */
	curves?: boolean;
}

/** The construction guide angles new editors start with. */
export const VECTOR_CONSTRUCTION_ANGLES: readonly number[] = [0, 45, 90, 135];

/** Where `constrain` puts `p` (unchanged without one). */
export function constrainToLeave(leave: VectorSnapLeave | null | undefined, p: Vec2): Vec2 {
	if (!leave?.constrain) return p;
	const dx = p.x - leave.at.x;
	const dy = p.y - leave.at.y;
	switch (leave.constrain) {
		case 'axis':
			return Math.abs(dx) > Math.abs(dy) ? { x: p.x, y: leave.at.y } : { x: leave.at.x, y: p.y };
		case 'square': {
			const s = Math.max(Math.abs(dx), Math.abs(dy));
			return { x: leave.at.x + Math.sign(dx || 1) * s, y: leave.at.y + Math.sign(dy || 1) * s };
		}
		default: {
			const len = Math.hypot(dx, dy);
			const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
			return { x: leave.at.x + Math.cos(a) * len, y: leave.at.y + Math.sin(a) * len };
		}
	}
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

type TargetKind = 'anchor' | 'centre' | 'edge' | 'artboard';

interface PointTarget {
	p: Vec2;
	kind: 'anchor' | 'centre';
}

/** A line to line up with: where it runs on its axis and the target point it comes from. */
interface LineTarget {
	v: number;
	from: Vec2;
	kind: TargetKind;
}

interface SegmentTarget {
	seg: Point[];
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** How many anchors, and how many segments, the targets gather at most. */
const BUDGET = 20_000;
/** The first near segments paired up when looking for intersections. */
const CROSSING_PAIRS = 32;
/** Parameter samples per segment for perpendicular / tangent roots, and bisection steps. */
const CURVE_SAMPLES = 48;
const BISECT = 50;
const EQUAL = 1e-6;

/** First index of `sorted` whose key is not below `v` (`strict`: above `v`). */
function bound<T>(sorted: readonly T[], key: (e: T) => number, v: number, strict: boolean): number {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		const k = key(sorted[mid]);
		if (strict ? k <= v : k < v) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** The entries of `sorted` (ascending by `key`) whose key is within `tol` of `v`, by bisection. */
function within<T>(sorted: readonly T[], key: (e: T) => number, v: number, tol: number): readonly T[] {
	return sorted.slice(bound(sorted, key, v - tol, false), bound(sorted, key, v + tol, true));
}

const linesNear = (lines: readonly LineTarget[], v: number, tol: number) => within(lines, (l) => l.v, v, tol);

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const toPoint = (p: Vec2): Point => [p.x, p.y];
const toVec = (p: Point): Vec2 => ({ x: p[0], y: p[1] });

/** What `collect` gathers from each path besides its anchors and bounds. */
type Gather = 'bounds' | 'segments' | 'drawing';

const LABELS: Record<VectorSnapKind, string> = {
	anchor: 'anchor',
	centre: 'centre',
	intersect: 'intersect',
	perpendicular: 'perpendicular',
	tangent: 'tangent',
	path: 'path',
	construction: 'angle',
	align: 'align',
	spacing: 'spacing',
	size: 'size'
};

const fmtLength = (n: number) => String(Math.round(n * 100) / 100);

/** A node's own (possibly rotated) frame: its size there and its centre in document space. */
function nodeFrame(node: VectorNode, parent: AffineMatrix, aabb?: VectorBounds | null): { width: number; height: number; centre: Vec2 } | null {
	const angle = matrixRotation(multiplyMatrices(nodeMatrix(node), parent));
	const b = angle ? vectorNodeBounds(node, multiplyMatrices(parent, rotateMatrix(-angle))) : aabb !== undefined ? aabb : vectorNodeBounds(node, parent);
	if (!b) return null;
	const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	return { width: b.width, height: b.height, centre: angle ? applyMatrix(rotateMatrix(angle), c) : c };
}

/** True when `id` is `node` or inside it. */
function contains(node: VectorNode, ids: ReadonlySet<string>): boolean {
	if (ids.has(node.id)) return true;
	return node.type === 'group' && node.children.some((c) => contains(c, ids));
}

/**
 * Snap targets in document space, gathered once per gesture. Build them with `forMove`,
 * `forResize`, `forDrawing`, `forAnchorDrag` or `forHandle`, then call `snapFrom`,
 * `snapRect` or `snapScale` on every pointer move. Tolerances are in document units (screen
 * pixels divided by the zoom).
 */
export class VectorSnapTargets {
	private readonly points: PointTarget[] = [];
	private readonly xs: LineTarget[] = [];
	private readonly ys: LineTarget[] = [];
	private readonly segments: SegmentTarget[] = [];
	/** Bounds of the objects a moved box spaces itself evenly with. */
	private readonly boxes: VectorBounds[] = [];
	/** Side lengths of the other objects (in their own frames), which a resize may match. */
	private readonly sizes: number[] = [];
	private segmentTree: VectorRTree | null = null;

	private constructor() {}

	/** How many targets of each sort were gathered. */
	get counts(): { points: number; lines: number; segments: number; boxes: number } {
		return { points: this.points.length, lines: this.xs.length + this.ys.length, segments: this.segments.length, boxes: this.boxes.length };
	}

	/** Targets for moving nodes `ids`: the other art's anchors, bounds and centres, the artboard, and boxes to space evenly with. */
	static forMove(doc: VectorDocument, ids: readonly string[]): VectorSnapTargets {
		return VectorSnapTargets.collect(doc, new Set(ids), 'bounds');
	}

	/** Targets for resizing nodes `ids`: as for a move, plus the other objects' sizes. */
	static forResize(doc: VectorDocument, ids: readonly string[]): VectorSnapTargets {
		return VectorSnapTargets.collect(doc, new Set(ids), 'bounds');
	}

	/**
	 * Targets for a drawn point (pen, shape tools): the art but `exclude`, its anchors (as
	 * points and in line), centres, edges and segments. The anchors and segments of `exclude`
	 * (the path being drawn, whose bounds grow with it) stay targets.
	 */
	static forDrawing(doc: VectorDocument, exclude: readonly string[] = []): VectorSnapTargets {
		const skip = new Set(exclude);
		const t = VectorSnapTargets.collect(doc, skip, 'drawing', false);
		t.pushPaths(doc, skip, () => false, true);
		return t.index();
	}

	/**
	 * Targets for dragging anchors: the other art with its segments, and the anchors and
	 * segments that stay put on the paths being reshaped (their bounds move along, so they are
	 * no targets). The moving anchors are left out.
	 */
	static forAnchorDrag(doc: VectorDocument, anchors: readonly VectorAnchorRef[]): VectorSnapTargets {
		const moving = new Map<string, Set<string>>();
		for (const r of anchors) {
			const set = moving.get(r.nodeId) ?? new Set<string>();
			set.add(`${r.subpath}:${r.index}`);
			moving.set(r.nodeId, set);
		}
		const t = VectorSnapTargets.collect(doc, new Set(moving.keys()), 'segments', false);
		t.pushPaths(doc, new Set(moving.keys()), (id, s, i) => !!moving.get(id)?.has(`${s}:${i}`), true);
		return t.index();
	}

	/**
	 * Targets for dragging a handle of path `nodeId`: the other art and that path's anchors
	 * (its bounds and the segments through the handle move with it, so they would chase it).
	 */
	static forHandle(doc: VectorDocument, nodeId: string): VectorSnapTargets {
		const skip = new Set([nodeId]);
		const t = VectorSnapTargets.collect(doc, skip, 'bounds', false);
		t.pushPaths(doc, skip, () => false, false);
		return t.index();
	}

	/** The anchors of the paths `ids` as targets (on them and in line), and their segments when `segments`. */
	private pushPaths(doc: VectorDocument, ids: ReadonlySet<string>, moving: (id: string, subpath: number, index: number) => boolean, segments: boolean) {
		let anchors = BUDGET;
		let segmentBudget = segments ? BUDGET : 0;
		const visit = (list: readonly VectorNode[], parent: AffineMatrix) => {
			for (const n of list) {
				const m = multiplyMatrices(nodeMatrix(n), parent);
				if (n.type === 'group') visit(n.children, m);
				else if (n.type === 'path' && ids.has(n.id) && n.visible !== false) {
					n.subpaths.forEach((sp, s) => {
						sp.anchors.forEach((a, i) => {
							if (anchors <= 0 || moving(n.id, s, i)) return;
							this.pushAnchor(applyMatrix(m, a));
							anchors--;
						});
						segmentBudget = this.pushSegments(sp, m, (i) => moving(n.id, s, i), segmentBudget);
					});
				}
			}
		};
		visit(doc.nodes, IDENTITY_MATRIX);
	}

	private pushAnchor(p: Vec2) {
		this.points.push({ p, kind: 'anchor' });
		this.xs.push({ v: p.x, from: p, kind: 'anchor' });
		this.ys.push({ v: p.y, from: p, kind: 'anchor' });
	}

	/** The segments of `sp` (mapped by `m`) that stay put while the anchors `moving` accepts move. */
	private pushSegments(sp: VectorSubpath, m: AffineMatrix, moving: (index: number) => boolean, budget: number): number {
		const n = sp.anchors.length;
		const count = subpathSegmentCount(sp);
		for (let i = 0; i < count && budget > 0; i++) {
			if (moving(i) || moving((i + 1) % n)) continue;
			const seg = subpathSegment(sp, i).map((q) => toPoint(applyMatrix(m, toVec(q))));
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const [x, y] of seg) {
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
			this.segments.push({ seg, minX, minY, maxX, maxY });
			budget--;
		}
		return budget;
	}

	private pushRect(r: VectorBounds, kind: TargetKind, centre: Vec2 | null) {
		const corners = [
			{ x: r.x, y: r.y },
			{ x: r.x + r.width, y: r.y },
			{ x: r.x + r.width, y: r.y + r.height },
			{ x: r.x, y: r.y + r.height }
		];
		for (const p of corners) {
			this.xs.push({ v: p.x, from: p, kind });
			this.ys.push({ v: p.y, from: p, kind });
		}
		if (centre) {
			this.points.push({ p: centre, kind: 'centre' });
			this.xs.push({ v: centre.x, from: centre, kind: 'centre' });
			this.ys.push({ v: centre.y, from: centre, kind: 'centre' });
		}
	}

	/** Sorts the targets for `within` (stable: of targets alike, the first gathered wins). */
	private index(): this {
		// Many segments: an R-tree over their control boxes (a scan is quicker for a few).
		this.segmentTree = this.segments.length >= VECTOR_SPATIAL_MIN ? new VectorRTree(this.segments) : null;
		this.points.sort((a, b) => a.p.x - b.p.x);
		this.xs.sort((a, b) => a.v - b.v);
		this.ys.sort((a, b) => a.v - b.v);
		return this;
	}

	/**
	 * Gathers targets from the artboard and every visible node but `exclude` (and what is inside
	 * those): each leaf's anchors (also as lines for `drawing`), its segments (`segments`,
	 * `drawing`), its bounds' corners as lines and its centre; and the top-level objects' boxes and
	 * sizes (inside a group holding an excluded node, that group's other members).
	 */
	private static collect(doc: VectorDocument, exclude: ReadonlySet<string>, gather: Gather, sort = true): VectorSnapTargets {
		const self = new VectorSnapTargets();
		const artboard = { x: 0, y: 0, width: doc.width, height: doc.height };
		self.pushRect(artboard, 'artboard', { x: doc.width / 2, y: doc.height / 2 });
		let anchors = BUDGET;
		let segments = BUDGET;
		const visit = (list: readonly VectorNode[], parent: AffineMatrix) => {
			for (const stored of list) {
				if (exclude.has(stored.id) || stored.visible === false) continue;
				// A mask group snaps to its masked result: its contents' shapes, clipped.
				if (isVectorMaskActive(stored) && !contains(stored, exclude)) {
					visit(vectorAppearanceNodes(stored), multiplyMatrices(nodeMatrix(stored), parent));
					continue;
				}
				// Other art snaps where it draws (path effects and live booleans applied).
				const n = contains(stored, exclude) ? stored : expandVectorAppearance(stored);
				const m = multiplyMatrices(nodeMatrix(n), parent);
				if (n.type === 'group') {
					visit(n.children, m);
					continue;
				}
				if (anchors <= 0 || n.type !== 'path') continue;
				for (const sp of n.subpaths) {
					for (const a of sp.anchors) {
						if (anchors-- <= 0) break;
						const p = applyMatrix(m, a);
						if (gather === 'drawing') self.pushAnchor(p);
						else self.points.push({ p, kind: 'anchor' });
					}
					if (gather !== 'bounds') segments = self.pushSegments(sp, m, () => false, segments);
				}
				const b = vectorNodeBounds(n, parent);
				const f = nodeFrame(n, parent, b);
				if (b) self.pushRect(b, 'edge', f?.centre ?? null);
			}
		};
		visit(doc.nodes, IDENTITY_MATRIX);
		// Boxes to space evenly with and sizes to match: whole objects, opening groups that hold an excluded node.
		const objects = (list: readonly VectorNode[], parent: AffineMatrix) => {
			for (const n of list) {
				if (exclude.has(n.id) || n.visible === false || self.boxes.length >= BUDGET) continue;
				if (n.type === 'group' && contains(n, exclude)) {
					objects(n.children, multiplyMatrices(nodeMatrix(n), parent));
					continue;
				}
				const b = vectorNodeBounds(n, parent);
				if (b) self.boxes.push(b);
				const f = nodeFrame(n, parent, b);
				if (f) self.sizes.push(f.width, f.height);
			}
		};
		objects(doc.nodes, IDENTITY_MATRIX);
		return sort ? self.index() : self;
	}

	// -------------------------------------------------------------------------
	// Points
	// -------------------------------------------------------------------------

	/** Snaps a single point (see `snapFrom`). */
	snapPoint(p: Vec2, tol: number): VectorPointSnap {
		return this.snapFrom(p, null, tol);
	}

	/**
	 * Snaps a point `p`, drawn or dragged from `leave` when given. With `leave.constrain` it keeps
	 * to its angle round `leave.at`, sliding along that way into line with the nearest target.
	 * Otherwise it lands, in order, on an anchor or centre, an intersection of two paths, the
	 * perpendicular foot or a tangent point from `leave.at`, a path, a construction guide
	 * through `leave.at` (where a target's line crosses it if one does nearby), or else lines up
	 * with targets on x and y.
	 */
	snapFrom(p: Vec2, leave: VectorSnapLeave | null | undefined, tol: number): VectorPointSnap {
		const none = (q: Vec2): VectorPointSnap => ({ point: q, kind: null, x: false, y: false, lines: [], labels: [] });
		const at = (q: Vec2, kind: VectorSnapKind, lines: VectorGuideLine[] = []): VectorPointSnap => ({
			point: q,
			kind,
			x: true,
			y: true,
			lines,
			labels: [this.label(q, kind)]
		});
		if (leave?.constrain) {
			const q = constrainToLeave(leave, p);
			const hit = this.slide(leave.at, { x: q.x - leave.at.x, y: q.y - leave.at.y }, q, tol, true);
			return hit ? { point: hit.point, x: true, y: true, ...this.linedUp(hit.point, hit.from) } : none(q);
		}
		const point = this.nearestPoint(p, tol);
		if (point) return at(point.p, point.kind);
		const near = this.segmentsNear(p, tol);
		const crossing = this.crossing(near, p, tol);
		if (crossing) return at(crossing, 'intersect');
		if (leave && leave.curves !== false) {
			const foot = this.curvePoint(near, leave.at, p, tol);
			if (foot) return at(foot.point, foot.kind, [line('construction', leave.at, foot.point)]);
		}
		const on = this.onSegment(near);
		if (on) return at(on, 'path');
		if (leave?.angles?.length) {
			const c = construction(leave, p, tol);
			if (c) {
				const hit = this.slide(leave.at, c.dir, c.point, tol, false);
				if (hit) {
					const lined = this.linedUp(hit.point, hit.from);
					return { point: hit.point, x: true, y: true, kind: lined.kind, lines: [line('construction', leave.at, hit.point), ...lined.lines], labels: lined.labels };
				}
				return { point: c.point, kind: 'construction', x: true, y: true, lines: [line('construction', leave.at, c.point)], labels: [] };
			}
		}
		const nearest = (lines: readonly LineTarget[], v: number) => {
			let best: LineTarget | null = null;
			for (const l of linesNear(lines, v, tol)) if (!best || Math.abs(l.v - v) < Math.abs(best.v - v)) best = l;
			return best;
		};
		const bx = nearest(this.xs, p.x);
		const by = nearest(this.ys, p.y);
		if (!bx && !by) return none(p);
		const out = { x: bx ? bx.v : p.x, y: by ? by.v : p.y };
		const lines: VectorGuideLine[] = [];
		if (bx) lines.push(line('align', bx.from, { x: out.x, y: out.y }));
		if (by) lines.push(line('align', by.from, { x: out.x, y: out.y }));
		return { point: out, kind: 'align', x: !!bx, y: !!by, lines, labels: [this.label(out, 'align')] };
	}

	private label(p: Vec2, kind: VectorSnapKind, text = LABELS[kind]): VectorGuideLabel {
		return { kind, x: p.x, y: p.y, text };
	}

	/** The anchor or centre nearest `p`, within `tol`. */
	private nearestPoint(p: Vec2, tol: number): PointTarget | null {
		let best: PointTarget | null = null;
		let bestD = Infinity;
		for (const t of within(this.points, (e) => e.p.x, p.x, tol)) {
			const d = distance(t.p, p);
			if (d <= tol && d < bestD) {
				best = t;
				bestD = d;
			}
		}
		return best;
	}

	/**
	 * Slides `q`, on the line through `at` along `dir` (beyond `at` only for a `ray`), to where
	 * the nearest target line crosses it, at most twice `tol` away: where it lands and the
	 * target point that line comes from.
	 */
	private slide(at: Vec2, dir: Vec2, q: Vec2, tol: number, ray: boolean): { point: Vec2; from: Vec2 } | null {
		const len2 = dir.x * dir.x + dir.y * dir.y;
		if (!Number.isFinite(len2) || len2 <= 1e-18) return null;
		const reach = 2 * tol;
		let best: { moved: number; point: Vec2; from: Vec2 } | null = null;
		for (const vertical of [true, false]) {
			const d = vertical ? dir.x : dir.y;
			if (Math.abs(d) <= 1e-9) continue;
			const a = vertical ? at.x : at.y;
			for (const l of linesNear(vertical ? this.xs : this.ys, vertical ? q.x : q.y, reach)) {
				const s = (l.v - a) / d;
				// Exactly on the line, whatever the rounding along the way.
				const hit = vertical ? { x: l.v, y: at.y + dir.y * s } : { x: at.x + dir.x * s, y: l.v };
				const moved = distance(hit, q);
				if (moved <= reach && (!ray || s > 0) && (!best || moved < best.moved)) best = { moved, point: hit, from: l.from };
			}
		}
		return best && { point: best.point, from: best.from };
	}

	/** The guides of a point `q` slid into line with the target at `from`: the line and "align", or the target's own label when `q` sits on it. */
	private linedUp(q: Vec2, from: Vec2): { kind: VectorSnapKind } & VectorSnapGuides {
		const on = this.nearestPoint(q, 1e-9);
		if (on) return { kind: on.kind, lines: [], labels: [this.label(on.p, on.kind)] };
		return { kind: 'align', lines: [line('align', from, q)], labels: [this.label(q, 'align')] };
	}

	/** Target segments whose control box reaches `p` and which pass within `tol` of it, nearest first. */
	private segmentsNear(p: Vec2, tol: number): { seg: Point[]; t: number; distance: number }[] {
		const out: { seg: Point[]; t: number; distance: number }[] = [];
		const pt = toPoint(p);
		const candidates = this.segmentTree ? this.segmentTree.search({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol }).map((i) => this.segments[i]) : this.segments;
		for (const s of candidates) {
			if (p.x < s.minX - tol || p.x > s.maxX + tol || p.y < s.minY - tol || p.y > s.maxY + tol) continue;
			const hit = segmentNearest(s.seg, pt);
			if (hit.distance <= tol) out.push({ seg: s.seg, t: hit.t, distance: hit.distance });
		}
		return out.sort((a, b) => a.distance - b.distance);
	}

	private onSegment(near: readonly { seg: Point[]; t: number }[]): Vec2 | null {
		return near.length ? toVec(segmentPoint(near[0].seg, near[0].t)) : null;
	}

	/** Where two of the target segments near `p` cross, the crossing nearest `p` within `tol`. */
	private crossing(near: readonly { seg: Point[] }[], p: Vec2, tol: number): Vec2 | null {
		const list = near.slice(0, CROSSING_PAIRS);
		let best: Vec2 | null = null;
		let bestD = Infinity;
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				for (const hit of segmentIntersections(list[i].seg as BezierSegment, list[j].seg as BezierSegment)) {
					const q = toVec(hit.point);
					const d = distance(q, p);
					if (d <= tol && d < bestD) {
						best = q;
						bestD = d;
					}
				}
			}
		}
		return best;
	}

	/**
	 * The foot of a perpendicular, or a tangent point, from `base` on a target segment near `p`
	 * (within `tol` of it): roots of `(B(t) − base) · B′(t)` and `(B(t) − base) × B′(t)`
	 * bracketed by sign changes of samples and narrowed by bisection.
	 */
	private curvePoint(near: readonly { seg: Point[] }[], base: Vec2, p: Vec2, tol: number): { point: Vec2; kind: 'perpendicular' | 'tangent' } | null {
		let best: { point: Vec2; kind: 'perpendicular' | 'tangent'; d: number } | null = null;
		for (const { seg } of near) {
			for (const kind of ['perpendicular', 'tangent'] as const) {
				if (kind === 'tangent' && seg.length === 2) continue;
				for (const q of solveOnSegment(seg, base, kind === 'perpendicular' ? dotCondition : crossCondition)) {
					const d = distance(q, p);
					if (d <= tol && (!best || d < best.d)) best = { point: q, kind, d };
				}
			}
		}
		return best && { point: best.point, kind: best.kind };
	}

	// -------------------------------------------------------------------------
	// Boxes
	// -------------------------------------------------------------------------

	/**
	 * Snaps a moving box `r` (the moved selection's bounds): its edge or centre nearest a target
	 * line on each axis (`axes` limits which may move). With `spacing`, an axis that lines up
	 * with nothing spaces the box evenly in its row or column. Returns the correction and guides.
	 */
	snapRect(r: VectorBounds, tol: number, options: { spacing?: boolean; axes?: { x?: boolean; y?: boolean } } = {}): VectorRectSnap {
		const axes = { x: options.axes?.x !== false, y: options.axes?.y !== false };
		const nearest = (lines: readonly LineTarget[], values: number[]) => {
			let best: { d: number; from: Vec2 } | null = null;
			for (const v of values) for (const l of linesNear(lines, v, tol)) if (!best || Math.abs(l.v - v) < Math.abs(best.d)) best = { d: l.v - v, from: l.from };
			return best;
		};
		const bx = axes.x ? nearest(this.xs, [r.x, r.x + r.width / 2, r.x + r.width]) : null;
		const by = axes.y ? nearest(this.ys, [r.y, r.y + r.height / 2, r.y + r.height]) : null;
		const out: VectorRectSnap = { dx: bx?.d ?? 0, dy: by?.d ?? 0, x: !!bx, y: !!by, lines: [], labels: [] };
		const done = { ...r, x: r.x + out.dx, y: r.y + out.dy };
		if (bx) {
			const x = bx.from.x;
			out.lines.push({ kind: 'align', x1: x, y1: Math.min(bx.from.y, done.y), x2: x, y2: Math.max(bx.from.y, done.y + done.height) });
		}
		if (by) {
			const y = by.from.y;
			out.lines.push({ kind: 'align', x1: Math.min(by.from.x, done.x), y1: y, x2: Math.max(by.from.x, done.x + done.width), y2: y });
		}
		if (options.spacing && this.boxes.length) {
			for (const horizontal of [true, false]) {
				if (horizontal ? out.x || !axes.x : out.y || !axes.y) continue;
				const moved = { ...r, x: r.x + out.dx, y: r.y + out.dy };
				const even = this.evenSpacing(moved, horizontal, tol);
				if (!even) continue;
				if (horizontal) {
					out.dx += even.shift;
					out.x = true;
				} else {
					out.dy += even.shift;
					out.y = true;
				}
				for (const gap of even.gaps) this.gapMarks(gap, horizontal, tol, out);
			}
		}
		if (bx || by) out.labels.unshift(this.label({ x: r.x + out.dx + r.width / 2, y: r.y + out.dy + r.height / 2 }, 'align'));
		return out;
	}

	/**
	 * Equal spacing along x (`horizontal`) or y for the moved box `r`, among the objects of its
	 * row (column): the shift within `tol` that centres it between its neighbours, or leaves it
	 * as far from the neighbour before or after it as two other objects of the row are apart;
	 * and the gaps that are equal then, as (start, end, where across).
	 */
	private evenSpacing(r: VectorBounds, horizontal: boolean, tol: number): { shift: number; gaps: [number, number, number][] } | null {
		const span = (b: VectorBounds, x: boolean): [number, number] => (x ? [b.x, b.x + b.width] : [b.y, b.y + b.height]);
		const [r0, r1] = span(r, horizontal);
		const len = r1 - r0;
		const [c0, c1] = span(r, !horizontal);
		const row = this.boxes
			.map((b) => ({ b, a0: span(b, horizontal)[0], a1: span(b, horizontal)[1] }))
			.filter((e) => span(e.b, !horizontal)[0] < c1 && span(e.b, !horizontal)[1] > c0 && (e.a1 <= r0 + tol || e.a0 >= r1 - tol))
			.sort((a, b) => a.a0 - b.a0);
		if (!row.length) return null;
		// Across the middle of what two boxes share (or of the space between them).
		const mid = (a: VectorBounds, b: VectorBounds) => (Math.max(span(a, !horizontal)[0], span(b, !horizontal)[0]) + Math.min(span(a, !horizontal)[1], span(b, !horizontal)[1])) / 2;
		const pairs: { g: number; gap: [number, number, number] }[] = [];
		for (const p of row) {
			const next = bound(row, (e) => e.a0, p.a1, false);
			const q = row[next];
			if (!q) continue;
			const straddles = p.a1 <= r0 + tol && q.a0 >= r1 - tol;
			if (q.a0 > p.a1 && !straddles) pairs.push({ g: q.a0 - p.a1, gap: [p.a1, q.a0, mid(p.b, q.b)] });
		}
		let before: (typeof row)[number] | null = null;
		let after: (typeof row)[number] | null = null;
		for (const e of row) {
			if (e.a1 <= r0 + tol && (!before || e.a1 > before.a1)) before = e;
			if (e.a0 >= r1 - tol && (!after || e.a0 < after.a0)) after = e;
		}
		const starts: { start: number; repeats: number | null }[] = [];
		if (before && after && after.a0 - before.a1 > len) starts.push({ start: (before.a1 + after.a0 - len) / 2, repeats: null });
		for (const { g } of pairs) {
			if (before) starts.push({ start: before.a1 + g, repeats: g });
			if (after) starts.push({ start: after.a0 - g - len, repeats: g });
		}
		let pick: { start: number; repeats: number | null } | null = null;
		for (const s of starts) if (Math.abs(s.start - r0) <= tol && (!pick || Math.abs(s.start - r0) < Math.abs(pick.start - r0))) pick = s;
		if (!pick) return null;
		const { start, repeats } = pick;
		const at = horizontal ? { ...r, x: start } : { ...r, y: start };
		const end = start + len;
		const gaps: [number, number, number][] = [];
		if (before && (repeats === null || Math.abs(start - before.a1 - repeats) <= EQUAL)) gaps.push([before.a1, start, mid(before.b, at)]);
		if (after && (repeats === null || Math.abs(after.a0 - end - repeats) <= EQUAL)) gaps.push([end, after.a0, mid(after.b, at)]);
		if (repeats !== null) for (const p of pairs) if (Math.abs(p.g - repeats) <= EQUAL) gaps.push(p.gap);
		return { shift: start - r0, gaps };
	}

	/** A gap mark: a line across the gap with a tick at each end, and its length as a label. */
	private gapMarks([u0, u1, c]: [number, number, number], horizontal: boolean, tick: number, out: VectorSnapGuides) {
		const pt = (u: number, v: number): Vec2 => (horizontal ? { x: u, y: v } : { x: v, y: u });
		out.lines.push(line('spacing', pt(u0, c), pt(u1, c)), line('spacing', pt(u0, c - tick), pt(u0, c + tick)), line('spacing', pt(u1, c - tick), pt(u1, c + tick)));
		out.labels.push(this.label(pt((u0 + u1) / 2, c), 'spacing', fmtLength(u1 - u0)));
	}

	/** The other objects' side length nearest `length`, within `tol`, or null. */
	matchSize(length: number, tol: number): number | null {
		let best: number | null = null;
		for (const s of this.sizes) if (Math.abs(s - length) <= tol && (best === null || Math.abs(s - length) < Math.abs(best - length))) best = s;
		return best;
	}

	/**
	 * Snaps a selection-box resize. `sx / sy` are the scale `scaleFor` gave for dragging
	 * `handle` of `frame` (in the box's own, possibly rotated frame), `mods.shift` keeps the
	 * proportions and `mods.alt` scales about the centre. The handle lands on an anchor or
	 * centre within `tol`, else the corner or the side it moves lines up with the nearest
	 * target, whatever the box's angle; a handle with one way to go (a side, or a proportional
	 * corner) slides along it until one of them is on a target. An axis that snaps to nothing
	 * may match another object's width or height instead.
	 */
	snapScale(
		frame: VectorBounds & { angle: number },
		handle: Exclude<VectorTransformHandle, 'rotate'>,
		sx: number,
		sy: number,
		mods: { shift?: boolean; alt?: boolean },
		tol: number
	): VectorScaleSnap {
		const toDoc = frame.angle ? rotateMatrix(frame.angle) : IDENTITY_MATRIX;
		const toLocal = frame.angle ? rotateMatrix(-frame.angle) : IDENTITY_MATRIX;
		const corner = handle.length === 2;
		const proportional = !!mods.shift;
		const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
		const origin = mods.alt ? centre : handlePos(opposite(handle), frame);
		const hp = handlePos(handle, frame);
		const d0 = { x: hp.x - origin.x, y: hp.y - origin.y };
		const valid = (n: number, s: number) => Number.isFinite(n) && n * s > 0;
		const nearest = (v: number, lines: readonly LineTarget[]) => {
			let best: LineTarget | null = null;
			for (const l of linesNear(lines, v, tol)) if (!best || Math.abs(l.v - v) < Math.abs(best.v - v)) best = l;
			return best;
		};
		type Snap = { hx: LineTarget | null; hy: LineTarget | null; on: PointTarget | null };
		let nx = sx;
		let ny = sy;
		let snap: Snap = { hx: null, hy: null, on: null };
		if (corner && !proportional) {
			// The corner goes anywhere: onto an anchor or centre, else it takes a target's x, its y, or both.
			const p = applyMatrix(toDoc, { x: origin.x + d0.x * sx, y: origin.y + d0.y * sy });
			const hx = nearest(p.x, this.xs);
			const hy = nearest(p.y, this.ys);
			const on = this.nearestPoint(p, tol);
			const tries: { tx: number | null; ty: number | null; s: Snap }[] = [];
			if (on) tries.push({ tx: on.p.x, ty: on.p.y, s: { hx: null, hy: null, on } });
			tries.push({ tx: hx?.v ?? null, ty: hy?.v ?? null, s: { hx, hy, on: null } });
			tries.push({ tx: hx?.v ?? null, ty: null, s: { hx, hy: null, on: null } });
			tries.push({ tx: null, ty: hy?.v ?? null, s: { hx: null, hy, on: null } });
			for (const { tx, ty, s } of tries) {
				if (tx === null && ty === null) continue;
				const q = applyMatrix(toLocal, { x: tx ?? p.x, y: ty ?? p.y });
				let cx = (q.x - origin.x) / d0.x;
				let cy = (q.y - origin.y) / d0.y;
				// Square to the page, the axis without a target stays exactly where it was.
				if (!frame.angle) {
					if (tx === null) cx = sx;
					if (ty === null) cy = sy;
				}
				if (valid(cx, sx) && valid(cy, sy)) {
					nx = cx;
					ny = cy;
					snap = s;
					break;
				}
			}
		} else {
			// One parameter `s`: the scale is `c + s·e` on each axis.
			const movesX = handle === 'e' || handle === 'w';
			let e: Vec2;
			let c: Vec2;
			let s0: number;
			if (corner) [e, c, s0] = [{ x: Math.sign(sx), y: Math.sign(sy) }, { x: 0, y: 0 }, Math.abs(sx)];
			else if (movesX) [e, c, s0] = proportional ? [{ x: 1, y: Math.sign(sx) }, { x: 0, y: 0 }, sx] : [{ x: 1, y: 0 }, { x: 0, y: 1 }, sx];
			else [e, c, s0] = proportional ? [{ x: Math.sign(sy), y: 1 }, { x: 0, y: 0 }, sy] : [{ x: 0, y: 1 }, { x: 1, y: 0 }, sy];
			// The points that may land on a target: the handle, and the two ends of its side.
			const i = RING.indexOf(handle);
			const ends = corner ? [] : [RING[(i + 1) % 8], RING[(i + 7) % 8]];
			// How far the handle travels per unit of `s`: a snap may not drag it far from the pointer.
			const travel = Math.hypot(e.x * d0.x, e.y * d0.y);
			let best: { s: number; inLine: boolean; moved: number; snap: Snap } | null = null;
			const consider = (s: number, inLine: boolean, found: Snap) => {
				const moved = Math.abs(s - s0) * travel;
				if (!valid(s, s0) || moved > 2 * tol) return;
				if (!best || (inLine === best.inLine ? moved < best.moved : !inLine)) best = { s, inLine, moved, snap: found };
			};
			for (const h of [handle, ...ends]) {
				const hv = handlePos(h, frame);
				const v = { x: hv.x - origin.x, y: hv.y - origin.y };
				const base = applyMatrix(toDoc, { x: origin.x + c.x * v.x, y: origin.y + c.y * v.y });
				const dir = applyMatrix(toDoc, { x: e.x * v.x, y: e.y * v.y });
				const p = { x: base.x + dir.x * s0, y: base.y + dir.y * s0 };
				const l2 = dir.x * dir.x + dir.y * dir.y;
				const on = l2 > 1e-18 ? this.nearestPoint(p, tol) : null;
				// An anchor or centre beside its way: it stops at the nearest point of the way.
				if (on) consider(((on.p.x - base.x) * dir.x + (on.p.y - base.y) * dir.y) / l2, false, { hx: null, hy: null, on });
				if (Math.abs(dir.x) > 1e-9) {
					const hit = nearest(p.x, this.xs);
					if (hit) consider((hit.v - base.x) / dir.x, true, { hx: hit, hy: null, on: null });
				}
				if (Math.abs(dir.y) > 1e-9) {
					const hit = nearest(p.y, this.ys);
					if (hit) consider((hit.v - base.y) / dir.y, true, { hx: null, hy: hit, on: null });
				}
			}
			const found = best as { s: number; snap: Snap } | null;
			if (found) {
				nx = c.x + found.s * e.x;
				ny = c.y + found.s * e.y;
				snap = found.snap;
			}
		}
		const out: VectorScaleSnap = { sx: nx, sy: ny, snapped: false, lines: [], labels: [] };
		const handleAt = () => applyMatrix(toDoc, { x: origin.x + d0.x * out.sx, y: origin.y + d0.y * out.sy });
		if (snap.on) {
			out.snapped = true;
			out.labels.push(this.label(snap.on.p, snap.on.kind));
			return out;
		}
		// Sides that line up with nothing may match another object's width or height.
		const movesX = handle !== 'n' && handle !== 's';
		const movesY = handle !== 'e' && handle !== 'w';
		const sized: ('x' | 'y')[] = [];
		if (!proportional) {
			if (movesX && !snap.hx && !(frame.angle && snap.hy) && frame.width > 1e-9) {
				const len = this.matchSize(Math.abs(out.sx) * frame.width, tol);
				if (len !== null && len > 0) {
					out.sx = Math.sign(out.sx || 1) * (len / frame.width);
					sized.push('x');
				}
			}
			if (movesY && !snap.hy && !(frame.angle && snap.hx) && frame.height > 1e-9) {
				const len = this.matchSize(Math.abs(out.sy) * frame.height, tol);
				if (len !== null && len > 0) {
					out.sy = Math.sign(out.sy || 1) * (len / frame.height);
					sized.push('y');
				}
			}
		}
		// The resized box in its frame, and its corners on the page.
		const x0 = origin.x + (frame.x - origin.x) * out.sx;
		const x1 = origin.x + (frame.x + frame.width - origin.x) * out.sx;
		const y0 = origin.y + (frame.y - origin.y) * out.sy;
		const y1 = origin.y + (frame.y + frame.height - origin.y) * out.sy;
		const box = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
		const page = [
			{ x: box.x0, y: box.y0 },
			{ x: box.x1, y: box.y0 },
			{ x: box.x1, y: box.y1 },
			{ x: box.x0, y: box.y1 }
		].map((q) => applyMatrix(toDoc, q));
		const pminY = Math.min(...page.map((q) => q.y));
		const pmaxY = Math.max(...page.map((q) => q.y));
		const pminX = Math.min(...page.map((q) => q.x));
		const pmaxX = Math.max(...page.map((q) => q.x));
		if (snap.hx) out.lines.push({ kind: 'align', x1: snap.hx.v, y1: Math.min(snap.hx.from.y, pminY), x2: snap.hx.v, y2: Math.max(snap.hx.from.y, pmaxY) });
		if (snap.hy) out.lines.push({ kind: 'align', x1: Math.min(snap.hy.from.x, pminX), y1: snap.hy.v, x2: Math.max(snap.hy.from.x, pmaxX), y2: snap.hy.v });
		if (snap.hx || snap.hy) {
			out.snapped = true;
			out.labels.push(this.label(handleAt(), 'align'));
		}
		for (const axis of sized) {
			out.snapped = true;
			// Along the matched side, just outside the box.
			const off = tol * 2;
			const [a, b] = axis === 'x' ? [{ x: box.x0, y: box.y1 + off }, { x: box.x1, y: box.y1 + off }] : [{ x: box.x1 + off, y: box.y0 }, { x: box.x1 + off, y: box.y1 }];
			const pa = applyMatrix(toDoc, a);
			const pb = applyMatrix(toDoc, b);
			out.lines.push(line('size', pa, pb));
			out.labels.push(this.label({ x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, 'size', `${axis === 'x' ? 'W' : 'H'} ${fmtLength(axis === 'x' ? box.x1 - box.x0 : box.y1 - box.y0)}`));
		}
		return out;
	}
}

/** The eight resize handles clockwise from the top left (each side sits between its two corners). */
const RING: readonly Exclude<VectorTransformHandle, 'rotate'>[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function opposite(h: Exclude<VectorTransformHandle, 'rotate'>): Exclude<VectorTransformHandle, 'rotate'> {
	return RING[(RING.indexOf(h) + 4) % 8];
}

function handlePos(h: Exclude<VectorTransformHandle, 'rotate'>, r: VectorBounds): Vec2 {
	const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : r.x + r.width / 2;
	const y = h.startsWith('n') ? r.y : h.startsWith('s') ? r.y + r.height : r.y + r.height / 2;
	return { x, y };
}

function line(kind: VectorGuideKind, a: Vec2, b: Vec2): VectorGuideLine {
	return { kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

/** The construction guide through `leave.at` nearest `p`, within `tol` (and `p` farther than that from `at`): its direction and where `p` lands. */
function construction(leave: VectorSnapLeave, p: Vec2, tol: number): { dir: Vec2; point: Vec2 } | null {
	const v = { x: p.x - leave.at.x, y: p.y - leave.at.y };
	if (Math.hypot(v.x, v.y) <= tol) return null;
	let best: { dir: Vec2; point: Vec2; d: number } | null = null;
	for (const a of leave.angles ?? []) {
		// Counter-clockwise as seen on the y-down page.
		const r = (a * Math.PI) / 180;
		// Exactly along an axis for multiples of 90°.
		const exact = (n: number) => (Math.abs(n) < 1e-12 ? 0 : n);
		const dir = { x: exact(Math.cos(r)), y: exact(-Math.sin(r)) };
		const k = v.x * dir.x + v.y * dir.y;
		const point = { x: leave.at.x + dir.x * k, y: leave.at.y + dir.y * k };
		const d = distance(point, p);
		if (d <= tol && (!best || d < best.d)) best = { dir, point, d };
	}
	return best && { dir: best.dir, point: best.point };
}

const dotCondition = (r: Point, d: Point) => r[0] * d[0] + r[1] * d[1];
const crossCondition = (r: Point, d: Point) => r[0] * d[1] - r[1] * d[0];

/**
 * The points of a segment where `cond(B(t) − base, B′(t))` is zero: sign changes of samples,
 * narrowed by bisection, kept when the normalised condition is (nearly) zero there.
 */
function solveOnSegment(seg: readonly Point[], base: Vec2, cond: (r: Point, d: Point) => number): Vec2[] {
	const b: Point = [base.x, base.y];
	const g = (t: number) => {
		const p = segmentPoint(seg, t);
		return cond([p[0] - b[0], p[1] - b[1]], segmentDerivative(seg, t));
	};
	const vals: number[] = [];
	let scale = 0;
	for (let i = 0; i <= CURVE_SAMPLES; i++) {
		const t = i / CURVE_SAMPLES;
		const p = segmentPoint(seg, t);
		const d = segmentDerivative(seg, t);
		const r: Point = [p[0] - b[0], p[1] - b[1]];
		vals.push(cond(r, d));
		scale = Math.max(scale, Math.hypot(r[0], r[1]) * Math.hypot(d[0], d[1]));
	}
	// Every point qualifies (a line seen from a point on it): no particular solution.
	if (!(scale > 0) || vals.every((v) => Math.abs(v) <= scale * 1e-12)) return [];
	const out: Vec2[] = [];
	for (let i = 0; i < CURVE_SAMPLES; i++) {
		const ga = vals[i];
		const gb = vals[i + 1];
		if (!(Number.isFinite(ga) && Number.isFinite(gb)) || (ga > 0 === gb > 0 && ga !== 0)) continue;
		let lo = i / CURVE_SAMPLES;
		let hi = (i + 1) / CURVE_SAMPLES;
		let flo = ga;
		for (let k = 0; k < BISECT; k++) {
			const m = (lo + hi) / 2;
			const fm = g(m);
			if (fm === 0) {
				lo = hi = m;
				break;
			}
			if (fm > 0 === flo > 0) {
				lo = m;
				flo = fm;
			} else hi = m;
		}
		const t = (lo + hi) / 2;
		const p = segmentPoint(seg, t);
		const dv = segmentDerivative(seg, t);
		const r = Math.hypot(p[0] - b[0], p[1] - b[1]);
		const dl = Math.hypot(dv[0], dv[1]);
		if (!(r > 1e-9 && dl > 0) || Math.abs(cond([p[0] - b[0], p[1] - b[1]], dv)) > 1e-6 * r * dl) continue;
		if (!out.some((q) => Math.hypot(q.x - p[0], q.y - p[1]) <= 1e-9 * (1 + r))) out.push({ x: p[0], y: p[1] });
	}
	return out;
}
