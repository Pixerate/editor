import { describe, expect, it } from 'vitest';
import {
  BLEND_MODES,
  LayerCompositor,
  TILE,
  applyAdjustmentLayers,
  blendPixel,
  createAdjustmentLayer,
  emptySurface,
  surfaceFromPixels,
  writeRegion,
  type AdjustmentLayer,
  type AdjustmentLayerNode,
  type BlendMode,
  type GroupLayer,
  type ImageLayer,
  type PixelLayer,
  type RasterMask,
} from '../src/image-editor';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const W = 40;
const H = 30;
const sources = { width: W, height: H };

function pixels(seed: number, alpha: 'opaque' | 'random' = 'random', w = W, h = H) {
  const r = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(r() * 256);
    data[i + 1] = Math.floor(r() * 256);
    data[i + 2] = Math.floor(r() * 256);
    data[i + 3] = alpha === 'opaque' ? 255 : r() < 0.15 ? 0 : Math.floor(r() * 256);
  }
  return { width: w, height: h, data };
}

function pixelLayer(id: string, seed: number, extra: Partial<PixelLayer> = {}, alpha: 'opaque' | 'random' = 'random'): PixelLayer {
  return {
    type: 'pixel',
    id,
    name: id,
    visible: true,
    opacity: 1,
    blend: 'normal',
    surface: surfaceFromPixels(pixels(seed, alpha), 4),
    offset: { x: 0, y: 0 },
    ...extra,
  };
}

function maskFrom(seed: number, defaultValue: 0 | 255 = 0): RasterMask {
  const r = rng(seed);
  const data = new Uint8ClampedArray(W * H).map(() => Math.floor(r() * 256));
  return { surface: surfaceFromPixels({ width: W, height: H, data }, 1, 0, 0, defaultValue), defaultValue };
}

function adjustment(kind: AdjustmentLayer['kind'], params: Record<string, unknown>, extra: Partial<AdjustmentLayerNode> = {}): AdjustmentLayerNode {
  const l = createAdjustmentLayer(kind, { params: params as never });
  return { type: 'adjustment', id: l.id, name: '', visible: true, opacity: 1, blend: 'normal', kind: l.kind, params: l.params, ...extra } as AdjustmentLayerNode;
}

function px(data: ArrayLike<number>, i: number): number[] {
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

/** Reference: one pixel at a time, `blendPixel` per layer with 8-bit rounding after each. */
function reference(layers: ImageLayer[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    let acc = [0, 0, 0, 0];
    let empty = true;
    for (const l of layers) {
      if (!l.visible) continue;
      if (l.type === 'adjustment') {
        if (empty) continue;
        const buf = { data: new Uint8ClampedArray(acc) };
        const cov = l.mask ? maskCov(l.mask, p) : 1;
        const view = { id: l.id, kind: l.kind, enabled: true, opacity: l.opacity, blend: l.blend, params: l.params } as AdjustmentLayer;
        applyAdjustmentLayers(buf, [view], cov < 1 ? new Map([[l.id, new Float32Array([cov])]]) : undefined);
        acc = Array.from(buf.data);
        continue;
      }
      if (l.type !== 'pixel') continue;
      const x = (p % W) - l.offset.x;
      const y = Math.floor(p / W) - l.offset.y;
      let src = [0, 0, 0, 0];
      if (x >= 0 && y >= 0 && x < W && y < H) {
        const tile = l.surface.getTile(Math.floor(x / TILE), Math.floor(y / TILE));
        if (tile) src = px(tile.data, ((y % TILE) * TILE + (x % TILE)) * 4);
      }
      const cov = l.mask ? maskCov(l.mask, p) : 1;
      const alpha = l.opacity * (l.fillOpacity ?? 1) * cov;
      if (empty && l.blend === 'normal' && alpha >= 1) {
        acc = src;
        empty = false;
        continue;
      }
      empty = false;
      if (src[3] === 0 || !(alpha > 0)) continue;
      const o = blendPixel(l.blend, acc.map((v) => v / 255), src.map((v) => v / 255), alpha);
      acc = o.map((v) => Math.round(v * 255));
    }
    out.set(acc, p * 4);
  }
  return out;
}

function maskCov(mask: RasterMask, p: number): number {
  const x = p % W;
  const y = Math.floor(p / W);
  const tile = mask.surface.getTile(0, 0);
  const v = tile ? tile.data[y * TILE + x] / 255 : mask.defaultValue / 255;
  const d = mask.density ?? 1;
  return Math.fround(1 - d * (1 - Math.fround(v)));
}

const full = { x: 0, y: 0, width: W, height: H };

describe('layer compositor', () => {
  it('a single normal layer is a plain copy (transparent colours included)', () => {
    const l = pixelLayer('a', 1);
    const out = new LayerCompositor().composite([l], full, sources);
    expect(out).toEqual(pixels(1).data);
  });

  it('matches blendPixel for every blend mode, with opacity, fill and masks', { timeout: 30_000 }, () => {
    for (const { id: mode } of BLEND_MODES) {
      const bg = pixelLayer('bg', 2, {}, 'opaque');
      const top = pixelLayer('top', 3, { blend: mode, opacity: 0.8, fillOpacity: 0.7, mask: { ...maskFrom(4), density: 0.6 } });
      const layers = [bg, top];
      const got = new LayerCompositor().composite(layers, full, sources);
      const want = reference(layers);
      for (let i = 0; i < got.length; i++) {
        if (Math.abs(got[i] - want[i]) > 1) throw new Error(`${mode} byte ${i}: ${got[i]} vs ${want[i]}`);
      }
      // Usually exact; the compositor folds alpha into one multiply, so allow a rare ±1.
      let exact = 0;
      for (let i = 0; i < got.length; i++) if (got[i] === want[i]) exact++;
      expect(exact / got.length).toBeGreaterThan(0.995);
    }
  });

  it('runs consecutive adjustment layers as one float pass, like applyAdjustmentLayers', () => {
    const bg = pixelLayer('bg', 5, {}, 'opaque');
    const a = adjustment('curves', { master: [{ input: 0, output: 30 }, { input: 255, output: 220 }] });
    const b = adjustment('hueSaturation', { hue: 40, saturation: 20 }, { opacity: 0.6, blend: 'soft-light', mask: maskFrom(6) });
    const got = new LayerCompositor().composite([bg, a, b], full, sources);
    const want = { data: new Uint8ClampedArray(pixels(5, 'opaque').data) };
    const cov = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) cov[p] = maskCov(b.mask!, p);
    const views = [a, b].map((n) => ({ id: n.id, kind: n.kind, enabled: true, opacity: n.opacity, blend: n.blend, params: n.params }) as AdjustmentLayer);
    applyAdjustmentLayers(want, views, new Map([[b.id, cov]]));
    expect(got).toEqual(want.data);
  });

  it('places layers by their offset and leaves the rest transparent', () => {
    const small = { ...pixelLayer('s', 7), surface: surfaceFromPixels(pixels(7, 'opaque', 4, 3), 4), offset: { x: 10, y: 20 } };
    const out = new LayerCompositor().composite([small], full, sources);
    expect(px(out, (20 * W + 10) * 4)).toEqual(px(pixels(7, 'opaque', 4, 3).data, 0));
    expect(px(out, (19 * W + 10) * 4)).toEqual([0, 0, 0, 0]);
    expect(px(out, (22 * W + 13) * 4)).toEqual(px(pixels(7, 'opaque', 4, 3).data, (2 * 4 + 3) * 4));
  });

  it('skips hidden layers, and a hidden base hides the layers clipped to it', () => {
    const bg = pixelLayer('bg', 8, {}, 'opaque');
    const hidden = pixelLayer('h', 9, { visible: false });
    const clipped = pixelLayer('c', 10, { clipped: true });
    const out = new LayerCompositor().composite([bg, hidden, clipped], full, sources);
    expect(out).toEqual(pixels(8, 'opaque').data);
  });

  it('clipped layers paint only inside the base layer and keep its alpha', () => {
    const r = rng(11);
    const shape = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p++) shape.set([200, 10, 10, p % 3 === 0 ? 0 : p % 3 === 1 ? 128 : 255], p * 4);
    const base: PixelLayer = { ...pixelLayer('base', 0), surface: surfaceFromPixels({ width: W, height: H, data: shape }, 4) };
    const fill: PixelLayer = { ...pixelLayer('fill', 0), surface: surfaceFromPixels(pixels(12, 'opaque'), 4), clipped: true };
    const adj = { ...adjustment('invert', {}), clipped: true };
    const out = new LayerCompositor().composite([base, fill, adj], full, sources);
    for (let p = 0; p < W * H; p++) {
      expect(out[p * 4 + 3]).toBe(shape[p * 4 + 3]);
      if (shape[p * 4 + 3] === 255) {
        const f = px(pixels(12, 'opaque').data, p * 4);
        expect(px(out, p * 4).slice(0, 3)).toEqual([255 - f[0], 255 - f[1], 255 - f[2]]);
      }
    }
    void r;
  });

  it('pass-through groups blend their children with what is below; other groups are isolated', () => {
    const bg = pixelLayer('bg', 13, {}, 'opaque');
    const child = pixelLayer('child', 14, { blend: 'multiply' }, 'opaque');
    const group = (blend: GroupLayer['blend']): GroupLayer => ({
      type: 'group',
      id: 'g',
      name: 'g',
      visible: true,
      opacity: 1,
      blend,
      children: [child],
    });
    const through = new LayerCompositor().composite([bg, group('pass-through')], full, sources);
    expect(through).toEqual(reference([bg, child]));
    const isolated = new LayerCompositor().composite([bg, group('normal')], full, sources);
    // Multiply over a transparent group backdrop is the child itself, then normal over bg.
    expect(isolated).toEqual(pixels(14, 'opaque').data);
    // A pass-through group at half opacity is half way between before and after.
    const half = new LayerCompositor().composite([bg, { ...group('pass-through'), opacity: 0.5 }], full, sources);
    const a = pixels(13, 'opaque').data;
    const b = reference([bg, child]);
    for (let i = 0; i < half.length; i++) expect(Math.abs(half[i] - (a[i] + b[i]) / 2)).toBeLessThanOrEqual(0.5);
  });

  it('masks: disabled masks are ignored, feathered masks are blurred, defaults apply outside the canvas', () => {
    const bg = pixelLayer('bg', 15, {}, 'opaque');
    const top = pixelLayer('top', 16, { mask: { ...maskFrom(17), enabled: false } }, 'opaque');
    expect(new LayerCompositor().composite([bg, top], full, sources)).toEqual(pixels(16, 'opaque').data);
    const hideAll: RasterMask = { surface: emptySurface(1, 0), defaultValue: 0 };
    expect(new LayerCompositor().composite([bg, { ...top, mask: hideAll }], full, sources)).toEqual(pixels(15, 'opaque').data);
    const half = writeRegion(emptySurface(1, 0), { x: 0, y: 0, width: W / 2, height: H }, new Uint8ClampedArray((W / 2) * H).fill(255));
    const sharp = new LayerCompositor().composite([bg, { ...top, mask: { surface: half, defaultValue: 0 } }], full, sources);
    const soft = new LayerCompositor().composite([bg, { ...top, mask: { surface: half, defaultValue: 0, feather: 3 } }], full, sources);
    const edge = (19 * 1 + 10) * W * 0 + 10 * W + W / 2; // a pixel just right of the edge
    expect(px(sharp, edge * 4)).toEqual(px(pixels(15, 'opaque').data, edge * 4));
    expect(px(soft, edge * 4)).not.toEqual(px(pixels(15, 'opaque').data, edge * 4));
  });

  it('caches tiles by their inputs and recomposites only from the changed layer up', { timeout: 30_000 }, () => {
    const big = { width: TILE * 2, height: TILE };
    const mk = (id: string, seed: number) => ({ ...pixelLayer(id, 0), surface: surfaceFromPixels(pixels(seed, 'opaque', big.width, big.height), 4) });
    const layers: ImageLayer[] = [mk('a', 20), { ...mk('b', 21), blend: 'screen' as BlendMode, opacity: 0.5 }, adjustment('invert', {}), { ...mk('d', 22), blend: 'multiply' as BlendMode }];
    const c = new LayerCompositor();
    const rect = { x: 0, y: 0, ...big };
    const tiles = new Map<number, Uint8ClampedArray>();
    c.compositeTiles(layers, rect, big, (tx, _ty, data) => tiles.set(tx, data));
    expect(c.lastStats).toEqual({ tiles: 2, cached: 0, stepsRun: 8, effectsBuilt: 0, effectsPatched: 0 });
    // Same inputs: same buffers, nothing run.
    c.compositeTiles(layers, rect, big, (tx, _ty, data, changed) => {
      expect(data).toBe(tiles.get(tx));
      expect(changed).toBe(false);
    });
    expect(c.lastStats.cached).toBe(2);
    // Change the top layer's pixels in the right tile only.
    const d = layers[3] as PixelLayer;
    const edited = { ...d, surface: writeRegion(d.surface, { x: TILE + 3, y: 3, width: 2, height: 2 }, new Uint8ClampedArray(16).fill(9)) };
    const next = [...layers.slice(0, 3), edited];
    const changed: number[] = [];
    c.compositeTiles(next, rect, big, (tx, _ty, _data, ch) => ch && changed.push(tx));
    expect(changed).toEqual([1]);
    expect(c.lastStats).toEqual({ tiles: 2, cached: 1, stepsRun: 4, effectsBuilt: 0, effectsPatched: 0 });
    // A slider drag on the middle layer: the next drags start from the checkpoint below it.
    const drag = (opacity: number) => [layers[0], { ...(layers[1] as PixelLayer), opacity }, layers[2], edited];
    c.compositeTiles(drag(0.4), rect, big, () => {});
    c.compositeTiles(drag(0.3), rect, big, () => {});
    expect(c.lastStats.stepsRun).toBe(2 * 3);
    // A stroke that reports where it painted recomposites only there, with the same result.
    const dirtyRect = { x: TILE - 10, y: 100, width: 30, height: 20 };
    const painted = { ...edited, surface: writeRegion(edited.surface, dirtyRect, new Uint8ClampedArray(30 * 20 * 4).fill(77)) };
    const strokeLayers = [...drag(0.3).slice(0, 3), painted];
    c.compositeTiles(drag(0.3), rect, big, () => {}, { checkpointLayerId: 'd' });
    c.compositeTiles(strokeLayers, rect, big, () => {}, { checkpointLayerId: 'd', dirty: [dirtyRect] });
    // Two tiles, each from the checkpoint the slider drag left below layer b (3 steps).
    expect(c.lastStats.stepsRun).toBe(6);
    expect(Buffer.from(c.composite(strokeLayers, rect, big)).equals(Buffer.from(new LayerCompositor().composite(strokeLayers, rect, big)))).toBe(true);
    // And the result is still what a fresh compositor computes.
    expect(Buffer.from(c.composite(drag(0.3), rect, big)).equals(Buffer.from(new LayerCompositor().composite(drag(0.3), rect, big)))).toBe(true);
  });
});
