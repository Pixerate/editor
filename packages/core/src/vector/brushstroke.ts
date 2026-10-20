/**
 * Brushstrokes on vector paths: a stroke layer of kind `brushstroke` paints the path with a
 * natural-media brush from the paint editor's library (pencil, pastel, charcoal, ink, marker…)
 * instead of a geometric line. The path stays the data; the pixels are a cache. Each subpath is
 * flattened into samples, rendered by the shared renderer (`renderBrushstroke` through a
 * `BrushstrokeCache`, the same one the canvas uses for brushed strokes) in the layer's colour, and
 * drawn as an image over the path's bounds. A pressure profile along the length shapes it like a
 * pen stroke.
 *
 * Only dry dab-engine brushes render (wet, mixer and smudge brushes need paint under them).
 * Images are rendered at `VECTOR_BRUSHSTROKE_SCALE` pixels per unit, the same at every zoom.
 */
import { BrushstrokeCache, brushstrokeDataUrl, isBrushstrokeBrush, type BrushstrokeImage } from '../paint/brushstroke.js';
import { BUILTIN_BRUSHES, type PaintBrush } from '../paint-editor/brushes.js';
import { closeContour, flattenChain, pathToContours } from '../canvas/pathops/bezier.js';
import { parseVectorColor } from './gradient.js';
import { subpathsToBezier } from './geometry.js';
import { vectorPaintSolid } from './extrude.js';
import type { VectorBrushstroke, VectorPathNode, VectorStrokeLayer } from './types.js';

/** Image pixels per document unit brushstrokes are rendered at. */
export const VECTOR_BRUSHSTROKE_SCALE = 2;

/** The brushes a brushstroke can use: the library's dry dab-engine brushes. */
export function vectorBrushstrokeBrushes(): PaintBrush[] {
	return BUILTIN_BRUSHES.filter((b) => isBrushstrokeBrush(b));
}

/** A brush from the library by id, or null. */
export function vectorBrushstrokeBrush(id: string): PaintBrush | null {
	return vectorBrushstrokeBrushes().find((b) => b.id === id) ?? null;
}

/** Reads brushstroke settings from untrusted data; null when the brush is unknown. */
export function sanitizeVectorBrushstroke(value: unknown): VectorBrushstroke | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	if (typeof r.brushId !== 'string' || !vectorBrushstrokeBrush(r.brushId)) return null;
	const out: VectorBrushstroke = { brushId: r.brushId };
	if (typeof r.size === 'number' && Number.isFinite(r.size) && r.size > 0) out.size = Math.min(500, r.size);
	if (Array.isArray(r.pressure)) {
		const p = r.pressure.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).map((v) => Math.min(1, Math.max(0, v)));
		if (p.length) out.pressure = p.slice(0, 64);
	}
	return out;
}

/** A brushstroke stroke layer (kind `brushstroke` with a known brush). */
export function isVectorBrushstrokeLayer(layer: VectorStrokeLayer): layer is VectorStrokeLayer & { kind: 'brushstroke'; brush: VectorBrushstroke } {
	return layer.kind === 'brushstroke' && !!layer.brush && !!vectorBrushstrokeBrush(layer.brush.brushId);
}

/** How far a brushstroke layer reaches past the path (half its brush size). */
export function vectorBrushstrokeReach(layer: VectorStrokeLayer): number {
	if (!isVectorBrushstrokeLayer(layer)) return 0;
	return (layer.brush.size ?? vectorBrushstrokeBrush(layer.brush.brushId)!.tip.size) / 2;
}

/** One rendered piece of a brushstroke: a PNG data URL drawn stretched over `x, y, width, height` (path units). */
export interface VectorBrushstrokeImage {
	href: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

const cache = new BrushstrokeCache(256);
const urls = new WeakMap<BrushstrokeImage, string>();
const layerCache = new WeakMap<VectorPathNode, Map<VectorStrokeLayer, VectorBrushstrokeImage[]>>();

/**
 * The images of a brushstroke layer on a path, one per subpath, in the path's own space (cached
 * per path and layer object, and by the shared renderer's cache).
 */
export function vectorBrushstrokeImages(node: VectorPathNode, layer: VectorStrokeLayer): VectorBrushstrokeImage[] {
	if (!isVectorBrushstrokeLayer(layer)) return [];
	let byLayer = layerCache.get(node);
	const hit = byLayer?.get(layer);
	if (hit) return hit;
	const preset = vectorBrushstrokeBrush(layer.brush.brushId)!;
	const brush = layer.brush.size ? { ...preset, tip: { ...preset.tip, size: layer.brush.size } } : preset;
	const solid = vectorPaintSolid(layer.paint) ?? '#000000';
	const c = parseVectorColor(solid) ?? [0, 0, 0, 1];
	const color = [c[0] * 255, c[1] * 255, c[2] * 255, c[3] * 255].map(Math.round) as [number, number, number, number];
	const out: VectorBrushstrokeImage[] = [];
	for (const sp of node.subpaths) {
		if (sp.anchors.length < 2) continue;
		for (const contour of pathToContours(subpathsToBezier([sp]))) {
			const ring = flattenChain(closeContour(contour, contour.closed), 0.25);
			if (contour.closed && ring.length > 2) ring.push(ring[0]);
			if (ring.length < 2) continue;
			const stroke = cache.render({ points: ring.map(([x, y]) => ({ x, y })), ...(layer.brush.pressure ? { pressure: layer.brush.pressure } : {}) }, brush, { scale: VECTOR_BRUSHSTROKE_SCALE, color, maxPixels: 2048 * 2048 });
			if (!stroke.bounds) continue;
			let href = urls.get(stroke);
			if (!href) urls.set(stroke, (href = brushstrokeDataUrl(stroke)));
			out.push({ href, ...stroke.bounds });
		}
	}
	if (!byLayer) layerCache.set(node, (byLayer = new Map()));
	byLayer.set(layer, out);
	return out;
}
