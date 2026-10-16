/**
 * Diagonal hatching: the Shape Builder's mesh highlight over a face.
 *
 * Ported from vectorcraft-main/crates/tools/src/builder.rs (`hatch`). MIT OR Apache-2.0,
 * © ArtCraft Team and contributors. See THIRD_PARTY_NOTICES.md.
 */
import type { Point } from '../types.js';
import { bezierPathBounds, closeContour, flattenChain, pathToContours, type BezierPath, type BezierPathInput } from './bezier.js';

export interface HatchOptions {
	/** Distance between the lines, in the path's units (default 4). */
	gap?: number;
	/** Most lines drawn: past it the gap widens (default 400). */
	maxLines?: number;
}

/**
 * 45° hatch lines filling `path` (non-zero and even-odd agree for simple faces; crossings are
 * paired in order, as even-odd does), `gap` apart. Each line is its own `M`/`L` pair, clipped to
 * the path. Empty for a path with no area.
 */
export function hatchPath(path: BezierPathInput, options: HatchOptions = {}): BezierPath {
	const out: BezierPath = [];
	const b = bezierPathBounds(path);
	if (!b || b.maxX - b.minX <= 0 || b.maxY - b.minY <= 0) return out;
	const want = Math.max(options.gap ?? 4, 1e-3);
	// Rotated by -45° the hatch lines are horizontal scanlines.
	const s = Math.SQRT1_2;
	const rot = (p: Point): Point => [(p[0] + p[1]) * s, (p[1] - p[0]) * s];
	const unrot = (x: number, y: number) => ({ x: (x - y) * s, y: (x + y) * s });
	const edges: [Point, Point][] = [];
	for (const contour of pathToContours(path)) {
		const pts = flattenChain(closeContour(contour, true), want * 0.1).map(rot);
		for (let i = 0; i < pts.length; i++) {
			const p = pts[i];
			const q = pts[(i + 1) % pts.length];
			if (p[0] !== q[0] || p[1] !== q[1]) edges.push([p, q]);
		}
	}
	let y0 = Infinity;
	let y1 = -Infinity;
	for (const [p, q] of edges) {
		y0 = Math.min(y0, p[1], q[1]);
		y1 = Math.max(y1, p[1], q[1]);
	}
	if (!(y1 > y0)) return out;
	const gap = Math.max(want, (y1 - y0) / Math.max(1, options.maxLines ?? 400), 1e-6);
	const xs: number[] = [];
	for (let y = Math.floor(y0 / gap) * gap + gap / 2; y < y1; y += gap) {
		xs.length = 0;
		for (const [p, q] of edges) if (p[1] <= y !== q[1] <= y) xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
		xs.sort((m, n) => m - n);
		for (let i = 0; i + 1 < xs.length; i += 2) {
			out.push({ type: 'M', ...unrot(xs[i], y) }, { type: 'L', ...unrot(xs[i + 1], y) });
		}
	}
	return out;
}
