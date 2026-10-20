import { describe, expect, it } from 'vitest';
import {
  CoverageMap,
  PaintGradientSampler,
  StrokeCoverage,
  applyStrokeToTile,
  parsePaintSource,
  paintSourceCss,
  readPaintSource,
  resolvePaintGradient,
  type PaintDabParams,
  type PaintGradientSource,
  type StrokeApply,
} from '../src/paint';
import { DEFAULT_BRUSH } from '../src/paint/brush';

const blueYellow = (map: PaintGradientSource['map'], extra: Partial<PaintGradientSource> = {}): PaintGradientSource =>
  parsePaintSource({ type: 'gradient', stops: [{ offset: 0, color: '#1d4ed8' }, { offset: 1, color: '#facc15' }], map, ...extra }) as PaintGradientSource;
const dab = (p: Partial<PaintDabParams> = {}): PaintDabParams => ({ travel: 0, index: 0, pressure: 1, lean: 0, speed: null, direction: 0, time: null, ...p });
const hex = (rgb: number[]) => '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

describe('paint sources', () => {
  it('reads colours and gradients, filling in the defaults', () => {
    expect(parsePaintSource('#ABC')).toEqual({ type: 'color', color: '#aabbcc' });
    expect(parsePaintSource({ type: 'color', color: '#1D4ED8' })).toEqual({ type: 'color', color: '#1d4ed8' });
    const g = parsePaintSource({ type: 'gradient', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: 'paint', opacity: 0.5, midpoint: 0.5 }] });
    expect(g).toEqual({ type: 'gradient', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: 'paint', opacity: 0.5 }], space: 'pigment', map: { by: 'distance', length: 300, repeat: 'mirror', unit: 'px' } });
    expect(resolvePaintGradient(g as PaintGradientSource, { paint: '#ff0000', secondary: '#00ff00' }).stops[1].color).toBe('#ff0000');
    expect(paintSourceCss(g, { paint: '#ff0000', secondary: '#fff' })).toBe('linear-gradient(90deg, rgba(0, 0, 0, 1) 0%, rgba(255, 0, 0, 0.5) 100%)');
  });

  it('says what is wrong with a gradient and how to fix it', () => {
    const bad = (raw: unknown) => () => parsePaintSource(raw);
    expect(bad({ type: 'gradient', stops: [{ offset: 0, color: '#000' }] })).toThrow(/needs 2\.\.16 stops/);
    expect(bad({ type: 'gradient', stops: [{ offset: 0.6, color: '#000' }, { offset: 0.2, color: '#fff' }] })).toThrow(/sorted by offset: stop 1 \(0\.2\) comes before stop 0 \(0\.6\)/);
    expect(bad({ type: 'gradient', stops: [{ offset: -1, color: '#000' }, { offset: 1, color: '#fff' }] })).toThrow(/stops\[0\]\.offset -1 must be a number 0\.\.1/);
    expect(bad({ type: 'gradient', stops: [{ offset: 0, color: 'blue' }, { offset: 1, color: '#fff' }] })).toThrow(/stops\[0\]\.color "blue" is not a colour/);
    expect(bad({ type: 'gradient', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff', midpoint: 0.99 }] })).toThrow(/midpoint 0\.99 must be 0\.05\.\.0\.95/);
    expect(bad({ type: 'gradient', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }], space: 'hsl' })).toThrow(/space "hsl" is not a space; use pigment, oklab, srgb/);
    expect(bad({ type: 'gradient', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }], map: { by: 'length' } })).toThrow(/map\.by "length" is not a mapping/);
    expect(bad({ type: 'gradient', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }], map: { by: 'distance', length: 0 } })).toThrow(/map\.length 0 is out of range; use 1\.\.100000 px/);
    expect(bad({ type: 'pattern' })).toThrow(/type "pattern" is not a paint/);
    expect(bad('red')).toThrow(/"red" is not a colour/);
    expect(readPaintSource({ type: 'pattern' })).toBeNull();
  });
});

describe('sampling', () => {
  it('pigment mixing takes blue to yellow through green; sRGB through grey', () => {
    const pig = new PaintGradientSampler(blueYellow({ by: 'pressure' })).sample(0.5).rgb;
    const rgb = new PaintGradientSampler(blueYellow({ by: 'pressure' }, { space: 'srgb' })).sample(0.5).rgb;
    const lab = new PaintGradientSampler(blueYellow({ by: 'pressure' }, { space: 'oklab' })).sample(0.5).rgb;
    expect(pig[1]).toBeGreaterThan(pig[0]);
    expect(pig[1]).toBeGreaterThan(pig[2]);
    expect(Math.abs(rgb[0] - rgb[2])).toBeLessThan(0.15);
    expect(lab).not.toEqual(rgb);
    expect(hex(new PaintGradientSampler(blueYellow({ by: 'pressure' })).sample(0).rgb)).toBe('#1d4ed8');
    expect(hex(new PaintGradientSampler(blueYellow({ by: 'pressure' })).sample(1).rgb)).toBe('#facc15');
  });

  it('distance runs along the stroke and repeats as asked; dabs counts dabs', () => {
    const at = (repeat: 'clamp' | 'repeat' | 'mirror', travel: number) => new PaintGradientSampler(blueYellow({ by: 'distance', length: 100, repeat }, { space: 'srgb' })).dab(dab({ travel })).rgb[0];
    const start = at('clamp', 0);
    const end = at('clamp', 100);
    expect(at('clamp', 50)).toBeCloseTo((start + end) / 2, 5);
    expect(at('clamp', 250)).toBeCloseTo(end, 6);
    expect(at('repeat', 125)).toBeCloseTo(at('repeat', 25), 6);
    expect(at('mirror', 125)).toBeCloseTo(at('mirror', 75), 6);
    expect(at('mirror', 200)).toBeCloseTo(start, 6);
    const byDabs = new PaintGradientSampler(blueYellow({ by: 'distance', length: 10, repeat: 'clamp', unit: 'dabs' }, { space: 'srgb' }));
    expect(byDabs.dab(dab({ index: 5, travel: 9999 })).rgb[0]).toBeCloseTo((start + end) / 2, 5);
  });

  it('pressure, tilt, velocity, direction and time each move along the gradient', () => {
    const g = (by: 'pressure' | 'tilt' | 'velocity' | 'direction') => new PaintGradientSampler(blueYellow({ by }, { space: 'srgb' }));
    const mid = g('pressure').sample(0.5).rgb[0];
    expect(g('pressure').dab(dab({ pressure: 0.5 })).rgb[0]).toBeCloseTo(mid, 6);
    expect(g('tilt').dab(dab({ lean: 0.5 })).rgb[0]).toBeCloseTo(mid, 6);
    expect(g('velocity').dab(dab({ speed: 1.25 })).rgb[0]).toBeCloseTo(mid, 6);
    expect(g('velocity').dab(dab({ speed: null })).rgb[0]).toBeCloseTo(g('pressure').sample(0).rgb[0], 6);
    expect(g('direction').dab(dab({ direction: Math.PI })).rgb[0]).toBeCloseTo(mid, 6);
    expect(g('direction').dab(dab({ direction: -Math.PI / 2 })).rgb[0]).toBeCloseTo(g('pressure').sample(0.75).rgb[0], 6);
    const time = new PaintGradientSampler(blueYellow({ by: 'time', duration: 1000 }, { space: 'srgb' }));
    expect(time.dab(dab({ time: 500 })).rgb[0]).toBeCloseTo(mid, 6);
    expect(time.dab(dab({ time: 5000 })).rgb[0]).toBeCloseTo(g('pressure').sample(1).rgb[0], 6);
  });

  it('random is seeded per dab (or per run of dabs); midpoints, softness and opacity shape the stops', () => {
    const r = (seed: number) => new PaintGradientSampler(blueYellow({ by: 'random', every: 3 }), seed);
    const a = [0, 1, 2, 3, 4, 5].map((i) => hex(r(7).dab(dab({ index: i })).rgb));
    expect(a).toEqual([0, 1, 2, 3, 4, 5].map((i) => hex(r(7).dab(dab({ index: i })).rgb)));
    expect(a[0]).toBe(a[2]);
    expect(new Set([0, 3, 6, 9, 12, 15].map((i) => hex(r(7).dab(dab({ index: i })).rgb))).size).toBeGreaterThan(2);
    const mid = parsePaintSource({ type: 'gradient', stops: [{ offset: 0, color: '#000000', midpoint: 0.2 }, { offset: 1, color: '#ffffff' }], space: 'srgb', map: { by: 'pressure' } }) as PaintGradientSource;
    expect(new PaintGradientSampler(mid).sample(0.2).rgb[0]).toBeCloseTo(0.5, 6);
    const hard = parsePaintSource({ type: 'gradient', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff', opacity: 0.4 }], space: 'srgb', softness: 0, map: { by: 'pressure' } }) as PaintGradientSource;
    const s = new PaintGradientSampler(hard);
    expect(s.sample(0.45).rgb[0]).toBe(0);
    expect(s.sample(0.55).rgb[0]).toBe(1);
    expect(s.sample(0.55).alpha).toBeCloseTo(0.4, 6);
  });
});

describe('gradient paint on coverage strokes', () => {
  const apply: StrokeApply = { mode: 'paint', color: [0, 0, 0, 255], background: [255, 255, 255, 255], opacity: 1, blend: 'normal', lockTransparency: false, selection: null, offset: { x: 0, y: 0 } };
  const blank = () => new Uint8ClampedArray(256 * 256 * 4);
  const px = (t: Uint8ClampedArray, x: number, y: number) => [...t.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];

  it('a stroke changes colour as it is dragged out, and repeats', () => {
    const g = blueYellow({ by: 'distance', length: 100, repeat: 'mirror' });
    const s = new StrokeCoverage({ ...DEFAULT_BRUSH, size: 10, spacing: 0.1 }, g);
    s.push(Array.from({ length: 21 }, (_, i) => ({ x: 10 + i * 10, y: 50 })));
    s.finish();
    const t = applyStrokeToTile(s.coverage, blank(), 4, 0, 0, apply);
    // A pixel takes most of its colour from the first dab to reach it (about half a tip behind).
    const near = (a: number[], b: number[]) => b.every((v, i) => Math.abs(v - a[i]) <= 16);
    expect(px(t, 10, 50)).toEqual([29, 78, 216, 255]);
    expect(near(px(t, 115, 50), [250, 204, 21])).toBe(true);
    expect(near(px(t, 215, 50), [29, 78, 216])).toBe(true);
    const middle = px(t, 60, 50);
    expect(middle[1]).toBeGreaterThan(middle[0]);
    expect(middle[1]).toBeGreaterThan(middle[2]);
    // One colour: the stroke's own colour, as before.
    const plain = new StrokeCoverage({ ...DEFAULT_BRUSH, size: 10 });
    plain.push([{ x: 10, y: 50 }, { x: 200, y: 50 }]);
    plain.finish();
    expect(plain.coverage.colors.size).toBe(0);
    expect(px(applyStrokeToTile(plain.coverage, blank(), 4, 0, 0, apply), 100, 50)).toEqual([0, 0, 0, 255]);
  });

  it('across the tip lays the colours side by side; the eraser ignores the colours', () => {
    const g = blueYellow({ by: 'across-tip' }, { space: 'srgb' });
    const s = new StrokeCoverage({ ...DEFAULT_BRUSH, size: 40, spacing: 0.05 }, g);
    s.push([{ x: 20, y: 100 }, { x: 220, y: 100 }]);
    s.finish();
    const t = applyStrokeToTile(s.coverage, blank(), 4, 0, 0, apply);
    // Moving right, the left of the stroke is up (y − 18) and the right down (y + 18).
    expect(px(t, 120, 82)[2]).toBeGreaterThan(150);
    expect(px(t, 120, 118)[0]).toBeGreaterThan(200);
    const filled = new Uint8ClampedArray(256 * 256 * 4).fill(255);
    const erased = applyStrokeToTile(s.coverage, filled, 4, 0, 0, { ...apply, mode: 'erase' });
    expect(px(erased, 120, 100)[3]).toBe(0);
    const cm = new CoverageMap();
    expect(cm.colorAt(0, 0, [0, 0, 0])).toBeNull();
  });
});

describe('gradient editing helpers', () => {
  it('adds, moves, removes and reverses stops, keeping them sorted', async () => {
    const { addPaintGradientStop, updatePaintGradientStop, removePaintGradientStop, reversePaintGradient, paintGradientMappingFor, PAINT_GRADIENT_PRESETS } = await import('../src/paint');
    const g = parsePaintSource({ type: 'gradient', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff', opacity: 0.5 }], space: 'srgb' }) as PaintGradientSource;
    const added = addPaintGradientStop(g, 0.5);
    expect(added.index).toBe(1);
    expect(added.paint.stops[1]).toEqual({ offset: 0.5, color: '#808080', opacity: 0.75 });
    const moved = updatePaintGradientStop(added.paint, 1, { offset: 0.9, midpoint: 0.3 });
    expect(moved.index).toBe(1);
    const past = updatePaintGradientStop(added.paint, 0, { offset: 0.95 });
    expect(past.index).toBe(1);
    expect(past.paint.stops.map((s) => s.offset)).toEqual([0.5, 0.95, 1]);
    expect(removePaintGradientStop(g, 0)).toBe(g);
    expect(removePaintGradientStop(added.paint, 1).stops).toHaveLength(2);
    const rev = reversePaintGradient(moved.paint);
    expect(rev.stops.map((s) => s.offset)).toEqual([0, 0.09999999999999998, 1]);
    // The segment after the new first stop was the one with the 0.3 midpoint, seen from the other side.
    expect(rev.stops[0]).toMatchObject({ offset: 0, color: '#ffffff', opacity: 0.5 });
    expect(rev.stops[0].midpoint).toBeCloseTo(0.7, 6);
    expect(rev.stops[1].midpoint).toBeUndefined();
    expect(paintGradientMappingFor('time', { by: 'distance', length: 50, repeat: 'repeat' })).toEqual({ by: 'time', duration: 2000, repeat: 'repeat' });
    for (const p of PAINT_GRADIENT_PRESETS) expect(parsePaintSource(p.paint)).toEqual(p.paint);
  });
});
