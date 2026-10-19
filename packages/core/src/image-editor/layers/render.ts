/**
 * Pure helpers between the compositor and the renderer: the output stage (projection to the
 * cropped, rotated frame, output opacity and the migrated blur), the routing rule that keeps
 * old-shape documents on the exact legacy path where document-space compositing cannot match it,
 * and per-tile histograms. No DOM.
 */

import { applyBoxBlur } from '../filters';
import { normalizeAngle, unprojectCanvasPoint, getRotatedSize, type ImageProjection } from '../geometry';
import { HISTOGRAM_BINS, type ImageHistogram } from '../histogram';
import type { CropBox, ImageTransform } from '../types';
import { blurFilter, type AnnotationLayer, type ImageLayer, type PixelLayer } from './model';
import { hasResampledLegacyMask, isLegacyShape, type LayerStack } from './migrate';
import { LayerCompositor, type CompositorSources } from './compositor';

/** True for 0, 90, 180 and 270 degrees. */
export function isQuarterTurn(rotate: number): boolean {
  return normalizeAngle(rotate) % 90 === 0;
}

function isIntegerRect(r: CropBox): boolean {
  return Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.width) && Number.isInteger(r.height);
}

/** The projection that draws `region` into a `baseW × baseH` buffer at scale 1 (the renderer's base canvas). */
export function baseProjection(region: CropBox, transform: ImageTransform, baseW: number, baseH: number): ImageProjection {
  return {
    region,
    angle: normalizeAngle(transform.rotate),
    flipH: transform.flipH,
    flipV: transform.flipV,
    scale: 1,
    originX: baseW / 2,
    originY: baseH / 2,
  };
}

/**
 * Projects `src` (RGBA covering `srcRect` in document space) into the base frame of `region`
 * under a quarter-turn `transform`: an exact pixel permutation (crop, flips, 90° steps), the
 * same mapping the canvas draws with. Returns the base buffer and its size.
 */
export function projectQuarterTurn(
  src: ArrayLike<number>,
  srcRect: CropBox,
  region: CropBox,
  transform: ImageTransform
): { width: number; height: number; data: Uint8ClampedArray } {
  const rotated = getRotatedSize(region.width, region.height, transform);
  const w = Math.max(1, Math.round(rotated.width));
  const h = Math.max(1, Math.round(rotated.height));
  const out = new Uint8ClampedArray(w * h * 4);
  const p = baseProjection(region, transform, w, h);
  const o = unprojectCanvasPoint({ x: 0.5, y: 0.5 }, p);
  const ox = unprojectCanvasPoint({ x: 1.5, y: 0.5 }, p);
  const oy = unprojectCanvasPoint({ x: 0.5, y: 1.5 }, p);
  const ux = Math.round(ox.x - o.x);
  const vx = Math.round(ox.y - o.y);
  const uy = Math.round(oy.x - o.x);
  const vy = Math.round(oy.y - o.y);
  const u0 = Math.floor(o.x) - srcRect.x;
  const v0 = Math.floor(o.y) - srcRect.y;
  const sw = srcRect.width;
  const sh = srcRect.height;
  for (let y = 0; y < h; y++) {
    let u = u0 + y * uy;
    let v = v0 + y * vy;
    for (let x = 0; x < w; x++, u += ux, v += vx) {
      if (u < 0 || v < 0 || u >= sw || v >= sh) continue;
      const s = (v * sw + u) * 4;
      const d = (y * w + x) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/** Output opacity as the old base adjustments applied it (`clamp(a · opacity)`), then the migrated blur. */
export function applyOutputStage(img: { width: number; height: number; data: Uint8ClampedArray }, opacity: number, legacyOutputBlur?: number): void {
  if (opacity < 1) {
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] * opacity;
  }
  if (legacyOutputBlur && legacyOutputBlur > 0) applyBoxBlur(img, Math.min(Math.round(legacyOutputBlur), 40));
}

export interface RouteInput {
  stack: LayerStack;
  region: CropBox;
  canvas: { width: number; height: number };
  transform: ImageTransform;
  /** Whether the source image is fully opaque. */
  sourceOpaque: boolean;
}

/**
 * Whether a document must render through the legacy base path to look exactly as before. Only
 * documents that still have the v1 / v2 shape qualify, and only where compositing in document
 * space cannot reproduce the old order of operations:
 *
 * - a rotation that is not a quarter turn, or a crop with fractional coordinates (the old path
 *   resampled before adjusting);
 * - an enabled depth mask (applied after the blur and resampled with the canvas);
 * - output opacity below 1 (it rounded alpha before the depth mask);
 * - a Background blur filter with a crop or a 90° / 270° turn (the old blur clamped at the crop
 *   edge and ran on the rotated buffer);
 * - a migrated output blur over a source with transparency (canvas premultiplication would round
 *   colours before blurring);
 * - an adjustment-layer mask stored at another size than the canvas (it was resampled through
 *   the projection on every render).
 */
export function needsLegacyBase(input: RouteInput): boolean {
  const { stack, region, canvas, transform } = input;
  if (!isLegacyShape(stack)) return false;
  const bg = stack.layers[0] as PixelLayer;
  if (!isQuarterTurn(transform.rotate) || !isIntegerRect(region)) return true;
  if (bg.mask?.source?.enabled && bg.mask.source.maskSource) return true;
  if (stack.outputOpacity < 1) return true;
  const blur = blurFilter(bg);
  if (blur && blur.enabled && blur.radius > 0) {
    const full = region.x === 0 && region.y === 0 && region.width === canvas.width && region.height === canvas.height;
    const angle = normalizeAngle(transform.rotate);
    if (!full || angle === 90 || angle === 270) return true;
  }
  if ((stack.legacyOutputBlur ?? 0) > 0 && !input.sourceOpaque) return true;
  if (hasResampledLegacyMask(stack.layers, canvas.width, canvas.height)) return true;
  return false;
}

const isPlainAnnotation = (l: ImageLayer): l is AnnotationLayer =>
  l.type === 'annotation' && l.opacity === 1 && l.blend === 'normal' && !l.clipped && !l.mask;

/**
 * Splits the stack into what the compositor rasterizes and the annotation layers at the top that
 * draw as crisp vectors over the result (as annotations always did): the trailing run of plain
 * top-level annotation layers (hidden ones are skipped).
 */
export function splitOverlayAnnotations(layers: readonly ImageLayer[]): { composite: ImageLayer[]; overlay: AnnotationLayer[] } {
  let i = layers.length;
  while (i > 0) {
    const l = layers[i - 1];
    if (l.type === 'annotation' && (!l.visible || isPlainAnnotation(l))) i--;
    else break;
  }
  return {
    composite: layers.slice(0, i) as ImageLayer[],
    overlay: (layers.slice(i) as AnnotationLayer[]).filter((l) => l.visible),
  };
}

/** The integer rectangle covering `region`. */
export function coveringRect(region: CropBox): CropBox {
  const x = Math.floor(region.x);
  const y = Math.floor(region.y);
  return { x, y, width: Math.ceil(region.x + region.width) - x, height: Math.ceil(region.y + region.height) - y };
}

/**
 * The base image of a layered document without a canvas: the stack composited over `region`
 * (integer), projected under a quarter-turn `transform`, then output opacity and the migrated
 * blur. Annotation layers need a canvas and are skipped unless `sources` can rasterize them.
 * This is what the renderer's base canvas holds for such documents.
 */
export function renderLayeredBase(
  stack: LayerStack,
  region: CropBox,
  transform: ImageTransform,
  sources: CompositorSources,
  compositor = new LayerCompositor()
): { width: number; height: number; data: Uint8ClampedArray } {
  if (!isQuarterTurn(transform.rotate) || !isIntegerRect(region)) {
    throw new Error('renderLayeredBase needs an integer region and a quarter-turn rotation.');
  }
  const composite = compositor.composite(stack.layers, region, sources);
  const out = projectQuarterTurn(composite, region, region, transform);
  applyOutputStage(out, stack.outputOpacity, stack.legacyOutputBlur);
  return out;
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

/** An empty histogram. */
export function emptyHistogram(): ImageHistogram {
  return {
    red: new Uint32Array(HISTOGRAM_BINS),
    green: new Uint32Array(HISTOGRAM_BINS),
    blue: new Uint32Array(HISTOGRAM_BINS),
    luminance: new Uint32Array(HISTOGRAM_BINS),
    samples: 0,
    transparent: 0,
    shadows: [0, 0, 0],
    highlights: [0, 0, 0],
    max: 0,
  };
}

/** Adds the pixels of `rect` (in tile-local coordinates of a `stride`-wide RGBA buffer) to `h`. */
export function addToHistogram(h: ImageHistogram, data: ArrayLike<number>, stride: number, rect: CropBox): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    let i = (y * stride + rect.x) * 4;
    for (let x = 0; x < rect.width; x++, i += 4) {
      if (!(data[i + 3] > 0)) {
        h.transparent++;
        continue;
      }
      h.samples++;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      h.red[r]++;
      h.green[g]++;
      h.blue[b]++;
      h.luminance[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
      if (r === 0) h.shadows[0]++;
      if (g === 0) h.shadows[1]++;
      if (b === 0) h.shadows[2]++;
      if (r === 255) h.highlights[0]++;
      if (g === 255) h.highlights[1]++;
      if (b === 255) h.highlights[2]++;
    }
  }
}

/** Sums histograms (and recomputes `max`). */
export function sumHistograms(parts: Iterable<ImageHistogram>): ImageHistogram {
  const out = emptyHistogram();
  for (const p of parts) {
    for (let i = 0; i < HISTOGRAM_BINS; i++) {
      out.red[i] += p.red[i];
      out.green[i] += p.green[i];
      out.blue[i] += p.blue[i];
      out.luminance[i] += p.luminance[i];
    }
    out.samples += p.samples;
    out.transparent += p.transparent;
    for (let c = 0; c < 3; c++) {
      out.shadows[c] += p.shadows[c];
      out.highlights[c] += p.highlights[c];
    }
  }
  let max = 0;
  for (let i = 0; i < HISTOGRAM_BINS; i++) max = Math.max(max, out.red[i], out.green[i], out.blue[i], out.luminance[i]);
  out.max = max;
  return out;
}
