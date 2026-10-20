/**
 * Extrude: a flat shape drawn as a solid, after CorelDRAW's Extrude (concept only). Each edge of
 * the shape gets a side face running back to a copy of the edge, either moved `depth` along an
 * angle (parallel, an oblique projection) or pulled `toward` percent of the way to a vanishing
 * point (perspective). Faces are shaded by how squarely they face a light and are drawn back to front,
 * with the shape itself on top. Curves are flattened, so a curved side shades smoothly.
 */
import type { Point } from '../canvas/types.js';
import { bezierPathBounds, closeContour, flattenChain, pathToContours, type BezierPath } from '../canvas/pathops/bezier.js';
import { parseVectorColor } from './gradient.js';
import type { VectorEffectParamsMap, VectorPaint } from './types.js';

/**
 * One solid colour standing for a paint: a colour as it is, a gradient's stop nearest its
 * middle, a mesh or freeform gradient's first colour; null for no paint.
 */
export function vectorPaintSolid(paint: VectorPaint | undefined): string | null {
	if (paint == null || paint === 'none') return null;
	if (typeof paint === 'string') return paint;
	const stops = (paint as { stops?: { offset: number; color: string }[] }).stops;
	if (stops?.length) return stops.reduce((a, b) => (Math.abs(b.offset - 0.5) < Math.abs(a.offset - 0.5) ? b : a)).color;
	const colors = (paint as { colors?: string[] }).colors;
	if (colors?.length) return colors[0];
	const points = (paint as { points?: { color?: string }[] }).points;
	return points?.find((p) => typeof p.color === 'string')?.color ?? null;
}

/** `color` lightened toward white (`amount` > 0) or darkened toward black (< 0), −1…1. */
export function shadeVectorColor(color: string, amount: number): string {
	const c = parseVectorColor(color);
	if (!c) return color;
	const a = Math.min(1, Math.max(-1, amount));
	const target = a >= 0 ? 1 : 0;
	const h = (v: number) =>
		Math.round(Math.min(1, Math.max(0, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	const m = [0, 1, 2].map((k) => c[k] + (target - c[k]) * Math.abs(a));
	return `#${h(m[0])}${h(m[1])}${h(m[2])}`;
}

/** The closed rings of a path, curves flattened within `tolerance`. */
export function vectorPathRings(path: BezierPath, tolerance = 0.5): Point[][] {
	const rings: Point[][] = [];
	for (const contour of pathToContours(path)) {
		const ring = flattenChain(closeContour(contour, true), Math.max(1e-3, tolerance));
		if (ring.length >= 2) rings.push(ring);
	}
	return rings;
}

/** One side face of an extrusion: a quad with its shade (−1 darkest … 1 lightest). */
export interface VectorExtrudeFace {
	path: BezierPath;
	shade: number;
}

/**
 * The side faces of `path` extruded with `params`, in drawing order (back to front). The shape's
 * own face is not included: draw it on top. `light` is the light's direction in degrees (0 from
 * the right, 90 from below); a face's shade is the cosine between its outward normal and the
 * light, times `shading` percent.
 */
export function vectorExtrudeFaces(path: BezierPath, params: VectorEffectParamsMap['extrude']): VectorExtrudeFace[] {
	const box = bezierPathBounds(path);
	if (!box || !path.length) return [];
	const perspective = params.mode === 'perspective';
	const rad = (params.angle * Math.PI) / 180;
	const d: Point = [Math.cos(rad) * Math.max(0, params.depth), Math.sin(rad) * Math.max(0, params.depth)];
	const vp: Point = [(box.minX + box.maxX) / 2 + params.vanishingPoint.x, (box.minY + box.maxY) / 2 + params.vanishingPoint.y];
	const pull = Math.min(1, Math.max(0, params.toward / 100));
	const back = (p: Point): Point => (perspective ? [p[0] + (vp[0] - p[0]) * pull, p[1] + (vp[1] - p[1]) * pull] : [p[0] + d[0], p[1] + d[1]]);
	if (perspective ? pull <= 0 : Math.hypot(d[0], d[1]) < 1e-9) return [];
	const lr = (params.lightAngle * Math.PI) / 180;
	// The light comes from `lightAngle`, so a face lit squarely has its normal pointing at it.
	const light: Point = [Math.cos(lr), Math.sin(lr)];
	const strength = Math.min(1, Math.max(0, params.shading / 100));
	// Each face lies between its edge and the edge's copy along the viewing rays (parallel lines
	// along the extrusion, or rays to the vanishing point), so two faces overlap only over rays
	// that cross both edges, and there the edge nearer the back is in front.
	const u: Point = perspective ? [0, 0] : [d[0] / Math.hypot(d[0], d[1]), d[1] / Math.hypot(d[0], d[1])];
	const centre: Point = [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
	const aim = Math.atan2(centre[1] - vp[1], centre[0] - vp[0]);
	// Where a point lies across the rays.
	const across = (p: Point) => {
		if (!perspective) return -p[0] * u[1] + p[1] * u[0];
		let a = Math.atan2(p[1] - vp[1], p[0] - vp[0]) - aim;
		while (a > Math.PI) a -= 2 * Math.PI;
		while (a <= -Math.PI) a += 2 * Math.PI;
		return a;
	};
	// How far toward the back a point of the segment at ray `l` lies (larger: nearer the viewer).
	const towardBack = (p: Point, q: Point, l: number) => {
		const lp = across(p);
		const lq = across(q);
		const t = Math.abs(lq - lp) < 1e-12 ? 0.5 : Math.min(1, Math.max(0, (l - lp) / (lq - lp)));
		const x: Point = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
		return perspective ? -Math.hypot(vp[0] - x[0], vp[1] - x[1]) : x[0] * u[0] + x[1] * u[1];
	};
	interface Face {
		face: VectorExtrudeFace;
		p: Point;
		q: Point;
		lo: number;
		hi: number;
		key: number;
	}
	const faces: Face[] = [];
	for (const ring of vectorPathRings(path, 0.25)) {
		for (let i = 0; i < ring.length; i++) {
			const p = ring[i];
			const q = ring[(i + 1) % ring.length];
			const ex = q[0] - p[0];
			const ey = q[1] - p[1];
			const len = Math.hypot(ex, ey);
			if (len < 1e-9) continue;
			const pb = back(p);
			const qb = back(q);
			const mid: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
			// Where the face goes: along the extrusion from the edge's middle.
			const away: Point = perspective ? [vp[0] - mid[0], vp[1] - mid[1]] : d;
			// The visible side of a side face faces along the extrusion.
			let n: Point = [ey / len, -ex / len];
			if (n[0] * away[0] + n[1] * away[1] < 0) n = [-n[0], -n[1]];
			const shade = (n[0] * light[0] + n[1] * light[1]) * strength;
			const lp = across(p);
			const lq = across(q);
			faces.push({
				p,
				q,
				lo: Math.min(lp, lq),
				hi: Math.max(lp, lq),
				key: towardBack(p, q, (lp + lq) / 2),
				face: {
					shade,
					path: [{ type: 'M', x: p[0], y: p[1] }, { type: 'L', x: q[0], y: q[1] }, { type: 'L', x: qb[0], y: qb[1] }, { type: 'L', x: pb[0], y: pb[1] }, { type: 'Z' }]
				}
			});
		}
	}
	// Back to front: a face goes after every face it covers. Edges of a simple outline do not
	// cross, so "covers" has no cycles; ties keep the order by the middles.
	faces.sort((a, b) => a.key - b.key);
	const n = faces.length;
	const after: number[][] = faces.map(() => []);
	const before = new Array<number>(n).fill(0);
	const eps = 1e-9;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const lo = Math.max(faces[i].lo, faces[j].lo);
			const hi = Math.min(faces[i].hi, faces[j].hi);
			if (hi - lo <= eps * Math.max(1, Math.abs(hi))) continue;
			const l = (lo + hi) / 2;
			const di = towardBack(faces[i].p, faces[i].q, l);
			const dj = towardBack(faces[j].p, faces[j].q, l);
			if (Math.abs(di - dj) < 1e-9) continue;
			const [back0, front] = di < dj ? [i, j] : [j, i];
			after[back0].push(front);
			before[front]++;
		}
	}
	const order: number[] = [];
	const done = new Array<boolean>(n).fill(false);
	let next = 0;
	while (order.length < n) {
		// The first face (by middle) with nothing left behind it; on a cycle, the first left.
		let pick = -1;
		for (let i = next; i < n; i++) {
			if (!done[i] && before[i] === 0) {
				pick = i;
				break;
			}
		}
		if (pick < 0) pick = done.indexOf(false);
		done[pick] = true;
		order.push(pick);
		for (const k of after[pick]) before[k]--;
		while (next < n && done[next]) next++;
	}
	return order.map((i) => faces[i].face);
}
