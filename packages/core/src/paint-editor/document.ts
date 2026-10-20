/**
 * The paint editor's document: a canvas (size and resolution), a paper, and the shared raster
 * layer stack (`@pixerate/editor/raster`: pixel layers and groups with masks, clipping, locks and
 * blend modes). Layers are immutable and share tiles, so a history entry is a reference to a
 * whole document state.
 *
 * Saved documents are JSON plus PNG assets, through the image editor's layer serializer (so the
 * same layer tree loads in both editors), with the paper as plain settings.
 */

import type { RasterGroupLayer, RasterLayer, RasterPixelLayer } from '../raster/layers';
import { emptySurface } from '../raster/surface';
import { normalizePaper, type PaperSettings } from './paper';
import type { RecordedStroke } from './strokes';
import type { WetEvent } from './wet';
import type { ThickChannels } from './thick';
import type { Sticker } from './stickers';

export type PaintPixelLayer = RasterPixelLayer;
export type PaintGroupLayer = RasterGroupLayer<PaintLayer>;
/** A layer of the paint editor: the shared stack's pixel layers and groups. */
export type PaintLayer = RasterLayer;

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
  /** Thick paint: each layer's height and material channels (layers without relief are missing). */
  thick?: Readonly<Record<string, ThickChannels>>;
}

/** A change a replay repeats besides strokes, recorded with how many strokes came before it. */
export interface PaintEvent {
  at: number;
  kind: 'fill' | 'clear' | 'flatten' | 'stickers';
  layerId: string;
  /** The fill's options (colour, opacity, grain, pressure, blend), or the layer's stickers after an edit. */
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
