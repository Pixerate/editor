/**
 * `PaintEditorController`: the natural-media paint editor's state, framework-free.
 *
 * - The document (canvas, paper, the shared raster layer stack, recorded strokes) is immutable
 *   and tiled copy-on-write; each undo step is a reference to a whole document state.
 * - Strokes: `beginStroke` gives a live session for pointer input (one undo step at `end`);
 *   `paintStroke` paints a whole stroke from data (agents, tests, replays).
 * - The brush, colour, Mixer Brush load, view and hand are editor state, not undo steps.
 * - Rendering goes through the shared compositor with the paper as its bottom layer; exports
 *   are PNG (pure TypeScript), JPEG / WebP (through a canvas or a host encoder) and PSD (through
 *   the shared PSD writer, with the paper as a pixel layer).
 */

import { exportPsd, type PsdExportResult } from '../image-editor/psd/export';
import type { ImageLayer } from '../image-editor/layers/model';
import { applyStrokeToTile, CoverageMap, type StrokeApply } from '../paint/brush';
import { cleanMixer, EMPTY_MIXER_LOAD, loadMixer, type MixerLoad } from '../paint/mixer';
import { BLEND_MODES, isBlendMode, standardBlendMode, type BlendMode } from '../raster/blend';
import { findLayer, flattenLayers, insertLayer, isLayerLocked, mapLayer, type LayerLocks } from '../raster/layers';
import { bytesToBase64, decodePng, encodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import {
  translateSurface,
  contentBounds,
  emptySurface,
  readPixel,
  surfaceFromPixels,
  TILE,
  TiledSurface,
  tileKey,
  tilesInRect,
  finishTile,
  type RasterRect,
  type Tile,
} from '../raster/surface';
import { brushToJSON, BUILTIN_BRUSHES, DEFAULT_BRUSH_ID, normalizePaintBrush, type PaintBrushInput, parseBrushLibrary, BRUSH_ID, type BrushLibraryFile, type PaintBrush } from './brushes';
import {
  createPaintDocument,
  createPaintLayer,
  newPaintLayerId,
  normalizeCanvas,
  type PaintCanvas,
  type PaintDocumentState,
  type PaintLayer,
  type PaintPixelLayer,
  type PaintEvent,
} from './document';
import { defaultImageEncoder, type ImageEncoder, type ImageFormat } from './encode';
import type { PenPoint } from './engine';
import type { Hand } from './input';
import { mix32 } from './noise';
import { clonePaper, grainCatch, hexToRgb8, normalizePaper, paperPreset, type PaperSettings } from './paper';
import { createPaintCompositor, downsampleRgba, paperGrain, paperNode, TRACING_NODE_ID, type ImageNode, type ViewLayer } from './render';
import {
  deserializePaintDocument,
  deserializePaintDocumentAsync,
  serializePaintDocument,
  serializePaintDocumentExternal,
  type PaintAssetStore,
  type PaintDocumentExtensions,
  type SerializedPaintDocument,
} from './serialize';
import { brushLoadForStroke, PaintStrokeSession, type PaintStrokeResult, type StrokeSessionHost } from './stroke';
import { affineCopy, strokeBounds, variationAffine, varyStroke, IDENTITY_AFFINE, type Affine, type RecordedStroke, type StrokeVariation } from './strokes';
import { renderBrushThumbnail, type BrushThumbnail } from './thumbnails';
import { colorHarmony, DEFAULT_SWATCHES, type ColorWheel, type HarmonyColor, type HarmonyKind, type Swatch } from './color';
import {
  defaultGuides,
  normalizePerspective,
  normalizeSymmetry,
  PerspectiveSnapper,
  symmetryCopies,
  type PaintGuides,
  type PerspectiveGuide,
  type ReferenceImage,
  type SymmetryGuide,
  type TracingImage,
} from './guides';
import { MixingPad, type MixingPadTool, type PadMixOptions } from './mixing-pad';
import { DEFAULT_VIEW, normalizeView, type PaintView } from './view';
import { PaintWetLayers, WetStrokeDriver, type PaintWetOptions, type WetEvent, type WetLayerInfo, type WetLayerSettings } from './wet';
import { isWetBrush } from './brushes';
import { normalizeWetParams, normalizeTilt, type WetParams, type WetTilt } from '../paint/wet/model';
import { normalizeFlow, type WetFlowSpec } from '../paint/wet/flow';
import { MAX_WET_LANES, type WetBackendInfo, type WetSnapshot } from '../paint/wet/world';
import { wetSupport } from '../paint/wet/wasm';
import { buildTimeLapse, emptiedLayers, replayPainting, type TimeLapse, type TimeLapseOptions } from './replay';
import { DEFAULT_LIGHTING, emptyThickChannels, LitCache, normalizeLighting, reliefInfo, thickFromJSON, thickToJSON, type PaintLighting, type ThickChannels } from './thick';

/** A refusal with a message that says what is wrong and how to fix it. */
export class PaintEditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaintEditorError';
  }
}

export interface PaintEditorOptions extends Partial<PaintCanvas> {
  /** Paper settings, or a library preset id (default cold pressed). */
  paper?: Partial<PaperSettings> | string;
  /** Active brush id (default `pencil-6b`). */
  brushId?: string;
  /** Saved user brushes to start the library with. */
  brushes?: readonly PaintBrush[];
  /** Paint colour #rrggbb (default #1f2937). */
  color?: string;
  hand?: Hand;
  /** Encodes JPEG / WebP (default: a canvas, when there is one). */
  encodeImage?: ImageEncoder;
  /** Undo steps kept (default 200). */
  historyLimit?: number;
  /** Wet media: kernel, threads, speed (steps per second) and the memory kept for undoing wet strokes. */
  wet?: PaintWetOptions;
}

/** Wet media as panels show it. */
export interface PaintWetStateInfo {
  /** Layers with a wet layer (paint still wet or drying). */
  layerIds: string[];
  /** Some paint is wet. */
  wet: boolean;
  /** Time is stopped (the paint stays wet). */
  paused: boolean;
  /** The water overlay is shown. */
  overlay: boolean;
  /** Wet strokes dry as soon as they end. */
  instantDry: boolean;
  /** Steps per second while time runs. */
  speed: number;
  /** Simulation steps so far. */
  clock: number;
  tilt: WetTilt;
}

export interface PaintEditorState {
  document: PaintDocumentState;
  /** The active brush (possibly edited from its preset). */
  brush: PaintBrush;
  /** The brush library: built-in presets, then the user's brushes. */
  brushes: readonly PaintBrush[];
  /** Paint colour #rrggbb. */
  color: string;
  /** The second colour (swap with `swapColors`). */
  secondaryColor: string;
  /** What the Mixer Brush carries between strokes. */
  mixerLoad: MixerLoad;
  view: PaintView;
  hand: Hand;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  /** Mirror / kaleidoscope, perspective, tracing image and reference images (saved with the document, not undo steps). */
  guides: PaintGuides;
  /** The colour swatches (saved with the document, not undo steps). */
  swatches: readonly Swatch[];
  /** Changes whenever the mixing pad does. */
  mixingPadVersion: number;
  /** Mixing pads kept by name (saved with the document). */
  savedMixingPads: readonly SavedMixingPadInfo[];
  /** A stroke is in progress. */
  stroking: boolean;
  /** Wet media. */
  wet: PaintWetStateInfo;
  /** Increments on every change. */
  version: number;
}

/** A layer as tools and panels describe it. */
export interface PaintLayerInfo {
  id: string;
  name: string;
  type: 'pixel' | 'group';
  visible: boolean;
  opacity: number;
  blend: string;
  clipped: boolean;
  locks: LayerLocks;
  active: boolean;
  /** Painted content (document pixels), or `null` when empty. */
  bounds: RasterRect | null;
  parentId: string | null;
  depth: number;
}

export interface PaintStrokeInit {
  /** Default the active layer. */
  layerId?: string;
  /** Default the editor colour. */
  color?: string;
  /** Default the active brush. */
  brushId?: string;
  /** Changes to the brush for this stroke only. */
  brush?: PaintBrushInput;
  /** Jitter seed (default: a new one per stroke). */
  seed?: number;
  /** Extra copies of the stroke as affine maps (default: the symmetry guide's). */
  copies?: readonly Affine[];
  /** Snap the samples to the perspective guide (default true for `beginStroke`, false for `paintStroke`). */
  snapToPerspective?: boolean;
  /** Where the stroke starts, for taking its colour from the tracing image before the first sample (`beginStroke`). */
  start?: { x: number; y: number };
  /** What the brush carries at the start (default: from the editor's brush load); replays pass the recorded one. */
  load?: MixerLoad;
}

export interface LayerUpdate {
  name?: string;
  visible?: boolean;
  opacity?: number;
  blend?: BlendMode;
  clipped?: boolean;
  locks?: LayerLocks;
}

export interface FillLayerOptions {
  layerId?: string;
  /** Default the editor colour. */
  color?: string;
  /** 0..1 (default 1). */
  opacity?: number;
  /** Paper grain response 0..1 (default 0: a flat fill); above 0 the fill catches the grain like pastel rubbed across the paper. */
  grain?: number;
  /** With grain: pressure 0..1, how far the fill reaches into the valleys (default 0.5). */
  pressure?: number;
  blend?: BlendMode;
}

export interface ReplayOptions extends StrokeVariation {
  /** Recorded stroke ids (see `getStrokes`). */
  strokeIds: readonly string[];
  /** Paint on this layer instead of each stroke's own. */
  layerId?: string;
  /** Recolour (default each stroke's colour). */
  color?: string;
  /** Replay with this brush instead (default each stroke's brush). */
  brushId?: string;
  /** Repeat the variation this many times, each one applied on top of the last (default 1). */
  repeat?: number;
}

export interface RenderOptions {
  /** Include the paper (default true); without it the result is transparent where nothing is painted. */
  paper?: boolean;
  /** Only these layers (a group with its children). */
  layerIds?: readonly string[];
  /**
   * Wet paint as it is now (`display`: still wet, wet paper a little darker) or dried where it is
   * (`dried`, the deterministic bake that saving uses). Default `dried` for exports and `display`
   * for previews and picks.
   */
  wet?: 'display' | 'dried';
}

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A mixing pad kept by name. */
export interface SavedMixingPadInfo {
  id: string;
  name: string;
}

interface SavedMixingPad extends SavedMixingPadInfo {
  /** The pad as a PNG data URL. */
  png: string;
}

interface HistoryEntry {
  label: string;
  before: PaintDocumentState;
  after: PaintDocumentState;
  /** Wet steps: the wet simulation before and after (`lost` once dropped for memory: undo then leaves the paint dry). */
  wet?: { before: WetSnapshot | null; after: WetSnapshot | null; lost: boolean };
}

const HEX = /^#[0-9a-f]{6}$/i;

function parseColor(value: unknown, what = 'color'): string {
  if (typeof value !== 'string' || !HEX.test(value.trim())) throw new PaintEditorError(`${what} is ${JSON.stringify(value)}; use #rrggbb, e.g. "#2a4b8d".`);
  return value.trim().toLowerCase();
}

function rgbaOf(hex: string): [number, number, number, number] {
  const [r, g, b] = hexToRgb8(hex);
  return [r, g, b, 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
}

function unionRect(a: RasterRect | null, b: RasterRect | null): RasterRect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

const isPixelLayer = (l: PaintLayer | undefined): l is PaintPixelLayer => l?.type === 'pixel';

export class PaintEditorController {
  private doc: PaintDocumentState;
  private extensions: PaintDocumentExtensions = {};
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private readonly historyLimit: number;
  private brush: PaintBrush;
  private userBrushes: PaintBrush[];
  /** The library list in the state (the same array until the user brushes change, so thumbnails are not redrawn). */
  private library: readonly PaintBrush[] | null = null;
  private color: string;
  private secondaryColor = '#ffffff';
  private mixerLoad: MixerLoad = EMPTY_MIXER_LOAD;
  private view: PaintView = { ...DEFAULT_VIEW, pan: { ...DEFAULT_VIEW.pan } };
  private hand: Hand;
  private readonly encodeImage: ImageEncoder | undefined;
  private listeners = new Set<() => void>();
  private version = 0;
  private cached: PaintEditorState | null = null;
  private session: PaintStrokeSession | null = null;
  private live: { layerId: string; surface: TiledSurface } | null = null;
  private liveLayers: { key: TiledSurface; layers: PaintLayer[] } | null = null;
  private dirty: RasterRect[] | 'all' = 'all';
  private seedCounter = 1;
  private strokeCounter = 1;
  private guides: PaintGuides;
  private swatches: Swatch[] = DEFAULT_SWATCHES.map((s) => ({ ...s }));
  private readonly pad = new MixingPad();
  private savedPads: SavedMixingPad[] = [];
  private nextPadId = 1;
  private tracingVersion = 1;
  private tracingCache: { key: number; node: ImageNode } | null = null;
  private readonly imagePixels = new Map<string, PixelImage>();
  private nextReferenceId = 1;
  private readonly viewCompositor = createPaintCompositor();
  private readonly exportCompositor = createPaintCompositor();
  /** Wet media: the simulation, its settings and time. */
  readonly wet: PaintWetLayers;
  private readonly wetOptions: PaintWetOptions | undefined;
  /** Where the light comes from for thick paint (saved with the document, not undo steps). */
  private lighting: PaintLighting = { ...DEFAULT_LIGHTING };
  private readonly litCaches = new Map<string, LitCache>();
  /** The live impasto stroke's channels. */
  private liveThick: { layerId: string; channels: ThickChannels } | null = null;
  /** Set while an operation that changes wet paint runs: the simulation before it (for undo). */
  private wetOp: { before: WetSnapshot | null } | null = null;

  constructor(options: PaintEditorOptions = {}) {
    this.historyLimit = Math.max(1, options.historyLimit ?? 200);
    this.doc = createPaintDocument({ width: options.width, height: options.height, dpi: options.dpi, paper: this.resolvePaper(options.paper) });
    this.userBrushes = (options.brushes ?? []).map((b) => normalizePaintBrush({ ...b, builtin: false }));
    const start = this.findBrush(options.brushId ?? DEFAULT_BRUSH_ID) ?? this.findBrush(DEFAULT_BRUSH_ID)!;
    this.brush = normalizePaintBrush(start);
    this.color = options.color ? parseColor(options.color) : '#1f2937';
    this.hand = options.hand === 'left' ? 'left' : 'right';
    this.encodeImage = options.encodeImage;
    this.guides = defaultGuides(this.doc.canvas);
    this.wetOptions = options.wet;
    this.wet = new PaintWetLayers(
      {
        canvas: () => this.doc.canvas,
        paper: () => this.doc.paper,
        layerSurface: (id) => {
          const l = findLayer(this.doc.layers, id)?.layer;
          return isPixelLayer(l) ? l.surface : null;
        },
        updateSurfaces: (surfaces, rects) => {
          let layers = this.doc.layers;
          for (const [id, surface] of surfaces) if (findLayer(layers, id)) layers = mapLayer(layers, id, (l) => ({ ...(l as PaintPixelLayer), surface }));
          // Wet paint moving is not an undo step: keep the history's documents.
          this.doc = { ...this.doc, layers };
          this.emit(rects.length ? rects : 'all');
        },
        changed: () => {},
      },
      options.wet
    );
    this.wet.onDriverDone = () => this.session?.completeWetEnd();
  }

  // --- State and events ----------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(dirty: RasterRect[] | 'all' = 'all'): void {
    if (dirty === 'all' || this.dirty === 'all') this.dirty = 'all';
    else this.dirty.push(...dirty);
    this.version++;
    this.cached = null;
    for (const l of [...this.listeners]) l();
  }

  /** A snapshot of the editor (the same object until something changes). */
  getState(): PaintEditorState {
    if (this.cached) return this.cached;
    const last = this.undoStack[this.undoStack.length - 1];
    const next = this.redoStack[this.redoStack.length - 1];
    this.cached = {
      document: this.doc,
      brush: this.brush,
      brushes: (this.library ??= [...BUILTIN_BRUSHES, ...this.userBrushes]),
      color: this.color,
      secondaryColor: this.secondaryColor,
      mixerLoad: this.mixerLoad,
      view: this.view,
      hand: this.hand,
      canUndo: this.undoStack.length > 0 && !this.session,
      canRedo: this.redoStack.length > 0 && !this.session,
      undoLabel: last?.label ?? null,
      redoLabel: next?.label ?? null,
      guides: this.guides,
      swatches: this.swatches,
      mixingPadVersion: this.pad.version,
      savedMixingPads: this.savedPads.map(({ id, name }) => ({ id, name })),
      stroking: Boolean(this.session),
      wet: {
        layerIds: this.wet.wetLayerIds(),
        wet: this.wet.isWet(),
        paused: this.wet.paused,
        overlay: this.wet.overlay,
        instantDry: this.wet.instantDry,
        speed: this.wet.speed,
        clock: this.wet.world?.clock ?? 0,
        tilt: { ...this.wet.tilt },
      },
      version: this.version,
    };
    return this.cached;
  }

  get document(): PaintDocumentState {
    return this.doc;
  }

  /**
   * Where the rendered stack changed since the last call: rectangles (a stroke's dabs) or `'all'`.
   * The viewport passes it to `compositeTiles` as `dirty`.
   */
  takeDirty(): RasterRect[] | 'all' {
    const d = this.dirty;
    this.dirty = [];
    return d;
  }

  // --- History -------------------------------------------------------------------

  private requireIdle(what: string): void {
    if (this.session) throw new PaintEditorError(`A stroke is in progress; end or cancel it before ${what}.`);
  }

  private commit(label: string, next: PaintDocumentState, before = this.doc): void {
    const entry: HistoryEntry = { label, before, after: next };
    if (this.wetOp) {
      entry.wet = { before: this.wetOp.before, after: this.wet.snapshot(), lost: false };
      this.wetOp = null;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.trimWetHistory();
    this.emit();
  }

  /** Keeps the wet snapshots in history within the wet undo memory, dropping the oldest. */
  private trimWetHistory(): void {
    const seen = new Set<WetSnapshot>();
    let bytes = 0;
    // The nearest steps first: the top of the undo stack, then the redo stack.
    const order = [...[...this.undoStack].reverse(), ...[...this.redoStack].reverse()];
    for (const e of order) {
      if (!e.wet || e.wet.lost) continue;
      for (const snap of [e.wet.before, e.wet.after]) if (snap && !seen.has(snap)) {
        seen.add(snap);
        bytes += snap.bytes;
      }
      if (bytes > this.wet.undoMemory) e.wet = { before: null, after: null, lost: true };
    }
  }

  /** Throws when wet paint is mid-step (a batch in worker threads); `wetIdle()` waits for it. */
  private requireWetIdle(what: string): void {
    if (this.wet.busy) throw new PaintEditorError(`Wet paint is mid-step; wait a moment (await wetIdle()) before ${what}.`);
  }

  /** Starts an operation that changes wet paint: keeps the simulation as it is now for undo. */
  private beginWetOp(): void {
    this.requireWetIdle('changing wet paint');
    if (!this.wetOp) this.wetOp = { before: this.wet.snapshot() };
  }

  /**
   * Before a non-wet change to layers that hold wet paint (a dry brush, a fill, a merge…): dries
   * them first, in the same undo step. Returns the ids dried.
   */
  private dryLayersFirst(ids: readonly string[]): string[] {
    const wetIds = ids.filter((id) => this.wet.wetLayerIds().includes(id));
    if (!wetIds.length) return [];
    this.beginWetOp();
    for (const id of wetIds) this.wet.dry(id);
    this.logWet({ kind: 'dry', layerId: wetIds.join(',') });
    return wetIds;
  }

  /** Records a wet event (for replays) in the document being built. */
  private pendingWetEvents: WetEvent[] = [];

  private logWet(e: Omit<WetEvent, 'clock'>): void {
    this.pendingWetEvents.push({ clock: this.wet.world?.clock ?? 0, at: this.doc.strokes.length, ...e });
  }

  /** The document with a paint event appended (for replays). */
  private withPaintEvent(doc: PaintDocumentState, e: Omit<PaintEvent, 'at'>): PaintDocumentState {
    return { ...doc, paintEvents: [...(doc.paintEvents ?? []), { at: doc.strokes.length, ...e }] };
  }

  /** The document with the pending wet events appended. */
  private withWetEvents(doc: PaintDocumentState): PaintDocumentState {
    if (!this.pendingWetEvents.length) return doc;
    const events = [...(doc.wetEvents ?? []), ...this.pendingWetEvents];
    this.pendingWetEvents = [];
    return { ...doc, wetEvents: events };
  }

  undo(): string | null {
    this.requireIdle('undoing');
    const e = this.undoStack[this.undoStack.length - 1];
    if (!e) return null;
    if (e.wet) this.requireWetIdle('undoing');
    this.undoStack.pop();
    this.redoStack.push(e);
    const paper = this.doc.paper;
    this.doc = e.before;
    if (e.wet) {
      if (paper !== this.doc.paper) this.wet.paperChanged();
      this.wet.restore(e.wet.lost ? null : e.wet.before);
      if (paper !== this.doc.paper) this.wet.paperChanged();
    }
    this.emit();
    return e.label;
  }

  redo(): string | null {
    this.requireIdle('redoing');
    const e = this.redoStack[this.redoStack.length - 1];
    if (!e) return null;
    if (e.wet) this.requireWetIdle('redoing');
    this.redoStack.pop();
    this.undoStack.push(e);
    const paper = this.doc.paper;
    this.doc = e.after;
    if (e.wet) {
      this.wet.restore(e.wet.lost ? null : e.wet.after);
      if (paper !== this.doc.paper) this.wet.paperChanged();
    }
    this.emit();
    return e.label;
  }

  /** Labels of the undo steps, oldest first. */
  historyLabels(): { undo: string[]; redo: string[] } {
    return { undo: this.undoStack.map((e) => e.label), redo: this.redoStack.map((e) => e.label).reverse() };
  }

  // --- Canvas and paper ----------------------------------------------------------

  private resolvePaper(paper: Partial<PaperSettings> | string | undefined): Partial<PaperSettings> {
    if (typeof paper === 'string') {
      const p = paperPreset(paper);
      if (!p) throw new PaintEditorError(`Unknown paper "${paper}". Call list_papers for the ids.`);
      return p;
    }
    return paper ?? {};
  }

  /** Starts a new canvas: one empty layer over the paper (one undo step; undo brings the old one back). */
  newCanvas(options: Partial<PaintCanvas> & { paper?: Partial<PaperSettings> | string } = {}): PaintDocumentState {
    this.requireIdle('starting a new canvas');
    const next = createPaintDocument({
      width: options.width ?? this.doc.canvas.width,
      height: options.height ?? this.doc.canvas.height,
      dpi: options.dpi ?? this.doc.canvas.dpi,
      paper: options.paper === undefined ? this.doc.paper : this.resolvePaper(options.paper),
    });
    this.extensions = {};
    this.guides = { ...this.guides, symmetry: { ...this.guides.symmetry, center: { x: next.canvas.width / 2, y: next.canvas.height / 2 } }, tracing: null };
    this.tracingVersion++;
    if (this.wet.world) {
      this.beginWetOp();
      this.wet.reset();
    }
    this.commit('New canvas', next);
    return next;
  }

  /** Changes the canvas size (keeping the pixels where they are, anchored top-left) or resolution. */
  setCanvas(update: Partial<PaintCanvas>): PaintCanvas {
    this.requireIdle('changing the canvas');
    const canvas = normalizeCanvas({
      width: update.width ?? this.doc.canvas.width,
      height: update.height ?? this.doc.canvas.height,
      dpi: update.dpi ?? this.doc.canvas.dpi,
    });
    if (this.wet.world && (canvas.width !== this.doc.canvas.width || canvas.height !== this.doc.canvas.height)) {
      // The wet simulation is canvas-sized: the paint dries first.
      this.dryLayersFirst(this.wet.wetLayerIds());
      this.wet.reset();
    }
    this.commit('Canvas size', this.withWetEvents({ ...this.doc, canvas }));
    return canvas;
  }

  /** Changes the paper: a library preset (`preset`), and / or any of its settings (one undo step). */
  setPaper(update: Partial<PaperSettings> & { preset?: string }): PaperSettings {
    this.requireIdle('changing the paper');
    let base = this.doc.paper;
    if (update.preset !== undefined && update.preset !== this.doc.paper.preset) {
      const p = paperPreset(update.preset);
      if (!p) throw new PaintEditorError(`Unknown paper "${update.preset}". Call list_papers for the ids.`);
      base = p;
    }
    const { preset: _p, ...rest } = update;
    if (rest.color !== undefined) parseColor(rest.color, 'paper color');
    const paper = normalizePaper({ ...rest, preset: base.preset }, base);
    const changedKeys = Object.keys(rest).filter((k) => k !== 'name');
    if (changedKeys.length && update.preset === undefined) paper.preset = base.preset;
    if (this.wet.world) this.beginWetOp();
    this.commit('Paper', { ...this.doc, paper });
    this.wet.paperChanged();
    return clonePaper(paper);
  }

  // --- Layers --------------------------------------------------------------------

  getLayer(id: string): PaintLayer | undefined {
    return findLayer(this.doc.layers, id)?.layer;
  }

  /** The active pixel layer (or `undefined`). */
  getActiveLayer(): PaintLayer | undefined {
    return this.doc.activeLayerId ? this.getLayer(this.doc.activeLayerId) : undefined;
  }

  /** Every layer, top first, as panels and tools describe them. */
  listLayers(): PaintLayerInfo[] {
    const out: PaintLayerInfo[] = [];
    const walk = (list: readonly PaintLayer[], parentId: string | null, depth: number) => {
      for (let i = list.length - 1; i >= 0; i--) {
        const l = list[i];
        out.push(this.describeLayer(l, parentId, depth));
        if (l.type === 'group') walk(l.children, l.id, depth + 1);
      }
    };
    walk(this.doc.layers, null, 0);
    return out;
  }

  describeLayer(l: PaintLayer, parentId: string | null = findLayer(this.doc.layers, l.id)?.parent?.id ?? null, depth = findLayer(this.doc.layers, l.id)?.path.length ?? 0): PaintLayerInfo {
    let bounds: RasterRect | null = null;
    if (l.type === 'pixel') {
      const b = contentBounds(l.surface);
      bounds = b ? { ...b, x: b.x + l.offset.x, y: b.y + l.offset.y } : null;
    } else for (const c of flattenLayers(l.children)) if (c.type === 'pixel') bounds = unionRect(bounds, this.describeLayer(c, l.id, depth + 1).bounds);
    return {
      id: l.id,
      name: l.name,
      type: l.type,
      visible: l.visible,
      opacity: l.opacity,
      blend: l.blend,
      clipped: Boolean(l.clipped),
      locks: { ...(l.locks ?? {}) },
      active: l.id === this.doc.activeLayerId,
      bounds,
      parentId,
      depth,
    };
  }

  private requireLayer(id: string): PaintLayer {
    const l = this.getLayer(id);
    if (!l) throw new PaintEditorError(`Unknown layer "${id}". Call list_layers for the ids.`);
    return l;
  }

  /** The pixel layer a paint operation targets, checked for locks and visibility. */
  private paintTarget(layerId: string | undefined, what: string): PaintPixelLayer {
    const id = layerId ?? this.doc.activeLayerId;
    if (!id) throw new PaintEditorError(`There is no active layer to ${what}; add one with add_layer.`);
    const l = this.requireLayer(id);
    if (!isPixelLayer(l)) throw new PaintEditorError(`Layer "${l.name}" is a group; ${what} a pixel layer inside it.`);
    if (isLayerLocked(l, 'pixels')) throw new PaintEditorError(`Layer "${l.name}" has its pixels locked; unlock it (update_layer locks) before you ${what} it.`);
    if (!l.visible) throw new PaintEditorError(`Layer "${l.name}" is hidden; show it (update_layer visible true) before you ${what} it.`);
    return l;
  }

  setActiveLayer(id: string): void {
    this.requireLayer(id);
    if (this.doc.activeLayerId === id) return;
    // Selection of the active layer is editor state, not an undo step: keep the history's documents.
    this.doc = { ...this.doc, activeLayerId: id };
    this.emit();
  }

  /** Adds an empty pixel layer or group above `aboveId` (default: the active layer) and makes it active. */
  addLayer(options: { name?: string; type?: 'pixel' | 'group'; aboveId?: string; parentId?: string | null } = {}): PaintLayerInfo {
    this.requireIdle('adding a layer');
    const count = flattenLayers(this.doc.layers).length;
    const type = options.type ?? 'pixel';
    const name = options.name?.trim() || (type === 'group' ? `Group ${count + 1}` : `Layer ${count + 1}`);
    const layer: PaintLayer =
      type === 'group' ? { type: 'group', id: newPaintLayerId(), name, visible: true, opacity: 1, blend: 'pass-through', children: [] } : createPaintLayer(name);
    let parentId: string | null = null;
    let index: number | undefined;
    const above = options.aboveId ?? (options.parentId === undefined ? this.doc.activeLayerId : null);
    if (options.parentId !== undefined && options.parentId !== null) {
      const g = this.requireLayer(options.parentId);
      if (g.type !== 'group') throw new PaintEditorError(`Layer "${g.name}" is not a group; pass a group id as parentId.`);
      parentId = g.id;
    } else if (above) {
      const loc = findLayer(this.doc.layers, above);
      if (!loc) throw new PaintEditorError(`Unknown layer "${above}". Call list_layers for the ids.`);
      parentId = loc.parent?.id ?? null;
      index = loc.index + 1;
    }
    const layers = insertLayer(this.doc.layers, layer, parentId, index);
    this.commit(type === 'group' ? 'Add group' : 'Add layer', { ...this.doc, layers, activeLayerId: layer.id });
    return this.describeLayer(layer);
  }

  updateLayer(id: string, update: LayerUpdate): PaintLayerInfo {
    this.requireIdle('changing a layer');
    const l = this.requireLayer(id);
    if (isLayerLocked(l, 'all') && Object.keys(update).some((k) => k !== 'locks')) throw new PaintEditorError(`Layer "${l.name}" is fully locked; unlock it first (locks {all: false}).`);
    if (update.opacity !== undefined && !(update.opacity >= 0 && update.opacity <= 1)) throw new PaintEditorError(`opacity ${update.opacity} is out of range; use 0..1.`);
    if (update.blend !== undefined && !isBlendMode(update.blend) && !(l.type === 'group' && update.blend === 'pass-through')) {
      throw new PaintEditorError(`Unknown blend mode "${update.blend}". Call get_canvas_info for the blend modes.`);
    }
    if (update.name !== undefined && !update.name.trim()) throw new PaintEditorError('name is empty; give the layer a name.');
    const next = { ...l } as PaintLayer;
    if (update.name !== undefined) next.name = update.name.trim();
    if (update.visible !== undefined) next.visible = update.visible;
    if (update.opacity !== undefined) next.opacity = update.opacity;
    if (update.blend !== undefined) (next as { blend: string }).blend = update.blend;
    if (update.clipped !== undefined) next.clipped = update.clipped || undefined;
    if (update.locks !== undefined) {
      const locks = { ...(l.locks ?? {}), ...update.locks };
      next.locks = Object.values(locks).some(Boolean) ? locks : undefined;
    }
    this.commit('Layer properties', { ...this.doc, layers: mapLayer(this.doc.layers, id, () => next) });
    return this.describeLayer(next);
  }

  removeLayer(id: string): { removed: string; activeLayerId: string | null } {
    this.requireIdle('removing a layer');
    const l = this.requireLayer(id);
    if (isLayerLocked(l, 'all')) throw new PaintEditorError(`Layer "${l.name}" is fully locked; unlock it before removing it.`);
    const wetIds = this.wet.wetLayerIds().filter((x) => x === id || (l.type === 'group' && findLayer(l.children, x)));
    if (wetIds.length) {
      this.beginWetOp();
      for (const x of wetIds) this.wet.world!.removeLane(x);
    }
    const layers = mapLayer(this.doc.layers, id, () => null);
    let active = this.doc.activeLayerId;
    if (active && !findLayer(layers, active)) active = flattenLayers(layers).filter((x) => x.type === 'pixel').pop()?.id ?? null;
    this.commit('Remove layer', { ...this.doc, layers, activeLayerId: active, ...this.thickWithout(flattenLayers([l]).map((x) => x.id)) });
    return { removed: id, activeLayerId: active };
  }

  duplicateLayer(id: string): PaintLayerInfo {
    this.requireIdle('duplicating a layer');
    if (findLayer(this.doc.layers, id)) {
      const inside = (l: PaintLayer): string[] => (l.type === 'group' ? l.children.flatMap(inside) : [l.id]);
      this.dryLayersFirst(inside(findLayer(this.doc.layers, id)!.layer));
    }
    const loc = findLayer(this.doc.layers, id);
    if (!loc) throw new PaintEditorError(`Unknown layer "${id}". Call list_layers for the ids.`);
    const thick: Record<string, ThickChannels> = { ...(this.doc.thick ?? {}) };
    const copy = (l: PaintLayer): PaintLayer => {
      const id = newPaintLayerId();
      if (thick[l.id]) thick[id] = thick[l.id];
      return l.type === 'group' ? { ...l, id, children: l.children.map(copy) } : { ...l, id };
    };
    const dup = { ...copy(loc.layer), name: `${loc.layer.name} copy` };
    const layers = insertLayer(this.doc.layers, dup, loc.parent?.id ?? null, loc.index + 1);
    this.commit('Duplicate layer', this.withWetEvents({ ...this.doc, layers, activeLayerId: dup.id, ...(this.doc.thick ? { thick } : {}) }));
    return this.describeLayer(dup);
  }

  /** Moves a layer to `index` (0 = bottom) within `parentId` (default its own parent; `null` = top level). */
  moveLayer(id: string, index: number, parentId?: string | null): PaintLayerInfo {
    this.requireIdle('moving a layer');
    const loc = findLayer(this.doc.layers, id);
    if (!loc) throw new PaintEditorError(`Unknown layer "${id}". Call list_layers for the ids.`);
    const target = parentId === undefined ? (loc.parent?.id ?? null) : parentId;
    if (target) {
      const g = this.requireLayer(target);
      if (g.type !== 'group') throw new PaintEditorError(`Layer "${g.name}" is not a group; pass a group id as parentId.`);
      if (target === id || (loc.layer.type === 'group' && findLayer(loc.layer.children, target))) throw new PaintEditorError('A group cannot move into itself.');
    }
    const without = mapLayer(this.doc.layers, id, () => null);
    const siblings = target ? (findLayer(without, target)!.layer as { children: PaintLayer[] }).children : without;
    if (!Number.isInteger(index) || index < 0 || index > siblings.length) throw new PaintEditorError(`index ${index} is out of range; use 0..${siblings.length} (0 is the bottom).`);
    const layers = insertLayer(without, loc.layer, target, index);
    this.commit('Move layer', { ...this.doc, layers });
    return this.describeLayer(loc.layer);
  }

  /** Merges a pixel layer into the pixel layer below it (keeping the lower one's settings). */
  mergeDown(id: string): PaintLayerInfo {
    this.requireIdle('merging');
    const pre = findLayer(this.doc.layers, id);
    if (pre) {
      const sib = pre.parent ? pre.parent.children : this.doc.layers;
      this.dryLayersFirst([id, sib[pre.index - 1]?.id].filter((x): x is string => Boolean(x)));
    }
    const loc = findLayer(this.doc.layers, id);
    if (!loc) throw new PaintEditorError(`Unknown layer "${id}". Call list_layers for the ids.`);
    const siblings = loc.parent ? loc.parent.children : this.doc.layers;
    const below = siblings[loc.index - 1];
    const upper = loc.layer;
    if (!isPixelLayer(upper) || !isPixelLayer(below)) throw new PaintEditorError('Merge down needs a pixel layer directly above another pixel layer in the same group.');
    if (isLayerLocked(below, 'pixels')) throw new PaintEditorError(`Layer "${below.name}" has its pixels locked; unlock it to merge into it.`);
    const rect = unionRect(this.describeLayer(below).bounds, this.describeLayer(upper).bounds);
    let surface = emptySurface(4);
    if (rect) {
      const base: PaintPixelLayer = { ...below, opacity: 1, blend: 'normal', visible: true, clipped: undefined, mask: undefined };
      // Thick paint on the upper layer merges as it is lit (its relief does not carry over).
      const upperLit = this.litLayers([upper])[0] as PaintPixelLayer;
      const px = createPaintCompositor().composite([base, upper.visible ? upperLit : { ...upperLit, opacity: 0 }] as ViewLayer[], rect, this.sources());
      surface = surfaceFromPixels({ width: rect.width, height: rect.height, data: px }, 4, rect.x, rect.y);
    }
    const merged: PaintPixelLayer = { ...below, surface, offset: { x: 0, y: 0 } };
    const layers = mapLayer(mapLayer(this.doc.layers, upper.id, () => null), below.id, () => merged);
    this.commit('Merge down', this.withWetEvents({ ...this.doc, layers, activeLayerId: below.id, ...this.thickWithout([upper.id]) }));
    return this.describeLayer(merged);
  }

  /** Removes every pixel of a layer. */
  clearLayer(layerId?: string): { layerId: string; bounds: RasterRect | null } {
    this.requireIdle('clearing');
    const l = this.paintTarget(layerId, 'clear');
    if (this.wet.wetLayerIds().includes(l.id)) {
      this.beginWetOp();
      this.wet.world!.removeLane(l.id);
    }
    const bounds = this.describeLayer(l).bounds;
    this.commit('Clear layer', this.withPaintEvent({ ...this.doc, layers: mapLayer(this.doc.layers, l.id, () => ({ ...l, surface: emptySurface(4) })), ...this.thickWithout([l.id]) }, { kind: 'clear', layerId: l.id }));
    return { layerId: l.id, bounds };
  }

  /**
   * Fills a layer across the canvas with a colour. With `grain` above 0 the fill follows the paper
   * grain (it catches the peaks, as pastel or charcoal rubbed across the sheet).
   */
  fillLayer(options: FillLayerOptions = {}): { layerId: string; bounds: RasterRect } {
    this.requireIdle('filling');
    this.paintTarget(options.layerId, 'fill');
    this.dryLayersFirst([options.layerId ?? this.doc.activeLayerId ?? '']);
    const l = this.paintTarget(options.layerId, 'fill');
    const color = options.color === undefined ? this.color : parseColor(options.color);
    const opacity = options.opacity ?? 1;
    if (!(opacity >= 0 && opacity <= 1)) throw new PaintEditorError(`opacity ${opacity} is out of range; use 0..1.`);
    const grainAmount = options.grain ?? 0;
    if (!(grainAmount >= 0 && grainAmount <= 1)) throw new PaintEditorError(`grain ${grainAmount} is out of range; use 0..1.`);
    const pressure = options.pressure ?? 0.5;
    const blend = options.blend ?? 'normal';
    if (!isBlendMode(blend)) throw new PaintEditorError(`Unknown blend mode "${blend}".`);
    const { width, height } = this.doc.canvas;
    const rect = { x: 0, y: 0, width, height };
    const coverage = new CoverageMap();
    const depth = grainAmount * this.doc.paper.depth;
    const grain = depth > 0 ? paperGrain(this.doc.paper) : null;
    for (const { tx, ty } of tilesInRect(rect)) {
      const r = { x: tx * TILE, y: ty * TILE, width: Math.min(TILE, width - tx * TILE), height: Math.min(TILE, height - ty * TILE) };
      const vals = new Float32Array(r.width * r.height);
      for (let y = 0, k = 0; y < r.height; y++) for (let x = 0; x < r.width; x++, k++) vals[k] = grain ? grainCatch(grain.at(r.x + x + 0.5, r.y + y + 0.5), depth, pressure) : 1;
      coverage.accumulate(r, vals, 1);
    }
    const apply: StrokeApply = {
      mode: 'paint',
      color: rgbaOf(color),
      background: rgbaOf(this.doc.paper.color),
      opacity,
      blend,
      lockTransparency: isLayerLocked(l, 'transparency'),
      selection: null,
      offset: l.offset,
    };
    const surface = this.applyCoverage(l, coverage, rect, apply);
    this.commit('Fill layer', this.withPaintEvent(this.withWetEvents({ ...this.doc, layers: mapLayer(this.doc.layers, l.id, () => ({ ...l, surface })) }), { kind: 'fill', layerId: l.id, data: { color, opacity, grain: grainAmount, pressure, blend } }));
    return { layerId: l.id, bounds: rect };
  }

  private applyCoverage(l: PaintPixelLayer, coverage: CoverageMap, rect: RasterRect, apply: StrokeApply): TiledSurface {
    const base = l.surface;
    const tiles = new Map(base.tiles);
    for (const { tx, ty } of tilesInRect({ x: rect.x - l.offset.x, y: rect.y - l.offset.y, width: rect.width, height: rect.height })) {
      const key = tileKey(tx, ty);
      const src = base.tiles.get(key)?.data ?? new Uint8ClampedArray(TILE * TILE * 4);
      const tile = finishTile(applyStrokeToTile(coverage, src, 4, tx, ty, apply), 4, 0);
      if (tile) tiles.set(key, tile);
      else tiles.delete(key);
    }
    return new TiledSurface(4, tiles, 0);
  }

  // --- Brushes -------------------------------------------------------------------

  private findBrush(id: string): PaintBrush | undefined {
    return BUILTIN_BRUSHES.find((b) => b.id === id) ?? this.userBrushes.find((b) => b.id === id);
  }

  /** A library brush by id (`undefined` when unknown). */
  getBrush(id: string): PaintBrush | undefined {
    const b = this.findBrush(id);
    return b ? normalizePaintBrush(b, b) : undefined;
  }

  private requireBrush(id: string): PaintBrush {
    const b = this.findBrush(id);
    if (!b) throw new PaintEditorError(`Unknown brush "${id}". Call list_brushes for the ids.`);
    return b;
  }

  /**
   * Chooses the active brush (`id`: a library brush) and / or changes its settings. Editor state,
   * not an undo step. Returns the active brush.
   */
  setBrush(update: { id?: string } & Omit<PaintBrushInput, 'id'> = {}): PaintBrush {
    const { id, ...changes } = update;
    const base = id !== undefined ? this.requireBrush(id) : this.brush;
    const next = normalizePaintBrush({ ...changes, id: base.id }, base);
    // The active brush is `builtin` only while it is an unchanged built-in preset.
    if (base.builtin && !Object.keys(changes).length) next.builtin = true;
    else delete next.builtin;
    this.brush = next;
    this.emit([]);
    return this.brush;
  }

  /** Saves the active brush (or `brush`) into the user library under `id` / `name`. */
  saveBrush(options: { id: string; name?: string; brush?: PaintBrushInput }): PaintBrush {
    if (!BRUSH_ID.test(options.id)) throw new PaintEditorError(`Brush id "${options.id}" is invalid; use lowercase letters, digits and dashes (e.g. "my-pencil").`);
    if (BUILTIN_BRUSHES.some((b) => b.id === options.id)) throw new PaintEditorError(`"${options.id}" is a built-in brush; save under another id.`);
    const source = options.brush ? normalizePaintBrush(options.brush, this.brush) : this.brush;
    const saved = normalizePaintBrush({ ...source, id: options.id, name: options.name ?? source.name });
    delete saved.builtin;
    const i = this.userBrushes.findIndex((b) => b.id === options.id);
    if (i >= 0) this.userBrushes[i] = saved;
    else this.userBrushes.push(saved);
    this.library = null;
    this.emit([]);
    return saved;
  }

  removeBrush(id: string): void {
    if (BUILTIN_BRUSHES.some((b) => b.id === id)) throw new PaintEditorError(`"${id}" is a built-in brush and cannot be removed.`);
    const i = this.userBrushes.findIndex((b) => b.id === id);
    if (i < 0) throw new PaintEditorError(`Unknown brush "${id}". Call list_brushes for the ids.`);
    this.userBrushes.splice(i, 1);
    this.library = null;
    this.emit([]);
  }

  /** The user's saved brushes. */
  getUserBrushes(): PaintBrush[] {
    return this.userBrushes.map((b) => normalizePaintBrush(b, b));
  }

  /** A brush library file of the given brushes (default: the user's brushes). */
  exportBrushes(ids?: readonly string[]): BrushLibraryFile {
    const list = ids ? ids.map((id) => this.requireBrush(id)) : this.userBrushes;
    return { format: 'pixerate-brushes', version: 1, brushes: list.map(brushToJSON) };
  }

  /**
   * Adds the brushes of a library file to the user library. A brush whose id is taken is skipped
   * unless `replace` (built-in ids are always skipped). Returns the ids added and the problems.
   */
  importBrushes(file: unknown, options: { replace?: boolean } = {}): { added: string[]; skipped: string[]; problems: string[] } {
    const problems: string[] = [];
    let list: PaintBrush[];
    try {
      list = parseBrushLibrary(file, problems);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    const added: string[] = [];
    const skipped: string[] = [];
    for (const b of list) {
      if (BUILTIN_BRUSHES.some((x) => x.id === b.id)) {
        skipped.push(b.id);
        problems.push(`"${b.id}" is a built-in brush id; rename it to import it.`);
        continue;
      }
      const i = this.userBrushes.findIndex((x) => x.id === b.id);
      if (i >= 0 && !options.replace) {
        skipped.push(b.id);
        continue;
      }
      if (i >= 0) this.userBrushes[i] = b;
      else this.userBrushes.push(b);
      added.push(b.id);
    }
    if (added.length) {
      this.library = null;
      this.emit([]);
    }
    return { added, skipped, problems };
  }

  /** A thumbnail of a brush: a test stroke on the current paper. */
  brushThumbnail(id: string, options: { width?: number; height?: number; color?: string } = {}): BrushThumbnail {
    const b = id === this.brush.id ? this.brush : this.requireBrush(id);
    return renderBrushThumbnail(b, { paper: this.doc.paper, width: options.width, height: options.height, color: options.color ? parseColor(options.color) : this.color });
  }

  // --- Colour --------------------------------------------------------------------

  setColor(color: string): string {
    this.color = parseColor(color);
    this.emit([]);
    return this.color;
  }

  setSecondaryColor(color: string): string {
    this.secondaryColor = parseColor(color);
    this.emit([]);
    return this.secondaryColor;
  }

  swapColors(): void {
    [this.color, this.secondaryColor] = [this.secondaryColor, this.color];
    this.emit([]);
  }

  /** The colour at a document pixel: of the composite (paper included) or of one layer. */
  pickColor(x: number, y: number, options: { layerId?: string } = {}): { color: string; alpha: number } {
    const { width, height } = this.doc.canvas;
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (!(px >= 0 && py >= 0 && px < width && py < height)) throw new PaintEditorError(`(${x}, ${y}) is outside the ${width}×${height} canvas.`);
    if (options.layerId !== undefined) {
      const l = this.requireLayer(options.layerId);
      if (!isPixelLayer(l)) throw new PaintEditorError(`Layer "${l.name}" is a group; pick from a pixel layer or the composite.`);
      const [r, g, b, a] = readPixel(l.surface, px - l.offset.x, py - l.offset.y);
      return { color: rgbToHex(r, g, b), alpha: Math.round((a / 255) * 1000) / 1000 };
    }
    const d = this.exportCompositor.composite(this.renderLayers({}), { x: px, y: py, width: 1, height: 1 }, this.sources());
    return { color: rgbToHex(d[0], d[1], d[2]), alpha: Math.round((d[3] / 255) * 1000) / 1000 };
  }

  // --- Mixer Brush ---------------------------------------------------------------

  /** Fills the Mixer Brush reservoir with a colour (default the editor colour). */
  loadMixerBrush(color?: string): MixerLoad {
    const [r, g, b] = hexToRgb8(color === undefined ? this.color : parseColor(color));
    this.mixerLoad = loadMixer(this.mixerLoad, [r / 255, g / 255, b / 255]);
    this.emit([]);
    return this.mixerLoad;
  }

  /** Empties the pickup well (and with `emptyReservoir` the loaded paint too). */
  cleanMixerBrush(emptyReservoir = false): MixerLoad {
    this.mixerLoad = emptyReservoir ? EMPTY_MIXER_LOAD : cleanMixer(this.mixerLoad);
    this.emit([]);
    return this.mixerLoad;
  }

  // --- View and hand -------------------------------------------------------------

  /** Zoom, pan, rotation and mirroring: view state only, the pixels never resample. */
  setView(update: Partial<PaintView>): PaintView {
    this.view = normalizeView(update, this.view);
    this.emit([]);
    return this.view;
  }

  resetView(): PaintView {
    return this.setView({ ...DEFAULT_VIEW, pan: { x: 0, y: 0 } });
  }

  setHand(hand: Hand): Hand {
    if (hand !== 'left' && hand !== 'right') throw new PaintEditorError(`hand is ${JSON.stringify(hand)}; use "left" or "right".`);
    this.hand = hand;
    this.emit([]);
    return hand;
  }

  // --- Strokes -------------------------------------------------------------------

  private strokeBrush(init: PaintStrokeInit): PaintBrush {
    let brush = init.brushId !== undefined ? this.requireBrush(init.brushId) : this.brush;
    if (init.brush) brush = normalizePaintBrush({ ...init.brush, id: brush.id }, brush);
    return brush;
  }

  /**
   * After a stroke: a Mixer Brush that loads colour keeps its whole load; any other dirty brush
   * keeps only the paint it carries (the reservoir stays the Mixer Brush's).
   */
  private keepLoad(brush: PaintBrush, load: MixerLoad): void {
    if (brush.engine === 'mixer' && brush.loadsColor) this.mixerLoad = load;
    else if (brush.behavior.dirty) this.mixerLoad = { ...this.mixerLoad, pickup: load.pickup };
  }

  /** Extra copies every new stroke paints (the painting guides add mirror and kaleidoscope copies). */
  protected strokeCopies(): Affine[] {
    return symmetryCopies(this.guides.symmetry);
  }

  private sessionFor(doc: PaintDocumentState, init: PaintStrokeInit, host: StrokeSessionHost): PaintStrokeSession {
    let layer = (() => {
      const id = init.layerId ?? doc.activeLayerId;
      if (!id) throw new PaintEditorError('There is no active layer to paint on; add one with add_layer.');
      const loc = findLayer(doc.layers, id);
      if (!loc) throw new PaintEditorError(`Unknown layer "${id}". Call list_layers for the ids.`);
      const l = loc.layer;
      if (!isPixelLayer(l)) throw new PaintEditorError(`Layer "${l.name}" is a group; paint on a pixel layer inside it.`);
      if (isLayerLocked(l, 'pixels')) throw new PaintEditorError(`Layer "${l.name}" has its pixels locked; unlock it (update_layer locks) to paint on it.`);
      if (!l.visible) throw new PaintEditorError(`Layer "${l.name}" is hidden; show it (update_layer visible true) to paint on it.`);
      return l;
    })();
    const brush = this.strokeBrush(init);
    let wet: { driver: WetStrokeDriver; surface: () => TiledSurface } | undefined;
    if (isWetBrush(brush)) {
      this.requireWetIdle('painting');
      if (layer.offset.x || layer.offset.y) {
        // The wet simulation works in canvas space: move the pixels into it (same picture, not an undo step).
        const moved: PaintPixelLayer = { ...layer, surface: translateSurface(layer.surface, layer.offset.x, layer.offset.y), offset: { x: 0, y: 0 } };
        this.doc = { ...this.doc, layers: mapLayer(this.doc.layers, layer.id, () => moved) };
        if (doc !== this.doc) doc = { ...doc, layers: mapLayer(doc.layers, layer.id, () => moved) };
        layer = moved;
      }
      if (!this.wet.wetLayerIds().includes(layer.id) && this.wet.wetLayerIds().length >= MAX_WET_LANES) {
        throw new PaintEditorError(`At most ${MAX_WET_LANES} layers can hold wet paint at once; dry one first (dry_paint).`);
      }
      this.beginWetOp();
      const world = this.wet.ensureLane(layer.id, brush.wet.medium);
      const id = layer.id;
      const [r, g, b] = hexToRgb8(init.color === undefined ? this.color : parseColor(init.color));
      const load = init.load ?? brushLoadForStroke(brush, this.mixerLoad, [r / 255, g / 255, b / 255]);
      const seedW = init.seed ?? mix32((this.seedCounter * 0x9e3779b1) >>> 0) & 0x7fffffff;
      const copiesW = (init.copies ?? this.strokeCopies()).filter((m) => m.some((v, i) => v !== IDENTITY_AFFINE[i]));
      const driver = new WetStrokeDriver({
        world,
        laneId: id,
        brush,
        color: [r / 255, g / 255, b / 255],
        load,
        grain: paperGrain(doc.paper),
        paperDepth: doc.paper.depth,
        paperColor: hexToRgb8(doc.paper.color),
        seed: seedW,
        copies: [IDENTITY_AFFINE, ...copiesW].map(affineCopy),
      });
      init = { ...init, seed: seedW, load };
      wet = { driver, surface: () => world.display(id).surface };
    } else if (this.wet.wetLayerIds().includes(layer.id)) {
      // A dry brush on wet paint: the paint dries first (in the same undo step).
      this.dryLayersFirst([layer.id]);
      const dried = findLayer(this.doc.layers, layer.id)!.layer as PaintPixelLayer;
      layer = dried;
    }
    let color = init.color === undefined ? this.color : parseColor(init.color);
    const tracing = this.guides.tracing;
    if (init.color === undefined && init.start && tracing?.visible && tracing.sampleColors) color = this.sampleTracingColor(init.start.x, init.start.y) ?? color;
    const perspective = this.guides.perspective;
    const snapper = init.snapToPerspective && perspective.enabled && perspective.snap ? new PerspectiveSnapper(perspective) : null;
    const rgba = rgbaOf(color);
    const seed = init.seed ?? mix32((this.seedCounter++ * 0x9e3779b1) >>> 0) & 0x7fffffff;
    const copies = (init.copies ?? this.strokeCopies()).filter((m) => m.some((v, i) => v !== IDENTITY_AFFINE[i]));
    const session = new PaintStrokeSession(host, {
      layerId: layer.id,
      surface: layer.surface,
      offset: layer.offset,
      lockTransparency: isLayerLocked(layer, 'transparency'),
      brush,
      color: rgba,
      background: rgbaOf(doc.paper.color),
      grain: paperGrain(doc.paper),
      paperDepth: doc.paper.depth,
      seed,
      colorHex: color,
      affineCopies: copies,
      copies: [IDENTITY_AFFINE, ...copies].map(affineCopy),
      inputFilter: snapper ? (p) => snapper.snap(p) : undefined,
      mixerLoad: init.load ?? brushLoadForStroke(brush, this.mixerLoad, [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255]),
      secondary: rgbaOf(this.secondaryColor),
      wet,
      thick: brush.engine === 'impasto' ? { channels: doc.thick?.[layer.id] ?? emptyThickChannels() } : undefined,
    });
    if (wet) this.wet.driver = wet.driver;
    return session;
  }

  private record(session: PaintStrokeSession): RecordedStroke {
    const init = session.init;
    const stroke: RecordedStroke = {
      id: `s${this.strokeCounter++}`,
      layerId: session.layerId,
      brush: brushToJSON(init.brush) as PaintBrush,
      color: init.colorHex,
      points: session.points.map((p) => ({ ...p })),
      seed: init.seed,
    };
    if (init.affineCopies.length) stroke.copies = init.affineCopies.map((m) => [...m] as unknown as Affine);
    if (init.mixerLoad.reservoir || init.mixerLoad.pickup) stroke.load = JSON.parse(JSON.stringify(init.mixerLoad));
    if (init.wet) stroke.steps = [...init.wet.driver.steps];
    return stroke;
  }

  /**
   * Starts a live stroke for pointer input: `push` raw pen samples (document pixels), then `end()`
   * (one undo step) or `cancel()`.
   */
  beginStroke(init: PaintStrokeInit = {}): PaintStrokeSession {
    this.requireIdle('starting another');
    const before = this.doc;
    const host: StrokeSessionHost = {
      update: (layerId, surface, rects) => {
        if (this.session?.init.wet) {
          // The wet layer's display is the layer's pixels: show it (not an undo step).
          this.wet.syncDisplays();
          return;
        }
        this.live = { layerId, surface };
        const ch = this.session?.thickChannels();
        this.liveThick = ch ? { layerId, channels: ch } : null;
        this.emit(rects);
      },
      commit: (s, surface, cancelled) => {
        this.session = null;
        this.live = null;
        this.liveLayers = null;
        this.liveThick = null;
        const wetStroke = Boolean(s.init.wet);
        if (wetStroke) this.wet.driver = null;
        const brush = s.init.brush;
        if (!cancelled && s.result?.mixerLoad) this.keepLoad(brush, s.result.mixerLoad);
        if (cancelled || !surface) {
          if (this.wetOp) {
            // Put the wet paint back as it was before the stroke.
            const snap = this.wetOp.before;
            this.wetOp = null;
            this.pendingWetEvents = [];
            if (wetStroke) this.wet.restore(snap);
            this.doc = { ...this.doc, layers: before.layers };
            this.wet.syncDisplays();
          }
          this.emit();
          return;
        }
        const stroke = this.record(s);
        s.result!.strokeId = stroke.id;
        if (wetStroke && this.wet.instantDry) {
          this.wet.dry(s.layerId);
          this.logWet({ kind: 'dry', layerId: s.layerId, at: this.doc.strokes.length + 1 });
          surface = (this.getLayer(s.layerId) as PaintPixelLayer).surface;
          s.result!.wet = this.wet.isWet(s.layerId);
        }
        const l = this.getLayer(s.layerId) as PaintPixelLayer;
        const ch = s.thickChannels();
        const thick = ch ? { ...(this.doc.thick ?? {}), [l.id]: ch } : this.doc.thick;
        this.commit(`${brush.name} stroke`, this.withWetEvents({ ...this.doc, layers: mapLayer(this.doc.layers, l.id, () => ({ ...l, surface })), strokes: [...this.doc.strokes, stroke], ...(thick ? { thick } : {}) }), wetStroke ? before : this.doc);
      },
    };
    let session: PaintStrokeSession;
    try {
      session = this.sessionFor(this.doc, { snapToPerspective: true, ...init }, host);
    } catch (e) {
      this.wetOp = null;
      throw e;
    }
    this.session = session;
    this.emit([]);
    return session;
  }

  /** The current live stroke, if any. */
  get activeStroke(): PaintStrokeSession | null {
    return this.session;
  }

  /** Runs a whole stroke against `doc` without touching the editor; returns the new document. */
  private runStroke(doc: PaintDocumentState, init: PaintStrokeInit, points: readonly PenPoint[]): { doc: PaintDocumentState; result: PaintStrokeResult; brush: PaintBrush } {
    let out = doc;
    const host: StrokeSessionHost = {
      update: () => {},
      commit: (s, surface, cancelled) => {
        if (cancelled || !surface) return;
        const stroke = this.record(s);
        s.result!.strokeId = stroke.id;
        const l = findLayer(out.layers, s.layerId)!.layer as PaintPixelLayer;
        const offset = s.init.wet ? { x: 0, y: 0 } : l.offset;
        const ch = s.thickChannels();
        out = { ...out, layers: mapLayer(out.layers, l.id, () => ({ ...l, surface, offset })), strokes: [...out.strokes, stroke], ...(ch ? { thick: { ...(out.thick ?? {}), [l.id]: ch } } : {}) };
      },
    };
    const session = this.sessionFor(doc, init, host);
    session.push(points);
    const result = session.end();
    if (session.init.wet) {
      this.wet.driver = null;
      if (this.wet.instantDry && result.strokeId) {
        this.wet.dry(session.layerId);
        this.logWet({ kind: 'dry', layerId: session.layerId, at: out.strokes.length });
        const dried = (findLayer(this.doc.layers, session.layerId)!.layer as PaintPixelLayer).surface;
        out = { ...out, layers: mapLayer(out.layers, session.layerId, (l) => ({ ...(l as PaintPixelLayer), surface: dried })) };
      }
      result.wet = this.wet.isWet(session.layerId);
    }
    return { doc: out, result, brush: session.init.brush };
  }

  /** Paints one stroke from data (one undo step). */
  paintStroke(init: PaintStrokeInit & { points: readonly PenPoint[] }): PaintStrokeResult {
    this.requireIdle('painting');
    const points = this.checkPoints(init.points);
    const before = this.doc;
    let run: ReturnType<PaintEditorController['runStroke']>;
    try {
      run = this.runStroke(this.doc, { ...init, start: init.start ?? points[0] }, points);
    } catch (e) {
      this.wetOp = null;
      throw e;
    }
    const { doc, result, brush } = run;
    if (result.mixerLoad) this.keepLoad(brush, result.mixerLoad);
    if (doc !== before || this.wetOp) this.commit(`${brush.name} stroke`, this.withWetEvents(doc), before);
    else this.emit([]);
    return result;
  }

  /** Checks stroke samples (finite x and y, pressure 0..1) and returns them; throws a sentence naming the bad point. */
  checkPoints(points: readonly PenPoint[]): PenPoint[] {
    if (!Array.isArray(points) || !points.length) throw new PaintEditorError('points is empty; give at least one {x, y} in document pixels.');
    const out: PenPoint[] = [];
    points.forEach((p, i) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new PaintEditorError(`points[${i}] needs finite x and y in document pixels.`);
      if (p.pressure !== undefined && !(p.pressure >= 0 && p.pressure <= 1)) throw new PaintEditorError(`points[${i}].pressure ${p.pressure} is out of range; use 0..1.`);
      out.push(p);
    });
    return out;
  }

  /** Every recorded stroke, oldest first. */
  getStrokes(): readonly RecordedStroke[] {
    return this.doc.strokes;
  }

  /**
   * Replays recorded strokes, varied (moved, scaled, rotated, flipped, recoloured, with another
   * brush or layer), `repeat` times: all of it one undo step. Returns the new strokes.
   */
  replayStrokes(options: ReplayOptions): { strokeIds: string[]; bounds: RasterRect | null; layerIds: string[] } {
    this.requireIdle('replaying');
    if (!options.strokeIds?.length) throw new PaintEditorError('strokeIds is empty; pass ids from list_strokes.');
    const strokes = options.strokeIds.map((id) => {
      const s = this.doc.strokes.find((x) => x.id === id);
      if (!s) throw new PaintEditorError(`Unknown stroke "${id}". Call list_strokes for the ids.`);
      return s;
    });
    const repeat = options.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new PaintEditorError(`repeat ${repeat} is out of range; use 1..100.`);
    if (options.scale !== undefined && !(options.scale > 0 && options.scale <= 20)) throw new PaintEditorError(`scale ${options.scale} is out of range; use above 0 up to 20.`);
    if (options.color !== undefined) parseColor(options.color);
    if (options.brushId !== undefined) this.requireBrush(options.brushId);
    if (options.layerId !== undefined) this.paintTarget(options.layerId, 'replay onto');
    let origin = options.origin;
    if (!origin) {
      const b = strokeBounds(strokes.flatMap((s) => s.points));
      origin = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    const step = variationAffine(options, origin);
    let doc = this.doc;
    let bounds: RasterRect | null = null;
    const ids: string[] = [];
    const layerIds = new Set<string>();
    let m: Affine = IDENTITY_AFFINE;
    for (let k = 0; k < repeat; k++) {
      m = [step[0] * m[0] + step[1] * m[2], step[0] * m[1] + step[1] * m[3], step[2] * m[0] + step[3] * m[2], step[2] * m[1] + step[3] * m[3], step[0] * m[4] + step[1] * m[5] + step[4], step[2] * m[4] + step[3] * m[5] + step[5]];
      for (const s of strokes) {
        const v = varyStroke(s, m, options);
        let brush = v.brush;
        if (options.brushId !== undefined) {
          const b = this.requireBrush(options.brushId);
          brush = normalizePaintBrush({ tip: { ...b.tip, size: b.tip.size * (v.brush.tip.size / s.brush.tip.size) } }, b);
        }
        const layerId = options.layerId ?? s.layerId;
        if (!findLayer(doc.layers, layerId)) throw new PaintEditorError(`Stroke "${s.id}" was painted on layer "${layerId}", which no longer exists; pass layerId to replay it elsewhere.`);
        // The recorded load replays the stroke exactly; a recolour reloads the reservoir with the new colour.
        let load = s.load;
        if (load && options.color !== undefined && load.reservoir) {
          const [r, g, b] = hexToRgb8(options.color);
          load = { ...load, reservoir: [r / 255, g / 255, b / 255] };
        }
        const run = this.runStroke(doc, { layerId, color: options.color ?? s.color, brush, seed: s.seed, copies: v.copies ?? [], ...(load && options.brushId === undefined ? { load } : {}) }, v.points);
        doc = run.doc;
        bounds = unionRect(bounds, run.result.bounds);
        if (run.result.strokeId) ids.push(run.result.strokeId);
        layerIds.add(layerId);
      }
    }
    if (doc !== this.doc) this.commit(strokes.length === 1 && repeat === 1 ? 'Replay stroke' : 'Replay strokes', doc);
    return { strokeIds: ids, bounds, layerIds: [...layerIds] };
  }

  // --- Thick paint and light -------------------------------------------------------

  /** The document's `thick` without these layers (as a spread: `{}` when unchanged). */
  private thickWithout(ids: readonly string[]): { thick?: Record<string, ThickChannels> } {
    const t = this.doc.thick;
    if (!t || !ids.some((id) => t[id])) return {};
    const out = { ...t };
    for (const id of ids) delete out[id];
    return { thick: out };
  }

  /** Where the light comes from for thick paint and metallic paper. */
  getLighting(): PaintLighting {
    return { ...this.lighting };
  }

  /** Moves the light (thick paint and metallic paper are relit; nothing is repainted). Saved with the document, not an undo step. */
  setLighting(update: Partial<PaintLighting>): PaintLighting {
    if (update.elevation !== undefined && !(update.elevation >= 5 && update.elevation <= 90)) throw new PaintEditorError(`elevation ${update.elevation} is out of range; use 5..90 degrees.`);
    if (update.relief !== undefined && !(update.relief >= 0 && update.relief <= 1)) throw new PaintEditorError(`relief ${update.relief} is out of range; use 0..1.`);
    this.lighting = normalizeLighting(update, this.lighting);
    this.emit('all');
    return { ...this.lighting };
  }

  /** A layer's relief: where it is, its highest point (0..255) and its tiles; `null` when it has none. */
  reliefOf(layerId?: string): { layerId: string; bounds: RasterRect | null; maxHeight: number } | null {
    const id = layerId ?? this.doc.activeLayerId;
    if (!id) return null;
    this.requireLayer(id);
    const ch = this.doc.thick?.[id];
    if (!ch) return null;
    const r = reliefInfo(ch);
    return { layerId: id, bounds: r.bounds, maxHeight: r.maxHeight };
  }

  /** Flattens a layer's thick paint (its colour stays; the relief and material go). One undo step. */
  flattenRelief(layerId?: string): { layerId: string; flattened: boolean } {
    this.requireIdle('flattening');
    const l = this.paintTarget(layerId, 'flatten');
    const t = this.thickWithout([l.id]);
    if (!t.thick) return { layerId: l.id, flattened: false };
    this.commit('Flatten relief', this.withPaintEvent({ ...this.doc, ...t }, { kind: 'flatten', layerId: l.id }));
    return { layerId: l.id, flattened: true };
  }

  // --- Replay: time-lapse and high-resolution export ------------------------------

  /**
   * A fresh, headless editor for replaying this painting at `scale` (canvas, dpi and paper grain
   * scaled; every pixel layer empty; the same brushes, lighting and wet options). Dispose of it
   * when done.
   */
  createReplayTarget(scale = 1): PaintEditorController {
    if (!(scale >= 1 && scale <= 8)) throw new PaintEditorError(`scale ${scale} is out of range; use 1..8.`);
    const { width, height, dpi } = this.doc.canvas;
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (w > 16384 || h > 16384) throw new PaintEditorError(`At scale ${scale} the canvas would be ${w}×${h}; the limit is 16384 px per side. Use a smaller scale.`);
    const target = new PaintEditorController({ width: w, height: h, dpi: dpi * scale, brushes: this.userBrushes, wet: this.wetOptions });
    const paper = { ...this.doc.paper, scale: Math.min(8, this.doc.paper.scale * scale) };
    target.adopt({ state: { canvas: target.doc.canvas, paper, layers: emptiedLayers(this.doc.layers), activeLayerId: this.doc.activeLayerId, strokes: [] }, extensions: {}, problems: [] });
    target.lighting = { ...this.lighting };
    return target;
  }

  /**
   * Repaints the painting from its recorded strokes and events, as a time-lapse: PNG frames (after
   * strokes, and while wet paint flows), a `VideoProject` of the frames as stills and the ffmpeg
   * command that renders it (the video editor's export path). Changes nothing here.
   */
  async timeLapse(options: TimeLapseOptions = {}): Promise<TimeLapse> {
    const target = this.createReplayTarget(1);
    try {
      return await buildTimeLapse(this.doc, target, options);
    } finally {
      target.dispose();
    }
  }

  /**
   * The painting repainted from its recorded strokes at `scale` times the size (brush sizes,
   * paper grain, fills and wet events scaled), wet paint dried: more detail instead of upscaled
   * pixels. Layers painted without recorded strokes (imported pixels) come out empty. Changes nothing here.
   */
  /** `renderHighRes` as PNG bytes. */
  async exportHighResPng(options: { scale: number; paper?: boolean }): Promise<Uint8Array> {
    const img = await this.renderHighRes(options);
    return encodePng(img.width, img.height, img.data);
  }

  async renderHighRes(options: { scale: number; paper?: boolean }): Promise<PixelImage> {
    const target = this.createReplayTarget(options.scale);
    try {
      await replayPainting(this.doc, target, { scale: options.scale });
      await target.wetIdle();
      return target.compositePixels({ paper: options.paper, wet: 'dried' });
    } finally {
      target.dispose();
    }
  }

  // --- Wet media -----------------------------------------------------------------

  /**
   * Lets wet paint flow with the wall clock: call every frame with `performance.now()` (the
   * bindings do). Steps at the wet speed unless paused; resolves when the frame's steps are done.
   */
  tickWet(now: number): Promise<void> {
    return this.wet.tick(now);
  }

  /** Resolves when the wet kernel is as fast as it will get here (`null` when nothing is wet yet). */
  wetReady(): Promise<WetBackendInfo | null> {
    return this.wet.world ? this.wet.world.ready : Promise.resolve(null);
  }

  /** Stops the wet simulation's worker threads (call when the editor goes away). */
  dispose(): void {
    this.wet.destroy();
  }

  /** Resolves when wet paint is between steps (edits, undo and exports can run). */
  wetIdle(): Promise<void> {
    return this.wet.idle();
  }

  private wetLayer(layerId: string | undefined, what: string): PaintPixelLayer {
    const id = layerId ?? this.doc.activeLayerId;
    if (!id) throw new PaintEditorError(`There is no active layer to ${what}; pass layerId (list_layers).`);
    const l = this.requireLayer(id);
    if (!isPixelLayer(l)) throw new PaintEditorError(`Layer "${l.name}" is a group; ${what} a pixel layer inside it.`);
    return l;
  }

  private checkRect(rect: RasterRect | undefined): RasterRect | undefined {
    if (!rect) return undefined;
    const { width, height } = this.doc.canvas;
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || !(rect.width > 0 && rect.height > 0)) throw new PaintEditorError('rect needs finite x, y and a width and height above 0 (document pixels).');
    const r = { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    if (r.x >= width || r.y >= height || r.x + r.width <= 0 || r.y + r.height <= 0) throw new PaintEditorError(`rect is outside the ${width}×${height} canvas.`);
    return r;
  }

  /** Wet media as panels and tools show it, with each wet layer's state. */
  wetState(): PaintWetStateInfo & { layers: WetLayerInfo[]; backend: WetBackendInfo | null; message: string | null } {
    const st = this.getState().wet;
    const backend = this.wet.backend();
    return { ...st, layers: this.wet.wetLayerIds().map((id) => this.wet.info(id)), backend, message: backend?.message ?? wetSupport().message };
  }

  /** One layer's wet settings and state. */
  wetLayerInfo(layerId?: string): WetLayerInfo {
    return this.wet.info(this.wetLayer(layerId, 'read the wet paint of').id);
  }

  /**
   * Lets the paint flow for `steps` simulation steps now (or `seconds` at the wet speed): what
   * agents call between strokes. Not an undo step (time passing never is). Returns the steps run
   * and which layers are still wet.
   */
  async advanceWet(options: { steps?: number; seconds?: number }): Promise<{ steps: number; clock: number; stillWet: boolean; layers: WetLayerInfo[] }> {
    const steps = options.steps ?? Math.round((options.seconds ?? 1) * this.wet.speed);
    if (!(Number.isInteger(steps) && steps >= 0 && steps <= 100000)) throw new PaintEditorError(`steps ${steps} is out of range; use 0..100000 (or seconds).`);
    const run = await this.wet.advance(steps);
    this.emit();
    const st = this.wetState();
    return { steps: run, clock: st.clock, stillWet: st.wet, layers: st.layers };
  }

  /**
   * Dries wet paint at once: everything settles where it is and the water goes (one undo step).
   * On one layer or all, optionally only inside `rect`. Returns what dried and whether anything is
   * still wet.
   */
  dryPaint(options: { layerId?: string; rect?: RasterRect } = {}): { dried: Array<{ layerId: string; bounds: RasterRect | null }>; stillWet: boolean } {
    this.requireIdle('drying');
    this.requireWetIdle('drying');
    if (options.layerId !== undefined) this.wetLayer(options.layerId, 'dry');
    const rect = this.checkRect(options.rect);
    const ids = options.layerId !== undefined ? this.wet.wetLayerIds().filter((x) => x === options.layerId) : this.wet.wetLayerIds();
    if (!ids.length) return { dried: [], stillWet: this.wet.isWet() };
    const before = this.doc;
    this.beginWetOp();
    const dried = ids.flatMap((id) => this.wet.dry(id, rect));
    this.logWet({ kind: 'dry', layerId: options.layerId, data: rect });
    this.commit('Dry paint', this.withWetEvents(this.doc), before);
    return { dried, stillWet: this.wet.isWet() };
  }

  /**
   * Pre-wets the paper (wet-in-wet): fills the paper's water over `rect` (default the canvas) by
   * `amount` 0..1 on a layer's wet layer, so paint laid there spreads softly. One undo step.
   */
  wetPaper(options: { layerId?: string; rect?: RasterRect; amount?: number } = {}): { layerId: string; rect: RasterRect; wet: boolean } {
    this.requireIdle('wetting the paper');
    const l = this.wetLayer(options.layerId, 'wet the paper of');
    if (isLayerLocked(l, 'pixels')) throw new PaintEditorError(`Layer "${l.name}" has its pixels locked; unlock it first.`);
    const amount = options.amount ?? 1;
    if (!(amount > 0 && amount <= 1)) throw new PaintEditorError(`amount ${amount} is out of range; use above 0 up to 1.`);
    const rect = this.checkRect(options.rect) ?? { x: 0, y: 0, width: this.doc.canvas.width, height: this.doc.canvas.height };
    if (!this.wet.wetLayerIds().includes(l.id) && this.wet.wetLayerIds().length >= MAX_WET_LANES) throw new PaintEditorError(`At most ${MAX_WET_LANES} layers can hold wet paint at once; dry one first (dry_paint).`);
    const before = this.doc;
    this.beginWetOp();
    const world = this.wet.ensureLane(l.id);
    world.wetPaper(l.id, rect, null, amount);
    this.wet.syncDisplays();
    this.logWet({ kind: 'wet-paper', layerId: l.id, data: { rect, amount } });
    this.commit('Wet paper', this.withWetEvents(this.doc), before);
    return { layerId: l.id, rect, wet: this.wet.isWet(l.id) };
  }

  /** Records a settings change as a wet event (not an undo step). */
  private recordWetSetting(e: Omit<WetEvent, 'clock'>): void {
    this.doc = { ...this.doc, wetEvents: [...(this.doc.wetEvents ?? []), { clock: this.wet.world?.clock ?? 0, at: this.doc.strokes.length, ...e }] };
  }

  /** Changes a layer's wet settings (viscosity, evaporation, granulation…). Editor settings saved with the document, not an undo step. */
  setWetParams(layerId: string | undefined, update: Partial<WetParams>): WetParams {
    const l = this.wetLayer(layerId, 'change the wet settings of');
    this.requireWetIdle('changing wet settings');
    const params = this.wet.setParams(l.id, update);
    this.recordWetSetting({ kind: 'params', layerId: l.id, data: params });
    this.emit([]);
    return params;
  }

  /** Sets a layer's flow map (water pushed in a pattern). Saved with the document, not an undo step. */
  setFlowMap(layerId: string | undefined, update: Partial<WetFlowSpec>): WetFlowSpec {
    const l = this.wetLayer(layerId, 'set the flow map of');
    this.requireWetIdle('changing the flow map');
    const flow = this.wet.setFlow(l.id, update);
    this.recordWetSetting({ kind: 'flow', layerId: l.id, data: flow });
    this.emit([]);
    return flow;
  }

  /** Tilts the canvas (water runs downhill; steep tilts make drips). Saved with the document, not an undo step. */
  setCanvasTilt(update: Partial<WetTilt>): WetTilt {
    this.requireWetIdle('tilting the canvas');
    if (update.angle !== undefined && !(update.angle >= 0 && update.angle <= 90)) throw new PaintEditorError(`angle ${update.angle} is out of range; use 0 (flat) .. 90 (upright) degrees.`);
    const tilt = this.wet.setTilt(update);
    this.recordWetSetting({ kind: 'tilt', data: tilt });
    this.emit([]);
    return tilt;
  }

  /** Stops (or restarts) time: paused paint stays wet. Editor state. */
  setWetPaused(paused: boolean): boolean {
    this.wet.paused = paused;
    this.emit([]);
    return paused;
  }

  /** Simulation steps per second while time runs (1..2000; default 120). Editor state. */
  setWetSpeed(speed: number): number {
    if (!(speed >= 1 && speed <= 2000)) throw new PaintEditorError(`speed ${speed} is out of range; use 1..2000 steps per second.`);
    this.wet.speed = speed;
    this.emit([]);
    return speed;
  }

  /** Wet strokes dry as soon as they end (each stroke still one undo step). Editor state. */
  setInstantDry(on: boolean): boolean {
    this.wet.instantDry = on;
    this.emit([]);
    return on;
  }

  /** Shows or hides the water overlay (where the water is, view only). */
  setWaterOverlay(visible: boolean): boolean {
    this.wet.overlay = visible;
    this.emit([]);
    return visible;
  }

  /** The water overlay's tiles over a document rectangle (RGBA, view only). */
  waterOverlayTiles(rect: RasterRect): Array<{ tx: number; ty: number; data: Uint8ClampedArray }> {
    if (this.wet.busy) return [];
    return this.wet.waterOverlay(rect);
  }

  // --- Rendering -----------------------------------------------------------------

  private sources() {
    return { width: this.doc.canvas.width, height: this.doc.canvas.height };
  }

  /** The layers with the live stroke's surface in place. */
  private currentLayers(): PaintLayer[] {
    const live = this.live;
    if (!live) return this.doc.layers;
    if (this.liveLayers?.key === live.surface) return this.liveLayers.layers;
    const layers = mapLayer(this.doc.layers, live.layerId, (l) => ({ ...(l as PaintPixelLayer), surface: live.surface }));
    this.liveLayers = { key: live.surface, layers };
    return layers;
  }

  /** View-only layers between the paper and the paint (the painting guides add the tracing image). */
  protected underlayLayers(): ViewLayer[] {
    const t = this.guides.tracing;
    if (!t || !t.visible) return [];
    return [this.tracingNode(t)];
  }

  /** The tracing image resampled onto the canvas (cached until it or the canvas changes). */
  private tracingNode(t: TracingImage): ImageNode {
    const { width, height } = this.doc.canvas;
    const key = this.tracingVersion * 100003 + width * 7 + height;
    if (this.tracingCache?.key === key && this.tracingCache.node.opacity === t.opacity) return this.tracingCache.node;
    const src = this.imagePixels.get(t.src) ?? this.decodeImage(t.src);
    const image = resampleInto(src, t.rect, width, height);
    const node: ImageNode = { type: 'image', id: TRACING_NODE_ID, name: 'Tracing', visible: true, opacity: t.opacity, blend: 'normal', image, version: key + Math.round(t.opacity * 1000) / 1e4 };
    this.tracingCache = { key, node };
    return node;
  }

  /** The layers with every wet layer dried where it is (what saving and exporting see). */
  private driedLayers(layers: PaintLayer[] = this.currentLayers()): PaintLayer[] {
    const ids = this.wet.wetLayerIds();
    if (!ids.length) return layers;
    this.requireWetIdle('exporting');
    let out = layers;
    for (const id of ids) {
      const baked = this.wet.bakedSurface(id);
      if (baked && findLayer(out, id)) out = mapLayer(out, id, (l) => ({ ...(l as PaintPixelLayer), surface: baked }));
    }
    return out;
  }

  /** The layers with thick paint lit (each thick layer's pixels replaced by its lit tiles). */
  private litLayers(layers: PaintLayer[]): PaintLayer[] {
    const thick = this.doc.thick;
    const live = this.liveThick;
    if (!thick && !live) return layers;
    let out = layers;
    const ids = new Set([...Object.keys(thick ?? {}), ...(live ? [live.layerId] : [])]);
    for (const id of ids) {
      const ch = live?.layerId === id ? live.channels : thick?.[id];
      const l = ch && findLayer(out, id)?.layer;
      if (!ch || !isPixelLayer(l)) continue;
      let cache = this.litCaches.get(id);
      if (!cache) this.litCaches.set(id, (cache = new LitCache()));
      const lit = cache.lit(l.surface, ch, this.lighting);
      if (lit !== l.surface) out = mapLayer(out, id, () => ({ ...l, surface: lit }));
    }
    return out;
  }

  private renderLayers(options: RenderOptions, view = false): ViewLayer[] {
    let layers: PaintLayer[] = this.litLayers((options.wet ?? 'display') === 'dried' ? this.driedLayers() : this.currentLayers());
    if (options.layerIds) {
      const picked: PaintLayer[] = [];
      for (const id of options.layerIds) picked.push(findLayer(layers, id)?.layer ?? this.requireLayer(id));
      layers = picked.map((l) => ({ ...l, visible: true }) as PaintLayer);
    }
    const under: ViewLayer[] = options.paper === false ? [] : [paperNode(this.doc.paper, this.lighting)];
    if (view) under.push(...this.underlayLayers());
    return [...under, ...layers];
  }

  /**
   * Composites the viewport stack (paper, view-only underlays, layers with the live stroke) tile by
   * tile over `rect`, calling `onTile` with each 256 px tile's RGBA (cached: unchanged tiles come back
   * as the same buffer). Pass `takeDirty()` as `dirty`.
   */
  compositeTiles(rect: RasterRect, onTile: (tx: number, ty: number, data: Uint8ClampedArray, changed: boolean) => void, options: { dirty?: RasterRect[] | 'all' } = {}): void {
    const dirty = options.dirty === 'all' ? undefined : options.dirty;
    this.viewCompositor.compositeTiles(this.renderLayers({}, true), rect, this.sources(), onTile, { dirty, checkpointLayerId: this.live?.layerId ?? this.doc.activeLayerId });
  }

  /** The canvas as canvas-sized RGBA (paper included by default). */
  compositePixels(options: RenderOptions = {}): PixelImage {
    const { width, height } = this.doc.canvas;
    const data = this.exportCompositor.composite(this.renderLayers({ ...options, wet: options.wet ?? 'dried' }), { x: 0, y: 0, width, height }, this.sources());
    return { width, height, data };
  }

  /** The canvas (or some layers), scaled so the longest side is at most `maxSide`. */
  renderPreview(options: RenderOptions & { maxSide?: number } = {}): PixelImage {
    const full = this.compositePixels({ ...options, wet: options.wet ?? 'display' });
    const side = Math.max(1, Math.round(options.maxSide ?? 512));
    const k = Math.min(1, side / Math.max(full.width, full.height));
    if (k >= 1) return full;
    const w = Math.max(1, Math.round(full.width * k));
    const h = Math.max(1, Math.round(full.height * k));
    return { width: w, height: h, data: downsampleRgba(full.data, full.width, full.height, w, h) };
  }

  // --- Save, load and export -------------------------------------------------------

  /** The document as JSON with inline PNG assets. */
  /** The document as saved: wet paint dried where it is (deterministically); wet settings as data. */
  private savedState(): PaintDocumentState {
    const layers = this.driedLayers(this.doc.layers);
    return layers === this.doc.layers ? this.doc : { ...this.doc, layers };
  }

  /** Wet settings saved with the document (`null` when they are all defaults). */
  private wetJSON(): unknown {
    const layers: Record<string, WetLayerSettings> = {};
    for (const [id, set] of this.wet.settings) if (findLayer(this.doc.layers, id)) layers[id] = { params: { ...set.params }, flow: { ...set.flow } };
    const flat = this.wet.tilt.angle === 0;
    if (!Object.keys(layers).length && flat) return undefined;
    return { tilt: { ...this.wet.tilt }, layers };
  }

  private readWet(raw: unknown, problems: string[]): void {
    this.wet.reset();
    if (!raw || typeof raw !== 'object') return;
    const r = raw as { tilt?: unknown; layers?: unknown };
    this.wet.setTilt(normalizeTilt((r.tilt as Partial<WetTilt>) ?? {}));
    if (r.layers && typeof r.layers === 'object') {
      for (const [id, v] of Object.entries(r.layers as Record<string, unknown>)) {
        if (!v || typeof v !== 'object') {
          problems.push(`wet.layers["${id}"] is not wet settings; skipped.`);
          continue;
        }
        const x = v as { params?: Partial<WetParams>; flow?: Partial<WetFlowSpec> };
        this.wet.settings.set(id, { params: normalizeWetParams(x.params ?? {}), flow: normalizeFlow(x.flow ?? {}) });
      }
    }
  }

  /** Thick paint and light as saved (`layerChannels`, `lighting`), merged into the extensions. */
  private thickExtensions(): PaintDocumentExtensions {
    const ext: PaintDocumentExtensions = { ...this.extensions };
    const channels: Record<string, unknown> = {};
    for (const [id, ch] of Object.entries(this.doc.thick ?? {})) {
      if (!findLayer(this.doc.layers, id)) continue;
      const saved = thickToJSON(ch);
      if (saved) channels[id] = saved;
    }
    if (Object.keys(channels).length) ext.layerChannels = channels;
    else delete ext.layerChannels;
    if (this.lighting.azimuth !== DEFAULT_LIGHTING.azimuth || this.lighting.elevation !== DEFAULT_LIGHTING.elevation || this.lighting.relief !== DEFAULT_LIGHTING.relief) ext.lighting = { ...this.lighting };
    else delete ext.lighting;
    return ext;
  }

  /** Reads `layerChannels` and `lighting` from loaded extensions into the document. */
  private readThick(state: PaintDocumentState, ext: PaintDocumentExtensions, problems: string[]): PaintDocumentState {
    this.lighting = normalizeLighting((ext.lighting as Partial<PaintLighting>) ?? {}, DEFAULT_LIGHTING);
    this.litCaches.clear();
    const raw = ext.layerChannels;
    if (!raw || typeof raw !== 'object') return state;
    const thick: Record<string, ThickChannels> = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!findLayer(state.layers, id)) continue;
      try {
        thick[id] = thickFromJSON(v);
      } catch (e) {
        problems.push(`The thick paint of layer "${id}" could not be read (${(e as Error).message}); it loads flat.`);
      }
    }
    return Object.keys(thick).length ? { ...state, thick } : state;
  }

  toJSON(options: { strokes?: boolean } = {}): SerializedPaintDocument {
    return serializePaintDocument(this.savedState(), { strokes: options.strokes, extensions: this.thickExtensions(), guides: this.guides, swatches: this.swatches, mixingPad: this.mixingPadJSON(), wet: this.wetJSON() });
  }

  /** The document as JSON with each PNG stored in `store`. */
  toJSONExternal(store: PaintAssetStore, options: { strokes?: boolean } = {}): Promise<SerializedPaintDocument> {
    return serializePaintDocumentExternal(this.savedState(), store, { strokes: options.strokes, extensions: this.thickExtensions(), guides: this.guides, swatches: this.swatches, mixingPad: this.mixingPadJSON(), wet: this.wetJSON() });
  }

  private adopt(loaded: { state: PaintDocumentState; extensions: PaintDocumentExtensions; problems: string[]; guides?: unknown; swatches?: unknown; mixingPad?: unknown; wet?: unknown }): string[] {
    this.extensions = loaded.extensions;
    this.readWet(loaded.wet, loaded.problems);
    this.readMixingPad(loaded.mixingPad, loaded.problems);
    this.readGuides(loaded.guides, loaded.state, loaded.problems);
    if (Array.isArray(loaded.swatches)) {
      this.swatches = loaded.swatches
        .filter((x): x is Swatch => Boolean(x) && typeof (x as Swatch).color === 'string' && /^#[0-9a-f]{6}$/i.test((x as Swatch).color))
        .map((x) => (typeof x.name === 'string' ? { color: x.color.toLowerCase(), name: x.name } : { color: x.color.toLowerCase() }));
    }
    for (const s of loaded.state.strokes) {
      const n = Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0);
      if (n >= this.strokeCounter) this.strokeCounter = n + 1;
    }
    this.undoStack = [];
    this.redoStack = [];
    this.doc = this.readThick(loaded.state, loaded.extensions, loaded.problems);
    delete this.extensions.layerChannels;
    delete this.extensions.lighting;
    this.viewCompositor.clear();
    this.emit();
    return loaded.problems;
  }

  /** Opens a saved document (clears the history). Returns what could not be read. */
  loadJSON(raw: unknown): string[] {
    this.requireIdle('opening a document');
    try {
      return this.adopt(deserializePaintDocument(raw));
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
  }

  /** Opens a saved document whose assets may live in `store`. */
  async loadJSONAsync(raw: unknown, store?: PaintAssetStore): Promise<string[]> {
    this.requireIdle('opening a document');
    try {
      return this.adopt(await deserializePaintDocumentAsync(raw, store));
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
  }

  /** The canvas as PNG bytes (paper included by default; `scale` below 1 shrinks it). */
  exportPng(options: RenderOptions & { scale?: number } = {}): Uint8Array {
    const img = this.scaled(options);
    return encodePng(img.width, img.height, img.data);
  }

  private scaled(options: RenderOptions & { scale?: number }): PixelImage {
    const full = this.compositePixels(options);
    const s = options.scale ?? 1;
    if (!(s > 0 && s <= 1)) throw new PaintEditorError(`scale ${s} is out of range; use above 0 up to 1 (exports never upscale pixels).`);
    if (s === 1) return full;
    const w = Math.max(1, Math.round(full.width * s));
    const h = Math.max(1, Math.round(full.height * s));
    return { width: w, height: h, data: downsampleRgba(full.data, full.width, full.height, w, h) };
  }

  /**
   * The canvas as PNG, JPEG or WebP bytes. JPEG has no alpha, so it always includes the paper.
   * JPEG and WebP need a canvas (a browser or Worker) or the `encodeImage` option.
   */
  async exportImage(options: RenderOptions & { format?: ImageFormat; quality?: number; scale?: number } = {}): Promise<Uint8Array> {
    const format = options.format ?? 'image/png';
    if (format === 'image/png') return this.exportPng(options);
    if (format !== 'image/jpeg' && format !== 'image/webp') throw new PaintEditorError(`format ${JSON.stringify(format)} is not supported; use image/png, image/jpeg or image/webp.`);
    const quality = options.quality ?? 0.92;
    if (!(quality >= 0 && quality <= 1)) throw new PaintEditorError(`quality ${quality} is out of range; use 0..1.`);
    const img = this.scaled({ ...options, paper: format === 'image/jpeg' ? true : options.paper });
    const encode = this.encodeImage ?? defaultImageEncoder();
    if (!encode) throw new PaintEditorError(`${format} needs a canvas to encode and there is none here; pass encodeImage to the controller, or export PNG.`);
    return encode(img, format, quality);
  }

  /**
   * The document as an 8-bit RGB PSD through the shared PSD writer: every layer and group, with
   * the paper as a locked "Paper" pixel layer at the bottom (it is generated, so PSD gets its
   * pixels), and the composite as the merged image.
   */
  exportPsd(): PsdExportResult {
    const dried = this.litLayers(this.driedLayers(this.doc.layers));
    const { width, height, dpi } = this.doc.canvas;
    const paperPixels = this.compositePixels({ layerIds: [], paper: true });
    const paperLayer: PaintPixelLayer = {
      type: 'pixel',
      id: 'paper',
      name: 'Paper',
      visible: true,
      opacity: 1,
      blend: 'normal',
      locks: { all: true },
      surface: surfaceFromPixels(paperPixels, 4),
      offset: { x: 0, y: 0 },
    };
    const merged = this.compositePixels({ paper: true }).data;
    // PSD has no pigment or painterly modes: write each as its nearest standard mode and say so.
    const changed = new Map<BlendMode, string[]>();
    const toStandard = (layers: readonly PaintLayer[]): PaintLayer[] =>
      layers.map((l) => {
        const blend = l.blend === 'pass-through' ? l.blend : standardBlendMode(l.blend as BlendMode);
        if (blend !== l.blend) changed.set(l.blend as BlendMode, [...(changed.get(l.blend as BlendMode) ?? []), l.name]);
        const next = blend === l.blend ? l : ({ ...l, blend } as PaintLayer);
        return next.type === 'group' ? { ...next, children: toStandard(next.children) } : next;
      });
    const layers = toStandard(dried);
    const result = exportPsd({ width, height, layers: [paperLayer, ...layers] as unknown as ImageLayer[], merged, resolution: dpi });
    for (const [mode, names] of changed) {
      const label = BLEND_MODES.find((m) => m.id === mode)?.label ?? mode;
      const std = BLEND_MODES.find((m) => m.id === standardBlendMode(mode))?.label ?? standardBlendMode(mode);
      const list = names.map((n) => `"${n}"`).join(', ');
      const one = names.length === 1;
      result.warnings.push(`${label} blending has no PSD equivalent; ${list} ${one ? 'was' : 'were'} written as ${std}, the nearest Photoshop mode, so ${one ? 'it looks' : 'they look'} different in Photoshop (the merged image is exact).`);
    }
    return result;
  }

  /** `render_preview` as a base64 PNG. */
  previewPngBase64(options: RenderOptions & { maxSide?: number } = {}): { data: string; width: number; height: number } {
    const img = this.renderPreview(options);
    return { data: bytesToBase64(encodePng(img.width, img.height, img.data)), width: img.width, height: img.height };
  }

  // --- Guides --------------------------------------------------------------------

  private setGuides(next: PaintGuides): PaintGuides {
    this.guides = next;
    this.emit('all');
    return next;
  }

  /** Mirror and kaleidoscope painting: every new stroke paints its copies too (one stroke, one undo step). */
  setSymmetry(update: Partial<SymmetryGuide>): SymmetryGuide {
    const symmetry = normalizeSymmetry(update, this.guides.symmetry);
    this.setGuides({ ...this.guides, symmetry });
    return symmetry;
  }

  /** Perspective guides with one to three vanishing points that pointer strokes snap to. */
  setPerspective(update: Partial<PerspectiveGuide>): PerspectiveGuide {
    let perspective: PerspectiveGuide;
    try {
      perspective = normalizePerspective(update, this.guides.perspective);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    this.setGuides({ ...this.guides, perspective });
    return perspective;
  }

  /** An image from a PNG (base64 or data URL) or from RGBA pixels, stored as a PNG data URL. */
  private importImage(input: { png?: string; pixels?: PixelImage }, what: string): { src: string; pixels: PixelImage } {
    let pixels: PixelImage;
    if (input.pixels) {
      const { width, height, data } = input.pixels;
      if (!(width > 0 && height > 0 && Number.isInteger(width) && Number.isInteger(height)) || data.length !== width * height * 4) {
        throw new PaintEditorError(`${what}: pixels must be width × height × 4 bytes of RGBA.`);
      }
      pixels = { width, height, data: new Uint8ClampedArray(data) };
    } else if (typeof input.png === 'string' && input.png.trim()) {
      pixels = this.decodeImage(input.png.trim().startsWith('data:') ? input.png.trim() : `data:image/png;base64,${input.png.trim()}`, what);
    } else throw new PaintEditorError(`${what}: pass png (a PNG as base64 or a data URL) or pixels.`);
    if (pixels.width > MAX_IMAGE_SIDE || pixels.height > MAX_IMAGE_SIDE) throw new PaintEditorError(`${what} is ${pixels.width}×${pixels.height}; the limit is ${MAX_IMAGE_SIDE} px per side.`);
    const src = pngDataUrl(pixels.width, pixels.height, pixels.data);
    this.imagePixels.set(src, pixels);
    return { src, pixels };
  }

  private decodeImage(src: string, what = 'Image'): PixelImage {
    const cached = this.imagePixels.get(src);
    if (cached) return cached;
    const parsed = parseDataUrl(src);
    if (!parsed) throw new PaintEditorError(`${what} is not a data URL or base64 PNG.`);
    try {
      const png = decodePng(parsed.bytes);
      const px = { width: png.width, height: png.height, data: png.data };
      this.imagePixels.set(src, px);
      return px;
    } catch (e) {
      throw new PaintEditorError(`${what} could not be decoded as a PNG (${(e as Error).message}); decode other formats in the browser and pass pixels.`);
    }
  }

  /**
   * Puts an image under the paint to trace over: view only, never in exports. Placed to fit the
   * canvas unless `rect` is given; `sampleColors` makes strokes take their colour from it.
   */
  setTracingImage(options: { png?: string; pixels?: PixelImage; rect?: TracingImage['rect']; opacity?: number; sampleColors?: boolean }): TracingImage {
    const { src, pixels } = this.importImage(options, 'The tracing image');
    const { width, height } = this.doc.canvas;
    const k = Math.min(width / pixels.width, height / pixels.height);
    const fit = { x: (width - pixels.width * k) / 2, y: (height - pixels.height * k) / 2, width: pixels.width * k, height: pixels.height * k };
    const tracing: TracingImage = { src, width: pixels.width, height: pixels.height, rect: fit, opacity: 0.35, visible: true, sampleColors: false };
    return this.updateTracing({ ...options, rect: options.rect ?? fit }, tracing);
  }

  /** Changes the tracing image's opacity, visibility, placement or colour sampling. */
  updateTracing(update: Partial<Pick<TracingImage, 'opacity' | 'visible' | 'sampleColors' | 'rect'>>, base = this.guides.tracing): TracingImage {
    if (!base) throw new PaintEditorError('There is no tracing image; set one with set_tracing_image first.');
    if (update.opacity !== undefined && !(update.opacity >= 0 && update.opacity <= 1)) throw new PaintEditorError(`opacity ${update.opacity} is out of range; use 0..1.`);
    if (update.rect && !(update.rect.width > 0 && update.rect.height > 0)) throw new PaintEditorError('rect needs a width and height above 0.');
    const tracing: TracingImage = {
      ...base,
      ...(update.opacity !== undefined ? { opacity: update.opacity } : {}),
      ...(update.visible !== undefined ? { visible: update.visible } : {}),
      ...(update.sampleColors !== undefined ? { sampleColors: update.sampleColors } : {}),
      ...(update.rect ? { rect: { ...update.rect } } : {}),
    };
    if (tracing.src !== base.src || update.rect) this.tracingVersion++;
    if (base !== this.guides.tracing) this.tracingVersion++;
    this.setGuides({ ...this.guides, tracing });
    return tracing;
  }

  clearTracingImage(): void {
    this.tracingVersion++;
    this.setGuides({ ...this.guides, tracing: null });
  }

  /** The tracing image's colour at a document pixel, or `null` outside it or where it is clear. */
  sampleTracingColor(x: number, y: number): string | null {
    const t = this.guides.tracing;
    if (!t) return null;
    const src = this.decodeImage(t.src);
    const u = Math.floor(((x - t.rect.x) / t.rect.width) * src.width);
    const v = Math.floor(((y - t.rect.y) / t.rect.height) * src.height);
    if (u < 0 || v < 0 || u >= src.width || v >= src.height) return null;
    const i = (v * src.width + u) * 4;
    if (src.data[i + 3] === 0) return null;
    return rgbToHex(src.data[i], src.data[i + 1], src.data[i + 2]);
  }

  /** Adds a floating reference image to look at and pick colours from. */
  addReferenceImage(options: { png?: string; pixels?: PixelImage; name?: string; x?: number; y?: number; displayWidth?: number }): ReferenceImage {
    const { src, pixels } = this.importImage(options, 'The reference image');
    const ref: ReferenceImage = {
      id: `ref${this.nextReferenceId++}`,
      name: options.name?.trim() || `Reference ${this.guides.references.length + 1}`,
      src,
      width: pixels.width,
      height: pixels.height,
      x: options.x ?? 16 + this.guides.references.length * 24,
      y: options.y ?? 16 + this.guides.references.length * 24,
      displayWidth: options.displayWidth ?? Math.min(240, pixels.width),
      visible: true,
    };
    this.setGuides({ ...this.guides, references: [...this.guides.references, ref] });
    return ref;
  }

  private requireReference(id: string): ReferenceImage {
    const r = this.guides.references.find((x) => x.id === id);
    if (!r) throw new PaintEditorError(`Unknown reference image "${id}". Call list_reference_images for the ids.`);
    return r;
  }

  /** Moves, resizes, renames, shows or hides a reference image. */
  updateReferenceImage(id: string, update: Partial<Pick<ReferenceImage, 'name' | 'x' | 'y' | 'displayWidth' | 'visible'>>): ReferenceImage {
    const r = this.requireReference(id);
    if (update.displayWidth !== undefined && !(update.displayWidth >= 16 && update.displayWidth <= 4096)) throw new PaintEditorError(`displayWidth ${update.displayWidth} is out of range; use 16..4096.`);
    const next: ReferenceImage = { ...r, ...Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)) };
    this.setGuides({ ...this.guides, references: this.guides.references.map((x) => (x.id === id ? next : x)) });
    return next;
  }

  removeReferenceImage(id: string): void {
    this.requireReference(id);
    this.setGuides({ ...this.guides, references: this.guides.references.filter((x) => x.id !== id) });
  }

  /** A reference image's pixels (decoded once). */
  referencePixels(id: string): PixelImage {
    return this.decodeImage(this.requireReference(id).src);
  }

  /** The colour of a reference image at its pixel (x, y). */
  pickReferenceColor(id: string, x: number, y: number): string {
    const r = this.requireReference(id);
    const px = this.decodeImage(r.src);
    const u = Math.floor(x);
    const v = Math.floor(y);
    if (!(u >= 0 && v >= 0 && u < px.width && v < px.height)) throw new PaintEditorError(`(${x}, ${y}) is outside reference "${r.name}" (${px.width}×${px.height}); use its own pixel coordinates.`);
    const i = (v * px.width + u) * 4;
    return rgbToHex(px.data[i], px.data[i + 1], px.data[i + 2]);
  }

  private readGuides(raw: unknown, state: PaintDocumentState, problems: string[]): void {
    const base = defaultGuides(state.canvas);
    this.guides = base;
    this.tracingVersion++;
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const guides: PaintGuides = { ...base };
    guides.symmetry = normalizeSymmetry((r.symmetry as Record<string, unknown>) ?? {}, base.symmetry);
    try {
      guides.perspective = normalizePerspective((r.perspective as Record<string, unknown>) ?? {}, base.perspective);
    } catch (e) {
      problems.push(`Perspective guide: ${(e as Error).message}`);
    }
    const t = r.tracing as TracingImage | null | undefined;
    if (t && typeof t.src === 'string') {
      try {
        const px = this.decodeImage(t.src, 'The tracing image');
        guides.tracing = {
          src: t.src,
          width: px.width,
          height: px.height,
          rect: t.rect && t.rect.width > 0 && t.rect.height > 0 ? { ...t.rect } : { x: 0, y: 0, width: state.canvas.width, height: state.canvas.height },
          opacity: typeof t.opacity === 'number' ? Math.min(1, Math.max(0, t.opacity)) : 0.35,
          visible: t.visible !== false,
          sampleColors: t.sampleColors === true,
        };
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    if (Array.isArray(r.references)) {
      for (const ref of r.references as ReferenceImage[]) {
        if (!ref || typeof ref.src !== 'string' || typeof ref.id !== 'string') continue;
        try {
          const px = this.decodeImage(ref.src, `Reference "${ref.name}"`);
          guides.references.push({ id: ref.id, name: String(ref.name ?? ref.id), src: ref.src, width: px.width, height: px.height, x: Number(ref.x) || 0, y: Number(ref.y) || 0, displayWidth: Number(ref.displayWidth) || 240, visible: ref.visible !== false });
          const n = Number(/^ref(\d+)$/.exec(ref.id)?.[1] ?? 0);
          if (n >= this.nextReferenceId) this.nextReferenceId = n + 1;
        } catch (e) {
          problems.push((e as Error).message);
        }
      }
    }
    this.guides = guides;
  }

  // --- Swatches and harmonies ------------------------------------------------------

  /** Colour harmonies around a colour (default the paint colour) on the painter's RYB wheel or the RGB wheel. */
  harmony(kind: HarmonyKind, options: { color?: string; wheel?: ColorWheel; spread?: number } = {}): HarmonyColor[] {
    try {
      return colorHarmony(options.color === undefined ? this.color : parseColor(options.color), kind, options);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
  }

  addSwatch(color: string, name?: string): Swatch[] {
    const c = parseColor(color);
    this.swatches = [...this.swatches, name?.trim() ? { color: c, name: name.trim() } : { color: c }];
    this.emit([]);
    return this.swatches;
  }

  removeSwatch(index: number): Swatch[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.swatches.length) throw new PaintEditorError(`index ${index} is out of range; there are ${this.swatches.length} swatches (0-based).`);
    this.swatches = this.swatches.filter((_, i) => i !== index);
    this.emit([]);
    return this.swatches;
  }

  setSwatches(swatches: readonly Swatch[]): Swatch[] {
    this.swatches = swatches.map((x) => (x.name ? { color: parseColor(x.color), name: x.name } : { color: parseColor(x.color) }));
    this.emit([]);
    return this.swatches;
  }

  // --- Mixing pad ------------------------------------------------------------------

  get mixingPad(): MixingPad {
    return this.pad;
  }

  /** Paints (`paint`) or smears with the palette knife (`knife`) on the mixing pad, in pad pixels. */
  mixingPadStroke(points: readonly PenPoint[], options: { tool?: MixingPadTool; color?: string; size?: number } = {}): { bounds: RasterRect | null } {
    const color = options.color === undefined ? this.color : parseColor(options.color);
    if (options.size !== undefined && !(options.size >= 1 && options.size <= 200)) throw new PaintEditorError(`size ${options.size} is out of range; use 1..200 px.`);
    try {
      const r = this.pad.stroke(points, { tool: options.tool ?? 'paint', color, size: options.size });
      this.emit([]);
      return r;
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
  }

  /** Picks the mixed colour on the pad (averaged over `radius` px); with `setColor` it becomes the paint colour. */
  mixingPadPick(x: number, y: number, options: { radius?: number; setColor?: boolean } = {}): string | null {
    let c: string | null;
    try {
      c = this.pad.pick(x, y, options.radius);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    if (c && options.setColor) this.setColor(c);
    return c;
  }

  clearMixingPad(): void {
    this.pad.clear();
    this.emit([]);
  }

  /**
   * Mixes paints on the pad like a painter: blobs in proportion to their `parts`, knife passes,
   * and a fully mixed core of the Kubelka-Munk mix (see `MixingPad.mix`). With `setColor` the
   * mix becomes the paint colour. Returns the mixed colour and the pile's bounds.
   */
  mixOnPad(paints: readonly { color: string; parts: number }[], options: PadMixOptions & { setColor?: boolean } = {}): { color: string; bounds: RasterRect } {
    const parsed = (paints ?? []).map((p, i) => ({ color: parseColor(p?.color, `paints[${i}].color`), parts: p?.parts }));
    let r: { color: string | null; bounds: RasterRect };
    try {
      r = this.pad.mix(parsed, options);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    const color = r.color ?? parsed[0].color;
    this.emit([]);
    if (options.setColor) this.setColor(color);
    return { color, bounds: r.bounds };
  }

  /** The mixing pad as a PNG data URL (with alpha). */
  mixingPadPng(): string {
    return this.pad.toPng();
  }

  /** Replaces the mixing pad with a PNG (data URL or base64, 360 × 220). */
  setMixingPadPng(png: string): void {
    try {
      this.pad.fromPng(png);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    this.emit([]);
  }

  /** The mixing pads kept by name. */
  listMixingPads(): SavedMixingPadInfo[] {
    return this.savedPads.map(({ id, name }) => ({ id, name }));
  }

  /** Keeps the mixing pad as it is now under `name` (saved with the document). Returns its id. */
  saveMixingPad(name?: string): SavedMixingPadInfo {
    if (this.pad.empty) throw new PaintEditorError('The mixing pad is empty; put paint on it (mixing_pad_stroke or mix_on_pad) before saving it.');
    const label = (typeof name === 'string' && name.trim() ? name.trim() : `Pad ${this.nextPadId}`).slice(0, 80);
    const pad: SavedMixingPad = { id: `pad${this.nextPadId++}`, name: label, png: this.pad.toPng() };
    this.savedPads.push(pad);
    this.emit([]);
    return { id: pad.id, name: pad.name };
  }

  private requirePad(id: string): SavedMixingPad {
    const p = this.savedPads.find((x) => x.id === id);
    if (!p) throw new PaintEditorError(`Unknown mixing pad "${id}". Call list_mixing_pads for the ids.`);
    return p;
  }

  /** Puts a kept pad back on the mixing pad (replacing what is there). */
  loadMixingPad(id: string): SavedMixingPadInfo {
    const p = this.requirePad(id);
    this.setMixingPadPng(p.png);
    return { id: p.id, name: p.name };
  }

  /** Forgets a kept pad. */
  removeMixingPad(id: string): SavedMixingPadInfo {
    const p = this.requirePad(id);
    this.savedPads = this.savedPads.filter((x) => x !== p);
    this.emit([]);
    return { id: p.id, name: p.name };
  }

  private mixingPadJSON(): { current?: string; saved: SavedMixingPad[] } | undefined {
    if (this.pad.empty && !this.savedPads.length) return undefined;
    return { ...(this.pad.empty ? {} : { current: this.pad.toPng() }), saved: this.savedPads.map((p) => ({ ...p })) };
  }

  private readMixingPad(raw: unknown, problems: string[]): void {
    this.savedPads = [];
    this.nextPadId = 1;
    this.pad.clear();
    if (raw === undefined || raw === null) return;
    const r = raw as { current?: unknown; saved?: unknown };
    if (typeof r.current === 'string') {
      try {
        this.pad.fromPng(r.current);
      } catch (e) {
        problems.push(`The mixing pad could not be read (${(e as Error).message}); it starts empty.`);
      }
    }
    if (Array.isArray(r.saved)) {
      r.saved.forEach((p, i) => {
        const x = p as Partial<SavedMixingPad>;
        if (!x || typeof x.png !== 'string' || typeof x.name !== 'string') {
          problems.push(`mixingPad.saved[${i}] is not a saved pad; skipped.`);
          return;
        }
        const id = typeof x.id === 'string' && /^pad\d+$/.test(x.id) ? x.id : `pad${this.nextPadId}`;
        const n = Number(id.slice(3));
        if (n >= this.nextPadId) this.nextPadId = n + 1;
        this.savedPads.push({ id, name: x.name, png: x.png });
      });
    }
  }

  /** A layer's tile surface (live while stroking), for thumbnails. */
  layerSurface(id: string): TiledSurface | null {
    const l = findLayer(this.currentLayers(), id)?.layer;
    return isPixelLayer(l) ? l.surface : null;
  }
}

export type { Tile };

/** Largest tracing or reference image side, in pixels. */
export const MAX_IMAGE_SIDE = 8192;

/** `src` drawn into `rect` of a `width × height` canvas (bilinear), canvas-sized RGBA. */
function resampleInto(src: PixelImage, rect: { x: number; y: number; width: number; height: number }, width: number, height: number): PixelImage {
  const out = new Uint8ClampedArray(width * height * 4);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  const sx = src.width / rect.width;
  const sy = src.height / rect.height;
  const d = src.data;
  for (let y = y0; y < y1; y++) {
    const v = Math.min(src.height - 1, Math.max(0, (y + 0.5 - rect.y) * sy - 0.5));
    const j0 = Math.floor(v);
    const j1 = Math.min(src.height - 1, j0 + 1);
    const fy = v - j0;
    for (let x = x0; x < x1; x++) {
      const u = (x + 0.5 - rect.x) * sx - 0.5;
      if (u < -0.5 || u > src.width - 0.5 || (y + 0.5 - rect.y) * sy < 0 || (y + 0.5 - rect.y) * sy > src.height) continue;
      const uc = Math.min(src.width - 1, Math.max(0, u));
      const i0 = Math.floor(uc);
      const i1 = Math.min(src.width - 1, i0 + 1);
      const fx = uc - i0;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = d[(j0 * src.width + i0) * 4 + c] + (d[(j0 * src.width + i1) * 4 + c] - d[(j0 * src.width + i0) * 4 + c]) * fx;
        const b = d[(j1 * src.width + i0) * 4 + c] + (d[(j1 * src.width + i1) * 4 + c] - d[(j1 * src.width + i0) * 4 + c]) * fx;
        out[o + c] = a + (b - a) * fy;
      }
    }
  }
  return { width, height, data: out };
}
