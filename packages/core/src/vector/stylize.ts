/**
 * Bitmap-to-vector stylise: a picture turned into stylised vector art rather than traced
 * outlines, after the artistic bitmap-to-vector styles of CorelDRAW and similar tools (concepts
 * only). Every style samples the picture on a grid of cells and draws one shape per cell:
 *
 * - `mosaic`: a square or round tile per cell in the cell's colour;
 * - `halftone`: a dot per cell of a turned grid, its area following the cell's darkness;
 * - `lowPoly`: two triangles per cell of a jittered grid, each in the colour under it;
 * - `hatch`: engraving lines along a turned grid, swelling where the picture is dark.
 *
 * Colours are reduced to a palette (median cut on the cells' colours, as Image Trace does) and the
 * shapes of one colour are one compound path, so a picture becomes a few dozen paths. Results are
 * in pixel units (one pixel = one unit, the image's top-left at the origin), bottom to top.
 */
import { ellipseSubpath, rectSubpath } from './geometry.js';
import { quantizeVectorTraceColors, VECTOR_TRACE_MAX_PIXELS, type VectorTracePixels } from './trace.js';
import type { VectorPathNode, VectorSubpath } from './types.js';

export type VectorStylizeStyle = 'mosaic' | 'halftone' | 'lowPoly' | 'hatch';
export const VECTOR_STYLIZE_STYLES: readonly VectorStylizeStyle[] = ['mosaic', 'halftone', 'lowPoly', 'hatch'];
export const VECTOR_STYLIZE_LABELS: Record<VectorStylizeStyle, string> = { mosaic: 'Mosaic', halftone: 'Halftone', lowPoly: 'Low Poly', hatch: 'Engraving' };

/** Options of the styles (each uses the ones that apply to it). */
export interface VectorStylizeOptions {
	/** Cell size in pixels: tile, dot spacing, triangle size or line spacing (default 12; hatch 6, halftone 8). */
	cell?: number;
	/** Palette size for coloured output, 2–32 (default 12). */
	colors?: number;
	/** Mosaic: `square` (default) or `circle` tiles. */
	shape?: 'square' | 'circle';
	/** Mosaic: gap between tiles as a fraction of the cell, 0–0.9 (default 0.1). */
	gap?: number;
	/** Halftone and hatch: the grid's turn in degrees (default 45). */
	angle?: number;
	/** Halftone and hatch: one ink colour (default black); null keeps the picture's colours (halftone only). */
	color?: string | null;
	/** Low poly: how far grid points wander, as a fraction of the cell, 0–0.5 (default 0.35). */
	jitter?: number;
	/** Low poly: seed of the wandering (default 1). */
	seed?: number;
}

/** The most shapes a style may draw (larger cells draw fewer). */
export const VECTOR_STYLIZE_MAX_SHAPES = 60_000;

type Rgba = [number, number, number, number];

/** The average colour around (cx, cy) in a box `size` wide, sampling at most 5 × 5 pixels. */
function sampleBox(px: VectorTracePixels, cx: number, cy: number, size: number): Rgba {
	const { width: w, height: h, data: d } = px;
	const n = Math.max(1, Math.min(5, Math.round(size)));
	const s: Rgba = [0, 0, 0, 0];
	let count = 0;
	for (let j = 0; j < n; j++) {
		for (let i = 0; i < n; i++) {
			const x = Math.floor(cx - size / 2 + ((i + 0.5) * size) / n);
			const y = Math.floor(cy - size / 2 + ((j + 0.5) * size) / n);
			if (x < 0 || y < 0 || x >= w || y >= h) continue;
			const k = (y * w + x) * 4;
			const a = d[k + 3];
			// Colour weighted by alpha, so transparent edges do not darken it.
			s[0] += d[k] * a;
			s[1] += d[k + 1] * a;
			s[2] += d[k + 2] * a;
			s[3] += a;
			count++;
		}
	}
	if (!count || s[3] <= 0) return [0, 0, 0, 0];
	return [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3] / count];
}

const darkness = (c: Rgba) => (1 - (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255) * (c[3] / 255);
const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** Colours of shapes reduced to a palette: each shape's palette index (−1: left out), and the palette. */
function paletteOf(colors: readonly Rgba[], count: number): { palette: string[]; index: Int16Array } {
	const data = new Uint8ClampedArray(colors.length * 4);
	colors.forEach((c, i) => {
		data[i * 4] = c[0];
		data[i * 4 + 1] = c[1];
		data[i * 4 + 2] = c[2];
		data[i * 4 + 3] = c[3];
	});
	const q = quantizeVectorTraceColors({ width: colors.length, height: 1, data }, Math.min(32, Math.max(2, Math.round(count))));
	return { palette: q.palette.map(hex), index: q.index };
}

/** One compound path per palette colour holding its shapes (most shapes at the bottom). */
function byColour(shapes: readonly VectorSubpath[][], palette: readonly string[], index: ArrayLike<number>, name: string, extra: Partial<VectorPathNode> = {}): VectorPathNode[] {
	const groups = palette.map(() => [] as VectorSubpath[]);
	shapes.forEach((s, i) => {
		if (index[i] >= 0) groups[index[i]].push(...s);
	});
	return groups
		.map((subpaths, k) => ({ subpaths, k }))
		.filter((g) => g.subpaths.length)
		.sort((a, b) => b.subpaths.length - a.subpaths.length)
		.map((g, n) => ({ id: `stylize-${n}`, type: 'path' as const, name: `${name} ${palette[g.k]}`, fill: palette[g.k], stroke: null, subpaths: g.subpaths, ...extra }));
}

function check(px: VectorTracePixels, cell: number) {
	const { width: w, height: h, data } = px;
	if (!(w > 0 && h > 0) || data.length < w * h * 4) throw new Error('The image has no pixels (or fewer than width × height × 4 values).');
	if (w * h > VECTOR_TRACE_MAX_PIXELS) throw new Error(`The image has ${w * h} pixels; scale it down to at most ${VECTOR_TRACE_MAX_PIXELS}.`);
	if (!(cell >= 1)) throw new Error('cell must be at least 1 pixel.');
}

function tooMany(count: number) {
	if (count > VECTOR_STYLIZE_MAX_SHAPES) throw new Error(`That would draw about ${count} shapes (at most ${VECTOR_STYLIZE_MAX_SHAPES}): use a larger cell.`);
}

/** The points of a grid turned by `angle` degrees that cover the image, `cell` apart. */
function turnedGrid(w: number, h: number, cell: number, angle: number): { x: number; y: number; row: number; col: number }[] {
	const a = (angle * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	const cx = w / 2;
	const cy = h / 2;
	const reach = Math.ceil(Math.hypot(w, h) / 2 / cell) + 1;
	tooMany((2 * reach + 1) ** 2 * 0.7);
	const out: { x: number; y: number; row: number; col: number }[] = [];
	for (let j = -reach; j <= reach; j++) {
		for (let i = -reach; i <= reach; i++) {
			const x = cx + (i * c - j * s) * cell;
			const y = cy + (i * s + j * c) * cell;
			if (x < -cell || y < -cell || x > w + cell || y > h + cell) continue;
			out.push({ x, y, row: j, col: i });
		}
	}
	return out;
}

/** Mosaic tiles: one square or circle per cell, coloured by the palette. */
export function vectorMosaic(px: VectorTracePixels, o: VectorStylizeOptions = {}): VectorPathNode[] {
	const cell = o.cell ?? 12;
	check(px, cell);
	const cols = Math.ceil(px.width / cell);
	const rows = Math.ceil(px.height / cell);
	tooMany(cols * rows);
	const gap = Math.min(0.9, Math.max(0, o.gap ?? 0.1)) * cell;
	const colors: Rgba[] = [];
	const shapes: VectorSubpath[][] = [];
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const color = sampleBox(px, (c + 0.5) * cell, (r + 0.5) * cell, cell);
			if (color[3] < 128) continue;
			const box = { x: c * cell + gap / 2, y: r * cell + gap / 2, width: cell - gap, height: cell - gap };
			colors.push(color);
			shapes.push([o.shape === 'circle' ? ellipseSubpath(box) : rectSubpath(box)]);
		}
	}
	if (!shapes.length) return [];
	const { palette, index } = paletteOf(colors, o.colors ?? 12);
	return byColour(shapes, palette, index, 'Mosaic');
}

/** Halftone dots: one per cell of a turned grid, its area following the darkness there. */
export function vectorHalftone(px: VectorTracePixels, o: VectorStylizeOptions = {}): VectorPathNode[] {
	const cell = o.cell ?? 8;
	check(px, cell);
	const colors: Rgba[] = [];
	const shapes: VectorSubpath[][] = [];
	for (const p of turnedGrid(px.width, px.height, cell, o.angle ?? 45)) {
		if (p.x < 0 || p.y < 0 || p.x >= px.width || p.y >= px.height) continue;
		const color = sampleBox(px, p.x, p.y, cell);
		// A dot's area follows the darkness; full darkness just touches its neighbours diagonally.
		const r = (cell / Math.SQRT2) * Math.sqrt(darkness(color));
		if (r < cell * 0.04) continue;
		colors.push(color);
		shapes.push([ellipseSubpath({ x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r })]);
	}
	if (!shapes.length) return [];
	if (o.color === null) {
		const { palette, index } = paletteOf(colors, o.colors ?? 12);
		return byColour(shapes, palette, index, 'Halftone');
	}
	return [{ id: 'stylize-0', type: 'path', name: 'Halftone', fill: o.color ?? '#000000', stroke: null, subpaths: shapes.flat() }];
}

/** A hash of three integers to 0…1. */
function hash01(a: number, b: number, seed: number): number {
	let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f) ^ Math.imul(seed, 0x165667b1);
	h ^= h >>> 15;
	h = Math.imul(h, 0x2c1b3c6d);
	h ^= h >>> 12;
	return (h >>> 0) / 0xffffffff;
}

/** Low-poly triangles: a jittered grid split into triangles, each in the colour under it. */
export function vectorLowPoly(px: VectorTracePixels, o: VectorStylizeOptions = {}): VectorPathNode[] {
	const cell = o.cell ?? 24;
	check(px, cell);
	const cols = Math.max(1, Math.round(px.width / cell));
	const rows = Math.max(1, Math.round(px.height / cell));
	tooMany(cols * rows * 2);
	const sx = px.width / cols;
	const sy = px.height / rows;
	const jitter = Math.min(0.5, Math.max(0, o.jitter ?? 0.35));
	const seed = Math.round(o.seed ?? 1);
	// Points on the image's edges stay on them.
	const pt = (c: number, r: number): [number, number] => {
		const jx = c === 0 || c === cols ? 0 : (hash01(c, r, seed) * 2 - 1) * jitter * sx;
		const jy = r === 0 || r === rows ? 0 : (hash01(c, r, seed + 7919) * 2 - 1) * jitter * sy;
		return [c * sx + jx, r * sy + jy];
	};
	const colors: Rgba[] = [];
	const shapes: VectorSubpath[][] = [];
	const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
		const cx = (a[0] + b[0] + c[0]) / 3;
		const cy = (a[1] + b[1] + c[1]) / 3;
		const color = sampleBox(px, cx, cy, Math.min(sx, sy) * 0.6);
		if (color[3] < 128) return;
		colors.push(color);
		shapes.push([{ closed: true, anchors: [a, b, c].map(([x, y]) => ({ x, y })) }]);
	};
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const p00 = pt(c, r);
			const p10 = pt(c + 1, r);
			const p01 = pt(c, r + 1);
			const p11 = pt(c + 1, r + 1);
			// Alternate the diagonal so the triangles do not all lean one way.
			if ((r + c) % 2) {
				tri(p00, p10, p11);
				tri(p00, p11, p01);
			} else {
				tri(p00, p10, p01);
				tri(p10, p11, p01);
			}
		}
	}
	if (!shapes.length) return [];
	const { palette, index } = paletteOf(colors, o.colors ?? 16);
	// A hairline in the fill colour closes the seams between neighbouring colours.
	return byColour(shapes, palette, index, 'Low Poly').map((n) => ({ ...n, stroke: n.fill, strokeWidth: 0.5, strokeLinejoin: 'round' as const }));
}

/** Engraving: lines along a turned grid that swell where the picture is dark and break where it is light. */
export function vectorHatch(px: VectorTracePixels, o: VectorStylizeOptions = {}): VectorPathNode[] {
	const cell = o.cell ?? 6;
	check(px, cell);
	const a = ((o.angle ?? 45) * Math.PI) / 180;
	const dir = { x: Math.cos(a), y: Math.sin(a) };
	const nrm = { x: -dir.y, y: dir.x };
	const pts = turnedGrid(px.width, px.height, cell, o.angle ?? 45);
	const rows = new Map<number, typeof pts>();
	for (const p of pts) {
		const list = rows.get(p.row);
		if (list) list.push(p);
		else rows.set(p.row, [p]);
	}
	const subpaths: VectorSubpath[] = [];
	const min = cell * 0.04;
	for (const list of rows.values()) {
		list.sort((p, q) => p.col - q.col);
		// Runs of points dark enough to draw become ribbons: the half-width either side of the line.
		let run: { x: number; y: number; t: number }[] = [];
		const flush = () => {
			if (run.length >= 2) {
				const top = run.map((p) => ({ x: p.x + nrm.x * p.t, y: p.y + nrm.y * p.t }));
				const bottom = run.map((p) => ({ x: p.x - nrm.x * p.t, y: p.y - nrm.y * p.t })).reverse();
				subpaths.push({ closed: true, anchors: [...top, ...bottom] });
			}
			run = [];
		};
		for (const p of list) {
			const inside = p.x >= 0 && p.y >= 0 && p.x < px.width && p.y < px.height;
			const t = inside ? (cell * 0.45 * darkness(sampleBox(px, p.x, p.y, cell))) : 0;
			if (t < min) {
				// Taper the end: the line closes at this point.
				if (run.length) run.push({ x: p.x, y: p.y, t: 0 });
				flush();
				continue;
			}
			// A ribbon starts from a point (tapered start).
			if (!run.length) run.push({ x: p.x - dir.x * cell, y: p.y - dir.y * cell, t: 0 });
			run.push({ x: p.x, y: p.y, t });
		}
		flush();
	}
	if (!subpaths.length) return [];
	tooMany(subpaths.length);
	return [{ id: 'stylize-0', type: 'path', name: 'Hatch', fill: o.color ?? '#000000', stroke: null, subpaths }];
}

/** Stylises pixels with `style` (see the module notes). */
export function stylizeVectorImage(px: VectorTracePixels, style: VectorStylizeStyle, options: VectorStylizeOptions = {}): VectorPathNode[] {
	switch (style) {
		case 'mosaic':
			return vectorMosaic(px, options);
		case 'halftone':
			return vectorHalftone(px, options);
		case 'lowPoly':
			return vectorLowPoly(px, options);
		case 'hatch':
			return vectorHatch(px, options);
	}
}
