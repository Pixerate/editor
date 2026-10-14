// Portions ported from photocraft/crates/engine/src/layer_mask_props_cmds.rs and photocraft/crates/compose/src/masks.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

import type { AdjustmentLayer, AdjustmentLayerMask } from '../types';
import { unprojectCanvasPoint, type ImageProjection } from '../geometry';
import {
  createSelectionMask,
  decodeSelectionRle,
  encodeSelectionRle,
  hashMaskContent,
  type SelectionMask,
} from './mask';
import { gaussianBlur } from './modify';

/** Properties of a layer mask that leave its pixels intact (Photoshop's Properties › Masks). */
export interface LayerMaskProps {
  /** 0..1 (default 1): at 0.5 the masked-out areas still get half of the adjustment. */
  density?: number;
  /** Gaussian feather σ in pixels, 0..1000 (default 0). */
  feather?: number;
  /** Disabled masks are kept but ignored (the layer applies everywhere). Default true. */
  enabled?: boolean;
}

const MAX_SIDE = 1 << 15;

/**
 * A clean layer mask from stored data, or `null` when it is unusable. Defaults are left out
 * (density 1, feather 0, enabled), so a plain mask serializes as `{width, height, rle}`. The
 * RLE is only decoded when rendering.
 */
export function normalizeLayerMask(raw: unknown): AdjustmentLayerMask | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const { width, height, rle } = r;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SIDE ||
    height > MAX_SIDE ||
    typeof rle !== 'string' ||
    !rle.startsWith('r1:')
  ) {
    return null;
  }
  const out: AdjustmentLayerMask = { width, height, rle };
  if (typeof r.density === 'number' && Number.isFinite(r.density)) {
    const d = Math.min(1, Math.max(0, r.density));
    if (d !== 1) out.density = d;
  }
  if (typeof r.feather === 'number' && Number.isFinite(r.feather)) {
    const f = Math.min(1000, Math.max(0, r.feather));
    if (f !== 0) out.feather = f;
  }
  if (r.enabled === false) out.enabled = false;
  return out;
}

/** A layer mask holding the selection's pixels (Add Layer Mask › Reveal Selection). */
export function layerMaskFromSelection(selection: SelectionMask, props: LayerMaskProps = {}): AdjustmentLayerMask {
  return normalizeLayerMask({ width: selection.width, height: selection.height, rle: encodeSelectionRle(selection.data), ...props })!;
}

/** Applies property changes; `undefined` fields keep their value. */
export function updateLayerMaskProps(mask: AdjustmentLayerMask, props: LayerMaskProps): AdjustmentLayerMask {
  return normalizeLayerMask({
    ...mask,
    ...(props.density !== undefined ? { density: props.density } : {}),
    ...(props.feather !== undefined ? { feather: props.feather } : {}),
    ...(props.enabled !== undefined ? { enabled: props.enabled } : {}),
  })!;
}

// Small LRU caches: masks are stored as RLE strings and layers are deep-copied often.
const DECODE_LIMIT = 8;
const decoded = new Map<string, SelectionMask | null>();
const coverageCache = new Map<string, Float32Array | null>();

function lru<T>(cache: Map<string, T>, key: string, make: () => T): T {
  if (cache.has(key)) {
    const v = cache.get(key)!;
    cache.delete(key);
    cache.set(key, v);
    return v;
  }
  const v = make();
  cache.set(key, v);
  if (cache.size > DECODE_LIMIT) cache.delete(cache.keys().next().value as string);
  return v;
}

/** The mask's pixels as a selection (Load Selection from mask), or `null` when the data is damaged. */
export function decodeLayerMask(mask: AdjustmentLayerMask): SelectionMask | null {
  const key = `${mask.width}x${mask.height}:${mask.rle}`;
  return lru(decoded, key, () => {
    try {
      return createSelectionMask(mask.width, mask.height, decodeSelectionRle(mask.rle, mask.width * mask.height));
    } catch {
      return null;
    }
  });
}

/** Cache key of everything about a mask that changes pixels. */
export function layerMaskKey(mask: AdjustmentLayerMask | undefined): string {
  if (!mask) return '';
  return `${mask.width}x${mask.height}:${hashMaskContent(mask.rle)}:${mask.density ?? 1}:${mask.feather ?? 0}:${mask.enabled !== false}`;
}

/**
 * The mask's effective coverage (0..1, mask resolution): feathered (σ = feather, borders
 * replicated), then density applied as `1 − density·(1 − v)`. `null` for a disabled or damaged
 * mask, meaning "no mask".
 */
export function layerMaskCoverage(mask: AdjustmentLayerMask): Float32Array | null {
  if (mask.enabled === false) return null;
  return lru(coverageCache, layerMaskKey(mask), () => {
    const sel = decodeLayerMask(mask);
    if (!sel) return null;
    let v: Float32Array = new Float32Array(sel.data.length);
    for (let i = 0; i < v.length; i++) v[i] = sel.data[i] / 255;
    const feather = mask.feather ?? 0;
    if (feather > 0) v = gaussianBlur(v, mask.width, mask.height, feather, 'clamp');
    const density = mask.density ?? 1;
    if (density !== 1) for (let i = 0; i < v.length; i++) v[i] = 1 - density * (1 - v[i]);
    return v;
  });
}

/**
 * Resamples mask coverage (natural-image aligned, any resolution) into a target raster drawn
 * through `projection` (the base canvas of the renderer: crop, rotation, flips): each target
 * pixel centre is unprojected to natural pixels and sampled bilinearly.
 */
export function projectMaskCoverage(
  coverage: Float32Array,
  maskWidth: number,
  maskHeight: number,
  naturalWidth: number,
  naturalHeight: number,
  projection: ImageProjection,
  targetWidth: number,
  targetHeight: number
): Float32Array {
  const out = new Float32Array(targetWidth * targetHeight);
  const o = unprojectCanvasPoint({ x: 0.5, y: 0.5 }, projection);
  const ox = unprojectCanvasPoint({ x: 1.5, y: 0.5 }, projection);
  const oy = unprojectCanvasPoint({ x: 0.5, y: 1.5 }, projection);
  const kx = maskWidth / naturalWidth;
  const ky = maskHeight / naturalHeight;
  // Affine map target → mask coordinates (pixel centres at +0.5).
  const ux = (ox.x - o.x) * kx;
  const vx = (ox.y - o.y) * ky;
  const uy = (oy.x - o.x) * kx;
  const vy = (oy.y - o.y) * ky;
  const u0 = o.x * kx - 0.5;
  const v0 = o.y * ky - 0.5;
  const mw1 = maskWidth - 1;
  const mh1 = maskHeight - 1;
  for (let y = 0; y < targetHeight; y++) {
    let u = u0 + y * uy;
    let v = v0 + y * vy;
    const row = y * targetWidth;
    for (let x = 0; x < targetWidth; x++, u += ux, v += vx) {
      const fu = u < 0 ? 0 : u > mw1 ? mw1 : u;
      const fv = v < 0 ? 0 : v > mh1 ? mh1 : v;
      const x0 = fu | 0;
      const y0 = fv | 0;
      const x1 = x0 < mw1 ? x0 + 1 : x0;
      const y1 = y0 < mh1 ? y0 + 1 : y0;
      const tx = fu - x0;
      const ty = fv - y0;
      const a = coverage[y0 * maskWidth + x0] * (1 - tx) + coverage[y0 * maskWidth + x1] * tx;
      const b = coverage[y1 * maskWidth + x0] * (1 - tx) + coverage[y1 * maskWidth + x1] * tx;
      out[row + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/**
 * Per-layer mask coverage for a render target, keyed by layer id; `undefined` when no layer has
 * an enabled, valid mask (so mask-free stacks take the exact same path as before).
 */
export function buildLayerMaskPlanes(
  layers: readonly AdjustmentLayer[] | undefined,
  naturalWidth: number,
  naturalHeight: number,
  projection: ImageProjection,
  targetWidth: number,
  targetHeight: number
): Map<string, Float32Array> | undefined {
  if (!layers?.some((l) => l.mask && l.mask.enabled !== false)) return undefined;
  const planes = new Map<string, Float32Array>();
  for (const layer of layers) {
    if (!layer.mask) continue;
    const coverage = layerMaskCoverage(layer.mask);
    if (!coverage) continue;
    planes.set(
      layer.id,
      projectMaskCoverage(coverage, layer.mask.width, layer.mask.height, naturalWidth, naturalHeight, projection, targetWidth, targetHeight)
    );
  }
  return planes.size ? planes : undefined;
}
