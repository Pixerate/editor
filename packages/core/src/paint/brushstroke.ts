/**
 * A brushstroke rendered on its own: a path (polyline samples with pressure, tilt and time, or
 * points plus pressure / tilt profiles along the length) and a dry brush in, an RGBA image and its
 * bounds out. The canvas renders brushed freehand strokes with it, and the vector editor
 * brushstrokes on vector paths; both keep the path as the data and the pixels as a cache.
 *
 * - Built on {@link paintPathStroke}: the same dabs, coverage and build-up as everywhere else.
 * - Rendered at `scale` image pixels per path unit (both the samples and the brush size scale), so
 *   a stroke looks the same at any zoom with more or fewer pixels. Snap zooms to
 *   {@link brushstrokeScaleBucket} so panning and small zoom changes reuse the same image.
 * - Dry media only. A wet brush needs an area to flow in (the paint editor's wet layer); mixer,
 *   blender and smudge brushes need paint under them. Those are refused with an error.
 * - Deterministic and DOM-free: the image is plain RGBA bytes. Turn it into a PNG data URL with
 *   {@link brushstrokeDataUrl}, or into a canvas through an injected factory
 *   ({@link brushstrokeToCanvas}).
 */

import { normalizeBrush, type BrushSettings } from './brush';
import { paintPathStroke, type PathSample, type PathStrokeOptions } from './path-stroke';
import { scalePaintGradient, type PaintSource } from './gradient-paint';
import { PaperGrain, type GrainPattern } from './grain';
import { emptySurface, readRegion, type RasterRect } from '../raster/surface';
import { pngDataUrl } from '../raster/png';
import { BRUSHSTROKE_MAX_SCALE as MAX_SCALE, BRUSHSTROKE_MIN_SCALE as MIN_SCALE } from './brushstroke-scale';

export { brushstrokeScaleBucket, BRUSHSTROKE_MAX_SCALE, BRUSHSTROKE_MIN_SCALE } from './brushstroke-scale';

/** One sample of a brushstroke: a {@link PathSample} plus an optional time stamp (milliseconds). */
export interface BrushstrokeSample extends PathSample {
  t?: number;
}

/**
 * A path plus pen profiles along it. Each profile is a list of values spread evenly over the
 * path's length (first at the start, last at the end) and interpolated in between; one value is
 * constant. Missing profiles leave the samples upright at full pressure.
 */
export interface BrushstrokeProfilePath {
  points: ReadonlyArray<{ x: number; y: number }>;
  /** Pressure 0..1 along the length. */
  pressure?: readonly number[];
  /** Pointer Events tilt in degrees (−90..90) along the length. */
  tiltX?: readonly number[];
  tiltY?: readonly number[];
}

export type BrushstrokeInput = readonly BrushstrokeSample[] | BrushstrokeProfilePath;

/**
 * A brush for a brushstroke: plain tip settings, or a paint-editor brush (`PaintBrush` matches this
 * shape structurally). Only dab-engine brushes render; `rotation: 'stroke'` turns the tip with the
 * path, and `dynamics` give the size at zero pressure and how tilt shapes the tip. With the
 * `character` option the brush's `grain` response and its size, angle, opacity and scatter jitter
 * apply too (seeded, so still deterministic). Velocity dynamics are never applied.
 */
export type BrushstrokeBrush =
  | Partial<BrushSettings>
  | {
      id?: string;
      name?: string;
      engine?: string;
      tip: Partial<BrushSettings>;
      rotation?: string;
      /** How strongly the mark follows the paper grain, 0..1 (with `character`). */
      grain?: number;
      dynamics?: { minSize?: number; tiltSize?: number; tiltRoundness?: number; sizeJitter?: number; angleJitter?: number; opacityJitter?: number; scatter?: number };
    };

/** The paper a brushstroke's grain comes from (all optional). */
export interface BrushstrokePaper {
  /** Grain pattern (default `sanded`: a fine, even tooth). */
  pattern?: GrainPattern;
  /** Grain seed (default 1). */
  seed?: number;
  /** Grain scale in path units: 1 is the pattern's natural size (default 1). */
  scale?: number;
  /** Grain depth 0..1, multiplied by the brush's `grain` response (default 0.5). */
  depth?: number;
}

/**
 * A brush's character: its jitter and the paper grain it catches. Seeded, so a stroke always
 * renders the same bytes.
 */
export interface BrushstrokeCharacter {
  /** Jitter seed (default: a hash of the path, so each stroke differs but repeats exactly). */
  seed?: number;
  /** The paper (default: the built-in sanded grain); `null` for no grain. */
  paper?: BrushstrokePaper | null;
  /**
   * Where the path sits on the paper: paper point = `origin + path point × unit` (default origin
   * 0, 0 and unit 1). Pass the stroke's world position so neighbouring strokes share one sheet of
   * paper and the grain stays put on screen.
   */
  origin?: { x: number; y: number };
  unit?: number;
}

/**
 * What the stroke is painted with: a solid RGBA colour, or a `PaintSource` (one `#rrggbb` colour,
 * or gradient paint sampled dab by dab along the path: by distance, pressure, tilt, speed,
 * direction, time, across the tip or at random).
 */
export type BrushstrokePaint = { color: readonly [number, number, number, number] } | PaintSource;

export interface BrushstrokeOptions {
  /** Image pixels per path unit (default 1). Use {@link brushstrokeScaleBucket} for a zoom. */
  scale?: number;
  /** RGBA 0..255 (default opaque black). Shorthand for `paint: { color }`. */
  color?: readonly [number, number, number, number];
  /** What to paint with (wins over `color`; with gradient paint, `color` fills `paint` stops and gives the alpha). */
  paint?: BrushstrokePaint;
  /** Seed of gradient paint's `random` mapping (default 0). */
  seed?: number;
  /** Join the last sample back to the first. */
  closed?: boolean;
  /**
   * Render the brush's character: its seeded size / angle / opacity / scatter jitter and the paper
   * grain it catches (charcoal, pastel and pencil get their look from these). Default off: plain
   * dabs, as before.
   */
  character?: BrushstrokeCharacter;
  /**
   * The largest image to render, in pixels (default 16 777 216, 4096²). A stroke that would be
   * bigger at `scale` renders at a lower scale instead; the result's `scale` says which.
   */
  maxPixels?: number;
}

/** A rendered brushstroke. */
export interface BrushstrokeImage {
  /** Straight-alpha RGBA bytes, `width × height × 4` (the same layout as `ImageData`). */
  image: { width: number; height: number; data: Uint8ClampedArray };
  /** Where the image goes, in path units: draw `image` stretched over this rectangle. Null for an empty stroke. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** Image pixels per path unit it was rendered at. */
  scale: number;
  /** How many dabs the stroke laid down. */
  dabs: number;
}

const DEFAULT_MAX_PIXELS = 4096 * 4096;

const isProfilePath = (input: BrushstrokeInput): input is BrushstrokeProfilePath => !Array.isArray(input) && typeof input === 'object' && input !== null && 'points' in input;

/** A profile's value at `f` (0..1 along the length), or undefined without one. */
function profileAt(profile: readonly number[] | undefined, f: number): number | undefined {
  if (!profile || !profile.length) return undefined;
  if (profile.length === 1) return profile[0];
  const u = Math.min(1, Math.max(0, f)) * (profile.length - 1);
  const i = Math.min(profile.length - 2, Math.floor(u));
  return profile[i] + (profile[i + 1] - profile[i]) * (u - i);
}

/** The samples of a brushstroke input: profile paths are sampled at their points by arc length. */
export function brushstrokeSamples(input: BrushstrokeInput): BrushstrokeSample[] {
  if (!isProfilePath(input)) return input.map((s) => ({ ...s }));
  const pts = input.points;
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = lengths.at(-1) ?? 0;
  return pts.map((p, i) => {
    const f = total > 0 ? lengths[i] / total : pts.length > 1 ? i / (pts.length - 1) : 0;
    const s: BrushstrokeSample = { x: p.x, y: p.y };
    const pressure = profileAt(input.pressure, f);
    const tiltX = profileAt(input.tiltX, f);
    const tiltY = profileAt(input.tiltY, f);
    if (pressure !== undefined) s.pressure = pressure;
    if (tiltX !== undefined) s.tiltX = tiltX;
    if (tiltY !== undefined) s.tiltY = tiltY;
    return s;
  });
}

/** Engines that cannot render a brushstroke on its own, and why. */
const REFUSED_ENGINES: Record<string, string> = {
  wet: 'is a wet brush, and wet paint needs an area to flow in (paint it on a wet layer in the paint editor)',
  mixer: 'is a Mixer Brush, which picks up paint from under the tip and has none on a standalone stroke',
  blender: 'is a blender, which only moves paint that is already there',
  smudge: 'is a smudge brush, which only moves paint that is already there',
  eraser: 'is an eraser, which has nothing to remove on a standalone stroke',
};

/**
 * The tip settings and path-stroke options of a brushstroke brush. Throws for brushes that are not
 * dry dab brushes (wet, mixer, blender, smudge, eraser, impasto and the procedural engines).
 */
export function brushstrokeStrokeOptions(brush: BrushstrokeBrush): PathStrokeOptions {
  if (!brush || typeof brush !== 'object') throw new Error('A brushstroke needs a brush: tip settings ({ size, hardness, … }) or a paint brush preset.');
  if (!('tip' in brush) || !brush.tip) return { brush: normalizeBrush(brush as Partial<BrushSettings>) };
  const engine = brush.engine ?? 'dab';
  if (engine !== 'dab') {
    const label = brush.name ?? brush.id ?? 'This brush';
    const why = REFUSED_ENGINES[engine] ?? `uses the '${engine}' engine, which renderBrushstroke does not draw`;
    throw new Error(`Brushstrokes render dry media only: '${label}' ${why}. Pick a dry brush (a dab-engine preset such as a pencil, pastel, charcoal, marker, ink or airbrush) or plain tip settings.`);
  }
  const d = brush.dynamics ?? {};
  const tilt = { size: d.tiltSize ?? 0, roundness: d.tiltRoundness ?? 0 };
  return {
    brush: normalizeBrush(brush.tip),
    followPath: brush.rotation === 'stroke',
    minSize: d.minSize ?? 0,
    ...(tilt.size || tilt.roundness ? { tilt } : {}),
  };
}

/** Whether a brush renders as a brushstroke (a dry dab brush, or plain tip settings). */
export function isBrushstrokeBrush(brush: BrushstrokeBrush): boolean {
  return !('tip' in brush) || !brush.tip || (brush.engine ?? 'dab') === 'dab';
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The jitter and grain settings of a brush (zero for plain tip settings). */
function brushCharacterOf(brush: BrushstrokeBrush): { grain: number; size: number; angle: number; opacity: number; scatter: number } {
  if (!('tip' in brush) || !brush.tip) return { grain: 0, size: 0, angle: 0, opacity: 0, scatter: 0 };
  const d = brush.dynamics ?? {};
  const u = (v: unknown, hi = 1) => (finite(v) ? Math.min(hi, Math.max(0, v)) : 0);
  return { grain: u(brush.grain), size: u(d.sizeJitter), angle: u(d.angleJitter), opacity: u(d.opacityJitter), scatter: u(d.scatter, 4) };
}

const papers = new Map<string, PaperGrain>();

/** The grain of a paper (built once per pattern, seed and scale). */
function paperGrain(paper: BrushstrokePaper): PaperGrain {
  const pattern = paper.pattern ?? 'sanded';
  const seed = finite(paper.seed) ? Math.round(Math.abs(paper.seed)) : 1;
  const scale = finite(paper.scale) && paper.scale > 0 ? Math.min(8, Math.max(0.25, paper.scale)) : 1;
  const key = `${pattern}:${seed}:${scale}`;
  let g = papers.get(key);
  if (!g) {
    g = new PaperGrain({ pattern, seed, scale, tiling: 'mirror', dry: { contrast: 1, invert: false }, wet: { contrast: 1, invert: false } });
    if (papers.size > 16) papers.delete(papers.keys().next().value as string);
    papers.set(key, g);
  }
  return g;
}

/**
 * Renders a dry brushstroke along `input` with `brush` to an RGBA image. The same input, brush and
 * options always give the same bytes. Throws for a wet (or other non-dry) brush and for samples
 * that are not finite.
 */
export function renderBrushstroke(input: BrushstrokeInput, brush: BrushstrokeBrush, options: BrushstrokeOptions = {}): BrushstrokeImage {
  const strokeOptions = brushstrokeStrokeOptions(brush);
  const samples = brushstrokeSamples(input);
  for (const s of samples) if (!finite(s.x) || !finite(s.y)) throw new Error('Brushstroke samples need finite x and y.');
  const solid = options.paint && !('type' in options.paint) ? options.paint.color : null;
  const source = options.paint && 'type' in options.paint ? options.paint : null;
  const color = solid ?? options.color ?? [0, 0, 0, 255];
  let scale = finite(options.scale) && options.scale > 0 ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, options.scale)) : 1;
  if (!samples.length) return { image: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, bounds: null, scale, dabs: 0 };

  // Keep the image under maxPixels: estimate it from the samples and the widest the tip can get.
  const tip = strokeOptions.brush as BrushSettings;
  const reach = tip.size * (1 + 1.5 * (strokeOptions.tilt?.size ?? 0)) + 4;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of samples) {
    x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y);
  }
  const maxPixels = finite(options.maxPixels) && options.maxPixels > 0 ? options.maxPixels : DEFAULT_MAX_PIXELS;
  const area = (x1 - x0 + reach) * (y1 - y0 + reach);
  if (area * scale * scale > maxPixels) scale = Math.max(MIN_SCALE, Math.sqrt(maxPixels / area));

  const scaled = samples.map((s) => ({ ...s, x: s.x * scale, y: s.y * scale }));
  // Character: seeded jitter and paper grain, sampled where the path lies on the paper.
  let character: Pick<PathStrokeOptions, 'jitter' | 'grain'> = {};
  if (options.character) {
    const c = brushCharacterOf(brush);
    const ch = options.character;
    const seed = finite(ch.seed) ? ch.seed | 0 : hashString(JSON.stringify(input));
    const jitter = c.size || c.angle || c.opacity || c.scatter ? { seed, size: c.size, angle: c.angle, opacity: c.opacity, scatter: c.scatter } : undefined;
    const paper = ch.paper === null ? null : (ch.paper ?? {});
    const depth = paper ? Math.min(1, Math.max(0, (finite(paper.depth) ? paper.depth : 0.5) * c.grain)) : 0;
    let grain: PathStrokeOptions['grain'];
    if (paper && depth > 0) {
      const g = paperGrain(paper);
      const ox = ch.origin?.x ?? 0;
      const oy = ch.origin?.y ?? 0;
      const k = (finite(ch.unit) && ch.unit > 0 ? ch.unit : 1) / scale;
      grain = { depth, at: (x, y) => g.at(ox + x * k, oy + y * k) };
    }
    character = { ...(jitter ? { jitter } : {}), ...(grain ? { grain } : {}) };
  }
  const { surface, bounds, dabs } = paintPathStroke(emptySurface(4), scaled, {
    ...strokeOptions,
    ...character,
    brush: { ...tip, size: tip.size * scale },
    closed: options.closed ?? strokeOptions.closed,
    color,
    // Gradient lengths are in path units: scale them with the image.
    ...(source ? { paint: { paint: source.type === 'gradient' ? scalePaintGradient(source, scale) : source, seed: options.seed ?? 0 } } : {}),
  });
  if (!bounds) return { image: { width: 0, height: 0, data: new Uint8ClampedArray(0) }, bounds: null, scale, dabs };
  const rect: RasterRect = bounds;
  const data = readRegion(surface, rect);
  return {
    image: { width: rect.width, height: rect.height, data },
    bounds: { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale },
    scale,
    dabs,
  };
}

/** A rendered brushstroke as a PNG data URL (for an SVG `<image>`, an `<img>` or an export). Empty strokes give ''. */
export function brushstrokeDataUrl(stroke: BrushstrokeImage): string {
  const { width, height, data } = stroke.image;
  return width && height ? pngDataUrl(width, height, data) : '';
}

/** The 2D-canvas surface {@link brushstrokeToCanvas} draws on (an `HTMLCanvasElement` or `OffscreenCanvas`). */
export interface BrushstrokeCanvasLike {
  getContext(type: '2d'): { createImageData(w: number, h: number): { data: Uint8ClampedArray }; putImageData(img: never, x: number, y: number): void } | null;
}

/**
 * A rendered brushstroke on a canvas made by `createCanvas(width, height)` (injected, so this
 * module stays DOM-free). Returns null for an empty stroke or a canvas without a 2D context.
 */
export function brushstrokeToCanvas<C extends BrushstrokeCanvasLike>(stroke: BrushstrokeImage, createCanvas: (width: number, height: number) => C): C | null {
  const { width, height, data } = stroke.image;
  if (!width || !height) return null;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(width, height);
  img.data.set(data);
  ctx.putImageData(img as never, 0, 0);
  return canvas;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** FNV-1a over a string, as 8 hex digits. */
function hashString(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A key for a brushstroke: the path (samples or profiles), the brush, the colour and the scale.
 * Two calls with equal arguments give equal keys; any change to them changes the key.
 */
export function brushstrokeKey(input: BrushstrokeInput, brush: BrushstrokeBrush, options: BrushstrokeOptions = {}): string {
  const path = JSON.stringify(input);
  const { brush: tip, ...rest } = brushstrokeStrokeOptions(brush);
  const character = options.character ? [options.character, brushCharacterOf(brush)] : null;
  const rest2 = JSON.stringify([tip, rest, options.paint ?? options.color ?? null, options.seed ?? 0, options.closed ?? false, options.maxPixels ?? null, ...(character ? [character] : [])]);
  const scale = finite(options.scale) ? options.scale : 1;
  return `${hashString(path).toString(16)}:${path.length}:${hashString(rest2).toString(16)}:${scale}`;
}

/**
 * A small least-recently-used cache of rendered brushstrokes keyed by {@link brushstrokeKey}: path,
 * brush, colour and scale. Pass a bucketed scale ({@link brushstrokeScaleBucket}) so zooming inside
 * a bucket hits the cache, and a changed path, brush or bucket re-renders.
 */
export class BrushstrokeCache {
  private readonly entries = new Map<string, BrushstrokeImage>();
  /** Renders that missed the cache (for tests and stats). */
  misses = 0;

  constructor(readonly capacity = 64) {}

  get size(): number {
    return this.entries.size;
  }

  /** The cached stroke for these arguments, rendering (and caching) it on a miss. */
  render(input: BrushstrokeInput, brush: BrushstrokeBrush, options: BrushstrokeOptions = {}): BrushstrokeImage {
    const key = brushstrokeKey(input, brush, options);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    this.misses++;
    const out = renderBrushstroke(input, brush, options);
    this.entries.set(key, out);
    while (this.entries.size > Math.max(1, this.capacity)) this.entries.delete(this.entries.keys().next().value as string);
    return out;
  }

  clear(): void {
    this.entries.clear();
  }
}
