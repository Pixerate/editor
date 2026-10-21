/**
 * Brushstrokes on vector paths: a stroke layer of kind `brushstroke` paints the path with a
 * natural-media brush from the paint editor's library (pencil, pastel, charcoal, ink, marker…)
 * instead of a geometric line. The path stays the data; the pixels are a cache. Each subpath is
 * flattened into samples, rendered by the shared renderer (`renderBrushstroke` through a
 * `BrushstrokeCache`, the same one the canvas uses for brushed strokes) in the layer's colour, and
 * drawn as an image over the path's bounds. A pressure profile along the length shapes it like a
 * pen stroke. A layer with a `seed` also gets the brush's character (seeded jitter and paper grain,
 * `renderBrushstroke`'s `character` option); one without renders exactly as it always has.
 *
 * Only dry dab-engine brushes render (wet, mixer and smudge brushes need paint under them).
 * Images are rendered at `VECTOR_BRUSHSTROKE_SCALE` pixels per unit, the same at every zoom.
 */
import { BrushstrokeCache, brushstrokeDataUrl, isBrushstrokeBrush, type BrushstrokeImage } from '../paint/brushstroke.js';
import { GRAIN_PATTERNS, type GrainPattern } from '../paint/grain.js';
import { BUILTIN_BRUSHES, type PaintBrush } from '../paint-editor/brushes.js';
import { closeContour, flattenChain, pathToContours } from '../canvas/pathops/bezier.js';
import { parseVectorColor } from './gradient.js';
import { subpathsToBezier } from './geometry.js';
import { vectorPaintSolid } from './extrude.js';
import type { VectorBrushstroke, VectorBrushstrokePaper, VectorPathNode, VectorStrokeLayer } from './types.js';

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
	const seed = sanitizeSeed(r.seed);
	if (seed !== undefined) out.seed = seed;
	if (r.paper === null) out.paper = null;
	else {
		const paper = sanitizeVectorBrushstrokePaper(r.paper);
		if (paper) out.paper = paper;
	}
	return out;
}

/** The largest brushstroke seed. */
export const VECTOR_BRUSHSTROKE_MAX_SEED = 2147483647;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sanitizeSeed = (v: unknown): number | undefined => (finite(v) ? Math.min(VECTOR_BRUSHSTROKE_MAX_SEED, Math.max(0, Math.round(v))) : undefined);

/** Reads paper settings from untrusted data; null when there are none (the default paper). */
export function sanitizeVectorBrushstrokePaper(value: unknown): VectorBrushstrokePaper | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	const out: VectorBrushstrokePaper = {};
	if (typeof r.pattern === 'string' && (GRAIN_PATTERNS as readonly string[]).includes(r.pattern)) out.pattern = r.pattern as GrainPattern;
	const seed = sanitizeSeed(r.seed);
	if (seed !== undefined) out.seed = seed;
	if (finite(r.scale) && r.scale > 0) out.scale = Math.min(8, Math.max(0.25, r.scale));
	if (finite(r.depth)) out.depth = Math.min(1, Math.max(0, r.depth));
	return Object.keys(out).length ? out : null;
}

/**
 * What is wrong with a brushstroke's `seed` or `paper` (from an agent or a caller), or null when
 * they are valid (or absent).
 */
export function vectorBrushstrokeCharacterError(brush: { seed?: unknown; paper?: unknown }): string | null {
	if (brush.seed !== undefined && !(Number.isInteger(brush.seed) && (brush.seed as number) >= 0 && (brush.seed as number) <= VECTOR_BRUSHSTROKE_MAX_SEED)) return `seed must be an integer from 0 to ${VECTOR_BRUSHSTROKE_MAX_SEED}.`;
	const paper = brush.paper;
	if (paper === undefined || paper === null) return null;
	if (typeof paper !== 'object' || Array.isArray(paper)) return 'paper must be an object { pattern, seed, scale, depth } or null for no grain.';
	const r = paper as Record<string, unknown>;
	const extra = Object.keys(r).filter((k) => !['pattern', 'seed', 'scale', 'depth'].includes(k));
	if (extra.length) return `paper has unknown field ${extra.map((k) => `"${k}"`).join(', ')}: use pattern, seed, scale, depth.`;
	if (r.pattern !== undefined && !(GRAIN_PATTERNS as readonly unknown[]).includes(r.pattern)) return `Unknown paper pattern "${String(r.pattern)}": use one of ${GRAIN_PATTERNS.join(', ')}.`;
	if (r.seed !== undefined && !(Number.isInteger(r.seed) && (r.seed as number) >= 0 && (r.seed as number) <= VECTOR_BRUSHSTROKE_MAX_SEED)) return `paper.seed must be an integer from 0 to ${VECTOR_BRUSHSTROKE_MAX_SEED}.`;
	if (r.scale !== undefined && !(finite(r.scale) && r.scale >= 0.25 && r.scale <= 8)) return 'paper.scale must be from 0.25 to 8 (1 is the pattern\'s natural size).';
	if (r.depth !== undefined && !(finite(r.depth) && r.depth >= 0 && r.depth <= 1)) return 'paper.depth must be from 0 to 1.';
	return null;
}

/** A random brushstroke seed, for a new layer added from a panel. */
export function randomVectorBrushstrokeSeed(): number {
	return Math.floor(Math.random() * VECTOR_BRUSHSTROKE_MAX_SEED);
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
 * per path and layer object, and by the shared renderer's cache, whose key includes the seed and
 * paper). A layer with a seed renders with the brush's character, the grain laid in the path's
 * own space (paper point = path point).
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
	const { seed, paper } = layer.brush;
	const character = seed !== undefined ? { character: { seed, origin: { x: 0, y: 0 }, unit: 1, ...(paper !== undefined ? { paper } : {}) } } : {};
	const out: VectorBrushstrokeImage[] = [];
	for (const sp of node.subpaths) {
		if (sp.anchors.length < 2) continue;
		for (const contour of pathToContours(subpathsToBezier([sp]))) {
			const ring = flattenChain(closeContour(contour, contour.closed), 0.25);
			if (contour.closed && ring.length > 2) ring.push(ring[0]);
			if (ring.length < 2) continue;
			const stroke = cache.render({ points: ring.map(([x, y]) => ({ x, y })), ...(layer.brush.pressure ? { pressure: layer.brush.pressure } : {}) }, brush, { scale: VECTOR_BRUSHSTROKE_SCALE, color, maxPixels: 2048 * 2048, ...character });
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
