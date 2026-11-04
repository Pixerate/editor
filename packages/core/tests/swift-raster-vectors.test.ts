import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, constants as zc } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BLEND_MODES,
  blendChannel,
  blendImageData,
  blendPixel,
  blendRgb,
  blendTile,
  buildEffectMaps,
  builtinPattern,
  builtinPatternIds,
  canvasCompositeOperation,
  changedTiles,
  compositeLayerEffects,
  compositeSurfaceOver,
  contentBounds,
  contourLut,
  convertSurfaceDepth,
  curveLut,
  DeepCompositor,
  deepTile,
  defaultLayerEffect,
  effectColorHex,
  effectFillColors,
  effectReach,
  effectsAreLocal,
  effectsFingerprint,
  effectsMargin,
  emptySurface,
  fillRect,
  findLayer,
  flattenLayers,
  gaussianBlur,
  gradientT,
  hashNoise,
  insertLayer,
  isSeparableBlendMode,
  keepDeepSamples,
  keysWeight,
  layerEffectControls,
  layerEffectFields,
  layerEffectsPanel,
  effectControlChange,
  LAYER_EFFECT_KINDS,
  mapLayer,
  mergeLayerEffect,
  mixPigment8,
  mixPigmentRgb,
  normalizeLayerEffects,
  parseEffectColor,
  PatternPlacement,
  PatternTile,
  RasterCompositor,
  readDeepRegion,
  readPixel,
  readRegion,
  reduceSurface,
  renderLayerEffects,
  scaleLayerEffect,
  solidSurface,
  srgbDecode,
  srgbEncode,
  standardBlendMode,
  surfaceBytes,
  SurfaceDraft,
  surfaceDepth,
  surfaceFromDeepPixels,
  surfaceFromPixels,
  surfaceMipLevel,
  surfaceResolutionForZoom,
  surfacesEqual,
  SurfaceViewportRenderer,
  tileCoord,
  tileKey,
  tilesInRect,
  to16From32,
  to16From8,
  to32From16,
  to32From8,
  to8From16,
  to8From32,
  transformSurface,
  translateSurface,
  validateLayerEffect,
  validateLayerEffects,
  visibleSurfaceRect,
  warpSurface,
  workingToSamples,
  worldRectToSurface,
  worldToSurface,
  surfaceToWorld,
  writeDeepRegion,
  writeRegion,
  type BlendMode,
  type CompositorLayer,
  type CompositorProfile,
  type EffectContext,
  type LayerEffect,
  type LayerEffects,
  type RasterRect,
  type TiledSurface,
} from '../src/raster';
import { createPigment, lerpPigment, mixPigments, reflectanceToRgb, rgbToReflectance } from '../src/raster/pigment';
import { adler32, deflate, deflateRaw, inflate, inflateRaw } from '../src/raster/zlib';
import { base64ToBytes, bytesToBase64, decodePng, encodePng, parseDataUrl } from '../src/raster/png';
import { applyHomography, homographyFromPoints, invertHomography, multiplyHomographies, orderQuad, rectToQuad, isConvexQuad, homographyFrontSide, cornerBounds } from '../src/geom/homography';
import type { Homography } from '../src/geom/types';

/**
 * Test vectors the Swift raster module (`packages/swift`, `PixerateRaster`) checks itself
 * against: blend modes, surfaces, deep samples, pigment mixing, blur, curves, transforms, the
 * compositors, every layer effect, patterns, the effects panel model, PNG / zlib bytes and the
 * viewport maths. Computed here from the TS raster module; a drift from the committed file fails
 * this test (run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an intended change, then rerun
 * the Swift tests).
 *
 * Numbers that went through `Math.exp`, `pow`, `cbrt`, `sin`, … are stored as `Math.fround`
 * (V8 rounds those differently in the last bit on x64 and arm64, and this file must not change
 * with the machine); pixels are bytes or Float32 samples, which absorb that.
 */
const FILE = join(__dirname, '../../swift/Tests/PixerateRasterTests/Fixtures/raster-vectors.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const b64 = (a: ArrayLike<number> | Uint8Array | Uint8ClampedArray) => Buffer.from(a instanceof Uint8Array || a instanceof Uint8ClampedArray ? a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength) : Uint8Array.from(a)).toString('base64');
const b64f = (a: Float32Array) => Buffer.from(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)).toString('base64');
const b64u16 = (a: Uint16Array) => Buffer.from(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)).toString('base64');
const fromB64 = (s: string) => new Uint8ClampedArray(Buffer.from(s, 'base64'));
const f32 = (v: number) => Math.fround(v);

/** A seeded LCG in 0..1 (the inputs are stored in the file, so only TS runs it). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** RGBA pixels: a colour gradient with alpha from `alpha(x, y)`. */
function gradientPixels(w: number, h: number, seed: number, alpha: (x: number, y: number) => number): Uint8ClampedArray {
  const r = lcg(seed);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = Math.round((x / Math.max(1, w - 1)) * 255);
      out[i + 1] = Math.round((y / Math.max(1, h - 1)) * 255);
      out[i + 2] = Math.floor(r() * 256);
      out[i + 3] = alpha(x, y);
    }
  }
  return out;
}

/** A soft-edged disc of one colour (RGBA), centred at (cx, cy). */
function disc(w: number, h: number, cx: number, cy: number, radius: number, rgb: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
      const a = Math.max(0, Math.min(1, radius - d + 0.5));
      const i = (y * w + x) * 4;
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

/** A rectangle with a soft corner notch (RGBA), so chamfer and Euclidean distances differ. */
function shapePixels(w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inRect = x >= 9 && x < 25 && y >= 10 && y < 22;
      const notch = x >= 19 && y >= 17;
      let a = inRect && !notch ? 255 : 0;
      if (inRect && x === 9) a = 128;
      if (inRect && y === 21 && !notch) a = 200;
      out[i] = 40 + x * 5;
      out[i + 1] = 200 - y * 4;
      out[i + 2] = 120;
      out[i + 3] = a;
    }
  }
  return out;
}

interface PixelSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  channels: 1 | 4;
  defaultValue: number;
  data: string;
}

const surfaceSpec = (x: number, y: number, width: number, height: number, data: ArrayLike<number>, channels: 1 | 4 = 4, defaultValue = 0): PixelSpec => ({ x, y, width, height, channels, defaultValue, data: b64(data) });
const surfaceOf = (s: PixelSpec) => surfaceFromPixels({ width: s.width, height: s.height, data: fromB64(s.data) }, s.channels, s.x, s.y, s.defaultValue);

const ctx: EffectContext = {
  light: { angle: 120, altitude: 30 },
  pattern: (id) => {
    const p = builtinPattern(id);
    return p ? new PatternTile(p) : null;
  },
};

// ---------------------------------------------------------------------------
// Blend modes
// ---------------------------------------------------------------------------

const MODES = BLEND_MODES.map((m) => m.id);
/** Modes whose maths goes through exp / pow / cbrt or the pigment spectra. */
const TRANSCENDENTAL = new Set<BlendMode>(['pigment', 'watercolor', 'tint', 'highlight', 'shadow']);

function blendVectors() {
  const grid = [0, 1 / 255, 0.1, 0.25, 0.5, 0.75, 0.9, 254 / 255, 1];
  const store = (mode: BlendMode, v: number) => (TRANSCENDENTAL.has(mode) ? f32(v) : v);
  const channel = MODES.map((mode) => ({ mode, out: grid.flatMap((cb) => grid.map((cs) => store(mode, blendChannel(mode, cb, cs)))) }));
  const colors = [
    [0, 0, 0],
    [1, 1, 1],
    [1, 0, 0],
    [0.1, 0.6, 0.2],
    [0.9, 0.85, 0.1],
    [0.2, 0.3, 0.95],
    [0.5, 0.5, 0.5],
    [0.95, 0.4, 0.7],
  ];
  const rgb = MODES.map((mode) => ({ mode, out: colors.flatMap((cb) => colors.flatMap((cs) => blendRgb(mode, cb, cs).map((v) => store(mode, v)))) }));
  const pixels: Array<{ mode: BlendMode; b: number[]; s: number[]; alpha: number; out: number[] }> = [];
  const pairs: Array<[number[], number[], number]> = [
    [[0.2, 0.4, 0.6, 1], [0.9, 0.1, 0.3, 1], 1],
    [[0.2, 0.4, 0.6, 0.5], [0.9, 0.1, 0.3, 0.7], 0.8],
    [[0.7, 0.7, 0.1, 0], [0.1, 0.3, 0.9, 0.4], 1],
    [[0.1, 0.2, 0.8, 1], [0.95, 0.9, 0.05, 0.6], 0.5],
  ];
  for (const mode of MODES) for (const [b, s, alpha] of pairs) pixels.push({ mode, b, s, alpha, out: blendPixel(mode, b, s, alpha).map((v) => store(mode, v)) });
  const dst0 = gradientPixels(8, 8, 1, (x, y) => (x * 37 + y * 11) % 256);
  const src0 = gradientPixels(8, 8, 2, (x, y) => (x * 13 + y * 29 + 40) % 256);
  const coverage = new Float32Array(64).map((_, i) => (i % 9) / 8);
  const tiles = MODES.map((mode) => {
    const a = new Uint8ClampedArray(dst0);
    blendTile(a, src0, mode, 0.7, coverage);
    const b = new Uint8ClampedArray(dst0);
    blendTile(b, src0, mode, 1, null);
    const c = { width: 8, height: 8, data: new Uint8ClampedArray(dst0) } as ImageData;
    blendImageData(c, { width: 8, height: 8, data: src0 } as ImageData, mode, 0.85);
    return { mode, coverage: b64(a), plain: b64(b), imageData: b64(c.data) };
  });
  const pigment = [
    [[0.1, 0.2, 0.9], [0.95, 0.9, 0.1], 0.5],
    [[1, 1, 1], [0.8, 0.1, 0.1], 0.3],
    [[0, 0, 0], [1, 1, 1], 0.5],
    [[0.3, 0.6, 0.2], [0.3, 0.6, 0.2], 0.4],
    [[0.2, 0.2, 0.2], [0.9, 0.5, 0.1], 0],
  ].map(([b, s, t]) => ({ b, s, t, out: mixPigmentRgb(b as number[], s as number[], t as number).map(f32) }));
  const pigment8 = [
    [10, 40, 200, 240, 220, 20, 0.5],
    [255, 255, 255, 200, 30, 30, 0.25],
    [5, 5, 5, 5, 5, 5, 0.5],
    [0, 128, 255, 255, 128, 0, 1],
  ].map((a) => {
    const out = [0, 0, 0];
    mixPigment8(a[0], a[1], a[2], a[3], a[4], a[5], a[6], out);
    return { in: a, out: out.map(f32) };
  });
  const info = BLEND_MODES.map((m) => ({ id: m.id, label: m.label, canvas: m.canvas, painterly: Boolean(m.painterly), standard: standardBlendMode(m.id), separable: isSeparableBlendMode(m.id), op: canvasCompositeOperation(m.id) }));
  return { grid, channel, colors, rgb, pixels, dst: b64(dst0), src: b64(src0), coverage: Array.from(coverage), tiles, pigment, pigment8, info };
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function surfaceVectors() {
  const cases: unknown[] = [];
  const add = (name: string, s: TiledSurface, read: RasterRect) => {
    const keys = [...s.tiles.keys()];
    cases.push({
      name,
      channels: s.channels,
      defaultValue: s.defaultValue,
      bounds: s.bounds,
      contentBounds: contentBounds(s),
      tiles: keys.map((k) => [k, tileCoord(k).tx, tileCoord(k).ty, s.tiles.get(k)!.uniform]),
      bytes: surfaceBytes(s),
      read,
      pixels: b64(readRegion(s, read)),
    });
  };
  const px = gradientPixels(12, 10, 3, (x, y) => ((x + y) % 4 === 0 ? 0 : 60 + x * 15));
  const base = surfaceFromPixels({ width: 12, height: 10, data: px }, 4, 250, -5);
  add('across four tiles', base, { x: 244, y: -8, width: 22, height: 16 });
  const filled = fillRect(base, { x: 0, y: 0, width: 512, height: 256 }, [10, 20, 30, 255]);
  add('fill whole tiles', filled, { x: 248, y: -8, width: 20, height: 16 });
  const partial = fillRect(base, { x: 253, y: -2, width: 5, height: 3 }, [255, 0, 0, 128]);
  add('fill part', partial, { x: 248, y: -8, width: 20, height: 16 });
  const cleared = fillRect(base, { x: -256, y: -256, width: 1024, height: 512 }, [0, 0, 0, 0]);
  add('fill default', cleared, { x: 248, y: -8, width: 20, height: 16 });
  const written = writeRegion(base, { x: 255, y: 0, width: 3, height: 2 }, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  add('write region', written, { x: 248, y: -8, width: 20, height: 16 });
  add('translate', translateSurface(base, 3.4, -7.6), { x: 248, y: -16, width: 24, height: 20 });
  add('translate by tiles', translateSurface(base, 256, -512), { x: 504, y: -520, width: 20, height: 16 });
  add('solid', solidSurface(4, { x: -3, y: 2, width: 6, height: 4 }, 0x11223344), { x: -4, y: 0, width: 8, height: 8 });
  const mask = surfaceFromPixels({ width: 6, height: 5, data: Uint8Array.from({ length: 30 }, (_, i) => (i * 23) % 256) }, 1, -2, -1, 255);
  add('mask default 255', mask, { x: -4, y: -3, width: 10, height: 9 });
  add('mask fill hide', fillRect(mask, { x: -256, y: -256, width: 512, height: 512 }, [0]), { x: -4, y: -3, width: 10, height: 9 });
  const draft = new SurfaceDraft(base);
  draft.tile(0, 0)[0] = 99;
  draft.tile(1, -1)[4 * 300] = 7;
  draft.tile(5, 5)[3] = 255;
  const committed = draft.commit();
  add('draft', committed, { x: 0, y: 0, width: 2, height: 2 });
  const pixelsRead = [
    [base, 250, -5],
    [base, 261, 4],
    [base, 0, 0],
    [mask, -2, -1],
    [mask, 100, 100],
  ].map(([s, x, y]) => readPixel(s as TiledSurface, x as number, y as number));
  const other = writeRegion(base, { x: 260, y: 3, width: 1, height: 1 }, [0, 0, 0, 0]);
  return {
    source: surfaceSpec(250, -5, 12, 10, px),
    mask: surfaceSpec(-2, -1, 6, 5, Uint8Array.from({ length: 30 }, (_, i) => (i * 23) % 256), 1, 255),
    cases,
    tileKeys: [[0, 0], [-1, -1], [5, -3], [-32768, 32767]].map(([x, y]) => [x, y, tileKey(x, y)]),
    tilesInRect: tilesInRect({ x: -10, y: 250, width: 300, height: 10 }).map((t) => [t.tx, t.ty]),
    draftTouched: draft.touched,
    readPixel: pixelsRead,
    equal: [surfacesEqual(base, base), surfacesEqual(base, written), surfacesEqual(base, surfaceFromPixels({ width: 12, height: 10, data: px }, 4, 250, -5)), surfacesEqual(base, other)],
    changed: changedTiles(base, other),
    changedDraft: changedTiles(base, committed),
  };
}

// ---------------------------------------------------------------------------
// Deep samples
// ---------------------------------------------------------------------------

function deepVectors() {
  const codes = Array.from({ length: 256 }, (_, i) => i);
  const enc = [-0.5, 0, 0.001, 0.0031308, 0.01, 0.2, 0.5, 0.9, 1, 1.5, 4].map((v) => [v, f32(srgbEncode(v)), f32(srgbDecode(v))]);
  const rgba = gradientPixels(4, 4, 4, (x, y) => x * 60 + y * 5);
  const s16 = to16From8(rgba);
  const s32 = to32From8(rgba, 4);
  const lin = new Float32Array([0, 0.0001, 0.002, 0.04, 0.3, 0.7, 1, 1.4, -0.2, 0.5, 0.25, 0.6, 0.9, 0.1, 0.33, 1]);
  const u16 = new Uint16Array([0, 1, 256, 257, 300, 32768, 65280, 65535, 1000, 2000, 3000, 4000, 40000, 50000, 60000, 65534]);
  const convert = {
    codes: b64f(to32From8(codes, 4)),
    mask32: b64f(to32From8(codes, 1)),
    to16From8: b64u16(s16),
    to32From8: b64f(s32),
    to32From16: b64f(to32From16(u16, 4)),
    to32From16Mask: b64f(to32From16(u16, 1)),
    to16From32: b64u16(to16From32(lin, 4)),
    to16From32Mask: b64u16(to16From32(lin, 1)),
    to8From16: b64(to8From16(u16)),
    to8From32: b64(to8From32(lin, 4)),
    to8From32Mask: b64(to8From32(lin, 1)),
    lin: b64f(lin),
    u16: b64u16(u16),
  };
  // Deep surfaces: a 16-bit and a 32-bit layer across tile edges, read back at each depth.
  const w = 6;
  const h = 5;
  const d16 = new Uint16Array(w * h * 4).map((_, i) => (i * 2731 + 17) % 65536);
  for (let i = 3; i < d16.length; i += 4) d16[i] = 65535 - ((i * 997) % 30000);
  const d32 = new Float32Array(w * h * 4).map((_, i) => ((i * 37) % 101) / 80 - 0.1);
  for (let i = 3; i < d32.length; i += 4) d32[i] = ((i * 13) % 17) / 16;
  const sur16 = surfaceFromDeepPixels({ width: w, height: h, data: d16 }, 4, 253, -2);
  const sur32 = surfaceFromDeepPixels({ width: w, height: h, data: d32 }, 4, 253, -2);
  const read = { x: 251, y: -4, width: 10, height: 9 };
  const exact16 = new Uint16Array(w * h * 4).map((_, i) => ((i * 7) % 256) * 257);
  const surfaces = [
    ['16-bit', sur16],
    ['32-bit', sur32],
    ['16 as 32', convertSurfaceDepth(sur16, 32)],
    ['32 as 16', convertSurfaceDepth(sur32, 16)],
    ['32 as 8', convertSurfaceDepth(sur32, 8)],
    ['exact 16', surfaceFromDeepPixels({ width: w, height: h, data: exact16 }, 4, 0, 0)],
    ['written over 8-bit', writeDeepRegion(surfaceFromPixels({ width: 8, height: 8, data: rgbaOf(8, 8) }, 4, 250, -4), { x: 253, y: -2, width: w, height: h }, d16)],
  ].map(([name, s]) => {
    const sur = s as TiledSurface;
    return {
      name,
      depth: surfaceDepth(sur),
      tiles: sur.tiles.size,
      bytes8: b64(readRegion(sur, read)),
      read16: b64u16(readDeepRegion(sur, read, 16)),
      read32: b64f(readDeepRegion(sur, read, 32)),
    };
  });
  const before = sur16;
  const after = writeRegion(before, { x: 254, y: -1, width: 2, height: 2 }, new Uint8ClampedArray(16).fill(200));
  const kept = keepDeepSamples(before, after);
  const emptyFloat = deepTile(new Float32Array(256 * 256 * 4), 4, 0);
  return {
    enc,
    convert,
    d16: b64u16(d16),
    d32: b64f(d32),
    exact16: b64u16(exact16),
    rgba8: b64(rgbaOf(8, 8)),
    read,
    surfaces,
    kept: { depth: surfaceDepth(kept), read16: b64u16(readDeepRegion(kept, read, 16)), bytes8: b64(readRegion(kept, read)) },
    emptyFloatTile: emptyFloat === null,
    working16: b64u16(workingToSamples(new Float32Array([0, 0.5, 1, 1.2, -0.1, 0.25, 0.75, 0.999]), 16) as Uint16Array),
  };
}

function rgbaOf(w: number, h: number): Uint8ClampedArray {
  return gradientPixels(w, h, 5, (x, y) => 255 - x * 9 - y * 3);
}

// ---------------------------------------------------------------------------
// Pigment, blur, curves
// ---------------------------------------------------------------------------

function pigmentVectors() {
  const colors: [number, number, number][] = [
    [0, 0, 0],
    [1, 1, 1],
    [1, 0, 0],
    [0, 0.4, 1],
    [1, 0.9, 0],
    [0.5, 0.5, 0.5],
    [0.05, 0.02, 0.3],
    [0.13, 0.77, 0.41],
  ];
  const spectra = colors.map((c) => ({ c, spectrum: b64f(rgbToReflectance(c[0], c[1], c[2])), back: reflectanceToRgb(rgbToReflectance(c[0], c[1], c[2])).map(f32) }));
  const pigments = colors.map((c, i) => {
    const p = createPigment(c, { strength: i % 3 === 0 ? 2 : undefined });
    return { c, strength: p.strength, scatter: f32(p.scatter), ks: b64f(p.ks), rgb: p.rgb };
  });
  const mixes = [
    [[0, 1], [1, 1]],
    [[2, 3, 4], [1, 2, 0.5]],
    [[1, 6], [10, 1]],
    [[5], [3]],
  ].map(([idx, weights]) => ({ idx, weights, out: mixPigments(idx.map((i) => colors[i]), weights).map(f32) }));
  const lerps = [0, 0.25, 0.5, 1].map((t) => ({ t, out: lerpPigment(colors[3], colors[4], t).map(f32) }));
  const strong = createPigment([0.05, 0.02, 0.3], { strength: 4 });
  const strongMix = mixPigments([strong, [1, 1, 1]], [1, 3]).map(f32);
  const errors = [
    () => mixPigments([], []),
    () => mixPigments([[0, 0, 0]], [1, 2]),
    () => mixPigments([[0, 0, 0]], [-1]),
    () => mixPigments([[0, 0, 0]], [0]),
  ].map((f) => {
    try {
      f();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  });
  return { colors, spectra, pigments, mixes, lerps, strongMix, errors };
}

function blurVectors() {
  const w = 16;
  const h = 12;
  const src = new Float32Array(w * h).map((_, i) => ((i % w) > 5 && (i % w) < 11 && Math.floor(i / w) > 3 && Math.floor(i / w) < 9 ? 1 : ((i * 7) % 10) / 40));
  const cases = [
    [0.05, 'zero'],
    [0.5, 'zero'],
    [1.5, 'clamp'],
    [3, 'zero'],
    [8, 'clamp'],
    [9, 'zero'],
    [20, 'clamp'],
    [200, 'zero'],
  ].map(([sigma, edge]) => ({ sigma, edge, out: b64f(gaussianBlur(src, w, h, sigma as number, edge as 'zero' | 'clamp')) }));
  return { w, h, src: b64f(src), cases };
}

function curveVectors() {
  const sets = [
    [],
    [{ input: 0.5, output: 0.5 }],
    [{ input: 0, output: 0 }, { input: 1, output: 1 }],
    [{ input: 0, output: 0.1 }, { input: 0.4, output: 0.8 }, { input: 1, output: 0.9 }],
    [{ input: 0.2, output: 0 }, { input: 0.5, output: 1 }, { input: 0.5000001, output: 0 }, { input: 0.8, output: 0.3 }, { input: 0.95, output: 1.2 }],
    [{ input: 1, output: 0 }, { input: 0, output: 1 }, { input: 0.3, output: 0.3 }, { input: NaN, output: 0 }],
  ];
  return sets.map((points, i) => ({ points: points.map((p) => [p.input, p.output]), small: b64f(curveLut(points, 65)), full: i >= 3 ? b64f(curveLut(points)) : null }));
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

function transformVectors() {
  const px = gradientPixels(16, 14, 6, (x, y) => (x < 2 || y > 12 ? 0 : Math.min(255, 40 + x * 14 + y * 3)));
  const source = surfaceSpec(3, 2, 16, 14, px);
  const maskSpec = surfaceSpec(3, 2, 16, 14, Uint8Array.from({ length: 16 * 14 }, (_, i) => (i * 29) % 256), 1, 255);
  const deep16 = new Uint16Array(16 * 14 * 4).map((_, i) => (i * 4099 + 11) % 65536);
  for (let i = 3; i < deep16.length; i += 4) deep16[i] = 40000 + ((i * 31) % 25000);
  const rad = (d: number) => (d * Math.PI) / 180;
  const rot = (deg: number, cx: number, cy: number): Homography => {
    // Rounded to floats, so the inputs do not depend on the machine's last bit of sin / cos.
    const c = f32(Math.cos(rad(deg)));
    const s = f32(Math.sin(rad(deg)));
    return [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1];
  };
  const maps: Array<{ name: string; h: number[]; interpolation?: 'nearest' | 'bilinear' | 'bicubic'; clip?: RasterRect; step?: number; sourceRect?: RasterRect; surface?: 'mask' | 'deep16' }> = [
    { name: 'scale 1.5 bicubic', h: [1.5, 0, -2, 0, 1.5, 1, 0, 0, 1] },
    { name: 'scale 1.5 bilinear', h: [1.5, 0, -2, 0, 1.5, 1, 0, 0, 1], interpolation: 'bilinear' },
    { name: 'scale 1.5 nearest', h: [1.5, 0, -2, 0, 1.5, 1, 0, 0, 1], interpolation: 'nearest' },
    { name: 'rotate 30', h: [...rot(30, 11, 9)] },
    { name: 'rotate 30 bilinear', h: [...rot(30, 11, 9)], interpolation: 'bilinear' },
    { name: 'shrink 0.3', h: [0.3, 0, 1, 0, 0.3, 2, 0, 0, 1] },
    { name: 'shrink 0.6 skew', h: [0.6, 0.2, 0, 0.05, 0.55, 0, 0, 0, 1] },
    { name: 'perspective', h: [1, 0.1, 0, 0.05, 1.1, 0, 0.01, 0.004, 1] },
    { name: 'whole pixels', h: [1, 0, 5, 0, 1, -3, 0, 0, 1] },
    { name: 'fractional move', h: [1, 0, 0.5, 0, 1, 0.25, 0, 0, 1] },
    { name: 'identity clipped', h: [1, 0, 0, 0, 1, 0, 0, 0, 1], clip: { x: 5, y: 4, width: 6, height: 6 } },
    { name: 'preview step 2', h: [1.2, 0, 0, 0, 1.2, 0, 0, 0, 1], step: 2, interpolation: 'bilinear' },
    { name: 'source rect', h: [1, 0, 2, 0, 1, 0, 0, 0, 1], sourceRect: { x: 4, y: 3, width: 6, height: 5 }, interpolation: 'bilinear' },
    { name: 'mask rotate', h: [...rot(20, 10, 9)], surface: 'mask' },
    { name: 'mask scale nearest', h: [2, 0, 0, 0, 2, 0, 0, 0, 1], surface: 'mask', interpolation: 'nearest' },
    { name: 'deep16 scale', h: [1.25, 0, 0, 0, 1.25, 0, 0, 0, 1], surface: 'deep16', interpolation: 'bilinear' },
    { name: 'deep16 move', h: [1, 0, 3, 0, 1, 1, 0, 0, 1], surface: 'deep16' },
  ];
  const srcSurface = surfaceOf(source);
  const maskSurface = surfaceOf(maskSpec);
  const deepSurface = surfaceFromDeepPixels({ width: 16, height: 14, data: deep16 }, 4, 3, 2);
  const read = { x: -6, y: -6, width: 40, height: 40 };
  const cases = maps.map((m) => {
    const s = m.surface === 'mask' ? maskSurface : m.surface === 'deep16' ? deepSurface : srcSurface;
    const out = transformSurface(s, m.h as unknown as Homography, { interpolation: m.interpolation, clip: m.clip, step: m.step, source: m.sourceRect });
    return {
      ...m,
      contentBounds: contentBounds(out),
      depth: surfaceDepth(out),
      pixels: b64(readRegion(out, read)),
      deep16: m.surface === 'deep16' ? b64u16(readDeepRegion(out, read, 16)) : null,
    };
  });
  const warps = [
    { name: 'wave bicubic', interpolation: 'bicubic' as const },
    { name: 'wave nearest', interpolation: 'nearest' as const },
    { name: 'shrink bilinear', interpolation: 'bilinear' as const, shrink: true },
    { name: 'preview', interpolation: 'bilinear' as const, step: 4 },
  ].map((w) => {
    const f = w.shrink ? (p: { x: number; y: number }) => ({ x: p.x * 0.4 + 2, y: p.y * 0.45 + 1 }) : (p: { x: number; y: number }) => ({ x: p.x + f32(1.5 * Math.sin(p.y / 3)), y: p.y + f32(0.7 * Math.cos(p.x / 4)) });
    const out = warpSurface(srcSurface, f, { interpolation: w.interpolation, step: w.step });
    return { name: w.name, interpolation: w.interpolation, shrink: Boolean(w.shrink), step: w.step ?? null, contentBounds: contentBounds(out), pixels: b64(readRegion(out, read)) };
  });
  const top = surfaceFromPixels({ width: 8, height: 6, data: gradientPixels(8, 6, 7, (x, y) => (x * 40 + y * 9) % 256) }, 4, 6, 5);
  const over = [
    ['layer', compositeSurfaceOver(srcSurface, top)],
    ['mask', compositeSurfaceOver(maskSurface, top)],
    ['deep', compositeSurfaceOver(deepSurface, top)],
  ].map(([name, s]) => ({ name, pixels: b64(readRegion(s as TiledSurface, read)), deep16: name === 'deep' ? b64u16(readDeepRegion(s as TiledSurface, read, 16)) : null }));
  const reduced = reduceSurface(srcSurface, 3);
  // Homography maths.
  const quad = [{ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 12, y: 9 }, { x: -1, y: 8 }];
  const h1 = homographyFromPoints([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], quad);
  const h2 = rectToQuad({ x: 2, y: 3, width: 8, height: 6 }, quad);
  const homography = {
    fromPoints: h1,
    rectToQuad: h2,
    inverse: h2 ? invertHomography(h2) : null,
    product: h1 && h2 ? multiplyHomographies(h1, h2) : null,
    applied: h2 ? [applyHomography(h2, { x: 3, y: 4 }), applyHomography(h2, { x: 10, y: 9 })] : null,
    order: orderQuad([{ x: 10, y: 1 }, { x: -1, y: 8 }, { x: 0, y: 0 }, { x: 12, y: 9 }]),
    convex: [isConvexQuad(quad), isConvexQuad([quad[0], quad[2], quad[1], quad[3]])],
    front: h2 ? homographyFrontSide(h2, { x: 2, y: 3, width: 8, height: 6 }) : null,
    corners: cornerBounds(quad),
    keys: [-2.5, -1.5, -1, -0.3, 0, 0.4, 1, 1.7, 2, 3].map((x) => [x, keysWeight(x)]),
  };
  return {
    source,
    mask: maskSpec,
    deep16: b64u16(deep16),
    read,
    cases,
    warps,
    top: surfaceSpec(6, 5, 8, 6, gradientPixels(8, 6, 7, (x, y) => (x * 40 + y * 9) % 256)),
    over,
    reduced: { contentBounds: contentBounds(reduced), pixels: b64(readRegion(reduced, { x: 0, y: 0, width: 8, height: 8 })) },
    homography,
  };
}

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

interface LayerSpec {
  id: string;
  type: 'pixel' | 'group';
  visible?: boolean;
  opacity?: number;
  blend?: string;
  clipped?: boolean;
  fillOpacity?: number;
  offset?: { x: number; y: number };
  pixels?: PixelSpec;
  mask?: { pixels: PixelSpec; density?: number; feather?: number; enabled?: boolean };
  effects?: LayerEffects;
  edge?: { ambient?: number; ambientColor?: [number, number, number] };
  children?: LayerSpec[];
}

function buildLayer(s: LayerSpec): CompositorLayer {
  const base: CompositorLayer & { name: string } = {
    id: s.id,
    name: s.id,
    type: s.type,
    visible: s.visible ?? true,
    opacity: s.opacity ?? 1,
    blend: s.blend ?? 'normal',
    clipped: s.clipped,
  };
  if (s.mask) base.mask = { surface: surfaceOf(s.mask.pixels), defaultValue: s.mask.pixels.defaultValue as 0 | 255, density: s.mask.density, feather: s.mask.feather, enabled: s.mask.enabled };
  if (s.effects) base.effects = s.effects;
  if (s.edge) base.edge = s.edge;
  if (s.type === 'pixel') {
    base.surface = s.pixels ? surfaceOf(s.pixels) : emptySurface(4);
    base.offset = s.offset ?? { x: 0, y: 0 };
    if (s.fillOpacity !== undefined) base.fillOpacity = s.fillOpacity;
  } else base.children = (s.children ?? []).map(buildLayer);
  return base;
}

interface ProfileSpec extends Omit<LayerSpec, 'type' | 'mask'> {
  type: 'pixel' | 'group' | 'invert' | 'fill' | 'smart';
  color?: [number, number, number, number];
  mask?: { pixels: PixelSpec; density?: number; feather?: number; enabled?: boolean; source?: { ramp: boolean } };
}

type ProfileLayer = CompositorLayer & { color?: [number, number, number, number] };

function buildProfileLayer(s: ProfileSpec): ProfileLayer {
  const l = buildLayer({ ...s, type: s.type === 'smart' ? 'pixel' : s.type === 'group' ? 'group' : s.type === 'pixel' ? 'pixel' : 'group', children: [] } as LayerSpec) as ProfileLayer;
  l.type = s.type;
  if (s.type === 'invert' || s.type === 'fill') {
    delete l.children;
    delete l.surface;
    delete l.offset;
  }
  if (s.type === 'smart') {
    l.surface = surfaceOf(s.pixels!);
    l.offset = s.offset ?? { x: 0, y: 0 };
    if (s.fillOpacity !== undefined) l.fillOpacity = s.fillOpacity;
  }
  if (s.mask?.source && l.mask) l.mask = { ...l.mask, source: s.mask.source };
  if (s.color) l.color = s.color;
  return l;
}

const testProfile: CompositorProfile<ProfileLayer, { width: number; height: number }> = {
  isFilterLayer: (l) => l.type === 'invert',
  applyFilterRun: (layers, acc, _r, coverage) => {
    for (const l of layers) {
      const cov = coverage?.get(l.id);
      for (let i = 0, p = 0; i < acc.length; i += 4, p++) {
        const k = cov ? cov[p] : 1;
        for (let c = 0; c < 3; c++) acc[i + c] = Math.round(acc[i + c] + (255 - 2 * acc[i + c]) * k);
      }
    }
  },
  contentTile: (l, r) => {
    if (l.type !== 'fill' || !l.color) return null;
    const out = new Uint8ClampedArray(r.width * r.height * 4);
    for (let i = 0; i < out.length; i += 4) out.set(l.color, i);
    return out;
  },
  pixelFilters: (l) => {
    if (l.id === 'dim') {
      return {
        key: 'dim',
        spatial: false,
        apply: (d) => {
          for (let i = 0; i < d.length; i += 4) {
            d[i] = d[i] * 0.5;
            d[i + 1] = d[i + 1] * 0.5;
            d[i + 2] = d[i + 2] * 0.5;
          }
        },
      };
    }
    if (l.id === 'blur') {
      return {
        key: 'blur',
        spatial: true,
        apply: (d, w, h) => {
          const src = d.slice();
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              for (let c = 0; c < 4; c++) {
                const at = (xx: number) => src[(y * w + Math.min(w - 1, Math.max(0, xx))) * 4 + c];
                d[(y * w + x) * 4 + c] = (at(x - 1) + at(x) + at(x + 1)) / 3;
              }
            }
          }
        },
      };
    }
    return null;
  },
  maskSourcePlane: (source, w, h) => ((source as { ramp?: boolean }).ramp ? Float32Array.from({ length: w * h }, (_, i) => (i % w) / w) : null),
  isPixelLike: (l) => l.type === 'smart',
  layerKey: (l) => l.color,
};

function compositorVectors() {
  const W = 24;
  const H = 20;
  const bg = surfaceSpec(0, 0, W, H, gradientPixels(W, H, 8, () => 255));
  const blob = surfaceSpec(2, 3, 14, 12, disc(14, 12, 7, 6, 5.5, [220, 60, 30]));
  const blob2 = surfaceSpec(9, 6, 13, 12, disc(13, 12, 6, 6, 6, [30, 90, 230]));
  const stripes = surfaceSpec(0, 0, W, H, gradientPixels(W, H, 9, (x) => (x % 6 < 3 ? 255 : 90)));
  const maskPx = surfaceSpec(0, 0, W, H, Uint8Array.from({ length: W * H }, (_, i) => ((i % W) < 12 ? 255 : (i * 41) % 256)), 1, 0);
  const shadow = { ...defaultLayerEffect('drop-shadow', 'fx1'), distance: 3, size: 3 } as LayerEffect;
  const stroke = { ...defaultLayerEffect('stroke', 'fx2'), size: 2 } as LayerEffect;
  const stacks: Array<{ name: string; layers: LayerSpec[]; rect?: RasterRect }> = [
    { name: 'normal over background', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob, opacity: 0.8 }] },
    { name: 'multiply and screen', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob, blend: 'multiply' }, { id: 'b', type: 'pixel', pixels: blob2, blend: 'screen', opacity: 0.6 }] },
    { name: 'clipping', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'base', type: 'pixel', pixels: blob, fillOpacity: 0.7 }, { id: 'clip', type: 'pixel', pixels: stripes, clipped: true, blend: 'overlay' }, { id: 'clip2', type: 'pixel', pixels: blob2, clipped: true, opacity: 0.5 }] },
    { name: 'group with opacity', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'g', type: 'group', opacity: 0.6, blend: 'hard-light', children: [{ id: 'a', type: 'pixel', pixels: blob }, { id: 'b', type: 'pixel', pixels: blob2, blend: 'difference' }] }] },
    { name: 'pass-through group', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'g', type: 'group', opacity: 0.5, blend: 'pass-through', children: [{ id: 'a', type: 'pixel', pixels: blob, blend: 'color-burn' }, { id: 'b', type: 'pixel', pixels: blob2, blend: 'hue' }] }] },
    { name: 'masks', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: stripes, mask: { pixels: maskPx, density: 0.8 } }, { id: 'b', type: 'pixel', pixels: blob2, mask: { pixels: maskPx, feather: 1.5 } }] },
    { name: 'disabled mask and hidden layer', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob, mask: { pixels: maskPx, enabled: false } }, { id: 'b', type: 'pixel', pixels: blob2, visible: false }] },
    { name: 'pigment and painterly', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob, blend: 'pigment', opacity: 0.7 }, { id: 'b', type: 'pixel', pixels: blob2, blend: 'watercolor' }, { id: 'c', type: 'pixel', pixels: stripes, blend: 'tint', opacity: 0.4 }] },
    { name: 'effects', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob, effects: { enabled: true, items: [shadow, stroke] } }] },
    { name: 'clipped effects', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob }, { id: 'b', type: 'pixel', pixels: blob2, clipped: true, effects: { enabled: true, items: [{ ...defaultLayerEffect('inner-glow', 'fx3') } as LayerEffect] } }] },
    { name: 'group effects', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'g', type: 'group', effects: { enabled: true, items: [{ ...defaultLayerEffect('outer-glow', 'fx4'), size: 4 } as LayerEffect] }, children: [{ id: 'a', type: 'pixel', pixels: blob }] }] },
    { name: 'edge ambient', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob, edge: { ambient: 0.8 } }, { id: 'b', type: 'pixel', pixels: blob2, edge: { ambient: 0.5, ambientColor: [0, 255, 0] } }] },
    { name: 'offsets across tiles', rect: { x: 240, y: -10, width: 30, height: 24 }, layers: [{ id: 'a', type: 'pixel', pixels: blob, offset: { x: 248, y: -9 } }, { id: 'b', type: 'pixel', pixels: blob2, offset: { x: 245, y: -6 }, blend: 'linear-light', opacity: 0.9 }] },
  ];
  const results = stacks.map((st) => {
    const comp = new RasterCompositor();
    const layers = st.layers.map(buildLayer);
    const rect = st.rect ?? { x: 0, y: 0, width: W, height: H };
    const sources = { width: W, height: H };
    const first = comp.composite(layers, rect, sources);
    const stats1 = comp.lastStats;
    const again = comp.composite(layers, rect, sources);
    const stats2 = comp.lastStats;
    return { name: st.name, rect, pixels: b64(first), same: b64(first) === b64(again), stats: [stats1, stats2] };
  });
  // Incremental: change one layer's pixels inside a dirty rect, and check against a fresh composite.
  const comp = new RasterCompositor();
  const layers0 = stacks[1].layers.map(buildLayer);
  const sources = { width: W, height: H };
  comp.composite(layers0, { x: 0, y: 0, width: W, height: H }, sources, { checkpointLayerId: 'b' });
  const s0 = layers0[2].surface as TiledSurface;
  const s1 = writeRegion(s0, { x: 12, y: 8, width: 3, height: 3 }, new Uint8ClampedArray(36).fill(250));
  const layers1 = [layers0[0], layers0[1], { ...layers0[2], surface: s1 }];
  const inc = comp.composite(layers1, { x: 0, y: 0, width: W, height: H }, sources, { dirty: [{ x: 12, y: 8, width: 3, height: 3 }] });
  const fresh = new RasterCompositor().composite(layers1, { x: 0, y: 0, width: W, height: H }, sources);
  const incremental = { pixels: b64(inc), matchesFresh: b64(inc) === b64(fresh), stats: comp.lastStats };
  // The same with layer effects on a wider layer: the effect maps are patched around the change.
  const big = surfaceSpec(0, 0, 80, 56, gradientPixels(80, 56, 15, (x, y) => (x % 20 < 14 && y % 20 < 14 ? 255 : 0)));
  const bigSources = { width: 80, height: 56 };
  const fxComp = new RasterCompositor();
  const fxLayers0 = [buildLayer({ id: 'bg', type: 'pixel', pixels: surfaceSpec(0, 0, 80, 56, gradientPixels(80, 56, 16, () => 255)) }), buildLayer({ id: 'a', type: 'pixel', pixels: big, effects: { enabled: true, items: [shadow, stroke] } })];
  fxComp.composite(fxLayers0, { x: 0, y: 0, width: 80, height: 56 }, bigSources);
  const fxSurface = writeRegion(fxLayers0[1].surface as TiledSurface, { x: 4, y: 5, width: 2, height: 2 }, new Uint8ClampedArray(16).fill(255));
  const fxLayers1 = [fxLayers0[0], { ...fxLayers0[1], surface: fxSurface }];
  const fxInc = fxComp.composite(fxLayers1, { x: 0, y: 0, width: 80, height: 56 }, bigSources, { dirty: [{ x: 4, y: 5, width: 2, height: 2 }] });
  const fxFresh = new RasterCompositor().composite(fxLayers1, { x: 0, y: 0, width: 80, height: 56 }, bigSources);
  const effectsIncremental = { big, bg: surfaceSpec(0, 0, 80, 56, gradientPixels(80, 56, 16, () => 255)), pixels: b64(fxInc), matchesFresh: b64(fxInc) === b64(fxFresh), stats: fxComp.lastStats };
  // A profile: filter layers, content the editor draws, pixel filters, parametric masks and pixel-like layers.
  const profileStacks: Array<{ name: string; layers: ProfileSpec[] }> = [
    {
      name: 'filters and fills',
      layers: [
        { id: 'bg', type: 'pixel', pixels: bg },
        { id: 'dim', type: 'pixel', pixels: blob },
        { id: 'inv', type: 'invert', mask: { pixels: maskPx } },
        { id: 'inv2', type: 'invert', opacity: 1 },
        { id: 'fill', type: 'fill', color: [20, 200, 90, 160], blend: 'multiply', mask: { pixels: maskPx, source: { ramp: true } } },
      ],
    },
    {
      name: 'spatial filter and smart layer',
      layers: [
        { id: 'bg', type: 'pixel', pixels: bg },
        { id: 'blur', type: 'pixel', pixels: stripes, opacity: 0.8 },
        { id: 'smart', type: 'smart', pixels: blob2, offset: { x: 1, y: -2 }, fillOpacity: 0.5, blend: 'screen' },
        { id: 'fill', type: 'fill', color: [250, 10, 10, 255], clipped: true, opacity: 0.5 },
      ],
    },
  ];
  const profileResults = profileStacks.map((st) => {
    const layers = st.layers.map(buildProfileLayer);
    const out = new RasterCompositor(testProfile).composite(layers, { x: 0, y: 0, width: W, height: H }, sources);
    const deep = [16, 32].map((depth) => b64f(new DeepCompositor(new RasterCompositor(testProfile), testProfile, {}, depth as 16 | 32).composite(layers, { x: 0, y: 0, width: W, height: H }, sources)));
    return { name: st.name, layers: st.layers, pixels: b64(out), deep16: deep[0], deep32: deep[1] };
  });
  // Deep compositor at 16 and 32 bits.
  const d16 = new Uint16Array(14 * 12 * 4);
  const discPx = disc(14, 12, 7, 6, 5.5, [220, 60, 30]);
  for (let i = 0; i < d16.length; i++) d16[i] = discPx[i] * 257 + ((i * 13) % 200);
  const deepStacks = [16, 32].flatMap((depth) =>
    [
      { name: 'deep normal', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob, opacity: 0.8, blend: 'multiply' }] as LayerSpec[] },
      { name: 'deep group and mask', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'g', type: 'group', opacity: 0.7, children: [{ id: 'a', type: 'pixel', pixels: blob2, mask: { pixels: maskPx, density: 0.6 } }, { id: 'c', type: 'pixel', pixels: stripes, clipped: true, blend: 'soft-light' }] }] as LayerSpec[] },
      { name: 'deep effects', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob, effects: { enabled: true, items: [shadow] } }] as LayerSpec[] },
      { name: 'deep pigment', layers: [{ id: 'bg', type: 'pixel', pixels: bg }, { id: 'a', type: 'pixel', pixels: blob2, blend: 'pigment', opacity: 0.6 }] as LayerSpec[] },
    ].map((st) => {
      const layers = st.layers.map(buildLayer);
      // The 16-bit layer: `a` gets deep samples.
      for (const l of layers) if (l.id === 'a' && l.surface) l.surface = surfaceFromDeepPixels({ width: 14, height: 12, data: depth === 16 ? d16 : to32From16(d16, 4) }, 4, 2, 3);
      const base = new RasterCompositor();
      const deep = new DeepCompositor(base, {} as CompositorProfile<CompositorLayer, { width: number; height: number }>, {}, depth as 16 | 32);
      const out = deep.composite(layers, { x: 0, y: 0, width: W, height: H }, { width: W, height: H });
      return { name: st.name, depth, pixels: b64f(out) };
    })
  );
  return {
    canvas: { width: W, height: H },
    surfaces: { bg, blob, blob2, stripes, mask: maskPx },
    d16: b64u16(d16),
    stacks: stacks.map((s) => ({ name: s.name, rect: s.rect ?? null, layers: s.layers })),
    results,
    incremental,
    effectsIncremental,
    profile: profileResults,
    deep: deepStacks,
  };
}

// ---------------------------------------------------------------------------
// Layer effects
// ---------------------------------------------------------------------------

function effectVariants(): Array<{ name: string; effects: LayerEffect[]; blend?: BlendMode; opacity?: number; fillOpacity?: number; scale?: number; backdrop?: 'opaque' | 'clear' }> {
  const d = (kind: Parameters<typeof defaultLayerEffect>[0], over: Record<string, unknown> = {}) => ({ ...defaultLayerEffect(kind, `fx_${kind}`), ...over }) as LayerEffect;
  const contour = { name: 'Cone', points: [{ input: 0, output: 0 }, { input: 0.5, output: 1 }, { input: 1, output: 0 }] };
  const corner = { name: 'Steps', points: [{ input: 0, output: 0 }, { input: 0.4, output: 0.3, corner: true }, { input: 0.6, output: 0.8 }, { input: 1, output: 1 }] };
  const gradient = { stops: [{ position: 0, color: '#ff0000' }, { position: 0.6, color: '#00ff00' }, { position: 1, color: '#0000ff' }], opacityStops: [{ position: 0, opacity: 1 }, { position: 1, opacity: 0.3 }], style: 'linear', angle: 30, scale: 1, reverse: false, align: true, offset: { x: 0, y: 0 } };
  const out: ReturnType<typeof effectVariants> = [];
  for (const kind of LAYER_EFFECT_KINDS) out.push({ name: `${kind} default`, effects: [d(kind)] });
  out.push(
    { name: 'drop shadow spread contour noise', effects: [d('drop-shadow', { spread: 0.4, size: 6, contour, noise: 0.3, angle: 45, useGlobalLight: false, distance: 4 })] },
    { name: 'drop shadow knockout off, fill 0.3', effects: [d('drop-shadow', { knocksOut: false })], fillOpacity: 0.3 },
    { name: 'inner shadow choke', effects: [d('inner-shadow', { choke: 0.5, size: 4, color: '#3300aa', blend: 'normal' })] },
    { name: 'outer glow precise gradient', effects: [d('outer-glow', { technique: 'precise', spread: 0.2, size: 6, fill: { type: 'gradient', gradient }, range: 0.7 })] },
    { name: 'inner glow center contour', effects: [d('inner-glow', { source: 'center', contour: corner, size: 6, technique: 'precise' })] },
    { name: 'satin contour', effects: [d('satin', { contour, invert: false, size: 5, distance: 4 })] },
    { name: 'color overlay multiply', effects: [d('color-overlay', { blend: 'multiply', opacity: 0.6, color: '#2080ff' })] },
    ...(['linear', 'radial', 'angle', 'reflected', 'diamond'] as const).map((style) => ({ name: `gradient overlay ${style}`, effects: [d('gradient-overlay', { gradient: { ...gradient, style, align: style !== 'radial', reverse: style === 'angle', offset: { x: 0.1, y: -0.2 }, scale: 0.8 } })] })),
    { name: 'pattern overlay rotated', effects: [d('pattern-overlay', { patternId: 'stripes', scale: 0.5, angle: 30, link: false, phase: { x: 2, y: 1 } })] },
    { name: 'pattern overlay dots', effects: [d('pattern-overlay', { patternId: 'dots', scale: 1.3 })] },
    { name: 'stroke inside', effects: [d('stroke', { position: 'inside', size: 3, fill: { type: 'color', color: '#00ff88' } })] },
    { name: 'stroke center gradient', effects: [d('stroke', { position: 'center', size: 4, fill: { type: 'gradient', gradient } })] },
    { name: 'stroke outside wide', effects: [d('stroke', { size: 22 })] },
    { name: 'stroke pattern', effects: [d('stroke', { size: 4, fill: { type: 'pattern', patternId: 'checker', scale: 0.5 } })] },
    { name: 'two strokes', effects: [d('stroke', { size: 2, fill: { type: 'color', color: '#ffffff' } }), { ...d('stroke', { size: 5, opacity: 0.7 }), id: 'fx_stroke2' } as LayerEffect] },
    ...(['inner-bevel', 'outer-bevel', 'emboss', 'pillow-emboss', 'stroke-emboss'] as const).flatMap((style) =>
      (['smooth', 'chisel-hard', 'chisel-soft'] as const).map((technique) => ({ name: `bevel ${style} ${technique}`, effects: [d('bevel-emboss', { style, technique, size: 4, soften: technique === 'chisel-soft' ? 1 : 0, direction: style === 'emboss' ? 'down' : 'up' })] }))
    ),
    { name: 'bevel gloss contour element texture', effects: [d('bevel-emboss', { glossContour: contour, contourElement: { contour: corner, range: 0.5, antiAlias: false }, texture: { patternId: 'noise', scale: 1, depth: 2, invert: true, link: true }, useGlobalLight: false, angle: 60, altitude: 45 })] },
    { name: 'stack in multiply layer', effects: [d('drop-shadow'), d('color-overlay', { opacity: 0.5 }), d('stroke', { size: 2 })], blend: 'multiply', opacity: 0.8, fillOpacity: 0.6 },
    { name: 'stack with scale', effects: [d('outer-glow'), d('inner-shadow'), d('bevel-emboss')], scale: 1.6 },
    { name: 'over clear backdrop', effects: [d('drop-shadow'), d('outer-glow')], backdrop: 'clear' },
  );
  return out;
}

function effectVectors() {
  const W = 34;
  const H = 32;
  const content = shapePixels(W, H);
  const backdrop = gradientPixels(W, H, 10, () => 255);
  const rect = { x: -3, y: 2, width: W, height: H };
  const canvas = { x: 0, y: 0, width: 40, height: 40 };
  const renders = effectVariants().map((v) => {
    const out = v.backdrop === 'clear' ? new Uint8ClampedArray(W * H * 4) : new Uint8ClampedArray(backdrop);
    const effects: LayerEffects = { enabled: true, items: v.effects, ...(v.scale ? { scale: v.scale } : {}) };
    renderLayerEffects(effects, { content, rect, blend: v.blend ?? 'normal', opacity: v.opacity ?? 1, fillOpacity: v.fillOpacity }, out, canvas, ctx);
    return { ...v, out: b64(out) };
  });
  // The float (deep) path: same maps, float backdrop and content.
  const items = [{ ...defaultLayerEffect('drop-shadow', 'f1') }, { ...defaultLayerEffect('stroke', 'f2'), size: 2 }] as LayerEffect[];
  const shape = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) shape[i] = content[i * 4 + 3] / 255;
  const maps = buildEffectMaps(items, shape, rect, ctx);
  const fb = new Float32Array(W * H * 4).map((_, i) => backdrop[i] / 255);
  const fc = new Float32Array(W * H * 4).map((_, i) => content[i] / 255);
  compositeLayerEffects({ backdrop: fb, content: fc, rect, maps, blend: 'screen', opacity: 0.9, fillOpacity: 1, canvas, ctx });
  const model = effectModelVectors();
  return { width: W, height: H, rect, canvas, content: b64(content), backdrop: b64(backdrop), renders, float: { items, out: b64f(fb) }, ...model };
}

function effectModelVectors() {
  const defaults = LAYER_EFFECT_KINDS.map((k) => defaultLayerEffect(k, `id_${k}`));
  const reach = defaults.map((e) => [e.kind, effectReach(e)]);
  const margins = [
    { enabled: true, items: defaults },
    { enabled: false, items: defaults },
    { enabled: true, scale: 2.5, items: [defaults[1], defaults[9]] },
    { enabled: true, items: [{ ...defaults[0], technique: 'chisel-soft', size: 9, soften: 3 }] },
  ].map((fx) => effectsMargin(fx as LayerEffects));
  const local = [
    defaults,
    [{ ...defaults[6], gradient: { ...(defaults[6] as { gradient: object }).gradient, align: false } }],
    [{ ...defaults[7], link: false }],
    [{ ...defaults[9], noise: 0.1 }],
    [{ ...defaults[1], fill: { type: 'pattern', patternId: 'dots', scale: 1, link: false } }],
  ].map((items) => effectsAreLocal(items as LayerEffect[]));
  const scaled = defaults.map((e) => scaleLayerEffect(e, 1.5));
  const bad: Array<[string, unknown]> = [
    ['not object', 5],
    ['array', [1]],
    ['kind', { kind: 'blur' }],
    ['id', { kind: 'stroke', id: '' }],
    ['enabled', { kind: 'stroke', id: 'a' }],
    ['unknown field', { ...defaults[1], colour: '#fff' }],
    ['blend', { ...defaults[1], blend: 'mix' }],
    ['pigment blend', { ...defaults[1], blend: 'pigment' }],
    ['opacity range', { ...defaults[1], opacity: 1.5 }],
    ['opacity type', { ...defaults[1], opacity: '1' }],
    ['color', { ...defaults[5], color: 'red' }],
    ['color missing', { ...defaults[5], color: undefined }],
    ['fill', { ...defaults[1], fill: { type: 'image' } }],
    ['glow pattern', { ...defaults[3], fill: { type: 'pattern', patternId: 'x', scale: 1 } }],
    ['gradient stops', { ...defaults[6], gradient: { stops: [] } }],
    ['gradient offset', { ...defaults[6], gradient: { ...(defaults[6] as { gradient: object }).gradient, offset: null } }],
    ['contour points', { ...defaults[9], contour: { name: 'x', points: [{ input: 0, output: 0 }] } }],
    ['contour point', { ...defaults[9], contour: { name: 'x', points: [{ input: 0, output: 0 }, { input: 2, output: 0 }] } }],
    ['texture', { ...defaults[0], texture: { patternId: 'checker', scale: 1, depth: 20, invert: false } }],
    ['bevel style', { ...defaults[0], style: 'flat' }],
    ['phase', { ...defaults[7], phase: { x: 'a', y: 0 } }],
    ['pattern id', { ...defaults[7], patternId: '' }],
    ['valid', defaults[4]],
  ];
  const validation = bad.map(([name, v]) => {
    try {
      validateLayerEffect(JSON.parse(JSON.stringify(v ?? null)));
      return { name, value: v ?? null, error: null };
    } catch (e) {
      return { name, value: v ?? null, error: (e as Error).message };
    }
  });
  const effectsValidation = [
    { enabled: true, items: [defaults[1], defaults[1]] },
    { enabled: 'yes', items: [] },
    { enabled: true, scale: 50, items: [] },
    { enabled: true, items: {} },
    { enabled: true, items: [defaults[2], defaults[3]] },
  ].map((v) => {
    try {
      validateLayerEffects(v);
      return { value: v, error: null };
    } catch (e) {
      return { value: v, error: (e as Error).message };
    }
  });
  const merges = [
    [defaults[1], { size: 9, fill: { type: 'color', color: '#123456' } }],
    [defaults[9], { contour: { name: 'c', points: [{ input: 0, output: 1 }, { input: 1, output: 0 }] } }],
    [{ ...defaults[9], contour: { name: 'c', points: [{ input: 0, output: 1 }, { input: 1, output: 0 }] } }, { contour: null }],
    [defaults[1], { kind: 'satin' }],
    [defaults[1], { id: 'other' }],
    [defaults[1], { size: -1 }],
  ].map(([e, changes]) => {
    try {
      return { effect: e, changes, out: mergeLayerEffect(e as LayerEffect, changes as Record<string, unknown>), error: null };
    } catch (err) {
      return { effect: e, changes, out: null, error: (err as Error).message };
    }
  });
  const raw = { enabled: true, scale: 1.5, items: [{ kind: 'stroke', id: 'a', size: 4 }, { kind: 'stroke', id: 'a' }, { kind: 'satin', id: 'b', size: 999 }, { kind: 'nope' }, { kind: 'color-overlay', id: 'c', color: '#abc' }] };
  const normalized = normalizeLayerEffects(raw)!;
  const fingerprints = [
    { enabled: true, items: defaults },
    { enabled: true, scale: 2, items: [defaults[1]] },
    { enabled: false, items: [{ ...defaults[1], id: 'other' }] },
  ].map((fx) => effectsFingerprint(fx as LayerEffects));
  const fields = LAYER_EFFECT_KINDS.map((k) => [k, layerEffectFields(k)]);
  const colors = ['#ff8800', 'abc', ' #FfF ', '#12345', 'red', '#00000g'].map((c) => [c, parseEffectColor(c)]);
  const hex = [[0, 0.5, 1], [-1, 2, 0.1234], [0.999, 0.0019, 0.5]].map((c) => [c, effectColorHex(c)]);
  const contours = [
    { name: 'Linear', points: [{ input: 0, output: 0 }, { input: 1, output: 1 }] },
    { name: 'Cone', points: [{ input: 0, output: 0 }, { input: 0.5, output: 1 }, { input: 1, output: 0 }] },
    { name: 'Steps', points: [{ input: 0, output: 0 }, { input: 0.4, output: 0.3, corner: true }, { input: 0.6, output: 0.8 }, { input: 1, output: 1 }] },
    { name: 'Corners', points: [{ input: 1, output: 1 }, { input: 0, output: 0.2, corner: true }, { input: 0.5, output: 0.9, corner: true }] },
  ].map((c) => {
    const lut = contourLut(c);
    return { contour: c, lut: lut ? b64f(lut) : null };
  });
  const frame = { x: 2, y: 3, width: 10, height: 6 };
  const gradientTs = (['linear', 'radial', 'angle', 'reflected', 'diamond'] as const).flatMap((style) =>
    [[0, 1, false, { x: 0, y: 0 }], [45, 0.5, true, { x: 0.2, y: -0.1 }], [-120, 1.3, false, { x: 0, y: 0.3 }]].map(([angle, scale, reverse, offset]) => ({
      style,
      angle,
      scale,
      reverse,
      offset,
      t: [[2.5, 3.5], [7, 6], [11.5, 8.5], [0, 0], [20, -4]].map(([x, y]) => f32(gradientT(style, angle as number, scale as number, reverse as boolean, offset as { x: number; y: number }, frame, x, y))),
    }))
  );
  const fillRect = { x: 1, y: 2, width: 6, height: 5 };
  const fillColors = [
    { type: 'color', color: '#336699' },
    { type: 'gradient', gradient: { ...defaultEffectGradientLike(), style: 'radial', align: true } },
    { type: 'gradient', gradient: { ...defaultEffectGradientLike(), angle: 30, align: false } },
    { type: 'pattern', patternId: 'checker', scale: 0.5, angle: 15 },
    { type: 'pattern', patternId: 'missing', scale: 1 },
  ].map((f) => ({ fill: f, out: b64f(effectFillColors(f as never, fillRect, frame, { x: 0, y: 0, width: 30, height: 20 }, { x: 1, y: 1 }, ctx)) }));
  return { defaults, reach, margins, local, scaled, validation, effectsValidation, merges, normalize: { raw, out: { ...normalized, items: normalized.items.map((e) => (e.id.startsWith('fx_') ? { ...e, id: '<new>' } : e)) } }, fingerprints, fields, colors, hex, contours, frame, gradientTs, fillRect, fillColors };
}

function defaultEffectGradientLike() {
  return { stops: [{ position: 0, color: '#000000' }, { position: 1, color: '#ffffff' }], style: 'linear', angle: 90, scale: 1, reverse: false, align: true, offset: { x: 0, y: 0 } };
}

// ---------------------------------------------------------------------------
// Patterns, UI, codecs, viewport, layer tree
// ---------------------------------------------------------------------------

function patternVectors() {
  const builtins = builtinPatternIds().map((id) => {
    const p = builtinPattern(id)!;
    return { id, name: p.name, width: p.width, height: p.height, data: b64(p.data) };
  });
  const tile = new PatternTile({ width: 3, height: 2, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255, 200, 100, 50, 64, 1, 2, 3, 4]) });
  const samples = [[0.5, 0.5], [1, 1], [1.7, 0.2], [-0.4, 2.6], [3.5, 1.5], [100.25, -33.75]].map(([u, v]) => {
    const out = [0, 0, 0, 0];
    tile.sample(u, v, out);
    return [u, v, ...out.map(f32)];
  });
  const place = new PatternPlacement({ x: 3, y: 4 }, true, { x: 1, y: -2 }, 0.5, 30);
  const placed = [[0, 0], [10.5, 3.5], [-4, 7]].map(([x, y]) => {
    const out = [0, 0];
    place.map(x, y, out);
    return [x, y, f32(out[0]), f32(out[1])];
  });
  const noise = [[0, 0], [1, 0], [0, 1], [-5, 7], [123456, -98765], [3.7, 2.2]].map(([x, y]) => [x, y, hashNoise(x, y)]);
  return { builtins, tile: { width: 3, height: 2, data: b64([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255, 200, 100, 50, 64, 1, 2, 3, 4]) }, samples, placement: { anchor: { x: 3, y: 4 }, link: true, phase: { x: 1, y: -2 }, scale: 0.5, angle: 30, out: placed }, noise };
}

function uiVectors() {
  const patterns = [{ id: 'doc1', name: 'Paper', width: 2, height: 2, data: new Uint8ClampedArray(16) }];
  const defaults = LAYER_EFFECT_KINDS.map((k) => defaultLayerEffect(k, `id_${k}`));
  const withFills = [
    { ...defaults[1], fill: { type: 'gradient', gradient: defaultEffectGradientLike() } },
    { ...defaults[1], fill: { type: 'pattern', patternId: 'dots', scale: 2 } },
    { ...defaults[8], fill: { type: 'gradient', gradient: defaultEffectGradientLike() } },
  ] as LayerEffect[];
  const controls = [...defaults, ...withFills].map((e) => ({ effect: e, controls: layerEffectControls(e, patterns) }));
  const changes: Array<[LayerEffect, string, unknown]> = [
    [defaults[1], 'fill.type', 'gradient'],
    [defaults[1], 'fill.type', 'pattern'],
    [withFills[0], 'fill.type', 'color'],
    [defaults[1], 'size', 7],
    [withFills[0], 'fill.gradient.stops.last.color', '#ff0000'],
    [withFills[0], 'fill.gradient.angle', 45],
    [defaults[6], 'gradient.stops.0.color', '#00ff00'],
    [defaults[7], 'patternId', 'doc1'],
    [defaults[7], 'patternId', 'unknown'],
    [withFills[1], 'fill.patternId', 'stripes'],
  ];
  const changed = changes.map(([e, key, value]) => ({ effect: e, key, value, out: effectControlChange(e, key, value, patterns) }));
  const panels = [
    null,
    { id: 'a', type: 'adjustment' },
    { id: 'b', type: 'pixel' },
    { id: 'c', type: 'pixel', locks: { all: true }, effects: { enabled: false, scale: 2, items: [defaults[2], { ...defaults[5], enabled: false }] } },
  ].map((l) => ({ layer: l, panel: layerEffectsPanel(l as never) }));
  return { patterns: [{ id: 'doc1', name: 'Paper', width: 2, height: 2, data: b64(new Uint8ClampedArray(16)) }], controls, changed, panels };
}

function codecVectors() {
  const r = lcg(11);
  const inputs: Array<{ name: string; data: Uint8Array }> = [
    { name: 'empty', data: new Uint8Array(0) },
    { name: 'hello', data: new TextEncoder().encode('hello hello hello world') },
    { name: 'runs', data: Uint8Array.from({ length: 3000 }, (_, i) => (i < 1500 ? 7 : i % 3)) },
    { name: 'random', data: Uint8Array.from({ length: 2000 }, () => Math.floor(r() * 256)) },
    { name: 'random 66k (two blocks)', data: Uint8Array.from({ length: 66000 }, () => Math.floor(r() * 256)) },
    { name: 'text', data: new TextEncoder().encode('The raster module: tiled copy-on-write surfaces, blend modes and a per-tile compositor. '.repeat(12)) },
  ];
  const zlib = inputs.map(({ name, data }) => ({ name, input: b64(data), adler: adler32(data), deflate: b64(deflate(data)), stored: b64(deflate(data, 0)), raw: b64(deflateRaw(data)) }));
  // Streams written by Node's zlib (fixed Huffman, stored, dynamic at level 9) that `inflate` must read.
  const foreign = inputs.slice(1, 4).flatMap(({ name, data }) =>
    [
      ['fixed', deflateSync(data, { strategy: zc.Z_FIXED })],
      ['level 0', deflateSync(data, { level: 0 })],
      ['level 9', deflateSync(data, { level: 9 })],
    ].map(([kind, z]) => ({ name: `${name} ${kind}`, stream: b64(z as Buffer), out: b64(inflate(new Uint8Array(z as Buffer))) }))
  );
  const rawInflate = { stream: b64(deflateRaw(inputs[2].data)), out: b64(inflateRaw(deflateRaw(inputs[2].data))) };
  const inflateErrors = [
    [1, 2, 3],
    [0x78, 0x01, 0xff, 0xff, 0xff, 0xff, 0, 0],
    [0x79, 0x01, 1, 2, 3, 4, 5],
    [0x78, 0x20, 1, 2, 3, 4, 5],
    [...deflate(inputs[1].data).slice(0, -1), 0],
  ].map((bytes) => {
    try {
      inflate(new Uint8Array(bytes));
      return { input: b64(bytes), error: null };
    } catch (e) {
      return { input: b64(bytes), error: (e as Error).message };
    }
  });
  let bombError: string | null = null;
  try {
    inflate(deflate(new Uint8Array(5000)), { maxOutput: 1000 });
  } catch (e) {
    bombError = (e as Error).message;
  }
  const images = [
    { name: 'rgba 8x8', width: 8, height: 8, channels: 4, data: gradientPixels(8, 8, 12, (x, y) => (x * 31 + y * 7) % 256) },
    { name: 'grey 16x16', width: 16, height: 16, channels: 1, data: Uint8ClampedArray.from({ length: 256 }, (_, i) => (i * 13) % 256) },
    { name: '1x1', width: 1, height: 1, channels: 4, data: new Uint8ClampedArray([1, 2, 3, 4]) },
    { name: 'random 33x7', width: 33, height: 7, channels: 4, data: Uint8ClampedArray.from({ length: 33 * 7 * 4 }, () => Math.floor(r() * 256)) },
    { name: 'solid 64x64', width: 64, height: 64, channels: 4, data: new Uint8ClampedArray(64 * 64 * 4).fill(200) },
    { name: 'smooth 40x30', width: 40, height: 30, channels: 4, data: gradientPixels(40, 30, 13, () => 255) },
  ];
  const png = images.map((im) => {
    const bytes = encodePng(im.width, im.height, im.data, im.channels as 1 | 4);
    return { name: im.name, width: im.width, height: im.height, channels: im.channels, data: b64(im.data), png: b64(bytes), decoded: b64(decodePng(bytes).data), gray: b64(decodePng(bytes, { keepGray: true }).data) };
  });
  const foreignPng = foreignPngs().map((p) => {
    try {
      const d = decodePng(p.bytes, { keepGray: p.keepGray });
      return { name: p.name, keepGray: p.keepGray, png: b64(p.bytes), width: d.width, height: d.height, channels: d.channels, out: b64(d.data), error: null };
    } catch (e) {
      return { name: p.name, keepGray: p.keepGray, png: b64(p.bytes), width: 0, height: 0, channels: 0, out: null, error: (e as Error).message };
    }
  });
  const base64 = {
    roundTrip: [[], [0], [1, 2], [1, 2, 3], [250, 251, 252, 253], Array.from({ length: 100 }, (_, i) => (i * 37) % 256)].map((a) => [a, bytesToBase64(Uint8Array.from(a))]),
    decode: ['AQID', 'AQ==', 'AQ', ' A Q I D ', '-_8', 'AQ=ID'].map((s) => [s, Array.from(base64ToBytes(s))]),
    invalid: (() => {
      try {
        base64ToBytes('AQ*D');
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })(),
    dataUrls: ['data:image/png;base64,AQID', 'data:;base64,AAA=', 'data:text/plain,hi%20there', 'data:text/plain;charset=utf-8,%E2%82%AC', 'nope'].map((u) => {
      const p = parseDataUrl(u);
      return [u, p ? { mime: p.mime, bytes: Array.from(p.bytes) } : null];
    }),
  };
  return { zlib, foreign, rawInflate, inflateErrors, bombError, png, foreignPng, base64 };
}

/** PNGs in formats `encodePng` does not write (palette, 16-bit, low bit depths, tRNS), built by hand. */
function foreignPngs(): Array<{ name: string; bytes: Uint8Array; keepGray: boolean }> {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = (v: number) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const chunk = (type: string, body: number[]) => {
    const t = [...type].map((c) => c.charCodeAt(0));
    return [...u32(body.length), ...t, ...body, ...u32(crc(Uint8Array.from([...t, ...body])))];
  };
  const png = (w: number, h: number, depth: number, type: number, rows: number[][], extra: Array<[string, number[]]> = [], filters?: number[], interlace = 0) => {
    const raw: number[] = [];
    rows.forEach((row, y) => raw.push(filters?.[y] ?? 0, ...row));
    return Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      ...chunk('IHDR', [...u32(w), ...u32(h), depth, type, 0, 0, interlace]),
      ...extra.flatMap(([t, b]) => chunk(t, b)),
      ...chunk('IDAT', Array.from(deflate(Uint8Array.from(raw)))),
      ...chunk('IEND', []),
    ]);
  };
  return [
    { name: 'palette 2-bit with tRNS', bytes: png(4, 2, 2, 3, [[0b00011011], [0b11100100]], [['PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]], ['tRNS', [128, 255]]]), keepGray: false },
    { name: 'grey 1-bit', bytes: png(9, 2, 1, 0, [[0b10101010, 0b10000000], [0b01010101, 0]]), keepGray: true },
    { name: 'grey 4-bit tRNS', bytes: png(3, 2, 4, 0, [[0x0f, 0x80], [0x37, 0xa0]], [['tRNS', [0, 7]]]), keepGray: true },
    { name: 'grey 16-bit', bytes: png(2, 2, 16, 0, [[0x12, 0x34, 0xff, 0xff], [0, 1, 0x80, 0]]), keepGray: false },
    { name: 'rgb 8-bit tRNS', bytes: png(2, 2, 8, 2, [[1, 2, 3, 4, 5, 6], [1, 2, 3, 9, 9, 9]], [['tRNS', [0, 1, 0, 2, 0, 3]]]), keepGray: false },
    { name: 'rgb 16-bit filters', bytes: png(2, 3, 16, 2, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [200, 0, 100, 0, 50, 0, 25, 0, 12, 0, 6, 0]], [], [1, 2, 4]), keepGray: false },
    { name: 'grey alpha average filter', bytes: png(3, 2, 8, 4, [[10, 255, 20, 128, 30, 0], [5, 5, 5, 5, 5, 5]], [], [0, 3]), keepGray: false },
    { name: 'rgba 16-bit paeth', bytes: png(2, 2, 16, 6, [[1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8, 0], [9, 0, 9, 0, 9, 0, 9, 0, 1, 0, 1, 0, 1, 0, 1, 0]], [], [0, 4]), keepGray: false },
    { name: 'interlaced', bytes: png(1, 1, 8, 0, [[5]], [], undefined, 1), keepGray: false },
    { name: 'bad filter', bytes: png(1, 1, 8, 0, [[5]], [], [7]), keepGray: false },
    { name: 'bad format', bytes: png(1, 1, 3, 2, [[5]]), keepGray: false },
    { name: 'palette out of range', bytes: png(1, 1, 8, 3, [[9]], [['PLTE', [1, 2, 3]]]), keepGray: false },
    { name: 'not png', bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), keepGray: false },
  ];
}

class FakeCanvas {
  data = new Uint8ClampedArray(256 * 256 * 4);
  getContext() {
    return {
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img: { data: Uint8ClampedArray }) => this.data.set(img.data),
    };
  }
}

function viewportVectors() {
  const mappings = [{}, { origin: { x: 10, y: -5 }, pixelsPerUnit: 2 }, { pixelsPerUnit: 0.5 }];
  const views = [{ x: 0, y: 0, zoom: 1 }, { x: 37.5, y: -12, zoom: 0.3 }, { x: -100, y: 40, zoom: 2.5 }, { x: 0, y: 0, zoom: 0.01 }];
  const mapped = mappings.flatMap((m) => views.map((v) => ({ mapping: m, view: v, w2s: worldToSurface(m, 13.25, -7.5), s2w: surfaceToWorld(m, 13.25, -7.5), rect: worldRectToSurface(m, { x: -3.2, y: 4.7, width: 10.1, height: 0.2 }), visible: visibleSurfaceRect(m, v, 800, 600, 3) })));
  const zooms = [0.001, 0.1, 0.33, 1, 1.5, 3, 7.9, 100, NaN, -1].map((z) => [z, surfaceResolutionForZoom(z), surfaceResolutionForZoom(z, { devicePixelRatio: 2, min: 0.5, max: 4 })]);
  const mips = [1, 0.5, 0.49, 0.25, 0.1, 0.01, 0, -1].map((s) => [s, surfaceMipLevel(s), surfaceMipLevel(s, 2)]);
  // Drawing: record the draw calls and each drawn image's pixels.
  const surface = writeRegion(
    surfaceFromPixels({ width: 20, height: 20, data: gradientPixels(20, 20, 14, () => 200) }, 4, 250, 250),
    { x: 600, y: -300, width: 4, height: 4 },
    new Uint8ClampedArray(64).fill(99)
  );
  const draws = [
    [{ origin: { x: 0, y: 0 } }, { x: 0, y: 0, zoom: 1 }, { width: 600, height: 400 }],
    [{ pixelsPerUnit: 1 }, { x: 100, y: 200, zoom: 0.2 }, { width: 400, height: 300 }],
    [{ pixelsPerUnit: 2 }, { x: -10, y: 5, zoom: 0.05 }, { width: 300, height: 300, maxMipLevel: 3 }],
  ].map(([mapping, view, options]) => {
    const calls: number[][] = [];
    const images: string[] = [];
    const renderer = new SurfaceViewportRenderer(() => new FakeCanvas());
    const record = {
      imageSmoothingEnabled: false,
      drawImage(img: FakeCanvas, dx: number, dy: number, dw: number, dh: number) {
        calls.push([dx, dy, dw, dh]);
        images.push(createHashLike(img.data));
      },
    };
    const stats = renderer.draw(record as never, surface, mapping as never, view as never, options as never);
    const again = renderer.draw(record as never, surface, mapping as never, view as never, options as never);
    return { mapping, view, options, stats, again, smoothing: record.imageSmoothingEnabled, calls, images };
  });
  return { mapped, zooms, mips, surface: { tiles: [[250, 250, 20, 20, b64(gradientPixels(20, 20, 14, () => 200))]], patch: [600, -300, 4, 4, 99] }, draws };
}

/** A short digest of image bytes (FNV-1a), so draw records stay small. */
function createHashLike(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
  return h.toString(16);
}

function layerTreeVectors() {
  type N = { id: string; type: string; children?: N[] };
  const tree: N[] = [{ id: 'a', type: 'pixel' }, { id: 'g', type: 'group', children: [{ id: 'b', type: 'pixel' }, { id: 'h', type: 'group', children: [{ id: 'c', type: 'pixel' }] }] }, { id: 'd', type: 'pixel' }];
  const ids = (list: N[]): unknown => list.map((l) => (l.children ? [l.id, ids(l.children)] : l.id));
  const loc = (id: string) => {
    const f = findLayer(tree, id);
    return f ? { id: f.layer.id, parent: (f.parent as N | null)?.id ?? null, index: f.index, path: (f.path as N[]).map((p) => p.id) } : null;
  };
  return {
    tree: ids(tree),
    flat: flattenLayers(tree).map((l) => l.id),
    find: ['a', 'c', 'h', 'zz'].map((id) => [id, loc(id)]),
    removeC: ids(mapLayer(tree, 'c', () => null)),
    renameB: ids(mapLayer(tree, 'b', (l) => ({ ...l, id: 'B' }))),
    insertTop: ids(insertLayer(tree, { id: 'n', type: 'pixel' }, null)),
    insertIntoH: ids(insertLayer(tree, { id: 'n', type: 'pixel' }, 'h', 0)),
    insertClamped: ids(insertLayer(tree, { id: 'n', type: 'pixel' }, 'g', 99)),
  };
}

function vectors() {
  return {
    blend: blendVectors(),
    surface: surfaceVectors(),
    deep: deepVectors(),
    pigment: pigmentVectors(),
    blur: blurVectors(),
    curve: curveVectors(),
    transform: transformVectors(),
    compositor: compositorVectors(),
    effects: effectVectors(),
    patterns: patternVectors(),
    ui: uiVectors(),
    codec: codecVectors(),
    viewport: viewportVectors(),
    layers: layerTreeVectors(),
  };
}

describe('Swift raster test vectors', () => {
  it('match the committed fixture (the Swift tests read it)', () => {
    const now = JSON.stringify(vectors()) + '\n';
    if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, now);
    expect(readFileSync(FILE, 'utf8')).toBe(now);
  });
});
