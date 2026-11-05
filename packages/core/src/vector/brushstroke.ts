/**
 * Brushstrokes on vector paths: a stroke layer of kind `brushstroke` paints the path with a
 * natural-media brush from the paint editor's library (pencil, pastel, charcoal, ink, marker,
 * watercolour, oils, the Mixer Brush, smudge, blender…) instead of a geometric line. The path
 * stays the data; the pixels are a cache. Each subpath is flattened into samples and rendered,
 * then drawn as an image over the path's bounds. A pressure profile along the length shapes it
 * like a pen stroke. A layer with a `seed` also gets the brush's character (seeded jitter and
 * paper grain, `renderBrushstroke`'s `character` option); one without renders exactly as it
 * always has.
 *
 * - **Dry brushes** (dab engine) render through the shared renderer (`renderBrushstroke` through a
 *   `BrushstrokeCache`, the same one the canvas uses for brushed strokes).
 * - **Wet paint brushes** (watercolour, gouache, wet oils) run the wet simulation in their own small
 *   area and dry (`brushstrokeMedia.ts`). Settling takes a while, so the scene shows the paint as
 *   laid and swaps in the settled image when it is ready (`onVectorBrushstrokesSettled`); exports
 *   and `settleVectorBrushstrokes` wait for it.
 * - **The Mixer Brush, smudge and blender** act on what lies beneath the stroke: the shapes below it
 *   and the path's own fills and lower strokes, drawn into a local backdrop (`backdrop.ts`). They
 *   re-render when anything beneath them changes.
 * - **Paint**: the layer's colour, or gradient paint sampled dab by dab along the path: the layer's
 *   `brush.paint` (by distance, pressure, tilt, direction, across the tip or at random), else a
 *   gradient layer paint (`along` the path, `across` the tip, or `within`: the gradient laid over
 *   the stroke in the path's space), else the brush's own gradient (multi-colour brushes).
 *
 * The brushes are the ones `VECTOR_PROFILE` admits: presets or saved brushes from a brush library.
 * A saved brush is embedded in the layer (`spec`), so the document renders without the library.
 * Images are rendered at `VECTOR_BRUSHSTROKE_SCALE` pixels per unit, the same at every zoom.
 */
import { BrushstrokeCache, brushstrokeDataUrl, isBrushstrokeBrush, type BrushstrokeImage, type BrushstrokeInput } from '../paint/brushstroke.js';
import { GRAIN_PATTERNS, type GrainPattern } from '../paint/grain.js';
import { parsePaintSource, readPaintSource, type PaintGradientSource, type PaintSource } from '../paint/gradient-paint.js';
import { BUILTIN_BRUSHES, type PaintBrush } from '../paint-editor/brushes.js';
import { brushColourHex } from '../brushes/colour.js';
import { closest } from '../brushes/library.js';
import { normalizeBrushSpec } from '../brushes/normalize.js';
import { BRUSH_PRESETS } from '../brushes/presets.js';
import { checkBrush, listPresets, VECTOR_PROFILE } from '../brushes/profiles.js';
import { resolveBrush } from '../brushes/resolve.js';
import type { Brush } from '../brushes/types.js';
import { bezierPathBounds as pathBounds, closeContour, flattenChain, pathToContours } from '../canvas/pathops/bezier.js';
import { isVectorGradient, parseVectorColor, sortedVectorGradientStops, vectorGradientRamp, vectorGradientTAt } from './gradient.js';
import { subpathsToBezier } from './geometry.js';
import { vectorPaintSolid } from './extrude.js';
import { renderBackdropBrushstroke, usesVectorBackdrop, vectorMediaEngine, WetBrushstrokeJob, type VectorBrushstrokeBackdrop } from './brushstrokeMedia.js';
import type { VectorBounds, VectorBrushstroke, VectorBrushstrokePaint, VectorBrushstrokePaper, VectorDocument, VectorGradient, VectorPathNode, VectorStrokeLayer } from './types.js';

/** Image pixels per document unit brushstrokes are rendered at. */
export const VECTOR_BRUSHSTROKE_SCALE = 2;

const PRESETS: readonly PaintBrush[] = listPresets(VECTOR_PROFILE).map((spec) => BUILTIN_BRUSHES.find((b) => b.id === spec.id)!);

/** A saved brush the vector profile admits, normalised, or null. */
function admitted(spec: unknown): Brush | null {
	try {
		const brush = normalizeBrushSpec(spec);
		return checkBrush(brush, VECTOR_PROFILE).ok && isVectorBrushstrokeEngine(resolveBrush(brush)) ? brush : null;
	} catch {
		return null;
	}
}

/** Whether a brush's engine paints vector brushstrokes: dry dab brushes, wet paint, the Mixer Brush, smudge and blender. */
export function isVectorBrushstrokeEngine(brush: PaintBrush): boolean {
	return (brush.engine === 'dab' && isBrushstrokeBrush(brush)) || vectorMediaEngine(brush) !== null;
}

/**
 * The brushes a brushstroke can use, as the engine paints them: the presets `VECTOR_PROFILE`
 * admits (dry, wet paint, mixer, smudge and blender brushes), then the saved brushes given (facet brushes, e.g. a brush
 * library's) it admits.
 */
export function vectorBrushstrokeBrushes(user: readonly Brush[] = []): PaintBrush[] {
	const out = [...PRESETS];
	for (const raw of user) {
		const brush = admitted(raw);
		if (brush && !out.some((b) => b.id === brush.id)) out.push(resolveBrush(brush));
	}
	return out;
}

/** A preset by id, or null. */
export function vectorBrushstrokeBrush(id: string): PaintBrush | null {
	return PRESETS.find((b) => b.id === id) ?? null;
}

/** The engine brush a brushstroke paints with: its embedded saved brush, else the preset; null when neither renders. */
export function vectorBrushstrokeBrushOf(brush: Pick<VectorBrushstroke, 'brushId' | 'spec'>): PaintBrush | null {
	if (brush.spec) {
		const saved = admitted(brush.spec);
		return saved && saved.id === brush.brushId ? resolveBrush(saved) : null;
	}
	return vectorBrushstrokeBrush(brush.brushId);
}

/**
 * Why a brush id can't paint a brushstroke (with the ids that can), or null when it can.
 * `user` are the saved brushes on offer.
 */
export function vectorBrushstrokeBrushError(id: string, user: readonly Brush[] = []): string | null {
	if (vectorBrushstrokeBrush(id)) return null;
	const saved = user.find((b) => b.id === id);
	const ids = vectorBrushstrokeBrushes(user).map((b) => b.id);
	const reasons = (b: Brush) =>
		checkBrush(b, VECTOR_PROFILE)
			.issues.filter((i) => i.severity === 'error')
			.map((i) => `${i.reason} ${i.fix}`)
			.join(' ') || 'its engine does not paint brushstrokes.';
	if (saved) return admitted(saved) ? null : `Brush "${id}" (${saved.name}) can't paint a brushstroke: ${reasons(saved)} Use one of: ${ids.join(', ')}.`;
	const preset = BRUSH_PRESETS.find((b) => b.id === id);
	if (preset) return `Brush "${id}" (${preset.name}) can't paint a brushstroke: ${reasons(preset)} Use one of: ${ids.join(', ')}.`;
	return `Unknown brush "${id}". ${closest(id, ids)}Use one of: ${ids.join(', ')} (vector.listBrushes lists them).`;
}

/**
 * The default colour of brush `id` (a preset, else a saved brush of `user`) as a hex colour for
 * `scheme`: a solid default, or the side of a light / dark pair; null when it has none (it paints
 * in the colour it is given).
 */
export function vectorBrushstrokeDefaultColour(id: string, user: readonly Brush[] = [], scheme: 'light' | 'dark' = 'light'): string | null {
	const brush = BRUSH_PRESETS.find((b) => b.id === id) ?? user.find((b) => b.id === id);
	return brush ? brushColourHex(brush.colour?.default, scheme) : null;
}

/**
 * Reads brushstroke settings from untrusted data; null when the brush is unknown. A saved brush is
 * taken from `value.spec` (a stored layer) or from `user` (the brush library's saved brushes) and
 * kept in `spec`.
 */
export function sanitizeVectorBrushstroke(value: unknown, user: readonly Brush[] = []): VectorBrushstroke | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	if (typeof r.brushId !== 'string') return null;
	const out: VectorBrushstroke = { brushId: r.brushId };
	if (!vectorBrushstrokeBrush(r.brushId)) {
		const spec = admitted(r.spec ?? user.find((b) => b.id === r.brushId));
		if (!spec || spec.id !== r.brushId) return null;
		out.spec = spec;
	}
	if (typeof r.size === 'number' && Number.isFinite(r.size) && r.size > 0) out.size = Math.min(500, r.size);
	if (Array.isArray(r.pressure)) {
		const p = r.pressure.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).map((v) => Math.min(1, Math.max(0, v)));
		if (p.length) out.pressure = p.slice(0, 64);
	}
	const seed = sanitizeSeed(r.seed);
	if (seed !== undefined) out.seed = seed;
	const paint = readVectorBrushstrokePaint(r.paint);
	if (paint) out.paint = paint;
	if (r.paper === null) out.paper = null;
	else {
		const paper = sanitizeVectorBrushstrokePaper(r.paper);
		if (paper) out.paper = paper;
	}
	return out;
}

/** Mappings that need timed samples, which vector paths don't have. */
const TIMED_MAPPINGS = ['velocity', 'time'];

/**
 * What is wrong with a brushstroke's gradient `paint` (from an agent or a caller), or null when it
 * is valid. Paint is `{ type: 'color', color }` or `{ type: 'gradient', stops, space, map, softness }`
 * (the paint engine's `PaintSource`, lengths in document units). `velocity` and `time` mappings
 * are refused: a vector path has no timing.
 */
export function vectorBrushstrokePaintError(paint: unknown): string | null {
	let source: PaintSource;
	try {
		source = parsePaintSource(paint, 'paint');
	} catch (e) {
		return (e as Error).message;
	}
	if (source.type === 'gradient' && TIMED_MAPPINGS.includes(source.map.by)) return `paint.map.by "${source.map.by}" needs timed samples, which vector paths do not have; use distance, pressure, tilt, direction, across-tip or random.`;
	return null;
}

/** Reads brushstroke paint from untrusted data (a stored layer); null when it is not valid paint. */
export function readVectorBrushstrokePaint(value: unknown): VectorBrushstrokePaint | null {
	if (value === undefined || value === null || vectorBrushstrokePaintError(value)) return null;
	return readPaintSource(value) as VectorBrushstrokePaint | null;
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
	return layer.kind === 'brushstroke' && !!layer.brush && !!vectorBrushstrokeBrushOf(layer.brush);
}

/** How far a brushstroke layer reaches past the path (half its brush size). */
export function vectorBrushstrokeReach(layer: VectorStrokeLayer): number {
	if (!isVectorBrushstrokeLayer(layer)) return 0;
	return (layer.brush.size ?? vectorBrushstrokeBrushOf(layer.brush)!.tip.size) / 2;
}


/** One rendered piece of a brushstroke: a PNG data URL drawn stretched over `x, y, width, height` (path units). */
export interface VectorBrushstrokeImage {
	href: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Where and how a brushstroke renders. */
export interface VectorBrushstrokeContext {
	/**
	 * The document the path is in. A Mixer Brush, smudge or blender acts on what lies beneath the
	 * stroke there; without it, only on the path's own fills and lower strokes.
	 */
	document?: VectorDocument | null;
	/**
	 * `async` (default): a wet brushstroke shows the paint as laid until its simulation has settled
	 * (`onVectorBrushstrokesSettled` says when). `now`: settle it first (exports, agents).
	 */
	settle?: 'async' | 'now';
}

/**
 * What lies beneath stroke layer `index` of `node`: the objects it depends on (compared by
 * identity: any change beneath gives a new one), and the backdrop renderer. The scene renderer
 * registers it (`setVectorBackdropSource`), as it is the one that can draw the scene.
 */
export type VectorBackdropSource = (document: VectorDocument | null, node: VectorPathNode, index: number, settle: 'async' | 'now') => { deps: readonly unknown[]; backdrop: VectorBrushstrokeBackdrop };

let backdropSource: VectorBackdropSource | null = null;

/** Registers what draws the backdrop of mixer, smudge and blender brushstrokes (done by `render.ts`). */
export function setVectorBackdropSource(source: VectorBackdropSource | null): void {
	backdropSource = source;
}

type Rgba = [number, number, number, number];

/** What a contour of a brushstroke is painted with. */
interface StrokePaint {
	color: Rgba;
	paint: PaintSource | null;
	/** A `within` gradient: laid over the finished stroke in the path's space. */
	within: { gradient: VectorGradient; bounds: VectorBounds | null } | null;
}

const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** A vector gradient's colours as gradient paint with mapping `map` (up to 16 stops; smooth or oklab ramps sampled). */
function gradientPaint(g: VectorGradient, map: PaintGradientSource['map']): PaintGradientSource {
	const stops = sortedVectorGradientStops(g);
	const exact = stops.length >= 2 && stops.length <= 16 && !g.smoothness && (g.interpolation ?? 'srgb') === 'srgb' && stops.every((s) => parseVectorColor(s.color));
	if (exact) {
		return {
			type: 'gradient',
			space: 'srgb',
			map,
			stops: stops.map((s) => {
				const c = parseVectorColor(s.color)!;
				const opacity = Math.min(1, Math.max(0, (s.opacity ?? 1) * c[3]));
				const midpoint = s.midpoint !== undefined && s.midpoint !== 0.5 ? Math.min(0.95, Math.max(0.05, s.midpoint)) : undefined;
				return { offset: Math.min(1, Math.max(0, s.offset)), color: `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`, ...(opacity < 1 ? { opacity } : {}), ...(midpoint !== undefined ? { midpoint } : {}) };
			}),
		};
	}
	const ramp = vectorGradientRamp(g);
	const n = 16;
	return {
		type: 'gradient',
		space: 'srgb',
		map,
		stops: Array.from({ length: n }, (_, i) => {
			const t = i / (n - 1);
			const c = ramp ? ramp.sample(t) : ([0, 0, 0, 1] as const);
			return { offset: t, color: `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`, ...(c[3] < 1 ? { opacity: Math.max(0, c[3]) } : {}) };
		}),
	};
}

const REPEAT = { pad: 'clamp', repeat: 'repeat', reflect: 'mirror' } as const;

/** The paint of one contour (`length` in path units) of a brushstroke layer. */
function strokePaintOf(node: VectorPathNode, layer: VectorStrokeLayer & { brush: VectorBrushstroke }, brush: PaintBrush, length: number): StrokePaint {
	const engine = vectorMediaEngine(brush);
	// The smudge and blender move paint that is there; they lay none of their own.
	if (engine === 'smudge' || engine === 'blender') return { color: [0, 0, 0, 255], paint: null, within: null };
	const solid = vectorPaintSolid(layer.paint) ?? '#000000';
	const c = parseVectorColor(solid) ?? [0, 0, 0, 1];
	const color = [c[0] * 255, c[1] * 255, c[2] * 255, c[3] * 255].map(Math.round) as Rgba;
	if (layer.brush.paint) return { color, paint: layer.brush.paint as PaintSource, within: null };
	const g = layer.paint;
	if (isVectorGradient(g) && g.stops?.length) {
		const mode = g.strokeMode ?? 'within';
		if (mode === 'along') return { color: [color[0], color[1], color[2], 255], paint: gradientPaint(g, { by: 'distance', length: Math.max(1, length), repeat: REPEAT[g.spread ?? 'pad'], unit: 'px' }), within: null };
		if (mode === 'across') return { color: [color[0], color[1], color[2], 255], paint: gradientPaint(g, { by: 'across-tip' }), within: null };
		// A Mixer Brush mixes its paint with what it picks up, so a gradient laid over the result would tint that too: run it along the path.
		if (engine === 'mixer') return { color: [color[0], color[1], color[2], 255], paint: gradientPaint(g, { by: 'distance', length: Math.max(1, length), repeat: REPEAT[g.spread ?? 'pad'] }), within: null };
		const b = pathBounds(subpathsToBezier(node.subpaths));
		return { color: [255, 255, 255, 255], paint: null, within: { gradient: g, bounds: b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY } : null } };
	}
	// The brush's own gradient (gradient presets, multi-colour brushes): `paint` stops are the layer colour.
	if (brush.paint && !TIMED_MAPPINGS.includes(brush.paint.map.by)) return { color, paint: brush.paint, within: null };
	return { color, paint: null, within: null };
}

/**
 * The stroke with a `within` gradient laid over it: each pixel's colour is multiplied by the
 * gradient's there (the stroke is painted white, so dry dabs take the gradient's colour exactly and
 * wet paint keeps its shading), its opacity by the gradient's.
 */
function recoloured(stroke: BrushstrokeImage, within: NonNullable<StrokePaint['within']>): BrushstrokeImage {
	if (!stroke.bounds) return stroke;
	const ramp = vectorGradientRamp(within.gradient);
	if (!ramp) return stroke;
	const lut = Array.from({ length: 256 }, (_, i) => ramp.sample(i / 255));
	const { width, height, data } = stroke.image;
	const out = new Uint8ClampedArray(data);
	const { x: bx, y: by } = stroke.bounds;
	const s = stroke.scale;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			if (!out[i + 3]) continue;
			const t = vectorGradientTAt(within.gradient, within.bounds, { x: bx + (x + 0.5) / s, y: by + (y + 0.5) / s });
			const col = lut[Math.round(Math.min(1, Math.max(0, t)) * 255)];
			out[i] = Math.round(out[i] * col[0]);
			out[i + 1] = Math.round(out[i + 1] * col[1]);
			out[i + 2] = Math.round(out[i + 2] * col[2]);
			out[i + 3] = Math.round(out[i + 3] * col[3]);
		}
	}
	return { ...stroke, image: { width, height, data: out } };
}

/** FNV-1a over a string. */
function hash(s: string, h = 0x811c9dc5): number {
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** FNV-1a over bytes. */
function hashBytes(b: Uint8ClampedArray, h = 0x811c9dc5): number {
	for (let i = 0; i < b.length; i++) {
		h ^= b[i];
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** A cache key for a media brushstroke: path, whole brush, paint and scale. */
function mediaKey(input: BrushstrokeInput, brush: PaintBrush, options: object): string {
	const path = JSON.stringify(input);
	return `${hash(path).toString(16)}:${path.length}:${hash(JSON.stringify([brush, options])).toString(16)}`;
}

/** A small least-recently-used map. */
class Lru<V> {
	private readonly map = new Map<string, V>();
	constructor(private readonly capacity: number) {}
	get(key: string): V | undefined {
		const v = this.map.get(key);
		if (v !== undefined) {
			this.map.delete(key);
			this.map.set(key, v);
		}
		return v;
	}
	has(key: string): boolean {
		return this.map.has(key);
	}
	set(key: string, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value as string);
	}
}

// --- Wet brushstrokes settle in the background ----------------------------------

/** How long one slice of wet simulation runs before giving the page back (ms). */
const WET_SLICE_MS = 12;

const wetSettled = new Lru<BrushstrokeImage>(128);
const wetInstant = new Map<string, BrushstrokeImage>();
const wetJobs = new Map<string, WetBrushstrokeJob>();
const settleListeners = new Set<() => void>();
let wetTimer: ReturnType<typeof setTimeout> | null = null;

/** Counts wet strokes settled: what lies beneath a backdrop stroke may have changed with each. */
let wetGeneration = 0;

function wetFinished(key: string, job: WetBrushstrokeJob): void {
	wetGeneration++;
	wetSettled.set(key, job.image());
	wetJobs.delete(key);
	wetInstant.delete(key);
}

function notifySettled(): void {
	for (const fn of [...settleListeners]) fn();
}

function scheduleWet(): void {
	if (wetTimer || !wetJobs.size) return;
	wetTimer = setTimeout(() => {
		wetTimer = null;
		const first = wetJobs.entries().next().value as [string, WetBrushstrokeJob] | undefined;
		if (first && first[1].run(WET_SLICE_MS)) {
			wetFinished(first[0], first[1]);
			notifySettled();
		}
		scheduleWet();
	}, 0);
}

/**
 * Calls `listener` whenever a wet brushstroke has settled, so its final image replaces the one
 * shown while it settled. Re-render the scene then (the controller does: it notifies its
 * subscribers). Returns the unsubscribe function.
 */
export function onVectorBrushstrokesSettled(listener: () => void): () => void {
	settleListeners.add(listener);
	return () => settleListeners.delete(listener);
}

/** How many wet brushstrokes are still settling. */
export function vectorBrushstrokesSettling(): number {
	return wetJobs.size;
}

/** Settles every wet brushstroke still settling, now (slow for many long strokes). Returns how many there were. */
export function settleVectorBrushstrokes(): number {
	const n = wetJobs.size;
	if (!n) return 0;
	for (const [key, job] of [...wetJobs]) {
		job.run();
		wetFinished(key, job);
	}
	notifySettled();
	return n;
}

/** A wet stroke's image: settled when it is, else as laid (and queued to settle), or settled now. */
function wetImage(input: BrushstrokeInput, brush: PaintBrush, options: ConstructorParameters<typeof WetBrushstrokeJob>[2], settle: 'async' | 'now', pending: string[]): BrushstrokeImage {
	const key = mediaKey(input, brush, options);
	const done = wetSettled.get(key);
	if (done) return done;
	let job = wetJobs.get(key);
	if (settle === 'now') {
		job ??= new WetBrushstrokeJob(input, brush, options);
		job.run();
		wetFinished(key, job);
		return wetSettled.get(key)!;
	}
	if (!job) {
		job = new WetBrushstrokeJob(input, brush, options);
		wetJobs.set(key, job);
		wetInstant.set(key, job.image());
		scheduleWet();
	}
	pending.push(key);
	return wetInstant.get(key) ?? job.image();
}

// --- Rendering --------------------------------------------------------------------

const cache = new BrushstrokeCache(256);
const backdropResults = new Lru<BrushstrokeImage>(64);
const urls = new WeakMap<BrushstrokeImage, string>();

interface LayerEntry {
	images: VectorBrushstrokeImage[];
	/** What lies beneath (backdrop strokes), compared by identity. */
	deps: readonly unknown[] | null;
	/** Wet strokes still settling. */
	pending: string[];
	/** Rendered with wet strokes (its own, or beneath it) settled. */
	settled: boolean;
}

const layerCache = new WeakMap<VectorPathNode, Map<VectorStrokeLayer, LayerEntry>>();

const sameDeps = (a: readonly unknown[] | null, b: readonly unknown[] | null) => a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));

/**
 * The images of a brushstroke layer on a path, one per subpath, in the path's own space. Cached
 * per path and layer object, by the shared renderer's cache (whose key includes the seed and
 * paper), and for mixer, smudge and blender strokes by what lies beneath them. A layer with a
 * seed renders with the brush's character, the grain laid in the path's own space (paper point =
 * path point). See `VectorBrushstrokeContext` for wet strokes and backdrops.
 */
export function vectorBrushstrokeImages(node: VectorPathNode, layer: VectorStrokeLayer, context: VectorBrushstrokeContext = {}): VectorBrushstrokeImage[] {
	if (!isVectorBrushstrokeLayer(layer)) return [];
	const preset = vectorBrushstrokeBrushOf(layer.brush)!;
	const engine = vectorMediaEngine(preset);
	const settle = context.settle ?? 'async';
	const document = context.document ?? null;
	const index = (node.strokes ?? []).indexOf(layer);
	const source = usesVectorBackdrop(engine) && backdropSource ? backdropSource(document, node, Math.max(0, index), settle) : null;
	const deps = source ? [...source.deps, wetGeneration] : null;
	let byLayer = layerCache.get(node);
	const hit = byLayer?.get(layer);
	const stale = hit && ((hit.pending.length && hit.pending.some((k) => wetSettled.has(k))) || (settle === 'now' && !hit.settled));
	if (hit && sameDeps(hit.deps, deps) && !stale) return hit.images;

	const brush = layer.brush.size ? { ...preset, tip: { ...preset.tip, size: layer.brush.size } } : preset;
	const { seed, paper } = layer.brush;
	const character = seed !== undefined ? { character: { seed, origin: { x: 0, y: 0 }, unit: 1, ...(paper !== undefined ? { paper } : {}) } } : {};
	const out: VectorBrushstrokeImage[] = [];
	const pending: string[] = [];
	for (const sp of node.subpaths) {
		if (sp.anchors.length < 2) continue;
		for (const contour of pathToContours(subpathsToBezier([sp]))) {
			const ring = flattenChain(closeContour(contour, contour.closed), 0.25);
			if (contour.closed && ring.length > 2) ring.push(ring[0]);
			if (ring.length < 2) continue;
			let length = 0;
			for (let i = 1; i < ring.length; i++) length += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
			const input: BrushstrokeInput = { points: ring.map(([x, y]) => ({ x, y })), ...(layer.brush.pressure ? { pressure: layer.brush.pressure } : {}) };
			const sp2 = strokePaintOf(node, layer, brush, length);
			const options = { scale: VECTOR_BRUSHSTROKE_SCALE, color: sp2.color, paint: sp2.paint, seed: seed ?? 0, maxPixels: 2048 * 2048 };
			let stroke: BrushstrokeImage;
			// The wet simulation's cost grows with the tiles the paint covers: a smaller cap keeps a long wet stroke to seconds.
			if (engine === 'wet') stroke = wetImage(input, brush, { ...options, maxPixels: 1024 * 1024 }, settle, pending);
			else if (engine) {
				const key = mediaKey(input, brush, options);
				// The backdrop's bytes key the result, so an unchanged backdrop reuses it.
				stroke = renderBackdropBrushstroke(input, brush, {
					...options,
					backdrop: source?.backdrop ?? null,
					cache: (bytes) => {
						const k = `${key}:${hashBytes(bytes).toString(16)}`;
						return { get: () => backdropResults.get(k), set: (img) => backdropResults.set(k, img) };
					},
				});
			} else {
				const { paint, ...rest } = options;
				stroke = cache.render(input, brush, { ...rest, ...(paint ? { paint } : {}), ...character });
			}
			if (sp2.within) stroke = recoloured(stroke, sp2.within);
			if (!stroke.bounds) continue;
			let href = urls.get(stroke);
			if (!href) urls.set(stroke, (href = brushstrokeDataUrl(stroke)));
			out.push({ href, ...stroke.bounds });
		}
	}
	if (!byLayer) layerCache.set(node, (byLayer = new Map()));
	byLayer.set(layer, { images: out, deps, pending, settled: settle === 'now' || (!pending.length && !deps) });
	return out;
}
