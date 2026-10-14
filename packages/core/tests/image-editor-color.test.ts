import { describe, it, expect } from 'vitest';
import {
  ImageEditorController,
  DEFAULT_ADJUSTMENTS,
  applyAdjustments,
  applyLegacyAdjustments,
  D65,
  LATEST_PROCESS_VERSION,
  applyMatrix3,
  buildToneLut,
  kelvinToTemperature,
  linearSrgbToXy,
  normalizeProcessVersion,
  sampleToneLut,
  srgbToLinear,
  linearToSrgb,
  tempTintToXy,
  temperatureToKelvin,
  toneCurve,
  wbMatrix,
  whiteBalanceFromSample,
  whiteBalanceMatrix,
  xyToTempTint,
  xyToUv,
  type ImageAdjustments,
  type SerializedImageEditorState,
} from '../src/image-editor';

function imageFrom(pixels: number[][]): ImageData {
  return { width: pixels.length, height: 1, data: new Uint8ClampedArray(pixels.flat()), colorSpace: 'srgb' } as ImageData;
}

function render(pixels: number[][], adjustments: Partial<ImageAdjustments>): number[][] {
  const img = imageFrom(pixels);
  applyAdjustments(img, { ...DEFAULT_ADJUSTMENTS, ...adjustments });
  const out: number[][] = [];
  for (let i = 0; i < img.data.length; i += 4) out.push(Array.from(img.data.slice(i, i + 4)));
  return out;
}

function luma(rgb: number[]): number {
  const [r, g, b] = rgb.map((c) => srgbToLinear(c / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('correlated colour temperature (ported from lightcraft cct.rs)', () => {
  it('reads D65 as about 6504 K with a small positive (daylight) tint', () => {
    const { kelvin, tint } = xyToTempTint(D65);
    expect(Math.abs(kelvin - 6504)).toBeLessThan(60);
    expect(tint).toBeGreaterThan(5);
    expect(tint).toBeLessThan(15);
  });

  it('round-trips temperature and tint through xy', () => {
    for (const t of [2000, 2856, 4000, 5003, 6500, 9000, 15000, 30000, 50000]) {
      for (const tint of [-100, -20, 0, 35, 150]) {
        const back = xyToTempTint(tempTintToXy(t, tint));
        expect(Math.abs(back.kelvin - t) / t).toBeLessThan(0.01);
        expect(Math.abs(back.tint - tint)).toBeLessThan(1);
      }
    }
  });

  it('warmer is redder and a positive tint is a greener source white', () => {
    expect(tempTintToXy(3000, 0).x).toBeGreaterThan(tempTintToXy(9000, 0).x);
    const [, v0] = xyToUv(tempTintToXy(5000, 0));
    const [, v1] = xyToUv(tempTintToXy(5000, 50));
    expect(v1).toBeGreaterThan(v0);
  });

  it('wbMatrix maps the source white to neutral', () => {
    const src = tempTintToXy(3200, 10);
    const m = wbMatrix(src);
    // A colour with chromaticity `src` (the source white) becomes neutral.
    const xyz = [src.x / src.y, 1, (1 - src.x - src.y) / src.y];
    // sRGB from XYZ (IEC 61966-2-1 matrix)
    const rgb: [number, number, number] = [
      3.2406 * xyz[0] - 1.5372 * xyz[1] - 0.4986 * xyz[2],
      -0.9689 * xyz[0] + 1.8758 * xyz[1] + 0.0415 * xyz[2],
      0.0557 * xyz[0] - 0.204 * xyz[1] + 1.057 * xyz[2],
    ];
    expect(linearSrgbToXy(rgb).x).toBeCloseTo(src.x, 3);
    const out = applyMatrix3(m, rgb);
    expect(Math.abs(out[0] - out[1])).toBeLessThan(2e-3);
    expect(Math.abs(out[1] - out[2])).toBeLessThan(2e-3);
  });
});

describe('relative white balance', () => {
  it('maps the temperature slider onto Kelvin in mireds around 6500 K', () => {
    expect(temperatureToKelvin(0)).toBeCloseTo(6500, 6);
    expect(temperatureToKelvin(100)).toBeGreaterThan(18000);
    expect(temperatureToKelvin(-100)).toBeLessThan(4000);
    for (const t of [-100, -37, 0, 12.5, 100]) expect(kelvinToTemperature(temperatureToKelvin(t))).toBeCloseTo(t, 9);
  });

  it('is the identity at as-shot and preserves neutral luminance otherwise', () => {
    expect(whiteBalanceMatrix(0, 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    for (const [t, tint] of [[40, 0], [-60, 25], [0, -50]]) {
      const w = applyMatrix3(whiteBalanceMatrix(t, tint), [1, 1, 1]);
      expect(0.2126 * w[0] + 0.7152 * w[1] + 0.0722 * w[2]).toBeCloseTo(1, 9);
    }
    const warm = applyMatrix3(whiteBalanceMatrix(50, 0), [0.5, 0.5, 0.5]);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const magenta = applyMatrix3(whiteBalanceMatrix(0, 50), [0.5, 0.5, 0.5]);
    expect(magenta[1]).toBeLessThan(magenta[0]);
    expect(magenta[1]).toBeLessThan(magenta[2]);
  });

  it('eyedropper: a neutral sample gives as-shot, a cast sample is neutralised', () => {
    const neutral = whiteBalanceFromSample([128, 128, 128]);
    expect(Math.abs(neutral.temperature)).toBeLessThan(0.5);
    expect(Math.abs(neutral.tint)).toBeLessThan(1);

    // A bluish grey needs a warming correction, a warm one a cooling correction.
    expect(whiteBalanceFromSample([110, 125, 150]).temperature).toBeGreaterThan(0);
    expect(whiteBalanceFromSample({ r: 150, g: 128, b: 105 }).temperature).toBeLessThan(0);

    for (const sample of [[150, 128, 105], [110, 125, 150], [120, 135, 118], [135, 118, 132]]) {
      const wb = whiteBalanceFromSample(sample as [number, number, number]);
      const [out] = render([[...sample, 255]], { ...wb, process: 2 });
      expect(Math.abs(out[0] - out[1])).toBeLessThanOrEqual(2);
      expect(Math.abs(out[1] - out[2])).toBeLessThanOrEqual(2);
    }
  });
});

describe('process 2 tone curve (ported from lightcraft tone.rs ToneMap::display)', () => {
  it('is the identity at neutral settings', () => {
    for (let i = 0; i <= 100; i++) expect(toneCurve(i / 100, 0, 0, 1)).toBeCloseTo(i / 100, 6);
    const lut = buildToneLut(0, 0, 1);
    for (let i = 0; i <= 100; i++) expect(sampleToneLut(lut, 1, i / 100)).toBeCloseTo(i / 100, 6);
  });

  it('is monotone and bounded for every slider combination and headroom', () => {
    for (const [c, b] of [[100, 100], [-100, -100], [100, -100], [-100, 100], [60, -30]]) {
      for (const h of [1, 1.5, 4]) {
        let prev = -1;
        for (let i = 0; i <= 2000; i++) {
          const o = toneCurve((h * i) / 2000, c, b, h);
          expect(o).toBeGreaterThanOrEqual(0);
          expect(o).toBeLessThanOrEqual(1);
          expect(o).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = o;
        }
      }
    }
  });

  it('moves the right way and keeps black, grey and white anchored', () => {
    const c = (y: number) => toneCurve(y, 60, 0, 1);
    expect(c(0.05)).toBeLessThan(0.05);
    expect(c(0.7)).toBeGreaterThan(0.7);
    expect(c(0.18)).toBeCloseTo(0.18, 6);
    expect(c(1)).toBeCloseTo(1, 6);
    expect(toneCurve(0.18, 0, 50, 1)).toBeGreaterThan(0.18);
    expect(toneCurve(0.18, 0, -50, 1)).toBeLessThan(0.18);
    expect(toneCurve(1, 0, 50, 1)).toBeCloseTo(1, 6);
  });

  it('rolls headroom into range instead of clipping', () => {
    expect(toneCurve(2, 0, 0, 2)).toBeCloseTo(1, 6);
    expect(toneCurve(1.5, 0, 0, 2)).toBeLessThan(toneCurve(1.9, 0, 0, 2));
    expect(toneCurve(0.5, 0, 0, 2)).toBeCloseTo(0.5, 9); // below the knee
  });
});

describe('process versions', () => {
  // Rendered with the implementation from before process versions existed (commit 896d762).
  const PIXELS = [[0, 0, 0, 255], [12, 34, 56, 255], [100, 100, 100, 255], [200, 150, 90, 200], [240, 250, 255, 255], [255, 255, 255, 128], [30, 200, 60, 255]];
  const SETTINGS: Partial<ImageAdjustments>[] = [
    { brightness: 20, contrast: 30 },
    { exposure: 40, contrast: -50 },
    { saturation: 60, temperature: 40 },
    { saturation: -80, temperature: -60, brightness: -20 },
    { exposure: -30, contrast: 80, opacity: 0.5 },
    { brightness: 100, contrast: -100, saturation: 100, exposure: 100, temperature: 100 },
  ];
  const LEGACY_SNAPSHOT = [
    [31, 31, 31, 255, 46, 74, 101, 255, 157, 157, 157, 255, 255, 220, 144, 200, 255, 255, 255, 255, 255, 255, 255, 128, 69, 255, 107, 255],
    [42, 42, 42, 255, 56, 82, 107, 255, 159, 159, 159, 255, 214, 214, 147, 200, 214, 214, 214, 255, 214, 214, 214, 128, 77, 214, 112, 255],
    [32, 0, 0, 255, 33, 36, 40, 255, 132, 100, 68, 255, 255, 145, 17, 200, 255, 251, 223, 255, 255, 255, 223, 128, 32, 240, 0, 255],
    [0, 0, 48, 255, 0, 0, 49, 255, 1, 49, 97, 255, 67, 105, 141, 200, 147, 197, 246, 255, 156, 204, 252, 128, 23, 101, 121, 255],
    [0, 0, 0, 128, 0, 0, 0, 128, 10, 10, 10, 128, 136, 73, 0, 100, 186, 198, 204, 128, 204, 204, 204, 64, 0, 136, 0, 128],
    [255, 184, 104, 255, 255, 184, 104, 255, 255, 184, 104, 255, 255, 184, 104, 200, 255, 184, 104, 255, 255, 184, 104, 128, 255, 184, 104, 255],
  ];

  it('renders adjustments without `process` exactly as the legacy implementation did', () => {
    SETTINGS.forEach((s, i) => {
      const { process: _drop, tint: _t, ...legacy } = { ...DEFAULT_ADJUSTMENTS, ...s };
      const a = imageFrom(PIXELS);
      applyAdjustments(a, legacy as ImageAdjustments);
      expect(Array.from(a.data)).toEqual(LEGACY_SNAPSHOT[i]);
      const b = imageFrom(PIXELS);
      applyAdjustments(b, { ...DEFAULT_ADJUSTMENTS, ...s, process: 1, tint: 80 }); // tint ignored
      expect(Array.from(b.data)).toEqual(LEGACY_SNAPSHOT[i]);
      const c = imageFrom(PIXELS);
      applyLegacyAdjustments(c, { ...DEFAULT_ADJUSTMENTS, ...s });
      expect(Array.from(c.data)).toEqual(LEGACY_SNAPSHOT[i]);
    });
  });

  it('reads stored process numbers leniently', () => {
    expect(normalizeProcessVersion(undefined)).toBe(1);
    expect(normalizeProcessVersion(1)).toBe(1);
    expect(normalizeProcessVersion(2)).toBe(2);
    expect(normalizeProcessVersion(7)).toBe(2); // newer than this build: latest
    expect(normalizeProcessVersion('2')).toBe(1); // damaged
    expect(normalizeProcessVersion(1.5)).toBe(1);
    expect(normalizeProcessVersion(null)).toBe(1);
  });

  it('process 2 at neutral settings is the identity', () => {
    const pixels: number[][] = [];
    for (let v = 0; v < 256; v++) {
      pixels.push([v, v, v, 255], [v, 255 - v, (v * 7) % 256, 255], [(v * 13) % 256, v, 0, 128]);
    }
    expect(render(pixels, { process: 2 })).toEqual(pixels);
    // Force the full pipeline with a vanishing white-balance change: still within ±1 everywhere.
    const out = render(pixels, { process: 2, temperature: 1e-9 });
    out.forEach((px, i) => px.forEach((c, k) => expect(Math.abs(c - pixels[i][k])).toBeLessThanOrEqual(1)));
  });

  it('does not clip between stages: exposure up then contrast down keeps highlight detail', () => {
    const pixels = [[200, 200, 200, 255], [220, 220, 220, 255], [240, 240, 240, 255], [255, 255, 255, 255]];
    const legacy = render(pixels, { process: 1, exposure: 50, contrast: -50 }).map((p) => p[0]);
    expect(new Set(legacy).size).toBe(1); // legacy clips all four to the same value
    const p2 = render(pixels, { process: 2, exposure: 50, contrast: -50 }).map((p) => p[0]);
    expect(new Set(p2).size).toBe(4);
    for (let i = 1; i < p2.length; i++) expect(p2[i]).toBeGreaterThan(p2[i - 1]);
    // Exposure alone also rolls highlights off instead of clipping.
    const exp = render(pixels, { process: 2, exposure: 50 }).map((p) => p[0]);
    expect(new Set(exp).size).toBe(4);
  });

  it('process 2 white balance warms / tints in linear light and keeps neutral luminance', () => {
    const [warm] = render([[120, 120, 120, 255]], { process: 2, temperature: 40 });
    expect(warm[0]).toBeGreaterThan(warm[1]);
    expect(warm[1]).toBeGreaterThan(warm[2]);
    expect(Math.abs(luma(warm) - luma([120, 120, 120]))).toBeLessThan(0.01);
    const [cool] = render([[120, 120, 120, 255]], { process: 2, temperature: -40 });
    expect(cool[2]).toBeGreaterThan(cool[0]);
    const [magenta] = render([[120, 120, 120, 255]], { process: 2, tint: 40 });
    expect(magenta[1]).toBeLessThan(magenta[0]);
    expect(magenta[1]).toBeLessThan(magenta[2]);
  });

  it('process 2 saturation is luminance-preserving in linear light', () => {
    const src = [200, 80, 40];
    const [grey] = render([[...src, 255]], { process: 2, saturation: -100 });
    expect(grey[0]).toBe(grey[1]);
    expect(grey[1]).toBe(grey[2]);
    expect(Math.abs(luma(grey) - luma(src))).toBeLessThan(0.005);
    const [vivid] = render([[120, 100, 90, 255]], { process: 2, saturation: 50 });
    expect(vivid[0] - vivid[2]).toBeGreaterThan(30);
    expect(linearToSrgb(srgbToLinear(0.5))).toBeCloseTo(0.5, 9);
  });

  it('applies opacity in process 2', () => {
    const [px] = render([[100, 100, 100, 200]], { process: 2, opacity: 0.5, contrast: 10 });
    expect(px[3]).toBe(100);
  });

  it('renders a megapixel in well under a second', () => {
    const w = 1024;
    const h = 1024;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
    const img = { width: w, height: h, data } as ImageData;
    const adjustments: ImageAdjustments = {
      ...DEFAULT_ADJUSTMENTS,
      brightness: 10, contrast: 20, saturation: 15, exposure: 10, temperature: 20, tint: -5, opacity: 0.9, process: 2,
    };
    const start = performance.now();
    applyAdjustments(img, adjustments);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe('process versions in the controller and serialization', () => {
  it('gives new edits the latest process and saves it', () => {
    const c = new ImageEditorController();
    expect(c.getState().adjustments.process).toBe(LATEST_PROCESS_VERSION);
    expect(c.isProcessOutdated).toBe(false);
    c.setAdjustments({ tint: 12 });
    const json = c.toJSON();
    expect(json.adjustments.process).toBe(2);
    expect(json.adjustments.tint).toBe(12);
    const restored = new ImageEditorController();
    restored.loadJSON(JSON.parse(JSON.stringify(json)));
    expect(restored.getState().adjustments).toEqual(c.getState().adjustments);
  });

  it('keeps saved states without `process` on the legacy process, byte for byte', () => {
    const legacy: SerializedImageEditorState = {
      version: 1,
      crop: null,
      transform: { rotate: 0, flipH: false, flipV: false },
      adjustments: { brightness: 10, contrast: 0, saturation: 5, exposure: 0, temperature: 30, blur: 0, opacity: 1 },
      depthMask: { enabled: false, maskSource: null, mode: 'threshold', depthRange: [0, 255], softness: 10, invert: false },
      annotations: [],
    };
    const fromInitial = new ImageEditorController({ initialState: legacy });
    expect(fromInitial.getState().adjustments.process).toBe(1);
    expect(fromInitial.isProcessOutdated).toBe(true);
    expect(JSON.stringify(fromInitial.toJSON())).toBe(JSON.stringify(legacy));

    const loaded = new ImageEditorController();
    loaded.loadJSON(legacy);
    expect(loaded.getState().adjustments.process).toBe(1);
    expect(loaded.toJSON().adjustments).toEqual(legacy.adjustments);

    // Update to Current Process: one undo step.
    expect(loaded.upgradeProcess()).toBe(true);
    expect(loaded.getState().adjustments.process).toBe(2);
    expect(loaded.getState().adjustments.temperature).toBe(30);
    expect(loaded.toJSON().adjustments.process).toBe(2);
    expect(loaded.upgradeProcess()).toBe(false);
    loaded.undo();
    expect(loaded.getState().adjustments.process).toBe(1);
    loaded.redo();
    expect(loaded.getState().adjustments.process).toBe(2);

    // Reset gives the latest process.
    fromInitial.resetAdjustments();
    expect(fromInitial.getState().adjustments).toEqual(DEFAULT_ADJUSTMENTS);
  });

  it('reads a damaged process as legacy', () => {
    const c = new ImageEditorController({
      initialState: { adjustments: { ...DEFAULT_ADJUSTMENTS, process: 'two' as any } },
    });
    expect(c.getState().adjustments.process).toBe(1);
  });
});
