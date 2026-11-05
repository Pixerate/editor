/**
 * What lies beneath a brushstroke, as pixels: the backdrop a Mixer Brush, smudge or blender
 * brushstroke acts on (#519). The vector editor draws through SVG, so this is a small CPU renderer
 * of the scene's render data (`getVectorSceneRenderData`), which already has blends, booleans,
 * symbols and path effects resolved into plain paths.
 *
 * It draws, straight over each other in paint order:
 * - fills: solid colours and the gradients in `defs` (linear and radial; conic, diamond and
 *   stroke-mode gradients through their pattern tiles), with the fill rule;
 * - strokes: the line at its width with round joins and caps (variable-width outlines filled),
 *   without dashes; inside and outside aligned strokes are drawn centred at their visible width;
 * - brushstrokes: their rendered images;
 * - layer, node and group opacity.
 *
 * Left out: text drawn as SVG text, filters (shadows, glows, blurs), masks and clips (masked
 * contents draw whole) and blend modes (drawn as normal). Pure data in, pixels out.
 */
import { decodePng, parseDataUrl } from '../raster/png.js';
import type { RasterRect } from '../raster/surface.js';
import { parseSvgPath } from '../canvas/shapeGeometry.js';
import { rasterizeCoverage, type FlatPath } from '../image-editor/layers/vector-raster.js';
import { parseVectorColor, sampleVectorPaintDefAt, type VectorPaintDef, type VectorRgba } from './gradient.js';
import type { VectorRenderNode, VectorRenderPaintLayer, VectorRenderPath } from './render.js';
import type { VectorMatrix } from './types.js';

type M = VectorMatrix;

const IDENTITY: M = [1, 0, 0, 1, 0, 0];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const inv = (m: M): M | null => {
	const det = m[0] * m[3] - m[1] * m[2];
	if (!det || !Number.isFinite(det)) return null;
	return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};

/** An SVG `transform` attribute (`matrix`, `translate`, `scale`, `rotate`, in order) as a matrix. */
export function parseVectorTransform(value: string | undefined): M {
	if (!value) return IDENTITY;
	let m = IDENTITY;
	for (const [, fn, args] of value.matchAll(/(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g)) {
		const n = args.split(/[\s,]+/).filter(Boolean).map(Number);
		if (n.some((v) => !Number.isFinite(v))) continue;
		let t: M = IDENTITY;
		if (fn === 'matrix' && n.length === 6) t = n as unknown as M;
		else if (fn === 'translate') t = [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0];
		else if (fn === 'scale') t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0];
		else if (fn === 'rotate') {
			const a = ((n[0] ?? 0) * Math.PI) / 180;
			const [cx, cy] = [n[1] ?? 0, n[2] ?? 0];
			t = mul(mul([1, 0, 0, 1, cx, cy], [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]), [1, 0, 0, 1, -cx, -cy]);
		}
		m = mul(m, t);
	}
	return m;
}

/** SVG path data flattened into polylines in pixel space (`m` maps path units to pixels), each with whether it closes. */
function flatten(d: string, m: M, tolerance = 0.25): Array<{ pts: number[]; closed: boolean }> {
	const out: Array<{ pts: number[]; closed: boolean }> = [];
	let cur: { pts: number[]; closed: boolean } | null = null;
	let x = 0, y = 0, sx = 0, sy = 0;
	const push = (px: number, py: number) => cur!.pts.push(m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]);
	const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
	const steps = (len: number) => Math.max(2, Math.min(64, Math.ceil(Math.sqrt((len * scale) / tolerance))));
	for (const c of parseSvgPath(d)) {
		if (c.type === 'M') {
			cur = { pts: [], closed: false };
			out.push(cur);
			x = sx = c.x;
			y = sy = c.y;
			push(x, y);
			continue;
		}
		if (!cur) continue;
		if (c.type === 'Z') {
			cur.closed = true;
			x = sx;
			y = sy;
			cur = { pts: [], closed: false };
			out.push(cur);
			push(x, y);
			continue;
		}
		if (c.type === 'C') {
			const n = steps(Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2));
			for (let i = 1; i <= n; i++) {
				const t = i / n, u = 1 - t;
				push(u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y);
			}
		} else if (c.type === 'Q') {
			const n = steps(Math.hypot(c.x1 - x, c.y1 - y) + Math.hypot(c.x - c.x1, c.y - c.y1));
			for (let i = 1; i <= n; i++) {
				const t = i / n, u = 1 - t;
				push(u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y);
			}
		} else push(c.x, c.y);
		x = c.x;
		y = c.y;
	}
	return out.filter((p) => p.pts.length >= 4);
}

/** Coverage of a stroke of `width` pixels along polylines (round joins and caps), over `rect`. */
function strokeCoverage(lines: Array<{ pts: number[]; closed: boolean }>, width: number, rect: RasterRect): Float32Array | null {
	const r = width / 2;
	if (!(r > 0)) return null;
	const w = rect.width, h = rect.height;
	let out: Float32Array | null = null;
	for (const line of lines) {
		const p = line.pts;
		const n = p.length / 2;
		const segs = line.closed ? n : n - 1;
		for (let s = 0; s < segs; s++) {
			const ax = p[2 * s] - rect.x, ay = p[2 * s + 1] - rect.y;
			const k = (s + 1) % n;
			const bx = p[2 * k] - rect.x, by = p[2 * k + 1] - rect.y;
			const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r + 1));
			const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r + 1));
			if (x0 > x1 || y0 > y1) continue;
			const dx = bx - ax, dy = by - ay;
			const l2 = dx * dx + dy * dy;
			for (let yy = y0; yy <= y1; yy++) {
				for (let xx = x0; xx <= x1; xx++) {
					const px = xx + 0.5 - ax, py = yy + 0.5 - ay;
					const t = l2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / l2)) : 0;
					const dist = Math.hypot(px - t * dx, py - t * dy);
					const c = Math.min(1, Math.max(0, r + 0.5 - dist));
					if (c <= 0) continue;
					out ??= new Float32Array(w * h);
					const i = yy * w + xx;
					if (c > out[i]) out[i] = c;
				}
			}
		}
	}
	return out;
}

const pngs = new Map<string, { width: number; height: number; data: Uint8ClampedArray } | null>();

/** A brushstroke image's pixels (decoded once per data URL; at most 64 kept). */
function decoded(href: string): { width: number; height: number; data: Uint8ClampedArray } | null {
	if (pngs.has(href)) return pngs.get(href)!;
	let img: { width: number; height: number; data: Uint8ClampedArray } | null = null;
	try {
		const parsed = parseDataUrl(href);
		const png = parsed ? decodePng(parsed.bytes) : null;
		if (png && png.channels === 4) img = { width: png.width, height: png.height, data: png.data };
	} catch {
		img = null;
	}
	if (pngs.size >= 64) pngs.delete(pngs.keys().next().value as string);
	pngs.set(href, img);
	return img;
}

/** Premultiplied float RGBA, composited `over`. */
class Canvas {
	readonly px: Float32Array;
	constructor(readonly rect: RasterRect) {
		this.px = new Float32Array(rect.width * rect.height * 4);
	}
	over(i: number, c: VectorRgba, a: number): void {
		const k = Math.min(1, Math.max(0, c[3] * a));
		if (k <= 0) return;
		const o = i * 4, px = this.px, rest = 1 - k;
		px[o] = c[0] * k + px[o] * rest;
		px[o + 1] = c[1] * k + px[o + 1] * rest;
		px[o + 2] = c[2] * k + px[o + 2] * rest;
		px[o + 3] = k + px[o + 3] * rest;
	}
	bytes(): Uint8ClampedArray {
		const out = new Uint8ClampedArray(this.px.length);
		for (let i = 0; i < this.px.length; i += 4) {
			const a = this.px[i + 3];
			if (a <= 0) continue;
			out[i] = Math.round((this.px[i] / a) * 255);
			out[i + 1] = Math.round((this.px[i + 1] / a) * 255);
			out[i + 2] = Math.round((this.px[i + 2] / a) * 255);
			out[i + 3] = Math.round(a * 255);
		}
		return out;
	}
}

/** Paints `coverage` with `paint` (a colour or `url(#id)` sampled in the item's space through `toLocal`). */
function paintCoverage(canvas: Canvas, coverage: Float32Array | null, paint: string, defs: readonly VectorPaintDef[], toLocal: M, alpha: number): void {
	if (!coverage || paint === 'none') return;
	const url = /^url\(#(.+)\)$/.exec(paint);
	const solid = url ? null : parseVectorColor(paint);
	if (!url && !solid) return;
	const { x: rx, y: ry, width: w } = canvas.rect;
	for (let i = 0; i < coverage.length; i++) {
		const c = coverage[i];
		if (c <= 0) continue;
		let col = solid;
		if (url) {
			const px = rx + (i % w) + 0.5, py = ry + Math.floor(i / w) + 0.5;
			col = sampleVectorPaintDefAt(defs, url[1], { x: toLocal[0] * px + toLocal[2] * py + toLocal[4], y: toLocal[1] * px + toLocal[3] * py + toLocal[5] });
		}
		if (col) canvas.over(i, col, c * alpha);
	}
}

function drawImage(canvas: Canvas, im: { href: string; x: number; y: number; width: number; height: number }, toLocal: M, alpha: number): void {
	const img = decoded(im.href);
	if (!img || !(im.width > 0 && im.height > 0)) return;
	const { x: rx, y: ry, width: w, height: h } = canvas.rect;
	const c: [number, number, number, number] = [0, 0, 0, 0];
	for (let yy = 0; yy < h; yy++) {
		for (let xx = 0; xx < w; xx++) {
			const px = rx + xx + 0.5, py = ry + yy + 0.5;
			const lx = toLocal[0] * px + toLocal[2] * py + toLocal[4], ly = toLocal[1] * px + toLocal[3] * py + toLocal[5];
			const u = ((lx - im.x) / im.width) * img.width - 0.5, v = ((ly - im.y) / im.height) * img.height - 0.5;
			if (u < -1 || v < -1 || u > img.width || v > img.height) continue;
			// Bilinear, premultiplied.
			const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
			c[0] = c[1] = c[2] = c[3] = 0;
			for (let k = 0; k < 4; k++) {
				const sx = u0 + (k & 1), sy = v0 + (k >> 1);
				if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
				const wgt = ((k & 1) ? fu : 1 - fu) * ((k >> 1) ? fv : 1 - fv);
				const o = (sy * img.width + sx) * 4, a = (img.data[o + 3] / 255) * wgt;
				c[0] += (img.data[o] / 255) * a;
				c[1] += (img.data[o + 1] / 255) * a;
				c[2] += (img.data[o + 2] / 255) * a;
				c[3] += a;
			}
			if (c[3] <= 0) continue;
			canvas.over(yy * w + xx, [c[0] / c[3], c[1] / c[3], c[2] / c[3], c[3]], alpha);
		}
	}
}

function drawPath(canvas: Canvas, p: VectorRenderPath, defs: readonly VectorPaintDef[], m: M, alpha: number): void {
	const toLocal = inv(m);
	if (!toLocal) return;
	const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
	const rule = p.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
	const layers: VectorRenderPaintLayer[] = p.layers ?? [
		{ kind: 'fill', index: 0, fill: p.fill, stroke: 'none', strokeWidth: 0, opacity: 1 },
		{ kind: 'stroke', index: 0, fill: 'none', stroke: p.stroke, strokeWidth: p.strokeWidth, opacity: 1, strokeParts: p.strokeParts }
	];
	let lines: ReturnType<typeof flatten> | null = null;
	const shape = () => (lines ??= flatten(p.d, m));
	const fill = (d: string | null, rl: 'nonzero' | 'evenodd') => {
		const flat: FlatPath = (d ? flatten(d, m) : shape()).map((l) => Float64Array.from(l.pts));
		return rasterizeCoverage(flat, canvas.rect, rl);
	};
	for (const l of layers) {
		const a = alpha * l.opacity;
		if (a <= 0) continue;
		if (l.kind === 'brushstroke') {
			for (const im of l.images ?? []) drawImage(canvas, im, toLocal, a);
		} else if (l.kind === 'fill') {
			if (l.fill !== 'none') paintCoverage(canvas, fill(null, rule), l.fill, defs, toLocal, a);
		} else if (l.stroke !== 'none' && l.strokeWidth > 0) {
			const parts = l.strokeParts;
			const cov = parts?.outline ? fill(parts.outline, 'nonzero') : strokeCoverage(parts ? flatten(parts.d, m) : shape(), (parts ? (parts.align === 'center' ? parts.width : parts.width / 2) : l.strokeWidth) * scale, canvas.rect);
			paintCoverage(canvas, cov, l.stroke, defs, toLocal, a);
		}
	}
}

function drawNodes(canvas: Canvas, nodes: readonly VectorRenderNode[], defs: readonly VectorPaintDef[], m: M, alpha: number): void {
	for (const n of nodes) {
		if (n.kind === 'text') continue;
		const mm = mul(m, parseVectorTransform(n.transform));
		const a = alpha * (n.opacity ?? 1);
		if (a <= 0) continue;
		if (n.kind === 'group') drawNodes(canvas, n.children, defs, mm, a);
		else drawPath(canvas, n, defs, mm, a);
	}
}

/**
 * The render data's `nodes` (document space) drawn over `rect` (pixels) through `toPixels`, the
 * map from document space to those pixels: straight-alpha RGBA, `rect.width × rect.height`.
 */
export function rasterizeVectorBackdrop(nodes: readonly VectorRenderNode[], defs: readonly VectorPaintDef[], toPixels: VectorMatrix, rect: RasterRect): Uint8ClampedArray {
	const canvas = new Canvas(rect);
	if (rect.width > 0 && rect.height > 0) drawNodes(canvas, nodes, defs, toPixels, 1);
	return canvas.bytes();
}
