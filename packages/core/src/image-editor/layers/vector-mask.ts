/**
 * Vector masks: a path on a layer that reveals it (Photoshop's Layer › Vector Mask). The paths are
 * shape components in document pixels; the compositor sees them through `resolveVectorMasks`, which
 * gives each layer with a vector mask a raster mask that is its raster mask times the path's
 * coverage, so the tile engine and its caches need nothing new.
 */

import type { CropBox } from '../types';
import type { AffineMatrix } from '../../geom/types';
import { emptySurface, readRegion, writeRegion } from '../../raster/surface';
import { gaussianBlur } from '../../raster/blur';
import type { ImageLayer, RasterMask, ShapeComponent, VectorMask } from './model';
import { componentPath, componentsCoverage, mapSubpaths, transformShapeComponents } from './shape';
import { flattenPath } from './vector-raster';

/** Whether a vector mask takes part in compositing. */
export function isActiveVectorMask(vm: VectorMask | undefined): vm is VectorMask {
  return Boolean(vm && vm.enabled !== false);
}

/**
 * The vector mask's coverage (0..1) over the `width × height` canvas, with its feather and
 * density applied.
 */
export function vectorMaskCoverage(vm: VectorMask, width: number, height: number): Float32Array {
  let v: Float32Array = componentsCoverage(vm.components, { x: 0, y: 0, width, height }, vm.fillRule ?? 'nonzero', vm.inverted === true);
  if ((vm.feather ?? 0) > 0) v = gaussianBlur(v, width, height, vm.feather!, 'clamp');
  const density = vm.density ?? 1;
  if (density !== 1) for (let i = 0; i < v.length; i++) v[i] = 1 - density * (1 - v[i]);
  return v;
}

/** What a vector mask is outside the canvas (0..1): revealed when inverted, scaled by density. */
function outsideValue(vm: VectorMask): number {
  return 1 - (vm.density ?? 1) * (1 - (vm.inverted ? 1 : 0));
}

/** A raster mask's coverage (0..1) over the canvas: its pixels with its feather and density. */
function rasterCoverage(mask: RasterMask, ox: number, oy: number, width: number, height: number): Float32Array {
  const bytes = readRegion(mask.surface, { x: -ox, y: -oy, width, height });
  let v: Float32Array = new Float32Array(width * height);
  for (let i = 0; i < v.length; i++) v[i] = bytes[i] / 255;
  if ((mask.feather ?? 0) > 0) v = gaussianBlur(v, width, height, mask.feather!, 'clamp');
  const density = mask.density ?? 1;
  if (density !== 1) for (let i = 0; i < v.length; i++) v[i] = 1 - density * (1 - v[i]);
  return v;
}

const layerOffset = (layer: ImageLayer) => (layer.type === 'pixel' ? layer.offset : { x: 0, y: 0 });

/**
 * The raster mask a layer composites with: its raster mask times its vector mask (layer space,
 * feather and density baked in), or the raster mask alone when there is no active vector mask.
 * A depth (parametric) mask cannot be combined, so it wins.
 */
export function effectiveLayerMask(layer: ImageLayer, width: number, height: number): RasterMask | undefined {
  const vm = layer.vectorMask;
  const raster = layer.mask;
  if (!isActiveVectorMask(vm) || raster?.source || width < 1 || height < 1) return raster;
  const { x: ox, y: oy } = layerOffset(layer);
  const v = vectorMaskCoverage(vm, width, height);
  let outside = outsideValue(vm);
  if (raster && raster.enabled !== false) {
    const r = rasterCoverage(raster, ox, oy, width, height);
    for (let i = 0; i < v.length; i++) v[i] *= r[i];
    outside *= 1 - (raster.density ?? 1) * (1 - raster.defaultValue / 255);
  }
  const bytes = new Uint8ClampedArray(v.length);
  for (let i = 0; i < v.length; i++) bytes[i] = Math.round(v[i] * 255);
  const defaultValue = outside >= 0.5 ? 255 : 0;
  return { surface: writeRegion(emptySurface(1, defaultValue), { x: -ox, y: -oy, width, height }, bytes), defaultValue };
}

interface Resolved {
  key: string;
  layer: ImageLayer;
}

const resolved = new WeakMap<ImageLayer, Resolved>();

function hasVectorMask(layers: readonly ImageLayer[]): boolean {
  for (const l of layers) {
    if (isActiveVectorMask(l.vectorMask)) return true;
    if (l.type === 'group' && hasVectorMask(l.children)) return true;
  }
  return false;
}

/**
 * The stack as the compositor should see it: each layer with an active vector mask replaced by a
 * copy whose `mask` is `effectiveLayerMask` (cached per layer object and canvas size, so the
 * engine's tile caches keep working). Returns `layers` itself when there are none.
 */
export function resolveVectorMasks(layers: readonly ImageLayer[], width: number, height: number): readonly ImageLayer[] {
  if (!hasVectorMask(layers)) return layers;
  return layers.map((l) => resolveLayer(l, width, height));
}

function resolveLayer(layer: ImageLayer, width: number, height: number): ImageLayer {
  let next = layer;
  if (layer.type === 'group' && hasVectorMask(layer.children)) {
    const key = `${width}x${height}`;
    const hit = resolved.get(layer);
    if (hit?.key === key) return hit.layer;
    next = { ...layer, children: layer.children.map((c) => resolveLayer(c, width, height)) };
    if (!isActiveVectorMask(layer.vectorMask)) {
      resolved.set(layer, { key, layer: next });
      return next;
    }
  }
  if (!isActiveVectorMask(layer.vectorMask)) return layer;
  const key = `${width}x${height}:v`;
  const hit = resolved.get(layer);
  if (hit?.key === key) return hit.layer;
  const mask = effectiveLayerMask(layer, width, height);
  // The copy drops `vectorMask`: it is in `mask` now, and resolving again must not apply it twice.
  const out = { ...next, mask } as ImageLayer;
  delete out.vectorMask;
  if (!mask) delete (out as { mask?: RasterMask }).mask;
  resolved.set(layer, { key, layer: out });
  return out;
}

/** A vector mask moved by (dx, dy) document pixels. */
export function offsetVectorMask(vm: VectorMask, dx: number, dy: number): VectorMask {
  if (!dx && !dy) return vm;
  return { ...vm, components: vm.components.map((c) => ({ ...c, subpaths: mapSubpaths(c.subpaths, (p) => ({ x: p.x + dx, y: p.y + dy })), ...(c.live ? { live: offsetLive(c.live, dx, dy) } : {}) })) };
}

function offsetLive(live: NonNullable<ShapeComponent['live']>, dx: number, dy: number): NonNullable<ShapeComponent['live']> {
  if (live.kind === 'line') return { ...live, x1: live.x1 + dx, y1: live.y1 + dy, x2: live.x2 + dx, y2: live.y2 + dy };
  return { ...live, x: live.x + dx, y: live.y + dy } as NonNullable<ShapeComponent['live']>;
}

/** A vector mask with its paths mapped by `f` (document space); `affine` keeps live shapes live. */
export function transformVectorMask(vm: VectorMask, f: (p: { x: number; y: number }) => { x: number; y: number }, affine?: AffineMatrix): VectorMask {
  return { ...vm, components: transformShapeComponents(vm.components, f, affine) };
}

/** A linked vector mask moved with its layer by (dx, dy); unlinked ones stay. */
export function followLayerMove<T extends ImageLayer>(layer: T, dx: number, dy: number): T {
  const vm = layer.vectorMask;
  if (!vm || vm.linked === false || (!dx && !dy)) return layer;
  return { ...layer, vectorMask: offsetVectorMask(vm, dx, dy) };
}

/** Bounds of the area a vector mask's paths enclose (document pixels, the curves themselves, not their handles), or `null` when it has none. */
export function vectorMaskBounds(vm: Pick<VectorMask, 'components'>): CropBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of vm.components) {
    for (const ring of flattenPath(componentPath(c))) {
      for (let k = 0; k + 1 < ring.length; k += 2) {
        x0 = Math.min(x0, ring[k]);
        x1 = Math.max(x1, ring[k]);
        y0 = Math.min(y0, ring[k + 1]);
        y1 = Math.max(y1, ring[k + 1]);
      }
    }
  }
  return x0 === Infinity ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const thumbCache = new WeakMap<VectorMask, { key: string; pixels: { width: number; height: number; data: Uint8ClampedArray } }>();

/**
 * A vector mask's thumbnail over the `width × height` canvas, at most `maxSide` px: grey RGBA,
 * white where the path reveals (cached per mask object).
 */
export function vectorMaskThumbnail(vm: VectorMask, width: number, height: number, maxSide = 64): { width: number; height: number; data: Uint8ClampedArray } {
  const key = `${width}x${height}:${maxSide}`;
  const hit = thumbCache.get(vm);
  if (hit?.key === key) return hit.pixels;
  const k = Math.min(1, maxSide / Math.max(1, width, height));
  const tw = Math.max(1, Math.round(width * k));
  const th = Math.max(1, Math.round(height * k));
  const scaled = transformVectorMask(vm, (p) => ({ x: p.x * k, y: p.y * k }), [k, 0, 0, k, 0, 0]);
  const cov = componentsCoverage(scaled.components, { x: 0, y: 0, width: tw, height: th }, vm.fillRule ?? 'nonzero', vm.inverted === true);
  const data = new Uint8ClampedArray(tw * th * 4);
  for (let i = 0; i < cov.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, cov[i])) * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const pixels = { width: tw, height: th, data };
  thumbCache.set(vm, { key, pixels });
  return pixels;
}
