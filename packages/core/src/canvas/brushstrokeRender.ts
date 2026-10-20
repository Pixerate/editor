/**
 * The lazily loaded half of brushed freehand strokes (`./brushstroke.ts` imports it on first use):
 * the paint engine's dry brushstroke renderer, the paint presets and a CSS colour parser. Keep
 * every import of the paint engine in this file, so the canvas entry never reaches it statically.
 */
import { BrushstrokeCache, brushstrokeDataUrl, isBrushstrokeBrush, type BrushstrokeBrush, type BrushstrokeImage } from '../paint/brushstroke.js';
import { BUILTIN_BRUSHES } from '../paint-editor/brushes.js';
import { parseCssColor } from '../image-editor/layers/css-color.js';
import { resolveCanvasGradient } from './gradient.js';
import { formatNumber, getShapeSvg, type ShapeSize } from './shapeGeometry.js';
import { pathDataToPolyline, type BrushedPathShape, type CanvasBrush, type CanvasBrushPreset, type CanvasBrushstrokeImage } from './brushstroke.js';

const DRY = BUILTIN_BRUSHES.filter((b) => isBrushstrokeBrush(b));

export function listCanvasBrushes(): CanvasBrushPreset[] {
	return DRY.map((b) => ({ id: b.id, name: b.name, category: b.category, size: b.tip.size }));
}

/** The paint engine brush for a canvas brush at stroke width `width`; throws with the usable ids. */
export function resolveCanvasBrush(brush: CanvasBrush, width: number): BrushstrokeBrush {
	const size = Math.max(1, Number.isFinite(width) ? width : 1);
	if (typeof brush === 'string') {
		const preset = BUILTIN_BRUSHES.find((b) => b.id === brush);
		const ids = DRY.map((b) => b.id).join(', ');
		if (!preset) throw new Error(`Unknown brush '${brush}'. Use one of the dry paint presets (${ids}) or tip settings ({ hardness, spacing, flow, … }).`);
		if (!isBrushstrokeBrush(preset)) {
			throw new Error(`Brush '${brush}' (${preset.name}) is not a dry brush: brushed canvas strokes use dry media only (wet paint needs an area to flow in; mixer, blender, smudge and eraser brushes need paint under them). Use one of: ${ids}.`);
		}
		return { ...preset, tip: { ...preset.tip, size } };
	}
	if (!brush || typeof brush !== 'object' || Array.isArray(brush)) {
		throw new Error('A brush is a dry paint preset id (see listCanvasBrushes / canvas.listBrushes) or an object of tip settings.');
	}
	return { size, ...brush };
}

/** RGBA of a shape's stroke paint. Gradients use their first stop until gradient paint (`PaintSource`) reaches the brush engine. */
function strokeColor(shape: BrushedPathShape): [number, number, number, number] {
	const gradient = resolveCanvasGradient(shape.strokeGradient ?? shape.stroke);
	const css = gradient ? (gradient.stops[0]?.color ?? '#000') : typeof shape.stroke === 'string' && shape.stroke !== 'none' ? shape.stroke : '#000';
	const parsed = parseCssColor(css) ?? { hex: '#000000', alpha: 1 };
	const n = parseInt(parsed.hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(parsed.alpha * 255)];
}

const cache = new BrushstrokeCache(128);
const urls = new WeakMap<BrushstrokeImage, string>();

export function renderShapeBrushstrokeNow(shape: BrushedPathShape, scale: number): CanvasBrushstrokeImage | null {
	const brush = resolveCanvasBrush(shape.brush.brush, shape.strokeWidth ?? 3);
	const points = pathDataToPolyline(shape.d);
	if (!points.length) return null;
	const { pressure, tiltX, tiltY } = shape.brush;
	const input = {
		points: points.map(([x, y]) => ({ x, y })),
		...(pressure?.length ? { pressure } : {}),
		...(tiltX?.length ? { tiltX } : {}),
		...(tiltY?.length ? { tiltY } : {})
	};
	const stroke = cache.render(input, brush, { scale, color: strokeColor(shape) });
	if (!stroke.bounds) return null;
	let href = urls.get(stroke);
	if (href === undefined) {
		href = brushstrokeDataUrl(stroke);
		urls.set(stroke, href);
	}
	return { href, ...stroke.bounds, scale: stroke.scale };
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function brushedShapeSvgNow(shape: BrushedPathShape, size: ShapeSize, scale: number): string {
	const f = (n: number) => formatNumber(n, 3);
	const image = renderShapeBrushstrokeNow(shape, scale);
	const svg = getShapeSvg(shape, size);
	const body = image
		? `<image href="${escapeAttr(image.href)}" x="${f(image.x)}" y="${f(image.y)}" width="${f(image.width)}" height="${f(image.height)}" preserveAspectRatio="none"${shape.opacity !== undefined ? ` opacity="${f(shape.opacity)}"` : ''}/>`
		: '';
	const content = svg.transform && body ? `<g transform="${svg.transform}">${body}</g>` : body;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${f(size.width)}" height="${f(size.height)}" viewBox="0 0 ${f(size.width)} ${f(size.height)}">${content}</svg>`;
}
