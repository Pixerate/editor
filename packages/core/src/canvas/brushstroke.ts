/**
 * Brushed freehand strokes: a path shape with a `brush` keeps its path (selection, editing, eraser
 * hit-testing, grouping and export work as for any path) and is drawn with the paint engine's
 * dry brushstroke renderer instead of an SVG stroke. The renderer, the paint presets and the colour
 * parser live in a separate chunk, loaded the first time a brushed stroke is drawn, so canvases
 * without brushes never load the paint engine.
 */
import { brushstrokeScaleBucket } from '../paint/brushstroke-scale.js';
import { parseSvgPath, type PathShape, type ShapeDescription, type ShapeSize } from './shapeGeometry.js';
import type { Point } from './types.js';
import type { CanvasBrush, CanvasBrushPaint, CanvasBrushPreset, CanvasBrushstroke } from './brushTypes.js';

export type { CanvasBrush, CanvasBrushPaint, CanvasBrushPaintMapping, CanvasBrushPaintStop, CanvasBrushPreset, CanvasBrushSettings, CanvasBrushstroke } from './brushTypes.js';

export { brushstrokeScaleBucket };

/** A brushed stroke's image, placed in the path's coordinates (the shape's view box). */
export interface CanvasBrushstrokeImage {
	/** PNG data URL. */
	href: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Image pixels per path unit. */
	scale: number;
}

/** A path shape with a brush. */
export type BrushedPathShape = PathShape & { brush: CanvasBrushstroke };

/** Whether a shape is a brushed stroke. */
export function isBrushedShape(shape: ShapeDescription | null | undefined): shape is BrushedPathShape {
	return !!shape && shape.kind === 'path' && !!shape.brush && typeof shape.brush === 'object' && shape.brush.brush != null;
}

/**
 * The open polyline of a path's first subpath, in path coordinates: lines kept, curves sampled
 * every `step` units or so. Brushed strokes are drawn along it.
 */
export function pathDataToPolyline(d: string, step = 2): Point[] {
	const out: Point[] = [];
	let x = 0;
	let y = 0;
	let started = false;
	const push = (px: number, py: number) => {
		const last = out[out.length - 1];
		if (!last || last[0] !== px || last[1] !== py) out.push([px, py]);
	};
	for (const c of parseSvgPath(d)) {
		if (c.type === 'M') {
			if (started) break;
			started = true;
			x = c.x;
			y = c.y;
			push(x, y);
		} else if (c.type === 'Z') {
			if (out.length) push(out[0][0], out[0][1]);
			break;
		} else if (c.type === 'C' || c.type === 'Q') {
			const pts = c.type === 'C' ? [[x, y], [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]] : [[x, y], [c.x1, c.y1], [c.x, c.y]];
			let hull = 0;
			for (let i = 1; i < pts.length; i++) hull += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
			const n = Math.max(1, Math.min(256, Math.ceil(hull / Math.max(0.25, step))));
			for (let k = 1; k <= n; k++) {
				const t = k / n;
				const u = 1 - t;
				if (c.type === 'C') {
					push(
						u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
						u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y
					);
				} else {
					push(u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y);
				}
			}
			x = c.x;
			y = c.y;
		} else {
			// Lines, and arcs as their chords (freehand paths have none).
			x = c.x;
			y = c.y;
			push(x, y);
		}
	}
	return out;
}

/**
 * Resamples per-point values into `count` values spread evenly along the polyline's length (the
 * profile a brushed stroke stores). Values are rounded to three decimals.
 */
export function profileAlongPolyline(points: readonly Point[], values: readonly number[], count = 32): number[] {
	const n = Math.min(points.length, values.length);
	if (n === 0) return [];
	if (n === 1) return [round3(values[0])];
	const lengths = [0];
	for (let i = 1; i < n; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
	const total = lengths[n - 1];
	const m = Math.max(2, Math.min(count, n));
	const out: number[] = [];
	let j = 0;
	for (let k = 0; k < m; k++) {
		const at = total > 0 ? (total * k) / (m - 1) : 0;
		while (j < n - 2 && lengths[j + 1] < at) j++;
		const span = lengths[j + 1] - lengths[j];
		const f = span > 0 ? Math.min(1, Math.max(0, (at - lengths[j]) / span)) : 0;
		out.push(round3(values[j] + (values[j + 1] - values[j]) * f));
	}
	return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// The lazily loaded renderer
// ---------------------------------------------------------------------------

/** The renderer chunk (`./brushstrokeRender.ts`). */
export interface CanvasBrushstrokeRenderer {
	listCanvasBrushes(): CanvasBrushPreset[];
	/** Throws for an unknown or non-dry brush; the result is the paint engine's brush. */
	resolveCanvasBrush(brush: CanvasBrush, width: number): unknown;
	/** Throws for paint that is not a colour or gradient paint a canvas stroke can use; the result is the paint engine's `PaintSource`. */
	resolveCanvasPaint(paint: unknown): unknown;
	renderShapeBrushstrokeNow(shape: BrushedPathShape, scale: number): CanvasBrushstrokeImage | null;
	brushedShapeSvgNow(shape: BrushedPathShape, size: ShapeSize, scale: number): string;
}

let loading: Promise<CanvasBrushstrokeRenderer> | null = null;

/**
 * Loads the brushstroke renderer (the paint engine's dry brushes, the paint presets and a CSS
 * colour parser). Called for you by the functions below; call it early to warm up.
 */
export function loadCanvasBrushstrokeRenderer(): Promise<CanvasBrushstrokeRenderer> {
	loading ??= (import('./brushstrokeRender.js') as Promise<CanvasBrushstrokeRenderer>).catch((error) => {
		loading = null;
		throw error;
	});
	return loading;
}

/** The dry paint presets a freehand stroke can use (wet, mixer, blender, smudge and eraser presets are left out). */
export async function listCanvasBrushes(): Promise<CanvasBrushPreset[]> {
	return (await loadCanvasBrushstrokeRenderer()).listCanvasBrushes();
}

/**
 * Checks a brush: an unknown preset id, a wet (or other non-dry) preset, or settings that are not
 * an object throw an error saying which presets can be used.
 */
export async function validateCanvasBrush(brush: CanvasBrush): Promise<void> {
	(await loadCanvasBrushstrokeRenderer()).resolveCanvasBrush(brush, 1);
}

/**
 * Checks a brushed stroke's `paint` (a colour or gradient paint): bad stops, an unknown mapping,
 * or a mapping that needs timed samples (`velocity`, `time`) throw an error saying what to use.
 */
export async function validateCanvasBrushPaint(paint: CanvasBrushPaint): Promise<void> {
	(await loadCanvasBrushstrokeRenderer()).resolveCanvasPaint(paint);
}

export interface RenderShapeBrushstrokeOptions {
	/** Image pixels per path unit; pass `brushstrokeScaleBucket(zoom × node scale, devicePixelRatio)` (default 1). */
	scale?: number;
}

/**
 * Renders a brushed path shape to a cached PNG placed in path coordinates, or null for a shape
 * without a brush or an empty path. Throws for an unknown or non-dry brush.
 */
export async function renderShapeBrushstroke(shape: ShapeDescription, options: RenderShapeBrushstrokeOptions = {}): Promise<CanvasBrushstrokeImage | null> {
	if (!isBrushedShape(shape)) return null;
	return (await loadCanvasBrushstrokeRenderer()).renderShapeBrushstrokeNow(shape, options.scale ?? 1);
}

/**
 * The brushed stroke as a standalone SVG document of `size` (the node box), with the image
 * embedded as a PNG data URL: what an SVG export writes for the node. Shapes without a brush give
 * null (export them as paths).
 */
export async function getBrushedShapeSvg(shape: ShapeDescription, size: ShapeSize, options: RenderShapeBrushstrokeOptions = {}): Promise<string | null> {
	if (!isBrushedShape(shape)) return null;
	return (await loadCanvasBrushstrokeRenderer()).brushedShapeSvgNow(shape, size, options.scale ?? 2);
}
