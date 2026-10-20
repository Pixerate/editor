/**
 * The lazily loaded half of brushed freehand strokes (`./brushstroke.ts` imports it on first use):
 * the paint engine's dry brushstroke renderer, the paint presets and a CSS colour parser. Keep
 * every import of the paint engine in this file, so the canvas entry never reaches it statically.
 */
import { BrushstrokeCache, brushstrokeDataUrl, isBrushstrokeBrush, type BrushstrokeBrush, type BrushstrokeImage } from '../paint/brushstroke.js';
import { parsePaintSource, type PaintSource } from '../paint/gradient-paint.js';
import { BUILTIN_BRUSHES } from '../paint-editor/brushes.js';
import { parseCssColor } from '../image-editor/layers/css-color.js';
import { resolveCanvasGradient } from './gradient.js';
import { formatNumber, getShapeSvg, type ShapeSize } from './shapeGeometry.js';
import { pathDataToPolyline, type BrushedPathShape, type CanvasBrushSwatchOptions, type CanvasBrush, type CanvasBrushPaint, type CanvasBrushPreset, type CanvasBrushstrokeImage } from './brushstroke.js';

const DRY = BUILTIN_BRUSHES.filter((b) => isBrushstrokeBrush(b));

export function listCanvasBrushes(): CanvasBrushPreset[] {
	return DRY.map((b) => ({ id: b.id, name: b.name, category: b.category, size: b.tip.size }));
}

/**
 * The paint engine brush for a canvas brush at diameter `width` (undefined: the preset's own size,
 * or the settings' `size`, else 3); throws with the usable ids.
 */
export function resolveCanvasBrush(brush: CanvasBrush, width: number | undefined): BrushstrokeBrush {
	const given = width !== undefined && Number.isFinite(width) ? Math.max(1, width) : undefined;
	if (typeof brush === 'string') {
		const preset = BUILTIN_BRUSHES.find((b) => b.id === brush);
		const ids = DRY.map((b) => b.id).join(', ');
		if (!preset) throw new Error(`Unknown brush '${brush}'. Use one of the dry paint presets (${ids}) or tip settings ({ hardness, spacing, flow, … }).`);
		if (!isBrushstrokeBrush(preset)) {
			throw new Error(`Brush '${brush}' (${preset.name}) is not a dry brush: brushed canvas strokes use dry media only (wet paint needs an area to flow in; mixer, blender, smudge and eraser brushes need paint under them). Use one of: ${ids}.`);
		}
		return given === undefined ? preset : { ...preset, tip: { ...preset.tip, size: given } };
	}
	if (!brush || typeof brush !== 'object' || Array.isArray(brush)) {
		throw new Error('A brush is a dry paint preset id (see listCanvasBrushes / canvas.listBrushes) or an object of tip settings.');
	}
	return { size: given ?? 3, ...brush };
}

/**
 * The paint engine's `PaintSource` for a brushed stroke's `paint`; throws with what is wrong.
 * Mappings that need timed samples (`velocity`, `time`) are refused: canvas strokes carry no timing.
 */
export function resolveCanvasPaint(paint: CanvasBrushPaint | unknown): PaintSource {
	const source = parsePaintSource(paint, 'paint');
	if (source.type === 'gradient' && (source.map.by === 'velocity' || source.map.by === 'time')) {
		throw new Error(`paint.map.by "${source.map.by}" needs timed samples, which canvas strokes do not record; use distance, pressure, tilt, direction, across-tip or random.`);
	}
	return source;
}

/** A stored stroke's paint, or null when it has none or it is not valid paint (the stroke colour is used then). */
function shapePaint(shape: BrushedPathShape): PaintSource | null {
	if (shape.brush.paint === undefined || shape.brush.paint === null) return null;
	try {
		return resolveCanvasPaint(shape.brush.paint);
	} catch {
		return null;
	}
}

/**
 * RGBA of a shape's stroke paint: with `brush.paint` its alpha and the colour of `paint` stops.
 * A canvas gradient stroke without `brush.paint` uses its first stop.
 */
function strokeColor(shape: BrushedPathShape): [number, number, number, number] {
	const gradient = resolveCanvasGradient(shape.strokeGradient ?? shape.stroke);
	const css = gradient ? (gradient.stops[0]?.color ?? '#000') : typeof shape.stroke === 'string' && shape.stroke !== 'none' ? shape.stroke : '#000';
	const parsed = parseCssColor(css) ?? { hex: '#000000', alpha: 1 };
	const n = parseInt(parsed.hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(parsed.alpha * 255)];
}

const cache = new BrushstrokeCache(128);
const urls = new WeakMap<BrushstrokeImage, string>();

export function renderShapeBrushstrokeNow(shape: BrushedPathShape, scale: number, place: { origin?: { x: number; y: number }; unit?: number } = {}): CanvasBrushstrokeImage | null {
	// Strokes with a character seed (new ones) default to the preset's size and render its jitter
	// and grain; older strokes keep the stroke width and plain dabs, so they look as they always did.
	const seed = shape.brush.seed;
	const textured = typeof seed === 'number' && Number.isFinite(seed);
	const size = shape.brush.size ?? (textured ? undefined : (shape.strokeWidth ?? 3));
	const brush = resolveCanvasBrush(shape.brush.brush, size);
	const points = pathDataToPolyline(shape.d);
	if (!points.length) return null;
	const { pressure, tiltX, tiltY } = shape.brush;
	const input = {
		points: points.map(([x, y]) => ({ x, y })),
		...(pressure?.length ? { pressure } : {}),
		...(tiltX?.length ? { tiltX } : {}),
		...(tiltY?.length ? { tiltY } : {})
	};
	const paint = shapePaint(shape);
	const character = textured
		? {
				character: {
					seed,
					...(shape.brush.paper !== undefined ? { paper: shape.brush.paper } : {}),
					// Whole canvas units: the grain stays put, and tiny drags do not re-render.
					origin: { x: Math.round(place.origin?.x ?? 0), y: Math.round(place.origin?.y ?? 0) },
					unit: place.unit && place.unit > 0 ? Math.round(place.unit * 1000) / 1000 : 1
				}
			}
		: {};
	const stroke = cache.render(input, brush, { scale, color: strokeColor(shape), ...(paint ? { paint } : {}), ...character });
	if (!stroke.bounds) return null;
	let href = urls.get(stroke);
	if (href === undefined) {
		href = brushstrokeDataUrl(stroke);
		urls.set(stroke, href);
	}
	return { href, ...stroke.bounds, scale: stroke.scale };
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function brushedShapeSvgNow(shape: BrushedPathShape, size: ShapeSize, scale: number, place: { origin?: { x: number; y: number }; unit?: number } = {}): string {
	const f = (n: number) => formatNumber(n, 3);
	const image = renderShapeBrushstrokeNow(shape, scale, place);
	const svg = getShapeSvg(shape, size);
	const body = image
		? `<image href="${escapeAttr(image.href)}" x="${f(image.x)}" y="${f(image.y)}" width="${f(image.width)}" height="${f(image.height)}" preserveAspectRatio="none"${shape.opacity !== undefined ? ` opacity="${f(shape.opacity)}"` : ''}/>`
		: '';
	const content = svg.transform && body ? `<g transform="${svg.transform}">${body}</g>` : body;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${f(size.width)}" height="${f(size.height)}" viewBox="0 0 ${f(size.width)} ${f(size.height)}">${content}</svg>`;
}

export function brushSwatchNow(brush: CanvasBrush, options: CanvasBrushSwatchOptions): string {
	const w = options.width && options.width > 8 ? options.width : 96;
	const h = options.height && options.height > 4 ? options.height : 24;
	const own = typeof brush === 'string' ? resolveCanvasBrush(brush, undefined) : resolveCanvasBrush(brush, brush.size);
	const tip = 'tip' in own && own.tip ? own.tip.size ?? 3 : (own as { size?: number }).size ?? 3;
	const size = Math.max(1.5, Math.min(tip, h * 0.55));
	const pad = size / 2 + 2;
	// A gentle S across the swatch, swelling in the middle.
	const pts = Array.from({ length: 9 }, (_, i) => [pad + ((w - 2 * pad) * i) / 8, h / 2 + Math.sin((i / 8) * Math.PI * 2) * (h / 2 - pad) * 0.6] as const);
	const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
	const image = renderShapeBrushstrokeNow(
		{ kind: 'path', d, stroke: options.color ?? '#1f2937', strokeWidth: size, brush: { brush, seed: 7, size, pressure: [0.35, 1, 0.5] } },
		options.scale && options.scale > 0 ? options.scale : 2
	);
	return image?.href ?? '';
}
