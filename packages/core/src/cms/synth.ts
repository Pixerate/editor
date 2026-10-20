// Portions ported from photocraft/crates/cms/src/synth.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * A synthetic coated-offset CMYK profile, built from a printing model rather than shipped as
 * measured data (so it carries no licence): a Yule-Nielsen-modified Neugebauer model over 16
 * primaries with tone value increase, inverted per node by damped least squares with a total
 * ink limit and grey component replacement. The perceptual B2A compresses colour towards a
 * gamut boundary descriptor; the colorimetric one clips.
 *
 * Generating it takes about a second, so `coatedCmyk()` builds it once, on first use.
 */

import { Clut } from './clut';
import type { Curve } from './curve';
import { D50, apply, invert, labToXyz, s15f16Round, xyzToLab, type Mat3, type Vec3 } from './math';
import type { Lut, Profile } from './profile';

export const COATED_CMYK_DESCRIPTION = 'Pixerate Coated CMYK (synthetic, 300% TAC, medium GCR)';

export interface CmykParams {
  description: string;
  /** Total area coverage, 0..4 (3 = 300 %). */
  tac: number;
  /** Grey component replacement starts at this grey level. */
  gcrStart: number;
  kMax: number;
  gcrGamma: number;
  /** Tone value increase at 50 % per ink (C, M, Y, K). */
  tvi: [number, number, number, number];
  gridA2b: number;
  gridB2a: number;
}

export const DEFAULT_CMYK_PARAMS: Readonly<CmykParams> = {
  description: COATED_CMYK_DESCRIPTION,
  tac: 3.0,
  gcrStart: 0.2,
  kMax: 0.95,
  gcrGamma: 1.1,
  tvi: [0.14, 0.14, 0.14, 0.17],
  gridA2b: 11,
  gridB2a: 17,
};

const YN = 2.0;

/** The printing model: CMYK (0..1) → XYZ and Lab relative to the paper. */
export class CmykModel {
  private readonly primN: Vec3[] = [];
  readonly paper: Vec3;

  constructor(readonly tvi: readonly number[]) {
    const lab = (l: number, a: number, b: number) => labToXyz([l, a, b]);
    const w = lab(95, 0, -2);
    const base: Vec3[] = [
      w, // paper
      lab(55, -37, -50), // C
      lab(48, 74, -3), // M
      lab(24, 22, -46), // C+M
      lab(89, -5, 93), // Y
      lab(50, -65, 27), // C+Y
      lab(47, 68, 48), // M+Y
      lab(23, 0, 0), // C+M+Y
    ];
    const k = lab(16, 0, 0);
    const floor = 0.006;
    for (let m = 0; m < 16; m++) {
      const p = base[m & 7];
      const prim: Vec3 =
        m & 8
          ? [0, 1, 2].map((i) => {
              const s = floor * w[i];
              return s + ((p[i] - s) * (k[i] - s)) / (w[i] - s);
            }) as Vec3
          : p;
      this.primN.push(prim.map((v) => Math.pow(Math.max(0, v), 1 / YN)) as Vec3);
    }
    this.paper = w;
  }

  xyz(cmyk: ArrayLike<number>): Vec3 {
    const a = [0, 1, 2, 3].map((i) => {
      const v = Math.min(1, Math.max(0, cmyk[i]));
      return Math.min(1, Math.max(0, v + 4 * this.tvi[i] * v * (1 - v)));
    });
    const s: Vec3 = [0, 0, 0];
    for (let m = 0; m < 16; m++) {
      let w = 1;
      for (let i = 0; i < 4; i++) w *= m & (1 << i) ? a[i] : 1 - a[i];
      if (w === 0) continue;
      const p = this.primN[m];
      s[0] += w * p[0];
      s[1] += w * p[1];
      s[2] += w * p[2];
    }
    return [Math.pow(s[0], YN), Math.pow(s[1], YN), Math.pow(s[2], YN)];
  }

  lab(cmyk: ArrayLike<number>): Vec3 {
    const x = this.xyz(cmyk);
    return xyzToLab([(x[0] * D50[0]) / this.paper[0], (x[1] * D50[1]) / this.paper[1], (x[2] * D50[2]) / this.paper[2]]);
  }
}

function solveCmy(model: CmykModel, target: Vec3, k: number, limit: number, seeds: Vec3[]): [Vec3, number] {
  const project = (x: Vec3): Vec3 => {
    const v: Vec3 = [x[0], x[1], x[2]];
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < 3; i++) v[i] = Math.min(1, Math.max(0, v[i]));
      const s = v[0] + v[1] + v[2];
      if (s <= limit + 1e-12) break;
      const active = Math.max(1, v.filter((x) => x > 0).length);
      const d = (s - limit) / active;
      for (let i = 0; i < 3; i++) if (v[i] > 0) v[i] -= d;
    }
    return v;
  };
  const err = (x: Vec3): Vec3 => {
    const l = model.lab([x[0], x[1], x[2], k]);
    return [l[0] - target[0], l[1] - target[1], l[2] - target[2]];
  };
  const norm2 = (e: Vec3) => e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  let best: [Vec3, number] = [[0, 0, 0], Infinity];
  for (const seed of seeds) {
    let x = project(seed);
    let e = err(x);
    let f = norm2(e);
    let lambda = 1e-3;
    for (let iter = 0; iter < 60; iter++) {
      const h = 1e-5;
      const j: Mat3 = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      for (let c = 0; c < 3; c++) {
        const xp: Vec3 = [x[0], x[1], x[2]];
        xp[c] += h;
        const ep = err(xp);
        for (let r = 0; r < 3; r++) j[r][c] = (ep[r] - e[r]) / h;
      }
      const a: Mat3 = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      const g: Vec3 = [0, 0, 0];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) a[r][c] = j[0][r] * j[0][c] + j[1][r] * j[1][c] + j[2][r] * j[2][c];
        g[r] = -(j[0][r] * e[0] + j[1][r] * e[1] + j[2][r] * e[2]);
      }
      let improved = false;
      for (let t = 0; t < 8; t++) {
        const al: Mat3 = [
          [a[0][0], a[0][1], a[0][2]],
          [a[1][0], a[1][1], a[1][2]],
          [a[2][0], a[2][1], a[2][2]],
        ];
        for (let d = 0; d < 3; d++) al[d][d] += lambda * (1 + a[d][d]);
        const inv = invert(al);
        if (!inv) {
          lambda *= 10;
          continue;
        }
        const step = apply(inv, g);
        const xn = project([x[0] + step[0], x[1] + step[1], x[2] + step[2]]);
        const en = err(xn);
        const fnew = norm2(en);
        if (fnew < f) {
          const moved = Math.max(Math.abs(xn[0] - x[0]), Math.abs(xn[1] - x[1]), Math.abs(xn[2] - x[2]));
          x = xn;
          e = en;
          f = fnew;
          lambda = Math.max(1e-9, lambda * 0.3);
          improved = moved > 1e-9;
          break;
        }
        lambda *= 10;
      }
      if (!improved || f < 1e-10) break;
    }
    if (f < best[1]) best = [x, f];
    if (best[1] < 1e-6) break;
  }
  return [best[0], Math.sqrt(best[1])];
}

const SEEDS: Vec3[] = [
  [0.3, 0.3, 0.3],
  [0.05, 0.05, 0.05],
  [0.8, 0.8, 0.8],
  [0.9, 0.2, 0.2],
  [0.2, 0.9, 0.9],
];

/** Separates a Lab colour into CMYK with GCR under the ink limit; returns it and the ΔE left. */
export function separate(model: CmykModel, p: CmykParams, target: Vec3, warm: number[] | null): [number[], number] {
  const seeds: Vec3[] = warm ? [[warm[0], warm[1], warm[2]], ...SEEDS] : SEEDS;
  const [cmy0] = solveCmy(model, target, 0, 3, seeds);
  const g = Math.min(cmy0[0], cmy0[1], cmy0[2]);
  const k = g <= p.gcrStart ? 0 : p.kMax * Math.pow((g - p.gcrStart) / (1 - p.gcrStart), p.gcrGamma);
  const seeds2: Vec3[] = [[Math.max(0, cmy0[0] - k), Math.max(0, cmy0[1] - k), Math.max(0, cmy0[2] - k)], cmy0, ...seeds];
  const [cmy, de] = solveCmy(model, target, k, Math.max(0, p.tac - k), seeds2);
  return [[cmy[0], cmy[1], cmy[2], k], de];
}

/** Gamut boundary descriptor: the largest chroma per lightness and hue bin. */
class Gbd {
  private readonly lBins = 41;
  private readonly hBins = 72;
  private readonly cmax: Float64Array;
  readonly blackL: number;

  constructor(model: CmykModel, p: CmykParams) {
    const { lBins, hBins } = this;
    const cmax = new Float64Array(lBins * hBins);
    const n = 13;
    let blackL = 100;
    for (let ci = 0; ci < n; ci++) {
      for (let mi = 0; mi < n; mi++) {
        for (let yi = 0; yi < n; yi++) {
          for (let ki = 0; ki < 7; ki++) {
            const v = [ci / (n - 1), mi / (n - 1), yi / (n - 1), ki / 6];
            if (v[0] + v[1] + v[2] + v[3] > p.tac + 1e-9) continue;
            const lab = model.lab(v);
            blackL = Math.min(blackL, lab[0]);
            const c = Math.hypot(lab[1], lab[2]);
            const h = (Math.atan2(lab[2], lab[1]) + 2 * Math.PI) % (2 * Math.PI);
            const li = Math.min(lBins - 1, Math.max(0, Math.round((lab[0] / 100) * (lBins - 1))));
            const hi = Math.round((h / (2 * Math.PI)) * hBins) % hBins;
            cmax[li * hBins + hi] = Math.max(cmax[li * hBins + hi], c);
          }
        }
      }
    }
    const get = (v: Float64Array, l: number, h: number) => v[Math.min(lBins - 1, Math.max(0, l)) * hBins + (((h % hBins) + hBins) % hBins)];
    const filled = new Float64Array(cmax.length);
    for (let l = 0; l < lBins; l++) {
      for (let h = 0; h < hBins; h++) {
        let m = 0;
        for (let dl = -1; dl <= 1; dl++) for (let dh = -1; dh <= 1; dh++) m = Math.max(m, get(cmax, l + dl, h + dh));
        filled[l * hBins + h] = m;
      }
    }
    this.cmax = new Float64Array(cmax.length);
    for (let l = 0; l < lBins; l++) {
      for (let h = 0; h < hBins; h++) {
        let s = 0;
        for (let dl = -1; dl <= 1; dl++) for (let dh = -1; dh <= 1; dh++) s += get(filled, l + dl, h + dh);
        this.cmax[l * hBins + h] = s / 9;
      }
    }
    this.blackL = blackL;
  }

  private maxChroma(l: number, h: number): number {
    const { lBins, hBins } = this;
    const lp = Math.min(1, Math.max(0, l / 100)) * (lBins - 1);
    const hp = ((((h % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI)) * hBins;
    const l0 = Math.floor(lp);
    const h0 = Math.floor(hp);
    const fl = lp - l0;
    const fh = hp - h0;
    const l1 = Math.min(lBins - 1, l0 + 1);
    const h0m = h0 % hBins;
    const h1m = (h0 + 1) % hBins;
    const v = (ll: number, hh: number) => this.cmax[ll * hBins + hh];
    const a = v(l0, h0m) + (v(l0, h1m) - v(l0, h0m)) * fh;
    const b = v(l1, h0m) + (v(l1, h1m) - v(l1, h0m)) * fh;
    return a + (b - a) * fl;
  }

  /** Lightness mapped onto the printable range, chroma softly compressed above 80 % of the boundary. */
  compress(lab: Vec3): Vec3 {
    const l = this.blackL + (Math.min(100, Math.max(0, lab[0])) * (100 - this.blackL)) / 100;
    const c = Math.hypot(lab[1], lab[2]);
    if (c < 1e-9) return [l, 0, 0];
    const h = Math.atan2(lab[2], lab[1]);
    const cm = Math.max(1e-3, this.maxChroma(l, h));
    const knee = 0.8 * cm;
    const c2 = c <= knee ? c : knee + (cm - knee) * Math.tanh((c - knee) / (cm - knee));
    return [l, c2 * Math.cos(h), c2 * Math.sin(h)];
  }
}

const decodeV2 = (v: number[]): Vec3 => [(v[0] * 100 * 65535) / 65280, (v[1] * 65535) / 256 - 128, (v[2] * 65535) / 256 - 128];
const encodeV2 = (lab: Vec3): number[] => [
  Math.min(1, Math.max(0, lab[0] / ((100 * 65535) / 65280))),
  Math.min(1, Math.max(0, ((lab[1] + 128) * 256) / 65535)),
  Math.min(1, Math.max(0, ((lab[2] + 128) * 256) / 65535)),
];

function b2aTable(model: CmykModel, p: CmykParams, gbd: Gbd | null): Clut {
  const n = p.gridB2a;
  const data = new Float32Array(n * n * n * 4);
  for (let li = 0; li < n; li++) {
    for (let ai = 0; ai < n; ai++) {
      let warm: number[] | null = null;
      for (let bi = 0; bi < n; bi++) {
        const lab = decodeV2([li / (n - 1), ai / (n - 1), bi / (n - 1)]);
        const target = gbd ? gbd.compress(lab) : lab;
        const [cmyk] = separate(model, p, target, warm);
        warm = cmyk;
        data.set(cmyk, ((li * n + ai) * n + bi) * 4);
      }
    }
  }
  return new Clut([n, n, n], 4, data);
}

const ramp = (): Curve => ({ type: 'table', table: Float32Array.from([0, 1]) });

function lut16(clut: Clut): Lut {
  return {
    kind: 'lut16',
    inputs: clut.inputs,
    outputs: clut.outputs,
    stages: [
      { kind: 'curves', curves: Array.from({ length: clut.inputs }, ramp) },
      { kind: 'clut', clut },
      { kind: 'curves', curves: Array.from({ length: clut.outputs }, ramp) },
    ],
  };
}

/** A synthetic CMYK profile model from `p` (bytes not encoded; see `builtin`). */
export function cmykProfile(p: CmykParams = DEFAULT_CMYK_PARAMS, copyright = ''): Profile {
  const model = new CmykModel(p.tvi);
  const g = p.gridA2b;
  const a2bClut = Clut.sample([g, g, g, g], 3, (inp, out) => out.set(encodeV2(model.lab(inp))));
  const gbd = new Gbd(model, p);
  const a2b = lut16(a2bClut);
  const perceptual = lut16(b2aTable(model, p, gbd));
  const colorimetric = lut16(b2aTable(model, p, null));
  return {
    version: [4, 0x30],
    profileClass: 'output',
    colorSpace: 'cmyk',
    pcs: 'lab',
    renderingIntent: 'perceptual',
    description: p.description,
    copyright,
    whitePoint: model.paper.map(s15f16Round) as Vec3,
    blackPoint: null,
    chad: null,
    matrix: null,
    trc: null,
    grayTrc: null,
    a2b: [a2b, a2b, a2b],
    b2a: [perceptual, colorimetric, perceptual],
    bytes: null,
  };
}
