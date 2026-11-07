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
import { paintSourceColor, parsePaintSource, PaintSourceError, resolvePaintGradient, type PaintGradientSource, type PaintSource } from '../paint/gradient-paint';
import { BLEND_MODES, isBlendMode, standardBlendMode, type BlendMode } from '../raster/blend';
import { findLayer, flattenLayers, insertLayer, isLayerLocked, mapLayer, type LayerLocks } from '../raster/layers';
import {
  defaultLayerEffect,
  isLayerEffectKind,
  LAYER_EFFECT_KINDS,
  LayerEffectError,
  layerEffectLabel,
  mergeLayerEffect,
  newEffectId,
  validateLayerEffects,
  type LayerEffect,
  type LayerEffectKind,
  type LayerEffects,
} from '../raster/effects/model';
import type { EffectPattern } from '../raster/effects/patterns';
import { bytesToBase64, decodePng, encodePng, parseDataUrl, pngDataUrl } from '../raster/png';
import {
  translateSurface,
  contentBounds,
  readRegion,
  writeRegion,
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
import {
  fillRegionMask,
  findUnfilledRegionsMask,
  type FillRegionPoint,
  type FillRegionSummary,
  type UnfilledRegion,
} from '../raster/fill';
import { PIGMENT_UNIT } from '../paint/wet/film';
import { WetMedium } from '../paint/wet/medium';
import { brushToJSON, DEFAULT_BRUSH_ID, normalizePaintBrush, type PaintBrushInput, BRUSH_ID, type PaintBrush } from './brushes';
import { BrushLibraryError, closest, createBrushLibrary, type BrushLibrary, type BrushLibraryFile } from '../brushes/library';
import { migrateBrushV1 } from '../brushes/migrate';
import { normalizeBrushSpec } from '../brushes/normalize';
import { mergeBrushPatch, type BrushPatch, type UnsettableBrushFacet } from '../brushes/patch';
import { resolveBrush } from '../brushes/resolve';
import type { Brush } from '../brushes/types';
import { brushStickerRefs } from './stamp-tip';
import { brushColourHex } from '../brushes/colour';
import type { ColorScheme, ColorValue } from '../color/dual';
import { brushSpecOf, builtinLibraryBrushes, copyJSON, engineChanges, libraryBrush, seededStorage, type LibraryBrush } from './brush-library';
import {
  createPaintDocument,
  createPaintLayer,
  MAX_CANVAS_SIDE,
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
import { samplePath, type PathSampleOptions } from './path-samples';
import type { Hand } from './input';
import { mix32 } from './noise';
import { clonePaper, grainCatch, hexToRgb8, normalizePaper, paperPreset, type PaperSettings } from './paper';
import { createPaintCompositor, downsampleRgba, paperGrain, paperNode, PAPER_EFFECT_NODE_ID, TRACING_NODE_ID, type ImageNode, type ViewLayer } from './render';
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
import { affineCopy, normalizeBrushStroke, strokeToJSON, strokeBounds, variationAffine, varyStroke, IDENTITY_AFFINE, type Affine, type RecordedStroke, type StrokeVariation } from './strokes';
import { renderBrushThumbnail, type BrushThumbnail } from './thumbnails';
import { colorHarmony, DEFAULT_SWATCHES, readSwatch, type ColorWheel, type HarmonyColor, type HarmonyKind, type Swatch } from './color';
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
import { normalizeStencil, StencilSnapper, stencilMask, translateStencil, type Stencil, type StencilInput } from './stencils';
import { normalizeStickerUpdate, stickerAt as hitSticker, stickerRect, stickerStamp, stickerSurface, type Sticker } from './stickers';
import { defaultStickerRasterizer, StickerArtCache, type StickerArtLookup, type StickerRasterizer } from './sticker-art';
import { BrushSourceArtCache, engineBrushSourceIds } from './brush-source-art';
import { isBrushSourceRef, readBrushSource } from '../brushes/sources';
import { editorStickers } from '../stickers/editor';
import { editorStampOf, normalizeStickerRef, StickersSlot } from '../stickers/helpers';
import type { StickerProvider, StickerRef, StickerVariant } from '../stickers/types';
import { liveStrokeBounds, liveStrokeRefusal } from './live-strokes';
import { BacklightCache, backlightOf, type BacklitLayer } from './backlight';
import { DEFAULT_LIGHT_SPILL, LightCache, emptyLight, lightFromJSON, lightInfo, lightToJSON, mergeLight, normalizeLightSpill, scaleLight, type LightSpill } from './light';
import { DEFAULT_VIEW, normalizeView, viewMatrix, type PaintView } from './view';
import { brushTakesPaint } from './brushes';
import { PaintWetLayers, WET_GPU_MODES, WetStrokeDriver, type PaintWetOptions, type WetEngineInfo, type WetEvent, type WetGpuMode, type WetLayerInfo, type WetLayerSettings } from './wet';
import { isWetBrush } from './brushes';
import { normalizeWetParams, normalizeTilt, type WetParams, type WetTilt } from '../paint/wet/model';
import { normalizeFlow, type WetFlowSpec } from '../paint/wet/flow';
import { MAX_WET_LANES, type WetBackendInfo, type WetGhostState, type WetSnapshot } from '../paint/wet/world';
import {
  LIVE_PATTERN_KINDS,
  LIVE_PATTERN_PRESETS,
  normalizeLivePatterns,
  type LivePatternKind,
  type LivePatternStats,
  type LivePatternsInput,
  type LivePatternsSettings,
} from '../paint/live-patterns';
import { wetSupport } from '../paint/wet/wasm';
import { buildTimeLapse, emptiedLayers, replayPainting, type TimeLapse, type TimeLapseOptions } from './replay';
import { EffectsSlot, pathControlsOf, resolveEffectValues } from '../effects/helpers.js';
import type { EffectDescription, EffectPixels, EffectProvider, EffectValue } from '../effects/types.js';
import { effectPaintKey, effectPaintSize, isPaintEffectPaint, readEffectStrokeMap, readPaintEffectPaint, withStrokePath, type EffectPaintPixels, type PaintEffectPaint } from './effect-paint';
import { checkPaintEffectPlace, effectLayersToJSON, mixPixels, nextPaperEffectVersion, overPixels, PaintEffectsRenderer, PAPER_EFFECT_BLENDS, paperEffectFromJSON, paperEffectToJSON, readPaintEffectSource, type PaintEffectPlace, type PaintEffectSource, type PaintPaperEffect, type PaperEffectBlend } from './effects';
import { DEFAULT_LIGHTING, DEFAULT_VIEW_TILT, emptyThickChannels, FilmBuffer, hasThickChannels, LitCache, normalizeLighting, normalizeViewTilt, reliefInfo, thickFromJSON, thickToJSON, type PaintLighting, type PaintViewTilt, type ThickChannels } from './thick';
import {
  DEFAULT_UV_LIGHT,
  HEAT_DRY_THRESHOLD,
  ThermoCache,
  UvCache,
  advanceHeatField,
  cloneHeatField,
  createHeatField,
  emptyFluor,
  emptyThermo,
  fluorFromJSON,
  fluorToJSON,
  heatFromJSON,
  heatStats,
  heatToJSON,
  hotCellsBounds,
  mergeFourChannel,
  normalizeUvLight,
  paintHeatField,
  sampleHeatAt,
  scaleFluor,
  shiftHeatField,
  thermoFromJSON,
  thermoToJSON,
  uvPaper,
  type HeatField,
  type HeatSample,
  type HeatStats,
  type UvLightSettings,
} from './heat';
import {
  mutationBrushRefusal,
  type PaintMutationAnswerInput,
  type PaintMutationAnswerResult,
  type PaintMutationInfo,
  type PaintMutationMedium,
  type PaintMutationReadResult,
  type PaintMutationRequestListener,
  type PaintMutationState,
  type PaintMutationStroke,
} from './mutation';
import type { PaintDirector, PaintStrokesResult } from './presence';
import type { PresenceActorInfo } from '../animation/presence';
import { createPaintProposals, type PaintProposals } from './collaboration';
import {
  crossoverGenomes,
  describeGenomeDiff,
  mutateGenome,
  normalizeMutationRates,
  proposalGenomeStrokes,
  type BreedStrokesResult,
  type BredProposalSummary,
  type ProposalGenomeResult,
  type StrokeMutationRates,
} from './evolution';

/** A refusal with a message that says what is wrong and how to fix it. */
/** Runs `fn`, turning an effect validation error into a `PaintEditorError` with the same message. */
function effectGuard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof LayerEffectError) throw new PaintEditorError(e.message);
    throw e;
  }
}

export class PaintEditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaintEditorError';
  }
}

/** Library errors as the paint editor's own. */
async function libraryCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw e instanceof BrushLibraryError ? new PaintEditorError(e.message) : e;
  }
}

export interface PaintEditorOptions extends Partial<PaintCanvas> {
  /** Paper settings, or a library preset id (default cold pressed). */
  paper?: Partial<PaperSettings> | string;
  /** Active brush id (default `pencil-6b`). */
  brushId?: string;
  /**
   * The brush library: built-in presets plus saved brushes, on any storage. Pass one library to
   * every editor so a brush saved in one shows in all of them (default: a library in memory).
   */
  brushLibrary?: BrushLibrary;
  /** Saved user brushes to start the default library with (or to add to `brushLibrary`). */
  brushes?: readonly PaintBrush[];
  /**
   * The host's colour scheme (default `light`): a brush's light / dark default colour resolves to
   * its side when the brush is chosen and when a stroke starts. Follow the host with `setColorScheme`.
   */
  colorScheme?: ColorScheme;
  /** Paint colour #rrggbb (default #1f2937). */
  color?: string;
  hand?: Hand;
  /** Encodes JPEG / WebP (default: a canvas, when there is one). */
  encodeImage?: ImageEncoder;
  /** Undo steps kept (default 200). */
  historyLimit?: number;
  /** Wet media: kernel, threads, speed (steps per second) and the memory kept for undoing wet strokes. */
  wet?: PaintWetOptions;
  /** The sticker library (default the editor's own stamps, `editorStickers()`); see `setStickersProvider`. */
  stickers?: StickerProvider;
  /**
   * Draws a provider sticker's SVG or `https:` art to RGBA (default: PNG data URLs anywhere, the
   * rest with the browser's `createImageBitmap` and `OffscreenCanvas`).
   */
  rasterizeSticker?: StickerRasterizer;
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
  /** Engine B (WebGPU): `auto` (used for large wet areas when there is a GPU) or `off` (CPU only). */
  gpu: WetGpuMode;
  /** Engine B is shading the wet paint now. */
  gpuActive: boolean;
}

/** One layer's Gray-Scott live-pattern state and wet coverage. */
export interface PaintLayerLivePatternsInfo extends LivePatternStats {
  layerId: string;
  wet: boolean;
  wetCells: number;
  wetBounds: RasterRect | null;
}

export interface PaintEditorState {
  document: PaintDocumentState;
  /** The active brush (possibly edited from its preset). */
  brush: PaintBrush;
  /** The brush library: built-in presets, then the user's brushes. */
  brushes: readonly PaintBrush[];
  /** Paint colour #rrggbb. */
  color: string;
  /** The colour scheme light / dark brush colours resolve for. */
  colorScheme: ColorScheme;
  /** Locked: choosing a brush with a default colour keeps the paint colour. */
  colorLocked: boolean;
  /** The second colour (swap with `swapColors`). */
  secondaryColor: string;
  /**
   * What strokes paint with: the paint colour, or gradient paint (`setPaint`). A brush with its
   * own gradient (`brush.paint`) paints that instead.
   */
  paint: PaintSource;
  /**
   * Effect paint (`setEffectPaint`): a provider effect strokes take each pixel's colour from,
   * instead of `paint`; `null` when they paint `paint`. `setColor` and `setPaint` clear it.
   */
  effectPaint: PaintEffectPaint | null;
  /** The effect paint is still rendering: strokes that would paint with it wait (they throw). */
  effectPaintRendering: boolean;
  /** What the Mixer Brush carries between strokes. */
  mixerLoad: MixerLoad;
  view: PaintView;
  /** View tilt for thin-film iridescence and specular highlights (-1..1, default {x: 0, y: 0}; editor state, not saved with the document). */
  viewTilt: PaintViewTilt;
  hand: Hand;
  /** Live effect paint: whether strokes on stroke layers play their effect, the frame rate cap and the time (ms) the view shows. Editor state. */
  effectPlayback: { playing: boolean; fps: number; time: number };
  /** The stroke picked on a stroke layer, on the canvas or in the stroke panel (editor state, not an undo step). */
  selectedStroke: string | null;
  /** The sticker picked on the canvas or in the sticker panel (editor state, not an undo step). */
  selectedSticker: string | null;
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
  /** The UV / blacklight view setting (saved with the document, not undo steps). */
  uvLight: UvLightSettings;
  /** The coarse heat field's temperature summary. */
  heat: HeatStats;
  /** Pending and active mutation exchanges (editor state, not saved with the document). */
  mutations: readonly PaintMutationInfo[];
  /** Whether an agent is listening for mutation requests (`onMutationRequest` or `setMutationAgentConnected`). */
  hasMutationAgent: boolean;
  /** Increments on every change. */
  version: number;
}

/** A layer as tools and panels describe it. */
/** A change to a live stroke (`updateStroke`): every field is optional. */
export interface LiveStrokeUpdate {
  /** Another brush preset; the stroke keeps its size. */
  brushId?: string;
  /** Brush settings to change (as `setBrush` takes), on top of `brushId` or the stroke's brush. */
  brush?: Omit<PaintBrushInput, 'id'>;
  /** A new colour #rrggbb (replaces gradient or effect paint). */
  color?: string;
  /** Paint: a colour, gradient paint or effect paint; `null` back to the plain colour. */
  paint?: unknown;
  /** Another jitter seed (particles, scatter and texture fall differently). */
  seed?: number;
}

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
  /** A live stroke layer (its pixels are drawn from its strokes, which stay editable): how many strokes it has. */
  liveStrokes?: number;
  /** How many live layer effects (glows, shadows, strokes…) it has, when any (`getLayerEffects`). */
  effects?: number;
  /** A temporary layer created for a dry mutation stroke (fades away once claimed or merges down if unanswered). */
  temporary?: boolean;
}

/** A live stroke as it is painted (`onStrokeSample`), for agents that paint along with the user. */
export interface PaintStrokeSample {
  /** `begin`: the pen went down. `points`: new samples. `end`: the stroke was recorded. `cancel`: it was abandoned. */
  phase: 'begin' | 'points' | 'end' | 'cancel';
  layerId: string;
  brush: PaintBrush;
  /** #rrggbb */
  color: string;
  /** Every raw sample so far (document pixels), in order. */
  points: readonly PenPoint[];
  /** The samples this event added (`points` only). */
  added: readonly PenPoint[];
  /** `end`: the recorded stroke's id, or `null` when it painted nothing. */
  strokeId?: string | null;
}

/** One change to the paint history, for hosts and change feeds (`onCommit`). */
export interface PaintCommitEvent {
  /** `execute`: a new undo step. `merge`: folded into the last one (a slider drag). */
  kind: 'execute' | 'merge' | 'undo' | 'redo';
  /** The step's name. */
  label: string;
  /** Who made the step: `user`, or `agent:<id>` (see `withOrigin`). */
  origin: string;
}

/** Paint a preview produced (`previewPaint`), in document coordinates, straight RGBA. */
export interface PaintPreview {
  /** Where the new paint sits, or `null` when nothing was painted. */
  bounds: RasterRect | null;
  /** The new paint alone: `bounds.width × bounds.height` pixels (empty when nothing was painted). */
  pixels: Uint8ClampedArray;
  /** The whole picture as it would look with the new paint, inside `bounds` (with the paper; empty when nothing was painted). */
  composite: Uint8ClampedArray;
}

/** Where `previewPaint` puts its layer: above a layer (default the active one), or at the bottom of the stack. */
export interface PaintPreviewPlacement {
  aboveId?: string;
  bottom?: boolean;
}

export interface PaintStrokeInit {
  /** Default the active layer. */
  layerId?: string;
  /** Default the editor colour. */
  color?: string;
  /**
   * What this stroke paints with, instead of the editor's paint: a colour, gradient paint
   * (`@pixerate/editor/paint` `PaintSource`), or effect paint (render it first with
   * `prepareEffectPaints`). A colour here is the same as `color`.
   */
  paint?: PaintSource | PaintEffectPaint | string;
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
  /** Follow guide stencils and keep to mask stencils (default true; replays pass false, their points already follow them). */
  stencils?: boolean;
  /** Mask with these stencils instead (replays pass the ones recorded with the stroke). */
  maskStencils?: readonly Stencil[];
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

export type FillReference = 'layer' | 'all' | 'composite' | (string & {});

export interface FillRegionOptions {
  /** Seed x in document pixels (pass `x` and `y`, or `points`). */
  x?: number;
  /** Seed y in document pixels (pass `x` and `y`, or `points`). */
  y?: number;
  /** Multiple seed points in document pixels (filled together as one undo step). */
  points?: ReadonlyArray<FillRegionPoint>;
  /** Target layer id from `listLayers` (default the active layer). */
  layerId?: string;
  /**
   * Which pixels define the region boundaries:
   * - `'layer'` (default): the target layer itself.
   * - `'all'` or `'composite'`: all visible layers composited (without paper).
   * - a layer id from `listLayers`: that layer (e.g. an ink line-art layer above a flats layer).
   */
  reference?: FillReference;
  /** Fill colour #rrggbb (default the editor's paint colour). */
  color?: string;
  /** Opacity 0..1 (default 1). */
  opacity?: number;
  /** Blend mode (default `'normal'`). */
  blend?: BlendMode;
  /** Alias for `blend`. */
  blendMode?: BlendMode;
  /** Colour/alpha similarity tolerance 0..255 (default 32). */
  tolerance?: number;
  /** Close small gaps in line art up to this width in pixels, 0..32 (default 0). */
  closeGap?: number;
  /** Expand (> 0, bleed under lines) or contract (< 0) the filled region in pixels, -16..16 (default 0). */
  expand?: number;
  /** Soften boundary edges (default true). */
  antialias?: boolean;
  /** Paper grain response 0..1 (default 0: flat fill). */
  grain?: number;
  /** With grain: pressure 0..1, how far the fill reaches into the valleys (default 0.5). */
  pressure?: number;
  /** Pour a wet watercolour wash into the region on the layer's wet layer (default false). */
  wet?: boolean;
}

export interface FillRegionResult {
  layerId: string;
  bounds: RasterRect | null;
  pixelCount: number;
  leaked: boolean;
  regions: FillRegionSummary[];
  wet?: boolean;
}

export interface FindUnfilledRegionsOptions {
  /** Target layer id from `listLayers` (when given, regions already painted on it are excluded). */
  layerId?: string;
  /**
   * Which pixels define the line-art barriers:
   * - `'all'` or `'composite'` (default): all visible layers composited (without paper).
   * - `'layer'`: the target (or active) layer itself.
   * - a layer id from `listLayers`: that layer (e.g. an ink line-art layer).
   */
  reference?: FillReference;
  /** Alpha/colour threshold 0..255 above which a reference pixel is treated as line art (default 32). */
  tolerance?: number;
  /** Close small gaps in line art up to this width in pixels, 0..32 (default 0). */
  closeGap?: number;
  /** Ignore regions smaller than this many pixels (default 16). */
  minArea?: number;
  /** Include regions that touch the canvas border (default false: only enclosed shapes). */
  includeEdge?: boolean;
  /** Maximum number of regions to return, sorted largest first (default 100). */
  maxRegions?: number;
}

/** Pixels to add on each side of the canvas (whole numbers, 0 or more; missing = 0). */
export interface PaintCanvasExtension {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
}

export interface PaintCanvasExtended {
  canvas: PaintCanvas;
  /** The new canvas in the previous document's pixels: x −left, y −top and the new size. */
  rect: RasterRect;
  /** The document's origin after the change (see `PaintDocumentState.origin`). */
  origin: { x: number; y: number };
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
  /** Who made it: `user`, or `agent:<id>` (see `withOrigin`). */
  origin: string;
  before: PaintDocumentState;
  after: PaintDocumentState;
  /** Wet steps: the wet simulation before and after (`lost` once dropped for memory: undo then leaves the paint dry). */
  wet?: { before: WetSnapshot | null; after: WetSnapshot | null; lost: boolean };
  /** Steps that move the guides with the paint (extending the canvas): the guides before and after. */
  guides?: { before: PaintGuides; after: PaintGuides };
}

interface MutationEntry {
  id: string;
  state: PaintMutationState;
  layerId: string;
  tempLayerId?: string;
  medium: PaintMutationMedium;
  strokes: PaintMutationStroke[];
  bounds: RasterRect | null;
  settle: number;
  patience: number;
  fade: number;
  age: number;
  sinceLastStroke: number;
  sincePending: number;
  fadeRemaining: number;
  claimedBy?: string;
  answerStrokeIds?: string[];
  declineReason?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** The most stickers one `addStickers` call places. */
const MAX_ADD_STICKERS = 500;

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
  /** The brush library this editor lists, saves into and paints from (shared with other editors when the host passes one). */
  readonly brushLibrary: BrushLibrary;
  private brush: PaintBrush;
  /** The active brush as facets (what `getBrushSpec` and saving use). */
  private brushSpec: Brush;
  /** The library's brushes as last read, each as stored (facets) and as the engine paints it. */
  private brushEntries: readonly LibraryBrush[];
  /** The brush id asked for at construction, while the library had not listed it yet. */
  private pendingBrushId: string | null = null;
  private brushesLoaded: Promise<void> = Promise.resolve();
  private readonly unsubscribeLibrary: () => void;
  /** The library list in the state (the same array until the user brushes change, so thumbnails are not redrawn). */
  private library: readonly PaintBrush[] | null = null;
  private color: string;
  private secondaryColor = '#ffffff';
  /** Gradient paint chosen with `setPaint` (`null`: the paint colour). */
  private gradient: PaintGradientSource | null = null;
  /** Effect paint chosen with `setEffectPaint` (rendered), and one still rendering. */
  private effectPaint: PaintEffectPaint | null = null;
  private effectPaintPending: PaintEffectPaint | null = null;
  /** Changes whenever the paint is chosen, so an effect paint that finishes rendering late does not take over. */
  private paintEpoch = 0;
  /** Rendered effect paints by `effectPaintKey` (most recently used last). */
  private readonly effectPaintPixels = new Map<string, EffectPaintPixels>();
  /** Primary path control name (`format: 'svg-path'`) per effect id, learned from `describeEffect`. */
  private readonly effectPathControls = new Map<string, string>();
  /** How many renders the running batch needs together (`prepareEffectPaints`; a synchronous replay reads them all). */
  private effectPaintBatch = 0;
  /** The hand-painted stroke waiting for its path render (`finishPathStroke`), or `null`. */
  private pathStroke: { effect: string; done: Promise<void> } | null = null;
  /**
   * The hand-painted path stroke's live preview: the effect rendered along the path drawn so far
   * (one render at a time; the newest path when it lands), repainted into the stroke as it lands.
   */
  private pathPreview: { session: PaintStrokeSession; key: string; pending: Promise<EffectPaintPixels> | null; landed: { key: string; pixels: EffectPaintPixels } | null } | null = null;
  private mixerLoad: MixerLoad = EMPTY_MIXER_LOAD;
  private view: PaintView = { ...DEFAULT_VIEW, pan: { ...DEFAULT_VIEW.pan } };
  private hand: Hand;
  private selectedStroke: string | null = null;
  private selectedSticker: string | null = null;
  /** A sticker drag in progress (`previewSticker`): the document before it, so the drop undoes in one step, and the one it showed last. */
  private stickerPreview: { base: PaintDocumentState; shown: PaintDocumentState } | null = null;
  private readonly encodeImage: ImageEncoder | undefined;
  private listeners = new Set<() => void>();
  private commitListeners = new Set<(event: PaintCommitEvent) => void>();
  private sampleListeners = new Set<(sample: PaintStrokeSample) => void>();
  /** Origins set by `withOrigin`, innermost last. */
  private origins: string[] = [];
  /** `group` in progress: commits fold into one step, recorded when it ends. */
  private grouping: { label: string; before: PaintDocumentState; changed: boolean; pending: boolean; inside: number } | null = null;
  /** `previewPaint` in progress: nothing is emitted or recorded. */
  private previewing = false;
  private version = 0;
  private cached: PaintEditorState | null = null;
  private session: PaintStrokeSession | null = null;
  private live: { layerId: string; surface: TiledSurface } | null = null;
  private liveLayers: { key: TiledSurface; layers: PaintLayer[] } | null = null;
  private dirty: RasterRect[] | 'all' = 'all';
  private seedCounter = 1;
  private strokeCounter = 1;
  /** Light paint: each layer's spill settings (saved with the document, not undo steps; missing = the defaults). */
  private lightSpills: Record<string, LightSpill> = {};
  private readonly lightCaches = new Map<string, LightCache>();
  /** Backlit paper: the light through the paint as drawn (live strokes too), and as committed (its spill). */
  private readonly backlightView = new BacklightCache();
  private readonly backlightCommitted = new BacklightCache();
  /** Live effect paint: playing and the frame rate cap (editor state), and the time the view shows. */
  private effectPlaybackState = { playing: true, fps: 30 };
  private effectTime = 0;
  /** While a frame is drawn: the time live effect strokes are drawn at (else their own time). */
  private liveEffectAt: number | null = null;
  /** The view's stroke layers at `effectTime`, each with the document surface it was drawn from (stale once that changes). */
  private animatedLayers = new Map<string, { base: TiledSurface; surface: TiledSurface }>();
  /** `renderAnimationFrame` / `withEffectTime`: layer surfaces at another time, for one render. */
  private frameOverride: Map<string, TiledSurface> | null = null;
  /** The area each stroke painted (document pixels; `null`: nothing), learnt as it is painted or drawn, so a stroke layer edit redraws only where it changes (see `drawLiveStrokes`). */
  private paintedBounds = new WeakMap<RecordedStroke, RasterRect | null>();
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
  /** Where the viewer looks from for thin-film iridescence and specular highlights (editor state, not saved with the document). */
  private viewTilt: PaintViewTilt = { ...DEFAULT_VIEW_TILT };
  private readonly litCaches = new Map<string, LitCache>();
  /** The live impasto stroke's channels. */
  private liveThick: { layerId: string; channels: ThickChannels } | null = null;
  /** The UV / blacklight setting (saved with the document, not undo steps). */
  private uvLight: UvLightSettings = { ...DEFAULT_UV_LIGHT };
  private readonly uvCaches = new Map<string, UvCache>();
  private readonly thermoCaches = new Map<string, ThermoCache>();
  private liveFluor: { layerId: string; surface: TiledSurface } | null = null;
  private liveThermo: { layerId: string; surface: TiledSurface } | null = null;
  /** Set while an operation that changes wet paint runs: the simulation before it (for undo). */
  private wetOp: { before: WetSnapshot | null } | null = null;
  /** The effects provider slot (see `setEffectsProvider`). */
  readonly effects = new EffectsSlot();
  /** The sticker library slot (see `setStickersProvider`). */
  readonly stickers = new StickersSlot(editorStickers());
  private readonly stickerArt = new StickerArtCache();
  /** Image sources strokes draw with: the brush library's and the open painting's (saved with it). */
  readonly brushSources = new BrushSourceArtCache();
  /** Art for stamp tips and tip grain: image sources from `brushSources`, stickers from the sticker library. */
  readonly stampArt: StickerArtLookup = (ref, variant) => (isBrushSourceRef(ref) ? this.brushSources.get(ref) : this.stickerArt.get(ref, variant));
  private readonly rasterizeSticker: StickerRasterizer;
  private readonly effectsRenderer = new PaintEffectsRenderer();
  private paperEffectNodeCache: ImageNode | null = null;
  private mutations: MutationEntry[] = [];
  private nextMutationId = 1;
  private readonly mutationListeners = new Set<PaintMutationRequestListener>();
  private mutationAgentConnected = false;
  private mutationDirector: PaintDirector | null = null;
  private readonly heldEvaporation = new Map<string, number>();
  private readonly tempLayerTargets = new Map<string, string>();
  private answeringMutation = false;
  private lastMutationTick: number | null = null;

  constructor(options: PaintEditorOptions = {}) {
    this.historyLimit = Math.max(1, options.historyLimit ?? 200);
    this.rasterizeSticker = options.rasterizeSticker ?? defaultStickerRasterizer;
    if (options.stickers) this.stickers.set(options.stickers);
    this.doc = createPaintDocument({ width: options.width, height: options.height, dpi: options.dpi, paper: this.resolvePaper(options.paper) });
    const seed = (options.brushes ?? []).map((b) => normalizePaintBrush({ ...b, builtin: false }));
    this.brushLibrary = options.brushLibrary ?? createBrushLibrary({ storage: seededStorage(seed) });
    this.brushEntries = [...builtinLibraryBrushes(), ...seed.map((b) => libraryBrush(migrateBrushV1(b), false, b))];
    const wanted = options.brushId ?? DEFAULT_BRUSH_ID;
    const start = this.findEntry(wanted) ?? this.findEntry(DEFAULT_BRUSH_ID)!;
    this.brush = normalizePaintBrush(start.brush);
    this.brushSpec = copyJSON(start.spec);
    // Brushes kept in the library's storage are listed once it is read; then the wanted brush is chosen.
    this.unsubscribeLibrary = this.brushLibrary.subscribe(() => void this.refreshBrushes().catch(() => undefined));
    if (options.brushLibrary && seed.length) void this.brushLibrary.importFile(seed.map(brushToJSON)).catch(() => undefined);
    void this.refreshBrushes().catch(() => undefined);
    this.pendingBrushId = start.brush.id === wanted ? null : wanted;
    this.color = options.color ? parseColor(options.color) : '#1f2937';
    this.colorScheme = options.colorScheme === 'dark' ? 'dark' : 'light';
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
        layerLight: (id) => this.doc.light?.[id] ?? null,
        updateLights: (lights) => {
          let light = this.doc.light;
          for (const [id, surface] of lights) if (findLayer(this.doc.layers, id)) light = withLayerLight(light, id, surface);
          // Wet light moving is not an undo step either.
          this.doc = { ...this.doc, ...(light ? { light } : {}) };
        },
        layerHeight: (id) => this.doc.thick?.[id]?.height ?? null,
        updateHeights: (heights) => {
          let thick = this.doc.thick;
          for (const [id, height] of heights) {
            if (!findLayer(this.doc.layers, id)) continue;
            const prev = thick?.[id] ?? emptyThickChannels();
            thick = { ...(thick ?? {}), [id]: { ...prev, height } };
          }
          if (thick !== this.doc.thick) this.doc = { ...this.doc, ...(thick ? { thick } : {}) };
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

  /**
   * Hears the user's live strokes as they are painted (`beginStroke` sessions, not strokes painted
   * from data): when the pen goes down, each batch of samples, and the end or cancel. For agents
   * that paint along in real time. Returns an unsubscribe function.
   */
  onStrokeSample(listener: (sample: PaintStrokeSample) => void): () => void {
    this.sampleListeners.add(listener);
    return () => {
      this.sampleListeners.delete(listener);
    };
  }

  private notifySample(phase: PaintStrokeSample['phase'], session: PaintStrokeSession, added: readonly PenPoint[] = [], strokeId?: string | null): void {
    if (!this.sampleListeners.size || this.previewing) return;
    const sample: PaintStrokeSample = { phase, layerId: session.layerId, brush: session.init.brush, color: session.init.colorHex, points: session.points, added, ...(strokeId !== undefined ? { strokeId } : {}) };
    for (const l of [...this.sampleListeners]) l(sample);
  }

  /** The stroke being painted now, or `null`: its layer, brush, colour and samples so far. */
  getLiveStroke(): { layerId: string; brushId: string; brushName: string; color: string; points: readonly PenPoint[] } | null {
    const s = this.session;
    return s ? { layerId: s.layerId, brushId: s.init.brush.id, brushName: s.init.brush.name, color: s.init.colorHex, points: s.points } : null;
  }

  /** Hears each undo step recorded, merged, undone or redone, with who made it. Returns an unsubscribe function. */
  onCommit(listener: (event: PaintCommitEvent) => void): () => void {
    this.commitListeners.add(listener);
    return () => {
      this.commitListeners.delete(listener);
    };
  }

  private notifyCommit(event: PaintCommitEvent): void {
    if (this.previewing) return;
    for (const l of [...this.commitListeners]) l(event);
  }

  /** The origin steps are recorded with now: the innermost `withOrigin`, else `user`. */
  getOrigin(): string {
    return this.origins[this.origins.length - 1] ?? 'user';
  }

  /**
   * Records the steps `fn` makes as made by `origin` (`agent:<id>` for an agent). When `fn` returns
   * a promise, the origin holds until it settles. Satisfies `createOriginMiddleware`'s history target,
   * so agent tool calls are recorded as the calling agent's.
   */
  withOrigin<T>(origin: string, fn: () => T): T {
    this.origins.push(origin);
    let pending = false;
    const pop = () => {
      const i = this.origins.lastIndexOf(origin);
      if (i >= 0) this.origins.splice(i, 1);
    };
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        pending = true;
        return Promise.resolve(result).finally(pop) as T;
      }
      return result;
    } finally {
      if (!pending) pop();
    }
  }

  /**
   * Runs `fn` as one undo step named `label`: every change it makes (strokes, fills, new layers) is
   * undone together. When `fn` returns a promise, the group holds until it settles; until then other
   * changes (the user's strokes, undo) are refused, except those `fn` makes through `within`, so
   * nothing else lands in (or is lost with) the group's step. Nested groups join the outer one. If
   * `fn` throws or rejects, its changes are put back and nothing is recorded.
   */
  group<T>(label: string, fn: (within: <U>(step: () => U) => U) => T): T {
    if (this.grouping && (!this.grouping.pending || this.grouping.inside)) return fn((step) => step());
    this.requireIdle('grouping changes');
    const before = this.doc;
    const revision = this.docRevision;
    const strokesBefore = this.strokeCounter;
    const origin = this.getOrigin();
    const g = { label, before, changed: false, pending: false, inside: 0 };
    this.grouping = g;
    const within = <U>(step: () => U): U => {
      if (this.grouping !== g) return step();
      g.inside++;
      try {
        return step();
      } finally {
        g.inside--;
      }
    };
    const rollback = () => {
      this.grouping = null;
      this.strokeCounter = strokesBefore;
      if (this.wetOp) {
        const snap = this.wetOp.before;
        this.wetOp = null;
        this.pendingWetEvents = [];
        this.wet.restore(snap);
      }
      if (this.doc !== before) {
        this.doc = before;
        this.docRevision = revision + 1;
        this.wet.syncDisplays();
        this.emit();
      }
    };
    const finish = () => {
      this.grouping = null;
      if ((g.changed && this.doc !== before) || this.wetOp) {
        const entry: HistoryEntry = { label: g.label, origin, before, after: this.doc };
        if (this.wetOp) {
          entry.wet = { before: this.wetOp.before, after: this.wet.snapshot(), lost: false };
          this.wetOp = null;
        }
        this.undoStack.push(entry);
        if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
        this.redoStack = [];
        this.trimWetHistory();
        this.notifyCommit({ kind: 'execute', label: g.label, origin: entry.origin });
        this.emit();
      }
    };
    let result: T;
    try {
      result = fn(within);
    } catch (e) {
      rollback();
      throw e;
    }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      g.pending = true;
      return Promise.resolve(result).then(
        (val) => {
          finish();
          return val;
        },
        (e) => {
          rollback();
          throw e;
        }
      ) as T;
    }
    finish();
    return result;
  }

  /**
   * What `fn` would paint, without changing anything: it runs on a new empty layer (above the
   * active layer, another one, or at the bottom), and the layer's pixels and the picture with them
   * come back while the document, history and listeners stay as they were. `fn` gets that layer's id and must paint on it with dry brushes (strokes, replays and
   * fills); wet paint can't be previewed. For ghost paint an agent suggests (`createPaintProposals`).
   */
  previewPaint(fn: (layerId: string) => void, placement: PaintPreviewPlacement = {}): PaintPreview {
    this.requireIdle('previewing');
    if (this.previewing) throw new PaintEditorError('A preview is already running.');
    const saved = {
      doc: this.doc,
      undo: [...this.undoStack],
      redo: this.redoStack,
      revision: this.docRevision,
      strokeCounter: this.strokeCounter,
      seedCounter: this.seedCounter,
      mixerLoad: this.mixerLoad,
    };
    this.previewing = true;
    try {
      const layer = this.addLayer({ name: 'Preview', ...(placement.aboveId ? { aboveId: placement.aboveId } : {}) });
      if (placement.bottom) this.moveLayer(layer.id, 0, null);
      fn(layer.id);
      if (this.wetOp || this.pendingWetEvents.length) throw new PaintEditorError("Wet paint can't be previewed; suggest it with a dry brush.");
      const found = findLayer(this.doc.layers, layer.id)?.layer;
      const surface = found && isPixelLayer(found) ? found.surface : null;
      const bounds = surface ? contentBounds(surface) : null;
      const box = bounds ? clipToCanvas(bounds, this.doc.canvas) : null;
      if (!surface || !box) return { bounds: null, pixels: new Uint8ClampedArray(0), composite: new Uint8ClampedArray(0) };
      const composite = this.exportCompositor.composite(this.renderLayers({ wet: 'display' }), box, this.sources());
      return { bounds: box, pixels: readRegion(surface, box), composite };
    } finally {
      this.wetOp = null;
      this.pendingWetEvents = [];
      this.doc = saved.doc;
      this.undoStack = saved.undo;
      this.redoStack = saved.redo;
      this.docRevision = saved.revision;
      this.strokeCounter = saved.strokeCounter;
      this.seedCounter = saved.seedCounter;
      this.mixerLoad = saved.mixerLoad;
      this.cached = null;
      this.previewing = false;
    }
  }

  private emit(dirty: RasterRect[] | 'all' = 'all'): void {
    if (this.previewing) return;
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
      brushes: (this.library ??= this.brushEntries.map((e) => e.brush)),
      color: this.color,
      colorScheme: this.colorScheme,
      colorLocked: this.colorLocked,
      secondaryColor: this.secondaryColor,
      paint: this.gradient ?? { type: 'color', color: this.color },
      effectPaint: this.effectPaintPending ?? this.effectPaint,
      effectPaintRendering: Boolean(this.effectPaintPending || this.pathStroke),
      mixerLoad: this.mixerLoad,
      view: this.view,
      viewTilt: { ...this.viewTilt },
      hand: this.hand,
      effectPlayback: { ...this.effectPlaybackState, time: this.effectTime },
      selectedStroke: this.selectedStroke,
      selectedSticker: this.selectedSticker,
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
        gpu: this.wet.gpuMode,
        gpuActive: Boolean(this.wet.world?.gpuActive),
      },
      uvLight: { ...this.uvLight },
      heat: heatStats(this.doc.heat),
      mutations: this.mutations.map((m) => this.toMutationInfo(m)),
      hasMutationAgent: this.mutationListeners.size > 0 || this.mutationAgentConnected,
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

  private docRevision = 0;

  /**
   * Bumped on every change to the painting (a committed or amended step, undo, redo, opening a
   * document), not on wet-paint frames or view changes. `createPaintEditorDocument` uses it.
   */
  get documentRevision(): number {
    return this.docRevision;
  }

  /** Why the document cannot be replaced or stepped through right now, or `null`. */
  busyReason(): string | null {
    if (this.session) return 'A stroke is in progress; end or cancel it first.';
    if (this.grouping?.pending && !this.grouping.inside) return `"${this.grouping.label}" is still being painted; wait for it to finish first.`;
    if (this.wet.busy) return 'Wet paint is mid-step; wait a moment (wetIdle()) first.';
    return null;
  }

  private requireIdle(what: string): void {
    if (this.session) throw new PaintEditorError(`A stroke is in progress; end or cancel it before ${what}.`);
    if (this.pathStroke) throw new PaintEditorError(`The last stroke is still rendering the effect "${this.pathStroke.effect}" along its path; wait for it (strokeRendering) before ${what}.`);
    if (this.grouping?.pending && !this.grouping.inside) throw new PaintEditorError(`"${this.grouping.label}" is still being painted (one undo step); wait for it to finish before ${what}.`);
  }

  private commit(label: string, next: PaintDocumentState, before = this.doc): void {
    if (this.grouping) {
      // Inside `group`: the change joins the group's one step, and listeners hear it when the group ends.
      this.grouping.changed = true;
      this.doc = next;
      this.docRevision++;
      return;
    }
    const entry: HistoryEntry = { label, origin: this.getOrigin(), before, after: next };
    if (this.wetOp) {
      entry.wet = { before: this.wetOp.before, after: this.wet.snapshot(), lost: false };
      this.wetOp = null;
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    this.redoStack = [];
    this.doc = next;
    this.docRevision++;
    this.trimWetHistory();
    // Commit listeners first, so a change feed hearing `emit` knows who made the step.
    this.notifyCommit({ kind: 'execute', label, origin: entry.origin });
    this.emit();
  }

  /**
   * Commits `next` as a new undo step, or with `commitToHistory` false folds it into the last step
   * when that step has the same label (the later values of one slider drag).
   */
  private commitOrAmend(label: string, next: PaintDocumentState, commitToHistory: boolean): void {
    const last = this.undoStack[this.undoStack.length - 1];
    if (commitToHistory || !last || last.label !== label || last.wet || this.wetOp || this.grouping) {
      this.commit(label, next);
      return;
    }
    last.after = next;
    this.redoStack = [];
    this.doc = next;
    this.docRevision++;
    this.notifyCommit({ kind: 'merge', label, origin: last.origin });
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
    for (const id of wetIds) {
      this.wet.dry(id);
      this.finishWetMutationsOnDry(id);
    }
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
    this.docRevision++;
    if (e.guides) this.restoreGuides(e.guides.before);
    if (e.wet) {
      if (paper !== this.doc.paper) this.wet.paperChanged();
      this.wet.restore(e.wet.lost ? null : e.wet.before);
      if (paper !== this.doc.paper) this.wet.paperChanged();
    }
    this.reconcileMutationsAfterUndo();
    this.notifyCommit({ kind: 'undo', label: e.label, origin: this.getOrigin() });
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
    this.docRevision++;
    if (e.guides) this.restoreGuides(e.guides.after);
    if (e.wet) {
      this.wet.restore(e.wet.lost ? null : e.wet.after);
      if (paper !== this.doc.paper) this.wet.paperChanged();
    }
    this.notifyCommit({ kind: 'redo', label: e.label, origin: this.getOrigin() });
    this.emit();
    return e.label;
  }

  private restoreGuides(guides: PaintGuides): void {
    if (guides.tracing !== this.guides.tracing) this.tracingVersion++;
    this.guides = guides;
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
      paper: options.paper === undefined ? { ...this.doc.paper, offset: undefined } : this.resolvePaper(options.paper),
    });
    this.extensions = {};
    this.guides = { ...this.guides, symmetry: { ...this.guides.symmetry, center: { x: next.canvas.width / 2, y: next.canvas.height / 2 } }, tracing: null };
    this.tracingVersion++;
    if (this.wet.world || this.wet.patterns.size) {
      this.beginWetOp();
      this.wet.reset();
    }
    this.resetMutations();
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
    const resized = canvas.width !== this.doc.canvas.width || canvas.height !== this.doc.canvas.height;
    if (this.wet.world && resized) {
      // The wet simulation is canvas-sized: the paint dries first.
      this.dryLayersFirst(this.wet.wetLayerIds());
      this.wet.reset();
    }
    const heat = resized && this.doc.heat ? shiftHeatField(this.doc.heat, canvas.width, canvas.height, 0, 0) : this.doc.heat;
    this.commit('Canvas size', this.withWetEvents({ ...this.doc, canvas, ...(heat ? { heat } : {}) }));
    return canvas;
  }

  /**
   * Grows the canvas by `left`, `top`, `right` and `bottom` pixels without moving anything
   * relative to anything else: the layers (with their masks, relief and stickers), the paper grain,
   * the effect paper, guides, stencils, the tracing image and the recorded strokes and events all
   * move by (left, top) in document pixels, `document.origin` moves by (−left, −top), and the view
   * pans so the picture stays still on screen.
   *
   * Wet paint stays wet and moves with the picture when `left` and `top` are whole 256 px tiles
   * (so a host growing a canvas while someone paints should grow it in tile steps); otherwise it
   * dries first (the wet simulation is canvas-sized), as with `setCanvas`. One undo step (undo
   * brings back the old size, origin and guides, and the wet paint). Returns the new canvas, where
   * it sits in the previous document's pixels, and the origin.
   */
  extendCanvas(by: PaintCanvasExtension): PaintCanvasExtended {
    this.requireIdle('extending the canvas');
    const side = (k: keyof PaintCanvasExtension) => {
      const v = by[k] ?? 0;
      if (!Number.isInteger(v) || v < 0) throw new PaintEditorError(`${k} is ${JSON.stringify(by[k])}; use a whole number of pixels to add, 0 or more.`);
      return v;
    };
    const left = side('left');
    const top = side('top');
    const right = side('right');
    const bottom = side('bottom');
    if (!(left || top || right || bottom)) throw new PaintEditorError('Nothing to extend: give left, top, right or bottom (pixels to add on that side) above 0.');
    const was = this.doc.canvas;
    const width = was.width + left + right;
    const height = was.height + top + bottom;
    if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
      throw new PaintEditorError(`The canvas would be ${width}×${height}; the limit is ${MAX_CANVAS_SIDE} px per side. Extend by less (it is ${was.width}×${was.height} now).`);
    }
    // Wet layers whose paint moves still wet (their pixels are in canvas space, like the simulation's)
    let keptWet: string[] = [];
    if (this.wet.world) {
      this.requireWetIdle('extending the canvas');
      if (this.wet.canExtend(left, top)) {
        keptWet = this.wet.wetLayerIds();
        if (keptWet.length) this.beginWetOp();
      } else {
        // The wet simulation is canvas-sized: the paint dries first (one undo step with the change).
        this.dryLayersFirst(this.wet.wetLayerIds());
      }
    }
    let next: PaintDocumentState = { ...shiftDocument(this.withWetEvents(this.doc), left, top), canvas: { ...was, width, height } };
    if (next.heat) next = { ...next, heat: shiftHeatField(next.heat, left, top, width, height) };
    for (const id of keptWet) {
      const l = findLayer(next.layers, id)?.layer;
      if (isPixelLayer(l)) {
        const ox = l.offset.x;
        const oy = l.offset.y;
        next = { ...next, layers: mapLayer(next.layers, id, () => ({ ...l, surface: translateSurface(l.surface, ox, oy), offset: { x: 0, y: 0 } })) };
        const tc = next.thick?.[id];
        if (tc && (ox || oy)) {
          next = {
            ...next,
            thick: {
              ...next.thick,
              [id]: {
                height: translateSurface(tc.height, ox, oy),
                material: translateSurface(tc.material, ox, oy),
                film: translateSurface(tc.film, ox, oy),
              },
            },
          };
        }
        if (next.fluor?.[id] && (ox || oy)) next = { ...next, fluor: { ...next.fluor, [id]: translateSurface(next.fluor[id], ox, oy) } };
        if (next.thermo?.[id] && (ox || oy)) next = { ...next, thermo: { ...next.thermo, [id]: translateSurface(next.thermo[id], ox, oy) } };
      }
    }
    if (this.wet.world) {
      if (keptWet.length) this.wet.extend(width, height, left, top, next.paper);
      else {
        // Keep each layer's wet settings (a flow map's centre moves with the paint).
        const settings = [...this.wet.settings];
        this.wet.reset();
        for (const [id, s] of settings) this.wet.settings.set(id, s.flow.center ? { ...s, flow: { ...s.flow, center: { x: s.flow.center.x + left, y: s.flow.center.y + top } } } : s);
      }
    }
    // The new centre is (right − left, bottom − top) / 2 from the old one: pan by that on screen.
    const m = viewMatrix(this.view, was, { width: 0, height: 0 });
    const dx = (right - left) / 2;
    const dy = (bottom - top) / 2;
    this.view = { ...this.view, pan: { x: this.view.pan.x + m[0] * dx + m[1] * dy, y: this.view.pan.y + m[2] * dx + m[3] * dy } };
    const guidesBefore = this.guides;
    if (left || top) this.restoreGuides(shiftGuides(this.guides, left, top));
    this.commit('Extend canvas', next);
    // The wet layers show the moved simulation (the same picture), now the document is the new size
    if (keptWet.length) this.wet.syncDisplays();
    if (this.guides !== guidesBefore) this.undoStack[this.undoStack.length - 1].guides = { before: guidesBefore, after: this.guides };
    const origin = { ...(next.origin ?? { x: 0, y: 0 }) };
    return { canvas: { ...next.canvas }, rect: { x: 0 - left, y: 0 - top, width, height }, origin };
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
    // The grain stays where the paint is (see extendCanvas), whichever paper it becomes.
    const paper = normalizePaper({ ...rest, preset: base.preset, offset: rest.offset ?? this.doc.paper.offset }, base);
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
      const b = unionRect(contentBounds(l.surface), this.doc.fluor?.[l.id] ? contentBounds(this.doc.fluor[l.id]) : null);
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
      ...(this.doc.liveStrokes?.[l.id] ? { liveStrokes: this.doc.liveStrokes[l.id].length } : {}),
      ...(l.effects?.items.length ? { effects: l.effects.items.length } : {}),
      ...(l.type === 'pixel' && l.temporary ? { temporary: true } : {}),
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
    const l = this.requireLayer(id);
    if (isPixelLayer(l) && l.temporary) throw new PaintEditorError('Temporary mutation layers fade away on their own; paint on the layer below.');
    if (this.doc.activeLayerId === id) return;
    // Selection of the active layer is editor state, not an undo step: keep the history's documents.
    this.doc = { ...this.doc, activeLayerId: id };
    this.emit();
  }

  /** Adds an empty pixel layer or group above `aboveId` (default: the active layer) and makes it active. */
  /** Adds a layer above the active one: `pixel` (default), `group`, or `strokes`, a live stroke layer whose strokes stay editable. */
  addLayer(options: { name?: string; type?: 'pixel' | 'group' | 'strokes'; aboveId?: string; parentId?: string | null } = {}): PaintLayerInfo {
    this.requireIdle('adding a layer');
    const count = flattenLayers(this.doc.layers).length;
    const type = options.type ?? 'pixel';
    const name = options.name?.trim() || (type === 'group' ? `Group ${count + 1}` : type === 'strokes' ? `Strokes ${count + 1}` : `Layer ${count + 1}`);
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
    const live = type === 'strokes' ? { liveStrokes: { ...(this.doc.liveStrokes ?? {}), [layer.id]: [] } } : {};
    this.commit(type === 'group' ? 'Add group' : type === 'strokes' ? 'Add stroke layer' : 'Add layer', { ...this.doc, layers, activeLayerId: layer.id, ...live });
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

  // --- Layer effects (layer styles) ---------------------------------------------

  /** A layer's live effects (an empty, enabled list when it has none). */
  getLayerEffects(id: string): LayerEffects {
    return this.requireLayer(id).effects ?? { enabled: true, items: [] };
  }

  /**
   * Adds a live effect of `kind` (outer and inner glow, drop and inner shadow, stroke, bevel &
   * emboss, satin, colour / gradient / pattern overlay) with Photoshop's defaults and `settings`
   * applied, at `index` in the layer's list (default the end). The effect is drawn from the
   * layer's pixels when it is composited, so it follows later painting. One undo step.
   */
  addLayerEffect(id: string, kind: LayerEffectKind, settings: Record<string, unknown> = {}, index?: number): { effect: LayerEffect; effects: LayerEffects } {
    if (!isLayerEffectKind(kind)) throw new PaintEditorError(`Unknown effect kind "${String(kind)}". Kinds: ${LAYER_EFFECT_KINDS.join(', ')}.`);
    const current = this.effectsLayer(id, 'add effects').effects ?? { enabled: true, items: [] };
    const ids = new Set(current.items.map((e) => e.id));
    let effectId = newEffectId();
    while (ids.has(effectId)) effectId = newEffectId();
    const { id: _id, kind: _kind, ...rest } = settings;
    const effect = effectGuard(() => mergeLayerEffect(defaultLayerEffect(kind, effectId), rest));
    const items = [...current.items];
    const at = index === undefined ? items.length : Math.max(0, Math.min(items.length, Math.floor(index)));
    items.splice(at, 0, effect);
    this.writeLayerEffects(id, { ...current, items }, `Add ${layerEffectLabel(kind)}`, true);
    return { effect, effects: this.getLayerEffects(id) };
  }

  /**
   * Changes one effect: only the given settings (nested objects replace whole; `null` removes an
   * optional contour or texture). One undo step, or with `commitToHistory` false folded into the
   * last change of this effect (a slider drag). Returns the layer's effects.
   */
  updateLayerEffect(id: string, effectId: string, changes: Record<string, unknown>, commitToHistory = true): LayerEffects {
    const current = this.effectsLayer(id, 'change its effects').effects;
    const i = this.requireEffect(id, effectId);
    const items = [...current!.items];
    items[i] = effectGuard(() => mergeLayerEffect(items[i], changes));
    this.writeLayerEffects(id, { ...current!, items }, `Change ${layerEffectLabel(items[i].kind)}`, commitToHistory);
    return this.getLayerEffects(id);
  }

  /** Removes one effect (one undo step). Returns the layer's remaining effects. */
  removeLayerEffect(id: string, effectId: string): LayerEffects {
    const current = this.effectsLayer(id, 'change its effects').effects;
    const i = this.requireEffect(id, effectId);
    this.writeLayerEffects(id, { ...current!, items: current!.items.filter((e) => e.id !== effectId) }, `Remove ${layerEffectLabel(current!.items[i].kind)}`, true);
    return this.getLayerEffects(id);
  }

  /** Turns all of a layer's effects on or off and, when given, sets Scale Effects (0.01..10). One undo step. */
  setLayerEffectsEnabled(id: string, enabled: boolean, scale?: number, commitToHistory = true): LayerEffects {
    const current = this.effectsLayer(id, 'change its effects').effects ?? { enabled: true, items: [] };
    if (scale !== undefined && !(Number.isFinite(scale) && scale >= 0.01 && scale <= 10)) throw new PaintEditorError(`scale must be from 0.01 to 10 (1 = 100 %), got ${scale}.`);
    const next: LayerEffects = { ...current, enabled };
    if (scale !== undefined) {
      if (scale === 1) delete next.scale;
      else next.scale = scale;
    }
    this.writeLayerEffects(id, next, 'Layer effects', commitToHistory);
    return this.getLayerEffects(id);
  }

  /** Replaces a layer's effects, validated (`null` removes them). One undo step. Returns the effects. */
  setLayerEffects(id: string, effects: LayerEffects | null, commitToHistory = true): LayerEffects {
    this.effectsLayer(id, 'change its effects');
    if (effects) effectGuard(() => validateLayerEffects(effects));
    this.writeLayerEffects(id, effects, 'Layer effects', commitToHistory);
    return this.getLayerEffects(id);
  }

  /** Document patterns for pattern effects besides the built-in ones: none (paint documents bring none). */
  getDocumentPatterns(): EffectPattern[] {
    return [];
  }

  private effectsLayer(id: string, action: string): PaintLayer {
    this.requireIdle('changing layer effects');
    const l = this.requireLayer(id);
    if (isLayerLocked(l, 'all')) throw new PaintEditorError(`Layer "${l.name}" is fully locked, so it can't ${action}; unlock it first (locks {all: false}).`);
    return l;
  }

  private requireEffect(id: string, effectId: string): number {
    const l = this.requireLayer(id);
    const items = l.effects?.items ?? [];
    const i = items.findIndex((e) => e.id === effectId);
    if (i === -1) throw new PaintEditorError(`Layer "${l.name}" has no effect "${effectId}". Effects: ${items.map((e) => `${e.id} (${e.kind})`).join(', ') || 'none'}; call list_layer_effects.`);
    return i;
  }

  /** Writes a layer's effects (dropped when empty, enabled and unscaled), as an undo step or folded into the last one. */
  private writeLayerEffects(id: string, effects: LayerEffects | null, label: string, commitToHistory: boolean): void {
    const next = { ...this.requireLayer(id) } as PaintLayer;
    if (effects && (effects.items.length || effects.psd || effects.scale !== undefined || !effects.enabled)) next.effects = effects;
    else delete next.effects;
    this.commitOrAmend(label, { ...this.doc, layers: mapLayer(this.doc.layers, id, () => next) }, commitToHistory);
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
    const removedIds = flattenLayers([l]).map((x) => x.id);
    this.commit('Remove layer', {
      ...this.doc,
      layers,
      activeLayerId: active,
      ...this.thickWithout(removedIds),
      ...this.stickersWithout(removedIds),
      ...this.liveStrokesWithout(removedIds),
      ...this.lightWithout(removedIds),
      ...this.fluorWithout(removedIds),
      ...this.thermoWithout(removedIds),
    });
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
    const stickers: Record<string, Sticker[]> = { ...(this.doc.stickers ?? {}) };
    const liveStrokes: Record<string, RecordedStroke[]> = { ...(this.doc.liveStrokes ?? {}) };
    const light: Record<string, TiledSurface> = { ...(this.doc.light ?? {}) };
    const fluor: Record<string, TiledSurface> = { ...(this.doc.fluor ?? {}) };
    const thermo: Record<string, TiledSurface> = { ...(this.doc.thermo ?? {}) };
    const copy = (l: PaintLayer): PaintLayer => {
      const id = newPaintLayerId();
      if (light[l.id]) light[id] = light[l.id];
      if (this.lightSpills[l.id]) this.lightSpills[id] = { ...this.lightSpills[l.id] };
      if (fluor[l.id]) fluor[id] = fluor[l.id];
      if (thermo[l.id]) thermo[id] = thermo[l.id];
      if (thick[l.id]) thick[id] = thick[l.id];
      if (stickers[l.id]) stickers[id] = stickers[l.id].map((x) => ({ ...x }));
      // Stroke ids are unique across the document: the copies get new ones.
      if (liveStrokes[l.id]) liveStrokes[id] = liveStrokes[l.id].map((x) => ({ ...x, id: `s${this.strokeCounter++}`, layerId: id }));
      return l.type === 'group' ? { ...l, id, children: l.children.map(copy) } : { ...l, id };
    };
    const dup = { ...copy(loc.layer), name: `${loc.layer.name} copy` };
    const layers = insertLayer(this.doc.layers, dup, loc.parent?.id ?? null, loc.index + 1);
    this.commit(
      'Duplicate layer',
      this.withWetEvents({
        ...this.doc,
        layers,
        activeLayerId: dup.id,
        ...(this.doc.thick ? { thick } : {}),
        ...(this.doc.stickers ? { stickers } : {}),
        ...(this.doc.liveStrokes ? { liveStrokes } : {}),
        ...(this.doc.light ? { light } : {}),
        ...(this.doc.fluor ? { fluor } : {}),
        ...(this.doc.thermo ? { thermo } : {}),
      }),
    );
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
    // Light, fluorescence and thermochromic ink: the upper layer's over the lower's (where the upper paint is transparent), in the merged layer's space.
    const toDoc = (t: TiledSurface | undefined, l: PaintPixelLayer) => (t ? translateSurface(t, l.offset.x, l.offset.y) : undefined);
    const upperDoc = translateSurface(upper.surface, upper.offset.x, upper.offset.y);
    const mergedLight = this.doc.light?.[upper.id] || this.doc.light?.[below.id] ? mergeLight(toDoc(this.doc.light?.[below.id], below), upper.visible ? toDoc(this.doc.light?.[upper.id], upper) : undefined, upperDoc) : undefined;
    const lightAfter = this.lightWithout([upper.id, below.id]).light ?? (this.doc.light ? { ...this.doc.light } : undefined);
    const light = mergedLight ? { ...(lightAfter ?? {}), [below.id]: mergedLight } : lightAfter;
    const mergedFluor = this.doc.fluor?.[upper.id] || this.doc.fluor?.[below.id] ? mergeFourChannel(toDoc(this.doc.fluor?.[below.id], below), upper.visible ? toDoc(this.doc.fluor?.[upper.id], upper) : undefined) : undefined;
    const fluorAfter = this.fluorWithout([upper.id, below.id]).fluor ?? (this.doc.fluor ? { ...this.doc.fluor } : undefined);
    const fluor = mergedFluor ? { ...(fluorAfter ?? {}), [below.id]: mergedFluor } : fluorAfter;
    const mergedThermo = this.doc.thermo?.[upper.id] || this.doc.thermo?.[below.id] ? mergeFourChannel(toDoc(this.doc.thermo?.[below.id], below), upper.visible ? toDoc(this.doc.thermo?.[upper.id], upper) : undefined) : undefined;
    const thermoAfter = this.thermoWithout([upper.id, below.id]).thermo ?? (this.doc.thermo ? { ...this.doc.thermo } : undefined);
    const thermo = mergedThermo ? { ...(thermoAfter ?? {}), [below.id]: mergedThermo } : thermoAfter;
    this.commit(
      'Merge down',
      this.withWetEvents({
        ...this.doc,
        layers,
        activeLayerId: below.id,
        ...this.thickWithout([upper.id]),
        ...this.stickersWithout([upper.id, below.id]),
        ...this.liveStrokesWithout([upper.id, below.id]),
        ...(light ? { light } : {}),
        ...(fluor ? { fluor } : {}),
        ...(thermo ? { thermo } : {}),
      }),
    );
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
    this.commit(
      'Clear layer',
      this.withPaintEvent(
        {
          ...this.doc,
          layers: mapLayer(this.doc.layers, l.id, () => ({ ...l, surface: emptySurface(4) })),
          ...this.thickWithout([l.id]),
          ...this.stickersWithout([l.id]),
          ...(this.doc.liveStrokes?.[l.id] ? { liveStrokes: { ...this.doc.liveStrokes, [l.id]: [] } } : {}),
          ...this.lightWithout([l.id]),
          ...this.fluorWithout([l.id]),
          ...this.thermoWithout([l.id]),
        },
        { kind: 'clear', layerId: l.id },
      ),
    );
    return { layerId: l.id, bounds };
  }

  /**
   * Fills a layer across the canvas with a colour. With `grain` above 0 the fill follows the paper
   * grain (it catches the peaks, as pastel or charcoal rubbed across the sheet).
   */
  fillLayer(options: FillLayerOptions = {}): { layerId: string; bounds: RasterRect } {
    this.requireIdle('filling');
    const fillTarget = this.paintTarget(options.layerId, 'fill');
    if (this.doc.stickers?.[fillTarget.id]?.length) throw new PaintEditorError(`Layer "${fillTarget.name}" is a sticker layer; fill another layer (add_layer).`);
    if (this.doc.liveStrokes?.[fillTarget.id]) throw new PaintEditorError(`Layer "${fillTarget.name}" is a stroke layer (its pixels are drawn from its strokes); fill another layer (add_layer), or rasterize it first (rasterize_stroke_layer).`);
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
    // A fill covers the paint, and its light / fluorescence / thermochromic ink with it.
    const lit = this.doc.light?.[l.id];
    const light = lit ? withLayerLight(this.doc.light, l.id, scaleLight(lit, 1 - opacity)) : undefined;
    const fl = this.doc.fluor?.[l.id];
    const fluor = fl ? withLayerLight(this.doc.fluor, l.id, scaleFluor(fl, 1 - opacity)) : undefined;
    const th = this.doc.thermo?.[l.id];
    const thermo = th && opacity >= 0.5 ? this.thermoWithout([l.id]).thermo : undefined;
    this.commit(
      'Fill layer',
      this.withPaintEvent(
        this.withWetEvents({
          ...this.doc,
          layers: mapLayer(this.doc.layers, l.id, () => ({ ...l, surface })),
          ...(light ? { light } : {}),
          ...(fluor ? { fluor } : {}),
          ...(thermo ? { thermo } : {}),
        }),
        { kind: 'fill', layerId: l.id, data: { color, opacity, grain: grainAmount, pressure, blend } },
      ),
    );
    return { layerId: l.id, bounds: rect };
  }

  /**
   * Flood-fills one or more contiguous regions on a pixel layer (one undo step), sampling boundaries
   * from the layer itself (`reference: 'layer'`), all visible layers (`'all'` / `'composite'`), or a
   * specific reference layer id (e.g. an ink line-art layer above a flats layer). Closes line-art gaps
   * up to `closeGap` px and expands (`> 0`, bleeding under lines) or contracts (`< 0`) by `expand` px.
   * With `wet: true`, pours a watercolour wash into the region on the layer's wet layer.
   */
  fillRegion(options: FillRegionOptions): FillRegionResult {
    this.requireIdle('filling');
    const fillTarget = this.paintTarget(options.layerId, 'fill');
    if (this.doc.stickers?.[fillTarget.id]?.length) throw new PaintEditorError(`Layer "${fillTarget.name}" is a sticker layer; fill another layer (add_layer).`);
    if (this.doc.liveStrokes?.[fillTarget.id]) throw new PaintEditorError(`Layer "${fillTarget.name}" is a stroke layer (its pixels are drawn from its strokes); fill another layer (add_layer), or rasterize it first (rasterize_stroke_layer).`);

    const { width, height } = this.doc.canvas;
    const pts: FillRegionPoint[] = [];
    if (options.points !== undefined) {
      if (!Array.isArray(options.points) || !options.points.length) {
        throw new PaintEditorError('points is empty; give at least one {x, y} in document pixels.');
      }
      for (let i = 0; i < options.points.length; i++) {
        const p = options.points[i];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          throw new PaintEditorError(`points[${i}] needs finite x and y in document pixels.`);
        }
        pts.push({ x: p.x, y: p.y });
      }
    }
    if (options.x !== undefined || options.y !== undefined) {
      if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) {
        throw new PaintEditorError('x and y must be finite numbers in document pixels.');
      }
      if (!options.points) pts.push({ x: options.x!, y: options.y! });
    }
    if (!pts.length) {
      throw new PaintEditorError('Pass x and y (or points) in document pixels to fill a region.');
    }
    for (const p of pts) {
      const px = Math.floor(p.x);
      const py = Math.floor(p.y);
      if (px < 0 || py < 0 || px >= width || py >= height) {
        throw new PaintEditorError(`(${p.x}, ${p.y}) is outside the ${width}×${height} canvas.`);
      }
    }

    const refSpec = options.reference ?? 'layer';
    if (refSpec !== 'layer' && refSpec !== 'all' && refSpec !== 'composite') {
      this.requireLayer(refSpec);
    }

    const color = options.color === undefined ? this.color : parseColor(options.color);
    const opacity = options.opacity ?? 1;
    if (!(Number.isFinite(opacity) && opacity >= 0 && opacity <= 1)) throw new PaintEditorError(`opacity ${opacity} is out of range; use 0..1.`);
    const blend = options.blend ?? options.blendMode ?? 'normal';
    if (!isBlendMode(blend)) throw new PaintEditorError(`Unknown blend mode "${blend}".`);
    const tolerance = options.tolerance ?? 32;
    if (!(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 255)) throw new PaintEditorError(`tolerance ${tolerance} is out of range; use 0..255.`);
    const closeGap = options.closeGap ?? 0;
    if (!(Number.isFinite(closeGap) && closeGap >= 0 && closeGap <= 32)) throw new PaintEditorError(`closeGap ${closeGap} is out of range; use 0..32 px.`);
    const expand = options.expand ?? 0;
    if (!(Number.isFinite(expand) && expand >= -16 && expand <= 16)) throw new PaintEditorError(`expand ${expand} is out of range; use -16..16 px.`);
    const antialias = options.antialias ?? true;
    if (typeof antialias !== 'boolean') throw new PaintEditorError('antialias must be true or false.');
    const grainAmount = options.grain ?? 0;
    if (!(Number.isFinite(grainAmount) && grainAmount >= 0 && grainAmount <= 1)) throw new PaintEditorError(`grain ${grainAmount} is out of range; use 0..1.`);
    const pressure = options.pressure ?? 0.5;
    if (!(Number.isFinite(pressure) && pressure >= 0 && pressure <= 1)) throw new PaintEditorError(`pressure ${pressure} is out of range; use 0..1.`);
    const wet = options.wet === true;
    if (wet && this.previewing) throw new PaintEditorError("Wet paint can't be previewed; suggest a dry fill instead.");
    if (wet && !this.wet.wetLayerIds().includes(fillTarget.id) && this.wet.wetLayerIds().length >= MAX_WET_LANES) {
      throw new PaintEditorError(`At most ${MAX_WET_LANES} layers can hold wet paint at once; dry one first (dry_paint).`);
    }

    const refPixels =
      refSpec === 'layer'
        ? this.compositePixels({ layerIds: [fillTarget.id], paper: false, wet: 'display' }).data
        : refSpec === 'all' || refSpec === 'composite'
          ? this.compositePixels({ paper: false, wet: 'display' }).data
          : this.compositePixels({ layerIds: [refSpec], paper: false, wet: 'display' }).data;

    const filled = fillRegionMask(refPixels, width, height, {
      points: pts,
      tolerance,
      closeGap,
      expand,
      antialias,
    });

    const eventData: Record<string, unknown> = {
      points: pts.map((p) => ({ x: p.x, y: p.y })),
      reference: refSpec,
      color,
      opacity,
      blend,
      tolerance,
      closeGap,
      expand,
      antialias,
      grain: grainAmount,
      pressure,
      ...(wet ? { wet: true } : {}),
    };

    if (!filled.bounds || filled.pixelCount === 0) {
      return {
        layerId: fillTarget.id,
        bounds: null,
        pixelCount: 0,
        leaked: false,
        regions: filled.regions,
        ...(wet ? { wet: this.wet.isWet(fillTarget.id) } : {}),
      };
    }

    const rect = filled.bounds;
    const depth = grainAmount * this.doc.paper.depth;
    const grain = depth > 0 ? paperGrain(this.doc.paper) : null;

    if (wet) {
      this.requireWetIdle('filling');
      const before = this.doc;
      let l = fillTarget;
      if (l.offset.x || l.offset.y) {
        const moved: PaintPixelLayer = { ...l, surface: translateSurface(l.surface, l.offset.x, l.offset.y), offset: { x: 0, y: 0 } };
        this.doc = { ...this.doc, layers: mapLayer(this.doc.layers, l.id, () => moved) };
        l = moved;
      }
      this.beginWetOp();
      const world = this.wet.ensureLane(l.id);
      const [r, g, b] = hexToRgb8(color);
      const medium = new WetMedium(world, l.id, {
        water: 0.9 * Math.max(0.25, opacity),
        mass: PIGMENT_UNIT * 2.5 * opacity,
        body: 0,
        light: 0,
      });
      const subCov = new Float32Array(rect.width * rect.height);
      for (let yy = 0, k = 0; yy < rect.height; yy++) {
        const py = rect.y + yy;
        const row = py * width;
        for (let xx = 0; xx < rect.width; xx++, k++) {
          const px = rect.x + xx;
          let v = filled.mask[row + px]!;
          if (v > 0 && grain) v *= grainCatch(grain.at(px + 0.5, py + 0.5), depth, pressure);
          subCov[k] = Math.round(v * 4096) / 4096;
        }
      }
      medium.deposit(rect, subCov, 1, [r / 255, g / 255, b / 255], null);
      if (this.wet.instantDry) {
        this.wet.dry(l.id);
        this.logWet({ kind: 'dry', layerId: l.id });
      } else {
        this.wet.syncDisplays();
      }
      const afterLayer = this.getLayer(l.id) as PaintPixelLayer;
      this.commit(
        'Fill region',
        this.withPaintEvent(this.withWetEvents({ ...this.doc, layers: mapLayer(this.doc.layers, l.id, () => ({ ...afterLayer })) }), {
          kind: 'fill-region',
          layerId: l.id,
          data: eventData,
        }),
        before
      );
      return {
        layerId: l.id,
        bounds: rect,
        pixelCount: filled.pixelCount,
        leaked: filled.leaked,
        regions: filled.regions,
        wet: this.wet.isWet(l.id),
      };
    }

    this.dryLayersFirst([fillTarget.id]);
    const l = this.paintTarget(options.layerId, 'fill');
    const coverage = new CoverageMap();
    const vals = new Float32Array(rect.width * rect.height);
    for (let yy = 0, k = 0; yy < rect.height; yy++) {
      const py = rect.y + yy;
      const row = py * width;
      for (let xx = 0; xx < rect.width; xx++, k++) {
        const px = rect.x + xx;
        let v = filled.mask[row + px]!;
        if (v > 0 && grain) v *= grainCatch(grain.at(px + 0.5, py + 0.5), depth, pressure);
        vals[k] = v;
      }
    }
    coverage.accumulate(rect, vals, 1);
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
    this.commit(
      'Fill region',
      this.withPaintEvent(this.withWetEvents({ ...this.doc, layers: mapLayer(this.doc.layers, l.id, () => ({ ...l, surface })) }), {
        kind: 'fill-region',
        layerId: l.id,
        data: eventData,
      })
    );
    return {
      layerId: l.id,
      bounds: rect,
      pixelCount: filled.pixelCount,
      leaked: filled.leaked,
      regions: filled.regions,
    };
  }

  /**
   * Finds enclosed unfilled regions from a reference layer or the visible composite (without paper),
   * closing line-art gaps up to `closeGap` px and returning each region's interior seed `point`,
   * `centroid`, `bounds`, `pixelCount`, and `touchesEdge` flag.
   */
  findUnfilledRegions(options: FindUnfilledRegionsOptions = {}): { regions: UnfilledRegion[] } {
    if (options.layerId !== undefined) {
      const l = this.requireLayer(options.layerId);
      if (!isPixelLayer(l)) throw new PaintEditorError(`Layer "${l.name}" is a group; pass a pixel layer inside it.`);
    }
    const refSpec = options.reference ?? 'all';
    if (refSpec !== 'layer' && refSpec !== 'all' && refSpec !== 'composite') {
      this.requireLayer(refSpec);
    }
    const tolerance = options.tolerance ?? 32;
    if (!(Number.isFinite(tolerance) && tolerance >= 0 && tolerance <= 255)) throw new PaintEditorError(`tolerance ${tolerance} is out of range; use 0..255.`);
    const closeGap = options.closeGap ?? 0;
    if (!(Number.isFinite(closeGap) && closeGap >= 0 && closeGap <= 32)) throw new PaintEditorError(`closeGap ${closeGap} is out of range; use 0..32 px.`);
    const minArea = options.minArea ?? 16;
    if (!(Number.isInteger(minArea) && minArea >= 1 && minArea <= 10000000)) throw new PaintEditorError(`minArea ${minArea} is out of range; use a whole number of pixels, 1 or more.`);
    const maxRegions = options.maxRegions ?? 100;
    if (!(Number.isInteger(maxRegions) && maxRegions >= 1 && maxRegions <= 1000)) throw new PaintEditorError(`maxRegions ${maxRegions} is out of range; use 1..1000.`);
    const includeEdge = options.includeEdge ?? false;
    if (typeof includeEdge !== 'boolean') throw new PaintEditorError('includeEdge must be true or false.');

    const { width, height } = this.doc.canvas;
    let refPixels: Uint8ClampedArray;
    if (refSpec === 'all' || refSpec === 'composite') {
      refPixels = this.compositePixels({ paper: false, wet: 'display' }).data;
    } else if (refSpec === 'layer') {
      const targetId = options.layerId ?? this.doc.activeLayerId;
      if (!targetId) throw new PaintEditorError('There is no active layer; pass layerId or reference.');
      refPixels = this.compositePixels({ layerIds: [targetId], paper: false, wet: 'display' }).data;
    } else {
      refPixels = this.compositePixels({ layerIds: [refSpec], paper: false, wet: 'display' }).data;
    }

    const targetPixels =
      options.layerId !== undefined && options.layerId !== refSpec && refSpec !== 'layer'
        ? this.compositePixels({ layerIds: [options.layerId], paper: false, wet: 'display' }).data
        : undefined;

    const regions = findUnfilledRegionsMask(refPixels, width, height, {
      target: targetPixels,
      tolerance,
      closeGap,
      minArea,
      includeEdge,
      maxRegions,
    });
    return { regions };
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

  // --- Provider effects ------------------------------------------------------------

  /** The registered effects provider, or `null`. */
  get effectsProvider(): EffectProvider | null {
    return this.effects.provider;
  }

  /** Registers (or with `null` removes) the effects provider. Not an edit: no undo step. */
  setEffectsProvider(provider: EffectProvider | null): void {
    this.effects.set(provider);
  }

  /** Registers `provider` and returns a function that removes it again (if it is still the one set). */
  useEffects(provider: EffectProvider): () => void {
    return this.effects.use(provider);
  }

  /** The provider's description of an effect, checked for `place` (rejects without a provider or for an unknown id). */
  async describeEffect(effect: string, place?: PaintEffectPlace): Promise<EffectDescription> {
    const d = await this.effectsRenderer.describe(this.effects.require(), effect);
    const pcs = pathControlsOf(d);
    if (pcs.length) this.effectPathControls.set(d.id, pcs[0]);
    if (place) checkPaintEffectPlace(d, place);
    return d;
  }

  /** Every effect layer (top first) with its effect. */
  listEffectLayers(): { layerId: string; name: string; source: PaintEffectSource }[] {
    const map = this.doc.effectLayers ?? {};
    return this.listLayers()
      .filter((l) => map[l.id])
      .map((l) => ({ layerId: l.id, name: l.name, source: map[l.id] }));
  }

  /** The effect a layer is drawn from, or `undefined` for other layers. */
  getEffectLayer(layerId: string): PaintEffectSource | undefined {
    return findLayer(this.doc.layers, layerId) ? this.doc.effectLayers?.[layerId] : undefined;
  }

  /** The effect paper (without its pixels), or `null`. */
  getPaperEffect(): Omit<PaintPaperEffect, 'image' | 'version'> | null {
    const p = this.doc.paperEffect;
    if (!p) return null;
    const { image: _i, version: _v, ...rest } = p;
    return { ...rest, values: { ...rest.values } };
  }

  /** Values over `base` (`null` resets a control to its default), checked against the effect's controls. */
  private effectValues(d: EffectDescription, base: Record<string, EffectValue>, changes: Record<string, EffectValue | null> | undefined): Record<string, EffectValue> {
    const merged = { ...base };
    const given: Record<string, EffectValue> = {};
    for (const [k, v] of Object.entries(changes ?? {})) {
      if (!(k in d.controls.properties)) throw new PaintEditorError(`"${k}" is not a control of "${d.id}"; its controls are ${Object.keys(d.controls.properties).join(', ') || 'none'} (describe_effect).`);
      if (v === null) merged[k] = d.defaults[k];
      else given[k] = v;
    }
    return { ...merged, ...resolveEffectValues({ ...d, defaults: merged }, given) } as Record<string, EffectValue>;
  }

  /** Renders a generator, overlay or title effect at the canvas size. */
  private renderEffectCanvas(d: EffectDescription, values: Record<string, EffectValue>, time = 0): Promise<EffectPixels> {
    const { width, height } = this.doc.canvas;
    return this.effectsRenderer.render(this.effects.require(), d.id, { width, height }, { time, values });
  }

  private sourceOf(d: EffectDescription, values: Record<string, EffectValue>, time?: number): PaintEffectSource {
    return { effect: d.id, provider: this.effects.require().id, name: d.name, values, ...(time ? { time } : {}) };
  }

  private checkTime(time: number | undefined): void {
    if (time !== undefined && !(Number.isFinite(time) && time >= 0)) throw new PaintEditorError(`time ${time} is not a moment of the effect; use 0 or more milliseconds.`);
  }

  private checkOpacity(opacity: number | undefined): void {
    if (opacity !== undefined && !(opacity >= 0 && opacity <= 1)) throw new PaintEditorError(`opacity ${opacity} is out of range; use 0..1.`);
  }

  /** A pixel layer that takes effect pixels: unlocked, visible, no sticker layer, no wet paint. */
  private effectTarget(layerId: string | undefined, what: string): PaintPixelLayer {
    const l = this.paintTarget(layerId, what);
    if (this.doc.stickers?.[l.id]?.length) throw new PaintEditorError(`Layer "${l.name}" is a sticker layer; ${what} another layer (add_layer).`);
    if (this.doc.liveStrokes?.[l.id]) throw new PaintEditorError(`Layer "${l.name}" is a stroke layer (its pixels are drawn from its strokes); ${what} another layer (add_layer), or rasterize it first (rasterize_stroke_layer).`);
    if (this.wet.wetLayerIds().includes(l.id)) throw new PaintEditorError(`Layer "${l.name}" holds wet paint; effects go on dried paint, so dry it first (dry_paint) and try again.`);
    return l;
  }

  /** After an effect rendered: the layer must be as it was when the render started. */
  private sameLayerAfterRender(before: PaintPixelLayer): PaintPixelLayer {
    this.requireIdle('applying an effect');
    const now = this.getLayer(before.id);
    if (!isPixelLayer(now)) throw new PaintEditorError(`Layer "${before.name}" was removed while the effect rendered.`);
    if (now.surface !== before.surface || now.offset.x !== before.offset.x || now.offset.y !== before.offset.y) throw new PaintEditorError(`Layer "${before.name}" changed while the effect rendered; apply the effect again.`);
    return now;
  }

  /** The canvas rectangle in a layer's own coordinates. */
  private canvasRectOf(l: PaintPixelLayer): RasterRect {
    return { x: -l.offset.x, y: -l.offset.y, width: this.doc.canvas.width, height: this.doc.canvas.height };
  }

  /**
   * Sets the effect paper: a provider generator drawn over the paper and under the paint, at the
   * canvas size (`multiply` by default, so the paper's colour and grain still show). `null` removes
   * it. One undo step. Returns the effect paper (without pixels), or `null`.
   */
  async setPaperEffect(effect: string | null, options: { values?: Record<string, EffectValue>; opacity?: number; blend?: PaperEffectBlend; time?: number } = {}): Promise<ReturnType<PaintEditorController['getPaperEffect']>> {
    this.requireIdle('changing the paper');
    if (effect === null) {
      if (!this.doc.paperEffect) return null;
      const { paperEffect: _p, ...rest } = this.doc;
      this.commit('Remove effect paper', rest);
      return null;
    }
    this.checkOpacity(options.opacity);
    this.checkTime(options.time);
    if (options.blend !== undefined && !PAPER_EFFECT_BLENDS.includes(options.blend)) throw new PaintEditorError(`Unknown effect paper blend "${options.blend}"; use ${PAPER_EFFECT_BLENDS.join(', ')}.`);
    const d = await this.describeEffect(effect, 'paper');
    const values = this.effectValues(d, { ...d.defaults } as Record<string, EffectValue>, options.values);
    const pixels = await this.renderEffectCanvas(d, values, options.time);
    this.requireIdle('changing the paper');
    const was = this.doc.paperEffect;
    const paperEffect: PaintPaperEffect = {
      ...this.sourceOf(d, values, options.time),
      opacity: options.opacity ?? was?.opacity ?? 1,
      blend: options.blend ?? was?.blend ?? 'multiply',
      image: { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(pixels.data) },
      version: nextPaperEffectVersion(),
    };
    this.commit('Effect paper', { ...this.doc, paperEffect });
    return this.getPaperEffect();
  }

  /**
   * Changes the effect paper: new control `values` (merged over its own; `null` resets one) or
   * `time` draw it again at the canvas size; `opacity` and `blend` only change how it is drawn.
   * One undo step; with `commitToHistory` false it joins the previous effect paper step (a slider
   * drag). Returns the effect paper (without pixels).
   */
  async updatePaperEffect(changes: { values?: Record<string, EffectValue | null>; opacity?: number; blend?: PaperEffectBlend; time?: number }, commitToHistory = true): Promise<NonNullable<ReturnType<PaintEditorController['getPaperEffect']>>> {
    this.requireIdle('changing the paper');
    const was = this.doc.paperEffect;
    if (!was) throw new PaintEditorError('There is no effect paper; set one with set_paper_effect.');
    this.checkOpacity(changes.opacity);
    this.checkTime(changes.time);
    if (changes.blend !== undefined && !PAPER_EFFECT_BLENDS.includes(changes.blend)) throw new PaintEditorError(`Unknown effect paper blend "${changes.blend}"; use ${PAPER_EFFECT_BLENDS.join(', ')}.`);
    let next: PaintPaperEffect = { ...was, ...(changes.opacity !== undefined ? { opacity: changes.opacity } : {}), ...(changes.blend !== undefined ? { blend: changes.blend } : {}) };
    const { width, height } = this.doc.canvas;
    if (changes.values !== undefined || changes.time !== undefined || was.image.width !== width || was.image.height !== height) {
      const d = await this.describeEffect(was.effect, 'paper');
      const values = this.effectValues(d, was.values, changes.values);
      const time = changes.time ?? was.time ?? 0;
      const pixels = await this.renderEffectCanvas(d, values, time);
      this.requireIdle('changing the paper');
      if (this.doc.paperEffect !== was) throw new PaintEditorError('The effect paper changed while it rendered; change it again.');
      next = { ...next, ...this.sourceOf(d, values, time), image: { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(pixels.data) }, version: nextPaperEffectVersion() };
      if (!time) delete next.time;
    }
    this.commitOrAmend('Effect paper', { ...this.doc, paperEffect: next }, commitToHistory);
    return this.getPaperEffect()!;
  }

  /**
   * Adds an effect layer above the active layer (or `aboveId`): a pixel layer drawn by a provider
   * generator, overlay or title effect at the canvas size. It keeps its effect, so
   * `updateEffectLayer` draws it again. One undo step. Returns the layer and its effect.
   */
  async addEffectLayer(effect: string, options: { values?: Record<string, EffectValue>; name?: string; aboveId?: string; opacity?: number; blend?: BlendMode; time?: number } = {}): Promise<{ layer: PaintLayerInfo; source: PaintEffectSource }> {
    this.requireIdle('adding a layer');
    this.checkOpacity(options.opacity);
    this.checkTime(options.time);
    if (options.blend !== undefined && !isBlendMode(options.blend)) throw new PaintEditorError(`Unknown blend mode "${options.blend}". Call get_canvas_info for the blend modes.`);
    if (options.aboveId !== undefined) this.requireLayer(options.aboveId);
    const d = await this.describeEffect(effect, 'layer');
    const values = this.effectValues(d, { ...d.defaults } as Record<string, EffectValue>, options.values);
    const pixels = await this.renderEffectCanvas(d, values, options.time);
    this.requireIdle('adding a layer');
    const above = options.aboveId ?? this.doc.activeLayerId;
    const loc = above ? findLayer(this.doc.layers, above) : null;
    if (options.aboveId !== undefined && !loc) throw new PaintEditorError(`Layer "${options.aboveId}" was removed while the effect rendered.`);
    const layer: PaintPixelLayer = { ...createPaintLayer(options.name?.trim() || d.name), surface: surfaceFromPixels(pixels, 4), opacity: options.opacity ?? 1, blend: options.blend ?? 'normal' };
    const layers = insertLayer(this.doc.layers, layer, loc?.parent?.id ?? null, loc ? loc.index + 1 : undefined);
    const source = this.sourceOf(d, values, options.time);
    this.commit('Add effect layer', { ...this.doc, layers, activeLayerId: layer.id, effectLayers: { ...(this.doc.effectLayers ?? {}), [layer.id]: source } });
    return { layer: this.describeLayer(layer), source };
  }

  /**
   * Draws an effect layer again with new `values` (merged over its own; `null` resets one) or
   * `time`, at the canvas size, replacing its pixels (paint on it is lost). One undo step; with
   * `commitToHistory` false it joins the previous effect layer step (a slider drag).
   */
  async updateEffectLayer(layerId: string, changes: { values?: Record<string, EffectValue | null>; time?: number }, commitToHistory = true): Promise<PaintEffectSource> {
    this.requireIdle('changing an effect layer');
    const was = this.getEffectLayer(layerId);
    if (!was) throw new PaintEditorError(`"${layerId}" is not an effect layer; add one with add_effect_layer.`);
    this.checkTime(changes.time);
    const l = this.effectTarget(layerId, 'draw the effect on');
    const d = await this.describeEffect(was.effect, 'layer');
    const values = this.effectValues(d, was.values, changes.values);
    const time = changes.time ?? was.time ?? 0;
    const pixels = await this.renderEffectCanvas(d, values, time);
    const now = this.getLayer(l.id);
    this.requireIdle('changing an effect layer');
    if (!isPixelLayer(now)) throw new PaintEditorError(`Layer "${l.name}" was removed while the effect rendered.`);
    const source = this.sourceOf(d, values, time);
    this.commitOrAmend('Effect layer', { ...this.doc, layers: mapLayer(this.doc.layers, l.id, () => ({ ...now, surface: surfaceFromPixels(pixels, 4), offset: { x: 0, y: 0 } })), effectLayers: { ...(this.doc.effectLayers ?? {}), [l.id]: source } }, commitToHistory);
    return source;
  }

  /** Turns an effect layer into a plain pixel layer, keeping its pixels (one undo step). */
  rasterizeEffectLayer(layerId: string): PaintLayerInfo {
    this.requireIdle('changing an effect layer');
    if (!this.getEffectLayer(layerId)) throw new PaintEditorError(`"${layerId}" is not an effect layer; list_applied_effects lists them.`);
    const { [layerId]: _gone, ...rest } = this.doc.effectLayers ?? {};
    this.commit('Rasterize effect layer', { ...this.doc, effectLayers: rest });
    return this.describeLayer(this.requireLayer(layerId));
  }

  /**
   * Fills a layer with a provider generator, overlay or title effect: its pixels, rendered at the
   * canvas size, are composited onto the layer's paint at `opacity` (only where it is already
   * painted with `lockTransparency`, or when the layer's transparency is locked). One undo step.
   */
  async fillLayerWithEffect(effect: string, options: { layerId?: string; values?: Record<string, EffectValue>; opacity?: number; time?: number; lockTransparency?: boolean } = {}): Promise<{ layerId: string; source: PaintEffectSource }> {
    this.requireIdle('filling');
    this.checkOpacity(options.opacity);
    this.checkTime(options.time);
    const l = this.effectTarget(options.layerId, 'fill');
    const d = await this.describeEffect(effect, 'fill');
    const values = this.effectValues(d, { ...d.defaults } as Record<string, EffectValue>, options.values);
    const pixels = await this.renderEffectCanvas(d, values, options.time);
    const now = this.sameLayerAfterRender(l);
    const rect = this.canvasRectOf(now);
    const before = readRegion(now.surface, rect);
    let after = overPixels(before, pixels.data, options.opacity ?? 1);
    if (options.lockTransparency || isLayerLocked(now, 'transparency')) after = mixPixels(before, after, 1);
    const surface = writeRegion(now.surface, rect, after);
    this.commit('Effect fill', { ...this.doc, layers: mapLayer(this.doc.layers, now.id, () => ({ ...now, surface })) });
    return { layerId: now.id, source: this.sourceOf(d, values, options.time) };
  }

  // --- Effect paint ----------------------------------------------------------------

  /**
   * At most this many rendered effect paints are kept (each is canvas-sized), more only while
   * something needs them all: a replay's batch, and the path-mapped strokes on stroke layers,
   * which each have a render of their own and are redrawn synchronously.
   */
  private static readonly EFFECT_PAINT_CACHE = 6;

  /** The effect paint strokes use (or the one rendering), or `null`. */
  getEffectPaint(): PaintEffectPaint | null {
    const p = this.effectPaintPending ?? this.effectPaint;
    return p ? { ...p, values: JSON.parse(JSON.stringify(p.values)) } : null;
  }

  /**
   * Paints with a provider generator, overlay or title effect: it is rendered once at the canvas
   * size, and brushes then take each pixel's colour (and alpha) from it, fixed to the canvas, as if
   * painting a hidden picture into view. `setColor` and `setPaint` go back to colour. Editor state,
   * not an undo step. Strokes that would paint with it throw while it renders. Returns the paint.
   * With `map: { by: 'stroke' }` the effect lies along each stroke as a strip; with
   * `map: { by: 'path' }` an effect with a path control (`format: 'svg-path'`) draws itself along
   * each stroke's centreline in canvas pixels; with `live`, strokes on a stroke layer keep playing
   * it (see `setEffectPlayback`).
   */
  async setEffectPaint(source: { effect: string; values?: Record<string, EffectValue | null>; time?: number; map?: unknown; live?: boolean }): Promise<PaintEffectPaint> {
    if (!source || typeof source.effect !== 'string' || !source.effect) throw new PaintEditorError('effect is missing; pass an effect id from search_effects (use generator, overlay or title).');
    this.checkTime(source.time);
    let map: PaintEffectPaint['map'];
    try {
      map = readEffectStrokeMap(source.map);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    if (source.live !== undefined && typeof source.live !== 'boolean') throw new PaintEditorError('live must be true or false.');
    const epoch = ++this.paintEpoch;
    const changed = (name: string) => new PaintEditorError(`The paint changed while "${name}" rendered (set_color, set_paint or another set_effect_paint); call set_effect_paint again to paint with it.`);
    const d = await this.describeEffect(source.effect, 'paint');
    if (map?.by === 'path' && !pathControlsOf(d).length) {
      throw new PaintEditorError(`Effect "${d.id}" has no path control (format "svg-path"); use by: "stroke" (bent along each stroke) or by: "canvas" (fixed to the canvas).`);
    }
    const values = this.effectValues(d, { ...d.defaults } as Record<string, EffectValue>, source.values);
    if (epoch !== this.paintEpoch) throw changed(d.name);
    const paint: PaintEffectPaint = { type: 'effect', effect: d.id, provider: this.effects.require().id, values, time: source.time ?? 0, ...(map ? { map } : {}), ...(source.live ? { live: true } : {}) };
    this.effectPaintPending = paint;
    this.emit([]);
    try {
      await this.renderEffectPaint(paint);
    } catch (e) {
      if (this.effectPaintPending === paint) {
        this.effectPaintPending = null;
        this.emit([]);
      }
      throw e;
    }
    if (this.effectPaintPending !== paint || epoch !== this.paintEpoch) throw changed(d.name);
    this.effectPaintPending = null;
    this.effectPaint = paint;
    this.gradient = null;
    this.emit([]);
    return this.getEffectPaint()!;
  }

  /** The rendered pixels of an effect paint at the current canvas size, or `null` when it has not been rendered. */
  private effectPaintImage(p: PaintEffectPaint): EffectPaintPixels | null {
    const key = effectPaintKey(p);
    const img = this.effectPaintPixels.get(key);
    const size = effectPaintSize(p, this.doc.canvas);
    if (!img || img.width !== size.width || img.height !== size.height) return null;
    this.effectPaintPixels.delete(key);
    this.effectPaintPixels.set(key, img);
    return img;
  }

  private cacheEffectPaintPixels(p: PaintEffectPaint, pixels: EffectPixels): EffectPaintPixels {
    return this.cacheEffectPaintImage(p, toEffectPaintPixels(p, pixels));
  }

  private cacheEffectPaintImage(p: PaintEffectPaint, img: EffectPaintPixels): EffectPaintPixels {
    this.effectPaintPixels.set(effectPaintKey(p), img);
    this.trimEffectPaints();
    return img;
  }

  private trimEffectPaints(): void {
    let live = 0;
    for (const list of Object.values(this.doc.liveStrokes ?? {})) for (const s of list) if (s.paint?.type === 'effect' && s.paint.map?.by === 'path') live++;
    // One more than the live strokes, for the editor's own paint.
    const limit = Math.max(PaintEditorController.EFFECT_PAINT_CACHE, this.effectPaintBatch, live + 1);
    while (this.effectPaintPixels.size > limit) this.effectPaintPixels.delete(this.effectPaintPixels.keys().next().value!);
  }

  /** Renders an effect paint on the caller's stack when its renderer is warm and has `renderSync`; otherwise `null`. */
  private renderEffectPaintSync(p: PaintEffectPaint): EffectPaintPixels | null {
    const have = this.effectPaintImage(p);
    if (have) return have;
    const provider = this.effects.provider;
    if (!provider || (p.provider && provider.id !== p.provider)) return null;
    const size = effectPaintSize(p, this.doc.canvas);
    const pixels = this.effectsRenderer.renderSync(provider, p.effect, size, { time: p.time, values: p.values });
    return pixels ? this.cacheEffectPaintPixels(p, pixels) : null;
  }

  /** Renders an effect paint at the canvas size into the cache (nothing when it is there already). */
  private async renderEffectPaint(p: PaintEffectPaint): Promise<EffectPaintPixels> {
    const have = this.effectPaintImage(p);
    if (have) return have;
    return this.cacheEffectPaintImage(p, await this.renderEffectPaintPixels(p));
  }

  /** Renders an effect paint at the canvas size without keeping it. */
  private async renderEffectPaintPixels(p: PaintEffectPaint): Promise<EffectPaintPixels> {
    const provider = this.effects.provider;
    const what = `the effect "${p.effect}"${p.provider ? ` from provider "${p.provider}"` : ''}`;
    if (!provider) throw new PaintEditorError(`Effect paint needs ${what}, but no effects provider is registered; register it (setEffectsProvider) and try again.`);
    if (p.provider && provider.id !== p.provider) throw new PaintEditorError(`Effect paint needs ${what}, but the registered provider is "${provider.id}"; register "${p.provider}" (setEffectsProvider) and try again.`);
    const { width, height } = effectPaintSize(p, this.doc.canvas);
    let pixels: EffectPixels;
    try {
      pixels = await this.effectsRenderer.render(provider, p.effect, { width, height }, { time: p.time, values: p.values });
    } catch (e) {
      throw new PaintEditorError(`Effect paint could not render ${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return toEffectPaintPixels(p, pixels);
  }

  /**
   * Renders effect paints that are not rendered yet (strokes and replays need them rendered
   * first, since strokes are synchronous). Throws naming the effect and provider when one cannot be.
   */
  async prepareEffectPaints(paints: Iterable<PaintEffectPaint>): Promise<void> {
    const list = [...paints];
    this.effectPaintBatch = new Set(list.map(effectPaintKey)).size;
    const seen = new Set<string>();
    for (const p of list) {
      const key = effectPaintKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      await this.renderEffectPaint(p);
    }
  }

  /**
   * Renders the path-mapped effect paint for one or more strokes' points before a synchronous
   * stroke call runs (`paint_stroke` and `stroke_path` do; `paintStroke` throws without it on a
   * provider that can't render synchronously). For a stroke layer edit, see `prepareStrokeEdit`.
   */
  async prepareStrokePathEffect(init: PaintStrokeInit, pointsList: readonly (readonly PenPoint[])[]): Promise<void> {
    const brush = this.strokeBrush(init);
    if (!brushTakesPaint(brush)) return;
    let source: PaintEffectPaint | null = null;
    if (init.paint !== undefined) {
      if (!isPaintEffectPaint(init.paint)) return;
      source = readPaintEffectPaint(init.paint);
    } else if (init.color === undefined && !brush.paint && !this.effectPaintPending) {
      source = this.effectPaint;
    }
    if (!source || source.map?.by !== 'path') return;
    if (!this.effectPathControls.has(source.effect)) await this.describeEffect(source.effect);
    const control = this.effectPathControls.get(source.effect);
    const paints = pointsList.filter((pts) => pts.length > 0).map((pts) => withStrokePath(source!, pts, control));
    if (paints.length) await this.prepareEffectPaints(paints);
  }

  /**
   * Renders what an edit of a stroke layer's stroke paints with (`updateStroke`, `editStrokePoints`):
   * a new effect paint, or a path-mapped stroke's new path. Those calls are synchronous, and throw
   * without it on a provider that can't render synchronously. Bad edits are left for them to refuse.
   */
  async prepareStrokeEdit(id: string, edit: { paint?: unknown; points?: readonly PenPoint[]; transform?: StrokeVariation }): Promise<void> {
    const p = this.strokeEditPaint(id, edit);
    if (!p) return;
    if (p.map?.by === 'path' && !this.effectPathControls.has(p.effect)) await this.describeEffect(p.effect);
    await this.prepareEffectPaints([this.strokeEditPaint(id, edit) ?? p]);
  }

  /** Whether `prepareStrokeEdit` has to be awaited before this edit can run. */
  strokeEditNeedsRender(id: string, edit: { paint?: unknown; points?: readonly PenPoint[]; transform?: StrokeVariation }): boolean {
    const p = this.strokeEditPaint(id, edit);
    return Boolean(p && !this.effectPaintImage(p) && !this.renderEffectPaintSync(p));
  }

  private strokeEditPaint(id: string, edit: { paint?: unknown; points?: readonly PenPoint[]; transform?: StrokeVariation }): PaintEffectPaint | null {
    const was = Object.values(this.doc.liveStrokes ?? {}).flat().find((s) => s.id === id);
    if (!was) return null;
    try {
      if (edit.paint !== undefined) {
        if (!isPaintEffectPaint(edit.paint)) return null;
        const p = readPaintEffectPaint(edit.paint);
        return p && withStrokePath(p, was.points, this.effectPathControls.get(p.effect));
      }
      if (was.paint?.type !== 'effect' || was.paint.map?.by !== 'path') return null;
      if (edit.points !== undefined) return withStrokePath(was.paint, this.checkPoints(edit.points), this.effectPathControls.get(was.paint.effect));
      if (!edit.transform) return null;
      const varied = varyStroke(was, this.strokeTransform(was, edit.transform), {}).paint;
      return varied?.type === 'effect' ? varied : null;
    } catch {
      return null;
    }
  }

  /** A stroke edit's transform as an affine map, checked. */
  private strokeTransform(stroke: RecordedStroke, t: StrokeVariation): Affine {
    if (t.scale !== undefined && !(t.scale > 0 && t.scale <= 20)) throw new PaintEditorError(`scale ${t.scale} is out of range; use above 0 up to 20.`);
    for (const k of ['dx', 'dy', 'rotate'] as const) if (t[k] !== undefined && !Number.isFinite(t[k])) throw new PaintEditorError(`${k} must be a number.`);
    const b = strokeBounds(stroke.points);
    return variationAffine(t, t.origin ?? { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  }

  /** Renders the effect paints of recorded strokes (default all of them) before a replay. */
  async prepareStrokeEffects(strokeIds?: readonly string[], variation?: ReplayOptions): Promise<void> {
    const ids = strokeIds ? new Set(strokeIds) : null;
    const strokes = this.doc.strokes.filter((s) => (!ids || ids.has(s.id)) && s.paint?.type === 'effect');
    const paints = strokes.map((s) => s.paint as PaintEffectPaint);
    if (variation && strokes.length) {
      const repeat = Math.max(1, Math.min(100, variation.repeat ?? 1));
      let origin = variation.origin;
      if (!origin) {
        const b = strokeBounds(strokes.flatMap((s) => s.points));
        origin = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }
      const step = variationAffine(variation, origin);
      let m: Affine = IDENTITY_AFFINE;
      for (let k = 0; k < repeat; k++) {
        m = [step[0] * m[0] + step[1] * m[2], step[0] * m[1] + step[1] * m[3], step[2] * m[0] + step[3] * m[2], step[2] * m[1] + step[3] * m[3], step[0] * m[4] + step[1] * m[5] + step[4], step[2] * m[4] + step[3] * m[5] + step[5]];
        for (const s of strokes) {
          const v = varyStroke(s, m, variation);
          if (v.paint?.type === 'effect') paints.push(v.paint);
        }
      }
    }
    await this.prepareEffectPaints(paints);
  }

  /** A small preview of the effect paint (a PNG data URL `size` px wide), or `null` without a rendered one. */
  effectPaintThumbnail(size = 48): string | null {
    const p = this.effectPaint;
    const img = p ? this.effectPaintImage(p) : null;
    if (!img) return null;
    const w = Math.max(1, Math.min(img.width, Math.round(size)));
    const h = Math.max(1, Math.round((img.height / img.width) * w));
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / w));
        const i = (sy * img.width + sx) * 4;
        const o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) out[o + c] = img.data[i + c];
      }
    }
    return pngDataUrl(w, h, out);
  }

  /**
   * The effect paint a stroke paints with and its pixels, or `null`: the stroke's own effect
   * `paint`, else (without its own `paint` or `color`, and with no brush gradient) the editor's.
   * Throws while the editor's is still rendering, for an engine that cannot paint with it, or when
   * its pixels are not rendered.
   */
  private strokeEffect(init: PaintStrokeInit, brush: PaintBrush, points?: readonly PenPoint[]): { source: PaintEffectPaint; pixels: EffectPaintPixels } | null {
    if (!brushTakesPaint(brush)) return null;
    let source: PaintEffectPaint | null = null;
    if (init.paint !== undefined) {
      if (!isPaintEffectPaint(init.paint)) return null;
      source = readPaintEffectPaint(init.paint);
      if (!source) throw new PaintEditorError('The stroke\'s effect paint needs an effect id and values (getEffectPaint returns one).');
    } else if (init.color === undefined && !brush.paint) {
      if (this.effectPaintPending) throw new PaintEditorError(`The effect paint "${this.effectPaintPending.effect}" is still rendering; wait for set_effect_paint to finish, then paint.`);
      source = this.effectPaint;
    }
    if (!source) return null;
    const path = source.map?.by === 'path';
    if (path && points?.length) source = withStrokePath(source, points, this.effectPathControls.get(source.effect));
    const pixels = this.effectPaintImage(source) ?? (path ? this.renderEffectPaintSync(source) : null);
    if (!pixels) throw new PaintEditorError(`The effect paint "${source.effect}"${source.provider ? ` from provider "${source.provider}"` : ''} is not rendered at this canvas size; call ${path ? 'prepareStrokePathEffect (the paint_stroke tool does this) or prepareStrokeEdit' : 'set_effect_paint (or prepareEffectPaints)'} first.`);
    return { source, pixels };
  }

  /**
   * Runs a filter effect (light, glow, colour grade …) on a layer's dried paint and bakes it in, at
   * `amount` strength (0..1, default 1). Transparent areas stay transparent; thick paint keeps its
   * relief, and an effect with a `height` input gets the relief as a height map. Wet paint is
   * refused (dry it first). One undo step.
   */
  async applyLightEffect(layerId: string | undefined, effect: string, options: { values?: Record<string, EffectValue>; amount?: number; time?: number } = {}): Promise<{ layerId: string; source: PaintEffectSource; amount: number }> {
    this.requireIdle('applying an effect');
    const amount = options.amount ?? 1;
    if (!(amount >= 0 && amount <= 1)) throw new PaintEditorError(`amount ${options.amount} is out of range; use 0..1.`);
    this.checkTime(options.time);
    const l = this.effectTarget(layerId, 'light');
    if (!contentBounds(l.surface)) throw new PaintEditorError(`Layer "${l.name}" has no paint to light; paint on it first, or add an effect layer (add_effect_layer).`);
    const d = await this.describeEffect(effect, 'light');
    const values = this.effectValues(d, { ...d.defaults } as Record<string, EffectValue>, options.values);
    const rect = this.canvasRectOf(l);
    const before = readRegion(l.surface, rect);
    const inputs: Record<string, EffectPixels> = { source: { width: rect.width, height: rect.height, data: before } };
    const heightInput = d.inputs.find((i) => i.kind === 'image' && /^(height|depth|relief)$/i.test(i.name));
    const relief = this.doc.thick?.[l.id];
    if (heightInput && relief) {
      const h = readRegion(relief.height, rect);
      const rgba = new Uint8ClampedArray(rect.width * rect.height * 4);
      for (let i = 0; i < h.length; i++) rgba.set([h[i], h[i], h[i], 255], i * 4);
      inputs[heightInput.name] = { width: rect.width, height: rect.height, data: rgba };
    }
    const sourceInput = d.inputs.find((i) => i.kind === 'image' && i.name !== heightInput?.name)?.name ?? 'source';
    if (sourceInput !== 'source') {
      inputs[sourceInput] = inputs.source;
      delete inputs.source;
    }
    const out = await this.effectsRenderer.render(this.effects.require(), d.id, { width: rect.width, height: rect.height }, { time: options.time ?? 0, values, inputs });
    const now = this.sameLayerAfterRender(l);
    const surface = writeRegion(now.surface, rect, mixPixels(before, out.data, amount));
    this.commit('Light effect', { ...this.doc, layers: mapLayer(this.doc.layers, now.id, () => ({ ...now, surface })) });
    return { layerId: now.id, source: this.sourceOf(d, values, options.time), amount };
  }

  // --- Brushes -------------------------------------------------------------------

  private findEntry(id: string): LibraryBrush | undefined {
    return this.brushEntries.find((e) => e.brush.id === id);
  }

  private findBrush(id: string): PaintBrush | undefined {
    return this.findEntry(id)?.brush;
  }

  private requireEntry(id: string): LibraryBrush {
    const e = this.findEntry(id);
    if (!e) throw new PaintEditorError(`Unknown brush "${id}". ${closest(id, this.brushEntries.map((x) => x.brush.id))}Call list_brush_presets for the ids.`);
    return e;
  }

  private requireBrush(id: string): PaintBrush {
    return this.requireEntry(id).brush;
  }

  /** Reads the library again (after a change anywhere it is shared). */
  private refreshBrushes(): Promise<void> {
    const library = this.brushLibrary;
    const sources = typeof library.listSources === 'function' ? library.listSources().catch(() => []) : Promise.resolve([]);
    const run = Promise.all([library.list(), sources]).then(([entries, list]) => {
      this.brushSources.set(list);
      this.brushEntries = entries.map((e) => libraryBrush(e.brush, e.builtin));
      this.library = null;
      const pending = this.pendingBrushId;
      this.pendingBrushId = null;
      if (pending && this.findEntry(pending)) this.setBrush({ id: pending });
      else this.emit([]);
    });
    this.brushesLoaded = run.catch(() => undefined);
    return run;
  }

  /** Resolves once the brush library has been read (user brushes kept in storage are listed from then on). */
  whenBrushesLoaded(): Promise<void> {
    return this.brushesLoaded;
  }

  /** A library brush by id, as the engine paints it (`undefined` when unknown). */
  getBrush(id: string): PaintBrush | undefined {
    const b = this.findBrush(id);
    return b ? normalizePaintBrush(b, b) : undefined;
  }

  /** A library brush by id as stored (its facets), or without an id the active brush as edited. */
  getBrushSpec(id?: string): Brush | undefined {
    const spec = id === undefined ? this.brushSpec : this.findEntry(id)?.spec;
    return spec ? copyJSON(spec) : undefined;
  }

  /**
   * Chooses the active brush (`id`: a library brush) and / or changes its engine settings. Editor
   * state, not an undo step. Returns the active brush. `setBrushFacets` changes it by facets.
   */
  setBrush(update: { id?: string } & Omit<PaintBrushInput, 'id'> = {}): PaintBrush {
    const { id, ...changes } = update;
    const entry = id !== undefined ? this.requireEntry(id) : null;
    const base = entry ? entry.brush : this.brush;
    const baseSpec = entry ? entry.spec : this.brushSpec;
    // Gradient paint is checked strictly here (documents and presets are read leniently).
    if (changes.paint !== undefined && changes.paint !== null) this.readStrokePaint(changes.paint);
    const unchanged = !Object.keys(changes).length;
    const next = normalizePaintBrush({ ...changes, id: base.id }, base);
    if (entry) this.takeBrushColour(entry.spec);
    this.useBrush(next, unchanged ? baseSpec : brushSpecOf(next, baseSpec), unchanged && base.builtin === true);
    return this.brush;
  }

  /**
   * Chooses the active brush (`id`: a library brush) and / or lays a facet patch over it (objects
   * merge, lists and values replace, as the library's `update_brush` does). Editor state, not an
   * undo step. `unset` removes whole facets first. Returns the active brush as the engine paints
   * it, its facets, and what was clamped or dropped.
   */
  setBrushFacets(patch: BrushPatch = {}, id?: string, unset: readonly UnsettableBrushFacet[] = []): { brush: PaintBrush; spec: Brush; problems: string[] } {
    const entry = id !== undefined ? this.requireEntry(id) : null;
    const unchanged = !Object.keys(patch).length && !unset.length;
    const problems: string[] = [];
    const base = copyJSON(entry ? entry.spec : this.brushSpec) as Brush & Record<string, unknown>;
    for (const k of unset) delete base[k];
    const spec = this.readBrushPatch(base, patch, problems);
    // Choosing a brush (or giving it a default colour) takes its default colour, unless the colour is locked.
    if (entry || patch.colour?.default !== undefined) this.takeBrushColour(spec);
    this.useBrush(unchanged && entry ? entry.brush : resolveBrush(spec), spec, unchanged && entry?.builtin === true);
    return { brush: this.brush, spec: copyJSON(this.brushSpec), problems };
  }

  /**
   * Makes `spec` (a whole facet brush, as the brush editor edits it) the active brush, keeping the
   * active brush's id. Editor state, not an undo step. Returns it as the engine paints it, its
   * facets, and what was clamped or dropped.
   */
  setBrushSpec(spec: Brush): { brush: PaintBrush; spec: Brush; problems: string[] } {
    const problems: string[] = [];
    const paint = spec.colour?.default;
    if (paint && typeof paint === 'object' && 'type' in paint && paint.type === 'gradient') this.readStrokePaint(paint);
    let next: Brush;
    try {
      next = normalizeBrushSpec({ ...spec, id: this.brush.id }, problems);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    this.useBrush(resolveBrush(next), next, false);
    return { brush: this.brush, spec: copyJSON(this.brushSpec), problems };
  }

  /**
   * The engine settings a facet patch changes on a brush (`from`: a library brush id or a brush as
   * painted; default the active brush), as `paintStroke`'s and `updateStroke`'s `brush` take them.
   */
  brushChanges(patch: BrushPatch, from?: string | PaintBrush): Omit<PaintBrushInput, 'id'> {
    const entry = typeof from === 'string' ? this.requireEntry(from) : null;
    const base = entry ? entry.brush : typeof from === 'object' ? normalizePaintBrush(from, from) : this.brush;
    const spec = entry ? entry.spec : typeof from === 'object' ? migrateBrushV1(base) : this.brushSpec;
    return engineChanges(base, resolveBrush(this.readBrushPatch(spec, patch, [])));
  }

  private readBrushPatch(base: Brush, patch: BrushPatch, problems: string[]): Brush {
    const { id: _id, name, ...rest } = patch as BrushPatch & { id?: unknown };
    // Gradient paint is checked strictly here (documents and presets are read leniently).
    const paint = rest.colour?.default;
    if (paint && typeof paint === 'object' && 'type' in paint && paint.type === 'gradient') this.readStrokePaint(paint);
    try {
      return normalizeBrushSpec(mergeBrushPatch(base as unknown as Record<string, unknown>, { ...rest, ...(name !== undefined ? { name } : {}) }), problems);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
  }

  private useBrush(next: PaintBrush, spec: Brush, builtin: boolean): void {
    next = normalizePaintBrush(next, next);
    const refusal = mutationBrushRefusal(next);
    if (refusal) throw new PaintEditorError(refusal);
    // The active brush is `builtin` only while it is an unchanged built-in preset.
    if (builtin) next.builtin = true;
    else delete next.builtin;
    this.brush = next;
    this.brushSpec = { ...copyJSON(spec), id: next.id, name: next.name };
    this.pendingBrushId = null;
    this.emit([]);
    // Provider stickers are loaded now, so the spray can draw them by the time the stroke starts.
    const refs = brushStickerRefs(next);
    if (refs.length) void this.prepareStickers(refs).catch(() => this.emit([]));
  }

  /**
   * Saves the active brush (or `brush`, engine settings on top of it) into the brush library under
   * `id` / `name`, replacing a user brush with that id. Built-in ids are refused. Resolves with the
   * saved brush.
   */
  async saveBrush(options: { id: string; name?: string; brush?: PaintBrushInput }): Promise<PaintBrush> {
    if (!BRUSH_ID.test(options.id)) throw new PaintEditorError(`Brush id "${options.id}" is invalid; use lowercase letters, digits and dashes (e.g. "my-pencil").`);
    if (this.brushLibrary.isBuiltin(options.id)) throw new PaintEditorError(`"${options.id}" is a built-in brush; save under another id.`);
    const spec = options.brush ? brushSpecOf(normalizePaintBrush(options.brush, this.brush), this.brushSpec) : this.brushSpec;
    const { brush } = await libraryCall(() => this.brushLibrary.save({ ...spec, id: options.id, name: options.name ?? spec.name }, { overwrite: true }));
    await this.refreshBrushes();
    return this.requireBrush(brush.id);
  }

  /** Removes a user brush from the brush library (built-in brushes can't be removed). */
  async removeBrush(id: string): Promise<void> {
    if (this.brushLibrary.isBuiltin(id)) throw new PaintEditorError(`"${id}" is a built-in brush and cannot be removed.`);
    if (!(await libraryCall(() => this.brushLibrary.remove(id)))) throw new PaintEditorError(`Unknown brush "${id}". Call list_brush_presets for the ids.`);
    await this.refreshBrushes();
  }

  /** The user's saved brushes, as the engine paints them. */
  getUserBrushes(): PaintBrush[] {
    return this.brushEntries.filter((e) => !e.builtin).map((e) => normalizePaintBrush(e.brush, e.brush));
  }

  /** A brush library file (version 2) of the given brushes (default: the user's brushes). */
  exportBrushes(ids?: readonly string[]): Promise<BrushLibraryFile> {
    return libraryCall(() => this.brushLibrary.exportFile(ids));
  }

  /**
   * Adds the brushes of a library file (version 1 or 2) to the brush library. A brush whose id is
   * taken is skipped unless `replace` (built-in ids are always skipped). Resolves with the ids
   * added or replaced, the ids skipped and the problems.
   */
  async importBrushes(file: unknown, options: { replace?: boolean } = {}): Promise<{ added: string[]; skipped: string[]; problems: string[] }> {
    const r = await libraryCall(() => this.brushLibrary.importFile(file, { overwrite: !!options.replace }));
    await this.refreshBrushes();
    return { added: [...r.added, ...r.replaced], skipped: r.skipped, problems: r.problems };
  }

  /** A thumbnail of a brush: a test stroke on the current paper. */
  brushThumbnail(id: string, options: { width?: number; height?: number; color?: string } = {}): BrushThumbnail {
    const b = id === this.brush.id ? this.brush : this.requireBrush(id);
    return renderBrushThumbnail(b, { paper: this.doc.paper, width: options.width, height: options.height, color: options.color ? parseColor(options.color) : this.color, stampArt: this.stampArt });
  }

  // --- Colour --------------------------------------------------------------------

  private colorScheme: ColorScheme;
  private colorLocked = false;
  /** The brush default colour the paint colour came from (resolved again when the scheme changes), or `null`. */
  private brushColour: ColorValue | null = null;

  /**
   * The host's colour scheme: a paint colour that came from a brush's light / dark default
   * resolves to the new side. Editor state, not an undo step.
   */
  setColorScheme(scheme: ColorScheme): void {
    const next: ColorScheme = scheme === 'dark' ? 'dark' : 'light';
    if (next === this.colorScheme) return;
    this.colorScheme = next;
    const hex = this.brushColour ? brushColourHex(this.brushColour, next) : null;
    if (hex) this.color = hex;
    // The sticker brush sprays dark variants on a dark scheme: load them now.
    const refs = brushStickerRefs(this.brush);
    if (refs.some((r) => !editorStampOf(r))) void this.prepareStickers(refs).catch(() => this.emit([]));
    this.emit([]);
  }

  /** Locks the paint colour: choosing a brush with a default colour keeps it. Editor state, not an undo step. */
  setColorLocked(locked: boolean): void {
    if (this.colorLocked === locked) return;
    this.colorLocked = locked;
    this.emit([]);
  }

  /**
   * After the user chooses a brush: its solid or light / dark default colour becomes the paint
   * colour (resolved for the colour scheme), unless the colour is locked. Gradient defaults are the
   * brush's own paint already; effect defaults stay a suggestion.
   */
  private takeBrushColour(spec: Brush): void {
    if (this.colorLocked) return;
    const d = spec.colour?.default;
    const hex = d !== undefined ? brushColourHex(d, this.colorScheme) : null;
    if (!hex) return;
    this.color = hex;
    this.gradient = null;
    this.effectPaint = this.effectPaintPending = null;
    this.paintEpoch++;
    this.brushColour = d as ColorValue;
  }

  /** A brush that always paints its own colour (`colour.own`): that colour, resolved for the scheme now; else `null`. */
  private ownColour(brushId: string | undefined): string | null {
    const spec = brushId !== undefined ? this.findEntry(brushId)?.spec : this.brushSpec;
    const d = spec?.colour?.own ? spec.colour.default : undefined;
    return d !== undefined ? brushColourHex(d, this.colorScheme) : null;
  }

  /** Sets the paint colour (and goes back to one colour from gradient paint). */
  setColor(color: string): string {
    this.color = parseColor(color);
    this.brushColour = null;
    this.gradient = null;
    this.effectPaint = this.effectPaintPending = null;
    this.paintEpoch++;
    this.emit([]);
    return this.color;
  }

  /**
   * Sets what strokes paint with: one colour (`{ type: 'color', color }` or `#rrggbb`), or gradient
   * paint (`{ type: 'gradient', stops, space?, map?, softness? }`, see `@pixerate/editor/paint`),
   * which brushes sample dab by dab as the stroke goes. Not an undo step. Throws with what is wrong
   * with an invalid source. Returns the paint.
   */
  setPaint(paint: PaintSource | string): PaintSource {
    let p: PaintSource;
    try {
      p = parsePaintSource(paint);
    } catch (e) {
      if (e instanceof PaintSourceError) throw new PaintEditorError(e.message);
      throw e;
    }
    if (p.type === 'color') {
      this.setColor(p.color);
      return p;
    }
    this.gradient = p;
    this.effectPaint = this.effectPaintPending = null;
    this.paintEpoch++;
    this.emit([]);
    return p;
  }

  /**
   * The gradient a stroke paints (resolved against its colours: no `paint` / `secondary` stops),
   * or `null` for one colour: the stroke's own `paint`, else (without an explicit `color`) the
   * brush's gradient, else the editor's gradient paint. Erasers, blenders and smudges take none.
   */
  private strokeGradient(init: PaintStrokeInit, brush: PaintBrush, color: string): PaintGradientSource | null {
    if (!brushTakesPaint(brush)) return null;
    let g: PaintGradientSource | null = null;
    if (init.paint !== undefined) {
      if (isPaintEffectPaint(init.paint)) return null;
      const p = this.readStrokePaint(init.paint);
      g = p.type === 'gradient' ? p : null;
    } else g = brush.paint ?? (init.color === undefined ? this.gradient : null);
    return g ? resolvePaintGradient(g, { paint: color, secondary: this.secondaryColor }) : null;
  }

  private readStrokePaint(raw: unknown): PaintSource {
    try {
      return parsePaintSource(raw);
    } catch (e) {
      if (e instanceof PaintSourceError) throw new PaintEditorError(e.message);
      throw e;
    }
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

  /**
   * The colour at a document pixel: of the composite or of one layer. The composite includes the
   * paper unless `paper` is false, so a pick where nothing is painted comes back with alpha 0.
   */
  pickColor(x: number, y: number, options: { layerId?: string; paper?: boolean } = {}): { color: string; alpha: number } {
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
    const d = this.exportCompositor.composite(this.renderLayers({ paper: options.paper }), { x: px, y: py, width: 1, height: 1 }, this.sources());
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

  private sessionFor(doc: PaintDocumentState, init: PaintStrokeInit, host: StrokeSessionHost, points?: readonly PenPoint[]): PaintStrokeSession {
    if (init.paint !== undefined && !isPaintEffectPaint(init.paint)) {
      const p = this.readStrokePaint(init.paint);
      if (p.type === 'color') init = { ...init, color: p.color, paint: undefined };
      else init = { ...init, paint: p };
    }
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
    const mutRefusal = mutationBrushRefusal(brush);
    if (mutRefusal) throw new PaintEditorError(mutRefusal);
    // A preview is rolled back, and the wet simulation can't be: refuse before it is touched.
    if (this.previewing && isWetBrush(brush)) throw new PaintEditorError(`Wet paint can't be previewed; the ${brush.name} brush paints wet media. Suggest it with a dry brush.`);
    if (brush.ghost) {
      if (brush.light.amount > 0) throw new PaintEditorError(`Ghost paint (${brush.name}) shares the wet light channel and can't emit light; set light.amount to 0 or ghost to null (set_brush).`);
      if (isPaintEffectPaint(init.paint) || (init.paint === undefined && init.color === undefined && Boolean(this.effectPaint))) {
        throw new PaintEditorError(`Ghost paint (${brush.name}) needs a single colour to subtract as it fades, so it can't paint with an effect; set a solid colour (set_color) or pass color to paint_stroke.`);
      }
      if (brush.behavior.multicolor.mode !== 'off') throw new PaintEditorError(`Ghost paint (${brush.name}) needs a single colour to subtract as it fades, so it can't use multi-colour paint; set behavior.multicolor.mode to "off" (set_brush).`);
      const gCol = init.color === undefined ? (this.ownColour(init.brushId) ?? this.color) : parseColor(init.color);
      if (this.strokeGradient(init, brush, gCol)) throw new PaintEditorError(`Ghost paint (${brush.name}) needs a single colour to subtract as it fades, so it can't paint a gradient; set a solid colour (set_color) or pass color to paint_stroke.`);
      if (Boolean(doc.light?.[layer.id]?.tiles.size) || Boolean(this.wet.world?.hasLane(layer.id) && this.wet.world.isLit(layer.id))) {
        throw new PaintEditorError(`Layer "${layer.name}" holds light paint, and ghost paint shares the wet light channel; paint on another layer (add_layer) or clear the light first (clear_light).`);
      }
    }
    const effect = this.strokeEffect(init, brush, points);
    // A hand-painted path stroke is painted again from its path at the end, and the wet simulation can't be.
    if (!points && init.paint === undefined && effect?.source.map?.by === 'path' && isWetBrush(brush)) {
      throw new PaintEditorError(`The ${brush.name} brush paints wet media, which can't follow a path that isn't known until the stroke ends; paint with a dry brush, set_effect_paint with by: "stroke", or give the points to paint_stroke.`);
    }
    if (brush.light.amount > 0) {
      if (brush.engine === 'sticker') throw new PaintEditorError(`The ${brush.name} brush sprays stickers, which don't take light yet; paint light with a dab or particle light brush (glow-gel, neon-marker; list_brush_presets lists them), or set light.amount to 0 (set_brush).`);
      if (Boolean(this.wet.world?.hasLane(layer.id) && this.wet.world.getGhost(layer.id)) || Boolean(this.wet.settings.get(layer.id)?.ghost)) {
        throw new PaintEditorError(`Layer "${layer.name}" has ghost paint fading on it, which uses the wet light channel; paint light on another layer (add_layer), or finish the ghost first (dry_paint).`);
      }
    }
    if (brush.fluorescence.amount > 0 && brush.engine === 'sticker') {
      throw new PaintEditorError(`The ${brush.name} brush sprays stickers, which don't take fluorescence; paint UV ink with a dab or particle brush (uv-marker; list_brush_presets lists them), or set fluorescence.amount to 0 (set_brush).`);
    }
    if (brush.thermochromic.hotColor !== null && brush.engine === 'sticker') {
      throw new PaintEditorError(`The ${brush.name} brush sprays stickers, which don't take thermochromic ink; paint thermochromic ink with a dab or particle brush (thermo-ink; list_brush_presets lists them), or set thermochromic.hotColor to null (set_brush).`);
    }
    if (doc.liveStrokes?.[layer.id]) {
      const why = liveStrokeRefusal(brush);
      if (why) throw new PaintEditorError(`Layer "${layer.name}" is a stroke layer. ${why}`);
    }
    if (doc.liveStrokes?.[layer.id] && effect?.source.live) {
      // Each live source needs a renderer every frame.
      const key = effectPaintKey(effect.source);
      const { sources } = this.liveEffects(doc);
      if (!sources.some((p) => effectPaintKey(p) === key) && sources.length >= MAX_LIVE_EFFECT_SOURCES) {
        throw new PaintEditorError(`The painting already plays ${MAX_LIVE_EFFECT_SOURCES} live effects, the most it can; paint with one of them, or set_effect_paint with live false to bake this one.`);
      }
    }
    const stickerLayer = Boolean(doc.stickers?.[layer.id]?.length);
    if (brush.engine === 'sticker') {
      if (!stickerLayer && contentBounds(layer.surface)) throw new PaintEditorError(`Layer "${layer.name}" already has paint; spray stickers onto an empty layer (add_layer) so they stay editable.`);
    } else if (stickerLayer) {
      throw new PaintEditorError(`Layer "${layer.name}" is a sticker layer (its pixels are drawn from its stickers); paint on another layer (add_layer).`);
    }
    let wet: { driver: WetStrokeDriver; surface: () => TiledSurface } | undefined;
    if (isWetBrush(brush)) {
      this.requireWetIdle('painting');
      if (layer.offset.x || layer.offset.y) {
        // The wet simulation works in canvas space: move the pixels into it (same picture, not an undo step).
        const ox = layer.offset.x;
        const oy = layer.offset.y;
        const moved: PaintPixelLayer = { ...layer, surface: translateSurface(layer.surface, ox, oy), offset: { x: 0, y: 0 } };
        const moveThick = (t: PaintDocumentState['thick']) => {
          const tc = t?.[layer.id];
          if (!tc) return t;
          return { ...t, [layer.id]: { height: translateSurface(tc.height, ox, oy), material: translateSurface(tc.material, ox, oy), film: translateSurface(tc.film, ox, oy) } };
        };
        this.doc = { ...this.doc, layers: mapLayer(this.doc.layers, layer.id, () => moved), ...(this.doc.thick?.[layer.id] ? { thick: moveThick(this.doc.thick) } : {}) };
        if (doc !== this.doc) doc = { ...doc, layers: mapLayer(doc.layers, layer.id, () => moved), ...(doc.thick?.[layer.id] ? { thick: moveThick(doc.thick) } : {}) };
        layer = moved;
      }
      if (!this.wet.wetLayerIds().includes(layer.id) && this.wet.wetLayerIds().length >= MAX_WET_LANES) {
        throw new PaintEditorError(`At most ${MAX_WET_LANES} layers can hold wet paint at once; dry one first (dry_paint).`);
      }
      this.beginWetOp();
      const world = this.wet.ensureLane(layer.id, brush.wet.medium);
      const id = layer.id;
      const wetColor = init.color === undefined ? (this.ownColour(init.brushId) ?? this.color) : parseColor(init.color);
      const [r, g, b] = hexToRgb8(wetColor);
      const wetGradient = this.strokeGradient(init, brush, wetColor);
      const load = init.load ?? brushLoadForStroke(brush, this.mixerLoad, [r / 255, g / 255, b / 255]);
      const seedW = init.seed ?? mix32((this.seedCounter * 0x9e3779b1) >>> 0) & 0x7fffffff;
      const copiesW = (init.copies ?? this.strokeCopies()).filter((m) => m.some((v, i) => v !== IDENTITY_AFFINE[i]));
      const wetMask = init.maskStencils ? this.stencilSelection(init.maskStencils) : init.stencils !== false ? this.stencilSelection() : null;
      const needWetFilm = Boolean((brush.wet.tool === 'paint' && brush.iridescence) || (brush.wet.tool === 'blot' && doc.thick?.[id]?.film.tiles.size));
      const wetFilm = needWetFilm ? new FilmBuffer((doc.thick?.[id] ?? emptyThickChannels()).film, layer.offset, wetMask) : null;
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
        mask: wetMask,
        paint: effect ? null : wetGradient,
        effect: effect?.pixels ?? null,
        film: wetFilm,
        speed: this.wet.speed,
      });
      init = { ...init, seed: seedW, load };
      wet = { driver, surface: () => world.display(id).surface };
    } else if (this.wet.wetLayerIds().includes(layer.id)) {
      // A dry brush on wet paint: the paint dries first (in the same undo step).
      this.dryLayersFirst([layer.id]);
      const dried = findLayer(this.doc.layers, layer.id)!.layer as PaintPixelLayer;
      layer = dried;
    }
    if (brush.mutation && !isWetBrush(brush) && !this.answeringMutation && !this.previewing && !this.getOrigin().startsWith('agent:')) {
      const targetLayer = layer;
      const existing = this.mutations.find((m) => m.state === 'settling' && m.medium === 'dry' && m.layerId === targetLayer.id && m.tempLayerId && findLayer(doc.layers, m.tempLayerId));
      if (existing?.tempLayerId) {
        layer = findLayer(doc.layers, existing.tempLayerId)!.layer as PaintPixelLayer;
      } else {
        const temp: PaintPixelLayer = {
          ...createPaintLayer('Mutation'),
          clipped: targetLayer.clipped,
          temporary: true,
        };
        this.tempLayerTargets.set(temp.id, targetLayer.id);
        this.doc = { ...this.doc, layers: insertAfter(this.doc.layers, targetLayer.id, temp) };
        if (doc !== this.doc) doc = { ...doc, layers: insertAfter(doc.layers, targetLayer.id, temp) };
        layer = temp;
      }
    }
    // A brush with its own colour paints it (resolved for the scheme now, and recorded with the stroke).
    let color = init.color === undefined ? (this.ownColour(init.brushId) ?? this.color) : parseColor(init.color);
    const tracing = this.guides.tracing;
    if (init.color === undefined && init.start && tracing?.visible && tracing.sampleColors) color = this.sampleTracingColor(init.start.x, init.start.y) ?? color;
    const perspective = this.guides.perspective;
    const snapper = init.snapToPerspective && perspective.enabled && perspective.snap ? new PerspectiveSnapper(perspective) : null;
    const useStencils = init.stencils !== false;
    const stencilSnapper = useStencils && this.guides.stencils.some((x) => x.enabled && x.mode === 'guide') ? new StencilSnapper(this.guides.stencils) : null;
    // Stickers are objects drawn whole (their layer is redrawn from the list unclipped), so a mask would only clip them until the next edit.
    if (brush.engine === 'sticker' && !init.maskStencils && useStencils && this.stencilSelection()) {
      const masks = this.guides.stencils.filter((x) => x.enabled && x.mode === 'mask').map((x) => x.id);
      throw new PaintEditorError(`Stickers can't be clipped by mask stencils (${masks.join(', ')}): they are objects drawn whole. Hide them (update_stencil enabled false) to spray stickers, or erase stickers you don't want (remove_stickers).`);
    }
    const selection = brush.engine === 'sticker' ? null : init.maskStencils ? this.stencilSelection(init.maskStencils) : useStencils ? this.stencilSelection() : null;
    const inputFilter = snapper || stencilSnapper ? (p: PenPoint) => (stencilSnapper ? stencilSnapper.snap(snapper ? snapper.snap(p) : p) : snapper!.snap(p)) : undefined;
    const rgba = rgbaOf(color);
    const seed = init.seed ?? mix32((this.seedCounter++ * 0x9e3779b1) >>> 0) & 0x7fffffff;
    const copies = (init.copies ?? this.strokeCopies()).filter((m) => m.some((v, i) => v !== IDENTITY_AFFINE[i]));
    const hasThick = Boolean(doc.thick?.[layer.id]);
    const needThick = brush.engine === 'impasto' || Boolean(brush.iridescence) || (brush.engine === 'eraser' && hasThick) || Boolean(wet?.driver.init.film);
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
      inputFilter,
      selection,
      mixerLoad: init.load ?? brushLoadForStroke(brush, this.mixerLoad, [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255]),
      secondary: rgbaOf(this.secondaryColor),
      wet,
      thick: needThick ? { channels: doc.thick?.[layer.id] ?? emptyThickChannels() } : undefined,
      // Light paint: a twin of the stroke paints the light channel (laying, dimming, moving light).
      light: !wet && brush.engine !== 'sticker' && (brush.light.amount > 0 || doc.light?.[layer.id]) ? { surface: doc.light?.[layer.id] ?? emptyLight() } : null,
      fluor: brush.engine !== 'sticker' && (brush.fluorescence.amount > 0 || doc.fluor?.[layer.id]) ? { surface: doc.fluor?.[layer.id] ?? emptyFluor() } : null,
      thermo: brush.engine !== 'sticker' && (brush.thermochromic.hotColor !== null || doc.thermo?.[layer.id]) ? { surface: doc.thermo?.[layer.id] ?? emptyThermo() } : null,
      sticker: brush.engine === 'sticker' ? { nextId: this.nextStickerNumber(doc), art: this.stickerArt.get, variant: (ref) => this.stickerArt.variantFor(ref, this.colorScheme === 'dark') } : undefined,
      stampArt: this.stampArt,
      paint: effect ? null : this.strokeGradient(init, brush, color),
      effect,
    });
    if (wet) this.wet.driver = wet.driver;
    if (init.maskStencils) session.maskStencils = init.maskStencils;
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
    if (init.effect) stroke.paint = JSON.parse(JSON.stringify(init.effect.source));
    else if (init.paint) stroke.paint = JSON.parse(JSON.stringify(init.paint));
    if (init.mixerLoad.reservoir || init.mixerLoad.pickup) stroke.load = JSON.parse(JSON.stringify(init.mixerLoad));
    if (init.wet) stroke.steps = [...init.wet.driver.steps];
    if (init.selection) {
      const masks = (session.maskStencils ?? this.guides.stencils).filter((x) => x.enabled && x.mode === 'mask');
      if (masks.length) stroke.stencils = masks.map((x) => ({ ...x }));
    }
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
        if ( this.session?.init.wet) {
          const ch = this.session.thickChannels();
          this.liveThick = ch ? { layerId, channels: ch } : null;
          // The wet layer's display is the layer's pixels: show it (not an undo step).
          this.wet.syncDisplays();
          return;
        }
        this.live = { layerId, surface };
        const ch = this.session?.thickChannels();
        this.liveThick = ch ? { layerId, channels: ch } : null;
        const fl = this.session?.fluorChannel();
        this.liveFluor = fl ? { layerId, surface: fl } : null;
        const th = this.session?.thermoChannel();
        this.liveThermo = th ? { layerId, surface: th } : null;
        this.emit(rects);
      },
      sampled: (s, points) => {
        this.notifySample('points', s, points);
        this.previewPathStroke(s);
      },
      commit: (s, surface, cancelled) => {
        this.session = null;
        const preview = this.pathPreview?.session === s ? this.pathPreview : null;
        this.pathPreview = null;
        // Before the check for changed pixels: what the preview laid may be nothing at all.
        const pathPaint = cancelled ? null : this.pathStrokePaint(s);
        if (pathPaint) {
          this.finishPathStroke(s, pathPaint, preview);
          return;
        }
        this.live = null;
        this.liveLayers = null;
        this.liveThick = null;
        this.liveFluor = null;
        this.liveThermo = null;
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
          } else if (this.doc.layers !== before.layers) {
            this.doc = { ...this.doc, layers: before.layers };
          }
          this.emit();
          this.notifySample(cancelled ? 'cancel' : 'end', s, [], cancelled ? undefined : null);
          return;
        }
        const stroke = this.record(s);
        s.result!.strokeId = stroke.id;
        this.paintedBounds.set(stroke, s.result?.bounds ?? null);
        if (wetStroke && this.wet.instantDry) {
          this.wet.dry(s.layerId);
          this.logWet({ kind: 'dry', layerId: s.layerId, at: this.doc.strokes.length + 1 });
          surface = (this.getLayer(s.layerId) as PaintPixelLayer).surface;
          s.result!.wet = this.wet.isWet(s.layerId);
        }
        const l = this.getLayer(s.layerId) as PaintPixelLayer;
        let ch = s.thickChannels();
        if (wetStroke) {
          const f = this.wet.patterns.get(l.id);
          if (f?.enabled) {
            this.wet.settingsOf(l.id).livePatterns = { ...f.settings };
            if (f.settings.relief > 0 && f.tiles.size > 0) {
              const prevCh = ch ?? this.doc.thick?.[l.id] ?? emptyThickChannels();
              const nextHeight = f.applyReliefHeight(prevCh.height);
              if (nextHeight !== prevCh.height) ch = { ...prevCh, height: nextHeight };
            }
          }
        }
        const thick = withLayerThick(this.doc.thick, l.id, ch);
        const sprayed = s.stickers();
        const stickers = sprayed ? { ...(this.doc.stickers ?? {}), [l.id]: [...(this.doc.stickers?.[l.id] ?? []), ...sprayed] } : this.doc.stickers;
        // Wet light is shaded from the simulation (it keeps flowing after the stroke, as the paint does).
        const wetLight = wetStroke && this.wet.world?.hasLane(l.id) ? this.wet.world.lightDisplay(l.id) : null;
        const light = withLayerLight(this.doc.light, l.id, s.lightChannel() ?? wetLight);
        const fluor = withLayerLight(this.doc.fluor, l.id, s.fluorChannel());
        const thermo = withLayerLight(this.doc.thermo, l.id, s.thermoChannel());
        this.commit(
          `${brush.name} stroke`,
          this.withWetEvents(
            withLiveStroke(
              {
                ...this.doc,
                layers: mapLayer(this.doc.layers, l.id, () => ({ ...l, surface })),
                strokes: [...this.doc.strokes, stroke],
                ...(thick ? { thick } : {}),
                ...(stickers ? { stickers } : {}),
                ...(light ? { light } : {}),
                ...(fluor ? { fluor } : {}),
                ...(thermo ? { thermo } : {}),
              },
              stroke,
            ),
          ),
          before,
        );
        this.recordMutationStroke(stroke, s.result?.bounds ?? null);
        // After the commit, so a listener that paints in reply finds the editor idle.
        this.notifySample('end', s, [], stroke.id);
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
    if (session.init.effect?.source.map?.by === 'path' && !session.init.wet) this.pathPreview = { session, key: '', pending: null, landed: null };
    this.emit([]);
    this.notifySample('begin', session);
    return session;
  }

  /**
   * Renders a hand-painted path stroke's effect along the path drawn so far and paints the stroke
   * again with it when it lands, so the effect follows the pen while it draws. One render at a
   * time: when one lands, the next takes the newest path. A failed render leaves the preview as it
   * was; the render on release reports it.
   */
  private previewPathStroke(s: PaintStrokeSession): void {
    const pv = this.pathPreview;
    if (!pv || pv.session !== s || pv.pending || !s.open) return;
    const paint = this.pathStrokePaint(s);
    if (!paint) return;
    const key = effectPaintKey(paint);
    if (key === pv.key) return;
    pv.key = key;
    const cached = this.effectPaintImage(paint);
    const pending = cached ? Promise.resolve(cached) : this.renderEffectPaintPixels(paint);
    pv.pending = pending;
    pending.then(
      (pixels) => {
        pv.pending = null;
        pv.landed = { key, pixels };
        if (this.pathPreview !== pv || !s.open) return;
        s.repaintEffect(pixels);
        this.previewPathStroke(s);
      },
      () => {
        pv.pending = null;
      },
    );
  }

  /** The current live stroke, if any. */
  get activeStroke(): PaintStrokeSession | null {
    return this.session;
  }

  /**
   * While a hand-painted stroke waits for its path render (`map: { by: 'path' }`), settles when it
   * has landed and rejects if it could not (the stroke is dropped); `null` otherwise. Until then
   * the editor is busy, as during a stroke, and shows the stroke as it was painted.
   */
  get strokeRendering(): Promise<void> | null {
    return this.pathStroke?.done ?? null;
  }

  /** The paint a finished hand-painted stroke must be painted again with, or `null` when it already painted with it. */
  private pathStrokePaint(s: PaintStrokeSession): PaintEffectPaint | null {
    const source = s.init.effect?.source;
    if (source?.map?.by !== 'path' || !s.points.length) return null;
    const paint = withStrokePath(source, s.points, this.effectPathControls.get(source.effect));
    return effectPaintKey(paint) === effectPaintKey(source) ? null : paint;
  }

  /**
   * Ends a hand-painted stroke with a path-mapped effect. Its whole path isn't known until now, so
   * the live stroke was only a preview from renders along the path so far (`previewPathStroke`):
   * nothing of it was committed. Paints it again with the path's own render, as one stroke and one undo step, at
   * once if that can render synchronously and when the render lands if not.
   */
  private finishPathStroke(s: PaintStrokeSession, paint: PaintEffectPaint, preview: PaintEditorController['pathPreview']): void {
    const finish = () => {
      this.pathStroke = null;
      this.live = null;
      this.liveLayers = null;
      this.liveThick = null;
      this.liveFluor = null;
      this.liveThermo = null;
      const masks = s.init.selection ? (s.maskStencils ?? this.guides.stencils).filter((x) => x.enabled && x.mode === 'mask') : [];
      const load = s.init.mixerLoad;
      const result = this.paintStroke({ layerId: s.layerId, points: s.points, color: s.init.colorHex, brush: brushToJSON(s.init.brush) as PaintBrush, seed: s.init.seed, copies: s.init.affineCopies as Affine[], ...(load.reservoir || load.pickup ? { load } : {}), paint, snapToPerspective: false, stencils: false, maskStencils: masks });
      Object.assign(s.result!, result);
      // After the commit, so a listener that paints in reply finds the editor idle.
      this.notifySample('end', s, [], result.strokeId);
    };
    const key = effectPaintKey(paint);
    // The preview's render of the whole path, when it got there.
    if (preview?.landed?.key === key) this.cacheEffectPaintImage(paint, preview.landed.pixels);
    if (this.effectPaintImage(paint) || this.renderEffectPaintSync(paint)) {
      finish();
      return;
    }
    const render = preview?.pending && preview.key === key ? preview.pending.then((img) => this.cacheEffectPaintImage(paint, img)) : this.renderEffectPaint(paint);
    const done = render.then(finish, (e) => {
      this.pathStroke = null;
      this.live = null;
      this.liveLayers = null;
      this.liveThick = null;
      this.liveFluor = null;
      this.liveThermo = null;
      this.emit();
      this.notifySample('cancel', s, []);
      throw e;
    });
    // Whoever watches `strokeRendering` hears the failure; nobody has to.
    done.catch(() => {});
    this.pathStroke = { effect: paint.effect, done };
    this.emit([]);
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
        this.paintedBounds.set(stroke, s.result?.bounds ?? null);
        const targetId = this.tempLayerTargets.get(s.layerId);
        if (targetId && !findLayer(out.layers, s.layerId)) {
          const temp = findLayer(this.doc.layers, s.layerId)?.layer;
          if (temp) out = { ...out, layers: insertAfter(out.layers, targetId, temp) };
        }
        const l = findLayer(out.layers, s.layerId)!.layer as PaintPixelLayer;
        const offset = s.init.wet ? { x: 0, y: 0 } : l.offset;
        let ch = s.thickChannels();
        if (s.init.wet) {
          const f = this.wet.patterns.get(l.id);
          if (f?.enabled) {
            this.wet.settingsOf(l.id).livePatterns = { ...f.settings };
            if (f.settings.relief > 0 && f.tiles.size > 0) {
              const prevCh = ch ?? out.thick?.[l.id] ?? emptyThickChannels();
              const nextHeight = f.applyReliefHeight(prevCh.height);
              if (nextHeight !== prevCh.height) ch = { ...prevCh, height: nextHeight };
            }
          }
        }
        const thick = withLayerThick(out.thick, l.id, ch);
        const sprayed = s.stickers();
        const lit = s.lightChannel() ?? (s.init.wet && this.wet.world?.hasLane(l.id) ? this.wet.world.lightDisplay(l.id) : null);
        const fl = s.fluorChannel();
        const th = s.thermoChannel();
        out = withLiveStroke({
          ...out,
          layers: mapLayer(out.layers, l.id, () => ({ ...l, surface, offset })),
          strokes: [...out.strokes, stroke],
          ...(thick ? { thick } : {}),
          ...(sprayed ? { stickers: { ...(out.stickers ?? {}), [l.id]: [...(out.stickers?.[l.id] ?? []), ...sprayed] } } : {}),
          ...(lit ? { light: withLayerLight(out.light, l.id, lit) } : {}),
          ...(fl ? { fluor: withLayerLight(out.fluor, l.id, fl) } : {}),
          ...(th ? { thermo: withLayerLight(out.thermo, l.id, th) } : {}),
        }, stroke);
      },
    };
    const session = this.sessionFor(doc, init, host, points);
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
    if (doc !== before || this.wetOp) {
      this.commit(`${brush.name} stroke`, this.withWetEvents(doc), before);
      const lastStroke = this.doc.strokes[this.doc.strokes.length - 1];
      if (lastStroke && lastStroke.id === result.strokeId) this.recordMutationStroke(lastStroke, result.bounds);
    } else this.emit([]);
    return result;
  }

  /**
   * Brushes vector path data (SVG `d`, document pixels) with the active brush, or `brushId` /
   * `brush`, as if drawn by hand: one recorded stroke per subpath, sampled every `spacing` px
   * with an optional `pressure` profile along each. All of it is one undo step. A given `seed`
   * seeds the first subpath; the next ones take the following seeds.
   */
  strokePath(init: Omit<PaintStrokeInit, 'start' | 'copies' | 'load'> & PathSampleOptions & { path: string }): { layerId: string; bounds: RasterRect | null; dabs: number; strokeIds: string[]; mixerLoad?: MixerLoad; wet?: boolean } {
    this.requireIdle('painting');
    if (typeof init.path !== 'string' || !init.path.trim()) throw new PaintEditorError('path is empty; give SVG path data in document pixels, e.g. "M 10 10 C 40 0 80 60 120 30".');
    let subpaths: PenPoint[][];
    try {
      subpaths = samplePath(init.path, init);
    } catch (e) {
      throw new PaintEditorError(e instanceof Error ? e.message : String(e));
    }
    const { path: _path, spacing: _spacing, pressure: _pressure, speed: _speed, ...stroke } = init;
    const before = this.doc;
    let doc = this.doc;
    let bounds: RasterRect | null = null;
    let dabs = 0;
    const strokeIds: string[] = [];
    let last: ReturnType<PaintEditorController['runStroke']> | null = null;
    try {
      subpaths.forEach((points, i) => {
        last = this.runStroke(doc, { ...stroke, ...(stroke.seed !== undefined ? { seed: stroke.seed + i } : {}), start: points[0] }, points);
        doc = last.doc;
        bounds = unionRect(bounds, last.result.bounds);
        dabs += last.result.dabs;
        if (last.result.strokeId) strokeIds.push(last.result.strokeId);
      });
    } catch (e) {
      this.wetOp = null;
      throw e;
    }
    const run = last as ReturnType<PaintEditorController['runStroke']> | null;
    if (run?.result.mixerLoad) this.keepLoad(run.brush, run.result.mixerLoad);
    if (doc !== before || this.wetOp) {
      this.commit(`${run?.brush.name ?? 'Brush'} path stroke`, this.withWetEvents(doc), before);
      for (const sid of strokeIds) {
        const recorded = this.doc.strokes.find((s) => s.id === sid);
        if (recorded) this.recordMutationStroke(recorded, this.paintedBounds.get(recorded) ?? null);
      }
    } else this.emit([]);
    const layerId = run?.result.layerId ?? stroke.layerId ?? this.doc.activeLayerId ?? '';
    return { layerId, bounds, dabs, strokeIds, ...(run?.result.mixerLoad ? { mixerLoad: run.result.mixerLoad } : {}), ...(run?.result.wet !== undefined ? { wet: run.result.wet } : {}) };
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
    if (options.color === undefined) {
      for (const s of strokes) {
        if (s.paint?.type === 'effect' && !this.effectPaintImage(s.paint)) {
          throw new PaintEditorError(`Stroke "${s.id}" paints with the effect "${s.paint.effect}"${s.paint.provider ? ` from provider "${s.paint.provider}"` : ''}, which is not rendered in this editor; render it first (prepareStrokeEffects; the replay_strokes tool does this) or recolour the replay with color.`);
        }
      }
    }
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
        // Gradient paint replays as recorded; a recolour paints the one new colour.
        const paint = v.paint && options.color === undefined ? { paint: v.paint } : {};
        const run = this.runStroke(doc, { layerId, color: options.color ?? s.color, brush, seed: s.seed, copies: v.copies ?? [], stencils: false, maskStencils: [], ...paint, ...(load && options.brushId === undefined ? { load } : {}) }, v.points);
        doc = run.doc;
        bounds = unionRect(bounds, run.result.bounds);
        if (run.result.strokeId) ids.push(run.result.strokeId);
        layerIds.add(layerId);
      }
    }
    if (doc !== this.doc) this.commit(strokes.length === 1 && repeat === 1 ? 'Replay stroke' : 'Replay strokes', doc);
    this.effectPaintBatch = 0;
    this.trimEffectPaints();
    return { strokeIds: ids, bounds, layerIds: [...layerIds] };
  }

  // --- Light paint --------------------------------------------------------------------

  /** The document's `light` without these layers (as a spread: `{}` when unchanged). */
  private lightWithout(ids: readonly string[]): { light?: Record<string, TiledSurface> } {
    const t = this.doc.light;
    if (!t || !ids.some((id) => t[id])) return {};
    const out = { ...t };
    for (const id of ids) delete out[id];
    return { light: out };
  }

  private lightSpillOf(layerId: string): LightSpill {
    return this.lightSpills[layerId] ?? DEFAULT_LIGHT_SPILL;
  }

  /** A layer's light paint: whether it has any, where (document pixels), its brightest value 0..255, and its spill. */
  lightOf(layerId?: string): { layerId: string; hasLight: boolean; bounds: RasterRect | null; peak: number; spill: LightSpill } {
    const l = this.wetLayer(layerId, 'read the light of');
    const info = lightInfo(this.doc.light?.[l.id]);
    const bounds = info.bounds ? { ...info.bounds, x: info.bounds.x + l.offset.x, y: info.bounds.y + l.offset.y } : null;
    return { layerId: l.id, hasLight: info.peak > 0, bounds, peak: info.peak, spill: { ...this.lightSpillOf(l.id) } };
  }

  /** How far a layer's light spills (px; 0 turns it off) and how strongly (0..2). Saved with the document, not an undo step; nothing is repainted. */
  setLightSpill(layerId: string | undefined, update: Partial<LightSpill>): LightSpill {
    const l = this.wetLayer(layerId, 'set the light spill of');
    try {
      this.lightSpills[l.id] = normalizeLightSpill(update, this.lightSpillOf(l.id));
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    this.emit('all');
    return { ...this.lightSpills[l.id] };
  }

  /** Takes a layer's light away; its paint keeps its colour. One undo step. Returns whether there was any. */
  clearLight(layerId?: string): { layerId: string; cleared: boolean } {
    this.requireIdle('clearing light');
    const l = this.paintTarget(layerId, 'clear the light of');
    // Wet light lives in the simulation: the paint dries first (in the same undo step).
    if (this.wet.bakedLight(l.id)) this.dryLayersFirst([l.id]);
    const t = this.lightWithout([l.id]);
    if (!t.light) return { layerId: l.id, cleared: false };
    this.commit('Clear light', { ...this.doc, light: t.light });
    return { layerId: l.id, cleared: true };
  }

  // --- UV blacklight and thermochromic heat ---------------------------------------

  private fluorWithout(ids: readonly string[]): { fluor?: Record<string, TiledSurface> } {
    const t = this.doc.fluor;
    if (!t || !ids.some((id) => t[id])) return {};
    const out = { ...t };
    for (const id of ids) delete out[id];
    return { fluor: out };
  }

  private thermoWithout(ids: readonly string[]): { thermo?: Record<string, TiledSurface> } {
    const t = this.doc.thermo;
    if (!t || !ids.some((id) => t[id])) return {};
    const out = { ...t };
    for (const id of ids) delete out[id];
    return { thermo: out };
  }

  /** The UV / blacklight view setting. */
  getUvLight(): UvLightSettings {
    return { ...this.uvLight };
  }

  /** Layers that carry UV-fluorescent ink. */
  fluorescentLayerIds(): string[] {
    return Object.entries(this.doc.fluor ?? {})
      .filter(([id, s]) => s.tiles.size > 0 && Boolean(findLayer(this.doc.layers, id)))
      .map(([id]) => id);
  }

  /** Layers that carry thermochromic ink. */
  thermochromicLayerIds(): string[] {
    return Object.entries(this.doc.thermo ?? {})
      .filter(([id, s]) => s.tiles.size > 0 && Boolean(findLayer(this.doc.layers, id)))
      .map(([id]) => id);
  }

  /**
   * Switches or tunes the virtual UV / blacklight (`on`, `strength` 0..2, `ambient` 0..1). When
   * `on` is true, the composite dims to `ambient` and fluorescent ink (`brush.fluorescence`) glows
   * in its stroke colour with a Linear Dodge halo. Saved with the document, not an undo step.
   */
  setUvLight(update: Partial<UvLightSettings>): UvLightSettings {
    if (update.on !== undefined && typeof update.on !== 'boolean') throw new PaintEditorError('on must be true or false.');
    if (update.strength !== undefined && !(typeof update.strength === 'number' && Number.isFinite(update.strength) && update.strength >= 0 && update.strength <= 2)) {
      throw new PaintEditorError(`strength ${update.strength} is out of range; use 0..2.`);
    }
    if (update.ambient !== undefined && !(typeof update.ambient === 'number' && Number.isFinite(update.ambient) && update.ambient >= 0 && update.ambient <= 1)) {
      throw new PaintEditorError(`ambient ${update.ambient} is out of range; use 0..1.`);
    }
    this.uvLight = normalizeUvLight(update, this.uvLight);
    this.emit('all');
    return { ...this.uvLight };
  }

  /**
   * Reads the document's heat field: its temperature summary (`peak`, `mean`, `hotCells`) and,
   * when `points` are given (document pixels), the bilinearly sampled temperature (0..1) at each.
   */
  getHeat(points: readonly { x: number; y: number }[] = []): HeatStats & { samples: HeatSample[]; thermochromicLayerIds: string[] } {
    const samples: HeatSample[] = points.map((p, i) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new PaintEditorError(`points[${i}] needs finite x and y in document pixels.`);
      return { x: p.x, y: p.y, temperature: this.doc.heat ? Math.round(sampleHeatAt(this.doc.heat, p.x, p.y) * 1000) / 1000 : 0 };
    });
    return { ...heatStats(this.doc.heat), samples, thermochromicLayerIds: this.thermochromicLayerIds() };
  }

  /**
   * Warms (or with `temperature` 0 cools) the canvas heat field along `points` (document pixels)
   * with a soft brush of `radius` px (default 28) towards `temperature` 0..1 (default 1). Where
   * temperature reaches `HEAT_DRY_THRESHOLD` (0.5), any wet paint on those tiles dries at once.
   * One undo step.
   */
  paintHeat(options: { points: readonly { x: number; y: number }[]; radius?: number; temperature?: number }): HeatStats & { bounds: RasterRect | null; dried: Array<{ layerId: string; bounds: RasterRect | null }> } {
    this.requireIdle('painting heat');
    this.requireWetIdle('painting heat');
    const points = this.checkPoints(options.points);
    const radius = options.radius ?? 28;
    if (!(typeof radius === 'number' && Number.isFinite(radius) && radius >= 1 && radius <= 512)) {
      throw new PaintEditorError(`radius ${options.radius} is out of range; use 1..512 px.`);
    }
    const temperature = options.temperature ?? 1;
    if (!(typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 1)) {
      throw new PaintEditorError(`temperature ${options.temperature} is out of range; use 0..1 (0 cools back to ambient).`);
    }
    const before = this.doc;
    const { width, height } = this.doc.canvas;
    const field = this.doc.heat ? cloneHeatField(this.doc.heat) : createHeatField(width, height);
    const { stats } = paintHeatField(field, points, radius, temperature);
    const dried = this.dryWetFromHeat(field);
    const next: PaintDocumentState = { ...this.doc, ...(stats.max > 0 ? { heat: field } : {}) };
    if (stats.max === 0) delete next.heat;
    if (next !== before || this.wetOp) this.commit('Paint heat', this.withWetEvents(next), before);
    else this.emit([]);
    return { ...stats, dried };
  }

  /**
   * Advances the heat field by `steps` simulation steps (1..200, default 10): heat diffuses into
   * neighbouring cells and cools towards 0 by Newtonian cooling. Newly heated tiles above the dry
   * threshold dry any wet paint on them. Not an undo step (time passing never is).
   */
  advanceHeat(stepsOrOptions: number | { steps?: number } = 10): HeatStats & { steps: number; dried: Array<{ layerId: string; bounds: RasterRect | null }> } {
    this.requireIdle('advancing heat');
    this.requireWetIdle('advancing heat');
    const rawSteps = typeof stepsOrOptions === 'number' ? stepsOrOptions : stepsOrOptions?.steps;
    const steps = rawSteps ?? 10;
    if (!(Number.isInteger(steps) && steps >= 1 && steps <= 200)) {
      throw new PaintEditorError(`steps ${rawSteps} is out of range; use a whole number 1..200.`);
    }
    if (!this.doc.heat || heatStats(this.doc.heat).max === 0) {
      return { steps, max: 0, mean: 0, hotCells: 0, bounds: null, dried: [] };
    }
    const field = cloneHeatField(this.doc.heat);
    const stats = advanceHeatField(field, steps);
    const dried = this.dryWetFromHeat(field);
    const next: PaintDocumentState = { ...this.doc, ...(stats.max > 0 ? { heat: field } : {}) };
    if (stats.max === 0) delete next.heat;
    this.doc = this.withWetEvents(next);
    this.docRevision++;
    this.emit('all');
    return { steps, ...stats, dried };
  }

  /** Cools the whole canvas heat field to 0 at once (one undo step when anything was warm). */
  clearHeat(): { cleared: boolean } {
    this.requireIdle('clearing heat');
    if (!this.doc.heat || heatStats(this.doc.heat).max === 0) {
      return { cleared: false };
    }
    const { heat: _gone, ...rest } = this.doc;
    this.commit('Clear heat', rest);
    return { cleared: true };
  }

  /** Dries any wet paint on tiles where `field` is at or above `HEAT_DRY_THRESHOLD`. */
  private dryWetFromHeat(field: HeatField): Array<{ layerId: string; bounds: RasterRect | null }> {
    const ids = this.wet.wetLayerIds();
    if (!ids.length) return [];
    const hotRect = hotCellsBounds(field, HEAT_DRY_THRESHOLD);
    if (!hotRect) return [];
    this.beginWetOp();
    const dried = ids.flatMap((id) => this.wet.dry(id, hotRect)).filter((d) => d.bounds !== null);
    if (dried.length) this.logWet({ kind: 'dry', data: hotRect });
    return dried;
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

  /** Where the viewer looks from for thin-film iridescence and specular highlights (-1..1; editor state, not saved with the document). */
  getViewTilt(): PaintViewTilt {
    return { ...this.viewTilt };
  }

  /** Tilts the view vector for thin-film iridescence and specular highlights (-1..1; editor state, not saved with the document, not an undo step). */
  setViewTilt(update: Partial<PaintViewTilt>): PaintViewTilt {
    if (update.x !== undefined && !(Number.isFinite(update.x) && update.x >= -1 && update.x <= 1)) {
      throw new PaintEditorError(`x ${update.x} is out of range; use -1..1.`);
    }
    if (update.y !== undefined && !(Number.isFinite(update.y) && update.y >= -1 && update.y <= 1)) {
      throw new PaintEditorError(`y ${update.y} is out of range; use -1..1.`);
    }
    this.viewTilt = normalizeViewTilt(update, this.viewTilt);
    this.emit('all');
    return { ...this.viewTilt };
  }

  /** A layer's relief: where it is, its highest point (0..255) and its tiles; `null` when it has none. */
  reliefOf(layerId?: string): { layerId: string; bounds: RasterRect | null; maxHeight: number } | null {
    const id = layerId ?? this.doc.activeLayerId;
    if (!id) return null;
    this.requireLayer(id);
    const ch = this.doc.thick?.[id];
    if (!ch || !hasThickChannels(ch)) return null;
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
    const target = new PaintEditorController({ width: w, height: h, dpi: dpi * scale, brushLibrary: this.brushLibrary, wet: this.wetOptions });
    target.brushEntries = this.brushEntries;
    target.brushSources.set(this.brushSources.all());
    const paper = { ...this.doc.paper, scale: Math.min(8, this.doc.paper.scale * scale) };
    target.adopt({ state: { canvas: target.doc.canvas, paper, layers: emptiedLayers(this.doc.layers), activeLayerId: this.doc.activeLayerId, strokes: [] }, extensions: {}, problems: [] });
    target.lighting = { ...this.lighting };
    target.uvLight = { ...this.uvLight };
    // Effect paint: the target renders what it is missing with the same provider; at scale 1 it starts from these pixels.
    target.effects.set(this.effects.provider);
    if (w === width && h === height) for (const [key, img] of this.effectPaintPixels) target.effectPaintPixels.set(key, img);
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
    this.tickMutations(now);
    return this.wet.tick(now);
  }

  /** Resolves when the wet kernel is as fast as it will get here (`null` when nothing is wet yet). */
  wetReady(): Promise<WetBackendInfo | null> {
    return this.wet.world ? this.wet.world.ready : Promise.resolve(null);
  }

  /** Stops the wet simulation's worker threads (call when the editor goes away). */
  dispose(): void {
    this.unsubscribeLibrary();
    this.wet.destroy();
    this.effectsRenderer.dispose();
    this.effectPaintPixels.clear();
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
  wetState(): PaintWetStateInfo & { layers: WetLayerInfo[]; backend: WetBackendInfo | null; message: string | null; engine: WetEngineInfo } {
    const st = this.getState().wet;
    const backend = this.wet.backend();
    return { ...st, layers: this.wet.wetLayerIds().map((id) => this.wet.info(id)), backend, message: backend?.message ?? wetSupport().message, engine: this.wet.engineInfo() };
  }

  /**
   * Engine B, the WebGPU accelerator for large wet areas: whether it may run, its state (`off`,
   * `not-started`, `starting`, `unavailable`, `standby`, `active`, `failed`), why, and the GPU.
   * The CPU engine stays the authority: drying, saving, export and replay never use the GPU.
   */
  wetEngine(): WetEngineInfo {
    return this.wet.engineInfo();
  }

  /**
   * Lets Engine B run (`gpu: 'auto'`, the default) or forces the CPU (`'off'`); `minTiles` is the
   * wet area (live 256 px tiles) at which the GPU takes over. Not an undo step and not saved with
   * the painting (it changes how wet paint is computed on this machine, never the result).
   * Resolves once the GPU has started or turned out unavailable.
   */
  async setWetEngine(options: { gpu?: WetGpuMode; minTiles?: number }): Promise<WetEngineInfo> {
    const gpu = options.gpu ?? this.wet.gpuMode;
    if (!WET_GPU_MODES.includes(gpu)) throw new PaintEditorError(`gpu must be ${WET_GPU_MODES.join(' or ')}, not ${JSON.stringify(gpu)}.`);
    if (options.minTiles !== undefined && !(Number.isInteger(options.minTiles) && options.minTiles >= 1 && options.minTiles <= 1024)) throw new PaintEditorError(`minTiles ${options.minTiles} is out of range; use 1..1024 tiles of 256 px.`);
    this.wet.setGpu(gpu, options.minTiles);
    this.emit();
    const info = await this.wet.gpuReady();
    this.emit();
    return info;
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
    const seconds = options.seconds ?? steps / this.wet.speed;
    const run = await this.wet.advance(steps);
    if (seconds > 0) this.advanceMutations(seconds);
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
    const dried = ids.flatMap((id) => {
      const r = this.wet.dry(id, rect);
      if (!rect) this.finishWetMutationsOnDry(id);
      return r;
    });
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
    if (this.heldEvaporation.has(l.id)) {
      const current = this.wet.info(l.id).params;
      const intended = normalizeWetParams({ ...current, evaporation: this.heldEvaporation.get(l.id), ...update });
      this.heldEvaporation.set(l.id, intended.evaporation);
      this.wet.setParams(l.id, { ...update, evaporation: 0 });
      this.recordWetSetting({ kind: 'params', layerId: l.id, data: intended });
      this.emit([]);
      return intended;
    }
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

  private layerLivePatternsInfo(layerId: string): PaintLayerLivePatternsInfo {
    const info = this.wet.info(layerId);
    const stats = this.wet.livePatternStats(layerId);
    return {
      layerId,
      wet: info.wet,
      wetCells: info.wetCells,
      wetBounds: info.wetBounds,
      ...stats,
    };
  }

  private checkLivePatternsInput(input: LivePatternsInput | undefined): LivePatternsInput {
    if (!input) return {};
    const out: LivePatternsInput = {};
    if (input.pattern !== undefined) {
      if (!(LIVE_PATTERN_KINDS as readonly string[]).includes(input.pattern)) {
        throw new PaintEditorError(`pattern must be one of ${LIVE_PATTERN_KINDS.join(', ')}, not ${JSON.stringify(input.pattern)}.`);
      }
      out.pattern = input.pattern;
    }
    if (input.feed !== undefined) {
      if (!(Number.isFinite(input.feed) && input.feed >= 0.005 && input.feed <= 0.1)) {
        throw new PaintEditorError(`feed ${input.feed} is out of range; use 0.005..0.1.`);
      }
      out.feed = input.feed;
    }
    if (input.kill !== undefined) {
      if (!(Number.isFinite(input.kill) && input.kill >= 0.02 && input.kill <= 0.08)) {
        throw new PaintEditorError(`kill ${input.kill} is out of range; use 0.02..0.08.`);
      }
      out.kill = input.kill;
    }
    if (input.scale !== undefined) {
      if (!(Number.isFinite(input.scale) && input.scale >= 0.25 && input.scale <= 4)) {
        throw new PaintEditorError(`scale ${input.scale} is out of range; use 0.25..4.`);
      }
      out.scale = input.scale;
    }
    if (input.contrast !== undefined) {
      if (!(Number.isFinite(input.contrast) && input.contrast >= 0 && input.contrast <= 2)) {
        throw new PaintEditorError(`contrast ${input.contrast} is out of range; use 0..2.`);
      }
      out.contrast = input.contrast;
    }
    if (input.secondColor !== undefined) {
      out.secondColor = input.secondColor === null ? null : parseColor(input.secondColor, 'secondColor');
    }
    if (input.relief !== undefined) {
      if (!(Number.isFinite(input.relief) && input.relief >= 0 && input.relief <= 1)) {
        throw new PaintEditorError(`relief ${input.relief} is out of range; use 0..1.`);
      }
      out.relief = input.relief;
    }
    return out;
  }

  /**
   * Reads a layer's Gray-Scott reaction-diffusion live patterns (`layerId`, default the active
   * layer), plus all layers with wet paint or live patterns and the built-in Pearson presets.
   */
  getLivePatterns(layerId?: string): PaintLayerLivePatternsInfo & {
    layers: PaintLayerLivePatternsInfo[];
    presets: Readonly<Record<LivePatternKind, { feed: number; kill: number }>>;
    brushPresets: readonly string[];
  } {
    const l = this.wetLayer(layerId, 'read the live patterns of');
    const primary = this.layerLivePatternsInfo(l.id);
    const ids = new Set<string>([l.id, ...this.wet.wetLayerIds()]);
    for (const [id, f] of this.wet.patterns) {
      if ((f.enabled || f.tiles.size > 0) && findLayer(this.doc.layers, id)) ids.add(id);
    }
    for (const [id, s] of this.wet.settings) {
      if (s.livePatterns && findLayer(this.doc.layers, id)) ids.add(id);
    }
    const layers = [...ids].map((id) => (id === l.id ? primary : this.layerLivePatternsInfo(id)));
    return {
      ...primary,
      layers,
      presets: LIVE_PATTERN_PRESETS,
      brushPresets: ['turing-wash', 'coral-ink'],
    };
  }

  /**
   * Configures a layer's Gray-Scott reaction-diffusion live patterns (or clears them with
   * `enabled: false`). One undo step.
   */
  setLivePatterns(
    layerId: string | undefined,
    update: LivePatternsInput & { enabled?: boolean }
  ): PaintLayerLivePatternsInfo {
    this.requireIdle('changing live patterns');
    this.requireWetIdle('changing live patterns');
    const l = this.wetLayer(layerId, 'set the live patterns of');
    if (isLayerLocked(l, 'pixels')) throw new PaintEditorError(`Layer "${l.name}" has its pixels locked; unlock it first.`);
    if (update.enabled !== undefined && typeof update.enabled !== 'boolean') {
      throw new PaintEditorError('enabled must be true or false.');
    }
    const checked = this.checkLivePatternsInput(update);
    const before = this.doc;
    this.beginWetOp();
    const next = this.wet.setLivePatterns(l.id, update.enabled === false ? null : checked);
    this.logWet({ kind: 'live-patterns', layerId: l.id, data: next });
    this.commit('Live patterns', this.withWetEvents(this.doc), before);
    return this.layerLivePatternsInfo(l.id);
  }

  /**
   * Seeds Gray-Scott reaction-diffusion activator (`V`) discs into a layer's live-pattern field so
   * patterns grow where the layer holds wet water and freeze where it dries. One undo step.
   */
  seedLivePatterns(options: {
    layerId?: string;
    points: ReadonlyArray<{ x: number; y: number; strength?: number }>;
    radius?: number;
    seed?: number;
    pattern?: LivePatternKind;
    feed?: number;
    kill?: number;
    scale?: number;
    contrast?: number;
    secondColor?: string | null;
    relief?: number;
  }): PaintLayerLivePatternsInfo & { seededCells: number } {
    this.requireIdle('seeding live patterns');
    this.requireWetIdle('seeding live patterns');
    const l = this.wetLayer(options.layerId, 'seed live patterns on');
    if (isLayerLocked(l, 'pixels')) throw new PaintEditorError(`Layer "${l.name}" has its pixels locked; unlock it first.`);
    if (!Array.isArray(options.points) || !options.points.length) {
      throw new PaintEditorError('points is empty; give at least one {x, y} in document pixels.');
    }
    const { width, height } = this.doc.canvas;
    const points = options.points.map((p, i) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        throw new PaintEditorError(`points[${i}] needs finite x and y in document pixels.`);
      }
      if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) {
        throw new PaintEditorError(`points[${i}] (${p.x}, ${p.y}) is outside the ${width}×${height} canvas.`);
      }
      if (p.strength !== undefined && !(Number.isFinite(p.strength) && p.strength > 0 && p.strength <= 1)) {
        throw new PaintEditorError(`points[${i}].strength ${p.strength} is out of range; use above 0 up to 1.`);
      }
      return { x: p.x, y: p.y, ...(p.strength !== undefined ? { strength: p.strength } : {}) };
    });
    const radius = options.radius ?? 16;
    if (!(Number.isFinite(radius) && radius >= 1 && radius <= 512)) {
      throw new PaintEditorError(`radius ${radius} is out of range; use 1..512 px.`);
    }
    const seed = options.seed ?? mix32((this.seedCounter++ * 0x9e3779b1) >>> 0) & 0x7fffffff;
    if (!Number.isInteger(seed) || seed < 0) {
      throw new PaintEditorError(`seed ${seed} must be a whole number of 0 or more.`);
    }
    const hasSettings =
      options.pattern !== undefined ||
      options.feed !== undefined ||
      options.kill !== undefined ||
      options.scale !== undefined ||
      options.contrast !== undefined ||
      options.secondColor !== undefined ||
      options.relief !== undefined;
    const settings = hasSettings ? this.checkLivePatternsInput(options) : undefined;
    const before = this.doc;
    this.beginWetOp();
    const { seededCells } = this.wet.seedLivePatterns(l.id, points, radius, seed, settings);
    this.logWet({
      kind: 'seed-live-patterns',
      layerId: l.id,
      data: { points, radius, seed, ...(settings ? { settings } : {}) },
    });
    this.commit('Seed live patterns', this.withWetEvents(this.doc), before);
    return { ...this.layerLivePatternsInfo(l.id), seededCells };
  }

  // --- Rendering -----------------------------------------------------------------

  private sources() {
    return { width: this.doc.canvas.width, height: this.doc.canvas.height };
  }

  /** The layers with the live stroke's surface in place. */
  private currentLayers(): PaintLayer[] {
    const override = this.frameOverride;
    if (override) return Array.from(override).reduce((ls, [id, surface]) => mapLayer(ls, id, (l) => ({ ...(l as PaintPixelLayer), surface })), this.doc.layers);
    const live = this.live;
    if (!live) return this.animatedView();
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

  /** The effect paper as a compositor layer (one object per effect paper, so caches hold). */
  private paperEffectNode(p: PaintPaperEffect): ImageNode {
    const c = this.paperEffectNodeCache;
    if (c && c.image === p.image && c.opacity === p.opacity && c.blend === p.blend) return c;
    const node: ImageNode = { type: 'image', id: PAPER_EFFECT_NODE_ID, name: 'Effect paper', visible: true, opacity: p.opacity, blend: p.blend, image: p.image, version: p.version };
    this.paperEffectNodeCache = node;
    return node;
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

  /** The layers with thermochromic paint shifted toward its hot colour where the canvas is warm. */
  private thermoLayers(layers: PaintLayer[]): PaintLayer[] {
    const thermo = this.doc.thermo;
    const heat = this.doc.heat;
    if (!thermo || !heat || heat.max === 0) return layers;
    let out = layers;
    for (const [id, th] of Object.entries(thermo)) {
      const l = findLayer(out, id)?.layer;
      if (!isPixelLayer(l) || !th.tiles.size) continue;
      let cache = this.thermoCaches.get(id);
      if (!cache) this.thermoCaches.set(id, (cache = new ThermoCache()));
      const shifted = cache.render(l.surface, th, l.offset, heat);
      if (shifted !== l.surface) out = mapLayer(out, id, () => ({ ...l, surface: shifted }));
    }
    return out;
  }

  /**
   * Under the UV blacklight: every pixel layer's daylight paint dims to `uvLight.ambient`, any
   * fluorescent ink (`doc.fluor[id]`) glows in its own colour, and each fluorescent layer casts a
   * Linear Dodge (`::uv`) spill layer directly above it.
   */
  private uvLayers(layers: PaintLayer[]): PaintLayer[] {
    if (!this.uvLight.on) return layers;
    const fluor = this.doc.fluor ?? {};
    const visit = (list: PaintLayer[]): PaintLayer[] => {
      let out: PaintLayer[] = [];
      for (const l of list) {
        if (l.type === 'group') {
          out.push({ ...l, children: visit(l.children) });
          continue;
        }
        if (!isPixelLayer(l)) {
          out.push(l);
          continue;
        }
        let cache = this.uvCaches.get(l.id);
        if (!cache) this.uvCaches.set(l.id, (cache = new UvCache()));
        const fl = fluor[l.id];
        const surface = cache.render(l.surface, fl, this.uvLight);
        out.push(surface !== l.surface ? { ...l, surface } : l);
        const spill = fl ? cache.spill(fl, this.uvLight) : null;
        if (spill) {
          out.push({ type: 'pixel', id: `${l.id}${UV_SPILL_SUFFIX}`, name: `${l.name} UV`, visible: l.visible, opacity: l.opacity, blend: 'linear-dodge', surface: spill, offset: { ...l.offset } } as PaintPixelLayer);
        }
      }
      return out;
    };
    return visit(layers);
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
      const lit = cache.lit(l.surface, ch, this.lighting, this.viewTilt);
      if (lit !== l.surface) out = mapLayer(out, id, () => ({ ...l, surface: lit }));
    }
    return out;
  }

  /**
   * Light paint over the (lit) layers: glow, rim and clarity in each layer's pixels, and its spill
   * as a Linear Dodge (Add) layer directly above it (from the painting as committed, so a stroke in
   * progress does not redraw the blur every frame).
   */
  private lightLayers(layers: PaintLayer[]): PaintLayer[] {
    const light = this.doc.light ?? {};
    const ids = new Set([...Object.keys(light), ...Object.keys(this.doc.thick ?? {})]);
    if (!ids.size) return layers;
    let out = layers;
    for (const id of ids) {
      const l = findLayer(out, id)?.layer;
      if (!isPixelLayer(l)) continue;
      let cache = this.lightCaches.get(id);
      if (!cache) this.lightCaches.set(id, (cache = new LightCache()));
      const glowed = cache.glow(l.surface, light[id], this.liveThick?.layerId === id ? this.liveThick.channels : this.doc.thick?.[id]);
      if (glowed !== l.surface) out = mapLayer(out, id, () => ({ ...l, surface: glowed }));
      const committed = findLayer(this.doc.layers, id)?.layer;
      const spill = light[id] && isPixelLayer(committed) ? cache.spill(committed.surface, light[id], this.lightSpillOf(id)) : null;
      if (spill) out = insertAfter(out, id, { type: 'pixel', id: `${id}${SPILL_SUFFIX}`, name: `${l.name} light`, visible: l.visible, opacity: l.opacity, blend: 'linear-dodge', surface: spill, offset: { ...l.offset } } as PaintPixelLayer);
    }
    return out;
  }

  /** Visible pixel layers bottom first, as the backlight reads them (group opacities multiplied in). */
  private backlitLayers(layers: readonly PaintLayer[], committed: boolean, opacity = 1, out: BacklitLayer[] = []): BacklitLayer[] {
    for (const l of layers) {
      if (!l.visible) continue;
      if (l.type === 'group') this.backlitLayers(l.children, committed, opacity * l.opacity, out);
      else if (isPixelLayer(l)) {
        const thick = !committed && this.liveThick?.layerId === l.id ? this.liveThick.channels : this.doc.thick?.[l.id];
        out.push({ surface: l.surface, offset: l.offset, opacity: opacity * l.opacity, ...(thick ? { thick } : {}) });
      }
    }
    return out;
  }

  /**
   * Backlit paper: the light that makes it through `base` (the layers as drawn), with the spill of
   * the light through the committed painting, as a Linear Dodge (Add) layer for the top of the
   * stack; `null` when the paper has no backlight.
   */
  private backlightLayer(base: PaintLayer[]): PaintPixelLayer | null {
    const paper = this.doc.paper;
    const amount = backlightOf(paper);
    if (!(amount > 0)) return null;
    const { width, height } = this.doc.canvas;
    const grain = paperGrain(paper);
    const current = this.backlightView.surface(paper, grain, width, height, this.backlitLayers(base, false), null)!;
    const committed = base === this.doc.layers ? current : this.backlightCommitted.surface(paper, grain, width, height, this.backlitLayers(this.doc.layers, true), null);
    const surface = this.backlightView.layer(current, committed, amount);
    return { type: 'pixel', id: BACKLIGHT_LAYER_ID, name: 'Backlight', visible: true, opacity: 1, blend: 'linear-dodge', surface, offset: { x: 0, y: 0 } } as PaintPixelLayer;
  }

  private renderLayers(options: RenderOptions, view = false): ViewLayer[] {
    const base = (options.wet ?? 'display') === 'dried' ? this.driedLayers() : this.currentLayers();
    let layers: PaintLayer[] = this.lightLayers(this.uvLayers(this.litLayers(this.thermoLayers(base))));
    const backlight = options.paper !== false && !options.layerIds ? this.backlightLayer(base) : null;
    if (backlight) layers = [...layers, backlight];
    if (options.layerIds) {
      const picked: PaintLayer[] = [];
      for (const id of options.layerIds) picked.push(findLayer(layers, id)?.layer ?? this.requireLayer(id));
      layers = picked.map((l) => ({ ...l, visible: true }) as PaintLayer);
    }
    const under: ViewLayer[] = options.paper === false ? [] : [paperNode(uvPaper(this.doc.paper, this.uvLight), this.lighting)];
    if (options.paper !== false && this.doc.paperEffect) under.push(this.paperEffectNode(this.doc.paperEffect));
    if (view) under.push(...this.underlayLayers());
    return [...under, ...layers];
  }

  /**
   * Composites the viewport stack (paper, view-only underlays, layers with the live stroke) tile by
   * tile over `rect`, calling `onTile` with each 256 px tile's RGBA (cached: unchanged tiles come back
   * as the same buffer). Pass `takeDirty()` as `dirty`. With `paper: false` the paper is left out and
   * unpainted pixels stay transparent, for a host that draws the paint over its own surface.
   */
  compositeTiles(rect: RasterRect, onTile: (tx: number, ty: number, data: Uint8ClampedArray, changed: boolean) => void, options: { dirty?: RasterRect[] | 'all'; paper?: boolean } = {}): void {
    const dirty = options.dirty === 'all' ? undefined : options.dirty;
    this.viewCompositor.compositeTiles(this.renderLayers({ paper: options.paper }, true), rect, this.sources(), onTile, { dirty, checkpointLayerId: this.live?.layerId ?? this.doc.activeLayerId });
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
    let state = this.doc;
    for (const m of this.mutations) {
      if (m.medium !== 'dry' || !m.tempLayerId || !findLayer(state.layers, m.tempLayerId)) continue;
      if (m.state === 'claimed' || m.state === 'answered') {
        const tempId = m.tempLayerId;
        state = {
          ...state,
          layers: mapLayer(state.layers, tempId, () => null),
          strokes: state.strokes.filter((s) => s.layerId !== tempId),
        };
      } else {
        state = this.mergeTempLayerIntoTarget(state, m.tempLayerId, m.layerId);
      }
    }
    for (const l of flattenLayers(state.layers)) {
      if (isPixelLayer(l) && l.temporary) {
        const targetId = this.tempLayerTargets.get(l.id);
        if (targetId && findLayer(state.layers, targetId)) {
          state = this.mergeTempLayerIntoTarget(state, l.id, targetId);
        } else {
          state = {
            ...state,
            layers: mapLayer(state.layers, l.id, () => null),
            strokes: state.strokes.filter((s) => s.layerId !== l.id),
          };
        }
      }
    }
    const layers = this.driedLayers(state.layers);
    return layers === state.layers ? state : { ...state, layers };
  }

  /** Wet settings saved with the document (`null` when they are all defaults). */
  private wetJSON(): unknown {
    const layers: Record<string, WetLayerSettings> = {};
    for (const [id, set] of this.wet.settings) {
      if (!findLayer(this.doc.layers, id)) continue;
      const ghost = this.wet.world?.hasLane(id) ? this.wet.world.getGhost(id) : set.ghost ?? null;
      const savedGhost = ghost?.trigger === 'agent' ? null : ghost;
      const heldEvap = this.heldEvaporation.get(id);
      const params = heldEvap !== undefined ? { ...set.params, evaporation: heldEvap } : { ...set.params };
      layers[id] = {
        params,
        flow: { ...set.flow },
        ...(savedGhost ? { ghost: savedGhost } : {}),
        ...(set.livePatterns ? { livePatterns: { ...set.livePatterns } } : {}),
      };
    }
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
        const x = v as { params?: Partial<WetParams>; flow?: Partial<WetFlowSpec>; ghost?: unknown; livePatterns?: LivePatternsInput | null };
        const ghost = readWetGhost(x.ghost);
        const livePatterns = x.livePatterns ? normalizeLivePatterns(x.livePatterns) : null;
        this.wet.settings.set(id, {
          params: normalizeWetParams(x.params ?? {}),
          flow: normalizeFlow(x.flow ?? {}),
          ...(ghost ? { ghost } : {}),
          ...(livePatterns ? { livePatterns } : {}),
        });
        if (livePatterns) this.wet.patternFieldOf(id).configure(livePatterns);
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
    const stickers: Record<string, Sticker[]> = {};
    for (const [id, list] of Object.entries(this.doc.stickers ?? {})) if (list.length && findLayer(this.doc.layers, id)) stickers[id] = list.map((x) => ({ ...x }));
    if (Object.keys(stickers).length) ext.stickers = stickers;
    else delete ext.stickers;
    const liveStrokes: Record<string, RecordedStroke[]> = {};
    for (const [id, list] of Object.entries(this.doc.liveStrokes ?? {})) if (findLayer(this.doc.layers, id)) liveStrokes[id] = list.map(strokeToJSON) as unknown as RecordedStroke[];
    if (Object.keys(liveStrokes).length) ext.liveStrokes = liveStrokes;
    else delete ext.liveStrokes;
    // The image sources the strokes draw with, bytes included, so replays and repaints match anywhere.
    const strokes = [...this.doc.strokes, ...Object.values(this.doc.liveStrokes ?? {}).flat()];
    const sourceIds = [...new Set(strokes.flatMap((st) => engineBrushSourceIds(st.brush)))];
    const sources = sourceIds.map((id) => this.brushSources.source(id)).filter((x) => x !== undefined);
    if (sources.length) ext.brushSources = sources.map((x) => ({ ...x }));
    else delete ext.brushSources;
    const light: Record<string, unknown> = {};
    for (const [id, t] of Object.entries(this.doc.light ?? {})) {
      if (!findLayer(this.doc.layers, id)) continue;
      // Wet light is saved dried where it is, as the paint is.
      const saved = lightToJSON(this.wet.bakedLight(id) ?? t);
      if (saved) light[id] = saved;
    }
    if (Object.keys(light).length) ext.light = light;
    else delete ext.light;
    const spills = Object.fromEntries(Object.entries(this.lightSpills).filter(([id]) => findLayer(this.doc.layers, id)));
    if (Object.keys(spills).length) ext.lightSpill = spills;
    else delete ext.lightSpill;
    const effectLayers = effectLayersToJSON(this.doc.effectLayers ?? {}, (id) => isPixelLayer(findLayer(this.doc.layers, id)?.layer));
    if (effectLayers) ext.effectLayers = effectLayers;
    else delete ext.effectLayers;
    if (this.doc.paperEffect) ext.paperEffect = paperEffectToJSON(this.doc.paperEffect);
    else delete ext.paperEffect;
    if (this.lighting.azimuth !== DEFAULT_LIGHTING.azimuth || this.lighting.elevation !== DEFAULT_LIGHTING.elevation || this.lighting.relief !== DEFAULT_LIGHTING.relief) ext.lighting = { ...this.lighting };
    else delete ext.lighting;
    const fluor: Record<string, unknown> = {};
    for (const [id, f] of Object.entries(this.doc.fluor ?? {})) {
      if (!findLayer(this.doc.layers, id)) continue;
      const saved = fluorToJSON(f);
      if (saved) fluor[id] = saved;
    }
    if (Object.keys(fluor).length) ext.fluor = fluor;
    else delete ext.fluor;
    const thermo: Record<string, unknown> = {};
    for (const [id, th] of Object.entries(this.doc.thermo ?? {})) {
      if (!findLayer(this.doc.layers, id)) continue;
      const saved = thermoToJSON(th);
      if (saved) thermo[id] = saved;
    }
    if (Object.keys(thermo).length) ext.thermo = thermo;
    else delete ext.thermo;
    const savedHeat = this.doc.heat ? heatToJSON(this.doc.heat) : null;
    if (savedHeat) ext.heat = savedHeat;
    else delete ext.heat;
    if (this.uvLight.on !== DEFAULT_UV_LIGHT.on || this.uvLight.strength !== DEFAULT_UV_LIGHT.strength || this.uvLight.ambient !== DEFAULT_UV_LIGHT.ambient) ext.uvLight = { ...this.uvLight };
    else delete ext.uvLight;
    return ext;
  }

  /** Reads `layerChannels` and `lighting` from loaded extensions into the document. */
  private readThick(state: PaintDocumentState, ext: PaintDocumentExtensions, problems: string[]): PaintDocumentState {
    if (Array.isArray(ext.brushSources)) this.brushSources.set(ext.brushSources.map((x, i) => readBrushSource(x, `brushSources[${i}]`, problems)).filter((x) => x !== null));
    this.lighting = normalizeLighting((ext.lighting as Partial<PaintLighting>) ?? {}, DEFAULT_LIGHTING);
    this.uvLight = normalizeUvLight((ext.uvLight as Partial<UvLightSettings>) ?? {}, DEFAULT_UV_LIGHT);
    this.litCaches.clear();
    this.uvCaches.clear();
    this.thermoCaches.clear();
    if (ext.stickers && typeof ext.stickers === 'object') {
      const stickers: Record<string, Sticker[]> = {};
      for (const [id, list] of Object.entries(ext.stickers as Record<string, unknown>)) {
        if (!findLayer(state.layers, id) || !Array.isArray(list)) continue;
        // Older documents name an editor stamp (stamp: "star"); newer ones a ref (ref: "editor:star").
        const ok = (list as Sticker[]).flatMap((x) => {
          if (!x || typeof x.id !== 'string' || !Number.isFinite(x.x) || !Number.isFinite(x.y) || !(x.size > 0)) return [];
          try {
            const ref = normalizeStickerRef(x.ref ?? (x.stamp as string));
            const stamp = editorStampOf(ref);
            const { stamp: _old, variant, ...rest } = x;
            return [{ ...rest, ref, ...(stamp ? { stamp } : {}), ...(variant === 'dark' && !stamp ? { variant } : {}) } as Sticker];
          } catch {
            return [];
          }
        });
        if (ok.length !== list.length) problems.push(`Some stickers of layer "${id}" could not be read; they were dropped.`);
        stickers[id] = ok;
      }
      if (Object.keys(stickers).length) state = { ...state, stickers };
    }
    if (ext.liveStrokes && typeof ext.liveStrokes === 'object') {
      const liveStrokes: Record<string, RecordedStroke[]> = {};
      for (const [id, list] of Object.entries(ext.liveStrokes as Record<string, unknown>)) {
        if (!isPixelLayer(findLayer(state.layers, id)?.layer) || !Array.isArray(list)) continue;
        const ok = list.map(normalizeBrushStroke).filter((x): x is RecordedStroke => x !== null).map((x) => ({ ...x, layerId: id }));
        if (ok.length !== list.length) problems.push(`Some strokes of stroke layer "${id}" could not be read; they were dropped (the layer's pixels are kept until a stroke is edited).`);
        liveStrokes[id] = ok;
      }
      if (Object.keys(liveStrokes).length) state = { ...state, liveStrokes };
    }
    if (ext.effectLayers && typeof ext.effectLayers === 'object') {
      const effectLayers: Record<string, PaintEffectSource> = {};
      for (const [id, v] of Object.entries(ext.effectLayers as Record<string, unknown>)) {
        if (!isPixelLayer(findLayer(state.layers, id)?.layer)) continue;
        const source = readPaintEffectSource(v);
        if (source) effectLayers[id] = source;
        else problems.push(`The effect of layer "${id}" could not be read; it loads as a plain layer.`);
      }
      if (Object.keys(effectLayers).length) state = { ...state, effectLayers };
    }
    if (ext.paperEffect !== undefined) {
      try {
        state = { ...state, paperEffect: paperEffectFromJSON(ext.paperEffect, state.canvas.width, state.canvas.height) };
      } catch (e) {
        problems.push(`The effect paper could not be read (${(e as Error).message}); the plain paper shows.`);
      }
    }
    this.lightSpills = {};
    this.lightCaches.clear();
    if (ext.lightSpill && typeof ext.lightSpill === 'object') {
      for (const [id, v] of Object.entries(ext.lightSpill as Record<string, Partial<LightSpill>>)) {
        try {
          if (findLayer(state.layers, id)) this.lightSpills[id] = normalizeLightSpill(v ?? {});
        } catch {
          problems.push(`The light spill of layer "${id}" could not be read; it takes the defaults.`);
        }
      }
    }
    if (ext.light && typeof ext.light === 'object') {
      const light: Record<string, TiledSurface> = {};
      for (const [id, v] of Object.entries(ext.light as Record<string, unknown>)) {
        if (!isPixelLayer(findLayer(state.layers, id)?.layer)) continue;
        try {
          light[id] = lightFromJSON(v);
        } catch (e) {
          problems.push(`The light paint of layer "${id}" could not be read (${(e as Error).message}); it loads without light.`);
        }
      }
      if (Object.keys(light).length) state = { ...state, light };
    }
    if (ext.fluor && typeof ext.fluor === 'object') {
      const fluor: Record<string, TiledSurface> = {};
      for (const [id, v] of Object.entries(ext.fluor as Record<string, unknown>)) {
        if (!isPixelLayer(findLayer(state.layers, id)?.layer)) continue;
        try {
          fluor[id] = fluorFromJSON(v);
        } catch (e) {
          problems.push(`The fluorescent ink of layer "${id}" could not be read (${(e as Error).message}); it loads without fluorescence.`);
        }
      }
      if (Object.keys(fluor).length) state = { ...state, fluor };
    }
    if (ext.thermo && typeof ext.thermo === 'object') {
      const thermo: Record<string, TiledSurface> = {};
      for (const [id, v] of Object.entries(ext.thermo as Record<string, unknown>)) {
        if (!isPixelLayer(findLayer(state.layers, id)?.layer)) continue;
        try {
          thermo[id] = thermoFromJSON(v);
        } catch (e) {
          problems.push(`The thermochromic ink of layer "${id}" could not be read (${(e as Error).message}); it loads without thermochromic shift.`);
        }
      }
      if (Object.keys(thermo).length) state = { ...state, thermo };
    }
    if (ext.heat !== undefined) {
      const heat = heatFromJSON(ext.heat, state.canvas.width, state.canvas.height);
      if (heat) state = { ...state, heat };
      else problems.push('The heat field could not be read; the canvas loads cool.');
    }
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
    if (Array.isArray(loaded.swatches)) this.swatches = loaded.swatches.map(readSwatch).filter((x): x is Swatch => x !== null);
    for (const s of loaded.state.strokes) {
      const n = Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0);
      if (n >= this.strokeCounter) this.strokeCounter = n + 1;
    }
    this.undoStack = [];
    this.redoStack = [];
    this.resetMutations();
    this.doc = this.readThick(loaded.state, loaded.extensions, loaded.problems);
    for (const list of Object.values(this.doc.liveStrokes ?? {})) {
      for (const s of list) {
        const n = Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0);
        if (n >= this.strokeCounter) this.strokeCounter = n + 1;
      }
    }
    this.docRevision++;
    delete this.extensions.layerChannels;
    delete this.extensions.light;
    delete this.extensions.lightSpill;
    delete this.extensions.lighting;
    delete this.extensions.stickers;
    delete this.extensions.liveStrokes;
    delete this.extensions.brushSources;
    delete this.extensions.effectLayers;
    delete this.extensions.paperEffect;
    delete this.extensions.fluor;
    delete this.extensions.thermo;
    delete this.extensions.heat;
    delete this.extensions.uvLight;
    this.viewCompositor.clear();
    this.emit();
    // Provider stickers keep their saved pixels; their art loads now so they can be edited.
    const refs = Object.values(this.doc.stickers ?? {}).flatMap((list) => list.map((x) => x.ref));
    if (refs.some((r) => !editorStampOf(r))) void this.prepareStickers(refs).catch(() => this.emit([]));
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
    // Thick paint lit, light paint glowing, and each layer's spill as a Linear Dodge (Add) layer above it.
    const driedBase = this.driedLayers(this.doc.layers);
    const backlight = this.backlightLayer(driedBase);
    const dried = [...this.lightLayers(this.uvLayers(this.litLayers(this.thermoLayers(driedBase)))), ...(backlight ? [backlight] : [])];
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
    if (backlight) {
      result.warnings.push('Backlit paper is written as pixels: the light that comes through the paint is a "Backlight" Linear Dodge (Add) layer at the top. Opening the PSD again gives a plain pixel layer, not a backlight.');
    }
    if (Object.values(this.doc.light ?? {}).some((l) => l.tiles.size)) {
      result.warnings.push('Light paint is written as pixels: each layer with its glow, and its spill as a "‹layer› light" Linear Dodge (Add) layer above it. Opening the PSD again gives plain pixel layers, not editable light.');
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
    if (Array.isArray(r.stencils)) {
      guides.stencils = [];
      (r.stencils as Stencil[]).forEach((raw, i) => {
        try {
          const id = typeof raw?.id === 'string' && /^stencil\d+$/.test(raw.id) ? raw.id : `stencil${this.nextStencilId}`;
          guides.stencils.push(normalizeStencil(raw, id));
          const n = Number(id.slice(7));
          if (n >= this.nextStencilId) this.nextStencilId = n + 1;
        } catch (e) {
          problems.push(`Stencil ${i + 1}: ${(e as Error).message}`);
        }
      });
    }
    this.guides = guides;
  }

  // --- Stickers --------------------------------------------------------------------

  /** The document's `stickers` without these layers (as a spread: `{}` when unchanged). */
  private stickersWithout(ids: readonly string[]): { stickers?: Record<string, Sticker[]> } {
    const t = this.doc.stickers;
    if (!t || !ids.some((id) => t[id])) return {};
    const out = { ...t };
    for (const id of ids) delete out[id];
    return { stickers: out };
  }

  /** The next free sticker number (ids `st<n>` are unique across the document). */
  private nextStickerNumber(doc: PaintDocumentState = this.doc): number {
    let n = 0;
    for (const list of Object.values(doc.stickers ?? {})) for (const st of list) n = Math.max(n, Number(/^st(\d+)$/.exec(st.id)?.[1] ?? 0));
    return n + 1;
  }

  private stickerLayer(layerId: string | undefined): { layer: PaintPixelLayer; stickers: Sticker[] } {
    const l = this.wetLayer(layerId, 'edit the stickers of');
    const stickers = this.doc.stickers?.[l.id];
    if (!stickers) throw new PaintEditorError(`Layer "${l.name}" has no stickers; spray some with a sticker brush (sticker-stars; list_brush_presets lists them).`);
    return { layer: l, stickers };
  }

  // --- The sticker library ---------------------------------------------------------

  /** The sticker library: the editor's own stamps unless a host set its own. */
  get stickersProvider(): StickerProvider {
    return this.stickers.provider;
  }

  /**
   * Sets the sticker library (`null` goes back to the editor's own stamps, `editorStickers()`);
   * to offer both, pass `combineStickerProviders([editorStickers(), yours])`. Loaded art is
   * forgotten. Not an edit: no undo step.
   */
  setStickersProvider(provider: StickerProvider | null): void {
    if ((provider ?? this.stickers.fallback) === this.stickers.provider) return;
    this.stickers.set(provider);
    this.stickerArt.clear();
    this.emit([]);
  }

  /**
   * Loads the art of `refs` (provider stickers; editor stamps need none) so sprays and placements
   * can draw them: their dark variants when the colour scheme is dark and they have one. Rejects with a `PaintEditorError` naming an unknown ref and the closest known
   * ones, or a sticker whose art failed. Emits when art arrives, so views redraw.
   */
  async prepareStickers(refs: readonly StickerRef[]): Promise<void> {
    const list = [...new Set(refs.map((r) => this.readStickerRef(r)))].filter((r) => !editorStampOf(r));
    try {
      await Promise.all(list.map((r) => this.stickerArt.ensure(this.stickers.provider, r, this.rasterizeSticker, this.colorScheme === 'dark')));
    } catch (e) {
      throw new PaintEditorError(e instanceof Error ? e.message : String(e));
    } finally {
      if (list.length) this.emit([]);
    }
  }

  /** Whether a sticker's art is ready to draw in the variant the colour scheme picks: `ready` (always for editor stamps), `loading`, `failed` (with why) or `none`. */
  stickerArtStatus(ref: StickerRef): { status: 'ready' | 'loading' | 'failed' | 'none'; error?: string } {
    const r = this.readStickerRef(ref);
    return this.stickerArt.status(r, this.stickerArt.variantFor(r, this.colorScheme === 'dark'));
  }

  /**
   * A sticker whose ref is new (placed or restamped) in the variant the colour scheme picks: `dark`
   * on a dark scheme when its sticker has one (known once its art was asked for).
   */
  private withStickerVariant<T extends Partial<Sticker> & Pick<Sticker, 'ref'>>(s: T): T {
    const { variant: _old, ...rest } = s;
    const v: StickerVariant = editorStampOf(s.ref) ? 'light' : this.stickerArt.variantFor(s.ref, this.colorScheme === 'dark');
    return (v === 'dark' ? { ...rest, variant: v } : rest) as T;
  }

  private readStickerRef(ref: StickerRef): StickerRef {
    try {
      return normalizeStickerRef(ref);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
  }

  /** Refuses to redraw stickers whose art has not loaded (they would vanish), naming them and what to call. */
  private requireStickerArt(stickers: readonly Sticker[]): void {
    const missing = stickers.filter((s) => !stickerStamp(s) && !this.stickerArt.get(s.ref, s.variant));
    if (missing.length) {
      const dark = this.colorScheme === 'dark';
      const loads = new Map<string, [StickerRef, boolean]>();
      for (const s of missing) {
        loads.set(`${s.ref}#${s.variant ?? 'light'}`, [s.ref, s.variant === 'dark']);
        // On a dark scheme the dark art too, so placing it again picks that variant.
        if (dark) loads.set(`${s.ref}#dark`, [s.ref, true]);
      }
      for (const [r, d] of loads.values()) void this.stickerArt.ensure(this.stickers.provider, r, this.rasterizeSticker, d).then(() => this.emit([]), () => this.emit([]));
      const refs = [...new Set(missing.map((s) => s.ref))];
      throw new PaintEditorError(`The art for ${refs.map((r) => `"${r}"`).join(', ')} has not loaded yet; it is loading now (prepareStickers), so try again when it has.`);
    }
  }

  /** A layer's stickers, bottom first. */
  listStickers(layerId?: string): Sticker[] {
    const id = layerId ?? this.doc.activeLayerId;
    if (!id) return [];
    this.requireLayer(id);
    return (this.doc.stickers?.[id] ?? []).map((s) => ({ ...s }));
  }

  /**
   * Replaces a layer's stickers and redraws its pixels from them (one undo step). With `dirty`,
   * only the tiles under those rects are redrawn.
   */
  private commitStickers(label: string, layer: PaintPixelLayer, stickers: Sticker[], dirty?: RasterRect[]): void {
    if (isLayerLocked(layer, 'pixels')) throw new PaintEditorError(`Layer "${layer.name}" has its pixels locked; unlock it first.`);
    this.requireStickerArt(stickers);
    const before = this.previewBase() ?? this.doc;
    this.stickerPreview = null;
    const surface = this.redrawStickers(layer, stickers, dirty);
    const doc = { ...this.doc, layers: mapLayer(this.doc.layers, layer.id, () => ({ ...layer, surface, offset: { x: 0, y: 0 } })), stickers: { ...(this.doc.stickers ?? {}), [layer.id]: stickers } };
    this.commit(label, this.withPaintEvent(doc, { kind: 'stickers', layerId: layer.id, data: { stickers: stickers.map((s) => ({ ...s })) } }), before);
  }

  private redrawStickers(layer: PaintPixelLayer, stickers: readonly Sticker[], dirty?: RasterRect[]): TiledSurface {
    const partial = dirty && !layer.offset.x && !layer.offset.y;
    return partial ? stickerSurface(stickers, layer.surface, dirty, this.stickerArt.get) : stickerSurface(stickers, undefined, undefined, this.stickerArt.get);
  }

  /** The document from before the sticker preview on screen, or `null` when none is (anything else changed the document since). */
  private previewBase(): PaintDocumentState | null {
    return this.stickerPreview?.shown === this.doc ? this.stickerPreview.base : null;
  }

  private readStickerUpdate(update: Partial<Omit<Sticker, 'id'>>): Partial<Omit<Sticker, 'id'>> {
    try {
      return normalizeStickerUpdate(update);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
  }

  /** The top-most sticker under a point (document pixels) on a layer (default the active one), or `null`. */
  stickerAt(layerId: string | undefined, x: number, y: number): Sticker | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PaintEditorError('x and y must be numbers of document pixels.');
    const id = layerId ?? this.doc.activeLayerId;
    if (!id) return null;
    this.requireLayer(id);
    const hit = hitSticker(this.doc.stickers?.[id] ?? [], x, y, this.stickerArt.get);
    return hit ? { ...hit } : null;
  }

  /** Picks a sticker for the panel and canvas (`null` for none). Editor state, not an undo step. */
  selectSticker(id: string | null): void {
    if (id === this.selectedSticker) return;
    this.selectedSticker = id;
    this.emit([]);
  }

  /**
   * Shows a sticker change without committing it (a drag in progress): only the tiles under its
   * old and new place are redrawn. `updateSticker` then commits it as one undo step from before
   * the first preview; `cancelStickerPreview` puts it back.
   */
  previewSticker(layerId: string | undefined, id: string, update: Partial<Omit<Sticker, 'id'>>): Sticker {
    const { layer, stickers } = this.stickerLayer(layerId);
    if (isLayerLocked(layer, 'pixels')) throw new PaintEditorError(`Layer "${layer.name}" has its pixels locked; unlock it first.`);
    const i = stickers.findIndex((s) => s.id === id);
    if (i < 0) throw new PaintEditorError(`Layer "${layer.name}" has no sticker "${id}". Call list_stickers for the ids.`);
    const u = this.readStickerUpdate(update);
    const next = u.ref !== undefined ? this.withStickerVariant({ ...stickers[i], ...u }) : { ...stickers[i], ...u };
    const list = stickers.map((s, j) => (j === i ? next : s));
    const dirty = [stickerRect(stickers[i]), stickerRect(next)];
    const base = this.previewBase() ?? this.doc;
    const surface = this.redrawStickers(layer, list, dirty);
    this.doc = { ...this.doc, layers: mapLayer(this.doc.layers, layer.id, () => ({ ...layer, surface, offset: { x: 0, y: 0 } })), stickers: { ...(this.doc.stickers ?? {}), [layer.id]: list } };
    this.stickerPreview = { base, shown: this.doc };
    this.emit(dirty);
    return { ...next };
  }

  /** Drops a sticker preview, restoring the document from before it. */
  cancelStickerPreview(): void {
    const base = this.previewBase();
    this.stickerPreview = null;
    if (!base) return;
    this.doc = base;
    this.emit();
  }

  /** Moves, turns, resizes, recolours or restamps one sticker (one undo step). Returns it. */
  updateSticker(layerId: string | undefined, id: string, update: Partial<Omit<Sticker, 'id'>>): Sticker {
    const { layer, stickers } = this.stickerLayer(layerId);
    const i = stickers.findIndex((s) => s.id === id);
    if (i < 0) throw new PaintEditorError(`Layer "${layer.name}" has no sticker "${id}". Call list_stickers for the ids.`);
    const u = this.readStickerUpdate(update);
    const next = u.ref !== undefined ? this.withStickerVariant({ ...stickers[i], ...u }) : { ...stickers[i], ...u };
    this.commitStickers('Edit sticker', layer, stickers.map((s, j) => (j === i ? next : s)), [stickerRect(stickers[i]), stickerRect(next)]);
    return { ...next };
  }

  /**
   * Places stickers exactly (one undo step), on top of a sticker layer or onto an empty layer,
   * which becomes one. Missing fields: size 48 px, rotation 0, the paint colour, opacity 1, a seed
   * from the new id. Returns the new stickers with their ids.
   */
  addStickers(layerId: string | undefined, input: readonly (Partial<Omit<Sticker, 'id'>> & Pick<Sticker, 'x' | 'y'>)[]): Sticker[] {
    const layer = this.wetLayer(layerId, 'add stickers to');
    if (!input.length) throw new PaintEditorError('Pass at least one sticker (ref, x, y).');
    if (input.length > MAX_ADD_STICKERS) throw new PaintEditorError(`At most ${MAX_ADD_STICKERS} stickers per call; split them over several calls.`);
    const existing = this.doc.stickers?.[layer.id];
    if (!existing?.length) {
      if (this.wet.wetLayerIds().includes(layer.id) || contentBounds(layer.surface)) throw new PaintEditorError(`Layer "${layer.name}" already has paint; add stickers to an empty layer (add_layer) or a sticker layer so they stay editable.`);
    }
    let n = this.nextStickerNumber();
    const added = input.map((raw, i) => {
      if (raw.ref === undefined && raw.stamp === undefined) throw new PaintEditorError(`Sticker ${i} needs ref (a sticker ref from find_stickers, e.g. "editor:star").`);
      for (const k of ['x', 'y'] as const) if (raw[k] === undefined) throw new PaintEditorError(`Sticker ${i} needs ${k}.`);
      let u: Partial<Omit<Sticker, 'id'>>;
      try {
        u = this.readStickerUpdate(raw);
      } catch (e) {
        throw new PaintEditorError(`Sticker ${i}: ${(e as Error).message}`);
      }
      if (raw.seed !== undefined && !Number.isInteger(raw.seed)) throw new PaintEditorError(`Sticker ${i}: seed must be a whole number.`);
      const id = n++;
      return this.withStickerVariant({ id: `st${id}`, size: 48, rotation: 0, color: this.color, opacity: 1, seed: raw.seed ?? (mix32((id * 0x9e3779b1) >>> 0) & 0x7fffffff), ...u } as Sticker);
    });
    this.commitStickers('Add stickers', layer, [...(existing ?? []), ...added], existing?.length ? added.map(stickerRect) : undefined);
    return added.map((s) => ({ ...s }));
  }

  /** Brings stickers to the top (`front`) or bottom of their layer (one undo step). */
  arrangeStickers(layerId: string | undefined, ids: readonly string[], to: 'front' | 'back'): string[] {
    const { layer, stickers } = this.stickerLayer(layerId);
    for (const id of ids) if (!stickers.some((s) => s.id === id)) throw new PaintEditorError(`Layer "${layer.name}" has no sticker "${id}". Call list_stickers for the ids.`);
    const picked = stickers.filter((s) => ids.includes(s.id));
    const rest = stickers.filter((s) => !ids.includes(s.id));
    const next = to === 'front' ? [...rest, ...picked] : [...picked, ...rest];
    this.commitStickers('Arrange stickers', layer, next, picked.map(stickerRect));
    return next.map((s) => s.id);
  }

  /** Deletes stickers (`ids`, or all of them on the layer) (one undo step). Returns the ids removed. */
  removeStickers(layerId: string | undefined, ids?: readonly string[]): string[] {
    const { layer, stickers } = this.stickerLayer(layerId);
    if (ids) for (const id of ids) if (!stickers.some((s) => s.id === id)) throw new PaintEditorError(`Layer "${layer.name}" has no sticker "${id}". Call list_stickers for the ids.`);
    const removed = ids ? [...ids] : stickers.map((s) => s.id);
    this.commitStickers('Remove stickers', layer, stickers.filter((s) => !removed.includes(s.id)), ids ? stickers.filter((s) => removed.includes(s.id)).map(stickerRect) : undefined);
    return removed;
  }

  /** Sets a layer's stickers (replays). */
  replaceStickers(layerId: string, stickers: readonly Sticker[]): void {
    const l = this.wetLayer(layerId, 'set the stickers of');
    this.commitStickers('Stickers', l, stickers.map((s) => ({ ...s })));
  }

  // --- Live stroke layers ---------------------------------------------------------

  /** The document's `liveStrokes` without these layers (as a spread: `{}` when unchanged). */
  private liveStrokesWithout(ids: readonly string[]): { liveStrokes?: Record<string, RecordedStroke[]> } {
    const t = this.doc.liveStrokes;
    if (!t || !ids.some((id) => t[id])) return {};
    const out = { ...t };
    for (const id of ids) delete out[id];
    return { liveStrokes: out };
  }

  private liveStrokeLayer(layerId: string | undefined, what: string): { layer: PaintPixelLayer; strokes: readonly RecordedStroke[] } {
    const l = this.wetLayer(layerId, what);
    const strokes = this.doc.liveStrokes?.[l.id];
    if (!strokes) throw new PaintEditorError(`Layer "${l.name}" is not a stroke layer; add one with add_layer {type: "strokes"} (or convert_to_stroke_layer on an empty layer), then paint on it.`);
    return { layer: l, strokes };
  }

  /** Whether a layer is a live stroke layer. */
  isLiveStrokeLayer(layerId: string): boolean {
    return Boolean(this.doc.liveStrokes?.[layerId]);
  }

  /** Makes an empty pixel layer a live stroke layer (one undo step). */
  convertToLiveStrokes(layerId?: string): PaintLayerInfo {
    this.requireIdle('converting a layer');
    const l = this.paintTarget(layerId, 'convert');
    if (this.doc.liveStrokes?.[l.id]) return this.describeLayer(l);
    if (this.doc.stickers?.[l.id]?.length) throw new PaintEditorError(`Layer "${l.name}" is a sticker layer; add a stroke layer instead (add_layer {type: "strokes"}).`);
    if (contentBounds(l.surface) || this.wet.wetLayerIds().includes(l.id)) throw new PaintEditorError(`Layer "${l.name}" already has paint, which isn't kept as strokes; convert an empty layer or add a stroke layer (add_layer {type: "strokes"}).`);
    this.commit('Convert to stroke layer', { ...this.doc, liveStrokes: { ...(this.doc.liveStrokes ?? {}), [l.id]: [] } });
    return this.describeLayer(this.getLayer(l.id)!);
  }

  /** A stroke layer's strokes, bottom first. */
  listLiveStrokes(layerId?: string): RecordedStroke[] {
    return this.liveStrokeLayer(layerId, 'list the strokes of').strokes.map((x) => ({ ...x }));
  }

  /** The stroke layer holding a live stroke, and where. */
  private findLiveStroke(id: string): { layer: PaintPixelLayer; strokes: readonly RecordedStroke[]; index: number } {
    for (const [layerId, strokes] of Object.entries(this.doc.liveStrokes ?? {})) {
      const index = strokes.findIndex((x) => x.id === id);
      const layer = findLayer(this.doc.layers, layerId)?.layer;
      if (index >= 0 && isPixelLayer(layer)) return { layer, strokes, index };
    }
    const baked = this.doc.strokes.some((x) => x.id === id);
    throw new PaintEditorError(
      baked
        ? `Stroke "${id}" was painted on a pixel layer, so its pixels are baked; only strokes on a stroke layer can be edited (list_strokes {live: true}). Replay it onto a stroke layer (replay_strokes layerId) to edit the copy.`
        : `Unknown stroke "${id}". Call list_strokes {live: true} for the ids of editable strokes.`
    );
  }

  /**
   * Changes a live stroke's brush (a preset by `brushId`, keeping the stroke's size, and/or brush
   * settings), colour, paint or seed, and redraws its layer (one undo step). A new colour replaces
   * gradient or effect paint. Returns the stroke and the area that changed.
   */
  updateStroke(id: string, update: LiveStrokeUpdate): { stroke: RecordedStroke; bounds: RasterRect } {
    this.requireIdle('editing a stroke');
    const { layer, strokes, index } = this.findLiveStroke(id);
    const was = strokes[index];
    let brush = was.brush;
    if (update.brushId !== undefined) {
      const b = this.requireBrush(update.brushId);
      brush = normalizePaintBrush({ tip: { ...b.tip, size: was.brush.tip.size } }, b);
    }
    if (update.brush !== undefined) {
      if (!update.brush || typeof update.brush !== 'object') throw new PaintEditorError('brush must be an object of brush settings (as set_brush takes).');
      brush = normalizePaintBrush({ ...update.brush, id: brush.id }, brush);
    }
    const why = liveStrokeRefusal(brush);
    if (why) throw new PaintEditorError(why);
    const next: RecordedStroke = { ...was, brush: brushToJSON(brush) as PaintBrush };
    if (update.seed !== undefined) {
      if (!Number.isInteger(update.seed) || update.seed < 0) throw new PaintEditorError(`seed ${update.seed} must be a whole number of 0 or more.`);
      next.seed = update.seed;
    }
    if (update.color !== undefined) {
      next.color = parseColor(update.color);
      delete next.paint;
    }
    if (update.paint !== undefined) {
      if (update.paint === null) delete next.paint;
      else if (isPaintEffectPaint(update.paint)) {
        const ep = update.paint.map?.by === 'path' ? withStrokePath(update.paint, next.points, this.effectPathControls.get(update.paint.effect)) : update.paint;
        if (!this.effectPaintImage(ep) && !this.renderEffectPaintSync(ep)) throw new PaintEditorError(`The effect "${update.paint.effect}" is not rendered yet; render it first (prepareEffectPaints; the update_stroke tool does this).`);
        next.paint = JSON.parse(JSON.stringify(ep));
      } else {
        const p = this.readStrokePaint(update.paint);
        if (p.type === 'color') {
          next.color = p.color;
          delete next.paint;
        } else next.paint = JSON.parse(JSON.stringify(p));
      }
    }
    // A Mixer Brush replays from its load: give it one that follows the stroke's own colour.
    const rgb = hexToRgb8(next.color).map((v) => v / 255) as [number, number, number];
    const load = brushLoadForStroke(brush, EMPTY_MIXER_LOAD, rgb);
    if (load.reservoir || load.pickup) next.load = load;
    else delete next.load;
    const list = strokes.map((x, i) => (i === index ? next : x));
    this.commitLiveStrokes('Edit stroke', layer, list, this.strokeAreas([was]));
    return { stroke: { ...next }, bounds: unionRect(this.strokeArea(was), this.strokeArea(next)) ?? { x: 0, y: 0, width: 0, height: 0 } };
  }

  /**
   * Replaces a live stroke's points, or moves, scales, rotates or flips them (`transform`, about
   * the stroke's centre unless an origin is given; the brush size scales too), and redraws its
   * layer (one undo step). Returns the stroke and the area that changed.
   */
  editStrokePoints(id: string, edit: { points?: readonly PenPoint[]; transform?: StrokeVariation }): { stroke: RecordedStroke; bounds: RasterRect } {
    this.requireIdle('editing a stroke');
    if ((edit.points === undefined) === (edit.transform === undefined)) throw new PaintEditorError('Pass either points (the new pen samples) or transform (dx, dy, scale, rotate, flipX), not both.');
    const { layer, strokes, index } = this.findLiveStroke(id);
    const was = strokes[index];
    let next: RecordedStroke;
    if (edit.points !== undefined) {
      const points = this.checkPoints(edit.points);
      // Wet strokes keep a clock per point; stroke layers hold none, so the points are free to change in number.
      next = { ...was, points: points.map((p) => ({ ...p })) };
      if (next.paint?.type === 'effect' && next.paint.map?.by === 'path') {
        next.paint = withStrokePath(next.paint, next.points, this.effectPathControls.get(next.paint.effect));
      }
    } else {
      next = varyStroke(was, this.strokeTransform(was, edit.transform!), {});
      if (was.stencils) next.stencils = was.stencils;
    }
    const list = strokes.map((x, i) => (i === index ? next : x));
    this.commitLiveStrokes('Edit stroke points', layer, list, this.strokeAreas([was]));
    return { stroke: { ...next }, bounds: unionRect(this.strokeArea(was), this.strokeArea(next)) ?? { x: 0, y: 0, width: 0, height: 0 } };
  }

  /** Deletes live strokes (one undo step). Returns the ids removed and the area that changed. */
  removeStrokes(ids: readonly string[]): { removed: string[]; bounds: RasterRect | null } {
    this.requireIdle('removing strokes');
    if (!ids.length) throw new PaintEditorError('Pass at least one stroke id (list_strokes {live: true}).');
    const found = ids.map((id) => this.findLiveStroke(id));
    let doc = this.doc;
    let bounds: RasterRect | null = null;
    const layers = new Map<string, PaintPixelLayer>();
    for (const f of found) layers.set(f.layer.id, f.layer);
    for (const [layerId, layer] of layers) {
      const gone = (doc.liveStrokes?.[layerId] ?? []).filter((x) => ids.includes(x.id));
      for (const x of gone) bounds = unionRect(bounds, this.strokeArea(x));
      doc = this.withLiveStrokes(doc, layer, (doc.liveStrokes?.[layerId] ?? []).filter((x) => !ids.includes(x.id)), this.strokeAreas(gone));
    }
    this.commit(ids.length === 1 ? 'Remove stroke' : 'Remove strokes', doc);
    return { removed: [...ids], bounds };
  }

  /** Moves a live stroke to `index` in its layer (0 = bottom) and redraws (one undo step). Returns the new order. */
  reorderStroke(id: string, index: number): string[] {
    this.requireIdle('reordering strokes');
    const { layer, strokes, index: from } = this.findLiveStroke(id);
    if (!Number.isInteger(index) || index < 0 || index >= strokes.length) throw new PaintEditorError(`index ${index} is out of range; the layer has ${strokes.length} strokes, so use 0..${strokes.length - 1} (0 = bottom).`);
    const list = [...strokes];
    const [moved] = list.splice(from, 1);
    list.splice(index, 0, moved);
    if (from !== index) this.commitLiveStrokes('Reorder stroke', layer, list, this.strokeAreas([moved]));
    return list.map((x) => x.id);
  }

  /** Turns a stroke layer into a plain pixel layer with the same pixels (one undo step). */
  rasterizeLiveStrokes(layerId?: string): PaintLayerInfo {
    this.requireIdle('rasterizing');
    const { layer } = this.liveStrokeLayer(layerId, 'rasterize');
    this.commit('Rasterize stroke layer', this.withPaintEvent({ ...this.doc, ...this.liveStrokesWithout([layer.id]) }, { kind: 'live-strokes', layerId: layer.id, data: { rasterized: true } }));
    return this.describeLayer(this.getLayer(layer.id)!);
  }

  /** Sets a layer's live strokes and redraws it (replays). `null` makes it a plain pixel layer. */
  replaceLiveStrokes(layerId: string, strokes: readonly RecordedStroke[] | null): void {
    const l = this.wetLayer(layerId, 'set the strokes of');
    if (strokes === null) {
      this.commit('Rasterize stroke layer', { ...this.doc, ...this.liveStrokesWithout([l.id]) });
      return;
    }
    this.commitLiveStrokes('Strokes', l, strokes.map((x) => ({ ...x, layerId: l.id })));
  }

  /**
   * The top-most stroke of a stroke layer (default the active layer) that painted the pixel at
   * (x, y) document pixels, or `null`. Strokes whose area holds the point are drawn alone, top
   * first, until one covers it.
   */
  liveStrokeAt(layerId: string | undefined, x: number, y: number): RecordedStroke | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new PaintEditorError('x and y must be numbers of document pixels.');
    const { layer, strokes } = this.liveStrokeLayer(layerId, 'pick a stroke on');
    const plain: PaintPixelLayer = { ...layer, visible: true, locks: undefined, offset: { x: 0, y: 0 } };
    const doc: PaintDocumentState = { ...this.doc, liveStrokes: undefined, stickers: undefined };
    const px = Math.floor(x);
    const py = Math.floor(y);
    for (let i = strokes.length - 1; i >= 0; i--) {
      const area = this.strokeArea(strokes[i]);
      if (!area || px < area.x || py < area.y || px >= area.x + area.width || py >= area.y + area.height) continue;
      const drawn = this.drawLiveStroke(doc, plain, emptySurface(4), strokes[i]).surface;
      if (readPixel(drawn, px, py)[3] > 24) return { ...strokes[i] };
    }
    return null;
  }

  /** Picks a stroke for the stroke panel and canvas (`null` for none). Editor state, not an undo step. */
  selectStroke(id: string | null): void {
    if (id === this.selectedStroke) return;
    this.selectedStroke = id;
    this.emit([]);
  }

  /** Where a live stroke painted (document pixels), or `null`. */
  liveStrokeArea(id: string): RasterRect | null {
    return this.strokeArea(this.findLiveStroke(id).strokes.find((s) => s.id === id)!);
  }

  /** Commits a layer's new stroke list with its redrawn pixels, recorded for replays (one undo step). */
  private commitLiveStrokes(label: string, layer: PaintPixelLayer, list: readonly RecordedStroke[], dirty?: RasterRect[] | null): void {
    this.commit(label, this.withLiveStrokes(this.doc, layer, list, dirty));
  }

  private withLiveStrokes(doc: PaintDocumentState, layer: PaintPixelLayer, list: readonly RecordedStroke[], dirty?: RasterRect[] | null): PaintDocumentState {
    if (isLayerLocked(layer, 'pixels')) throw new PaintEditorError(`Layer "${layer.name}" has its pixels locked; unlock it (update_layer locks) first.`);
    const current = findLayer(doc.layers, layer.id)?.layer as PaintPixelLayer | undefined;
    const hasFilm = list.some((s) => Boolean(s.brush.iridescence)) || Boolean(doc.thick?.[layer.id]);
    const surface = this.drawLiveStrokes(current ?? layer, list, hasFilm ? null : dirty);
    let thick = doc.thick;
    if (hasFilm) {
      const plain: PaintPixelLayer = { ...(current ?? layer), visible: true, locks: undefined, offset: { x: 0, y: 0 } };
      const plainDoc: PaintDocumentState = { ...doc, liveStrokes: undefined, stickers: undefined };
      let s = emptySurface(4);
      let ch: ThickChannels | null = list.some((st) => Boolean(st.brush.iridescence)) ? emptyThickChannels() : null;
      if (ch) {
        for (const st of list) {
          const step = this.drawLiveStroke(plainDoc, plain, s, st, ch);
          s = step.surface;
          ch = step.thick ?? ch;
        }
      }
      thick = withLayerThick(doc.thick, layer.id, ch);
    }
    const next = { ...doc, layers: mapLayer(doc.layers, layer.id, (l) => ({ ...(l as PaintPixelLayer), surface, offset: { x: 0, y: 0 } })), liveStrokes: { ...(doc.liveStrokes ?? {}), [layer.id]: [...list] }, ...(thick ? { thick } : {}) };
    return this.withPaintEvent(next, { kind: 'live-strokes', layerId: layer.id, data: { strokes: list.map((x) => JSON.parse(JSON.stringify(x))) } });
  }

  /** Where a stroke painted (document pixels): as learnt when it was painted or drawn, else an estimate from its points and brush. */
  private strokeArea(s: RecordedStroke): RasterRect | null {
    return this.paintedBounds.has(s) ? this.paintedBounds.get(s)! : liveStrokeBounds(s);
  }

  /** The areas strokes painted, or `null` when one is not known (a full redraw then). */
  private strokeAreas(strokes: readonly RecordedStroke[]): RasterRect[] | null {
    const out: RasterRect[] = [];
    for (const s of strokes) {
      if (!this.paintedBounds.has(s)) return null;
      const b = this.paintedBounds.get(s);
      if (b) out.push(b);
    }
    return out;
  }

  /** Draws one stroke onto `surface` of a plain copy of the layer; returns the result and the area it painted. */
  private drawLiveStroke(doc: PaintDocumentState, plain: PaintPixelLayer, surface: TiledSurface, st: RecordedStroke, thick?: ThickChannels): { surface: TiledSurface; bounds: RasterRect | null; thick?: ThickChannels } {
    let out = surface;
    let outThick = thick;
    const host: StrokeSessionHost = {
      update: () => {},
      commit: (s, drawn, cancelled) => {
        if (!cancelled && drawn) {
          out = drawn;
          outThick = s.thickChannels() ?? outThick;
        }
      },
    };
    const paint = st.paint && this.liveEffectAt !== null && isLiveEffect(st) ? framePaint(st.paint as PaintEffectPaint, this.liveEffectAt) : st.paint;
    const init: PaintStrokeInit = { layerId: plain.id, color: st.color, brush: st.brush, seed: st.seed, copies: (st.copies ?? []) as Affine[], ...(st.load ? { load: st.load } : {}), ...(paint ? { paint } : {}), snapToPerspective: false, stencils: false, maskStencils: st.stencils ?? [] };
    const session = this.sessionFor({ ...doc, layers: mapLayer(doc.layers, plain.id, () => ({ ...plain, surface })), ...(outThick ? { thick: { ...(doc.thick ?? {}), [plain.id]: outThick } } : {}) }, init, host);
    session.push(st.points);
    const result = session.end();
    // Only ever grown: a live effect's frames can paint more or less of a stroke (its alpha moves).
    const had = this.paintedBounds.get(st);
    this.paintedBounds.set(st, had && result.bounds ? unionRect(had, result.bounds) : (result.bounds ?? had ?? null));
    return { surface: out, bounds: result.bounds, thick: outThick };
  }

  /**
   * A stroke layer's pixels drawn from its strokes, bottom first. With `dirty` (the areas the old
   * strokes that changed had painted), only the tiles there and under any stroke whose area isn't
   * known yet are drawn again, from the strokes that reach them (a pixel depends only on the
   * strokes over it); the other tiles are kept. Without it, or with `null`, every stroke is drawn.
   */
  private drawLiveStrokes(layer: PaintPixelLayer, list: readonly RecordedStroke[], dirty?: RasterRect[] | null): TiledSurface {
    // Drawn on a copy of the layer as a visible, unlocked, plain layer at offset 0.
    const plain: PaintPixelLayer = { ...layer, visible: true, locks: undefined, offset: { x: 0, y: 0 } };
    const doc: PaintDocumentState = { ...this.doc, liveStrokes: undefined, stickers: undefined };
    const unknown = list.filter((s) => !this.paintedBounds.has(s));
    const partial = dirty && !layer.offset.x && !layer.offset.y && unknown.length <= 4;
    if (!partial) {
      let surface = emptySurface(4);
      for (const st of list) surface = this.drawLiveStroke(doc, plain, surface, st).surface;
      return surface;
    }
    // A stroke that is new here is drawn once alone to learn where it paints.
    const areas = [...dirty];
    for (const st of unknown) {
      const b = this.drawLiveStroke(doc, plain, emptySurface(4), st).bounds;
      if (b) areas.push(b);
    }
    const { width, height } = this.doc.canvas;
    const rects = areas.map((r) => clipRect(r, width, height)).filter((r): r is RasterRect => r !== null);
    if (!rects.length) return layer.surface;
    const overlaps = (a: RasterRect, b: RasterRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    let drawn = emptySurface(4);
    for (const st of list) {
      const b = this.paintedBounds.get(st);
      if (b && rects.some((r) => overlaps(r, b))) drawn = this.drawLiveStroke(doc, plain, drawn, st).surface;
    }
    // Only the changed areas are copied in; every other pixel is kept.
    let surface = layer.surface;
    for (const r of rects) surface = writeRegion(surface, r, readRegion(drawn, r));
    return surface;
  }

  // --- Live effect paint ------------------------------------------------------------

  /** The view's layers: stroke layers playing live effects at `effectTime`, the rest as they are. */
  private animatedView(): PaintLayer[] {
    if (!this.animatedLayers.size) return this.doc.layers;
    let layers = this.doc.layers;
    for (const [id, a] of this.animatedLayers) {
      const l = findLayer(layers, id)?.layer;
      if (isPixelLayer(l) && l.surface === a.base) layers = mapLayer(layers, id, () => ({ ...l, surface: a.surface }));
    }
    return layers;
  }

  /** Stroke layers with live effect strokes, and the distinct live sources (frame 0). */
  private liveEffects(doc: PaintDocumentState = this.doc): { layers: Array<{ layer: PaintPixelLayer; strokes: readonly RecordedStroke[] }>; sources: PaintEffectPaint[] } {
    const layers: Array<{ layer: PaintPixelLayer; strokes: readonly RecordedStroke[] }> = [];
    const sources = new Map<string, PaintEffectPaint>();
    for (const [id, strokes] of Object.entries(doc.liveStrokes ?? {})) {
      const layer = findLayer(doc.layers, id)?.layer;
      const live = strokes.filter(isLiveEffect);
      if (!isPixelLayer(layer) || !live.length) continue;
      layers.push({ layer, strokes });
      for (const st of live) sources.set(effectPaintKey(st.paint as PaintEffectPaint), st.paint as PaintEffectPaint);
    }
    return { layers, sources: [...sources.values()] };
  }

  /** What plays: the live effect strokes and their layers, or `null` when nothing does. */
  getAnimation(): { layerIds: string[]; strokes: number; sources: number } | null {
    const { layers, sources } = this.liveEffects();
    if (!layers.length) return null;
    return { layerIds: layers.map((x) => x.layer.id), strokes: layers.reduce((n, x) => n + x.strokes.filter(isLiveEffect).length, 0), sources: sources.length };
  }

  /** Plays or pauses live effect paint, and caps its frame rate (1..60); a setting left out keeps its value. Editor state, not an undo step. */
  setEffectPlayback(update: { playing?: boolean; fps?: number }): { playing: boolean; fps: number; time: number } {
    if (update.playing !== undefined && typeof update.playing !== 'boolean') throw new PaintEditorError('playing must be true or false.');
    if (update.fps !== undefined && !(Number.isInteger(update.fps) && update.fps >= 1 && update.fps <= 60)) throw new PaintEditorError(`fps ${update.fps} is out of range; use a whole number 1..60.`);
    // A setting the call leaves out (or passes as undefined, as the tool does) keeps its value.
    this.effectPlaybackState = { playing: update.playing ?? this.effectPlaybackState.playing, fps: update.fps ?? this.effectPlaybackState.fps };
    this.emit([]);
    return { ...this.effectPlaybackState, time: this.effectTime };
  }

  /** The surfaces of every stroke layer with live effects at `time` ms, drawn in full (frames rendered first). */
  private async liveSurfacesAt(time: number): Promise<Map<string, TiledSurface>> {
    const { layers, sources } = this.liveEffects();
    await this.prepareEffectPaints(sources.map((p) => framePaint(p, time)));
    const out = new Map<string, TiledSurface>();
    this.liveEffectAt = time;
    try {
      for (const { layer, strokes } of layers) out.set(layer.id, this.drawLiveStrokes({ ...layer, offset: { x: 0, y: 0 } }, strokes));
    } finally {
      this.liveEffectAt = null;
    }
    return out;
  }

  /**
   * Shows the live effects at `time` ms (each live stroke's effect at its own time plus `time`):
   * renders their frames, then redraws only where live effect strokes paint. Nothing in the
   * document changes. Resolves `false` when the document changed while frames rendered (the next
   * frame catches up).
   */
  async showEffectTime(time: number): Promise<boolean> {
    this.checkTime(time);
    const { layers, sources } = this.liveEffects();
    const revision = this.docRevision;
    await this.prepareEffectPaints(sources.map((p) => framePaint(p, time)));
    if (revision !== this.docRevision || this.session) return false;
    const next = new Map<string, { base: TiledSurface; surface: TiledSurface }>();
    const dirty: RasterRect[] = [];
    this.liveEffectAt = time;
    try {
      for (const { layer, strokes } of layers) {
        const shown = this.animatedLayers.get(layer.id);
        const from = shown && shown.base === layer.surface ? shown.surface : layer.surface;
        // Where live strokes may paint at any frame: what they painted, and their reach.
        const areas = strokes.filter(isLiveEffect).flatMap((st) => [liveStrokeBounds(st), ...(this.paintedBounds.get(st) ? [this.paintedBounds.get(st)!] : [])]);
        const surface = this.drawLiveStrokes({ ...layer, surface: from, offset: { x: 0, y: 0 } }, strokes, layer.offset.x || layer.offset.y ? null : areas);
        next.set(layer.id, { base: layer.surface, surface });
        dirty.push(...areas);
      }
    } finally {
      this.liveEffectAt = null;
    }
    this.animatedLayers = next;
    this.effectTime = time;
    this.emit(dirty);
    return true;
  }

  /**
   * Plays live effect paint in the view until `stop`: a frame per tick of `clock` (default
   * animation frames) at most `fps` a second, one render in flight. Idle while paused, while a
   * stroke is painted, or when nothing is live. The bindings start it while the editor is shown.
   */
  playEffects(clock: { now(): number; frame(cb: () => void): () => void } = defaultEffectClock): { stop(): void } {
    let stopped = false;
    let cancel = () => {};
    let last = -Infinity;
    let started = clock.now() - this.effectTime;
    const tick = () => {
      if (stopped) return;
      const now = clock.now();
      const { playing, fps } = this.effectPlaybackState;
      if (!playing) started = now - this.effectTime;
      if (!playing || this.session || now - last < 1000 / fps - 1 || !this.liveEffects().layers.length) {
        cancel = clock.frame(tick);
        return;
      }
      last = now;
      this.showEffectTime(Math.max(0, now - started)).then(
        () => {
          if (!stopped) cancel = clock.frame(tick);
        },
        () => {
          // A frame that could not render (no provider): try again on the next tick.
          if (!stopped) cancel = clock.frame(tick);
        }
      );
    };
    cancel = clock.frame(tick);
    return {
      stop() {
        stopped = true;
        cancel();
      },
    };
  }

  /**
   * Runs `fn` with the painting as it is `time` ms into its live effects (see `getAnimation`): for
   * exports at a moment. Nothing in the document changes.
   */
  async withEffectTime<T>(time: number, fn: () => T | Promise<T>): Promise<T> {
    this.checkTime(time);
    const surfaces = await this.liveSurfacesAt(time);
    const was = this.frameOverride;
    this.frameOverride = surfaces;
    try {
      return await fn();
    } finally {
      this.frameOverride = was;
    }
  }

  /** The painting composited `time` ms into its live effects, like `compositePixels`. Nothing in the document changes. */
  async renderAnimationFrame(time: number, options: RenderOptions = {}): Promise<PixelImage> {
    return this.withEffectTime(time, () => this.compositePixels(options));
  }

  // --- Stencils --------------------------------------------------------------------

  private stencilCache: { key: unknown; size: string; mask: { width: number; height: number; data: Uint8Array } | null } | null = null;
  private nextStencilId = 1;

  /** The mask stencils' coverage over the canvas (cached), or `null` when none masks. */
  private stencilSelection(stencils: readonly Stencil[] = this.guides.stencils): { width: number; height: number; data: Uint8Array } | null {
    const { width, height } = this.doc.canvas;
    const size = `${width}x${height}`;
    if (this.stencilCache?.key === stencils && this.stencilCache.size === size) return this.stencilCache.mask;
    const mask = stencilMask(stencils, width, height);
    this.stencilCache = { key: stencils, size, mask };
    return mask;
  }

  /** The stencils. */
  listStencils(): Stencil[] {
    return this.guides.stencils.map((s) => ({ ...s }));
  }

  /** Lays a stencil on the canvas (a ruler or arc to follow, a straight edge or shape to mask). Editor state saved with the document, not an undo step. */
  addStencil(input: StencilInput): Stencil {
    let stencil: Stencil;
    try {
      stencil = normalizeStencil(input, `stencil${this.nextStencilId++}`);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    this.setGuides({ ...this.guides, stencils: [...this.guides.stencils, stencil] });
    return { ...stencil };
  }

  private requireStencil(id: string): Stencil {
    const s = this.guides.stencils.find((x) => x.id === id);
    if (!s) throw new PaintEditorError(`Unknown stencil "${id}". Call get_guides for the stencil ids.`);
    return s;
  }

  /** Moves, reshapes, switches (guide / mask, invert) or hides a stencil. */
  updateStencil(id: string, update: Partial<Omit<Stencil, 'id' | 'kind'>>): Stencil {
    const base = this.requireStencil(id);
    let next: Stencil;
    try {
      next = normalizeStencil({ ...update, kind: base.kind }, id, base);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    this.setGuides({ ...this.guides, stencils: this.guides.stencils.map((x) => (x.id === id ? next : x)) });
    return { ...next };
  }

  /** Takes stencils away (`ids`, or all of them). Returns the ids removed. */
  removeStencils(ids?: readonly string[]): string[] {
    if (ids) for (const id of ids) this.requireStencil(id);
    const removed = ids ? [...ids] : this.guides.stencils.map((s) => s.id);
    this.setGuides({ ...this.guides, stencils: this.guides.stencils.filter((s) => !removed.includes(s.id)) });
    return removed;
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

  /** Adds a swatch: a colour, or a paint source (a gradient swatch holds its gradient). */
  addSwatch(color: string | PaintSource, name?: string): Swatch[] {
    this.swatches = [...this.swatches, this.makeSwatch(color, name)];
    this.emit([]);
    return this.swatches;
  }

  private makeSwatch(color: string | PaintSource, name?: string): Swatch {
    const p = typeof color === 'string' ? ({ type: 'color', color: parseColor(color) } as PaintSource) : this.readStrokePaint(color);
    const out: Swatch = { color: paintSourceColor(p, { paint: this.color, secondary: this.secondaryColor }) };
    if (name?.trim()) out.name = name.trim();
    if (p.type === 'gradient') out.paint = p;
    return out;
  }

  removeSwatch(index: number): Swatch[] {
    if (!Number.isInteger(index) || index < 0 || index >= this.swatches.length) throw new PaintEditorError(`index ${index} is out of range; there are ${this.swatches.length} swatches (0-based).`);
    this.swatches = this.swatches.filter((_, i) => i !== index);
    this.emit([]);
    return this.swatches;
  }

  setSwatches(swatches: readonly Swatch[]): Swatch[] {
    this.swatches = swatches.map((x) => this.makeSwatch(x.paint ?? x.color, x.name));
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

  // --- Mutation paint --------------------------------------------------------------

  /**
   * Hears each mutation once it has settled (`settle` seconds after the user's last mutation
   * stroke). Registering a listener marks an agent as connected (`state.hasMutationAgent`).
   */
  onMutationRequest(listener: PaintMutationRequestListener): () => void {
    const had = this.mutationListeners.size > 0;
    this.mutationListeners.add(listener);
    if (!had) this.emit([]);
    return () => {
      this.mutationListeners.delete(listener);
      if (this.mutationListeners.size === 0) this.emit([]);
    };
  }

  /** Marks whether a mutation-answering agent is connected (for hosts that wake agents via tools). */
  setMutationAgentConnected(connected: boolean): void {
    if (this.mutationAgentConnected === connected) return;
    this.mutationAgentConnected = connected;
    this.emit([]);
  }

  /** Attaches a `PaintDirector` so `answerMutation` and `readMutation` animate the agent's cursor. */
  setMutationDirector(director: PaintDirector | null): void {
    this.mutationDirector = director;
  }

  /** Lists pending mutations (or all mutations when `includeAll` is true). */
  listMutations(options: { includeAll?: boolean } = {}): PaintMutationInfo[] {
    const list = options.includeAll ? this.mutations : this.mutations.filter((m) => m.state === 'pending' || m.state === 'settling');
    return list.map((m) => this.toMutationInfo(m));
  }

  /** One mutation by id (`undefined` when unknown). */
  getMutation(id: string): PaintMutationInfo | undefined {
    const m = this.mutations.find((x) => x.id === id);
    return m ? this.toMutationInfo(m) : undefined;
  }

  /**
   * Claims a mutation (`id`) and starts its fade. Returns the strokes (points, colour, brush), a
   * PNG of the area around them (`cropPng`), and a preview of the whole painting (`canvasPng`) so
   * the agent can choose where to answer. Refused if already claimed, answered or declined.
   */
  readMutation(id: string, options: { actor?: string; padding?: number; maxSide?: number } = {}): PaintMutationReadResult {
    const m = this.mutations.find((x) => x.id === id);
    if (!m) throw new PaintEditorError(`Unknown mutation "${id}". Call list_mutations for the pending ids.`);
    if (m.state === 'claimed' || m.state === 'answered') {
      throw new PaintEditorError(`Mutation "${id}" has already been claimed${m.claimedBy ? ` by ${m.claimedBy}` : ''}.`);
    }
    if (m.state === 'declined') {
      throw new PaintEditorError(`Mutation "${id}" was already declined.`);
    }

    const { width, height } = this.doc.canvas;
    const pad = Math.max(0, Math.round(options.padding ?? 32));
    const baseRect = m.bounds ?? { x: 0, y: 0, width, height };
    const cropRect = clipRect(
      { x: baseRect.x - pad, y: baseRect.y - pad, width: baseRect.width + pad * 2, height: baseRect.height + pad * 2 },
      width,
      height
    ) ?? { x: 0, y: 0, width, height };

    // Capture the crop and canvas preview before the fade begins so the agent sees the full strokes.
    const full = this.compositePixels({ wet: 'display' });
    const cropData = new Uint8ClampedArray(cropRect.width * cropRect.height * 4);
    for (let y = 0; y < cropRect.height; y++) {
      const srcRow = ((cropRect.y + y) * width + cropRect.x) * 4;
      cropData.set(full.data.subarray(srcRow, srcRow + cropRect.width * 4), y * cropRect.width * 4);
    }
    const cropPngBase64 = bytesToBase64(encodePng(cropRect.width, cropRect.height, cropData));
    const preview = this.renderPreview({ wet: 'display', maxSide: options.maxSide ?? 512 });
    const canvasPngBase64 = bytesToBase64(encodePng(preview.width, preview.height, preview.data));

    const actorId = options.actor ?? (this.getOrigin() !== 'user' ? this.getOrigin() : 'agent');
    m.state = 'claimed';
    m.claimedBy = actorId;
    m.fadeRemaining = m.fade;

    if (m.medium === 'wet') {
      this.releaseMutationEvaporation(m.layerId);
      this.wet.releaseGhost(m.layerId, m.fade);
      this.recordWetSetting({ kind: 'ghost-release', layerId: m.layerId, data: { linger: m.fade } });
    }

    if (this.mutationDirector && m.bounds) {
      const pid = actorId.replace(/^agent:/, '') || 'mutation-agent';
      this.mutationDirector.presence.set({
        id: pid,
        name: 'Agent',
        color: '#7c3aed',
        x: m.bounds.x + m.bounds.width / 2,
        y: m.bounds.y + m.bounds.height / 2,
        message: 'Reading…',
      });
    }

    this.emit([]);
    return {
      id: m.id,
      state: 'claimed',
      layerId: m.layerId,
      medium: m.medium,
      bounds: m.bounds ? { ...m.bounds } : null,
      fade: m.fade,
      strokes: m.strokes.map((s) => ({
        ...s,
        points: s.points.map((p) => ({ ...p })),
        bounds: s.bounds ? { ...s.bounds } : null,
      })),
      cropPng: {
        width: cropRect.width,
        height: cropRect.height,
        rect: cropRect,
        data: cropPngBase64,
      },
      canvasPng: {
        width: preview.width,
        height: preview.height,
        data: canvasPngBase64,
      },
    };
  }

  /**
   * Paints the agent's answer to a claimed mutation (`id`). When a `PaintDirector` is attached (or
   * passed in `options`), the agent's cursor is seen painting live; all strokes commit as one undo
   * step with origin `agent:<id>`. A second answer to the same id is refused.
   */
  async answerMutation(
    id: string,
    input: PaintMutationAnswerInput,
    options: { director?: PaintDirector; actor?: PresenceActorInfo } = {}
  ): Promise<PaintMutationAnswerResult> {
    const m = this.mutations.find((x) => x.id === id);
    if (!m) throw new PaintEditorError(`Unknown mutation "${id}". Call list_mutations for the pending ids.`);
    if (m.state === 'answered') throw new PaintEditorError(`Mutation "${id}" has already been answered.`);
    if (m.state === 'declined') throw new PaintEditorError(`Mutation "${id}" was declined and cannot be answered.`);
    if (m.state !== 'claimed') throw new PaintEditorError(`Mutation "${id}" has not been claimed yet; call read_mutation("${id}") first.`);
    if (!Array.isArray(input?.strokes) || !input.strokes.length) {
      throw new PaintEditorError('strokes is empty; give at least one stroke with points.');
    }

    const targetLayerId = input.layerId ?? m.layerId;
    this.paintTarget(targetLayerId, 'paint on');

    const cleanedStrokes = input.strokes.map((s) => {
      const pts = this.checkPoints(s.points);
      const layerId = s.layerId ?? targetLayerId;
      this.paintTarget(layerId, 'paint on');
      const baseBrush = s.brushId !== undefined ? this.requireBrush(s.brushId) : this.brush;
      const stripAutoGhost = baseBrush.ghost?.trigger === 'agent' && !s.brush?.ghost;
      const brushPatch: PaintBrushInput = {
        ...(s.brush ?? {}),
        mutation: null,
        ...(stripAutoGhost ? { ghost: null } : {}),
      };
      return {
        ...s,
        layerId,
        brush: brushPatch,
        points: pts,
      };
    });

    m.state = 'answered';
    try {
      for (const s of cleanedStrokes) {
        await this.prepareStrokePathEffect(s, [s.points]);
      }
    } catch (e) {
      m.state = 'claimed';
      throw e;
    }

    const rawActorId = (options.actor?.id ?? m.claimedBy ?? 'mutation-agent').replace(/^agent:/, '') || 'mutation-agent';
    const actor: PresenceActorInfo = options.actor ?? {
      id: rawActorId,
      name: 'Agent',
      color: '#7c3aed',
    };
    const origin = this.getOrigin() !== 'user' ? this.getOrigin() : `agent:${actor.id}`;
    const director = options.director ?? this.mutationDirector;

    if (director) {
      const perf = await this.withOrigin(origin, async () => {
        this.answeringMutation = true;
        try {
          return await director.perform(
            actor,
            [{ kind: 'strokes', strokes: cleanedStrokes, label: 'Mutation answer', ...(input.note ? { note: input.note } : {}) }],
            { key: m.id }
          );
        } finally {
          this.answeringMutation = false;
        }
      });
      const first = perf[0];
      if (!first || !first.ok) {
        m.state = 'claimed';
        throw new PaintEditorError(first ? first.message : 'The mutation answer failed.');
      }
      const res = first.result as PaintStrokesResult;
      m.answerStrokeIds = [...res.strokeIds];
      this.cached = null;
      this.emit([]);
      return {
        id: m.id,
        state: 'answered',
        layerId: res.layerId,
        strokeIds: res.strokeIds,
        bounds: res.bounds,
        dabs: res.dabs,
        ...(res.wet !== undefined ? { wet: res.wet } : {}),
      };
    }

    return this.withOrigin(origin, () => {
      this.answeringMutation = true;
      try {
        return this.group('Mutation answer', () => {
          let bounds: RasterRect | null = null;
          let dabs = 0;
          const strokeIds: string[] = [];
          let wet: boolean | undefined;
          for (const s of cleanedStrokes) {
            const r = this.paintStroke(s);
            bounds = unionRect(bounds, r.bounds);
            dabs += r.dabs;
            if (r.strokeId) strokeIds.push(r.strokeId);
            if (r.wet !== undefined) wet = r.wet;
          }
          m.answerStrokeIds = [...strokeIds];
          this.cached = null;
          return {
            id: m.id,
            state: 'answered' as const,
            layerId: targetLayerId,
            strokeIds,
            bounds,
            dabs,
            ...(wet !== undefined ? { wet } : {}),
          };
        });
      } catch (e) {
        m.state = 'claimed';
        throw e;
      } finally {
        this.answeringMutation = false;
      }
    });
  }

  /**
   * Gives up on a mutation (`id`) without answering. The user's paint stays as ordinary paint (wet
   * strokes stay in the wet layer, and dry temporary layers merge down into their target layer).
   */
  declineMutation(id: string, reason?: string): PaintMutationInfo {
    const m = this.mutations.find((x) => x.id === id);
    if (!m) throw new PaintEditorError(`Unknown mutation "${id}". Call list_mutations for the pending ids.`);
    if (m.state === 'answered') throw new PaintEditorError(`Mutation "${id}" has already been answered.`);
    if (m.state === 'declined') return this.toMutationInfo(m);
    m.state = 'declined';
    if (reason?.trim()) m.declineReason = reason.trim();
    this.keepMutationPaint(m);
    if (this.mutationDirector && m.claimedBy) {
      this.mutationDirector.presence.remove(m.claimedBy.replace(/^agent:/, '') || 'mutation-agent');
    }
    this.emit();
    return this.toMutationInfo(m);
  }

  /**
   * Advances mutation timers (`settle`, `patience`, and dry temporary-layer `fade`) by `seconds`
   * of simulated time. Called automatically from `tickMutations` and `advanceWet`.
   */
  advanceMutations(seconds: number): void {
    if (!(seconds > 0) || !this.mutations.length) return;
    let changed = false;
    let dirty: RasterRect[] | 'all' = [];
    for (const m of [...this.mutations]) {
      const wasState = m.state;
      if (wasState === 'settling' || wasState === 'pending' || wasState === 'claimed') {
        m.age += seconds;
        changed = true;
      }
      if (wasState === 'settling') {
        m.sinceLastStroke += seconds;
        if (m.sinceLastStroke >= m.settle - 1e-9) {
          m.state = 'pending';
          m.sincePending = Math.max(0, m.sinceLastStroke - m.settle);
          const info = this.toMutationInfo(m);
          for (const listener of [...this.mutationListeners]) {
            listener(info);
          }
          if (m.state === 'pending' && m.sincePending >= m.patience - 1e-9) {
            this.expireMutation(m);
            dirty = 'all';
          }
        }
      } else if (wasState === 'pending') {
        m.sincePending += seconds;
        if (m.sincePending >= m.patience - 1e-9) {
          this.expireMutation(m);
          dirty = 'all';
        }
      } else if (wasState === 'claimed' || wasState === 'answered') {
        if (m.medium === 'dry' && m.tempLayerId) {
          changed = true;
          m.fadeRemaining = Math.max(0, m.fadeRemaining - seconds);
          if (m.fadeRemaining <= 1e-9) {
            this.removeTempMutationLayer(m);
            dirty = 'all';
          } else {
            const opacity = m.fade > 0 ? Math.max(0, Math.min(1, m.fadeRemaining / m.fade)) : 0;
            const tempId = m.tempLayerId;
            if (findLayer(this.doc.layers, tempId)) {
              this.doc = { ...this.doc, layers: mapLayer(this.doc.layers, tempId, (l) => ({ ...l, opacity })) };
              dirty = 'all';
            }
          }
        }
      }
    }
    if (changed) {
      this.cached = null;
      this.emit(dirty);
    }
  }

  /** Steps mutation timers with the wall clock (`performance.now()`, in ms). */
  tickMutations(now: number): void {
    if (!Number.isFinite(now)) return;
    if (this.lastMutationTick === null) {
      this.lastMutationTick = now;
      return;
    }
    const dt = Math.max(0, Math.min(1, (now - this.lastMutationTick) / 1000));
    this.lastMutationTick = now;
    if (dt > 0 && !this.session) {
      this.advanceMutations(dt);
    }
  }

  private toMutationInfo(m: MutationEntry): PaintMutationInfo {
    return {
      id: m.id,
      state: m.state,
      layerId: m.layerId,
      medium: m.medium,
      bounds: m.bounds ? { ...m.bounds } : null,
      strokeCount: m.strokes.length,
      age: Math.round(m.age * 100) / 100,
      settle: m.settle,
      patience: m.patience,
      fade: m.fade,
      ...(m.claimedBy ? { claimedBy: m.claimedBy } : {}),
      ...(m.answerStrokeIds ? { answerStrokeIds: [...m.answerStrokeIds] } : {}),
      ...(m.declineReason ? { declineReason: m.declineReason } : {}),
    };
  }

  private recordMutationStroke(stroke: RecordedStroke, bounds: RasterRect | null): void {
    const mut = stroke.brush.mutation;
    if (!mut || this.answeringMutation || this.previewing || this.getOrigin().startsWith('agent:')) return;
    const medium: PaintMutationMedium = isWetBrush(stroke.brush) ? 'wet' : 'dry';
    const tempLayerId = medium === 'dry' && this.tempLayerTargets.has(stroke.layerId) ? stroke.layerId : undefined;
    const targetLayerId = tempLayerId ? this.tempLayerTargets.get(tempLayerId)! : stroke.layerId;

    let entry = this.mutations.find((m) => m.state === 'settling' && m.layerId === targetLayerId && m.medium === medium);
    if (!entry) {
      entry = {
        id: `m${this.nextMutationId++}`,
        state: 'settling',
        layerId: targetLayerId,
        ...(tempLayerId ? { tempLayerId } : {}),
        medium,
        strokes: [],
        bounds: null,
        settle: mut.settle,
        patience: mut.patience,
        fade: mut.fade,
        age: 0,
        sinceLastStroke: 0,
        sincePending: 0,
        fadeRemaining: mut.fade,
      };
      this.mutations.push(entry);
      if (medium === 'wet') this.holdMutationEvaporation(targetLayerId);
    } else {
      entry.settle = mut.settle;
      entry.patience = mut.patience;
      entry.fade = mut.fade;
      entry.fadeRemaining = mut.fade;
      entry.sinceLastStroke = 0;
      if (tempLayerId && !entry.tempLayerId) entry.tempLayerId = tempLayerId;
    }

    const strokeRect = bounds ?? strokeBounds(stroke.points);
    entry.strokes.push({
      id: stroke.id,
      color: stroke.color,
      brushId: stroke.brush.id,
      brushName: stroke.brush.name,
      size: stroke.brush.tip.size,
      points: stroke.points.map((p) => ({ ...p })),
      bounds: strokeRect ? { ...strokeRect } : null,
    });
    entry.bounds = unionRect(entry.bounds, strokeRect);
    this.cached = null;
  }

  private holdMutationEvaporation(layerId: string): void {
    if (this.heldEvaporation.has(layerId)) return;
    const currentEvap = (this.wet.settings.get(layerId)?.params ?? this.wet.info(layerId).params).evaporation;
    this.heldEvaporation.set(layerId, currentEvap);
    this.wet.setParams(layerId, { evaporation: 0 });
  }

  private releaseMutationEvaporation(layerId: string): void {
    const stillWaiting = this.mutations.some(
      (m) => m.medium === 'wet' && m.layerId === layerId && (m.state === 'settling' || m.state === 'pending')
    );
    if (stillWaiting) return;
    const saved = this.heldEvaporation.get(layerId);
    if (saved === undefined) return;
    this.heldEvaporation.delete(layerId);
    if (findLayer(this.doc.layers, layerId)) {
      this.wet.setParams(layerId, { evaporation: saved });
    }
  }

  private finishWetMutationsOnDry(layerId: string): void {
    for (const m of this.mutations) {
      if (m.medium === 'wet' && m.layerId === layerId && (m.state === 'settling' || m.state === 'pending')) {
        m.state = 'declined';
        m.declineReason = 'Dried before an agent claimed it.';
      }
    }
    this.releaseMutationEvaporation(layerId);
  }

  private expireMutation(m: MutationEntry): void {
    m.state = 'declined';
    m.declineReason = 'No agent answered before patience ran out.';
    this.keepMutationPaint(m);
  }

  private keepMutationPaint(m: MutationEntry): void {
    if (m.medium === 'wet') {
      this.releaseMutationEvaporation(m.layerId);
      this.wet.keepGhost(m.layerId);
      this.recordWetSetting({ kind: 'ghost-keep', layerId: m.layerId });
      return;
    }
    const tempId = m.tempLayerId;
    if (!tempId) return;
    m.tempLayerId = undefined;
    this.tempLayerTargets.delete(tempId);
    if (!findLayer(this.doc.layers, tempId)) return;

    this.doc = this.mergeTempLayerIntoTarget(this.doc, tempId, m.layerId);
    // Update history entries that hold this temporary layer so undoing the unanswered mutation is one step.
    for (const e of this.undoStack) {
      if (findLayer(e.before.layers, tempId)) e.before = this.mergeTempLayerIntoTarget(e.before, tempId, m.layerId);
      if (findLayer(e.after.layers, tempId)) e.after = this.mergeTempLayerIntoTarget(e.after, tempId, m.layerId);
    }
    // Collapse consecutive undo steps belonging to this multi-stroke mutation into a single undo step.
    while (
      this.undoStack.length >= 2 &&
      !findLayer(this.undoStack[this.undoStack.length - 2]!.before.layers, tempId) &&
      this.undoStack[this.undoStack.length - 1]!.before.strokes.some((s) => m.strokes.some((ms) => ms.id === s.id)) &&
      this.undoStack[this.undoStack.length - 2]!.after.strokes.some((s) => m.strokes.some((ms) => ms.id === s.id))
    ) {
      const top = this.undoStack.pop()!;
      const prev = this.undoStack[this.undoStack.length - 1]!;
      prev.after = top.after;
    }
  }

  private mergeTempLayerIntoTarget(doc: PaintDocumentState, tempLayerId: string, targetLayerId: string): PaintDocumentState {
    const upper = findLayer(doc.layers, tempLayerId)?.layer;
    const below = findLayer(doc.layers, targetLayerId)?.layer;
    if (!isPixelLayer(upper)) return doc;
    if (!isPixelLayer(below)) {
      return {
        ...doc,
        layers: mapLayer(doc.layers, tempLayerId, () => null),
        strokes: doc.strokes.filter((s) => s.layerId !== tempLayerId),
      };
    }
    const rect = unionRect(this.describeLayer(below).bounds, this.describeLayer(upper).bounds);
    let surface = below.surface;
    let offset = below.offset;
    if (rect) {
      const base: PaintPixelLayer = { ...below, opacity: 1, blend: 'normal', visible: true, clipped: undefined, mask: undefined };
      const top: PaintPixelLayer = { ...upper, opacity: 1, visible: true };
      const px = createPaintCompositor().composite([base, top] as ViewLayer[], rect, this.sources());
      surface = surfaceFromPixels({ width: rect.width, height: rect.height, data: px }, 4, rect.x, rect.y);
      offset = { x: 0, y: 0 };
    }
    const merged: PaintPixelLayer = { ...below, surface, offset };
    const layers = mapLayer(mapLayer(doc.layers, upper.id, () => null), below.id, () => merged);
    const strokes = doc.strokes.map((s) => (s.layerId === tempLayerId ? { ...s, layerId: targetLayerId } : s));
    return { ...doc, layers, strokes };
  }

  private removeTempMutationLayer(m: MutationEntry): void {
    const tempId = m.tempLayerId;
    if (!tempId) return;
    m.tempLayerId = undefined;
    this.tempLayerTargets.delete(tempId);
    const strip = (d: PaintDocumentState): PaintDocumentState => {
      if (!findLayer(d.layers, tempId) && !d.strokes.some((s) => s.layerId === tempId)) return d;
      return {
        ...d,
        layers: mapLayer(d.layers, tempId, () => null),
        strokes: d.strokes.filter((s) => s.layerId !== tempId),
      };
    };
    this.doc = strip(this.doc);
    // Strip the faded temporary layer from subsequent undo steps (e.g. the agent's answer step) so
    // undoing the agent's answer doesn't resurrect a half-faded temporary layer.
    const mutStrokeIds = new Set(m.strokes.map((s) => s.id));
    for (const e of this.undoStack) {
      const isMutationCreationStep =
        !e.before.strokes.some((s) => mutStrokeIds.has(s.id)) && e.after.strokes.some((s) => mutStrokeIds.has(s.id));
      if (!isMutationCreationStep) {
        e.before = strip(e.before);
        e.after = strip(e.after);
      }
    }
  }

  private reconcileMutationsAfterUndo(): void {
    if (!this.mutations.length) return;
    const remainingIds = new Set(this.doc.strokes.map((s) => s.id));
    const kept: MutationEntry[] = [];
    for (const m of this.mutations) {
      m.strokes = m.strokes.filter((s) => remainingIds.has(s.id));
      if (m.strokes.length === 0) {
        this.mutationDirector?.cancel(m.id);
        if (m.claimedBy && this.mutationDirector) {
          this.mutationDirector.presence.remove(m.claimedBy.replace(/^agent:/, '') || 'mutation-agent');
        }
        if (m.tempLayerId) {
          const tempId = m.tempLayerId;
          this.tempLayerTargets.delete(tempId);
          if (findLayer(this.doc.layers, tempId)) {
            this.doc = {
              ...this.doc,
              layers: mapLayer(this.doc.layers, tempId, () => null),
              strokes: this.doc.strokes.filter((s) => s.layerId !== tempId),
            };
          }
        }
        if (m.medium === 'wet') {
          this.releaseMutationEvaporation(m.layerId);
        }
      } else {
        m.bounds = m.strokes.reduce<RasterRect | null>((acc, s) => unionRect(acc, s.bounds), null);
        kept.push(m);
      }
    }
    this.mutations = kept;
  }

  private resetMutations(): void {
    for (const m of this.mutations) {
      this.mutationDirector?.cancel(m.id);
    }
    this.mutations = [];
    this.heldEvaporation.clear();
    this.tempLayerTargets.clear();
    this.lastMutationTick = null;
  }

  /** A layer's tile surface (live while stroking), for thumbnails. */
  layerSurface(id: string): TiledSurface | null {
    const l = findLayer(this.currentLayers(), id)?.layer;
    return isPixelLayer(l) ? l.surface : null;
  }

  // --- Proposals and evolutionary strokes ------------------------------------------

  private proposalsStore: PaintProposals | null = null;

  /** The pending paint proposals store attached to this editor (created on demand). */
  get proposals(): PaintProposals {
    return (this.proposalsStore ??= createPaintProposals({ controller: this }));
  }

  /** Attaches an external `PaintProposals` store so tools and panels share it. */
  attachProposals(store: PaintProposals): void {
    this.proposalsStore = store;
  }

  /**
   * Breeds `count` (`2..12`, default `4`) mutated variants from `1..16` recorded strokes as
   * pending paint proposals, generated one after another through `previewPaint`.
   */
  breedStrokes(options: {
    strokeIds: readonly string[];
    count?: number;
    mutation?: StrokeMutationRates;
    seed?: number;
    origin?: string;
  }): BreedStrokesResult {
    const { strokeIds } = options;
    if (!Array.isArray(strokeIds) || strokeIds.length < 1 || strokeIds.length > 16) {
      throw new PaintEditorError(`strokeIds must have 1..16 stroke ids (got ${strokeIds?.length ?? 0}); call list_strokes for the ids.`);
    }
    const count = options.count ?? 4;
    if (!Number.isInteger(count) || count < 2 || count > 12) {
      throw new PaintEditorError(`count ${count} is out of range; use a whole number in 2..12.`);
    }
    const seed = options.seed ?? 1;
    if (!Number.isInteger(seed) || seed < 0) {
      throw new PaintEditorError(`seed ${seed} must be a whole number of 0 or more.`);
    }
    let rates;
    try {
      rates = normalizeMutationRates(options.mutation);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    const liveAll = Object.values(this.doc.liveStrokes ?? {}).flat();
    const byId = new Map<string, RecordedStroke>();
    for (const s of this.doc.strokes) byId.set(s.id, s);
    for (const s of liveAll) byId.set(s.id, s);
    const parents = strokeIds.map((id) => {
      const s = byId.get(id);
      if (!s) throw new PaintEditorError(`Unknown stroke "${id}". Call list_strokes for the ids.`);
      const refusal = liveStrokeRefusal(s.brush);
      if (refusal) throw new PaintEditorError(refusal);
      return s;
    });
    const proposals: BredProposalSummary[] = [];
    for (let i = 0; i < count; i++) {
      const variantSeed = (seed + i * 7919) | 0;
      const children = mutateGenome(parents, rates, variantSeed);
      const { diff, changes } = describeGenomeDiff(parents, children);
      const prop = this.proposals.propose({
        title: `Variant ${i + 1}`,
        rationale: diff,
        ...(options.origin ? { origin: options.origin } : {}),
        ops: [{ kind: 'strokes', strokes: children }],
      });
      proposals.push({
        proposalId: prop.id,
        title: prop.title,
        seed: variantSeed,
        bounds: prop.bounds,
        diff,
        changes,
      });
    }
    return { proposalIds: proposals.map((p) => p.proposalId), proposals };
  }

  /**
   * Breeds `count` (`2..12`, default `4`) variants from `1` pending proposal (mutation) or `2`
   * pending proposals (crossover + mutation), generated one after another through `previewPaint`.
   */
  breedProposal(options: {
    proposalIds: readonly string[];
    count?: number;
    mutation?: StrokeMutationRates;
    seed?: number;
    origin?: string;
  }): BreedStrokesResult {
    const { proposalIds } = options;
    if (!Array.isArray(proposalIds) || proposalIds.length < 1 || proposalIds.length > 2) {
      throw new PaintEditorError(`proposalIds must have 1 or 2 proposal ids (1 to mutate, 2 to cross over; got ${proposalIds?.length ?? 0}); call list_paint_proposals for the ids.`);
    }
    const count = options.count ?? 4;
    if (!Number.isInteger(count) || count < 2 || count > 12) {
      throw new PaintEditorError(`count ${count} is out of range; use a whole number in 2..12.`);
    }
    const seed = options.seed ?? 1;
    if (!Number.isInteger(seed) || seed < 0) {
      throw new PaintEditorError(`seed ${seed} must be a whole number of 0 or more.`);
    }
    let rates;
    try {
      rates = normalizeMutationRates(options.mutation);
    } catch (e) {
      throw new PaintEditorError((e as Error).message);
    }
    const parentProps = proposalIds.map((id) => {
      const p = this.proposals.get(id);
      if (!p) throw new PaintEditorError(`No pending paint proposal "${id}". Call list_paint_proposals for the ids.`);
      return p;
    });
    const parentGenomes = parentProps.map((p) => {
      const strokes = proposalGenomeStrokes(this, p);
      if (!strokes.length) throw new PaintEditorError(`Proposal "${p.id}" has no stroke genome to breed from.`);
      for (const s of strokes) {
        const refusal = liveStrokeRefusal(s.brush);
        if (refusal) throw new PaintEditorError(refusal);
      }
      return strokes;
    });
    const isCrossover = parentGenomes.length === 2;
    const proposals: BredProposalSummary[] = [];
    for (let i = 0; i < count; i++) {
      const variantSeed = (seed + i * 7919) | 0;
      const children = isCrossover
        ? crossoverGenomes(parentGenomes[0]!, parentGenomes[1]!, rates, variantSeed)
        : mutateGenome(parentGenomes[0]!, rates, variantSeed);
      const { diff, changes } = describeGenomeDiff(parentGenomes[0]!, children, { crossover: isCrossover });
      const title = isCrossover
        ? `Crossover ${i + 1} (${parentProps[0]!.id} × ${parentProps[1]!.id})`
        : `Variant ${i + 1} of ${parentProps[0]!.id}`;
      const prop = this.proposals.propose({
        title,
        rationale: diff,
        ...(options.origin ? { origin: options.origin } : {}),
        ops: [{ kind: 'strokes', strokes: children }],
      });
      proposals.push({
        proposalId: prop.id,
        title: prop.title,
        seed: variantSeed,
        bounds: prop.bounds,
        diff,
        changes,
      });
    }
    return { proposalIds: proposals.map((p) => p.proposalId), proposals };
  }

  /** Returns the full stroke genome records (`RecordedStrokeJSON[]`) of a pending paint proposal. */
  getProposalGenome(proposalId: string): ProposalGenomeResult {
    const p = this.proposals.get(proposalId);
    if (!p) throw new PaintEditorError(`No pending paint proposal "${proposalId}". Call list_paint_proposals for the ids.`);
    const strokes = proposalGenomeStrokes(this, p);
    if (!strokes.length) throw new PaintEditorError(`Proposal "${proposalId}" has no stroke genome.`);
    return {
      proposalId: p.id,
      title: p.title,
      bounds: p.bounds,
      strokes: strokes.map(strokeToJSON),
    };
  }
}

export type { Tile };

/** Largest tracing or reference image side, in pixels. */
export const MAX_IMAGE_SIDE = 8192;

const movePoint = (p: { x: number; y: number }, dx: number, dy: number) => ({ x: p.x + dx, y: p.y + dy });
const moveRect = <R extends { x: number; y: number }>(r: R, dx: number, dy: number): R => ({ ...r, x: r.x + dx, y: r.y + dy });

/** The id suffix of a layer's spill pass in the compositor (and PSD export). */
const SPILL_SUFFIX = '::light';
const UV_SPILL_SUFFIX = '::uv';

/** The document's light with one layer's set (removed when it is empty), or the same map when `next` is `null`. */
function withLayerLight(light: PaintDocumentState['light'], layerId: string, next: TiledSurface | null): Record<string, TiledSurface> | undefined {
  if (!next) return light ? { ...light } : undefined;
  const out = { ...(light ?? {}) };
  if (next.tiles.size) out[layerId] = next;
  else delete out[layerId];
  return out;
}

/** The document's thick channels with one layer's set (removed when it is empty), or the same map when `next` is `null`. */
function withLayerThick(thick: PaintDocumentState['thick'], layerId: string, next: ThickChannels | null): Record<string, ThickChannels> | undefined {
  if (!next) return thick ? { ...thick } : undefined;
  const out = { ...(thick ?? {}) };
  if (hasThickChannels(next)) out[layerId] = next;
  else delete out[layerId];
  return out;
}

/** The id of backlit paper's light layer in renders and PSD exports (never a document layer). */
const BACKLIGHT_LAYER_ID = '__backlight';

/** `layers` with `node` inserted directly above layer `id`, in the same group. */
function insertAfter(layers: PaintLayer[], id: string, node: PaintLayer): PaintLayer[] {
  const i = layers.findIndex((l) => l.id === id);
  if (i >= 0) return [...layers.slice(0, i + 1), node, ...layers.slice(i + 1)];
  return layers.map((l) => (l.type === 'group' ? { ...l, children: insertAfter(l.children, id, node) } : l));
}

/** Whether a stroke plays a live effect (its paint is effect paint with `live`). */
function isLiveEffect(s: RecordedStroke): boolean {
  return s.paint?.type === 'effect' && (s.paint as PaintEffectPaint).live === true;
}

/** An effect paint's frame `t` ms on from its own time. */
function framePaint(p: PaintEffectPaint, t: number): PaintEffectPaint {
  return { ...p, time: p.time + t };
}

/** The most live effects (distinct sources) a document plays at once: each needs a renderer. */
export const MAX_LIVE_EFFECT_SOURCES = 8;

const defaultEffectClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  frame: (cb: () => void): (() => void) => {
    if (typeof requestAnimationFrame === 'undefined') {
      const t = setTimeout(cb, 16);
      return () => clearTimeout(t);
    }
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  },
};

/** `r` cut to the canvas, or `null` when nothing of it is on the canvas. */
function clipRect(r: RasterRect, width: number, height: number): RasterRect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(width, Math.ceil(r.x + r.width));
  const y1 = Math.min(height, Math.ceil(r.y + r.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The document with `stroke` added to its layer's live strokes, when that is a live stroke layer. */
function withLiveStroke(doc: PaintDocumentState, stroke: RecordedStroke): PaintDocumentState {
  const list = doc.liveStrokes?.[stroke.layerId];
  return list ? { ...doc, liveStrokes: { ...doc.liveStrokes, [stroke.layerId]: [...list, stroke] } } : doc;
}

/**
 * The document with its content moved by (dx, dy) document pixels (`extendCanvas`): layer offsets
 * (masks and relief are in layer space and follow), sticker positions, the paper grain, the effect
 * paper, the origin, and the recorded strokes and events, so a replay paints the same picture.
 */
function shiftDocument(doc: PaintDocumentState, dx: number, dy: number): PaintDocumentState {
  if (!dx && !dy) return doc;
  let layers = doc.layers;
  for (const l of flattenLayers(doc.layers)) if (l.type === 'pixel') layers = mapLayer(layers, l.id, () => ({ ...l, offset: movePoint(l.offset, dx, dy) }));
  const m: Affine = [1, 0, 0, 1, dx, dy];
  // Stickers keep positions to 0.01 px, as sprayed.
  const moveStickers = (list: readonly Sticker[]) => list.map((s) => ({ ...s, x: Math.round((s.x + dx) * 100) / 100, y: Math.round((s.y + dy) * 100) / 100 }));
  const out: PaintDocumentState = {
    ...doc,
    layers,
    paper: { ...doc.paper, offset: movePoint(doc.paper.offset ?? { x: 0, y: 0 }, dx, dy) },
    origin: movePoint(doc.origin ?? { x: 0, y: 0 }, -dx, -dy),
    strokes: doc.strokes.map((s) => {
      const moved = varyStroke(s, m, {});
      return s.stencils ? { ...moved, stencils: s.stencils.map((x) => translateStencil(x, dx, dy)) } : moved;
    }),
  };
  const moveStroke = (s: RecordedStroke) => {
    const moved = varyStroke(s, m, {});
    return s.stencils ? { ...moved, stencils: s.stencils.map((x) => translateStencil(x, dx, dy)) } : moved;
  };
  if (doc.stickers) out.stickers = Object.fromEntries(Object.entries(doc.stickers).map(([id, list]) => [id, moveStickers(list)]));
  if (doc.liveStrokes) out.liveStrokes = Object.fromEntries(Object.entries(doc.liveStrokes).map(([id, list]) => [id, list.map(moveStroke)]));
  if (doc.paintEvents) {
    out.paintEvents = doc.paintEvents.map((e) => {
      const list = e.kind === 'stickers' ? (e.data as { stickers?: Sticker[] } | undefined)?.stickers : undefined;
      if (list) return { ...e, data: { ...e.data, stickers: moveStickers(list) } };
      const strokes = e.kind === 'live-strokes' ? (e.data as { strokes?: RecordedStroke[] } | undefined)?.strokes : undefined;
      if (strokes) return { ...e, data: { ...e.data, strokes: strokes.map(moveStroke) } };
      if (e.kind === 'fill-region' && e.data) {
        const d = e.data as { x?: number; y?: number; points?: Array<{ x: number; y: number }> };
        return {
          ...e,
          data: {
            ...e.data,
            ...(typeof d.x === 'number' && typeof d.y === 'number' ? { x: d.x + dx, y: d.y + dy } : {}),
            ...(Array.isArray(d.points) ? { points: d.points.map((p) => movePoint(p, dx, dy)) } : {}),
          },
        };
      }
      return e;
    });
  }
  if (doc.wetEvents) {
    out.wetEvents = doc.wetEvents.map((e) => {
      const d = e.data as { x?: number; rect?: RasterRect; center?: { x: number; y: number }; points?: Array<{ x: number; y: number; strength?: number }> } | undefined;
      if (!d) return e;
      if (e.kind === 'dry' && typeof d.x === 'number') return { ...e, data: moveRect(d as RasterRect, dx, dy) };
      if (e.kind === 'wet-paper' && d.rect) return { ...e, data: { ...d, rect: moveRect(d.rect, dx, dy) } };
      if (e.kind === 'flow' && d.center) return { ...e, data: { ...d, center: movePoint(d.center, dx, dy) } };
      if (e.kind === 'seed-live-patterns' && Array.isArray(d.points)) {
        return { ...e, data: { ...d, points: d.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) } };
      }
      return e;
    });
  }
  if (doc.paperEffect) {
    // Kept in place; smaller than the new canvas, so updatePaperEffect draws it again across all of it.
    const src = doc.paperEffect.image;
    const width = src.width + dx;
    const height = src.height + dy;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < src.height; y++) data.set(src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4), ((y + dy) * width + dx) * 4);
    out.paperEffect = { ...doc.paperEffect, image: { width, height, data }, version: nextPaperEffectVersion() };
  }
  return out;
}

/** The guides moved by (dx, dy) document pixels with the paint (reference panels are on screen and stay). */
function shiftGuides(g: PaintGuides, dx: number, dy: number): PaintGuides {
  return {
    ...g,
    symmetry: { ...g.symmetry, center: movePoint(g.symmetry.center, dx, dy) },
    perspective: { ...g.perspective, points: g.perspective.points.map((p) => movePoint(p, dx, dy)) },
    tracing: g.tracing ? { ...g.tracing, rect: moveRect(g.tracing.rect, dx, dy) } : null,
    stencils: g.stencils.map((s) => translateStencil(s, dx, dy)),
  };
}

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

function clipToCanvas(rect: RasterRect, canvas: { width: number; height: number }): RasterRect | null {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(canvas.width, rect.x + rect.width);
  const y1 = Math.min(canvas.height, rect.y + rect.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Rendered effect pixels as effect paint (a copy; with its strip map when bent along the stroke). */
function toEffectPaintPixels(p: PaintEffectPaint, pixels: EffectPixels): EffectPaintPixels {
  return { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(pixels.data as ArrayLike<number>), ...(p.map?.by === 'stroke' ? { map: p.map } : {}) };
}

function readWetGhost(raw: unknown): WetGhostState | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as { pigment?: unknown; remaining?: unknown; total?: unknown; linger?: unknown };
  if (!Array.isArray(g.pigment) || g.pigment.length !== 4 || !g.pigment.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  const remaining = typeof g.remaining === 'number' && Number.isFinite(g.remaining) ? Math.max(0, Math.round(g.remaining)) : 0;
  if (remaining <= 0) return null;
  const total = typeof g.total === 'number' && Number.isFinite(g.total) ? Math.max(1, Math.round(g.total)) : remaining;
  const linger = typeof g.linger === 'number' && Number.isFinite(g.linger) ? Math.max(0.5, Math.min(60, g.linger)) : 4;
  return { pigment: [g.pigment[0], g.pigment[1], g.pigment[2], g.pigment[3]], remaining, total, linger };
}
