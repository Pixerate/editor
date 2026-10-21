import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  BLEND_MODES,
  ImageEditorController,
  LayerCompositor,
  applyAdjustmentLayers,
  blendImageData,
  blendPixel,
  canvasCompositeOperation,
  createAdjustmentLayer,
  createImageEditorToolProvider,
  isSeparableBlendMode,
  readPixel,
  surfaceFromPixels,
  type AdjustmentLayer,
  type PixelLayer,
} from '../src/image-editor';
import { lerpPigment } from '../src/paint';
import { readPsd } from '../src/image-editor/psd/file';
import { baseToolName } from '../src/tools';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomPixels(seed: number, w: number, h: number, opaque: boolean): Uint8ClampedArray {
  const r = rng(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(r() * 256);
    data[i + 1] = Math.floor(r() * 256);
    data[i + 2] = Math.floor(r() * 256);
    data[i + 3] = opaque ? 255 : Math.floor(r() * 256);
  }
  return data;
}

function layer(id: string, w: number, h: number, data: Uint8ClampedArray, extra: Partial<PixelLayer> = {}): PixelLayer {
  return { type: 'pixel', id, name: id, visible: true, opacity: 1, blend: 'normal', surface: surfaceFromPixels({ width: w, height: h, data }, 4), offset: { x: 0, y: 0 }, ...extra };
}

const rgb = (d: ArrayLike<number>, i: number): [number, number, number] => [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
const sources = (w: number, h: number) => ({ width: w, height: h, version: 'v' });

describe('pigment blend mode', () => {
  it('is listed, has no canvas operation and is not separable', () => {
    expect(BLEND_MODES.map((m) => m.id)).toContain('pigment');
    expect(BLEND_MODES.find((m) => m.id === 'pigment')!.label).toBe('Pigment');
    expect(canvasCompositeOperation('pigment')).toBeNull();
    expect(isSeparableBlendMode('pigment')).toBe(false);
  });

  it('blendPixel is lerpPigment over an opaque backdrop, the source over a clear one', () => {
    const blue = [0.1, 0.2, 0.9, 1];
    const yellow = [0.95, 0.85, 0.1, 1];
    for (const a of [0.25, 0.5, 0.8]) {
      const got = blendPixel('pigment', blue, yellow, a);
      const want = lerpPigment([0.1, 0.2, 0.9], [0.95, 0.85, 0.1], a);
      for (let c = 0; c < 3; c++) expect(got[c]).toBeCloseTo(want[c], 6);
      expect(got[3]).toBe(1);
    }
    // Half and half is green, not grey.
    const mid = blendPixel('pigment', blue, yellow, 0.5);
    expect(mid[1]).toBeGreaterThan(mid[0]);
    expect(mid[1]).toBeGreaterThan(mid[2]);
    expect(blendPixel('pigment', blue, yellow, 0)).toEqual(blue);
    expect(blendPixel('pigment', blue, yellow, 1)).toEqual(yellow);
    // Over transparent there is nothing to mix with: the source colour at the source alpha.
    expect(blendPixel('pigment', [0.3, 0.3, 0.3, 0], [0.95, 0.85, 0.1, 0.5])).toEqual([0.95, 0.85, 0.1, 0.5]);
    // Over half-transparent the share of source is its amount: αs / αo.
    const part = blendPixel('pigment', [0.1, 0.2, 0.9, 0.5], yellow, 0.5);
    expect(part[3]).toBeCloseTo(0.75, 9);
    const want = lerpPigment([0.1, 0.2, 0.9], [0.95, 0.85, 0.1], 0.5 / 0.75);
    for (let c = 0; c < 3; c++) expect(part[c]).toBeCloseTo(want[c], 6);
  });

  it('the compositor equals lerpPigment per pixel, and opacity 0 and 1 are exact', () => {
    const w = 48;
    const h = 40;
    const bg = randomPixels(1, w, h, true);
    const top = randomPixels(2, w, h, false);
    const c = new LayerCompositor();
    const full = { x: 0, y: 0, width: w, height: h };
    const opacity = 0.6;
    const out = c.composite([layer('bg', w, h, bg), layer('top', w, h, top, { blend: 'pigment', opacity })], full, sources(w, h));
    let worst = 0;
    for (let i = 0; i < out.length; i += 4) {
      const as = (top[i + 3] / 255) * opacity;
      const want = as > 0 ? lerpPigment(rgb(bg, i), rgb(top, i), as) : rgb(bg, i);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[i + k] - Math.round(want[k] * 255)));
      expect(out[i + 3]).toBe(255);
    }
    expect(worst).toBeLessThanOrEqual(1);

    const none = new LayerCompositor().composite([layer('bg', w, h, bg), layer('top', w, h, top, { blend: 'pigment', opacity: 0 })], full, sources(w, h));
    expect(Array.from(none)).toEqual(Array.from(bg));
    const opaqueTop = randomPixels(3, w, h, true);
    const all = new LayerCompositor().composite([layer('bg', w, h, bg), layer('top', w, h, opaqueTop, { blend: 'pigment', opacity: 1 })], full, sources(w, h));
    expect(Array.from(all)).toEqual(Array.from(opaqueTop));
  });

  it('works on groups and adjustment layers', () => {
    const w = 16;
    const h = 16;
    const bg = randomPixels(4, w, h, true);
    const top = randomPixels(5, w, h, true);
    const full = { x: 0, y: 0, width: w, height: h };
    const group = { type: 'group', id: 'g', name: 'g', visible: true, opacity: 0.5, blend: 'pigment', children: [layer('top', w, h, top)] } as const;
    const out = new LayerCompositor().composite([layer('bg', w, h, bg), group as never], full, sources(w, h));
    for (let i = 0; i < out.length; i += 4) {
      const want = lerpPigment(rgb(bg, i), rgb(top, i), 0.5);
      for (let k = 0; k < 3; k++) expect(Math.abs(out[i + k] - Math.round(want[k] * 255))).toBeLessThanOrEqual(1);
    }
    // An invert adjustment at 50 % pigment mixes each colour with its complement.
    const adj = createAdjustmentLayer('invert', { opacity: 0.5, blend: 'pigment' }) as AdjustmentLayer;
    const img = { data: new Uint8ClampedArray([20, 60, 230, 255]) };
    applyAdjustmentLayers(img, [adj]);
    const want = lerpPigment([20 / 255, 60 / 255, 230 / 255], [235 / 255, 195 / 255, 25 / 255], 0.5);
    for (let k = 0; k < 3; k++) expect(Math.abs(img.data[k] - Math.round(want[k] * 255))).toBeLessThanOrEqual(1);
  });

  it('blendImageData (the canvas fallback) matches blendPixel', () => {
    const back = { data: randomPixels(6, 8, 8, false) } as ImageData;
    const src = { data: randomPixels(7, 8, 8, false) } as ImageData;
    const before = new Uint8ClampedArray(back.data);
    blendImageData(back, src, 'pigment', 0.7);
    for (let i = 0; i < before.length; i += 4) {
      if (src.data[i + 3] === 0) continue;
      const o = blendPixel('pigment', Array.from(before.slice(i, i + 4), (v) => v / 255), Array.from(src.data.slice(i, i + 4), (v) => v / 255), 0.7);
      for (let k = 0; k < 4; k++) expect(Math.abs(back.data[i + k] - Math.round(o[k] * 255))).toBeLessThanOrEqual(1);
    }
  });

  it('composites a 1024² pigment layer in reasonable time', () => {
    const n = 1024;
    const bg = randomPixels(8, n, n, true);
    // A painted layer: a few hundred distinct colours, like brush strokes or a palette.
    const r = rng(9);
    const palette = Array.from({ length: 256 }, () => [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)]);
    const top = new Uint8ClampedArray(n * n * 4);
    for (let i = 0; i < top.length; i += 4) top.set([...palette[(i >> 6) & 255], 255], i);
    const full = { x: 0, y: 0, width: n, height: n };
    const t0 = performance.now();
    new LayerCompositor().composite([layer('bg', n, n, bg), layer('top', n, n, top, { blend: 'pigment', opacity: 0.5 })], full, sources(n, n));
    const ms = performance.now() - t0;
    // Random-noise backdrop: one spectrum per pixel, the worst case (about 0.75 s on an M-series Mac, against 15 ms for normal).
    console.log(`pigment 1024² composite: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(15_000);
  }, 30_000);
});

describe('pigment blend mode through the image editor', () => {
  function setup() {
    const W = 20;
    const H = 10;
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i += 4) data.set([30, 60, 220, 255], i);
    c.setSamplePixels({ width: W, height: H, data });
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    return { c, registry };
  }

  it('fill_pixels and paint_stroke accept pigment and mix like paint', async () => {
    const { c, registry } = setup();
    const id = c.addPixelLayer({ name: 'Paint', color: '#1e3cdc' });
    for (const name of ['fill_pixels', 'paint_stroke']) {
      const tool = (await registry.listTools()).tools.find((t) => baseToolName(t.name) === name)!;
      const props = tool.inputSchema.properties as Record<string, { enum?: string[] } & Record<string, unknown>>;
      const blend = name === 'fill_pixels' ? props.blend : (props.brush as { properties: Record<string, { enum?: string[] }> }).properties.blend;
      expect(blend.enum).toContain('pigment');
    }
    const fill = await registry.callTool('fill_pixels', { color: '#f2d81a', opacity: 0.5, blend: 'pigment', useSelection: false });
    expect(fill.isError).toBeFalsy();
    const l = c.getLayer(id) as PixelLayer;
    const got = readPixel(l.surface, 5, 5);
    const want = lerpPigment([30 / 255, 60 / 255, 220 / 255], [0xf2 / 255, 0xd8 / 255, 0x1a / 255], 0.5);
    for (let k = 0; k < 3; k++) expect(Math.abs(got[k] - Math.round(want[k] * 255))).toBeLessThanOrEqual(1);
    expect(got[1]).toBeGreaterThan(got[0]);

    const stroke = await registry.callTool('paint_stroke', { points: [{ x: 2, y: 8 }, { x: 18, y: 8 }], color: '#ffffff', brush: { size: 3, blend: 'pigment', opacity: 0.5 } });
    expect(stroke.isError).toBeFalsy();
    const bad = await registry.callTool('fill_pixels', { blend: 'pigmentt' });
    expect(bad.isError).toBe(true);
  });

  it('set_layer_properties takes pigment, and PSD export writes Normal with a warning naming the layer', async () => {
    const { c, registry } = setup();
    const id = c.addPixelLayer({ name: 'Glaze', color: '#f2d81a' });
    const res = await registry.callTool('set_layer_properties', { layerId: id, blend: 'pigment', opacity: 0.5 });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(c.getLayer(id)!.blend).toBe('pigment');
    const merged = c.compositePixels().data;
    const { bytes, warnings } = await c.toPsd();
    expect(warnings).toEqual(['The Pigment blend mode has no PSD equivalent and was written as Normal (layer "Glaze").']);
    const psd = readPsd(bytes);
    const rec = psd.layers.find((r) => r.legacyName === 'Glaze')!;
    expect(rec.blendKey).toBe('norm');
    // The state is untouched and the merged image keeps the paint mix.
    expect(c.getLayer(id)!.blend).toBe('pigment');
    expect(Array.from(c.compositePixels().data)).toEqual(Array.from(merged));
    // Import never produces it.
    const reopened = new ImageEditorController({});
    reopened.loadPsd(bytes);
    expect(reopened.getLayers().map((l) => l.blend)).not.toContain('pigment');
  });
});
