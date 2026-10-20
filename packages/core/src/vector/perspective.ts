/**
 * Perspective (projective) maps between quadrilaterals: what Free Distort needs. The maths is
 * shared with the image editor's Free Transform and lives in `src/geom/homography.ts`; these are
 * its vector-named exports.
 *
 * Perspective grids (drawing in perspective, after CorelDRAW's Perspective Drawing, concept only)
 * build one projective map per plane from the vanishing points: its columns are the plane's two
 * directions (toward a vanishing point, or a fixed direction for a point at infinity) and the
 * origin. Plane coordinates are document units at the origin, x right and y up as seen there.
 */
import { applyHomography as applyH, invertHomography } from '../geom/homography.js';
import type { Homography } from '../geom/types.js';
import { mapBezierPath } from './pathMap.js';
import type { BezierPath } from '../canvas/pathops/bezier.js';
import type { Vec2, VectorPerspective, VectorPerspectivePlane } from './types.js';

export {
	solve8,
	applyHomography as applyVectorHomography,
	homographyFromPoints as vectorHomography,
	homographyKeepsQuad as vectorHomographyKeepsQuad,
	orderQuad as orderVectorQuad
} from '../geom/homography.js';

/** A 3×3 projective map, row-major, normalised so that the last entry is 1. */
export type { Homography as VectorHomography } from '../geom/types.js';

// ---------------------------------------------------------------------------
// Perspective grids (drawing in perspective)
// ---------------------------------------------------------------------------

/** The planes a grid with this many vanishing points has. */
export function vectorPerspectivePlanes(p: Pick<VectorPerspective, 'vanishingPoints'>): VectorPerspectivePlane[] {
	return p.vanishingPoints.length <= 1 ? ['floor', 'side', 'front'] : ['floor', 'left', 'right'];
}

/** Reads a perspective grid from untrusted data; null when invalid. */
export function sanitizeVectorPerspective(value: unknown): VectorPerspective | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	const isPt = (v: unknown): v is Vec2 => !!v && typeof v === 'object' && Number.isFinite((v as Vec2).x) && Number.isFinite((v as Vec2).y);
	if (!Array.isArray(r.vanishingPoints) || r.vanishingPoints.length < 1 || r.vanishingPoints.length > 3 || !r.vanishingPoints.every(isPt) || !isPt(r.origin)) return null;
	const origin = { x: r.origin.x, y: r.origin.y };
	const vps = (r.vanishingPoints as Vec2[]).map((v) => ({ x: v.x, y: v.y }));
	// A vanishing point on the origin has no direction.
	if (vps.some((v) => Math.hypot(v.x - origin.x, v.y - origin.y) < 1e-6)) return null;
	const out: VectorPerspective = { vanishingPoints: vps, origin };
	if (typeof r.gridSize === 'number' && r.gridSize > 0 && Number.isFinite(r.gridSize)) out.gridSize = Math.min(1000, r.gridSize);
	if (typeof r.extent === 'number' && Number.isFinite(r.extent)) out.extent = Math.min(100, Math.max(1, Math.round(r.extent)));
	if (r.visible === false) out.visible = false;
	return out;
}

type Col = [number, number, number];

/** The homogeneous direction column toward `vp`, one document unit long on screen at the origin, signed by `want`. */
function towards(o: Vec2, vp: Vec2, want: 'right' | 'up'): Col {
	const d = Math.hypot(vp.x - o.x, vp.y - o.y);
	let a = 1 / d;
	// Its screen direction at the origin is a·(vp − o): make it point right (or up).
	if (want === 'right' ? vp.x - o.x < 0 : vp.y - o.y > 0) a = -a;
	return [a * vp.x, a * vp.y, a];
}

/**
 * The projective map from plane coordinates (document units at the origin; x to the right and y
 * up as seen near the origin) to the document, for `plane` of the grid; null for a plane the grid
 * does not have. Columns: the plane's x direction, its y direction, the origin.
 */
export function vectorPerspectivePlaneMap(p: VectorPerspective, plane: VectorPerspectivePlane): Homography | null {
	if (!vectorPerspectivePlanes(p).includes(plane)) return null;
	const o = p.origin;
	const [v1, v2, v3] = p.vanishingPoints;
	const right: Col = [1, 0, 0];
	const up: Col = v3 ? towards(o, v3, 'up') : [0, -1, 0];
	let x: Col;
	let y: Col;
	if (p.vanishingPoints.length <= 1) {
		if (plane === 'floor') [x, y] = [right, towards(o, v1, 'up')];
		else if (plane === 'side') [x, y] = [towards(o, v1, 'right'), up];
		else [x, y] = [right, up];
	} else if (plane === 'floor') [x, y] = [towards(o, v2, 'right'), towards(o, v1, 'up')];
	else if (plane === 'left') [x, y] = [towards(o, v1, 'right'), up];
	else [x, y] = [towards(o, v2, 'right'), up];
	return [x[0], y[0], o.x, x[1], y[1], o.y, x[2], y[2], 1];
}

/**
 * Maps flat art onto a plane: a document point `q` is read as plane coordinates relative to the
 * origin (`q.x − origin.x` right, `origin.y − q.y` up) and placed on the plane. Art near the origin
 * keeps its size; further away it recedes. Null where the point would fall behind the viewer.
 */
export function vectorPerspectiveFlatToPlane(p: VectorPerspective, plane: VectorPerspectivePlane): ((q: Vec2) => Vec2 | null) | null {
	const h = vectorPerspectivePlaneMap(p, plane);
	if (!h) return null;
	const o = p.origin;
	return (q) => {
		const u = q.x - o.x;
		const v = o.y - q.y;
		const w = h[6] * u + h[7] * v + h[8];
		if (!(w > 1e-6)) return null;
		return applyH(h, { x: u, y: v });
	};
}

/** The inverse of `vectorPerspectiveFlatToPlane`: where on the flat art a document point on the plane comes from. */
export function vectorPerspectivePlaneToFlat(p: VectorPerspective, plane: VectorPerspectivePlane): ((q: Vec2) => Vec2 | null) | null {
	const h = vectorPerspectivePlaneMap(p, plane);
	const inv = h ? invertHomography(h) : null;
	if (!inv) return null;
	const o = p.origin;
	return (q) => {
		const f = applyH(inv, q);
		if (!f) return null;
		// Only points in front of the viewer (the side of the plane the grid draws).
		const w = h![6] * f.x + h![7] * f.y + h![8];
		if (!(w > 1e-6)) return null;
		return { x: o.x + f.x, y: o.y - f.y };
	};
}

/**
 * A flat path laid onto a plane (curves re-fitted where the projection bends them), or null when
 * part of it would fall behind the viewer (beyond the plane's horizon).
 */
export function vectorPerspectiveMapPath(p: VectorPerspective, plane: VectorPerspectivePlane, path: BezierPath): BezierPath | null {
	const f = vectorPerspectiveFlatToPlane(p, plane);
	if (!f) return null;
	let behind = false;
	const out = mapBezierPath(
		path,
		(q) => {
			const r = f(q);
			if (!r) {
				behind = true;
				return q;
			}
			return r;
		},
		0.1
	);
	return behind ? null : out;
}

/**
 * The grid lines of a plane, in document space: lines of constant x and of constant y every
 * `gridSize` out to `extent` cells on each side of the origin (only the parts in front of the
 * viewer; lines running behind it are cut where they near the horizon).
 */
export function vectorPerspectiveGridLines(p: VectorPerspective, plane: VectorPerspectivePlane): { a: Vec2; b: Vec2 }[] {
	const h = vectorPerspectivePlaneMap(p, plane);
	if (!h) return [];
	const g = p.gridSize ?? 20;
	const n = p.extent ?? 12;
	const max = n * g;
	// The floor and the front run both ways from the origin; walls rise from the ground.
	const lo = (axis: 'x' | 'y') => (axis === 'y' && plane !== 'floor' ? 0 : -max);
	const w = (u: number, v: number) => h[6] * u + h[7] * v + h[8];
	const at = (u: number, v: number) => applyH(h, { x: u, y: v });
	// Clip a line's parameter range to where it stays clearly in front (w ≥ 0.05).
	const segment = (u0: number, v0: number, u1: number, v1: number) => {
		const wa = w(u0, v0);
		const wb = w(u1, v1);
		const min = 0.05;
		if (wa < min && wb < min) return null;
		let t0 = 0;
		let t1 = 1;
		if (wa < min) t0 = (min - wa) / (wb - wa);
		if (wb < min) t1 = (min - wa) / (wb - wa);
		const a = at(u0 + (u1 - u0) * t0, v0 + (v1 - v0) * t0);
		const b = at(u0 + (u1 - u0) * t1, v0 + (v1 - v0) * t1);
		return a && b ? { a, b } : null;
	};
	const out: { a: Vec2; b: Vec2 }[] = [];
	for (let k = lo('x') / g; k <= n; k++) {
		const s = segment(k * g, lo('y'), k * g, max);
		if (s) out.push(s);
	}
	for (let k = lo('y') / g; k <= n; k++) {
		const s = segment(lo('x'), k * g, max, k * g);
		if (s) out.push(s);
	}
	return out;
}

/**
 * A starting grid for a page `width × height`: the horizon a third of the way down, the origin
 * near the bottom middle; 1 point in the middle of the horizon, 2 beyond the page's sides, and a
 * third far below the page (a bird's eye view).
 */
export function vectorPerspectivePreset(points: 1 | 2 | 3, width: number, height: number): VectorPerspective {
	const horizon = height * 0.35;
	const origin = { x: width / 2, y: height * 0.8 };
	const vps = points === 1 ? [{ x: width / 2, y: horizon }] : [{ x: -width * 0.3, y: horizon }, { x: width * 1.3, y: horizon }];
	if (points === 3) vps.push({ x: width / 2, y: height * 3 });
	return { vanishingPoints: vps, origin, gridSize: Math.max(4, Math.round(Math.min(width, height) / 20)), extent: 12 };
}
