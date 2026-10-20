/**
 * Image tracing: raster pixels to vector paths.
 *
 * After effectcraft's `crates/path/src/trace.rs` (MIT OR Apache-2.0, © ArtCraft Team and
 * contributors; see THIRD_PARTY_NOTICES.md): marching squares over the samples at pixel centres
 * (the crossing interpolated along each cell edge, saddles resolved by the cell's mean, the field
 * padded with "outside" so every contour closes), Ramer–Douglas–Peucker simplification to the
 * tolerance, loops smaller than the minimum area dropped and each loop's nesting depth counted
 * (holes have odd depth). The loops are then fitted with our `fitCubics` (corner roundness sets
 * which turns stay sharp). Colour tracing quantises the image (median cut) and traces each colour
 * stacked: a colour's shape covers the colours traced above it too, so no gaps open between them.
 */

import type { Point } from '../canvas/types.js';
import { fitCubics } from '../canvas/curveFit.js';
import { simplifyRing } from '../canvas/shapeGeometry.js';
import type { VectorAnchor, VectorPathNode, VectorSubpath } from './types.js';

/** RGBA pixels, row by row (8 bits a channel). */
export interface VectorTracePixels {
	width: number;
	height: number;
	data: ArrayLike<number>;
}

/** How to trace. */
export interface VectorTraceOptions {
	/** `threshold`: one colour where the image is dark (or opaque); `color`: a stacked path per colour (default threshold). */
	mode?: 'threshold' | 'color';
	/** Threshold mode: trace by `luminance` (dark is inside, default) or `alpha` (opaque is inside). */
	channel?: 'luminance' | 'alpha';
	/** Threshold mode: inside where darkness (or alpha) is at least this, 0–1 (default 0.5). */
	threshold?: number;
	/** Threshold mode: the traced shape's fill (default black). */
	color?: string;
	/** Colour mode: how many colours (2–32, default 6). Fully transparent pixels are left out. */
	colors?: number;
	/** How far (pixels) the outline may stray from the pixels (default 1). */
	tolerance?: number;
	/** Shapes smaller than this many square pixels are dropped (default 10). */
	minArea?: number;
	/** 0: straight sides and sharp corners; 1: as smooth as the outline allows (default 0.5). */
	cornerRoundness?: number;
}

/** The most pixels traced (larger images are refused; scale them down first). */
export const VECTOR_TRACE_MAX_PIXELS = 4_000_000;

/** A traced loop: its points (pixel units), nesting depth and signed area. */
interface Loop {
	raw: Point[];
	simple: Point[];
	area: number;
	depth: number;
}

function signedArea(p: readonly Point[]): number {
	let a = 0;
	for (let i = 0; i < p.length; i++) {
		const [x0, y0] = p[i];
		const [x1, y1] = p[(i + 1) % p.length];
		a += x0 * y1 - x1 * y0;
	}
	return a / 2;
}

function pointInPoly(p: Point, poly: readonly Point[]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/**
 * Marching squares over `field` (`w × h`, row by row, sample (x, y) at pixel centre (x + 0.5,
 * y + 0.5)): the closed contours where the field reaches `threshold`, in pixel coordinates.
 */
export function vectorTraceContours(field: ArrayLike<number>, w: number, h: number, threshold: number): Point[][] {
	const gw = w + 2;
	const gh = h + 2;
	const val = (i: number, j: number) => (i === 0 || j === 0 || i > w || j > h ? -Infinity : field[(j - 1) * w + (i - 1)]);
	const inside = (i: number, j: number) => val(i, j) >= threshold;
	const pos = (i: number, j: number): Point => [i - 0.5, j - 0.5];
	const cross = (a: [number, number], b: [number, number]): Point => {
		const va = val(a[0], a[1]);
		const vb = val(b[0], b[1]);
		let t: number;
		if (Number.isFinite(va) && Number.isFinite(vb) && Math.abs(vb - va) > 1e-12) t = Math.min(1, Math.max(0, (threshold - va) / (vb - va)));
		// One side is padding: the crossing sits half a pixel out.
		else if (Number.isFinite(va)) t = va >= threshold ? 0.5 : 0;
		else t = vb >= threshold ? 0.5 : 1;
		const pa = pos(a[0], a[1]);
		const pb = pos(b[0], b[1]);
		return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
	};
	const hid = (i: number, j: number) => 2 * (j * gw + i);
	const vid = (i: number, j: number) => 2 * (j * gw + i) + 1;
	const next = new Map<number, number>();
	const point = new Map<number, Point>();
	for (let j = 0; j < gh - 1; j++) {
		for (let i = 0; i < gw - 1; i++) {
			const tl = inside(i, j);
			const tr = inside(i + 1, j);
			const br = inside(i + 1, j + 1);
			const bl = inside(i, j + 1);
			const code = (+tl << 3) | (+tr << 2) | (+br << 1) | +bl;
			if (code === 0 || code === 15) continue;
			const top = hid(i, j);
			const bottom = hid(i, j + 1);
			const left = vid(i, j);
			const right = vid(i + 1, j);
			const seg = (a: number, b: number) => next.set(a, b);
			const mean = () => (val(i, j) + val(i + 1, j) + val(i + 1, j + 1) + val(i, j + 1)) / 4;
			switch (code) {
				case 1:
					seg(left, bottom);
					break;
				case 2:
					seg(bottom, right);
					break;
				case 3:
					seg(left, right);
					break;
				case 4:
					seg(right, top);
					break;
				case 5:
					if (mean() >= threshold) {
						seg(left, top);
						seg(right, bottom);
					} else {
						seg(left, bottom);
						seg(right, top);
					}
					break;
				case 6:
					seg(bottom, top);
					break;
				case 7:
					seg(left, top);
					break;
				case 8:
					seg(top, left);
					break;
				case 9:
					seg(top, bottom);
					break;
				case 10:
					if (mean() >= threshold) {
						seg(top, right);
						seg(bottom, left);
					} else {
						seg(top, left);
						seg(bottom, right);
					}
					break;
				case 11:
					seg(top, right);
					break;
				case 12:
					seg(right, left);
					break;
				case 13:
					seg(right, bottom);
					break;
				case 14:
					seg(bottom, left);
					break;
			}
			const edges: [number, [number, number], [number, number]][] = [
				[top, [i, j], [i + 1, j]],
				[bottom, [i, j + 1], [i + 1, j + 1]],
				[left, [i, j], [i, j + 1]],
				[right, [i + 1, j], [i + 1, j + 1]]
			];
			for (const [e, a, b] of edges) if (inside(a[0], a[1]) !== inside(b[0], b[1]) && !point.has(e)) point.set(e, cross(a, b));
		}
	}
	const out: Point[][] = [];
	for (const start of [...next.keys()].sort((a, b) => a - b)) {
		if (!next.has(start)) continue;
		const poly: Point[] = [];
		let e = start;
		for (;;) {
			const n = next.get(e);
			if (n === undefined) break;
			next.delete(e);
			const p = point.get(e);
			if (p) poly.push(p);
			e = n;
			if (e === start) break;
		}
		if (poly.length >= 3) out.push(poly);
	}
	return out;
}

/** The loops of a field, simplified, filtered by area and given their nesting depth (outermost first). */
function loopsOf(field: ArrayLike<number>, w: number, h: number, threshold: number, tolerance: number, minArea: number): Loop[] {
	const loops: Loop[] = [];
	for (const raw of vectorTraceContours(field, w, h, threshold)) {
		const area = signedArea(raw);
		if (Math.abs(area) < Math.max(0, minArea)) continue;
		const simple = simplifyRing(raw, Math.max(0.01, tolerance));
		if (simple.length < 3) continue;
		loops.push({ raw, simple, area, depth: 0 });
	}
	for (const l of loops) l.depth = loops.filter((o) => o !== l && Math.abs(o.area) > Math.abs(l.area) && pointInPoly(l.simple[0], o.simple)).length;
	return loops.sort((a, b) => a.depth - b.depth || Math.abs(b.area) - Math.abs(a.area));
}

/** A loop as a closed subpath: a polygon at roundness 0, else cubics fitted within the tolerance. */
function loopSubpath(l: Loop, tolerance: number, roundness: number): VectorSubpath {
	if (roundness <= 0) return { closed: true, anchors: l.simple.map(([x, y]) => ({ x, y })) };
	// The rounder, the larger a turn must be to stay a corner.
	const cornerAngleDeg = 25 + roundness * 125;
	const cubics = fitCubics(l.raw, Math.max(0.05, tolerance), {
		closed: true,
		cornerAngleDeg
	});
	if (!cubics.length) return { closed: true, anchors: l.simple.map(([x, y]) => ({ x, y })) };
	const anchors: VectorAnchor[] = cubics.map((c, k) => {
		const prev = cubics[(k - 1 + cubics.length) % cubics.length];
		return {
			x: c.p0[0],
			y: c.p0[1],
			in: { x: prev.p2[0], y: prev.p2[1] },
			out: { x: c.p1[0], y: c.p1[1] }
		};
	});
	return { closed: true, anchors };
}

/** The subpaths of a field's outline (holes included; fill even-odd). */
function traceField(field: ArrayLike<number>, w: number, h: number, threshold: number, o: VectorTraceOptions): VectorSubpath[] {
	const tolerance = o.tolerance ?? 1;
	const roundness = Math.min(1, Math.max(0, o.cornerRoundness ?? 0.5));
	return loopsOf(field, w, h, threshold, tolerance, o.minArea ?? 10).map((l) => loopSubpath(l, tolerance, roundness));
}

/**
 * The palette of the opaque pixels quantised to `count` colours (median cut on RGB) and each
 * pixel's palette index (−1 for transparent pixels), with how many pixels each colour got.
 */
export function quantizeVectorTraceColors(
	pixels: VectorTracePixels,
	count: number
): {
	palette: [number, number, number][];
	index: Int16Array;
	counts: number[];
} {
	const n = pixels.width * pixels.height;
	const d = pixels.data;
	const opaque: number[] = [];
	for (let i = 0; i < n; i++) if (d[i * 4 + 3] >= 128) opaque.push(i);
	const boxes: number[][] = opaque.length ? [opaque] : [];
	const range = (box: number[], c: number) => {
		let lo = 255;
		let hi = 0;
		for (const i of box) {
			const v = d[i * 4 + c];
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
		return hi - lo;
	};
	while (boxes.length < count) {
		// Split the box with the widest channel range at its median.
		let best = -1;
		let bestRange = 0;
		let bestC = 0;
		boxes.forEach((b, k) => {
			if (b.length < 2) return;
			for (let c = 0; c < 3; c++) {
				const r = range(b, c);
				if (r > bestRange) {
					bestRange = r;
					best = k;
					bestC = c;
				}
			}
		});
		if (best < 0) break;
		const box = boxes[best].slice().sort((a, b) => d[a * 4 + bestC] - d[b * 4 + bestC]);
		// At the median, moved to where the channel's value changes so equal colours stay together.
		const key = (k: number) => d[box[k] * 4 + bestC];
		const v = key(box.length >> 1);
		let mid = box.findIndex((_, k) => key(k) >= v);
		if (mid <= 0) mid = box.findIndex((_, k) => key(k) > v);
		boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
	}
	const palette = boxes.map((b): [number, number, number] => {
		const s = [0, 0, 0];
		for (const i of b) for (let c = 0; c < 3; c++) s[c] += d[i * 4 + c];
		return [Math.round(s[0] / b.length), Math.round(s[1] / b.length), Math.round(s[2] / b.length)];
	});
	const index = new Int16Array(n).fill(-1);
	const counts = palette.map(() => 0);
	for (const i of opaque) {
		let best = 0;
		let bestD = Infinity;
		palette.forEach((p, k) => {
			const dd = (d[i * 4] - p[0]) ** 2 + (d[i * 4 + 1] - p[1]) ** 2 + (d[i * 4 + 2] - p[2]) ** 2;
			if (dd < bestD) {
				bestD = dd;
				best = k;
			}
		});
		index[i] = best;
		counts[best]++;
	}
	return { palette, index, counts };
}

const hex = (c: readonly number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * Traces pixels into path nodes in pixel units (one pixel = one unit, the image's top-left at the
 * origin), bottom to top: one compound path in threshold mode, a stacked path per colour in
 * colour mode (most common colour at the bottom). Ids are `trace-<n>`; give them your own.
 */
export function traceVectorImage(pixels: VectorTracePixels, options: VectorTraceOptions = {}): VectorPathNode[] {
	const { width: w, height: h, data } = pixels;
	if (!(w > 0 && h > 0) || data.length < w * h * 4) throw new Error('The image has no pixels (or fewer than width × height × 4 values).');
	if (w * h > VECTOR_TRACE_MAX_PIXELS) throw new Error(`The image has ${w * h} pixels; scale it down to at most ${VECTOR_TRACE_MAX_PIXELS} to trace it.`);
	const n = w * h;
	if ((options.mode ?? 'threshold') === 'threshold') {
		const field = new Float32Array(n);
		const byAlpha = options.channel === 'alpha';
		for (let i = 0; i < n; i++) {
			const a = data[i * 4 + 3] / 255;
			// Darkness over white: transparent pixels count as white.
			field[i] = byAlpha ? a : a * (1 - (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255);
		}
		const subpaths = traceField(field, w, h, Math.min(1, Math.max(0, options.threshold ?? 0.5)), options);
		return subpaths.length
			? [
					{
						id: 'trace-1',
						type: 'path',
						name: 'Trace',
						fill: options.color ?? '#000000',
						stroke: null,
						fillRule: 'evenodd',
						subpaths
					}
				]
			: [];
	}
	const count = Math.min(32, Math.max(2, Math.round(options.colors ?? 6)));
	const q = quantizeVectorTraceColors(pixels, count);
	// Most common colour first (bottom); each layer covers its colour and every one above it.
	const order = q.palette
		.map((_, k) => k)
		.filter((k) => q.counts[k] > 0)
		.sort((a, b) => q.counts[b] - q.counts[a]);
	const rank = new Map(order.map((k, r) => [k, r]));
	const out: VectorPathNode[] = [];
	order.forEach((k, r) => {
		const field = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			const ix = q.index[i];
			field[i] = ix >= 0 && rank.get(ix)! >= r ? 1 : 0;
		}
		const subpaths = traceField(field, w, h, 0.5, options);
		if (subpaths.length)
			out.push({
				id: `trace-${out.length + 1}`,
				type: 'path',
				name: hex(q.palette[k]),
				fill: hex(q.palette[k]),
				stroke: null,
				fillRule: 'evenodd',
				subpaths
			});
	});
	return out;
}
