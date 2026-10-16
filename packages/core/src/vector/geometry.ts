/**
 * Vector path geometry: anchors and handles to Bézier paths and back, bounds, hit-testing,
 * affine transforms, segment splitting, anchor-type conversion and shape factories.
 */
import type { Point } from '../canvas/types.js';
import {
	bezierPathBounds,
	bezierPathToSvg,
	transformBezierPath,
	distanceToBezierPath,
	pointInBezierPath,
	segmentNearest,
	segmentPoint,
	splitSegment,
	toBezierPath,
	type AffineMatrix,
	type BezierPath,
	type BezierPathInput
} from '../canvas/pathops/bezier.js';
import { expandVectorCorners, setSubpathCorners } from './corners.js';
import { hitTestVectorStroke, vectorStrokeOutlinePath } from './stroke.js';
import { mirrorWidthProfile } from './width.js';
import type {
	VectorAnchor,
	VectorAnchorType,
	VectorCornerKind,
	VectorBounds,
	VectorDocument,
	VectorGroupNode,
	VectorNode,
	VectorPaint,
	VectorPathNode,
	VectorSubpath,
	Vec2
} from './types.js';

export type { AffineMatrix };

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const cloneAnchor = (a: VectorAnchor): VectorAnchor => ({
	x: a.x,
	y: a.y,
	...(a.in ? { in: { x: a.in.x, y: a.in.y } } : {}),
	...(a.out ? { out: { x: a.out.x, y: a.out.y } } : {}),
	...(a.type && a.type !== 'corner' ? { type: a.type } : {}),
	...(a.corner ? { corner: { ...a.corner } } : {})
});

export const cloneSubpath = (s: VectorSubpath): VectorSubpath => ({ anchors: s.anchors.map(cloneAnchor), closed: s.closed });

/** A deep copy of a node (ids kept). */
export function cloneVectorNode<T extends VectorNode>(node: T): T {
	return JSON.parse(JSON.stringify(node)) as T;
}

export function cloneVectorDocument(doc: VectorDocument): VectorDocument {
	return JSON.parse(JSON.stringify(doc)) as VectorDocument;
}

/** True when the paint draws something (not `null`, `'none'`, `'transparent'` or empty). */
export function hasPaint(paint: VectorPaint | undefined): boolean {
	if (paint === undefined || paint === null) return false;
	if (typeof paint === 'string') {
		const p = paint.trim().toLowerCase();
		return p !== '' && p !== 'none' && p !== 'transparent';
	}
	return true;
}

const handleOf = (a: VectorAnchor, side: 'in' | 'out'): Vec2 => a[side] ?? { x: a.x, y: a.y };
const isOnAnchor = (a: VectorAnchor, h: Vec2 | null | undefined) => !h || (Math.abs(h.x - a.x) < EPS && Math.abs(h.y - a.y) < EPS);

// ---------------------------------------------------------------------------
// Anchors ↔ Bézier
// ---------------------------------------------------------------------------

/** Number of segments of a subpath (a closed one has a segment from the last anchor back to the first). */
export function subpathSegmentCount(sp: VectorSubpath): number {
	const n = sp.anchors.length;
	if (n < 2) return 0;
	return sp.closed ? n : n - 1;
}

/** Control points of segment `i` of a subpath: 2 for a line, 4 for a cubic. */
export function subpathSegment(sp: VectorSubpath, i: number): Point[] {
	const a = sp.anchors[i];
	const b = sp.anchors[(i + 1) % sp.anchors.length];
	if (isOnAnchor(a, a.out) && isOnAnchor(b, b.in)) return [[a.x, a.y], [b.x, b.y]];
	const c1 = handleOf(a, 'out');
	const c2 = handleOf(b, 'in');
	return [[a.x, a.y], [c1.x, c1.y], [c2.x, c2.y], [b.x, b.y]];
}

/**
 * Absolute `M` / `L` / `C` / `Z` commands of subpaths, with live corners cut
 * (`expandVectorCorners`). Pass `{ corners: false }` for the stored anchors as they are.
 */
export function subpathsToBezier(subpaths: readonly VectorSubpath[], options: { corners?: boolean } = {}): BezierPath {
	const out: BezierPath = [];
	for (const sp of options.corners === false ? subpaths : expandVectorCorners(subpaths)) {
		if (sp.anchors.length === 0) continue;
		const first = sp.anchors[0];
		out.push({ type: 'M', x: first.x, y: first.y });
		const count = subpathSegmentCount(sp);
		for (let i = 0; i < count; i++) {
			const seg = subpathSegment(sp, i);
			if (sp.closed && i === count - 1 && seg.length === 2) break; // `Z` draws the closing line.
			if (seg.length === 2) out.push({ type: 'L', x: seg[1][0], y: seg[1][1] });
			else out.push({ type: 'C', x1: seg[1][0], y1: seg[1][1], x2: seg[2][0], y2: seg[2][1], x: seg[3][0], y: seg[3][1] });
		}
		if (sp.closed) out.push({ type: 'Z' });
	}
	return out;
}

/** The node's outline as Bézier commands. Groups have none. */
export function vectorNodeToBezier(node: VectorNode): BezierPath {
	return node.type === 'path' ? subpathsToBezier(node.subpaths) : [];
}

/** SVG path data (`d`) of a path node or subpaths. */
export function vectorPathData(input: VectorPathNode | readonly VectorSubpath[], precision = 3): string {
	const subpaths = Array.isArray(input) ? (input as readonly VectorSubpath[]) : (input as VectorPathNode).subpaths;
	return bezierPathToSvg(subpathsToBezier(subpaths), { precision });
}

/** Infers the anchor type from its handles. */
export function inferAnchorType(a: VectorAnchor): VectorAnchorType {
	if (isOnAnchor(a, a.in) || isOnAnchor(a, a.out)) return 'corner';
	const ix = a.in!.x - a.x;
	const iy = a.in!.y - a.y;
	const ox = a.out!.x - a.x;
	const oy = a.out!.y - a.y;
	const li = Math.hypot(ix, iy);
	const lo = Math.hypot(ox, oy);
	const cross = (ix * oy - iy * ox) / (li * lo);
	const dot = (ix * ox + iy * oy) / (li * lo);
	if (Math.abs(cross) > 1e-3 || dot > 0) return 'corner';
	return Math.abs(li - lo) <= 1e-3 * Math.max(li, lo) ? 'symmetric' : 'smooth';
}

/**
 * Converts SVG path data or Bézier commands to editable subpaths. Quadratics become cubics,
 * arcs become cubics, a closing anchor that repeats the first one is merged into it, and
 * each anchor's type is inferred from its handles.
 */
export function bezierToSubpaths(input: BezierPathInput): VectorSubpath[] {
	const path = toBezierPath(input);
	const out: VectorSubpath[] = [];
	let current: VectorSubpath | null = null;
	const last = () => current!.anchors[current!.anchors.length - 1];
	for (const cmd of path) {
		switch (cmd.type) {
			case 'M':
				current = { anchors: [{ x: cmd.x, y: cmd.y }], closed: false };
				out.push(current);
				break;
			case 'L':
				current!.anchors.push({ x: cmd.x, y: cmd.y });
				break;
			case 'Q': {
				const p0 = last();
				p0.out = { x: p0.x + (2 / 3) * (cmd.x1 - p0.x), y: p0.y + (2 / 3) * (cmd.y1 - p0.y) };
				current!.anchors.push({ x: cmd.x, y: cmd.y, in: { x: cmd.x + (2 / 3) * (cmd.x1 - cmd.x), y: cmd.y + (2 / 3) * (cmd.y1 - cmd.y) } });
				break;
			}
			case 'C':
				last().out = { x: cmd.x1, y: cmd.y1 };
				current!.anchors.push({ x: cmd.x, y: cmd.y, in: { x: cmd.x2, y: cmd.y2 } });
				break;
			case 'Z': {
				if (!current) break;
				current.closed = true;
				const anchors = current.anchors;
				if (anchors.length > 1) {
					const first = anchors[0];
					const end = anchors[anchors.length - 1];
					if (Math.abs(end.x - first.x) < 1e-7 && Math.abs(end.y - first.y) < 1e-7) {
						if (end.in) first.in = end.in;
						anchors.pop();
					}
				}
				current = null;
				break;
			}
		}
	}
	for (const sp of out) {
		for (const a of sp.anchors) {
			if (isOnAnchor(a, a.in)) delete a.in;
			if (isOnAnchor(a, a.out)) delete a.out;
			const type = inferAnchorType(a);
			if (type !== 'corner') a.type = type;
		}
	}
	return out.filter((sp) => sp.anchors.length > 0);
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/** Calls `fn` for every node, depth first, parents before children. */
export function walkVectorNodes(nodes: readonly VectorNode[], fn: (node: VectorNode, parent: VectorGroupNode | null, depth: number) => void): void {
	const visit = (list: readonly VectorNode[], parent: VectorGroupNode | null, depth: number) => {
		for (const node of list) {
			fn(node, parent, depth);
			if (node.type === 'group') visit(node.children, node, depth + 1);
		}
	};
	visit(nodes, null, 0);
}

/** Finds a node by id anywhere in the tree. */
export function findVectorNode(nodes: readonly VectorNode[], id: string): VectorNode | undefined {
	for (const node of nodes) {
		if (node.id === id) return node;
		if (node.type === 'group') {
			const found = findVectorNode(node.children, id);
			if (found) return found;
		}
	}
	return undefined;
}

/** The list that contains node `id` (the root list or a group's children) and its index there. */
export function locateVectorNode(nodes: VectorNode[], id: string): { list: VectorNode[]; index: number; parent: VectorGroupNode | null } | null {
	const search = (list: VectorNode[], parent: VectorGroupNode | null): ReturnType<typeof locateVectorNode> => {
		for (let i = 0; i < list.length; i++) {
			const node = list[i];
			if (node.id === id) return { list, index: i, parent };
			if (node.type === 'group') {
				const found = search(node.children, node);
				if (found) return found;
			}
		}
		return null;
	};
	return search(nodes, null);
}

/** Every path node in the subtree (a path node itself, or a group's descendants). */
export function collectPathNodes(node: VectorNode): VectorPathNode[] {
	if (node.type === 'path') return [node];
	const out: VectorPathNode[] = [];
	walkVectorNodes(node.children, (n) => {
		if (n.type === 'path') out.push(n);
	});
	return out;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** The node's local → parent matrix (identity when it has no `transform`). */
export function nodeMatrix(node: VectorNode): AffineMatrix {
	return node.transform ?? IDENTITY_MATRIX;
}

/** A path node's outline in the space `parent` maps to (default: its parent's space). */
export function vectorPathWorldBezier(node: VectorPathNode, parent: AffineMatrix = IDENTITY_MATRIX): BezierPath {
	const m = multiplyMatrices(nodeMatrix(node), parent);
	const path = subpathsToBezier(node.subpaths);
	return isIdentityMatrix(m) ? path : transformBezierPath(path, m);
}

/**
 * Geometric bounds of a node (stroke width not included) in the space `parent` maps to —
 * by default the node's parent space, which for top-level nodes is the document. Null when
 * the node has no points.
 */
export function vectorNodeBounds(node: VectorNode, parent: AffineMatrix = IDENTITY_MATRIX): VectorBounds | null {
	if (node.type === 'group') {
		const m = multiplyMatrices(nodeMatrix(node), parent);
		return unionBounds(node.children.map((c) => vectorNodeBounds(c, m)));
	}
	const b = bezierPathBounds(vectorPathWorldBezier(node, parent));
	if (!b) return null;
	return { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY };
}

/** The smallest box around all non-null boxes, or null. */
export function unionBounds(list: readonly (VectorBounds | null | undefined)[]): VectorBounds | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const b of list) {
		if (!b) continue;
		minX = Math.min(minX, b.x);
		minY = Math.min(minY, b.y);
		maxX = Math.max(maxX, b.x + b.width);
		maxY = Math.max(maxY, b.y + b.height);
	}
	if (minX === Infinity) return null;
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** True when two boxes overlap (touching counts). */
export function boundsIntersect(a: VectorBounds, b: VectorBounds): boolean {
	return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/** A box from two corners in any order. */
export function boundsFromPoints(a: Vec2, b: Vec2): VectorBounds {
	return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

/**
 * Whether `p` hits a node: inside its fill (when it has one), on its stroke as drawn (its
 * alignment and arrowheads respected) or within `tolerance` of either. A group is hit when
 * any visible child is.
 */
export function hitTestVectorNode(node: VectorNode, p: Vec2, tolerance = 0, parent: AffineMatrix = IDENTITY_MATRIX): boolean {
	if (node.visible === false) return false;
	if (node.type === 'group') {
		const m = multiplyMatrices(nodeMatrix(node), parent);
		return node.children.some((c) => hitTestVectorNode(c, p, tolerance, m));
	}
	const path = vectorPathWorldBezier(node, parent);
	if (path.length === 0) return false;
	const point: Point = [p.x, p.y];
	if (hasPaint(node.fill) && pointInBezierPath(path, point, node.fillRule ?? 'nonzero')) return true;
	if (hasPaint(node.stroke)) return hitTestVectorStroke(path, p, node, tolerance);
	return distanceToBezierPath(path, point) <= tolerance;
}

/**
 * The area a path node's stroke paints (alignment, caps, joins, dashes and arrowheads
 * included), as a filled path in the space `parent` maps to. Empty without a stroke.
 */
export function vectorStrokeOutline(node: VectorPathNode, parent: AffineMatrix = IDENTITY_MATRIX): BezierPath {
	if (!hasPaint(node.stroke) || !((node.strokeWidth ?? 1) > 0)) return [];
	return vectorStrokeOutlinePath(vectorPathWorldBezier(node, parent), node);
}

/** The topmost node hit by `p` (skipping hidden and locked ones), or null. */
export function hitTestVectorNodes(nodes: readonly VectorNode[], p: Vec2, tolerance = 0): VectorNode | null {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i];
		if (node.visible === false || node.locked) continue;
		if (hitTestVectorNode(node, p, tolerance)) return node;
	}
	return null;
}

export interface NearestSegment {
	subpath: number;
	segment: number;
	/** Curve parameter 0–1 on the segment. */
	t: number;
	point: Vec2;
	distance: number;
}

/** The closest point on any segment of a path node (`p` and the result are in the node's own space). */
export function nearestSegment(node: VectorPathNode, p: Vec2): NearestSegment | null {
	let best: NearestSegment | null = null;
	node.subpaths.forEach((sp, s) => {
		const count = subpathSegmentCount(sp);
		for (let i = 0; i < count; i++) {
			const seg = subpathSegment(sp, i);
			const hit = segmentNearest(seg, [p.x, p.y]);
			if (!best || hit.distance < best.distance) {
				const pt = segmentPoint(seg, hit.t);
				best = { subpath: s, segment: i, t: hit.t, point: { x: pt[0], y: pt[1] }, distance: hit.distance };
			}
		}
	});
	return best;
}

// ---------------------------------------------------------------------------
// Affine transforms
// ---------------------------------------------------------------------------

export const IDENTITY_MATRIX: AffineMatrix = [1, 0, 0, 1, 0, 0];

/** `a` then `b` (apply `a` first). */
export function multiplyMatrices(a: AffineMatrix, b: AffineMatrix): AffineMatrix {
	const [a0, a1, a2, a3, a4, a5] = a;
	const [b0, b1, b2, b3, b4, b5] = b;
	return [b0 * a0 + b2 * a1, b1 * a0 + b3 * a1, b0 * a2 + b2 * a3, b1 * a2 + b3 * a3, b0 * a4 + b2 * a5 + b4, b1 * a4 + b3 * a5 + b5];
}

export const translateMatrix = (dx: number, dy: number): AffineMatrix => [1, 0, 0, 1, dx, dy];

export function scaleMatrix(sx: number, sy: number, origin: Vec2 = { x: 0, y: 0 }): AffineMatrix {
	return [sx, 0, 0, sy, origin.x - sx * origin.x, origin.y - sy * origin.y];
}

/** Rotation by `degrees` clockwise (y points down) around `origin`. */
export function rotateMatrix(degrees: number, origin: Vec2 = { x: 0, y: 0 }): AffineMatrix {
	const r = (degrees * Math.PI) / 180;
	const cos = Math.cos(r);
	const sin = Math.sin(r);
	return [cos, sin, -sin, cos, origin.x - cos * origin.x + sin * origin.y, origin.y - sin * origin.x - cos * origin.y];
}

export function applyMatrix(m: AffineMatrix, p: Vec2): Vec2 {
	return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function isIdentityMatrix(m: AffineMatrix, eps = 1e-12): boolean {
	return Math.abs(m[0] - 1) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] - 1) < eps && Math.abs(m[4]) < eps && Math.abs(m[5]) < eps;
}

/** The inverse matrix (the identity for a singular one). */
export function invertMatrix(m: AffineMatrix): AffineMatrix {
	const [a, b, c, d, e, f] = m;
	const det = a * d - b * c;
	if (!det || !Number.isFinite(det)) return IDENTITY_MATRIX;
	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Applies only the linear part (for directions and offsets). */
export function applyMatrixLinear(m: AffineMatrix, v: Vec2): Vec2 {
	return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}

/**
 * The rotation of a matrix in degrees, clockwise (y down), in (−180, 180]. For a mirrored
 * matrix it is the rotation left after undoing a horizontal flip, so a flipped rotated shape
 * keeps its angle.
 */
export function matrixRotation(m: AffineMatrix): number {
	const [a, b, c, d] = m;
	const mirrored = a * d - b * c < 0;
	const deg = ((mirrored ? Math.atan2(-b - c, d - a) : Math.atan2(b - c, a + d)) * 180) / Math.PI;
	return Math.abs(deg) < 1e-9 ? 0 : deg;
}

/**
 * Splits `m` into `residual` then `rigid` (`m = residual × rigid` in apply order): `rigid` is
 * the nearest rotation plus the translation, `residual` the linear rest (scale, skew,
 * reflection). An unrotated `m` gives an identity `rigid` and everything in `residual`.
 */
export function decomposeRigid(m: AffineMatrix): { rigid: AffineMatrix; residual: AffineMatrix } {
	const [a, b, c, d, e, f] = m;
	const deg = matrixRotation(m);
	if (deg === 0) return { rigid: IDENTITY_MATRIX, residual: m };
	const r = (deg * Math.PI) / 180;
	const cos = Math.cos(r);
	const sin = Math.sin(r);
	return {
		rigid: [cos, sin, -sin, cos, e, f],
		residual: [cos * a + sin * b, -sin * a + cos * b, cos * c + sin * d, -sin * c + cos * d, 0, 0]
	};
}

function mapAnchor(a: VectorAnchor, m: AffineMatrix): VectorAnchor {
	const p = applyMatrix(m, a);
	const next: VectorAnchor = { x: p.x, y: p.y };
	if (a.in) next.in = applyMatrix(m, a.in);
	if (a.out) next.out = applyMatrix(m, a.out);
	if (a.type) next.type = a.type;
	if (a.corner) next.corner = { ...a.corner };
	return next;
}

/** Every anchor and handle mapped through `m` (the node's own `transform` is untouched). */
function bakeIntoGeometry<T extends VectorNode>(node: T, m: AffineMatrix): T {
	if (isIdentityMatrix(m)) return node;
	if (node.type === 'group') {
		const group = node as VectorGroupNode;
		const children = group.children.map((c) => transformVectorNode(c, m));
		// A blend's replaced spine lives in the group's space too.
		const spine = group.blend?.spine;
		if (!spine) return { ...group, children } as T;
		const moved = { closed: spine.closed, anchors: spine.anchors.map((a) => mapAnchor(a, m)) };
		return { ...group, children, blend: { ...group.blend, spine: moved } } as T;
	}
	const path = node as VectorPathNode;
	// A mirror swaps the sides of a variable-width stroke (the path still runs the same way).
	const mirrored = m[0] * m[3] - m[1] * m[2] < 0 && path.strokeWidthProfile?.length;
	return {
		...path,
		...(mirrored ? { strokeWidthProfile: mirrorWidthProfile(path.strokeWidthProfile!) } : {}),
		subpaths: path.subpaths.map((sp) => ({
			closed: sp.closed,
			anchors: sp.anchors.map((a) => mapAnchor(a, m))
		}))
	} as T;
}

/**
 * A copy of the node moved by `m`, given in its parent's space. The node's rotation and
 * translation go to its rigid `transform`; scale and skew are baked into its anchors (or its
 * children), so the result draws exactly as `m` says. Stroke widths are kept.
 */
export function transformVectorNode<T extends VectorNode>(node: T, m: AffineMatrix): T {
	const total = multiplyMatrices(nodeMatrix(node), m);
	const { rigid, residual } = decomposeRigid(total);
	const { transform: _old, ...rest } = node as VectorNode;
	const baked = bakeIntoGeometry(rest as T, residual);
	return isIdentityMatrix(rigid) ? baked : ({ ...baked, transform: rigid } as T);
}

/** The node's rotation in degrees (from its `transform` and its ancestors' when `parent` is given). */
export function vectorNodeRotation(node: VectorNode, parent: AffineMatrix = IDENTITY_MATRIX): number {
	return matrixRotation(multiplyMatrices(nodeMatrix(node), parent));
}

/** The local → document matrix of node `id` (ancestors' transforms included), or null. */
export function vectorWorldMatrix(nodes: readonly VectorNode[], id: string): AffineMatrix | null {
	const search = (list: readonly VectorNode[], parent: AffineMatrix): AffineMatrix | null => {
		for (const n of list) {
			const m = multiplyMatrices(nodeMatrix(n), parent);
			if (n.id === id) return m;
			if (n.type === 'group') {
				const found = search(n.children, m);
				if (found) return found;
			}
		}
		return null;
	};
	return search(nodes, IDENTITY_MATRIX);
}

/** The parent space → document matrix of node `id` (identity for top-level nodes), or null. */
export function vectorParentMatrix(nodes: readonly VectorNode[], id: string): AffineMatrix | null {
	const node = findVectorNode(nodes, id);
	const world = vectorWorldMatrix(nodes, id);
	if (!node || !world) return null;
	return multiplyMatrices(invertMatrix(nodeMatrix(node)), world);
}

// ---------------------------------------------------------------------------
// Anchor editing
// ---------------------------------------------------------------------------

/** Moves an anchor and its handles by (dx, dy). */
export function translateAnchor(a: VectorAnchor, dx: number, dy: number): VectorAnchor {
	const next = cloneAnchor(a);
	next.x += dx;
	next.y += dy;
	if (next.in) next.in = { x: next.in.x + dx, y: next.in.y + dy };
	if (next.out) next.out = { x: next.out.x + dx, y: next.out.y + dy };
	return next;
}

/**
 * Moves one handle to `pos`, keeping the other in line for `smooth` anchors and mirrored for
 * `symmetric` ones. With `breakHandles` the anchor becomes a `corner` and only this handle moves.
 */
export function moveAnchorHandle(a: VectorAnchor, side: 'in' | 'out', pos: Vec2, breakHandles = false): VectorAnchor {
	const next = cloneAnchor(a);
	next[side] = { x: pos.x, y: pos.y };
	const other = side === 'in' ? 'out' : 'in';
	const type = breakHandles ? 'corner' : (a.type ?? 'corner');
	if (breakHandles) delete next.type;
	const dx = pos.x - a.x;
	const dy = pos.y - a.y;
	const len = Math.hypot(dx, dy);
	if (type === 'symmetric') next[other] = { x: a.x - dx, y: a.y - dy };
	else if (type === 'smooth' && len > EPS) {
		const o = a[other];
		const olen = o ? Math.hypot(o.x - a.x, o.y - a.y) : len;
		next[other] = { x: a.x - (dx / len) * olen, y: a.y - (dy / len) * olen };
	}
	if (isOnAnchor(next, next.in)) delete next.in;
	if (isOnAnchor(next, next.out)) delete next.out;
	return next;
}

/**
 * Converts anchor `index` of a subpath. `corner` removes both handles; `smooth` and
 * `symmetric` keep existing handles in line, or add handles a third of the way to the
 * neighbours along the line between them.
 */
export function convertAnchor(sp: VectorSubpath, index: number, type: VectorAnchorType): VectorSubpath {
	const anchors = sp.anchors.map(cloneAnchor);
	const a = anchors[index];
	if (!a) return { anchors, closed: sp.closed };
	if (type === 'corner') {
		delete a.in;
		delete a.out;
		delete a.type;
		return { anchors, closed: sp.closed };
	}
	const n = anchors.length;
	const prev = index > 0 ? anchors[index - 1] : sp.closed ? anchors[n - 1] : null;
	const next = index < n - 1 ? anchors[index + 1] : sp.closed ? anchors[0] : null;
	let dir: Vec2 | null = null;
	let lenIn = 0;
	let lenOut = 0;
	if (!isOnAnchor(a, a.out)) dir = { x: a.out!.x - a.x, y: a.out!.y - a.y };
	else if (!isOnAnchor(a, a.in)) dir = { x: a.x - a.in!.x, y: a.y - a.in!.y };
	else if (prev && next) dir = { x: next.x - prev.x, y: next.y - prev.y };
	else if (next) dir = { x: next.x - a.x, y: next.y - a.y };
	else if (prev) dir = { x: a.x - prev.x, y: a.y - prev.y };
	if (!dir || Math.hypot(dir.x, dir.y) < EPS) return { anchors, closed: sp.closed };
	const dl = Math.hypot(dir.x, dir.y);
	const ux = dir.x / dl;
	const uy = dir.y / dl;
	lenIn = a.in && !isOnAnchor(a, a.in) ? Math.hypot(a.in.x - a.x, a.in.y - a.y) : prev ? Math.hypot(prev.x - a.x, prev.y - a.y) / 3 : 0;
	lenOut = a.out && !isOnAnchor(a, a.out) ? Math.hypot(a.out.x - a.x, a.out.y - a.y) : next ? Math.hypot(next.x - a.x, next.y - a.y) / 3 : 0;
	if (type === 'symmetric') lenIn = lenOut = (lenIn + lenOut) / 2 || Math.max(lenIn, lenOut);
	if (lenIn > EPS) a.in = { x: a.x - ux * lenIn, y: a.y - uy * lenIn };
	if (lenOut > EPS) a.out = { x: a.x + ux * lenOut, y: a.y + uy * lenOut };
	a.type = type;
	return { anchors, closed: sp.closed };
}

/**
 * Inserts an anchor on segment `segment` at parameter `t` without changing the curve's
 * shape (de Casteljau split). Returns the new subpath and the new anchor's index.
 */
export function insertAnchor(sp: VectorSubpath, segment: number, t: number): { subpath: VectorSubpath; index: number } {
	const anchors = sp.anchors.map(cloneAnchor);
	const n = anchors.length;
	const ia = segment;
	const ib = (segment + 1) % n;
	const seg = subpathSegment(sp, segment);
	const [left, right] = splitSegment(seg, t);
	const mid = left[left.length - 1];
	const anchor: VectorAnchor = { x: mid[0], y: mid[1] };
	if (seg.length === 4) {
		anchors[ia].out = { x: left[1][0], y: left[1][1] };
		anchor.in = { x: left[2][0], y: left[2][1] };
		anchor.out = { x: right[1][0], y: right[1][1] };
		anchor.type = 'smooth';
		anchors[ib].in = { x: right[2][0], y: right[2][1] };
		for (const k of [ia, ib]) if (isOnAnchor(anchors[k], anchors[k].in)) delete anchors[k].in;
		for (const k of [ia, ib]) if (isOnAnchor(anchors[k], anchors[k].out)) delete anchors[k].out;
	}
	const index = segment + 1;
	anchors.splice(index, 0, anchor);
	return { subpath: { anchors, closed: sp.closed }, index };
}

/**
 * Removes anchors from a subpath. An open subpath with fewer than 2 anchors left, or a
 * closed one with fewer than 2, is returned with whatever remains (callers drop empty ones).
 */
export function removeAnchors(sp: VectorSubpath, indices: readonly number[]): VectorSubpath {
	const drop = new Set(indices);
	return { anchors: sp.anchors.filter((_, i) => !drop.has(i)).map(cloneAnchor), closed: sp.closed };
}

/** Reverses a subpath's direction (handles swap sides). */
export function reverseSubpath(sp: VectorSubpath): VectorSubpath {
	const anchors = sp.anchors
		.slice()
		.reverse()
		.map((a) => {
			const next: VectorAnchor = { x: a.x, y: a.y };
			if (a.out) next.in = { ...a.out };
			if (a.in) next.out = { ...a.in };
			if (a.type) next.type = a.type;
			if (a.corner) next.corner = { ...a.corner };
			return next;
		});
	return { anchors, closed: sp.closed };
}

// ---------------------------------------------------------------------------
// Shape factories
// ---------------------------------------------------------------------------

/** Handle length that makes a cubic approximate a quarter circle. */
export const KAPPA = 0.5522847498307936;

/**
 * A rectangle. A `radius` becomes a live corner on each of its four anchors (drawn round, and
 * clamped to half the shorter side, when the path is turned into curves).
 */
export function rectSubpath(b: VectorBounds, radius = 0, kind?: VectorCornerKind): VectorSubpath {
	const { x, y, width: w, height: h } = b;
	const sp: VectorSubpath = { anchors: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], closed: true };
	return radius > 0 ? setSubpathCorners(sp, radius, kind) : sp;
}

/** An ellipse inscribed in a box (four smooth anchors). */
export function ellipseSubpath(b: VectorBounds): VectorSubpath {
	const rx = b.width / 2;
	const ry = b.height / 2;
	const cx = b.x + rx;
	const cy = b.y + ry;
	const kx = rx * KAPPA;
	const ky = ry * KAPPA;
	return {
		closed: true,
		anchors: [
			{ x: cx, y: cy - ry, in: { x: cx - kx, y: cy - ry }, out: { x: cx + kx, y: cy - ry }, type: 'symmetric' },
			{ x: cx + rx, y: cy, in: { x: cx + rx, y: cy - ky }, out: { x: cx + rx, y: cy + ky }, type: 'symmetric' },
			{ x: cx, y: cy + ry, in: { x: cx + kx, y: cy + ry }, out: { x: cx - kx, y: cy + ry }, type: 'symmetric' },
			{ x: cx - rx, y: cy, in: { x: cx - rx, y: cy + ky }, out: { x: cx - rx, y: cy - ky }, type: 'symmetric' }
		]
	};
}

/** A regular polygon inscribed in a box, first vertex at the top. */
export function polygonSubpath(b: VectorBounds, sides = 6): VectorSubpath {
	const n = Math.max(3, Math.round(sides));
	const cx = b.x + b.width / 2;
	const cy = b.y + b.height / 2;
	const anchors: VectorAnchor[] = [];
	for (let i = 0; i < n; i++) {
		const t = -Math.PI / 2 + (i * 2 * Math.PI) / n;
		anchors.push({ x: cx + (Math.cos(t) * b.width) / 2, y: cy + (Math.sin(t) * b.height) / 2 });
	}
	return { anchors, closed: true };
}

/** A star inscribed in a box, first point at the top. `innerRatio` is inner / outer radius. */
export function starSubpath(b: VectorBounds, points = 5, innerRatio = 0.5): VectorSubpath {
	const n = Math.max(3, Math.round(points));
	const cx = b.x + b.width / 2;
	const cy = b.y + b.height / 2;
	const anchors: VectorAnchor[] = [];
	for (let i = 0; i < n * 2; i++) {
		const t = -Math.PI / 2 + (i * Math.PI) / n;
		const r = i % 2 === 0 ? 1 : innerRatio;
		anchors.push({ x: cx + (Math.cos(t) * r * b.width) / 2, y: cy + (Math.sin(t) * r * b.height) / 2 });
	}
	return { anchors, closed: true };
}

/** A straight open line. */
export function lineSubpath(a: Vec2, b: Vec2): VectorSubpath {
	return { anchors: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], closed: false };
}

/** Rounds every coordinate to `precision` decimals (stable JSON and SVG output). */
export function roundSubpaths(subpaths: readonly VectorSubpath[], precision = 3): VectorSubpath[] {
	const f = 10 ** precision;
	const r = (n: number) => Math.round(n * f) / f;
	const rp = (p: Vec2) => ({ x: r(p.x), y: r(p.y) });
	return subpaths.map((sp) => ({
		closed: sp.closed,
		anchors: sp.anchors.map((a) => ({ ...cloneAnchor(a), x: r(a.x), y: r(a.y), ...(a.in ? { in: rp(a.in) } : {}), ...(a.out ? { out: rp(a.out) } : {}) }))
	}));
}
