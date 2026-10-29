import type { CropBox, ImagePoint } from '../types';
import { combineSelections, resizeSelection, selectionFromPixels, type PixelBuffer, type SelectionMask } from './mask';
import { polygonSelection } from './shapes';

/** What a segmentation provider is asked for (see `SegmentationProvider`). */
export interface SegmentationRequest {
  /** The flattened image at its natural size, as a PNG data URL. */
  image: string;
  /** The image's natural size in pixels. */
  width: number;
  height: number;
  /** What to find, in words ("the dog", "the sky", "every separate object"). */
  target: string;
  /** Return at most this many objects (the provider's default when absent). */
  maxSegments?: number;
  signal?: AbortSignal;
}

/**
 * One object a provider found, in natural image pixels: an outline `polygon` (or several, for
 * an object in pieces), or a `mask` covering the whole image (white = the object, any size;
 * it is resampled), or both, which are combined.
 */
export interface SegmentationResult {
  label?: string;
  polygon?: ImagePoint[] | ImagePoint[][];
  mask?: string | PixelBuffer;
  /** The object's bounding box, when the provider knows it. */
  box?: CropBox;
  /** The provider's confidence, 0..1. */
  score?: number;
}

/**
 * Finds objects in an image by a description and returns their shapes: an AI segmentation
 * model (SAM, Gemini, a background remover…) behind `ImageEditorController.selectSubject`.
 */
export interface SegmentationProvider {
  /** Shown in the UI and in tool results (e.g. "Gemini"). */
  readonly name?: string;
  segment(request: SegmentationRequest): Promise<SegmentationResult[]>;
}

/** A segmentation result with its `mask` already decoded to pixels (strings are decoded by the controller). */
export type DecodedSegmentationResult = Omit<SegmentationResult, 'mask'> & { mask?: PixelBuffer };

const isPoint = (p: unknown): p is ImagePoint =>
  !!p && typeof p === 'object' && Number.isFinite((p as ImagePoint).x) && Number.isFinite((p as ImagePoint).y);

/** A result's polygons as lists of at least three points. */
/** A result's polygon outlines (rings of at least 3 points), in image pixels. */
export function segmentationOutlines(result: Pick<SegmentationResult, 'polygon'>): ImagePoint[][] {
  const p = result.polygon;
  if (!Array.isArray(p) || !p.length) return [];
  const rings = Array.isArray(p[0]) ? (p as ImagePoint[][]) : [p as ImagePoint[]];
  return rings.map((ring) => (Array.isArray(ring) ? ring.filter(isPoint) : [])).filter((ring) => ring.length >= 3);
}

/**
 * One segmentation result as a selection over a `width × height` image, or null when it has no
 * usable shape. Polygons are anti-aliased; several polygons and a mask are added together.
 */
export function segmentToSelection(width: number, height: number, result: DecodedSegmentationResult): SelectionMask | null {
  let out: SelectionMask | null = null;
  for (const ring of segmentationOutlines(result)) {
    out = combineSelections(out, polygonSelection(width, height, ring), 'add');
  }
  if (result.mask && result.mask.width > 0 && result.mask.height > 0) {
    const raw = selectionFromPixels(result.mask, { channel: 'luminance' });
    const sized = raw.width === width && raw.height === height ? raw : resizeSelection(raw, width, height);
    out = combineSelections(out, sized, 'add');
  }
  return out?.bounds ? out : null;
}

/** Every usable result added into one selection (null when none has a shape). */
export function segmentsToSelection(width: number, height: number, results: readonly DecodedSegmentationResult[]): SelectionMask | null {
  let out: SelectionMask | null = null;
  for (const r of results) {
    const sel = segmentToSelection(width, height, r);
    if (sel) out = combineSelections(out, sel, 'add');
  }
  return out;
}
