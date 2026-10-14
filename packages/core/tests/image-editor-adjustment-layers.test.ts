// Photoshop ground-truth cases re-expressed from photocraft-main/crates/compose/src/adjust.rs, compose/src/tests.rs
// and doc/src/adjust.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_LUT_SIZE,
  DEFAULT_ADJUSTMENTS,
  ImageEditorController,
  applyAdjustmentLayers,
  applyAdjustments,
  blackWhiteGray,
  colorBalanceChannel,
  createAdjustmentLayer,
  curveLut,
  evaluateAdjustmentLayers,
  hueRangeWeight,
  levelsValue,
  migrateSerializedImageEditorState,
  neutralHueRange,
  normalizeAdjustmentLayer,
  posterizeValue,
  rangeLightness,
  toneLuts,
  type AdjustmentLayer,
  type HueRange,
  type ImageAdjustments,
  type SerializedImageEditorState,
} from '../src/image-editor';

const to255 = (c: number[]) => c.map((v) => v * 255);
const from255 = (c: number[]) => c.map((v) => v / 255);
const expectNear = (got: number[], want: number[], tol: number, what = '') => {
  got.forEach((g, i) => {
    if (Math.abs(g - want[i]) > tol) throw new Error(`${what} channel ${i}: got ${g}, want ${want[i]} (±${tol})`);
  });
};

function imageFrom(pixels: number[][]): ImageData {
  return { width: pixels.length, height: 1, data: new Uint8ClampedArray(pixels.flat()), colorSpace: 'srgb' } as ImageData;
}

const RAMP = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255];

describe('curves', () => {
  it('is the identity for a straight line and constant outside the end points', () => {
    const lut = curveLut([{ input: 0, output: 0 }, { input: 1, output: 1 }]);
    expect(lut.length).toBe(ADJUSTMENT_LUT_SIZE);
    for (const k of [0, 1000, 2047, 4095]) expect(lut[k]).toBeCloseTo(k / 4095, 5);
    const clipped = curveLut([{ input: 0.25, output: 0.1 }, { input: 0.75, output: 0.9 }]);
    expect(clipped[0]).toBeCloseTo(0.1, 5);
    expect(clipped[4095]).toBeCloseTo(0.9, 5);
  });

  it('is a natural cubic spline through the points (overshoot clamped)', () => {
    const lut = curveLut([{ input: 0, output: 0 }, { input: 0.5, output: 0.7 }, { input: 1, output: 1 }]);
    expect(lut[Math.round(0.5 * 4095)]).toBeCloseTo(0.7, 3);
    // Monotonic lift between the points.
    expect(lut[1000]).toBeGreaterThan(1000 / 4095);
    const wild = curveLut([{ input: 0, output: 0 }, { input: 0.1, output: 1 }, { input: 0.2, output: 0 }, { input: 1, output: 1 }]);
    expect(Math.min(...wild)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...wild)).toBeLessThanOrEqual(1);
  });

  it('ignores duplicate and non-finite points', () => {
    const lut = curveLut([{ input: 0, output: 0 }, { input: 0, output: 0.5 }, { input: NaN, output: 1 }, { input: 1, output: 1 }]);
    expect(lut[2048]).toBeCloseTo(2048 / 4095, 4);
  });
});

describe('levels', () => {
  const ident = (gamma: number) => ({ inBlack: 0, inWhite: 1, gamma, outBlack: 0, outWhite: 1 });

  it('matches Photoshop gamma 2.0 within 4 levels, including the soft shadow toe', () => {
    const measured: [number, number][] = [[1, 4], [8, 30], [16, 55], [32, 90], [64, 128], [128, 181], [192, 221], [224, 239]];
    for (const [x, ps] of measured) {
      expect(Math.abs(Math.round(levelsValue(ident(2), x / 255) * 255) - ps)).toBeLessThanOrEqual(4);
    }
  });

  it('is an exact power curve for gamma below 1 and pins the end points', () => {
    for (const x of [0, 32, 64, 128, 192, 255]) {
      expect(Math.round(levelsValue(ident(0.5), x / 255) * 255)).toBe(Math.round((x / 255) ** 2 * 255));
    }
    expect(levelsValue(ident(2.5), 0)).toBe(0);
    expect(Math.round(levelsValue(ident(2.5), 1) * 255)).toBe(255);
    expect(levelsValue(ident(1), 0.37)).toBeCloseTo(0.37, 6);
  });

  it('works on whole levels like Photoshop (8-bit, range 44..214, gamma 1.78)', () => {
    const layer = createAdjustmentLayer('levels', {
      params: {
        red: { inBlack: 44, inWhite: 214, gamma: 1.78, outBlack: 0, outWhite: 255 },
        green: { inBlack: 44, inWhite: 214, gamma: 1.78, outBlack: 0, outWhite: 255 },
        blue: { inBlack: 44, inWhite: 214, gamma: 1.78, outBlack: 0, outWhite: 255 },
      },
    });
    const [lut] = toneLuts(layer)!;
    const at = (v: number) => {
      const x = (v / 255) * 4095;
      const i = Math.floor(x);
      const f = x - i;
      return Math.round((lut[i] * (1 - f) + lut[Math.min(i + 1, 4095)] * f) * 255);
    };
    const measured: [number, number][] = [[44, 0], [45, 7], [46, 10], [47, 17], [48, 20], [52, 37], [69, 88], [100, 137], [214, 255]];
    for (const [v, ps] of measured) expect(Math.abs(at(v) - ps)).toBeLessThanOrEqual(1);
  });

  it('applies each channel before the master, for Levels and Curves alike', () => {
    // channel(x) = 1/2 + x/2, then master(x) = x/2: 0 maps to 0.25.
    const levels = createAdjustmentLayer('levels', {
      params: {
        master: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 127.5 },
        red: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 127.5, outWhite: 255 },
        green: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 127.5, outWhite: 255 },
        blue: { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 127.5, outWhite: 255 },
      },
    });
    const line = (a: number, b: number) => [{ input: 0, output: a }, { input: 255, output: b }];
    const curves = createAdjustmentLayer('curves', {
      params: { master: line(0, 127.5), red: line(127.5, 255), green: line(127.5, 255), blue: line(127.5, 255) },
    });
    const ll = toneLuts(levels)!;
    const cl = toneLuts(curves)!;
    for (let ch = 0; ch < 3; ch++) {
      for (const k of [0, 1024, 2048, 3072, 4095]) expect(Math.abs(ll[ch][k] - cl[ch][k])).toBeLessThan(0.01);
    }
    expect(cl[0][0]).toBeCloseTo(0.25, 2);
    for (const layer of [levels, curves]) {
      expectNear(evaluateAdjustmentLayers([0, 0, 0], [layer]), [0.25, 0.25, 0.25], 0.01, layer.kind);
    }
  });
});

describe('hue/saturation', () => {
  const hs = (input: number[], hue: number, saturation: number, lightness: number, colorize: boolean) =>
    to255(
      evaluateAdjustmentLayers(from255(input), [
        createAdjustmentLayer('hueSaturation', { params: { hue, saturation, lightness, colorize } }),
      ])
    );

  it('matches Photoshop (saturation and colorize with lightness)', () => {
    const measured: [number[], number, number, number, boolean, number[]][] = [
      [[204, 102, 102], 0, 50, 0, false, [254, 51, 51]],
      [[204, 159, 102], 0, 50, 0, false, [254, 164, 51]],
      [[204, 102, 102], 0, -50, 0, false, [178, 127, 127]],
      [[0, 0, 0], 120, 100, 30, true, [0, 152, 0]],
      [[28, 28, 28], 120, 100, 30, true, [0, 192, 0]],
      [[160, 160, 160], 30, 25, -40, true, [120, 96, 73]],
      [[252, 252, 252], 30, 25, -40, true, [177, 151, 126]],
      [[255, 143, 0], 30, 25, -40, true, [95, 76, 58]],
    ];
    for (const [input, hue, s, l, colorize, want] of measured) {
      expectNear(hs(input, hue, s, l, colorize), want, 2, `${input} h${hue} s${s} l${l} ${colorize}`);
    }
  });

  it('colorize at 0% saturation leaves only the lightness', () => {
    for (const l of [0, 30, -30]) {
      for (const c of [[230, 51, 25], [25, 153, 204], [128, 128, 128]]) {
        const out = hs(c, 200, 0, l, true);
        expect(Math.abs(out[0] - out[1])).toBeLessThan(0.05);
        expect(Math.abs(out[1] - out[2])).toBeLessThan(0.05);
      }
    }
  });

  it('weights hue ranges with trapezoids that wrap (reds)', () => {
    const reds = neutralHueRange(0);
    expect(hueRangeWeight(reds, 0)).toBe(1);
    expect(hueRangeWeight(reds, 350)).toBe(1);
    expect(hueRangeWeight(reds, 30)).toBeCloseTo(0.5, 5);
    expect(hueRangeWeight(reds, 330)).toBeCloseTo(0.5, 5);
    expect(hueRangeWeight(reds, 60)).toBe(0);
    expect(hueRangeWeight(reds, 180)).toBe(0);
    const blues = neutralHueRange(4);
    expect(hueRangeWeight(blues, 240)).toBe(1);
    expect(hueRangeWeight(blues, 120)).toBe(0);
    expect(Number.isFinite(hueRangeWeight({ bounds: [10, 10, 10, 10] }, 200))).toBe(true);
    expect(Number.isFinite(hueRangeWeight({ bounds: [NaN, NaN, NaN, NaN] }, 10))).toBe(true);
  });

  it('range edits only touch their colours', () => {
    const ranges = [0, 1, 2, 3, 4, 5].map(neutralHueRange);
    ranges[0].saturation = -100;
    const layer = createAdjustmentLayer('hueSaturation', { params: { ranges } });
    const red = evaluateAdjustmentLayers([0.9, 0.1, 0.1], [layer]);
    expect(Math.abs(red[0] - red[1])).toBeLessThan(0.05);
    expectNear(evaluateAdjustmentLayers([0.1, 0.1, 0.9], [layer]), [0.1, 0.1, 0.9], 1e-4);
    expectNear(evaluateAdjustmentLayers([0.5, 0.5, 0.5], [layer]), [0.5, 0.5, 0.5], 1e-9);
  });

  it('range lightness moves towards the brightest / darkest channel like Photoshop', () => {
    const measured: [number[], number, number[]][] = [
      [[0, 29, 115], 0.5, [57, 71, 115]],
      [[0, 64, 255], 0.5, [125, 157, 255]],
      [[102, 128, 204], 0.5, [152, 165, 204]],
      [[102, 128, 204], -0.5, [102, 115, 154]],
      [[0, 18, 115], -0.5, [0, 9, 58]],
    ];
    for (const [input, l, want] of measured) expectNear(to255(rangeLightness(from255(input), l)), want, 2.5);
  });

  it('applies range edits in full to dull colours (Photoshop render)', () => {
    const range = (lightness: number, bounds: HueRange['bounds']): HueRange => ({ hue: 0, saturation: 0, lightness, bounds });
    const ranges = [
      range(-11, [-57, 4, 82, 175]),
      range(100, [12, 45, 75, 105]),
      neutralHueRange(2),
      neutralHueRange(3),
      neutralHueRange(4),
      range(100, [-117, -50, 39, 104]),
    ];
    const layer = createAdjustmentLayer('hueSaturation', { params: { lightness: 17, ranges } });
    const measured: [number[], number[]][] = [
      [[126, 97, 120], [148, 148, 148]],
      [[131, 103, 125], [152, 152, 152]],
      [[95, 69, 90], [122, 122, 122]],
    ];
    for (const [input, want] of measured) expectNear(to255(evaluateAdjustmentLayers(from255(input), [layer])), want, 2);
    const grey = evaluateAdjustmentLayers([0.4, 0.4, 0.4], [layer]);
    expectNear(grey, [0.4 + 0.6 * 0.17, 0.4 + 0.6 * 0.17, 0.4 + 0.6 * 0.17], 1e-4);
  });
});

describe('vibrance', () => {
  const vib = (c: number[], vibrance: number, saturation: number) =>
    to255(evaluateAdjustmentLayers(from255(c), [createAdjustmentLayer('vibrance', { params: { vibrance, saturation } })]));

  it('saturation matches Photoshop (grey 0.288 R + 0.712 G in linear light)', () => {
    for (const [c, g] of [[[251, 201, 0], 217], [[255, 0, 0], 146], [[0, 255, 0], 219.4], [[0, 0, 255], 0], [[255, 255, 0], 255]] as [number[], number][]) {
      expectNear(vib(c, 0, -100), [g, g, g], 0.5, 'saturation -100');
    }
    const cases: [number[], number, number[]][] = [
      [[255, 128, 0], -50, [220.7, 155.2, 129.4]],
      [[224, 176, 144], -50, [208.6, 183.9, 169.9]],
      [[64, 128, 192], 50, [0, 134.3, 218.7]],
      [[224, 176, 144], 100, [251.3, 158.5, 51.7]],
      [[32, 96, 64], 100, [0, 106.8, 32.8]],
    ];
    for (const [c, s, want] of cases) expectNear(vib(c, 0, s), want, 0.5, `saturation ${s}`);
  });

  it('negative vibrance matches Photoshop', () => {
    const cases: [number[], number, number[]][] = [
      [[255, 0, 0], -100, [255, 137, 137]],
      [[128, 0, 0], -100, [128, 65.7, 65.7]],
      [[224, 176, 144], -100, [213.2, 197.4, 188.8]],
      [[64, 128, 192], -100, [124.4, 149, 185]],
      [[255, 128, 0], -50, [255, 152, 99.1]],
      [[251, 201, 0], -50, [251, 208.1, 97.4]],
      [[32, 96, 64], -50, [50.1, 91.7, 68.6]],
    ];
    for (const [c, v, want] of cases) expectNear(vib(c, v, 0), want, 0.6, `vibrance ${v}`);
  });

  it('positive vibrance saturates dull colours more than vivid ones and keeps greys', () => {
    expectNear(vib([128, 128, 128], 100, 0), [128, 128, 128], 1e-6);
    const dull = vib([140, 120, 110], 60, 0);
    expect(dull[0] - dull[2]).toBeGreaterThan(30);
  });
});

describe('color balance', () => {
  it('matches Photoshop over a grey ramp', () => {
    const rows: [string, number, boolean, number[], number[]][] = [
      ['midtones', 50, false, [0, 36, 59, 78, 96, 112, 128, 142, 156, 170, 183, 196, 209, 221, 233, 244, 255], RAMP],
      ['shadows', -100, false, [0, 0, 0, 0, 0, 0, 0, 7, 23, 43, 67, 93, 122, 154, 186, 221, 255], RAMP],
      ['highlights', 100, false, [0, 51, 84, 111, 136, 160, 182, 202, 223, 242, 255, 255, 255, 255, 255, 255, 255], RAMP],
      ['shadows', 50, true, RAMP, [0, 0, 0, 0, 17, 37, 57, 77, 97, 117, 137, 157, 177, 197, 216, 236, 255]],
      [
        'midtones', 100, true,
        [0, 36, 59, 78, 96, 112, 128, 142, 156, 170, 183, 196, 209, 221, 233, 244, 255],
        [0, 5, 14, 24, 36, 50, 64, 80, 97, 114, 132, 151, 171, 191, 212, 234, 255],
      ],
      ['highlights', -100, true, RAMP, [0, 26, 53, 79, 105, 132, 158, 184, 211, 237, 255, 255, 255, 255, 255, 255, 255]],
    ];
    for (const [tone, amount, preserve, red, green] of rows) {
      const tones: [number[], number[], number[]] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      tones[['shadows', 'midtones', 'highlights'].indexOf(tone)][0] = amount;
      RAMP.forEach((x, i) => {
        const got = (ch: number) => Math.round(colorBalanceChannel(tones, preserve, ch, x / 255) * 255);
        expect(Math.abs(got(0) - red[i]), `${tone} ${amount} ${preserve} red at ${x}`).toBeLessThanOrEqual(1);
        expect(Math.abs(got(1) - green[i]), `${tone} ${amount} ${preserve} green at ${x}`).toBeLessThanOrEqual(1);
      });
    }
    const two = (tones: [number[], number[], number[]], x: number) =>
      [0, 1, 2].map((ch) => Math.round(colorBalanceChannel(tones, true, ch, x / 255) * 255));
    expect(two([[50, 0, 50], [0, 0, 0], [0, 0, 0]], 128)).toEqual([128, 97, 128]);
    expectNear(two([[0, 0, 0], [0, 0, 0], [-50, 50, 0]], 128), [128, 211, 159], 1);
  });

  it('midtones with several sliders use the extremes (preserve luminosity)', () => {
    const tones: [number[], number[], number[]] = [[0, 0, 0], [30, 0, 30], [0, 0, 0]];
    for (const input of [0.25, 0.5, 0.75]) {
      [-0.15, 0.15, -0.15].forEach((offset, ch) => {
        expect(colorBalanceChannel(tones, true, ch, input)).toBeCloseTo(input ** (2 ** offset), 6);
      });
      expect(colorBalanceChannel(tones, false, 1, input)).toBe(input);
    }
  });
});

describe('black & white, photo filter, invert, posterize, threshold', () => {
  const weights = [40, 60, 40, 60, 20, 80];

  it('black & white weights the colour parts of each pixel', () => {
    expect(blackWhiteGray([0.5, 0.5, 0.5], weights)).toBeCloseTo(0.5, 6);
    expect(blackWhiteGray([1, 0, 0], weights)).toBeCloseTo(0.4, 6);
    expect(blackWhiteGray([1, 1, 0], weights)).toBeCloseTo(0.6, 6);
    const w = [...weights];
    w[0] = 100;
    expect(blackWhiteGray([1, 0, 0], w)).toBeGreaterThan(blackWhiteGray([1, 0, 0], weights));
  });

  it('black & white tint matches Photoshop (Color blend of the tint at the grey)', () => {
    const hex = (c: number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
    const measured: [number[], number, number[]][] = [
      [[255, 0, 0], 24, [81, 1, 1]],
      [[255, 0, 0], 120, [255, 64, 64]],
      [[255, 0, 0], 240, [255, 235, 235]],
      [[0xe1, 0xd3, 0xb3], 120, [133, 119, 87]],
      [[0xe1, 0xd3, 0xb3], 24, [33, 24, 1]],
      [[0x40, 0x20, 0x10], 120, [144, 112, 96]],
    ];
    for (const [tint, grey, want] of measured) {
      const layer = createAdjustmentLayer('blackWhite', { params: { tint: hex(tint) } });
      expectNear(to255(evaluateAdjustmentLayers([grey / 255, grey / 255, grey / 255], [layer])), want, 2.5, `tint ${tint} grey ${grey}`);
    }
  });

  it('photo filter matches Photoshop (Warming 85, density 40%, preserve luminosity)', () => {
    const layer = createAdjustmentLayer('photoFilter', { params: { color: '#ec8a00', density: 40, preserveLuminosity: true } });
    const measured: [number[], number[]][] = [
      [[1, 0, 0], [239, 7, 7]],
      [[0, 1, 0], [69, 220, 0]],
      [[0, 0, 1], [46, 0, 130]],
      [[1, 1, 0], [255, 240, 80]],
      [[0.5019, 0.5019, 0.5019], [140, 124, 116]],
      [[0.949, 0.949, 0.949], [255, 238, 229]],
      [[1, 1, 1], [255, 255, 255]],
      [[0, 0, 0], [0, 0, 0]],
    ];
    for (const [v, ps] of measured) expectNear(to255(evaluateAdjustmentLayers(v, [layer])), ps, 1, `${v}`);
  });

  it('posterize uses Photoshop bins and threshold compares on the 8-bit grid', () => {
    expect(posterizeValue(0.2, 2)).toBe(0);
    expect(posterizeValue(0.6, 2)).toBe(1);
    expect(Math.round(posterizeValue(100 / 255, 4) * 255)).toBe(85);
    const img = imageFrom([[127, 127, 127, 255], [128, 128, 128, 255], [10, 20, 30, 0]]);
    applyAdjustmentLayers(img, [createAdjustmentLayer('threshold', { params: { level: 128 } })]);
    expect(Array.from(img.data)).toEqual([0, 0, 0, 255, 255, 255, 255, 255, 10, 20, 30, 0]);
    const inv = imageFrom([[10, 200, 255, 128]]);
    applyAdjustmentLayers(inv, [createAdjustmentLayer('invert')]);
    expect(Array.from(inv.data)).toEqual([245, 55, 0, 128]);
  });
});

describe('layer stack evaluation', () => {
  it('neutral, disabled and transparent layers are the identity', () => {
    const pixels = [[12, 200, 77, 255], [255, 0, 128, 255]];
    const neutral = ADJUSTMENT_KINDS.filter((k) => !['invert', 'posterize', 'threshold', 'blackWhite', 'photoFilter'].includes(k.kind)).map((k) =>
      createAdjustmentLayer(k.kind)
    );
    const img = imageFrom(pixels);
    applyAdjustmentLayers(img, [
      ...neutral,
      createAdjustmentLayer('invert', { enabled: false }),
      createAdjustmentLayer('invert', { opacity: 0 }),
    ]);
    expect(Array.from(img.data)).toEqual(pixels.flat());
  });

  it('blends each layer over the result below with its mode and opacity', () => {
    const half = createAdjustmentLayer('invert', { opacity: 0.5 });
    expectNear(evaluateAdjustmentLayers([0.2, 0.4, 1], [half]), [0.5, 0.5, 0.5], 1e-9);
    // Invert in Multiply: c·(1 − c).
    const multiply = createAdjustmentLayer('invert', { blend: 'multiply' });
    expectNear(evaluateAdjustmentLayers([0.5, 0.25, 1], [multiply]), [0.25, 0.1875, 0], 1e-9);
    // Black & White in Luminosity keeps the colour's hue and saturation (only luminosity changes).
    const lum = createAdjustmentLayer('blackWhite', { blend: 'luminosity' });
    const out = evaluateAdjustmentLayers([0.8, 0.2, 0.2], [lum]);
    expect(out[0]).toBeGreaterThan(out[1]);
  });

  it('runs layers bottom to top', () => {
    const stack: AdjustmentLayer[] = [createAdjustmentLayer('threshold', { params: { level: 128 } }), createAdjustmentLayer('invert')];
    expectNear(evaluateAdjustmentLayers([0.9, 0.9, 0.9], stack), [0, 0, 0], 0);
    expectNear(evaluateAdjustmentLayers([0.9, 0.9, 0.9], [...stack].reverse()), [0, 0, 0], 0);
    expectNear(evaluateAdjustmentLayers([0.6, 0.6, 0.6], [stack[1], stack[0]]), [0, 0, 0], 0);
    expectNear(evaluateAdjustmentLayers([0.4, 0.4, 0.4], [stack[1], stack[0]]), [1, 1, 1], 0);
  });

  it('runs after the base adjustments and before blur in applyAdjustments', () => {
    const base: ImageAdjustments = { ...DEFAULT_ADJUSTMENTS, exposure: 20 };
    const plain = imageFrom([[100, 100, 100, 255]]);
    applyAdjustments(plain, base);
    const layered = imageFrom([[100, 100, 100, 255]]);
    applyAdjustments(layered, { ...base, layers: [createAdjustmentLayer('invert')] });
    expect(layered.data[0]).toBe(255 - plain.data[0]);
  });

  it('normalises stored layers: defaults, clamping, unknown kinds', () => {
    expect(normalizeAdjustmentLayer({ kind: 'nope' })).toBeNull();
    const l = normalizeAdjustmentLayer({ id: 'a', kind: 'vibrance', params: { vibrance: 500 }, opacity: 3, blend: 'bogus' })!;
    expect(l).toEqual({ id: 'a', kind: 'vibrance', enabled: true, opacity: 1, blend: 'normal', params: { vibrance: 100, saturation: 0 } });
    const curves = normalizeAdjustmentLayer({ kind: 'curves', params: { master: [{ input: 0, output: 0 }] } })!;
    expect(curves.kind === 'curves' && curves.params.master).toEqual([{ input: 0, output: 0 }, { input: 255, output: 255 }]);
  });
});

describe('adjustment layers in the controller', () => {
  it('add / update / move / toggle / remove are each one undo step', () => {
    const c = new ImageEditorController();
    const a = c.addAdjustmentLayer('vibrance');
    const b = c.addAdjustmentLayer({ kind: 'curves', opacity: 0.5, blend: 'screen' });
    expect(c.getAdjustmentLayers().map((l) => l.id)).toEqual([a, b]);
    expect(c.getAdjustmentLayer(b)).toMatchObject({ opacity: 0.5, blend: 'screen' });

    expect(c.updateAdjustmentLayer(a, { params: { vibrance: 40 } })).toBe(true);
    expect(c.getAdjustmentLayer(a)!.params).toEqual({ vibrance: 40, saturation: 0 });
    expect(c.moveAdjustmentLayer(a, 1)).toBe(true);
    expect(c.getAdjustmentLayers().map((l) => l.id)).toEqual([b, a]);
    expect(c.toggleAdjustmentLayer(b)).toBe(true);
    expect(c.getAdjustmentLayer(b)!.enabled).toBe(false);
    expect(c.removeAdjustmentLayer(a)).toBe(true);
    expect(c.getAdjustmentLayers().map((l) => l.id)).toEqual([b]);

    c.undo(); // remove
    expect(c.getAdjustmentLayers().map((l) => l.id)).toEqual([b, a]);
    c.undo(); // toggle
    expect(c.getAdjustmentLayer(b)!.enabled).toBe(true);
    c.undo(); // move
    expect(c.getAdjustmentLayers().map((l) => l.id)).toEqual([a, b]);
    c.undo(); // update
    expect(c.getAdjustmentLayer(a)!.params).toEqual({ vibrance: 0, saturation: 0 });
    c.undo(); // add b
    c.undo(); // add a
    expect(c.getAdjustmentLayers()).toEqual([]);
    expect(c.getState().adjustments).toEqual(DEFAULT_ADJUSTMENTS);
    c.redo();
    expect(c.getAdjustmentLayers().map((l) => l.id)).toEqual([a]);
  });

  it('drag updates without history leave one undo step', () => {
    const c = new ImageEditorController();
    const id = c.addAdjustmentLayer('levels');
    c.updateAdjustmentLayer(id, {}, true);
    for (const g of [1.2, 1.4, 1.6]) {
      c.updateAdjustmentLayer(id, { params: { master: { inBlack: 0, inWhite: 255, gamma: g, outBlack: 0, outWhite: 255 } } }, false);
    }
    expect(c.getAdjustmentLayer(id)!.kind === 'levels' && (c.getAdjustmentLayer(id)!.params as any).master.gamma).toBe(1.6);
    c.undo();
    expect((c.getAdjustmentLayer(id)!.params as any).master.gamma).toBe(1);
  });

  it('unknown ids are rejected without history', () => {
    const c = new ImageEditorController();
    expect(c.updateAdjustmentLayer('x', { opacity: 0.5 })).toBe(false);
    expect(c.removeAdjustmentLayer('x')).toBe(false);
    expect(c.moveAdjustmentLayer('x', 0)).toBe(false);
    expect(c.toggleAdjustmentLayer('x')).toBe(false);
    expect(c.canUndo).toBe(false);
  });

  it('reset sliders keeps layers; clearAdjustmentLayers removes them', () => {
    const c = new ImageEditorController();
    c.setAdjustments({ exposure: 30 });
    c.addAdjustmentLayer('invert');
    c.resetAdjustments();
    expect(c.getState().adjustments.exposure).toBe(0);
    expect(c.getAdjustmentLayers()).toHaveLength(1);
    c.clearAdjustmentLayers();
    expect(c.getAdjustmentLayers()).toHaveLength(0);
    expect('layers' in c.getState().adjustments).toBe(false);
  });

  it('serializes layers as schema 2 and round-trips them', () => {
    const c = new ImageEditorController();
    c.addAdjustmentLayer({ kind: 'colorBalance', params: { midtones: [20, 0, -10] }, blend: 'soft-light' });
    const json = c.toJSON();
    expect(json.version).toBe(2);
    expect(json.adjustments.layers).toHaveLength(1);
    const restored = new ImageEditorController();
    restored.loadJSON(JSON.parse(JSON.stringify(json)));
    expect(restored.getState().adjustments).toEqual(c.getState().adjustments);
    expect(JSON.stringify(restored.toJSON())).toBe(JSON.stringify(json));
    // The serialized copy is detached from the live state.
    (json.adjustments.layers![0] as any).opacity = 0;
    expect(c.getAdjustmentLayers()[0].opacity).toBe(1);
  });

  it('migrates version 1 states unchanged, and keeps them at version 1', () => {
    const v1: SerializedImageEditorState = {
      version: 1,
      crop: null,
      transform: { rotate: 0, flipH: false, flipV: false },
      adjustments: { brightness: 10, contrast: 0, saturation: 5, exposure: 0, temperature: 30, blur: 0, opacity: 1 },
      depthMask: { enabled: false, maskSource: null, mode: 'threshold', depthRange: [0, 255], softness: 10, invert: false },
      annotations: [],
    };
    expect(JSON.stringify(migrateSerializedImageEditorState(v1))).toBe(JSON.stringify(v1));
    const c = new ImageEditorController();
    c.loadJSON(v1);
    expect(JSON.stringify(c.toJSON())).toBe(JSON.stringify(v1));
    // Adding a layer bumps the schema; removing it goes back.
    const id = c.addAdjustmentLayer('invert');
    expect(c.toJSON().version).toBe(2);
    c.removeAdjustmentLayer(id);
    expect(JSON.stringify(c.toJSON())).toBe(JSON.stringify(v1));
    // Damaged layer data is cleaned on load.
    const damaged = migrateSerializedImageEditorState({
      ...v1,
      version: 2,
      adjustments: { ...v1.adjustments, layers: [{ kind: 'bogus' }, { id: 'k', kind: 'posterize', params: { levels: 1 } }] as any },
    });
    expect(damaged.adjustments.layers).toEqual([{ id: 'k', kind: 'posterize', enabled: true, opacity: 1, blend: 'normal', params: { levels: 2 } }]);
  });

  it('renders legacy pixels identically when there are no layers', () => {
    const pixels = [[12, 200, 77, 255], [255, 0, 128, 255], [90, 90, 90, 255]];
    const adj = { brightness: 10, contrast: 5, saturation: 20, exposure: 0, temperature: 30, blur: 0, opacity: 1 } as ImageAdjustments;
    const a = imageFrom(pixels);
    applyAdjustments(a, adj);
    const b = imageFrom(pixels);
    applyAdjustments(b, { ...adj, layers: [] });
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });
});
