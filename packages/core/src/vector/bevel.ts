/**
 * Bevel: a flat shape drawn with a chiselled edge, after CorelDRAW's Bevel effect (concept
 * only). A band `width` wide inside the outline is split into one face per edge (curves
 * flattened), running from the edge in to an inset copy of it; each face is shaded by how
 * squarely its slope faces a light. The middle (the shape inset by `width`, exact) stays flat in
 * the shape's own paint.
 */
import type { Point } from '../canvas/types.js';
import type { BezierPath } from '../canvas/pathops/bezier.js';
import { pointInRings } from '../canvas/polygonBoolean.js';
import { vectorPathRings } from './extrude.js';
import type { VectorEffectParamsMap } from './types.js';

/** One sloped face of a bevel: a quad with its shade (−1 darkest … 1 lightest). */
export interface VectorBevelFace {
	path: BezierPath;
	shade: number;
}

const MITER_LIMIT = 4;

/** Where along `a → b` (0…1) it first crosses segment `c – d`, or null. */
function crossing(a: Point, b: Point, c: Point, d: Point): number | null {
	const rx = b[0] - a[0];
	const ry = b[1] - a[1];
	const sx = d[0] - c[0];
	const sy = d[1] - c[1];
	const den = rx * sy - ry * sx;
	if (Math.abs(den) < 1e-12) return null;
	const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
	const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
	return t > 1e-9 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/**
 * The sloped faces of `path` bevelled with `params` (`width`, `lightAngle`, `shading`); the flat
 * middle is not included. Corners are mitred (at most 4 × `width` deep). Where the shape is
 * thinner than the bevel, the inset corner stops half-way to the outline it would cross, so
 * faces stay inside the shape.
 */
export function vectorBevelFaces(path: BezierPath, params: Pick<VectorEffectParamsMap['bevel'], 'width' | 'lightAngle' | 'shading'>, fillRule: 'nonzero' | 'evenodd' = 'nonzero'): VectorBevelFace[] {
	const width = Math.max(0, params.width);
	if (!path.length || width <= 0) return [];
	const rings = vectorPathRings(path, 0.25).filter((r) => r.length >= 3);
	const lr = (params.lightAngle * Math.PI) / 180;
	const light: Point = [Math.cos(lr), Math.sin(lr)];
	const strength = Math.min(1, Math.max(0, params.shading / 100));
	const faces: VectorBevelFace[] = [];
	for (const ring of rings) {
		const n = ring.length;
		// Which side of this ring is inside: test just off the middle of its longest edge.
		let best = 0;
		let bestLen = -1;
		for (let i = 0; i < n; i++) {
			const q = ring[(i + 1) % n];
			const l = Math.hypot(q[0] - ring[i][0], q[1] - ring[i][1]);
			if (l > bestLen) [best, bestLen] = [i, l];
		}
		if (bestLen < 1e-9) continue;
		const bp = ring[best];
		const bq = ring[(best + 1) % n];
		const left: Point = [-(bq[1] - bp[1]) / bestLen, (bq[0] - bp[0]) / bestLen];
		const probe = Math.min(bestLen / 4, 1e-3 * Math.max(1, bestLen));
		const sign = pointInRings([(bp[0] + bq[0]) / 2 + left[0] * probe, (bp[1] + bq[1]) / 2 + left[1] * probe], rings, fillRule) ? 1 : -1;
		// Inward unit normal of edge i (from ring[i] to ring[i + 1]).
		const normals: (Point | null)[] = ring.map((p, i) => {
			const q = ring[(i + 1) % n];
			const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
			return l < 1e-9 ? null : [(-(q[1] - p[1]) / l) * sign, ((q[0] - p[0]) / l) * sign];
		});
		const normalAt = (i: number, step: number): Point => {
			for (let k = 0; k < n; k++) {
				const v = normals[(((i + step * k) % n) + n) % n];
				if (v) return v;
			}
			return [0, 0];
		};
		const inset: Point[] = ring.map((p, i) => {
			const a = normalAt(i - 1, -1);
			const b = normalAt(i, 1);
			let bx = a[0] + b[0];
			let by = a[1] + b[1];
			const bl = Math.hypot(bx, by);
			if (bl < 1e-9) [bx, by] = [b[0], b[1]];
			else [bx, by] = [bx / bl, by / bl];
			const cos = bx * b[0] + by * b[1];
			let len = width / Math.max(cos, 1 / MITER_LIMIT);
			// Stop half-way to any outline the corner's inset would cross.
			const end: Point = [p[0] + bx * len, p[1] + by * len];
			let t = 1;
			for (const other of rings) {
				const m = other.length;
				for (let j = 0; j < m; j++) {
					const c = other[j];
					const d = other[(j + 1) % m];
					if (c === p || d === p) continue;
					const hit = crossing(p, end, c, d);
					if (hit !== null && hit < t) t = hit;
				}
			}
			if (t < 1) len *= t / 2;
			return [p[0] + bx * len, p[1] + by * len];
		});
		for (let i = 0; i < n; i++) {
			const nrm = normals[i];
			if (!nrm) continue;
			const j = (i + 1) % n;
			// The face slopes up from the edge toward the middle: it faces outward.
			const shade = (-nrm[0] * light[0] - nrm[1] * light[1]) * strength;
			faces.push({
				shade,
				path: [
					{ type: 'M', x: ring[i][0], y: ring[i][1] },
					{ type: 'L', x: ring[j][0], y: ring[j][1] },
					{ type: 'L', x: inset[j][0], y: inset[j][1] },
					{ type: 'L', x: inset[i][0], y: inset[i][1] },
					{ type: 'Z' }
				]
			});
		}
	}
	return faces;
}
