// Blend and histogram cases re-expressed from photocraft-main/crates/color/src/blend.rs and crates/algo/src/histogram.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
  BLEND_MODES,
  ImageEditorRenderer,
  HISTOGRAM_BINS,
  blendChannel,
  blendImageData,
  blendLum,
  blendPixel,
  blendRgb,
  canvasCompositeOperation,
  computeHistogram,
  histogramPath,
  isSeparableBlendMode,
  normalizeBlendMode,
  setLum,
  type BlendMode,
} from '../src/image-editor';

const E = 1e-6;
const close = (a: number, b: number, e = 1e-5) => Math.abs(a - b) < e;

describe('blend modes', () => {
  it('has 26 Photoshop modes plus pigment and four painterly modes, with unique ids', () => {
    expect(BLEND_MODES).toHaveLength(31);
    expect(new Set(BLEND_MODES.map((m) => m.id)).size).toBe(31);
    expect(normalizeBlendMode('bogus')).toBe('normal');
    expect(normalizeBlendMode('pin-light')).toBe('pin-light');
  });

  it('maps to canvas composite operations only where the maths match', () => {
    expect(canvasCompositeOperation('multiply')).toBe('multiply');
    expect(canvasCompositeOperation('normal')).toBe('source-over');
    expect(canvasCompositeOperation('soft-light')).toBeNull();
    expect(canvasCompositeOperation('linear-burn')).toBeNull();
    expect(canvasCompositeOperation(undefined)).toBe('source-over');
  });

  it('normal is the source', () => {
    for (const [cb, cs] of [[0.2, 0.7], [1, 0], [0, 1]]) expect(blendChannel('normal', cb, cs)).toBe(cs);
  });

  it('identities with white, black and 50% grey', () => {
    for (const cb of [0, 0.1, 0.5, 0.9, 1]) {
      expect(close(blendChannel('multiply', cb, 1), cb)).toBe(true);
      expect(close(blendChannel('screen', cb, 0), cb)).toBe(true);
      expect(close(blendChannel('linear-dodge', cb, 0), cb)).toBe(true);
      expect(close(blendChannel('darken', cb, 1), cb)).toBe(true);
      expect(close(blendChannel('lighten', cb, 0), cb)).toBe(true);
      expect(close(blendChannel('difference', cb, 0), cb)).toBe(true);
      expect(close(blendChannel('subtract', cb, 0), cb)).toBe(true);
      expect(close(blendChannel('linear-burn', cb, 1), cb)).toBe(true);
      expect(close(blendChannel('exclusion', cb, 0), cb)).toBe(true);
      expect(close(blendChannel('hard-light', cb, 0.5), cb)).toBe(true);
      expect(close(blendChannel('soft-light', cb, 0.5), cb)).toBe(true);
      expect(close(blendChannel('linear-light', cb, 0.5), cb)).toBe(true);
    }
  });

  it('known values', () => {
    const cases: [BlendMode, number, number, number][] = [
      ['multiply', 0.5, 0.5, 0.25],
      ['screen', 0.5, 0.5, 0.75],
      ['overlay', 0.25, 0.5, 0.25],
      ['overlay', 0.75, 1, 1],
      ['color-dodge', 0.5, 0.5, 1],
      ['color-burn', 0.5, 0.5, 0],
      ['color-burn', 1, 0, 1],
      ['color-dodge', 0, 1, 0],
      ['divide', 0.25, 0.5, 0.5],
      ['divide', 0, 0, 0],
      ['divide', 0.3, 0, 1],
      ['exclusion', 0.5, 0.5, 0.5],
      ['pin-light', 0.8, 0.2, 0.4],
      ['pin-light', 0.1, 0.9, 0.8],
      ['hard-mix', 0.6, 0.4, 1],
      ['hard-mix', 0.6, 0.3, 0],
      ['vivid-light', 0.75, 0.25, 0.5],
      ['vivid-light', 0.25, 0.75, 0.5],
      ['linear-dodge', 0.75, 0.5, 1],
    ];
    for (const [mode, cb, cs, want] of cases) expect(close(blendChannel(mode, cb, cs), want), `${mode} ${cb} ${cs}`).toBe(true);
    // Photoshop soft light differs from W3C in the upper half: 2·cb·(1 − cs) + √cb·(2cs − 1).
    expect(close(blendChannel('soft-light', 0.25, 1), 0.5)).toBe(true);
  });

  it('vivid light and hard mix extremes', () => {
    for (const cb of [0, 0.25, 0.5, 0.75, 1]) {
      expect(blendChannel('vivid-light', cb, 0)).toBe(0);
      expect(blendChannel('vivid-light', cb, 1)).toBe(1);
    }
    expect(blendChannel('hard-mix', 1, 0)).toBe(1);
    expect(blendChannel('hard-mix', 0, 1)).toBe(0);
    expect(blendChannel('hard-mix', 1 - 1e-5, 0)).toBe(1);
    expect(blendChannel('hard-mix', 1e-5, 1)).toBe(0);
    expect(blendPixel('vivid-light', [1, 1, 1, 1], [0, 0, 0, 1])).toEqual([0, 0, 0, 1]);
    expect(blendPixel('hard-mix', [0, 0, 0, 1], [1, 1, 1, 1])).toEqual([0, 0, 0, 1]);
  });

  it('every mode stays in 0..1 on in-range input', () => {
    const steps = Array.from({ length: 21 }, (_, i) => i / 20);
    for (const { id } of BLEND_MODES) {
      for (const cb of steps) {
        for (const cs of steps) {
          for (const v of blendRgb(id, [cb, cs, 0.5], [cs, cb, 0.25])) {
            expect(v >= -E && v <= 1 + E, `${id} ${cb} ${cs} -> ${v}`).toBe(true);
          }
        }
      }
    }
  });

  it('non-separable modes swap hue / saturation / luminosity', () => {
    const cb = [0.8, 0.2, 0.2];
    const cs = [0.1, 0.1, 0.9];
    expect(close(blendLum(blendRgb('luminosity', cb, cs)), blendLum(cs))).toBe(true);
    expect(close(blendLum(blendRgb('color', cb, cs)), blendLum(cb))).toBe(true);
    expect(close(blendLum(blendRgb('hue', cb, cs)), blendLum(cb))).toBe(true);
    const s = blendRgb('saturation', cb, [0.5, 0.5, 0.5]);
    expect(close(s[0], s[1]) && close(s[1], s[2])).toBe(true);
    expect(isSeparableBlendMode('hue')).toBe(false);
    expect(isSeparableBlendMode('pin-light')).toBe(true);
  });

  it('hardened ClipColor: an out-of-range luminosity gives its grey, never an inside-out colour', () => {
    const r = setLum([0.5, 0.25, 0.125], 2);
    expect(r.every((v) => close(v, 2))).toBe(true);
    for (const l of [0, 0.3, 0.7, 1]) {
      const c = setLum([0.9, 0.1, 0.4], l);
      expect(close(blendLum(c), l, 1e-4)).toBe(true);
      expect(Math.min(...c)).toBeGreaterThanOrEqual(-E);
      expect(Math.max(...c)).toBeLessThanOrEqual(1 + E);
    }
  });

  it('darker / lighter colour pick whole pixels', () => {
    const a = [0.9, 0.1, 0.1];
    const b = [0.2, 0.6, 0.2];
    expect(blendRgb('darker-color', a, b)).toEqual(blendLum(b) < blendLum(a) ? b : a);
    expect(blendRgb('lighter-color', a, b)).toEqual(blendLum(b) > blendLum(a) ? b : a);
  });

  it('composites with the W3C alpha rules', () => {
    const bg = [0.2, 0.4, 0.6, 1];
    expect(blendPixel('multiply', bg, [1, 0, 0, 0])).toEqual(bg);
    const r = blendPixel('normal', bg, [1, 0, 0, 1]);
    expect(close(r[0], 1) && close(r[3], 1)).toBe(true);
    const half = blendPixel('normal', bg, [1, 1, 1, 1], 0.5);
    expect(close(half[0], 0.6) && close(half[1], 0.7) && close(half[2], 0.8)).toBe(true);
    const overClear = blendPixel('multiply', [0, 0, 0, 0], [0.3, 0.5, 0.7, 1]);
    expect(close(overClear[0], 0.3) && close(overClear[1], 0.5) && close(overClear[2], 0.7) && close(overClear[3], 1)).toBe(true);
    expect(close(blendPixel('screen', [0, 0, 0, 0.5], [0, 0, 0, 0.5])[3], 0.75)).toBe(true);
  });

  it('blendImageData blends 8-bit pixels in place and skips transparent source pixels', () => {
    const back = { width: 2, height: 1, data: new Uint8ClampedArray([128, 128, 128, 255, 10, 20, 30, 255]) } as ImageData;
    const src = { width: 2, height: 1, data: new Uint8ClampedArray([128, 255, 0, 255, 255, 255, 255, 0]) } as ImageData;
    blendImageData(back, src, 'multiply');
    expect(Array.from(back.data)).toEqual([64, 128, 0, 255, 10, 20, 30, 255]);
  });
});

describe('histogram', () => {
  const img = (pixels: number[][]) => ({ width: pixels.length, height: 1, data: new Uint8ClampedArray(pixels.flat()) });

  it('counts exact bins per channel and luminance', () => {
    const pixels = Array.from({ length: 256 }, (_, i) => [i, 255 - i, 128, 64]);
    const h = computeHistogram(img(pixels));
    expect(h.samples).toBe(256);
    expect(Array.from(h.red).every((v) => v === 1)).toBe(true);
    expect(Array.from(h.green).every((v) => v === 1)).toBe(true);
    expect(h.blue[128]).toBe(256);
    for (const bins of [h.red, h.green, h.blue, h.luminance]) {
      expect(bins.length).toBe(HISTOGRAM_BINS);
      expect(bins.reduce((a, b) => a + b, 0)).toBe(h.samples);
    }
    expect(h.max).toBe(256);
  });

  it('excludes transparent pixels and counts clipping at the exact endpoints', () => {
    const h = computeHistogram(img([[255, 255, 255, 0], [1, 254, 0, 255], [0, 255, 0, 255], [10, 10, 10, 0]]));
    expect(h.samples).toBe(2);
    expect(h.transparent).toBe(2);
    expect(h.shadows).toEqual([1, 0, 2]);
    expect(h.highlights).toEqual([0, 1, 0]);
    expect(h.red[255]).toBe(0);
    expect(computeHistogram(img([])).samples).toBe(0);
  });

  it('luminance uses Rec.709 weights', () => {
    const h = computeHistogram(img([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]));
    expect(h.luminance[54]).toBe(1);
    expect(h.luminance[182]).toBe(1);
    expect(h.luminance[18]).toBe(1);
  });

  it('builds an SVG path that spans the box', () => {
    const h = computeHistogram(img([[0, 0, 0, 255], [255, 255, 255, 255]]));
    const d = histogramPath(h, 'luminance', 256, 100);
    expect(d.startsWith('M0 100')).toBe(true);
    expect(d.endsWith('L256 100 Z')).toBe(true);
    expect(d).toContain('L0 0');
    expect(histogramPath(computeHistogram(img([])), 'red', 10, 10)).not.toContain('NaN');
  });
});

describe('annotation blend modes', () => {
  const recordingContext = () => {
    const ops: string[] = [];
    const target: Record<string | symbol, unknown> = {};
    const ctx = new Proxy(target, {
      get: (t, k) => (k in t ? t[k] : () => {}),
      set: (t, k, v) => {
        if (k === 'globalCompositeOperation') ops.push(v);
        t[k] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, ops };
  };
  const rect = { id: 'a', type: 'rect' as const, x: 0, y: 0, width: 5, height: 5, strokeColor: '#f00', strokeWidth: 1 };

  it('uses the canvas composite operation when it matches', async () => {
    const { ctx, ops } = recordingContext();
    await new ImageEditorRenderer().drawAnnotation(ctx, { ...rect, blend: 'multiply' });
    expect(ops).toEqual(['multiply']);
  });

  it('draws normally without a blend, or without pixel access for scalar-only modes', async () => {
    for (const blend of [undefined, 'normal', 'soft-light'] as const) {
      const { ctx, ops } = recordingContext();
      await new ImageEditorRenderer().drawAnnotation(ctx, { ...rect, blend });
      expect(ops).toEqual([]);
    }
  });
});
