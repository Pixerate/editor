import type { GlobalLight } from '../raster/effects/model';
import type { BlendMode } from './blend';
import type { SelectionMask, SerializedSelection } from './selection/mask';
import type { ImageLayer, LayerTarget } from './layers/model';
import type { SerializedLayeredImageEditorState } from './layers/serialize';
import type { PaintOptions } from './controller';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface ImagePoint {
  x: number;
  y: number;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AspectRatio = number | null;

export interface ImageTransform {
  rotate: number; // in degrees, e.g. 0, 90, 180, 270 or arbitrary
  flipH: boolean;
  flipV: boolean;
}

export interface ImageAdjustments {
  brightness: number; // -100 to 100, 0 is default
  contrast: number; // -100 to 100, 0 is default
  saturation: number; // -100 to 100, 0 is default
  exposure: number; // -100 to 100, 0 is default
  temperature: number; // -100 to 100, 0 is default (warmth/coolness)
  /**
   * -100 (green) to 100 (magenta), 0 is default. White-balance tint correction in Duv × 3000
   * (process 2 only; the legacy process ignores it).
   */
  tint?: number;
  blur: number; // 0 to 50, 0 is default
  opacity: number; // 0 to 1, 1 is default
  /**
   * Rendering process the values are interpreted by. `2` (the latest; new edits and Reset get
   * it): linear-light exposure, Bradford white balance, LUT tone curve without intermediate
   * clipping. `1` or missing: the legacy 8-bit rendering, so edits saved before process
   * versions existed look exactly as they did. See `normalizeProcessVersion`.
   */
  process?: 1 | 2;
  /**
   * Non-destructive adjustment layers, evaluated bottom (first) to top (last) after the base
   * adjustments above, on the encoded sRGB result. Missing or empty: no layers (edits saved
   * before layers existed render exactly as before).
   */
  layers?: AdjustmentLayer[];
}

// ---------------------------------------------------------------------------
// Adjustment layers
// ---------------------------------------------------------------------------

export type AdjustmentKind =
  | 'curves'
  | 'levels'
  | 'hueSaturation'
  | 'vibrance'
  | 'colorBalance'
  | 'blackWhite'
  | 'invert'
  | 'posterize'
  | 'threshold'
  | 'photoFilter';

/** A Curves point; `input` and `output` are levels, 0..255. */
export interface CurvePoint {
  input: number;
  output: number;
}

/** Curves: each channel's curve first, then the master (composite) curve, as in Photoshop. */
export interface CurvesParams {
  master: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

/** One Levels record. Black / white points are levels (0..255); `gamma` is the midtone slider (0.1..9.99). */
export interface LevelsChannel {
  inBlack: number;
  inWhite: number;
  gamma: number;
  outBlack: number;
  outWhite: number;
}

/** Levels: each channel's record first, then the master record, as in Photoshop. */
export interface LevelsParams {
  master: LevelsChannel;
  red: LevelsChannel;
  green: LevelsChannel;
  blue: LevelsChannel;
}

/** One of Hue/Saturation's six colour ranges (reds, yellows, greens, cyans, blues, magentas). */
export interface HueRange {
  /** Hue shift in degrees (-180..180). */
  hue: number;
  /** Saturation change in percent (-100..100). */
  saturation: number;
  /** Lightness change in percent (-100..100). */
  lightness: number;
  /** Hue degrees where the range starts fading in, is fully on, starts fading out and ends (may wrap). */
  bounds: [number, number, number, number];
}

export interface HueSaturationParams {
  /** Master hue shift in degrees (-180..180), or the hue when colorizing (0..360). */
  hue: number;
  /** Percent, -100..100 (0..100 when colorizing). */
  saturation: number;
  /** Percent, -100..100. */
  lightness: number;
  colorize: boolean;
  /** Six ranges: reds, yellows, greens, cyans, blues, magentas. */
  ranges: HueRange[];
}

export interface VibranceParams {
  /** -100..100 */
  vibrance: number;
  /** -100..100 */
  saturation: number;
}

/** Cyan–red, magenta–green, yellow–blue sliders, -100..100 each. */
export type ColorBalanceTone = [number, number, number];

export interface ColorBalanceParams {
  shadows: ColorBalanceTone;
  midtones: ColorBalanceTone;
  highlights: ColorBalanceTone;
  preserveLuminosity: boolean;
}

/** Black & White: percent weights of the six colours (Photoshop defaults 40 60 40 60 20 80). */
export interface BlackWhiteParams {
  reds: number;
  yellows: number;
  greens: number;
  cyans: number;
  blues: number;
  magentas: number;
  /** Tint colour (`#rrggbb`), applied like the Color blend mode, or `null` for none. */
  tint: string | null;
}

export interface PhotoFilterParams {
  /** Filter colour, `#rrggbb`. */
  color: string;
  /** Percent, 0..100. */
  density: number;
  preserveLuminosity: boolean;
}

export interface PosterizeParams {
  /** 2..255 */
  levels: number;
}

export interface ThresholdParams {
  /** 1..255: luma at or above it becomes white. */
  level: number;
}

export type InvertParams = Record<string, never>;

export interface AdjustmentParamsMap {
  curves: CurvesParams;
  levels: LevelsParams;
  hueSaturation: HueSaturationParams;
  vibrance: VibranceParams;
  colorBalance: ColorBalanceParams;
  blackWhite: BlackWhiteParams;
  invert: InvertParams;
  posterize: PosterizeParams;
  threshold: ThresholdParams;
  photoFilter: PhotoFilterParams;
}

export interface AdjustmentLayerBase {
  id: string;
  /** Optional display name. */
  name?: string;
  enabled: boolean;
  /** 0..1 */
  opacity: number;
  /** How the adjusted colour is blended over the layers below. */
  blend: BlendMode;
  /**
   * Optional layer mask (natural image pixels): where it is 0 the layer has no effect. Missing:
   * the layer applies everywhere (layers saved before masks existed are unchanged).
   */
  mask?: AdjustmentLayerMask;
}

/**
 * A layer mask: 8-bit coverage of the source image, run-length encoded (see
 * `encodeSelectionRle`), plus non-destructive density and feather.
 */
export interface AdjustmentLayerMask {
  width: number;
  height: number;
  /** `r1:` run-length encoding of the mask bytes. */
  rle: string;
  /** 0..1 (missing = 1). */
  density?: number;
  /** Gaussian σ in pixels (missing = 0). */
  feather?: number;
  /** `false` keeps the mask but ignores it. */
  enabled?: boolean;
}

/** A non-destructive adjustment layer (Photoshop's Layer › New Adjustment Layer). */
export type AdjustmentLayer = {
  [K in AdjustmentKind]: AdjustmentLayerBase & { kind: K; params: AdjustmentParamsMap[K] };
}[AdjustmentKind];

export type AdjustmentLayerOf<K extends AdjustmentKind> = Extract<AdjustmentLayer, { kind: K }>;

export interface DepthMaskOptions {
  enabled: boolean;
  maskSource: string | null;
  mode: 'threshold' | 'brightness';
  depthRange: [number, number]; // [start, stop] e.g. [0, 255]
  softness: number; // default 10
  invert: boolean;
}

export type AnnotationType = 'pen' | 'rect' | 'circle' | 'arrow' | 'line' | 'text' | 'image';

export interface BaseAnnotation {
  id: string;
  type: AnnotationType;
  x: number;
  y: number;
  rotation?: number;
  opacity?: number;
  /** Blend mode the annotation is drawn with (default `normal`). */
  blend?: BlendMode;
}

export interface PenAnnotation extends BaseAnnotation {
  type: 'pen';
  points: ImagePoint[];
  strokeColor: string;
  strokeWidth: number;
}

export interface RectAnnotation extends BaseAnnotation {
  type: 'rect';
  width: number;
  height: number;
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
  cornerRadius?: number;
}

export interface CircleAnnotation extends BaseAnnotation {
  type: 'circle';
  radiusX: number;
  radiusY: number;
  strokeColor: string;
  strokeWidth: number;
  fillColor?: string;
}

export interface ArrowAnnotation extends BaseAnnotation {
  type: 'arrow';
  endX: number;
  endY: number;
  strokeColor: string;
  strokeWidth: number;
}

export interface LineAnnotation extends BaseAnnotation {
  type: 'line';
  endX: number;
  endY: number;
  strokeColor: string;
  strokeWidth: number;
}

export interface TextAnnotation extends BaseAnnotation {
  type: 'text';
  text: string;
  fontSize: number;
  fontFamily?: string;
  color: string;
  fontWeight?: string | number;
}

export interface ImageAnnotation extends BaseAnnotation {
  type: 'image';
  src: string;
  width: number;
  height: number;
}

export type Annotation =
  | PenAnnotation
  | RectAnnotation
  | CircleAnnotation
  | ArrowAnnotation
  | LineAnnotation
  | TextAnnotation
  | ImageAnnotation;

export type CreateAnnotationPayload =
  | Omit<PenAnnotation, 'id'>
  | Omit<RectAnnotation, 'id'>
  | Omit<CircleAnnotation, 'id'>
  | Omit<ArrowAnnotation, 'id'>
  | Omit<LineAnnotation, 'id'>
  | Omit<TextAnnotation, 'id'>
  | Omit<ImageAnnotation, 'id'>;

export type ImageEditorTool =
  | 'select'
  | 'crop'
  | 'pen'
  | 'rect'
  | 'circle'
  | 'arrow'
  | 'line'
  | 'text'
  | 'watermark'
  | 'move'
  | 'brush'
  | 'eraser'
  | 'mixer';

export type ImageEditorFit = 'contain' | 'margin';

export interface ImageEditorState {
  sourceUrl: string | null;
  /** Canvas (document) size in pixels: the source image's natural size. */
  imageDimensions: ImageDimensions;
  crop: CropBox | null;
  transform: ImageTransform;
  /**
   * Compatibility view of the layer stack: the develop filter of the active pixel layer (or the
   * Background), its blur (or `legacyOutputBlur`), the output opacity and every adjustment layer
   * in stack order. Edit it with `setAdjustments` and the adjustment-layer methods.
   */
  adjustments: ImageAdjustments;
  /** Compatibility view: the parametric depth mask of the active pixel layer (or the Background). */
  depthMask: DepthMaskOptions;
  /** Compatibility view: the annotation of every annotation layer, bottom to top. */
  annotations: Annotation[];
  selectedAnnotationId: string | null;
  activeTool: ImageEditorTool;
  zoom: number;
  pan: ImagePoint;
  isOriginalCompared: boolean;
  /** Viewport fit mode: 'contain' scales to full viewport bounds; 'margin' scales to 85% with 1.0 cap (default). */
  fit?: ImageEditorFit;
  /**
   * The active selection (8-bit coverage over the source image), or null/missing when nothing is
   * selected. Recorded in undo history and saved as `selection` in `toJSON()`.
   */
  selection?: SelectionMask | null;
  /** Quick Mask view: tint the unselected area instead of drawing marching ants (view state). */
  quickMask?: boolean;
  /**
   * The layer stack, bottom to top. Opening an image gives one pixel layer, "Background", whose
   * pixels are the source image. Layers are immutable: compare them by identity.
   */
  layers: ImageLayer[];
  /** The layer that layer commands, painting and `setAdjustments` act on, or `null`. */
  activeLayerId: string | null;
  /** Whether painting targets the active layer's pixels or its mask. */
  activeTarget: LayerTarget;
  /** Export alpha (0..1), applied after compositing; `adjustments.opacity` mirrors it. */
  outputOpacity: number;
  /**
   * Blur that runs after the adjustment layers, kept from v1 / v2 documents that had both so
   * they render as before. New edits blur a layer instead (`blur` filter).
   */
  legacyOutputBlur?: number;
  /** Brush settings and foreground / background colours of the paint tools (view state). */
  paint: PaintOptions;
  /**
   * The light layer effects use when they follow the global light (Photoshop's Global Light);
   * missing = angle 120°, altitude 30°. Recorded in undo history and saved in `toJSON()`.
   */
  globalLight?: GlobalLight;
}

/**
 * A stored editor state in the document-level schema (versions 1 and 2). Documents whose layer
 * stack has exactly this shape are still written this way, byte for byte.
 */
export interface LegacySerializedImageEditorState {
  /**
   * Schema version. `2` adds `adjustments.layers`; states without layers are still written as
   * `1` so they round-trip unchanged. See `migrateSerializedImageEditorState`.
   */
  version: 1 | 2;
  crop: CropBox | null;
  transform: ImageTransform;
  adjustments: ImageAdjustments;
  depthMask: DepthMaskOptions;
  annotations: Annotation[];
  /** The active selection, run-length encoded. Missing when nothing is selected. */
  selection?: SerializedSelection;
}

/**
 * A stored editor state: the document-level schema (v1 / v2) or the layered schema (v3, see
 * `SerializedLayeredImageEditorState`). `toJSON()` writes v1 / v2 while the layer stack still
 * has the shape those versions describe.
 */
export type SerializedImageEditorState = LegacySerializedImageEditorState | SerializedLayeredImageEditorState;

export interface ExportOptions {
  format?: 'image/png' | 'image/jpeg' | 'image/webp';
  quality?: number; // 0 to 1
  width?: number;
  height?: number;
  includeAnnotations?: boolean;
  /** Render only these layers (groups with their children). */
  layerIds?: string[];
}

export interface ImageEditorOptions {
  image?: string | HTMLImageElement;
  initialState?: Partial<SerializedImageEditorState>;
  onStateChange?: (state: ImageEditorState) => void;
  maxHistoryDepth?: number;
  /**
   * Upper bound for the pixel data held only by undo / redo steps (tiles shared with the
   * current state are free). The oldest steps are dropped first. Default 512 MiB.
   */
  maxHistoryBytes?: number;
  /** Viewport fit mode: 'contain' scales to full viewport bounds; 'margin' scales to 85% with 1.0 cap (default). */
  fit?: ImageEditorFit;
}

export interface InpaintOptions {
  prompt: string;
  imageDataUrl: string;
  maskDataUrl?: string;
  cropBox?: CropBox | null;
}

export interface RemoveBackgroundOptions {
  imageDataUrl: string;
}

export type InpaintHook = (options: InpaintOptions) => Promise<string | void> | string | void;
export type RemoveBackgroundHook = (options: RemoveBackgroundOptions) => Promise<string | void> | string | void;

export interface ImageEditorAIHooks {
  onInpaint?: InpaintHook;
  onRemoveBackground?: RemoveBackgroundHook;
}

