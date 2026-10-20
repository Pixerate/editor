// CMS cases re-expressed from photocraft/crates/cms (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROFILES,
  Clut,
  CmsError,
  D50,
  D65_XY,
  GamutCheck,
  Lut3d,
  Transform,
  apply,
  blackPoint,
  bradford,
  builtinProfile,
  builtinProfileId,
  canBeDestination,
  encodeProfile,
  evalCurve,
  evalCurveInverse,
  gammaCurve,
  grayAsRgb,
  invert,
  labToXyz,
  mul,
  parseProfile,
  readJpegIcc,
  readPngIcc,
  sameColors,
  sampleCurve,
  srgbTrc,
  writeJpegIcc,
  writePngIcc,
  xyToXyz,
  xyzToLab,
  type Curve,
} from '../src/cms';
import { encodePng } from '../src/raster/png';

const lab = () => builtinProfile('lab-d50');
const srgb = () => builtinProfile('srgb');
const toLab = (rgb: number[], p = srgb()) => {
  const out = new Float32Array(3);
  Transform.create(p, lab(), { intent: 'relative', bpc: false }).eval(rgb, out);
  return [out[0] * 100, out[1] * 255 - 128, out[2] * 255 - 128];
};

describe('colour maths', () => {
  it('Lab round trips, the white is L 100, Bradford maps whites and inverses invert', () => {
    for (const xyz of [[0.2, 0.3, 0.1], [...D50], [0.001, 0.002, 0.0005]]) {
      const back = labToXyz(xyzToLab(xyz));
      for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(xyz[i], 12);
    }
    expect(xyzToLab(D50)[0]).toBeCloseTo(100, 12);
    const d65 = xyToXyz(D65_XY);
    const w = apply(bradford(d65, D50), d65);
    for (let i = 0; i < 3; i++) expect(w[i]).toBeCloseTo(D50[i], 12);
    const m: Parameters<typeof mul>[0] = [
      [0.4, 0.3, 0.2],
      [0.2, 0.7, 0.1],
      [0, 0.1, 0.8],
    ];
    const id = mul(m, invert(m)!);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(id[i][j]).toBeCloseTo(i === j ? 1 : 0, 12);
  });

  it('curves: sRGB matches its formula, parametric and table curves invert, HDR extends', () => {
    const c = srgbTrc();
    for (let i = 0; i <= 255; i++) {
      const v = i / 255;
      const want = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      expect(evalCurve(c, v)).toBeCloseTo(want, 12);
      expect(evalCurveInverse(c, want)).toBeCloseTo(v, 9);
    }
    const curves: Curve[] = [
      { type: 'parametric', kind: 1, p: [2, 0.9, 0.1, 0, 0, 0, 0] },
      { type: 'parametric', kind: 2, p: [2, 0.9, 0.1, 0.05, 0, 0, 0] },
      { type: 'parametric', kind: 4, p: [2.4, 0.9, 0.05, 0.08, 0.04, 0.01, 0.002] },
      gammaCurve(1.8),
    ];
    for (const k of curves) for (let i = 1; i < 100; i++) expect(evalCurveInverse(k, evalCurve(k, i / 100))).toBeCloseTo(i / 100, 6);
    const t: Curve = { type: 'table', table: sampleCurve(gammaCurve(2.2), 1024) };
    for (let i = 0; i <= 100; i++) expect(Math.abs(evalCurveInverse(t, evalCurve(t, i / 100)) - i / 100)).toBeLessThan(1e-4);
    expect(evalCurveInverse({ type: 'table', table: Float32Array.from([1, 0.5, 0]) }, 0.25)).toBeCloseTo(0.75, 6);
    expect(evalCurve(c, 2)).toBeGreaterThan(1);
    expect(evalCurve(gammaCurve(2.2), -0.5)).toBeCloseTo(-Math.pow(0.5, 2.2), 12);
  });

  it('CLUTs are exact on nodes and on linear functions', () => {
    const f = (p: ArrayLike<number>, o: Float32Array) => {
      o[0] = p[0] * 0.5 + p[1] * 0.3 + p[2] * 0.2;
      o[1] = p[0] * p[1];
    };
    const c = Clut.sample([5, 5, 5], 2, f);
    const o = new Float32Array(2);
    c.eval([0.25, 0.5, 0.75], o);
    expect(o[1]).toBeCloseTo(0.125, 6);
    c.eval([0.13, 0.77, 0.41], o);
    expect(o[0]).toBeCloseTo(0.13 * 0.5 + 0.77 * 0.3 + 0.41 * 0.2, 6);
    const c4 = Clut.sample([3, 3, 3, 3], 1, (p, out) => (out[0] = (p[0] + p[1] + p[2] + p[3]) / 4));
    c4.eval([0.1, 0.2, 0.3, 0.9], o);
    expect(o[0]).toBeCloseTo(0.375, 5);
  });
});

describe('profiles', () => {
  it('built-in profiles encode, parse back and keep their colours', () => {
    for (const { id, colorSpace } of BUILTIN_PROFILES.filter((b) => b.id !== 'coated-cmyk')) {
      const p = builtinProfile(id);
      expect(p.colorSpace).toBe(colorSpace);
      const back = parseProfile(encodeProfile(p));
      expect(back.description).toBe(p.description);
      expect(sameColors(p, back, lab())).toBe(true);
    }
    expect(builtinProfileId('Adobe RGB (1998)')).toBe('adobe-rgb-compat');
    expect(builtinProfileId('sRGB IEC61966-2.1')).toBe('srgb');
    expect(builtinProfileId('nope')).toBeNull();
  });

  it('sRGB white is Lab 100 0 0 and red is where CIE puts it', () => {
    const w = toLab([1, 1, 1]);
    expect(w[0]).toBeCloseTo(100, 1);
    expect(Math.abs(w[1]) + Math.abs(w[2])).toBeLessThan(0.5);
    const red = toLab([1, 0, 0]);
    expect(red[0]).toBeCloseTo(54.29, 0);
    expect(red[1]).toBeCloseTo(80.8, 0);
    expect(red[2]).toBeCloseTo(69.9, 0);
  });

  it('different encodings of one space are the same colours; different spaces are not', () => {
    const p3 = builtinProfile('display-p3');
    expect(sameColors(srgb(), p3, lab())).toBe(false);
    expect(sameColors(builtinProfile('sgray'), builtinProfile('gray-gamma-2.2'), lab())).toBe(false);
    // A grey profile as RGB keeps its colours on the neutral axis.
    const g = builtinProfile('sgray');
    const asRgb = grayAsRgb(g)!;
    const a = toLab([0.4, 0.4, 0.4], asRgb);
    const out = new Float32Array(3);
    Transform.create(g, lab(), { bpc: false }).eval([0.4], out);
    expect(a[0]).toBeCloseTo(out[0] * 100, 2);
  });

  it('refuses what is not a profile', () => {
    expect(() => parseProfile(new Uint8Array(10))).toThrow(CmsError);
    const bad = encodeProfile(srgb());
    bad[36] = 0x41;
    expect(() => parseProfile(bad)).toThrow(/acsp/);
    expect(() => parseProfile(encodeProfile(srgb()).subarray(0, 140))).toThrow(/truncated/);
  });
});

describe('transforms', () => {
  it('sRGB ↔ Display P3 round trips and white stays white', () => {
    const p3 = builtinProfile('display-p3');
    const there = Transform.create(srgb(), p3);
    const back = Transform.create(p3, srgb());
    const px = Uint8ClampedArray.from([255, 255, 255, 255, 200, 30, 60, 128, 10, 128, 240, 0]);
    const mid = new Uint8ClampedArray(px.length);
    there.convert8(px, 4, mid, 4);
    expect([...mid.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect(mid[7]).toBe(128);
    // Saturated sRGB red is less saturated in P3.
    expect(mid[4]).toBeLessThan(200);
    const out = new Uint8ClampedArray(px.length);
    back.convert8(mid, 4, out, 4);
    for (let i = 0; i < px.length; i++) expect(Math.abs(out[i] - px[i])).toBeLessThanOrEqual(1);
    // Adobe RGB-compatible: sRGB's green lands well inside.
    const adobe = new Uint8ClampedArray(4);
    Transform.create(srgb(), builtinProfile('adobe-rgb-compat')).convert8([0, 255, 0, 255], 4, adobe, 4);
    expect(adobe[0]).toBeGreaterThan(130);
    expect(adobe[1]).toBeGreaterThan(250);
    expect(adobe[2]).toBeLessThan(80);
  });

  it('16-bit and float buffers convert, floats keep HDR through matrix profiles', () => {
    const t = Transform.create(srgb(), builtinProfile('linear-srgb'));
    const o16 = new Uint16Array(4);
    t.convert16(Uint16Array.from([32768, 32768, 32768, 65535]), 4, o16, 4);
    expect(o16[0] / 65535).toBeCloseTo(0.214, 3);
    const of = new Float32Array(3);
    Transform.create(builtinProfile('linear-srgb'), srgb()).convertFloat([2, 0.5, 0], 3, of, 3);
    expect(of[0]).toBeGreaterThan(1);
  });

  it('a synthetic coated CMYK: paper white, rich black, intents, BPC, proofing and gamut', () => {
    const cmyk = builtinProfile('coated-cmyk');
    expect(cmyk.colorSpace).toBe('cmyk');
    expect(canBeDestination(cmyk)).toBe(true);
    const to = Transform.create(srgb(), cmyk, { intent: 'relative' });
    const out = new Float32Array(4);
    to.evalFast([1, 1, 1], out);
    expect(Math.max(...out)).toBeLessThan(0.02);
    to.eval([0, 0, 0], out);
    expect(out[3]).toBeGreaterThan(0.6);
    expect(out[0] + out[1] + out[2] + out[3]).toBeLessThanOrEqual(3.05);
    // A mid grey comes back close.
    const back = new Float32Array(3);
    Transform.create(cmyk, srgb()).eval(out.fill(0).map((_, i) => [0, 0, 0, 0.5][i]), back);
    const grey = toLab([back[0], back[1], back[2]]);
    expect(Math.abs(grey[1]) + Math.abs(grey[2])).toBeLessThan(4);
    // Absolute colorimetric keeps the paper's tint; relative maps it to white.
    const abs = new Float32Array(3);
    const rel = new Float32Array(3);
    Transform.create(cmyk, lab(), { intent: 'absolute' }).eval([0, 0, 0, 0], abs);
    Transform.create(cmyk, lab(), { intent: 'relative', bpc: false }).eval([0, 0, 0, 0], rel);
    expect(abs[0] * 100).toBeLessThan(rel[0] * 100 - 2);
    // Black points: sRGB's is 0, the press reaches only a dark grey.
    expect(blackPoint(srgb(), 'relative')).toBe(0);
    expect(blackPoint(cmyk, 'relative')).toBeGreaterThan(0.005);
    // Soft proof: saturated blue loses chroma through the press.
    const proof = Transform.proof(srgb(), cmyk, srgb(), 'relative', true, false);
    const seen = new Float32Array(3);
    proof.eval([0, 0, 1], seen);
    const before = toLab([0, 0, 1]);
    const after = toLab([seen[0], seen[1], seen[2]]);
    expect(Math.hypot(after[1], after[2])).toBeLessThan(Math.hypot(before[1], before[2]) - 20);
    const gamut = new GamutCheck(srgb(), cmyk, lab());
    expect(gamut.outOfGamut([0, 0, 1])).toBe(true);
    expect(gamut.outOfGamut([0.5, 0.5, 0.5])).toBe(false);
  }, 60_000);

  it('a 3D display table follows the transform', () => {
    const t = Transform.create(srgb(), builtinProfile('display-p3'));
    const lut = new Lut3d(t, 17);
    const a = new Float32Array(3);
    const b = [0, 0, 0];
    t.eval([0.3, 0.6, 0.2], a);
    lut.sample(0.3, 0.6, 0.2, b);
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(0.01);
  });
});

describe('embedded profiles', () => {
  it('PNG iCCP and JPEG APP2 round trip (a JPEG profile split over segments)', () => {
    const icc = encodeProfile(builtinProfile('display-p3'));
    const png = encodePng(2, 1, Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 255]));
    expect(readPngIcc(png)).toBeNull();
    const tagged = writePngIcc(png, icc, 'Display P3');
    expect(readPngIcc(tagged)).toEqual(icc);
    expect(parseProfile(readPngIcc(writePngIcc(tagged, encodeProfile(srgb())))!).description).toBe('sRGB IEC61966-2.1');
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9]);
    expect(readJpegIcc(jpeg)).toBeNull();
    const big = new Uint8Array(150_000).map((_, i) => i & 255);
    const j2 = writeJpegIcc(jpeg, big);
    expect(readJpegIcc(j2)).toEqual(big);
    expect(j2[2]).toBe(0xff);
    expect(j2[3]).toBe(0xe0); // APP0 stays first
    expect(readJpegIcc(writeJpegIcc(j2, icc))).toEqual(icc);
    expect([...j2.subarray(j2.length - 8)]).toEqual([0xff, 0xda, 0, 2, 9, 9, 0xff, 0xd9]);
  });
});

describe('cms module', () => {
  it('imports only itself and the zlib codec, with no DOM globals', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '../src/cms');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      expect(imports.filter((i) => !i.startsWith('./') && i !== '../raster/zlib'), f).toEqual([]);
      expect(/\b(window|document|HTMLCanvasElement|OffscreenCanvas)\b/.test(src), f).toBe(false);
    }
  });
});
