import { describe, expect, it } from 'vitest';
import {
  BLEND_MODES,
  PAINTERLY_BLEND_MODES,
  SHADOW_AMBIENT,
  blendChannel,
  blendImageData,
  blendPixel,
  blendRgb,
  canvasCompositeOperation,
  isPainterlyBlendMode,
  isSeparableBlendMode,
  standardBlendMode,
  surfaceFromPixels,
  type BlendMode,
} from '../src/raster';
import { LayerCompositor } from '../src/image-editor';

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

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const lum = (c: readonly number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const randColor = (r: () => number) => [Math.round(r() * 255) / 255, Math.round(r() * 255) / 255, Math.round(r() * 255) / 255];

/** Oklab lightness of an sRGB colour. */
function oklabL(c: readonly number[]): number {
  const [r, g, b] = c.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

describe('painterly blend modes', () => {
  it('are listed after pigment with labels, descriptions and their nearest standard mode', () => {
    expect(PAINTERLY_BLEND_MODES).toEqual(['watercolor', 'tint', 'highlight', 'shadow']);
    const ids = BLEND_MODES.map((m) => m.id);
    expect(ids.slice(-5)).toEqual(['pigment', 'watercolor', 'tint', 'highlight', 'shadow']);
    for (const id of PAINTERLY_BLEND_MODES) {
      const info = BLEND_MODES.find((m) => m.id === id)!;
      expect(info.painterly).toBe(true);
      expect(info.description!.length).toBeGreaterThan(20);
      expect(canvasCompositeOperation(id)).toBeNull();
      expect(isPainterlyBlendMode(id)).toBe(true);
    }
    expect(isPainterlyBlendMode('multiply')).toBe(false);
    expect(isPainterlyBlendMode('pigment')).toBe(false);
    expect(standardBlendMode('watercolor')).toBe('multiply');
    expect(standardBlendMode('tint')).toBe('color');
    expect(standardBlendMode('highlight')).toBe('screen');
    expect(standardBlendMode('shadow')).toBe('multiply');
    expect(standardBlendMode('pigment')).toBe('normal');
    expect(standardBlendMode('overlay')).toBe('overlay');
    // Highlight and shadow work channel by channel (the compositor's LUT); watercolour and tint on whole colours.
    expect(isSeparableBlendMode('highlight')).toBe(true);
    expect(isSeparableBlendMode('shadow')).toBe(true);
    expect(isSeparableBlendMode('watercolor')).toBe(false);
    expect(isSeparableBlendMode('tint')).toBe(false);
  });

  it('watercolor: white is clear, black is opaque, and washes only darken', () => {
    const r = rng(11);
    for (let i = 0; i < 200; i++) {
      const b = randColor(r);
      const s = randColor(r);
      expect(blendRgb('watercolor', b, [1, 1, 1])).toEqual(b);
      expect(blendRgb('watercolor', [1, 1, 1], s)).toEqual(s);
      expect(blendRgb('watercolor', b, [0, 0, 0])).toEqual([0, 0, 0]);
      const o = blendRgb('watercolor', b, s);
      // Reflectances multiply per wavelength, so the result is no lighter than either colour.
      expect(lum(o)).toBeLessThanOrEqual(Math.min(lum(b), lum(s)) + 0.01);
      // Order does not matter: the product commutes.
      const p = blendRgb('watercolor', s, b);
      for (let k = 0; k < 3; k++) expect(Math.abs(o[k] - p[k])).toBeLessThan(1e-9);
    }
  });

  it('watercolor glazes blue over yellow into green, where RGB multiply gives black', () => {
    const wash = blendRgb('watercolor', [1, 1, 0], [0, 0, 1]);
    expect(blendRgb('multiply', [1, 1, 0], [0, 0, 1])).toEqual([0, 0, 0]);
    expect(wash[1]).toBeGreaterThan(0.15);
    expect(wash[1]).toBeGreaterThan(wash[0]);
    // A second identical wash darkens further.
    const twice = blendRgb('watercolor', wash, [0, 0, 1]);
    expect(lum(twice)).toBeLessThan(lum(wash));
  });

  it('tint keeps the backdrop lightness and takes the source hue, gently at white and black', () => {
    const r = rng(12);
    for (let i = 0; i < 200; i++) {
      const b = randColor(r);
      const s = randColor(r);
      const o = blendRgb('tint', b, s);
      for (const v of o) expect(v >= 0 && v <= 1).toBe(true);
      expect(Math.abs(oklabL(o) - oklabL(b))).toBeLessThan(0.01);
    }
    expect(blendRgb('tint', [1, 1, 1], [0.9, 0.1, 0.1]).map((v) => Math.round(v * 255))).toEqual([255, 255, 255]);
    expect(blendRgb('tint', [0, 0, 0], [0.9, 0.1, 0.1]).map((v) => Math.round(v * 255))).toEqual([0, 0, 0]);
    // Blue over yellow is a light blue, not the grey an average of opposite hues would give.
    const o = blendRgb('tint', [0.95, 0.78, 0.29], [0.16, 0.29, 0.55]);
    expect(o[2]).toBeGreaterThan(o[0] + 0.05);
    // A grey source neutralises.
    const g = blendRgb('tint', [0.8, 0.3, 0.2], [0.5, 0.5, 0.5]);
    expect(Math.max(...g) - Math.min(...g)).toBeLessThan(0.02);
  });

  it('highlight adds light with a soft shoulder: black adds nothing and nothing clips below white', () => {
    for (let b = 0; b <= 255; b += 5) {
      expect(blendChannel('highlight', b / 255, 0)).toBeCloseTo(b / 255, 12);
      let prev = -1;
      for (let s = 0; s <= 255; s += 5) {
        const o = blendChannel('highlight', b / 255, s / 255);
        expect(o).toBeGreaterThanOrEqual(b / 255 - 1e-12);
        expect(o).toBeGreaterThanOrEqual(prev);
        if (b < 255) expect(o).toBeLessThan(1);
        prev = o;
      }
    }
    // A little light adds almost exactly its linear amount.
    const o = blendChannel('highlight', 0.4, 0.05);
    expect(lin(o) - lin(0.4)).toBeCloseTo(lin(0.05), 3);
    // Full white over black is bright but not blown out, unlike linear dodge or screen.
    expect(blendChannel('highlight', 0, 1)).toBeCloseTo(enc(1 - Math.exp(-1)), 9);
    expect(blendChannel('screen', 0, 1)).toBe(1);
  });

  it('shadow takes light away with ambient fill: white does nothing, black keeps a fifth of the light', () => {
    for (let b = 0; b <= 255; b += 5) {
      expect(blendChannel('shadow', b / 255, 1)).toBeCloseTo(b / 255, 12);
      expect(blendChannel('shadow', b / 255, 0)).toBeCloseTo(enc(lin(b / 255) * SHADOW_AMBIENT), 9);
      for (let s = 0; s <= 255; s += 15) expect(blendChannel('shadow', b / 255, s / 255)).toBeLessThanOrEqual(b / 255 + 1e-12);
    }
    // A blue shadow over yellow cools it to an olive, not black.
    const o = blendRgb('shadow', [0.95, 0.78, 0.29], [0.16, 0.29, 0.55]);
    expect(Math.min(...o)).toBeGreaterThan(0.05);
  });

  it("composite through the image editor's compositor exactly like blendPixel, at any opacity and alpha", () => {
    const w = 40;
    const h = 24;
    const bg = randomPixels(21, w, h, false);
    const top = randomPixels(22, w, h, false);
    const full = { x: 0, y: 0, width: w, height: h };
    const layer = (id: string, data: Uint8ClampedArray, blend: string, opacity = 1) => ({
      type: 'pixel' as const, id, name: id, visible: true, opacity, blend, surface: surfaceFromPixels({ width: w, height: h, data }, 4), offset: { x: 0, y: 0 },
    });
    for (const mode of PAINTERLY_BLEND_MODES) {
      const out = new LayerCompositor().composite([layer('bg', bg, 'normal'), layer('top', top, mode, 0.7)], full, { width: w, height: h, version: 'v' });
      let worst = 0;
      for (let i = 0; i < out.length; i += 4) {
        const want = blendPixel(mode, Array.from(bg.slice(i, i + 4), (v) => v / 255), Array.from(top.slice(i, i + 4), (v) => v / 255), 0.7);
        for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(out[i + k] - Math.round(want[k] * 255)));
      }
      expect(worst, mode).toBeLessThanOrEqual(1);
    }
  });

  it('blendImageData (the canvas fallback) matches blendPixel', () => {
    for (const mode of PAINTERLY_BLEND_MODES as BlendMode[]) {
      const back = { data: randomPixels(31, 8, 8, false) } as ImageData;
      const src = { data: randomPixels(32, 8, 8, false) } as ImageData;
      const before = new Uint8ClampedArray(back.data);
      blendImageData(back, src, mode, 0.5);
      for (let i = 0; i < before.length; i += 4) {
        if (src.data[i + 3] === 0) continue;
        const o = blendPixel(mode, Array.from(before.slice(i, i + 4), (v) => v / 255), Array.from(src.data.slice(i, i + 4), (v) => v / 255), 0.5);
        for (let k = 0; k < 4; k++) expect(Math.abs(back.data[i + k] - Math.round(o[k] * 255))).toBeLessThanOrEqual(1);
      }
    }
  });
});
