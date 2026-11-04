/**
 * The lazily loaded half of brushed freehand strokes (`./brushstroke.ts` imports it on first use):
 * the paint engine's dry brushstroke renderer, the brush presets and host profile, and a CSS
 * colour parser. Keep every import of the paint engine and the presets in this file, so the canvas
 * entry never reaches them statically.
 */
import { BrushstrokeCache, brushstrokeDataUrl, isBrushstrokeBrush, type BrushstrokeBrush, type BrushstrokeImage } from '../paint/brushstroke.js';
import { parsePaintSource, type PaintSource } from '../paint/gradient-paint.js';
import { BUILTIN_BRUSHES } from '../paint-editor/brushes.js';
import { closest } from '../brushes/library.js';
import { normalizeBrushSpec } from '../brushes/normalize.js';
import { BRUSH_PRESETS } from '../brushes/presets.js';
import { CANVAS_PROFILE, checkBrush, listPresets } from '../brushes/profiles.js';
import { resolveBrush, resolveCategory } from '../brushes/resolve.js';
import type { Brush } from '../brushes/types.js';
import { isDualColor } from '../color/dual.js';
import { parseCssColor } from '../image-editor/layers/css-color.js';
import { resolveCanvasGradient } from './gradient.js';
import { formatNumber, getShapeSvg, type ShapeSize } from './shapeGeometry.js';
import { pathDataToPolyline, type BrushedPathShape, type CanvasBrushSwatchOptions, type CanvasBrush, type CanvasBrushPaint, type CanvasBrushPreset, type CanvasBrushSpec, type CanvasBrushstrokeImage } from './brushstroke.js';

// What the canvas profile admits (dry dab brushes; no light, which needs the paint editor's light
// channel), as the engine brushes the presets resolve to.
const PRESETS = listPresets(CANVAS_PROFILE).map((spec) => BUILTIN_BRUSHES.find((b) => b.id === spec.id)!);
const presetIds = () => PRESETS.map((b) => b.id).join(', ');

const refusal = (brush: Brush) =>
	checkBrush(brush, CANVAS_PROFILE)
		.issues.filter((i) => i.severity === 'error')
		.map((i) => `${i.reason} ${i.fix}`)
		.join(' ');

/** A saved brush, normalised and checked against the canvas profile; throws saying why it can't brush a stroke. */
export function readCanvasBrushSpec(spec: CanvasBrushSpec | unknown): Brush {
	let brush: Brush;
	try {
		brush = normalizeBrushSpec(spec);
	} catch (e) {
		throw new Error(`Not a brush: ${(e as Error).message}`);
	}
	if (!checkBrush(brush, CANVAS_PROFILE).ok) throw new Error(`Brush '${brush.id}' (${brush.name}) can't brush a canvas stroke: ${refusal(brush)}`);
	return brush;
}

/** The presets, then the saved brushes (`user`, facet brushes) the canvas can paint. */
export function listCanvasBrushes(user: readonly unknown[] = []): CanvasBrushPreset[] {
	const colourOf = (spec: Brush): Pick<CanvasBrushPreset, 'defaultColor'> => {
		const d = spec.colour?.default;
		return typeof d === 'string' || isDualColor(d) ? { defaultColor: d as CanvasBrushPreset['defaultColor'] } : {};
	};
	const out: CanvasBrushPreset[] = PRESETS.map((b) => ({ id: b.id, name: b.name, category: b.category, size: b.tip.size, builtin: true, ...colourOf(BRUSH_PRESETS.find((p) => p.id === b.id)!) }));
	for (const raw of user) {
		try {
			const brush = readCanvasBrushSpec(raw);
			if (out.some((b) => b.id === brush.id)) continue;
			out.push({ id: brush.id, name: brush.name, category: resolveCategory(brush), size: resolveBrush(brush).tip.size, builtin: false, spec: brush as unknown as CanvasBrushSpec, ...colourOf(brush) });
		} catch {
			// A saved brush the canvas can't paint is left out.
		}
	}
	return out;
}

/**
 * The paint engine brush for a canvas brush at diameter `width` (undefined: the brush's own size,
 * or the settings' `size`, else 3). `spec` is the saved brush a stroke embeds when `brush` names
 * one. Throws with the reason and the usable ids.
 */
export function resolveCanvasBrush(brush: CanvasBrush, width: number | undefined, spec?: CanvasBrushSpec | unknown): BrushstrokeBrush {
	const given = width !== undefined && Number.isFinite(width) ? Math.max(1, width) : undefined;
	const sized = (b: BrushstrokeBrush & { tip: { size: number } }) => (given === undefined ? b : { ...b, tip: { ...b.tip, size: given } });
	if (typeof brush === 'string') {
		if (spec !== undefined && spec !== null) {
			const saved = resolveBrush(readCanvasBrushSpec(spec));
			if (!isBrushstrokeBrush(saved)) throw new Error(`Brush '${saved.id}' (${saved.name}) can't brush a canvas stroke: it is not a dry dab brush.`);
			return sized(saved);
		}
		const preset = PRESETS.find((b) => b.id === brush);
		if (preset) return sized(preset);
		const other = BRUSH_PRESETS.find((b) => b.id === brush);
		if (other) throw new Error(`Brush '${brush}' (${other.name}) can't brush a canvas stroke: ${refusal(other)} Use one of: ${presetIds()}, or a saved brush the canvas can paint.`);
		throw new Error(`Unknown brush '${brush}'. ${closest(brush, PRESETS.map((b) => b.id))}Use one of the dry presets (${presetIds()}), a saved brush from the brush library, or tip settings ({ hardness, spacing, flow, … }).`);
	}
	if (!brush || typeof brush !== 'object' || Array.isArray(brush)) {
		throw new Error('A brush is a preset or saved brush id (see listCanvasBrushes / canvas.listBrushes) or an object of tip settings.');
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
	const brush = resolveCanvasBrush(shape.brush.brush, size, shape.brush.spec);
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

export function brushSwatchNow(brush: CanvasBrush, options: CanvasBrushSwatchOptions, spec?: CanvasBrushSpec): string {
	const w = options.width && options.width > 8 ? options.width : 96;
	const h = options.height && options.height > 4 ? options.height : 24;
	const own = typeof brush === 'string' ? resolveCanvasBrush(brush, undefined, spec) : resolveCanvasBrush(brush, brush.size);
	const tip = 'tip' in own && own.tip ? own.tip.size ?? 3 : (own as { size?: number }).size ?? 3;
	const size = Math.max(1.5, Math.min(tip, h * 0.55));
	const pad = size / 2 + 2;
	// A gentle S across the swatch, swelling in the middle.
	const pts = Array.from({ length: 9 }, (_, i) => [pad + ((w - 2 * pad) * i) / 8, h / 2 + Math.sin((i / 8) * Math.PI * 2) * (h / 2 - pad) * 0.6] as const);
	const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
	const image = renderShapeBrushstrokeNow(
		{ kind: 'path', d, stroke: options.color ?? '#1f2937', strokeWidth: size, brush: { brush, ...(spec ? { spec } : {}), seed: 7, size, pressure: [0.35, 1, 0.5] } },
		options.scale && options.scale > 0 ? options.scale : 2
	);
	return image?.href ?? '';
}
