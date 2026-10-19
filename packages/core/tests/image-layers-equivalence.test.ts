// Equivalence of the layer pipeline with the renderer it replaces.
//
// The legacy base render was: draw the (cropped) source through the projection, then
// `applyAdjustments` (base process 1 or 2, opacity, adjustment layers with their masks resampled
// through the same projection, blur) on the projected buffer. The layer pipeline composites the
// migrated stack in document space, then projects and applies the output stage. For every
// document that the renderer sends through the compositor, the two must agree byte for byte.
// The documents it keeps on the legacy path are the cases listed in `needsLegacyBase`.
import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_LAYER_CONTROLS,
  BLEND_MODES,
  ImageEditorController,
  applyAdjustments,
  baseProjection,
  buildLayerMaskPlanes,
  createAdjustmentLayer,
  encodeSelectionRle,
  getRotatedSize,
  layersFromLegacy,
  needsLegacyBase,
  projectImagePoint,
  projectQuarterTurn,
  renderLayeredBase,
  setControlPath,
  surfaceFromPixels,
  type AdjustmentLayer,
  type AdjustmentLayerMask,
  type CropBox,
  type DepthMaskOptions,
  type ImageAdjustments,
  type ImageTransform,
} from '../src/image-editor';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const W = 301;
const H = 263;

function sourcePixels(seed: number, transparent: boolean) {
  const r = rng(seed);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Smooth gradients plus noise, so tone curves and blurs see real structure.
      data[i] = (x * 255) / W + r() * 30;
      data[i + 1] = (y * 255) / H + r() * 30;
      data[i + 2] = 128 + 100 * Math.sin((x + y) / 17) + r() * 20;
      data[i + 3] = transparent && r() < 0.3 ? Math.floor(r() * 256) : 255;
    }
  }
  // Canvas readback never yields colour under zero alpha.
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 0) data[i] = data[i + 1] = data[i + 2] = 0;
  return { width: W, height: H, data };
}

function randomMask(r: () => number, w = W, h = H): AdjustmentLayerMask {
  const bytes = new Uint8Array(w * h);
  const cx = r() * w;
  const cy = r() * h;
  const rad = 30 + r() * 120;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      bytes[y * w + x] = d < rad ? 255 : d < rad + 20 ? Math.round(255 * (1 - (d - rad) / 20)) : 0;
    }
  }
  const mask: AdjustmentLayerMask = { width: w, height: h, rle: encodeSelectionRle(bytes) };
  if (r() < 0.4) mask.density = Math.round(r() * 100) / 100;
  if (r() < 0.4) mask.feather = Math.round(r() * 60) / 10;
  if (r() < 0.15) mask.enabled = false;
  return mask;
}

function randomLayer(r: () => number): AdjustmentLayer {
  const kind = ADJUSTMENT_KINDS[Math.floor(r() * ADJUSTMENT_KINDS.length)].kind;
  let params: Record<string, unknown> = {};
  if (kind === 'curves') {
    const pts = [0, 64, 128, 192, 255].map((input) => ({ input, output: Math.max(0, Math.min(255, Math.round(input + (r() - 0.5) * 120))) }));
    params = { master: pts, red: [{ input: 0, output: 0 }, { input: 255, output: Math.round(200 + r() * 55) }] };
  } else {
    for (const c of ADJUSTMENT_LAYER_CONTROLS[kind]) {
      if (r() < 0.5) continue;
      const v = c.min + Math.round((r() * (c.max - c.min)) / c.step) * c.step;
      params = setControlPath(params, c.id, v) as Record<string, unknown>;
    }
  }
  const layer = createAdjustmentLayer(kind, {
    params: params as never,
    opacity: r() < 0.5 ? 1 : Math.round(r() * 100) / 100,
    blend: r() < 0.5 ? 'normal' : BLEND_MODES[Math.floor(r() * BLEND_MODES.length)].id,
    enabled: r() > 0.1,
  });
  if (r() < 0.5) layer.mask = randomMask(r);
  return layer;
}

function randomDocument(seed: number) {
  const r = rng(seed);
  const pick = () => (r() < 0.4 ? 0 : Math.round((r() * 2 - 1) * 100));
  const adjustments: ImageAdjustments = {
    brightness: pick(),
    contrast: pick(),
    saturation: pick(),
    exposure: pick(),
    temperature: pick(),
    tint: pick(),
    blur: r() < 0.3 ? Math.round(r() * 8) : 0,
    opacity: 1,
    process: r() < 0.5 ? 1 : 2,
  };
  const n = Math.floor(r() * 4);
  if (n) adjustments.layers = Array.from({ length: n }, () => randomLayer(r));
  const crop: CropBox | null =
    r() < 0.5
      ? null
      : (() => {
          const x = Math.floor(r() * 100);
          const y = Math.floor(r() * 100);
          return { x, y, width: 1 + Math.floor(r() * (W - x - 1)), height: 1 + Math.floor(r() * (H - y - 1)) };
        })();
  const transform: ImageTransform = { rotate: [0, 90, 180, 270][Math.floor(r() * 4)], flipH: r() < 0.5, flipV: r() < 0.5 };
  return { adjustments, crop, transform, transparent: r() < 0.3, seed };
}

const DEPTH_OFF: DepthMaskOptions = { enabled: false, maskSource: null, mode: 'threshold', depthRange: [0, 255], softness: 10, invert: false };

/** Equal byte arrays, reporting the first difference (a full diff of big arrays is very slow). */
function expectSameBytes(got: ArrayLike<number>, want: ArrayLike<number>, what: string) {
  expect(got.length, what).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) throw new Error(`${what}: byte ${i} (pixel ${i >> 2}, channel ${i & 3}) is ${got[i]}, was ${want[i]}`);
  }
}

/** The old `renderBaseImage` without a canvas: project the source, then `applyAdjustments`. */
function legacyBase(source: ReturnType<typeof sourcePixels>, adjustments: ImageAdjustments, region: CropBox, transform: ImageTransform) {
  const out = projectQuarterTurn(source.data, { x: 0, y: 0, width: W, height: H }, region, transform);
  const layerMasks = buildLayerMaskPlanes(adjustments.layers, W, H, baseProjection(region, transform, out.width, out.height), out.width, out.height);
  applyAdjustments(out as unknown as ImageData, adjustments, layerMasks ? { layerMasks } : {});
  return out;
}

describe('legacy equivalence', () => {
  it('renders every compositor-routed v1 / v2 document byte for byte as the old pipeline did', () => {
    let routed = 0;
    let legacy = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const doc = randomDocument(seed);
      const source = sourcePixels(seed, doc.transparent);
      const stack = layersFromLegacy({ adjustments: doc.adjustments, depthMask: DEPTH_OFF, annotations: [] }, W, H);
      const region = doc.crop ?? { x: 0, y: 0, width: W, height: H };
      const route = needsLegacyBase({ stack, region, canvas: { width: W, height: H }, transform: doc.transform, sourceOpaque: !doc.transparent });
      if (route) {
        legacy++;
        continue;
      }
      routed++;
      const surface = surfaceFromPixels(source, 4);
      const got = renderLayeredBase(stack, region, doc.transform, { width: W, height: H, surfaceOf: () => surface });
      const want = legacyBase(source, doc.adjustments, region, doc.transform);
      expect({ w: got.width, h: got.height }).toEqual({ w: want.width, h: want.height });
      for (let i = 0; i < want.data.length; i++) {
        if (got.data[i] !== want.data[i]) {
          throw new Error(`seed ${seed}: byte ${i} (pixel ${i >> 2}, channel ${i & 3}) is ${got.data[i]}, was ${want.data[i]}`);
        }
      }
    }
    // Most random documents take the compositor; the rest are the documented legacy cases.
    expect(routed).toBeGreaterThan(30);
    expect(legacy).toBeGreaterThan(0);
  });

  it('also holds through the controller (load, migrate, render)', () => {
    for (const seed of [3, 7, 11]) {
      const doc = randomDocument(seed);
      doc.adjustments.blur = 0;
      const source = sourcePixels(seed, false);
      const c = new ImageEditorController({ initialState: { version: 2, adjustments: doc.adjustments, crop: null, transform: doc.transform } });
      c.setSamplePixels(source);
      // Geometry follows the source size (no image element in Node).
      (c.getState() as { imageDimensions: { width: number; height: number } }).imageDimensions = { width: W, height: H };
      c.loadJSON({ version: 2, adjustments: doc.adjustments, crop: null, transform: doc.transform, depthMask: DEPTH_OFF, annotations: [] });
      const s = c.getState();
      const region = { x: 0, y: 0, width: W, height: H };
      const stack = { layers: s.layers, outputOpacity: s.outputOpacity, legacyOutputBlur: s.legacyOutputBlur };
      const surface = surfaceFromPixels(source, 4);
      const got = renderLayeredBase(stack, region, doc.transform, { width: W, height: H, surfaceOf: () => surface });
      expectSameBytes(got.data, legacyBase(source, doc.adjustments, region, doc.transform).data, `seed ${seed}`);
    }
  });

  it('keeps the documented cases on the legacy path', () => {
    const base = { adjustments: { brightness: 10, contrast: 0, saturation: 0, exposure: 0, temperature: 0, blur: 0, opacity: 1 }, depthMask: DEPTH_OFF, annotations: [] };
    const full = { x: 0, y: 0, width: W, height: H };
    const flat: ImageTransform = { rotate: 0, flipH: false, flipV: false };
    const route = (parts: Parameters<typeof layersFromLegacy>[0], region: CropBox = full, transform = flat, sourceOpaque = true) =>
      needsLegacyBase({ stack: layersFromLegacy(parts, W, H), region, canvas: { width: W, height: H }, transform, sourceOpaque });
    expect(route(base)).toBe(false);
    expect(route(base, full, { rotate: 33, flipH: false, flipV: false })).toBe(true);
    expect(route(base, { x: 0.5, y: 0, width: 10, height: 10 })).toBe(true);
    expect(route({ ...base, depthMask: { ...DEPTH_OFF, enabled: true, maskSource: 'data:x' } })).toBe(true);
    expect(route({ ...base, depthMask: { ...DEPTH_OFF, enabled: false, maskSource: 'data:x' } })).toBe(false);
    expect(route({ ...base, adjustments: { ...base.adjustments, opacity: 0.5 } })).toBe(true);
    const blurred = { ...base, adjustments: { ...base.adjustments, blur: 4 } };
    expect(route(blurred)).toBe(false);
    expect(route(blurred, { x: 1, y: 1, width: 50, height: 50 })).toBe(true);
    expect(route(blurred, full, { rotate: 90, flipH: false, flipV: false })).toBe(true);
    expect(route(blurred, full, { rotate: 180, flipH: true, flipV: false })).toBe(false);
    const layered = { ...blurred, adjustments: { ...blurred.adjustments, layers: [createAdjustmentLayer('invert')] } };
    expect(route(layered, { x: 1, y: 1, width: 50, height: 50 })).toBe(false); // migrated output blur runs after the crop
    expect(route(layered, full, flat, false)).toBe(true);
    const small = createAdjustmentLayer('invert', { mask: randomMask(rng(1), 100, 80) });
    expect(route({ ...base, adjustments: { ...base.adjustments, layers: [small] } })).toBe(true);
  });

  it('projects quarter turns as the canvas projection does', () => {
    const src = sourcePixels(99, false);
    const region = { x: 10, y: 20, width: 50, height: 40 };
    for (const rotate of [0, 90, 180, 270]) {
      for (const flipH of [false, true]) {
        const transform = { rotate, flipH, flipV: false };
        const out = projectQuarterTurn(src.data, { x: 0, y: 0, width: W, height: H }, region, transform);
        const size = getRotatedSize(region.width, region.height, transform);
        expect([out.width, out.height]).toEqual([size.width, size.height]);
        // Each region pixel lands where the shared projection puts its centre.
        const p = baseProjection(region, transform, out.width, out.height);
        for (let y = region.y; y < region.y + region.height; y += 7) {
          for (let x = region.x; x < region.x + region.width; x += 5) {
            const t = projectImagePoint({ x: x + 0.5, y: y + 0.5 }, p);
            const d = (Math.floor(t.y) * out.width + Math.floor(t.x)) * 4;
            const s = (y * W + x) * 4;
            expect(Array.from(out.data.subarray(d, d + 4))).toEqual(Array.from(src.data.subarray(s, s + 4)));
          }
        }
      }
    }
  });
});
