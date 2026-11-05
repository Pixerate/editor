/**
 * Brushstrokes on vector paths with media that need more than an empty image (#519): wet paint, and
 * the Mixer Brush, smudge and blender, which act on the paint under them. The path stays the data
 * and the pixels a cache, as for dry brushstrokes (`renderBrushstroke`).
 *
 * - **Wet** (`engine: 'wet'`, wet paint brushes: watercolour, gouache, wet oils): the stroke gets its
 *   own small `WetWorld` over its bounds, the paint editor's `WetStrokeDriver` lays it, the
 *   simulation runs `VECTOR_WET_STEPS` steps (time is counted in steps, never wall time) and the
 *   paint is dried where it is. The bytes depend only on the path, brush, colour and seed. The
 *   simulation costs about 9 ms per 256 px tile per step on the TypeScript kernel, so
 *   `WetBrushstrokeJob` can run it in slices: hosts show the bake of the paint as laid (step 0) at
 *   once, and swap in the settled image when it is done.
 * - **Backdrop media** (`mixer`, `smudge`, `blender`): the stroke runs the paint editor's dab-by-dab
 *   engine (`PaintDabStroke`) over a local copy of what lies beneath it (the backdrop, rendered by
 *   the caller), and keeps only the pixels it changed. Drawn over the content it was made from,
 *   that is the stroke's result. A smudge can drag paint over bare paper, but it can't take paint
 *   away from the content underneath (the image is drawn over it).
 *
 * Coordinates: like `renderBrushstroke`, inputs are in path units, rendered at `scale` image pixels
 * per unit, and the result's `bounds` place the image back in path units.
 */
import { brushstrokeSamples, type BrushstrokeImage, type BrushstrokeInput } from '../paint/brushstroke.js';
import { BRUSHSTROKE_MAX_SCALE as MAX_SCALE, BRUSHSTROKE_MIN_SCALE as MIN_SCALE } from '../paint/brushstroke-scale.js';
import { EMPTY_MIXER_LOAD, type PaintTileTarget, type RgbTriple } from '../paint/exchange.js';
import { resolvePaintGradient, scalePaintGradient, type PaintSource } from '../paint/gradient-paint.js';
import { loadMixer } from '../paint/mixer.js';
import { WetWorld } from '../paint/wet/world.js';
import { PaintDabStroke } from '../paint-editor/dab-stroke.js';
import type { PaintBrush } from '../paint-editor/brushes.js';
import type { PenPoint } from '../paint-editor/engine.js';
import { DEFAULT_PAPER } from '../paint-editor/paper.js';
import { WET_MEDIUM_PARAMS, WetStrokeDriver, wetPaperInput } from '../paint-editor/wet.js';
import { emptySurface, readRegion, tileKey, writeRegion, TiledSurface, TILE, type RasterRect, type TileKey } from '../raster/surface.js';

/** Simulation steps a wet brushstroke runs before it is dried (enough to bleed, bloom and granulate). */
export const VECTOR_WET_STEPS = 120;

/** Engines a vector brushstroke paints through this module. */
export type VectorMediaEngine = 'wet' | 'mixer' | 'smudge' | 'blender';

/** Whether a brush paints through this module (and which way), or null for a dry dab brush. */
export function vectorMediaEngine(brush: Pick<PaintBrush, 'engine' | 'wet'>): VectorMediaEngine | null {
	if (brush.engine === 'wet') return brush.wet.tool === 'paint' ? 'wet' : null;
	return brush.engine === 'mixer' || brush.engine === 'smudge' || brush.engine === 'blender' ? brush.engine : null;
}

/** Whether a media engine acts on the paint beneath the stroke (and needs a backdrop). */
export const usesVectorBackdrop = (engine: VectorMediaEngine | null): boolean => engine === 'mixer' || engine === 'smudge' || engine === 'blender';

export interface VectorMediaOptions {
	/** Image pixels per path unit (default 1). */
	scale?: number;
	/** RGBA 0..255 of the paint (the alpha scales the result). */
	color: readonly [number, number, number, number];
	/** Gradient paint sampled dab by dab (lengths in path units), or null for `color`. */
	paint?: PaintSource | null;
	/** Jitter seed (default 0). */
	seed?: number;
	closed?: boolean;
	/** The largest image to render, in pixels (default 4096²); a bigger stroke renders at a lower scale. */
	maxPixels?: number;
}

/** Where a stroke renders: its samples in image pixels relative to `rect`, the brush at that scale. */
interface Placed {
	points: PenPoint[];
	brush: PaintBrush;
	/** Image pixels of the area, absolute (path units × scale). */
	rect: RasterRect;
	scale: number;
	color: RgbTriple;
	alpha: number;
	paint: import('../paint/gradient-paint.js').PaintGradientSource | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The stroke placed in image pixels: samples scaled and moved so the area starts at 0, the brush at
 * that scale without smoothing (the path is exact data), the area padded by the tip's reach.
 */
function place(input: BrushstrokeInput, brush: PaintBrush, options: VectorMediaOptions, pad = 0): Placed | null {
	const samples = brushstrokeSamples(input);
	if (!samples.length) return null;
	for (const s of samples) if (!finite(s.x) || !finite(s.y)) throw new Error('Brushstroke samples need finite x and y.');
	let scale = finite(options.scale) && options.scale > 0 ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, options.scale)) : 1;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const s of samples) {
		x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y);
	}
	const reach = brush.tip.size * (1 + 1.5 * brush.dynamics.tiltSize) / 2 + 2 + pad;
	const maxPixels = finite(options.maxPixels) && options.maxPixels > 0 ? options.maxPixels : 4096 * 4096;
	const area = (x1 - x0 + 2 * reach) * (y1 - y0 + 2 * reach);
	if (area * scale * scale > maxPixels) scale = Math.max(MIN_SCALE, Math.sqrt(maxPixels / area));
	const rect = { x: Math.floor((x0 - reach) * scale), y: Math.floor((y0 - reach) * scale), width: 0, height: 0 };
	rect.width = Math.max(1, Math.ceil((x1 + reach) * scale) - rect.x);
	rect.height = Math.max(1, Math.ceil((y1 + reach) * scale) - rect.y);
	const points: PenPoint[] = samples.map((s) => ({ ...s, x: s.x * scale - rect.x, y: s.y * scale - rect.y }));
	if (options.closed && points.length > 2) points.push({ ...points[0] });
	const sized: PaintBrush = { ...brush, pressureSmoothing: 0, tip: { ...brush.tip, size: brush.tip.size * scale, smoothing: 0 } };
	const [r, g, b, a] = options.color;
	const hex = '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
	const source = options.paint ?? null;
	const paint = source?.type === 'gradient' ? resolvePaintGradient(scalePaintGradient(source, scale), { paint: hex, secondary: '#ffffff' }) : null;
	const color: RgbTriple = source?.type === 'color' ? hexRgb(source.color) : [r / 255, g / 255, b / 255];
	return { points, brush: sized, rect, scale, color, alpha: Math.min(1, Math.max(0, a / 255)), paint };
}

function hexRgb(hex: string): RgbTriple {
	const n = parseInt(hex.slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const EMPTY: BrushstrokeImage = { image: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, bounds: null, scale: 1, dabs: 0 };

/** The image of `data` (the placed area's pixels) cropped to its painted pixels, with alpha scaled. */
function cropped(data: Uint8ClampedArray, placed: Placed, dabs: number, keep?: (i: number) => boolean): BrushstrokeImage {
	const { width: w, height: h } = placed.rect;
	let cx0 = w, cy0 = h, cx1 = -1, cy1 = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			if (keep ? !keep(i) : data[i + 3] === 0) continue;
			if (x < cx0) cx0 = x;
			if (x > cx1) cx1 = x;
			if (y < cy0) cy0 = y;
			if (y > cy1) cy1 = y;
		}
	}
	if (cx1 < 0) return { ...EMPTY, scale: placed.scale, dabs };
	const cw = cx1 - cx0 + 1;
	const ch = cy1 - cy0 + 1;
	const out = new Uint8ClampedArray(cw * ch * 4);
	for (let y = 0; y < ch; y++) {
		for (let x = 0; x < cw; x++) {
			const i = ((y + cy0) * w + x + cx0) * 4;
			if (keep && !keep(i)) continue;
			const o = (y * cw + x) * 4;
			out[o] = data[i];
			out[o + 1] = data[i + 1];
			out[o + 2] = data[i + 2];
			out[o + 3] = placed.alpha < 1 ? Math.round(data[i + 3] * placed.alpha) : data[i + 3];
		}
	}
	const s = placed.scale;
	return { image: { width: cw, height: ch, data: out }, bounds: { x: (placed.rect.x + cx0) / s, y: (placed.rect.y + cy0) / s, width: cw / s, height: ch / s }, scale: s, dabs };
}

// ---------------------------------------------------------------------------
// Wet
// ---------------------------------------------------------------------------

/**
 * One wet brushstroke's simulation: the paint is laid when the job is made; `run` advances it
 * (within a time budget, for hosts that slice the work), `image` bakes it as it is now and
 * `settled` once all `VECTOR_WET_STEPS` steps have run. Call `destroy` when done with it.
 */
export class WetBrushstrokeJob {
	private readonly world: WetWorld | null;
	private readonly placed: Placed | null;
	private readonly dabs: number;
	private done = 0;
	private final: BrushstrokeImage | null = null;

	constructor(input: BrushstrokeInput, brush: PaintBrush, options: VectorMediaOptions, readonly steps = VECTOR_WET_STEPS) {
		if (vectorMediaEngine(brush) !== 'wet') throw new Error(`'${brush.name}' is not a wet paint brush.`);
		// Wet paint spreads past the tip: leave room for it to run.
		this.placed = place(input, brush, options, brush.tip.size * 0.25);
		if (!this.placed) {
			this.world = null;
			this.dabs = 0;
			this.final = EMPTY;
			return;
		}
		const { rect, points } = this.placed;
		// The TypeScript kernel on this thread: the wasm kernel gives the same bits but loads asynchronously.
		this.world = new WetWorld(rect.width, rect.height, wetPaperInput(DEFAULT_PAPER), { kernel: 'typescript', threads: 0 });
		const medium = this.placed.brush.wet.medium ?? 'watercolor';
		this.world.ensureLane('s', { params: WET_MEDIUM_PARAMS[medium] ?? {} });
		const color = this.placed.color;
		const driver = new WetStrokeDriver({
			world: this.world,
			laneId: 's',
			brush: this.placed.brush,
			color,
			load: { reservoir: [...color], amount: 1, pickup: null },
			grain: null,
			paperDepth: 0,
			paperColor: [255, 255, 255],
			seed: options.seed ?? 0,
			copies: [],
			paint: this.placed.paint,
		});
		driver.push(points);
		driver.finish();
		this.dabs = driver.dabCount;
	}

	/** Steps run so far. */
	get progress(): number {
		return this.done;
	}

	get finished(): boolean {
		return this.final !== null;
	}

	/** Runs steps until `budgetMs` has passed (at least one) or all have run. Returns whether it is finished. */
	run(budgetMs = Infinity): boolean {
		if (this.final || !this.world) return true;
		const start = Date.now();
		while (this.done < this.steps) {
			this.world.stepSync(1);
			this.done++;
			if (Date.now() - start >= budgetMs) break;
		}
		if (this.done >= this.steps) {
			this.final = this.bake();
			this.destroy();
		}
		return this.final !== null;
	}

	/** The paint dried where it is now (step 0: as laid). */
	image(): BrushstrokeImage {
		return this.final ?? this.bake();
	}

	/** The settled image: runs the remaining steps now. */
	settled(): BrushstrokeImage {
		this.run();
		return this.final!;
	}

	destroy(): void {
		this.world?.destroy();
	}

	private bake(): BrushstrokeImage {
		if (!this.world || !this.placed) return EMPTY;
		const { width, height } = this.placed.rect;
		const data = readRegion(this.world.bakedSurface('s'), { x: 0, y: 0, width, height });
		return cropped(data, this.placed, this.dabs);
	}
}

/** A wet brushstroke rendered and settled at once (`VECTOR_WET_STEPS` steps; slow for long strokes). */
export function renderWetBrushstroke(input: BrushstrokeInput, brush: PaintBrush, options: VectorMediaOptions): BrushstrokeImage {
	return new WetBrushstrokeJob(input, brush, options).settled();
}

// ---------------------------------------------------------------------------
// Mixer, smudge and blender over a backdrop
// ---------------------------------------------------------------------------

/**
 * What lies beneath a stroke: straight-alpha RGBA of `rect` (image pixels at the stroke's scale,
 * path units × scale), row by row. Called once per render.
 */
export type VectorBrushstrokeBackdrop = (rect: RasterRect, scale: number) => Uint8ClampedArray;

/** The image pixels a backdrop brushstroke reads, in path units × the scale it renders at (for callers that render backdrops). */
export function vectorBackdropRect(input: BrushstrokeInput, brush: PaintBrush, options: VectorMediaOptions): { rect: RasterRect; scale: number } | null {
	const placed = place(input, brush, options);
	return placed ? { rect: placed.rect, scale: placed.scale } : null;
}

/**
 * A Mixer Brush, smudge or blender stroke over `backdrop`: the pixels it changed (the rest are
 * transparent). Without a backdrop it acts on bare paper: a Mixer Brush still paints from its
 * reservoir; a smudge or blender changes nothing.
 */
export function renderBackdropBrushstroke(
	input: BrushstrokeInput,
	brush: PaintBrush,
	options: VectorMediaOptions & {
		backdrop?: VectorBrushstrokeBackdrop | null;
		/** A cache for the result, given the backdrop's bytes (the result depends only on them and the stroke). */
		cache?: (backdrop: Uint8ClampedArray) => { get(): BrushstrokeImage | undefined; set(image: BrushstrokeImage): void };
	}
): BrushstrokeImage {
	const engine = vectorMediaEngine(brush);
	if (!usesVectorBackdrop(engine)) throw new Error(`'${brush.name}' is not a Mixer Brush, smudge or blender.`);
	const placed = place(input, brush, options);
	if (!placed) return EMPTY;
	const { rect } = placed;
	const area = { x: 0, y: 0, width: rect.width, height: rect.height };
	const before = options.backdrop ? options.backdrop(rect, placed.scale) : new Uint8ClampedArray(rect.width * rect.height * 4);
	if (before.length !== rect.width * rect.height * 4) throw new Error(`The backdrop must be ${rect.width}×${rect.height} RGBA pixels.`);
	const cached = options.cache?.(before);
	const hit = cached?.get();
	if (hit) return hit;
	const base = writeRegion(emptySurface(4), area, before);
	const live = new Map<TileKey, Uint8ClampedArray>();
	const target: PaintTileTarget = {
		offset: { x: 0, y: 0 },
		lockTransparency: false,
		selection: null,
		readTile: (tx, ty) => live.get(tileKey(tx, ty)) ?? base.tiles.get(tileKey(tx, ty))?.data ?? null,
		writeTile: (tx, ty) => {
			const key = tileKey(tx, ty);
			let t = live.get(key);
			if (!t) live.set(key, (t = base.tiles.get(key) ? new Uint8ClampedArray(base.tiles.get(key)!.data) : new Uint8ClampedArray(TILE * TILE * 4)));
			return t;
		},
	};
	const color = placed.color;
	const load = placed.brush.engine === 'mixer' && placed.brush.loadsColor ? loadMixer(EMPTY_MIXER_LOAD, color) : EMPTY_MIXER_LOAD;
	const stroke = new PaintDabStroke(placed.brush, { target, color, secondary: [1, 1, 1], load, grain: null, paperDepth: 0, seed: options.seed ?? 0, paint: placed.paint });
	stroke.push(placed.points);
	stroke.finish();
	const after = new Uint8ClampedArray(rect.width * rect.height * 4);
	const tiles = new Map(base.tiles);
	for (const [key, data] of live) tiles.set(key, { data, uniform: null });
	readRegion(new TiledSurface(4, tiles), area, after);
	const result = cropped(after, placed, stroke.dabCount, (i) => after[i] !== before[i] || after[i + 1] !== before[i + 1] || after[i + 2] !== before[i + 2] || after[i + 3] !== before[i + 3]);
	cached?.set(result);
	return result;
}
