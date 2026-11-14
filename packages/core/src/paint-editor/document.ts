/**
 * The paint editor's document: a canvas (size and resolution), a paper, and the shared raster
 * layer stack (`@pixerate/editor/raster`: pixel layers and groups with masks, clipping, locks and
 * blend modes). Layers are immutable and share tiles, so a history entry is a reference to a
 * whole document state.
 *
 * Saved documents are JSON plus PNG assets, through the image editor's layer serializer (so the
 * same layer tree loads in both editors), with the paper as plain settings.
 */

import type { RasterGroupLayer, RasterPixelLayer } from '../raster/layers';
import { emptySurface, type TiledSurface } from '../raster/surface';
import { normalizePaper, type PaperSettings } from './paper';
import type { RecordedStroke } from './strokes';
import type { WetEvent } from './wet';
import type { ThickChannels } from './thick';
import type { FerroSettings, PaintMagnet } from './ferro';
import type { Sticker } from './stickers';
import type { PaintEffectSource, PaintPaperEffect } from './effects';
import type { PaintAuthoredEffect } from './authored-effects';
import type { HeatField } from './heat';
import type { LayerCulture } from '../paint/culture';
import type { PaintAgeSettings } from './age';

export type PaintPixelLayer = RasterPixelLayer & {
  /** A temporary layer for a dry mutation stroke (fades on claim, merges down on timeout or save). */
  temporary?: boolean;
};
export type PaintGroupLayer = RasterGroupLayer<PaintLayer>;
/** A layer of the paint editor: the shared stack's pixel layers and groups. */
export type PaintLayer = PaintPixelLayer | PaintGroupLayer;

/** Canvas size limits (pixels per side). */
export const MIN_CANVAS_SIDE = 1;
export const MAX_CANVAS_SIDE = 16384;
export const DEFAULT_DPI = 300;

export interface PaintCanvas {
  width: number;
  height: number;
  /** Pixels per inch, for print sizes and PSD resolution (default 300). */
  dpi: number;
}

/** Everything one undo step restores. */
export interface PaintDocumentState {
  canvas: PaintCanvas;
  paper: PaperSettings;
  /** Bottom to top. */
  layers: PaintLayer[];
  activeLayerId: string | null;
  /** Every committed stroke, oldest first (strokes are data: replay, vary, time-lapse later). */
  strokes: RecordedStroke[];
  /** Wet-media events other than strokes (drying, tilt, settings), with the clock they happened at. */
  wetEvents?: WetEvent[];
  /** Changes besides strokes that a replay repeats (fills, clears, flattened relief), in order. */
  paintEvents?: PaintEvent[];
  /** Sticker layers: each layer's stickers, bottom first (its pixels are drawn from them). */
  stickers?: Readonly<Record<string, Sticker[]>>;
  /**
   * Live stroke layers: each layer's strokes, bottom first. Its pixels are drawn from them, so each
   * stroke's brush, colour and points stay editable (`updateStroke`).
   */
  liveStrokes?: Readonly<Record<string, RecordedStroke[]>>;
  /** Light paint: each layer's light channel, 0..255 per pixel in layer space (layers without light are missing). See `light.ts`. */
  light?: Readonly<Record<string, TiledSurface>>;
  /** UV-fluorescent ink: each layer's 4-channel RGBA fluorescence surface in layer space (layers without fluorescence are missing). See `heat.ts`. */
  fluor?: Readonly<Record<string, TiledSurface>>;
  /** Thermochromic ink: each layer's 4-channel RGBA thermochromic surface (`[hotR, hotG, hotB, thresholdByte]`) in layer space. See `heat.ts`. */
  thermo?: Readonly<Record<string, TiledSurface>>;
  /** Coarse document-level heat field (1/4 resolution) for thermochromic ink and wet-paint drying. See `heat.ts`. */
  heat?: HeatField;
  /** Ferrofluid paint: each layer's liquid ferrofluid channel, 0..255 per pixel in layer space (layers without ferrofluid are missing). See `ferro.ts`. */
  ferro?: Readonly<Record<string, TiledSurface>>;
  /** Per-layer Rosensweig spike settings (`wavelength`, `threshold`) from the last ferrofluid stroke on that layer. */
  ferroSettings?: Readonly<Record<string, FerroSettings>>;
  /** Dipole magnets placed on the canvas (document pixel coordinates). */
  magnets?: PaintMagnet[];
  /** Thick paint: each layer's height and material channels (layers without relief are missing). */
  thick?: Readonly<Record<string, ThickChannels>>;
  /** Biopaint (`culture`): per-layer living mycelial colony state (`tick`, `nextId`, `tips`, `occupancy`, `segmentsTotal`, `status`). */
  cultures?: Readonly<Record<string, LayerCulture>>;
  /** Whether active cultures continue growing while the document is closed (default false). */
  growWhileClosed?: boolean;
  /** Timestamp (ms) when cultures were last grown or saved. */
  lastGrownAt?: number;
  /** Effect layers: the provider effect each one is drawn from (layers that are gone are ignored). */
  effectLayers?: Readonly<Record<string, PaintEffectSource>>;
  /** Effect paper: a provider generator drawn over the paper, under the paint. */
  paperEffect?: PaintPaperEffect;
  /** Authored effects: effects written at run time, kept with their source (`authored.<name>` ids). */
  authoredEffects?: Readonly<Record<string, PaintAuthoredEffect>>;
  /**
   * Where this document's (0, 0) is in the coordinates of the canvas it grew from (missing = 0, 0).
   * `extendCanvas({ left: 100 })` moves it to x −100; a host maps its own coordinates with it.
   */
  origin?: { x: number; y: number };
  /** Non-destructive time-machine ageing preview settings (`years`, `varnish`, `cracks`, `fading`, `dust`, `seed`). */
  age?: PaintAgeSettings;
  /**
   * Pixel layers holding pixels the stroke log doesn't have (imported, merged, moved or transformed
   * pixels…), each with the change that put them there. A replay can't rebuild these layers, so
   * they keep the side of a dual colour they were painted in whatever the colour scheme (#720).
   * Kept by the editor on every commit; saved (extension `unlogged`) whenever there are any, with
   * `unloggedComplete: true` when the save keeps the stroke log and the marks are known to be
   * complete. A document opened without that flag (saved before the marks were kept, or without
   * its log) has its layers marked or checked against the log on opening (`colorSchemeView`).
   */
  unlogged?: Readonly<Record<string, string>>;
}

/** A change a replay repeats besides strokes, recorded with how many strokes came before it. */
export interface PaintEvent {
  at: number;
  kind: 'fill' | 'fill-region' | 'clear' | 'flatten' | 'stickers' | 'live-strokes' | 'magnets' | 'cure-ferrofluid' | 'culture-grow';
  layerId: string;
  /** The fill's options (colour, opacity, grain, pressure, blend), or the layer's stickers or live strokes after an edit. */
  data?: Record<string, unknown>;
}

let nextId = 1;

/** A new layer id, unique in this session. */
export function newPaintLayerId(): string {
  return `pl${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

/** An empty, visible, normal pixel layer. */
export function createPaintLayer(name: string, id = newPaintLayerId()): PaintPixelLayer {
  return { type: 'pixel', id, name, visible: true, opacity: 1, blend: 'normal', surface: emptySurface(4), offset: { x: 0, y: 0 } };
}

export class PaintDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaintDocumentError';
  }
}

/** Validates and rounds a canvas size; throws a `PaintDocumentError` that says what is wrong. */
export function normalizeCanvas(raw: Partial<PaintCanvas>): PaintCanvas {
  const side = (v: unknown, what: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new PaintDocumentError(`${what} must be a number of pixels (${MIN_CANVAS_SIDE}..${MAX_CANVAS_SIDE}).`);
    const n = Math.round(v);
    if (n < MIN_CANVAS_SIDE || n > MAX_CANVAS_SIDE) throw new PaintDocumentError(`${what} ${n} is out of range; use ${MIN_CANVAS_SIDE}..${MAX_CANVAS_SIDE} pixels.`);
    return n;
  };
  const dpi = raw.dpi === undefined ? DEFAULT_DPI : raw.dpi;
  if (typeof dpi !== 'number' || !Number.isFinite(dpi) || dpi < 1 || dpi > 10000) throw new PaintDocumentError(`dpi ${dpi} is out of range; use 1..10000.`);
  return { width: side(raw.width, 'width'), height: side(raw.height, 'height'), dpi: Math.round(dpi * 100) / 100 };
}

/** A blank document: one empty layer over the paper. */
export function createPaintDocument(options: Partial<PaintCanvas> & { paper?: Partial<PaperSettings> } = {}): PaintDocumentState {
  const canvas = normalizeCanvas({ width: options.width ?? 2048, height: options.height ?? 1536, dpi: options.dpi });
  const layer = createPaintLayer('Layer 1');
  return { canvas, paper: normalizePaper(options.paper ?? {}), layers: [layer], activeLayerId: layer.id, strokes: [] };
}
