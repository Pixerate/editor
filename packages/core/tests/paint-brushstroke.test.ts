import { describe, expect, it } from 'vitest';
import {
  BrushstrokeCache,
  brushstrokeDataUrl,
  brushstrokeKey,
  brushstrokeSamples,
  brushstrokeScaleBucket,
  brushstrokeToCanvas,
  isBrushstrokeBrush,
  renderBrushstroke,
  type BrushstrokeSample,
} from '../src/paint';
import { BUILTIN_BRUSHES } from '../src/paint-editor/brushes';

const wave = (n = 24): BrushstrokeSample[] => Array.from({ length: n }, (_, i) => ({ x: 10 + i * 6, y: 50 + Math.sin(i / 4) * 20, pressure: 0.3 + (0.7 * i) / (n - 1), t: i * 16 }));
const preset = (id: string) => BUILTIN_BRUSHES.find((b) => b.id === id)!;

describe('renderBrushstroke', () => {
  it('renders the same bytes for the same input', () => {
    const a = renderBrushstroke(wave(), { size: 10, hardness: 0.5 }, { color: [20, 40, 200, 255] });
    const b = renderBrushstroke(wave(), { size: 10, hardness: 0.5 }, { color: [20, 40, 200, 255] });
    expect(a.image.width).toBeGreaterThan(100);
    expect(a.bounds).not.toBeNull();
    expect(Buffer.from(a.image.data).equals(Buffer.from(b.image.data))).toBe(true);
    expect(a.image.data.length).toBe(a.image.width * a.image.height * 4);
    // The colour lands straight (not premultiplied).
    const i = a.image.data.findIndex((_, k) => k % 4 === 3 && a.image.data[k] === 255);
    expect([...a.image.data.subarray(i - 3, i + 1)]).toEqual([20, 40, 200, 255]);
  });

  it('scales pixels, not geometry: bounds stay put in path units', () => {
    const one = renderBrushstroke(wave(), { size: 10 }, { scale: 1 });
    const two = renderBrushstroke(wave(), { size: 10 }, { scale: 2 });
    expect(two.scale).toBe(2);
    expect(two.image.width).toBeGreaterThan(one.image.width * 1.8);
    // The tip's anti-aliasing margin is in pixels, so it shrinks in path units at a higher scale.
    expect(Math.abs(two.bounds!.x - one.bounds!.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(two.bounds!.width - one.bounds!.width)).toBeLessThanOrEqual(4);
  });

  it('caps the image size by lowering the scale', () => {
    const big = renderBrushstroke(wave(), { size: 10 }, { scale: 8, maxPixels: 100_000 });
    expect(big.scale).toBeLessThan(8);
    expect(big.image.width * big.image.height).toBeLessThanOrEqual(130_000);
  });

  it('samples pressure and tilt profiles along the length', () => {
    const samples = brushstrokeSamples({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 40, y: 0 }], pressure: [0, 1], tiltX: [30] });
    expect(samples.map((s) => s.pressure)).toEqual([0, 0.25, 1]);
    expect(samples.every((s) => s.tiltX === 30)).toBe(true);
    const thin = renderBrushstroke({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], pressure: [0.1] }, { size: 20 });
    const full = renderBrushstroke({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }, { size: 20 });
    expect(thin.image.height).toBeLessThan(full.image.height);
  });

  it('takes dry paint-editor presets and refuses wet and other non-dry brushes', () => {
    expect(renderBrushstroke(wave(), preset('ink-pen')).dabs).toBeGreaterThan(10);
    expect(isBrushstrokeBrush(preset('pencil-hb'))).toBe(true);
    expect(isBrushstrokeBrush(preset('watercolor-round'))).toBe(false);
    expect(() => renderBrushstroke(wave(), preset('watercolor-round'))).toThrow(/dry media only.*wet brush.*area to flow in/);
    expect(() => renderBrushstroke(wave(), preset('mixer-brush'))).toThrow(/Mixer Brush/);
    expect(() => renderBrushstroke(wave(), preset('impasto-brush'))).toThrow(/'impasto' engine/);
    expect(() => renderBrushstroke([{ x: NaN, y: 0 }], { size: 4 })).toThrow(/finite/);
  });

  it('gives an empty image for no samples, and PNG / canvas output for the rest', () => {
    const empty = renderBrushstroke([], { size: 4 });
    expect(empty.bounds).toBeNull();
    expect(brushstrokeDataUrl(empty)).toBe('');
    const s = renderBrushstroke([{ x: 5, y: 5 }], { size: 6 });
    expect(brushstrokeDataUrl(s)).toMatch(/^data:image\/png;base64,/);
    let put: unknown = null;
    const canvas = brushstrokeToCanvas(s, (w, h) => ({
      w,
      h,
      getContext: () => ({ createImageData: (cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) }), putImageData: (img: unknown) => { put = img; } }),
    }));
    expect(canvas).toMatchObject({ w: s.image.width, h: s.image.height });
    expect((put as { data: Uint8ClampedArray }).data).toEqual(s.image.data);
  });
});

describe('brushstroke scale buckets and cache', () => {
  it('snaps zooms up to powers of √2', () => {
    expect(brushstrokeScaleBucket(1)).toBe(1);
    expect(brushstrokeScaleBucket(1.1)).toBeCloseTo(Math.SQRT2, 6);
    expect(brushstrokeScaleBucket(1.4)).toBeCloseTo(Math.SQRT2, 6);
    expect(brushstrokeScaleBucket(1.5)).toBe(2);
    expect(brushstrokeScaleBucket(0.6)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(brushstrokeScaleBucket(1, 2)).toBe(2);
    expect(brushstrokeScaleBucket(1000)).toBe(16);
    expect(brushstrokeScaleBucket(0)).toBe(1);
  });

  it('hits within a bucket and re-renders when the path, brush, colour or bucket changes', () => {
    const cache = new BrushstrokeCache(8);
    const brush = { size: 8 };
    const a = cache.render(wave(), brush, { scale: brushstrokeScaleBucket(1.1) });
    expect(cache.render(wave(), brush, { scale: brushstrokeScaleBucket(1.3) })).toBe(a);
    expect(cache.misses).toBe(1);
    cache.render(wave(), brush, { scale: brushstrokeScaleBucket(2) });
    expect(cache.misses).toBe(2);
    cache.render(wave(25), brush, { scale: 1 });
    cache.render(wave(), { size: 9 }, { scale: 1 });
    cache.render(wave(), brush, { scale: 1, color: [255, 0, 0, 255] });
    expect(cache.misses).toBe(5);
    expect(brushstrokeKey(wave(), brush)).toBe(brushstrokeKey(wave(), { ...brush }));
    expect(brushstrokeKey(wave(), brush)).not.toBe(brushstrokeKey(wave().map((s) => ({ ...s, pressure: 1 })), brush));
  });

  it('evicts the least recently used stroke', () => {
    const cache = new BrushstrokeCache(2);
    const first = cache.render([{ x: 0, y: 0 }], { size: 4 });
    cache.render([{ x: 1, y: 0 }], { size: 4 });
    cache.render([{ x: 0, y: 0 }], { size: 4 });
    cache.render([{ x: 2, y: 0 }], { size: 4 });
    expect(cache.size).toBe(2);
    expect(cache.render([{ x: 0, y: 0 }], { size: 4 })).toBe(first);
    expect(cache.misses).toBe(3);
  });
});

describe('brushstrokes with gradient paint (PaintSource)', () => {
  const line = Array.from({ length: 11 }, (_, i) => ({ x: 10 + i * 30, y: 40, t: i * 20 }));
  const at = (s: ReturnType<typeof renderBrushstroke>, x: number, y: number) => {
    const px = Math.round((x - s.bounds!.x) * s.scale);
    const py = Math.round((y - s.bounds!.y) * s.scale);
    const i = (py * s.image.width + px) * 4;
    return [...s.image.data.subarray(i, i + 4)];
  };
  const blueToYellow = { type: 'gradient' as const, stops: [{ offset: 0, color: '#0000ff' }, { offset: 1, color: '#ffff00' }], space: 'srgb' as const, map: { by: 'distance' as const, length: 300, repeat: 'clamp' as const, unit: 'px' as const } };

  it('samples a distance gradient dab by dab along the path, the same at any scale', () => {
    const one = renderBrushstroke(line, { size: 12, hardness: 1 }, { paint: blueToYellow });
    const start = at(one, 12, 40);
    const end = at(one, 308, 40);
    expect(start[2]).toBeGreaterThan(200);
    expect(start[0]).toBeLessThan(40);
    expect(end[0]).toBeGreaterThan(200);
    expect(end[2]).toBeLessThan(40);
    const two = renderBrushstroke(line, { size: 12, hardness: 1 }, { paint: blueToYellow, scale: 2 });
    const mid1 = at(one, 160, 40);
    const mid2 = at(two, 160, 40);
    for (let c = 0; c < 3; c++) expect(Math.abs(mid1[c] - mid2[c])).toBeLessThan(16);
    expect(Buffer.from(one.image.data).equals(Buffer.from(renderBrushstroke(line, { size: 12, hardness: 1 }, { paint: blueToYellow }).image.data))).toBe(true);
  });

  it('takes a colour source, maps by pressure, and paints across the tip', () => {
    expect(at(renderBrushstroke(line, { size: 12 }, { paint: { type: 'color', color: '#ff0000' } }), 160, 40)).toEqual([255, 0, 0, 255]);
    const byPressure = renderBrushstroke(
      line.map((s, i) => ({ ...s, pressure: i < 5 ? 0.05 : 1 })),
      { size: 12, pressureSize: false },
      { paint: { ...blueToYellow, map: { by: 'pressure' } } }
    );
    expect(at(byPressure, 40, 40)[2]).toBeGreaterThan(200);
    expect(at(byPressure, 280, 40)[0]).toBeGreaterThan(200);
    const across = renderBrushstroke(line, { size: 20, hardness: 1 }, { paint: { ...blueToYellow, map: { by: 'across-tip' } } });
    const top = at(across, 160, 33);
    const bottom = at(across, 160, 47);
    expect(top[2]).not.toBe(bottom[2]);
  });

  it('keys the cache by paint and seed', () => {
    expect(brushstrokeKey(line, { size: 4 }, { paint: blueToYellow })).not.toBe(brushstrokeKey(line, { size: 4 }, { paint: { ...blueToYellow, space: 'pigment' } }));
    expect(brushstrokeKey(line, { size: 4 }, { paint: blueToYellow, seed: 1 })).not.toBe(brushstrokeKey(line, { size: 4 }, { paint: blueToYellow, seed: 2 }));
  });
});

describe('brushstroke character: seeded jitter and paper grain', () => {
  const path = Array.from({ length: 16 }, (_, i) => ({ x: 20 + i * 14, y: 60 + Math.sin(i / 3) * 12, pressure: 0.6 }));
  /** Mean |Δalpha| between horizontal neighbours where either is painted: 0 for a smooth stroke, higher for a grainy one. */
  const roughness = (img: ReturnType<typeof renderBrushstroke>['image']) => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 1; x < img.width; x++) {
        const a = img.data[(y * img.width + x) * 4 + 3];
        const b = img.data[(y * img.width + x - 1) * 4 + 3];
        if (a > 20 || b > 20) {
          sum += Math.abs(a - b);
          n++;
        }
      }
    return n ? sum / n : 0;
  };
  const render = (id: string, character?: Parameters<typeof renderBrushstroke>[2]['character']) => renderBrushstroke(path, preset(id), { scale: 1, ...(character ? { character } : {}) });

  it('gives charcoal, pastel and pencil their grain, and leaves the airbrush smooth', () => {
    for (const id of ['charcoal-stick', 'soft-pastel', 'pencil-hb']) {
      const plain = roughness(render(id).image);
      const textured = roughness(render(id, { seed: 7 }).image);
      expect(textured, id).toBeGreaterThan(plain * 1.5 + 2);
    }
    // No grain response, no jitter: character changes nothing.
    expect(Buffer.from(render('airbrush', { seed: 7 }).image.data).equals(Buffer.from(render('airbrush').image.data))).toBe(true);
  });

  it('makes the presets look different from each other', () => {
    const stats = ['charcoal-stick', 'soft-pastel', 'pencil-hb', 'airbrush'].map((id) => {
      const s = render(id, { seed: 3 });
      let alpha = 0;
      for (let i = 3; i < s.image.data.length; i += 4) alpha += s.image.data[i];
      return [Math.round(s.bounds!.height), Math.round(roughness(s.image)), Math.round(alpha / 1e5)].join('/');
    });
    expect(new Set(stats).size).toBe(4);
  });

  it('is deterministic: the same seed gives the same bytes, another seed other bytes', () => {
    const a = render('charcoal-stick', { seed: 11 });
    expect(Buffer.from(a.image.data).equals(Buffer.from(render('charcoal-stick', { seed: 11 }).image.data))).toBe(true);
    expect(Buffer.from(a.image.data).equals(Buffer.from(render('charcoal-stick', { seed: 12 }).image.data))).toBe(false);
    // Without a seed, a hash of the path: still the same every time.
    expect(Buffer.from(render('charcoal-stick', {}).image.data).equals(Buffer.from(render('charcoal-stick', {}).image.data))).toBe(true);
  });

  it('samples the grain on the paper, so a stroke moved by its origin keeps the same grain under it', () => {
    const brush = { ...preset('charcoal-stick'), dynamics: {} }; // grain only, no jitter
    const here = renderBrushstroke(path, brush, { character: { seed: 1, origin: { x: 0, y: 0 } } });
    const shifted = path.map((s) => ({ ...s, x: s.x - 100, y: s.y - 40 }));
    const there = renderBrushstroke(shifted, brush, { character: { seed: 1, origin: { x: 100, y: 40 } } });
    expect(Buffer.from(there.image.data).equals(Buffer.from(here.image.data))).toBe(true);
    // The same path elsewhere on the paper catches different grain.
    const elsewhere = renderBrushstroke(path, brush, { character: { seed: 1, origin: { x: 37, y: 11 } } });
    expect(Buffer.from(elsewhere.image.data).equals(Buffer.from(here.image.data))).toBe(false);
    // At twice the scale the grain is still sampled in path units: similar texture, not finer.
    const two = renderBrushstroke(path, brush, { scale: 2, character: { seed: 1 } });
    expect(Math.abs(roughness(two.image) / 2 - roughness(here.image))).toBeLessThan(roughness(here.image));
  });

  it('turns grain off with paper: null, and keys the cache by character', () => {
    const brush = { ...preset('charcoal-stick'), dynamics: {} };
    expect(Buffer.from(renderBrushstroke(path, brush, { character: { paper: null } }).image.data).equals(Buffer.from(renderBrushstroke(path, brush).image.data))).toBe(true);
    expect(brushstrokeKey(path, brush, { character: { seed: 1 } })).not.toBe(brushstrokeKey(path, brush));
    expect(brushstrokeKey(path, brush, { character: { seed: 1 } })).not.toBe(brushstrokeKey(path, brush, { character: { seed: 1, origin: { x: 1, y: 0 } } }));
  });
});
