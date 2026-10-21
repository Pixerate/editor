import { describe, expect, it } from 'vitest';
import {
  PIGMENT_BANDS,
  PIGMENT_WAVELENGTHS,
  createPigment,
  createPigmentTools,
  lerpPigment,
  lerpPigmentInto,
  mixPigments,
  reflectanceToRgb,
  rgbToReflectance,
  setPigmentColor,
  type PigmentRgb,
} from '../src/paint';
import { ToolRegistry } from '../src/tools';
import { baseToolName } from '../src/tools';

const hex = (h: string): PigmentRgb => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const to8 = (c: readonly number[]) => c.map((v) => Math.round(v * 255));
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (c: readonly number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
/** Hue in degrees (HSV). */
function hue([r, g, b]: readonly number[]): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const maxDiff = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** Round-trip bound in 8-bit levels: exact apart from a few very dark, saturated reds and purples. */
const ROUND_TRIP_MAX = 3.5 / 255;

describe('pigment mixing: known mixes', () => {
  it('mixes blue and yellow into green', () => {
    for (const [blue, yellow] of [
      ['#0000ff', '#ffff00'],
      ['#002185', '#fcd300'],
      ['#0047ab', '#feec00'],
    ]) {
      const mixed = mixPigments([hex(blue), hex(yellow)], [1, 1]);
      const [r, g, b] = mixed;
      expect(g, `${blue} + ${yellow} → ${to8(mixed)}`).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
      expect(hue(mixed)).toBeGreaterThan(90);
      expect(hue(mixed)).toBeLessThan(170);
    }
    // Averaging RGB gives grey instead.
    expect(to8([0.5, 0.5, 0.5])).toEqual([128, 128, 128]);
  });

  it('mixes red and white into a lighter tint of red, not a darker red', () => {
    const red = hex('#ff0000');
    const mixed = mixPigments([red, hex('#ffffff')], [1, 1]);
    expect(luminance(mixed)).toBeGreaterThan(luminance(red) * 1.15);
    expect(mixed[0]).toBeGreaterThan(0.99);
    expect(mixed[1]).toBeGreaterThan(0.2);
    expect(Math.abs(mixed[1] - mixed[2])).toBeLessThan(0.05);
    const h = hue(mixed);
    expect(Math.min(h, 360 - h)).toBeLessThan(10);
    // More white, paler pink.
    const paler = mixPigments([red, hex('#ffffff')], [1, 3]);
    expect(luminance(paler)).toBeGreaterThan(luminance(mixed) * 1.1);
    expect(paler[1]).toBeGreaterThan(0.35);
  });

  it('leaves a colour mixed with itself unchanged', () => {
    for (const h of ['#ff0000', '#00ff00', '#0000ff', '#808080', '#123456', '#fedcba', '#000000', '#ffffff', '#e4a11b']) {
      const c = hex(h);
      expect(maxDiff(mixPigments([c, c], [1, 1]), c), h).toBeLessThanOrEqual(ROUND_TRIP_MAX);
      expect(maxDiff(mixPigments([c, c, c], [0.2, 5, 1]), c), h).toBeLessThanOrEqual(ROUND_TRIP_MAX);
      // Whatever its tinting strength.
      const strong = createPigment(c, { strength: 7 });
      expect(maxDiff(mixPigments([strong, c], [1, 1]), c), h).toBeLessThanOrEqual(ROUND_TRIP_MAX);
    }
  });

  it('keeps white white and black black, and greys black with white', () => {
    expect(to8(mixPigments([hex('#ffffff')], [1]))).toEqual([255, 255, 255]);
    expect(to8(mixPigments([hex('#000000')], [1]))).toEqual([0, 0, 0]);
    const grey = mixPigments([hex('#000000'), hex('#ffffff')], [1, 1]);
    expect(maxDiff(grey, [grey[0], grey[0], grey[0]])).toBeLessThan(2 / 255);
    expect(grey[0]).toBeGreaterThan(0.02);
    expect(grey[0]).toBeLessThan(0.5);
  });

  it('lets a strong pigment tint more white', () => {
    const blue = hex('#1b2a8c');
    const white = hex('#ffffff');
    const weak = mixPigments([createPigment(blue), white], [1, 9]);
    const strong = mixPigments([createPigment(blue, { strength: 4 }), white], [1, 9]);
    expect(luminance(strong)).toBeLessThan(luminance(weak));
  });
});

describe('pigment mixing: spectra', () => {
  it('has 36 bands from 380 to 730 nm', () => {
    expect(PIGMENT_BANDS).toBe(36);
    expect(PIGMENT_WAVELENGTHS[0]).toBe(380);
    expect(PIGMENT_WAVELENGTHS[PIGMENT_BANDS - 1]).toBe(730);
  });

  it('lifts colours to smooth reflectances in 0..1', () => {
    for (const h of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#808080', '#3a7d44']) {
      const R = rgbToReflectance(...hex(h));
      expect(R.length).toBe(PIGMENT_BANDS);
      for (let k = 0; k < R.length; k++) {
        expect(R[k]).toBeGreaterThanOrEqual(0);
        expect(R[k]).toBeLessThanOrEqual(1);
      }
    }
    // A grey is flat.
    const grey = rgbToReflectance(0.5, 0.5, 0.5);
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThan(1e-4);
    // Blue reflects short wavelengths, red long ones.
    const blue = rgbToReflectance(0, 0, 1);
    const red = rgbToReflectance(1, 0, 0);
    expect(blue[5]).toBeGreaterThan(blue[30]);
    expect(red[30]).toBeGreaterThan(red[5]);
  });

  it('round-trips RGB → reflectance → RGB within a fixed bound over a dense 8-bit sample', () => {
    const R = new Float32Array(PIGMENT_BANDS);
    const out = [0, 0, 0];
    let max = 0;
    let sum = 0;
    let count = 0;
    const levels = [...Array.from({ length: 52 }, (_, i) => i * 5), 1, 2, 3, 254];
    for (const r of levels) {
      for (const g of levels) {
        for (const b of levels) {
          rgbToReflectance(r / 255, g / 255, b / 255, R);
          reflectanceToRgb(R, out);
          const e = Math.max(Math.abs(out[0] * 255 - r), Math.abs(out[1] * 255 - g), Math.abs(out[2] * 255 - b));
          max = Math.max(max, e);
          sum += e;
          count++;
        }
      }
    }
    expect(max / 255).toBeLessThanOrEqual(ROUND_TRIP_MAX);
    expect(sum / count).toBeLessThan(0.01);
  });
});

describe('pigment mixing: behaviour', () => {
  const pairs: [string, string][] = [
    ['#0000ff', '#ffff00'],
    ['#ff0000', '#ffffff'],
    ['#123456', '#abcdef'],
    ['#000000', '#ff8800'],
  ];

  it('is symmetric for equal weights', () => {
    for (const [a, b] of pairs) {
      expect(mixPigments([hex(a), hex(b)], [1, 1])).toEqual(mixPigments([hex(b), hex(a)], [1, 1]));
      // 1 − 0.7 is not exactly 0.3 in floating point.
      expect(maxDiff(lerpPigment(hex(a), hex(b), 0.3), lerpPigment(hex(b), hex(a), 0.7))).toBeLessThan(1e-12);
    }
  });

  it('is continuous in weight, from one colour to the other', () => {
    for (const [a, b] of pairs) {
      const ca = hex(a);
      const cb = hex(b);
      expect(maxDiff(lerpPigment(ca, cb, 0), ca)).toBeLessThanOrEqual(ROUND_TRIP_MAX);
      expect(maxDiff(lerpPigment(ca, cb, 1), cb)).toBeLessThanOrEqual(ROUND_TRIP_MAX);
      // No jumps: a smaller step always moves the colour less, down to nothing.
      for (const t of [0, 0.001, 0.25, 0.5, 0.999]) {
        const here = lerpPigment(ca, cb, t);
        const steps = [1e-3, 1e-4, 1e-5, 1e-6, 1e-8].map((h) => maxDiff(here, lerpPigment(ca, cb, t + h)));
        for (let i = 1; i < steps.length; i++) expect(steps[i], `${a}→${b} at ${t}`).toBeLessThanOrEqual(steps[i - 1] + 1e-12);
        // K/S has a square-root slope where a band reflects fully, so near the ends it converges
        // like √h rather than h; it still goes to nothing.
        expect(steps[steps.length - 1], `${a}→${b} at ${t}`).toBeLessThan(Math.max(steps[0] / 20, 1e-6));
      }
      // Away from the ends, 1% more of one paint moves the colour by a few levels at most.
      let prev = lerpPigment(ca, cb, 0.1);
      for (let i = 11; i <= 90; i++) {
        const next = lerpPigment(ca, cb, i / 100);
        expect(maxDiff(prev, next), `${a}→${b} at ${i / 100}`).toBeLessThan(0.05);
        prev = next;
      }
    }
  });

  it('is deterministic', () => {
    const a = mixPigments([hex('#0047ab'), hex('#feec00'), hex('#ffffff')], [2, 1, 0.5]);
    const b = mixPigments([hex('#0047ab'), hex('#feec00'), hex('#ffffff')], [2, 1, 0.5]);
    expect(a).toEqual(b);
  });

  it('matches mixPigments on the allocation-free per-dab path', () => {
    const brush = createPigment(hex('#0047ab'));
    const canvas = createPigment([0, 0, 0]);
    const out = new Float32Array(6);
    setPigmentColor(canvas, ...hex('#feec00'));
    lerpPigmentInto(brush, canvas, 0.25, out, 3);
    const expected = lerpPigment(hex('#0047ab'), hex('#feec00'), 0.25);
    expect(maxDiff(Array.from(out.subarray(3)), expected)).toBeLessThan(1e-6);
  });

  it('rejects bad input with a useful message', () => {
    expect(() => mixPigments([], [])).toThrow(/at least one colour/);
    expect(() => mixPigments([hex('#ffffff')], [1, 2])).toThrow(/one weight per colour/);
    expect(() => mixPigments([hex('#ffffff'), hex('#000000')], [0, 0])).toThrow(/positive weight/);
    expect(() => mixPigments([hex('#ffffff')], [-1])).toThrow(/≥ 0/);
  });

  it('costs well under a few microseconds per dab pixel (micro-benchmark)', () => {
    const brush = createPigment(hex('#0047ab'));
    const under = createPigment([0, 0, 0]);
    const out = new Float32Array(3);
    lerpPigmentInto(brush, under, 0.5, out); // build the table first
    const n = 200_000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      setPigmentColor(under, (i & 255) / 255, ((i >> 8) & 255) / 255, 0.4);
      lerpPigmentInto(brush, under, 0.5, out);
    }
    const nsPerPixel = ((performance.now() - t0) * 1e6) / n;
    console.info(`pigment mix: ${nsPerPixel.toFixed(0)} ns per pixel (lift + mix + back to sRGB)`);
    // Generous so CI machines pass; locally about 0.4 µs.
    expect(nsPerPixel).toBeLessThan(10_000);
  });
});

describe('mix_colors agent tool', () => {
  const registry = new ToolRegistry();
  registry.register({ id: 'paint', tools: createPigmentTools() });

  it('returns the pigment mix and the RGB average', async () => {
    const result = await registry.callTool('mix_colors', {
      colors: [
        { color: '#0000ff', weight: 1 },
        { color: '#FFFF00', weight: 1 },
      ],
    });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { mixed: string; rgbLerp: string; weights: number[]; model: string };
    expect(out.rgbLerp).toBe('#808080');
    expect(out.weights).toEqual([0.5, 0.5]);
    expect(out.model).toBe('kubelka-munk');
    const mixed = hex(out.mixed);
    expect(mixed[1]).toBeGreaterThan(mixed[0]);
    expect(mixed[1]).toBeGreaterThan(mixed[2]);
  });

  it('takes tinting strength and uneven parts', async () => {
    const call = (strength: number) =>
      registry.callTool('mix_colors', {
        colors: [
          { color: '#1b2a8c', weight: 1, strength },
          { color: '#ffffff', weight: 9 },
        ],
      });
    const weak = (await call(1)).structuredContent as { mixed: string; weights: number[] };
    const strong = (await call(4)).structuredContent as { mixed: string };
    expect(weak.weights).toEqual([0.1, 0.9]);
    expect(luminance(hex(strong.mixed))).toBeLessThan(luminance(hex(weak.mixed)));
  });

  it('fails usefully on bad arguments', async () => {
    const bad = async (args: unknown) => {
      const r = await registry.callTool('mix_colors', args as Record<string, unknown>);
      expect(r.isError).toBe(true);
      return (r.content[0] as { text: string }).text;
    };
    expect(await bad({ colors: [{ color: 'blue', weight: 1 }] })).toMatch(/#rrggbb/);
    expect(await bad({ colors: [{ color: '#ffffff', weight: 0 }] })).toMatch(/weight above 0/);
    expect(await bad({ colors: [] })).toMatch(/colors/);
    expect(await bad({ colors: [{ color: '#ffffff' }] })).toMatch(/weight/);
    expect(await bad({ colors: [{ color: '#ffffff', weight: 1, extra: true }] })).toMatch(/extra/);
    expect(await bad({ colors: [{ color: '#ffffff', weight: 1, strength: 0 }] })).toMatch(/strength/);
  });

  it('is read-only', () => {
    const tool = registry.listTools().tools.find((t) => baseToolName(t.name) === 'mix_colors')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });
});
