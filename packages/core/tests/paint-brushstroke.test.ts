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
