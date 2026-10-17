/**
 * Perspective (projective) maps between quadrilaterals: what Free Distort needs. Pure maths;
 * degenerate or non-finite quads give `null` instead of NaNs.
 *
 * Ported from ArtCraft (MIT OR Apache-2.0, © ArtCraft Team and contributors; see
 * THIRD_PARTY_NOTICES.md): pdfcraft `crates/geom/src/perspective.rs` (`Homography::from_points`,
 * `Homography::apply`, `solve8`, `order_quad`).
 */
import type { Vec2 } from './types.js';

/** A 3×3 projective map, row-major, normalised so that the last entry is 1. */
export type VectorHomography = readonly [number, number, number, number, number, number, number, number, number];

/**
 * Gaussian elimination with partial pivoting on an 8×8 system (the 9th column of each row is the
 * right-hand side). Null when the system is singular.
 */
export function solve8(rows: readonly (readonly number[])[]): number[] | null {
	const m = rows.map((r) => r.slice());
	for (let col = 0; col < 8; col++) {
		let pivot = col;
		for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
		if (!(Math.abs(m[pivot][col]) >= 1e-12)) return null;
		[m[col], m[pivot]] = [m[pivot], m[col]];
		const p = m[col];
		for (let r = 0; r < 8; r++) {
			if (r === col) continue;
			const f = m[r][col] / p[col];
			if (f !== 0) for (let k = 0; k < 9; k++) m[r][k] -= f * p[k];
		}
	}
	const out: number[] = [];
	for (let i = 0; i < 8; i++) {
		const v = m[i][8] / m[i][i];
		if (!Number.isFinite(v)) return null;
		out.push(v);
	}
	return out;
}

/** The image of `p`, or null where the map sends it to infinity. */
export function applyVectorHomography(h: VectorHomography, p: Vec2): Vec2 | null {
	const w = h[6] * p.x + h[7] * p.y + h[8];
	if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
	const x = (h[0] * p.x + h[1] * p.y + h[2]) / w;
	const y = (h[3] * p.x + h[4] * p.y + h[5]) / w;
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

const finite = (p: Vec2) => Number.isFinite(p.x) && Number.isFinite(p.y);

/**
 * The projective map that takes each of `from` to the point at the same index of `to`. Null when
 * three of either set are collinear or a coordinate is not finite.
 */
export function vectorHomography(from: readonly Vec2[], to: readonly Vec2[]): VectorHomography | null {
	if (from.length !== 4 || to.length !== 4 || ![...from, ...to].every(finite)) return null;
	// x' = (h0 x + h1 y + h2) / (h6 x + h7 y + 1), y' likewise with h3..h5: eight unknowns, two
	// equations per point pair.
	const rows: number[][] = [];
	for (let i = 0; i < 4; i++) {
		const { x, y } = from[i];
		const { x: u, y: v } = to[i];
		rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
		rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
	}
	const h = solve8(rows);
	if (!h) return null;
	const out: VectorHomography = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
	// Collinear points can leave a solvable but singular system: check the map really takes the
	// four points where they should go.
	for (let i = 0; i < 4; i++) {
		const r = applyVectorHomography(out, from[i]);
		const q = to[i];
		const scale = 1 + Math.max(Math.abs(q.x), Math.abs(q.y));
		if (!r || Math.abs(r.x - q.x) > 1e-6 * scale || Math.abs(r.y - q.y) > 1e-6 * scale) return null;
	}
	return out;
}

/**
 * Whether `h` maps the whole convex quad `quad` without sending any of it through infinity (the
 * denominator keeps one sign over it): what a usable distortion needs.
 */
export function vectorHomographyKeepsQuad(h: VectorHomography, quad: readonly Vec2[]): boolean {
	const ws = quad.map((p) => h[6] * p.x + h[7] * p.y + h[8]);
	return ws.every((w) => w > 1e-9) || ws.every((w) => w < -1e-9);
}

/**
 * The four corners in reading order for a y-down space: top-left, top-right, bottom-right,
 * bottom-left, whatever order they come in. Null unless they form a convex quadrilateral with a
 * non-negligible area.
 */
export function orderVectorQuad(points: readonly Vec2[]): Vec2[] | null {
	if (points.length !== 4 || !points.every(finite)) return null;
	const cx = points.reduce((s, p) => s + p.x, 0) / 4;
	const cy = points.reduce((s, p) => s + p.y, 0) / 4;
	// Ascending angle about the centre is clockwise on screen (y down).
	const q = points.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
	let first = 0;
	for (let i = 1; i < 4; i++) if (q[i].x + q[i].y < q[first].x + q[first].y) first = i;
	const ordered = [...q.slice(first), ...q.slice(0, first)];
	const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const turns = ordered.map((_, i) => cross(ordered[i], ordered[(i + 1) % 4], ordered[(i + 2) % 4]));
	const area = turns.reduce((s, t) => s + t, 0) / 2;
	const xs = ordered.map((p) => p.x);
	const ys = ordered.map((p) => p.y);
	const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
	const convex = turns.every((t) => t > 1e-9 * size * size);
	return convex && area > 1e-6 * size * size ? ordered : null;
}
