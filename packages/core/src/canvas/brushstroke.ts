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
import type { CanvasBrush, CanvasBrushPaint, CanvasBrushPreset, CanvasBrushSpec, CanvasBrushstroke } from './brushTypes.js';
// Types only: the brush library is passed in, and the brush model loads with the renderer.
import type { BrushLibrary } from '../brushes/library.js';
import type { BrushPreviewRenderer } from '../brushes/tools.js';

export type { CanvasBrush, CanvasBrushPaint, CanvasBrushPaintMapping, CanvasBrushPaintStop, CanvasBrushPaper, CanvasBrushChoice, CanvasBrushPreset, CanvasBrushSettings, CanvasBrushSpec, CanvasBrushstroke } from './brushTypes.js';

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
	/** The presets, then the saved brushes given (facet brushes) the canvas profile admits. */
	listCanvasBrushes(user?: readonly unknown[]): CanvasBrushPreset[];
	/** Throws for an unknown brush or one the canvas profile refuses; the result is the paint engine's brush. */
	resolveCanvasBrush(brush: CanvasBrush, width: number | undefined, spec?: unknown): unknown;
	/** A saved brush checked against the canvas profile (throws with the reason and fix). */
	readCanvasBrushSpec(spec: unknown): unknown;
	/** Throws for paint that is not a colour or gradient paint a canvas stroke can use; the result is the paint engine's `PaintSource`. */
	resolveCanvasPaint(paint: unknown): unknown;
	renderShapeBrushstrokeNow(shape: BrushedPathShape, scale: number, place?: { origin?: { x: number; y: number }; unit?: number }): CanvasBrushstrokeImage | null;
	brushSwatchNow(brush: CanvasBrush, options: CanvasBrushSwatchOptions, spec?: CanvasBrushSpec): string;
	brushedShapeSvgNow(shape: BrushedPathShape, size: ShapeSize, scale: number, place?: { origin?: { x: number; y: number }; unit?: number }): string;
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

/**
 * The brushes a freehand stroke can use: the presets `CANVAS_PROFILE` admits (dry dab brushes; wet,
 * mixer, blender, smudge, eraser and light presets are left out), then the saved brushes of
 * `library` it admits.
 */
export async function listCanvasBrushes(library?: Pick<BrushLibrary, 'list'>): Promise<CanvasBrushPreset[]> {
	const user = library ? (await library.list({ source: 'user' })).map((e) => e.brush) : [];
	return (await loadCanvasBrushstrokeRenderer()).listCanvasBrushes(user);
}

/**
 * The saved brush a stroke should embed for `brush`: the library's brush when `brush` names a saved
 * one (checked against the canvas profile), else undefined (a preset or tip settings). Throws
 * saying why a saved brush can't brush a stroke.
 */
export async function resolveCanvasBrushSpec(brush: CanvasBrush, library?: Pick<BrushLibrary, 'get' | 'isBuiltin'>): Promise<CanvasBrushSpec | undefined> {
	if (typeof brush !== 'string' || !library || library.isBuiltin(brush)) return undefined;
	const entry = await library.get(brush);
	if (!entry) return undefined;
	(await loadCanvasBrushstrokeRenderer()).readCanvasBrushSpec(entry.brush);
	return entry.brush as unknown as CanvasBrushSpec;
}

/**
 * Checks a brush: an unknown id, a brush the canvas profile refuses (wet, a tool, light…), or
 * settings that are not an object throw an error saying why and which brushes can be used.
 * `spec` is the saved brush `brush` names (`resolveCanvasBrushSpec`).
 */
export async function validateCanvasBrush(brush: CanvasBrush, spec?: CanvasBrushSpec): Promise<void> {
	(await loadCanvasBrushstrokeRenderer()).resolveCanvasBrush(brush, 1, spec);
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
	/**
	 * Where the path's (0, 0) is on the canvas, and canvas units per path unit (the node's
	 * absolute position and width ÷ view box width). The paper grain is sampled there, so
	 * neighbouring strokes share one sheet of paper. Default 0, 0 and 1.
	 */
	origin?: { x: number; y: number };
	unit?: number;
}

/** A stable character seed for a stroke (FNV-1a of its id). */
export function brushstrokeSeed(id: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Renders a brushed path shape to a cached PNG placed in path coordinates, or null for a shape
 * without a brush or an empty path. Throws for an unknown or non-dry brush.
 */
export async function renderShapeBrushstroke(shape: ShapeDescription, options: RenderShapeBrushstrokeOptions = {}): Promise<CanvasBrushstrokeImage | null> {
	if (!isBrushedShape(shape)) return null;
	return (await loadCanvasBrushstrokeRenderer()).renderShapeBrushstrokeNow(shape, options.scale ?? 1, options);
}

/**
 * The brushed stroke as a standalone SVG document of `size` (the node box), with the image
 * embedded as a PNG data URL: what an SVG export writes for the node. Shapes without a brush give
 * null (export them as paths).
 */
export async function getBrushedShapeSvg(shape: ShapeDescription, size: ShapeSize, options: RenderShapeBrushstrokeOptions = {}): Promise<string | null> {
	if (!isBrushedShape(shape)) return null;
	return (await loadCanvasBrushstrokeRenderer()).brushedShapeSvgNow(shape, size, options.scale ?? 2, options);
}

export interface CanvasBrushSwatchOptions {
	/** Swatch size in pixels (default 96 × 24). */
	width?: number;
	height?: number;
	/** CSS colour (default: each brush's preview colour for `background`, else `#1f2937`). */
	color?: string;
	/**
	 * What the swatch is shown on (#rrggbb; swatches are transparent): without a `color`, each
	 * brush gets a colour that reads on it (`brushPreviewColours`, its own default when it has one).
	 */
	background?: string;
	/** Image pixels per swatch pixel (default 2, for sharp swatches on high-density screens). */
	scale?: number;
}

/**
 * A preview of a brush for a brush menu: a short wavy stroke with the brush's character (jitter
 * and grain), its size capped to fit, as a PNG data URL ('' when nothing renders). Throws for an
 * unknown or non-dry brush.
 */
export async function renderCanvasBrushSwatch(brush: CanvasBrush, options: CanvasBrushSwatchOptions = {}, spec?: CanvasBrushSpec): Promise<string> {
	return (await loadCanvasBrushstrokeRenderer()).brushSwatchNow(brush, options, spec);
}

/**
 * `preview_brush` for brushed strokes (canvas and vector): the brush library tools' renderer
 * (`createBrushLibraryToolProvider(library, { profile: CANVAS_PROFILE, renderPreview: renderCanvasBrushPreview })`),
 * a swatch of the brush as a canvas stroke paints it. Loads the renderer on first use.
 */
export const renderCanvasBrushPreview: BrushPreviewRenderer = async (brush, { width, height, color }) => {
	// Vector brushstrokes paint light brushes as plain colour: preview them so (canvas strokes refuse light).
	const { light: _light, ...plain } = brush;
	const url = await renderCanvasBrushSwatch(brush.id, { width, height, color, scale: 1 }, plain as unknown as CanvasBrushSpec);
	return { data: url.replace(/^data:image\/png;base64,/, ''), mimeType: 'image/png' };
};
