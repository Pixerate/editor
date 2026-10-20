// Portions ported from photocraft/crates/cms/src/transform.rs, gamut.rs and lut3d.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Colour transforms between profiles through the PCS: rendering intents, black point
 * compensation (the structure of Adobe's published algorithm), soft-proofing chains, gamut
 * checks, and lookup-table evaluation of pixel buffers.
 *
 * - The exact path is a float stage pipeline; float buffers use it by default.
 * - Integer buffers use per-code input tables plus a matrix plus output tables indexed by
 *   x^(1/4) (accurate near black even for pure gamma curves) for matrix/TRC chains, a device
 *   link sampled at 33³ (3 inputs) or 17⁴ (4 inputs) with tetrahedral interpolation for chains
 *   with a CLUT, and the exact path for purely analytic chains (e.g. Lab ↔ RGB).
 */

import { Clut } from './clut';
import { evalCurve, evalCurveInverse, type Curve } from './curve';
import { D50, deltaE76, labToXyz } from './math';
import { Pipeline, type Stage } from './pipeline';
import { CmsError, deviceToPcs, mediaWhite, pcsToDevice, profileChannels, type ColorSpace, type Intent, type Pcs, type Profile } from './profile';

export interface TransformOptions {
  intent: Intent;
  /** Black point compensation (ignored for absolute colorimetric). Default true. */
  bpc: boolean;
  /** Float buffers through the exact pipeline (default true) rather than the tables. */
  preciseFloat: boolean;
}

export const DEFAULT_TRANSFORM_OPTIONS: Readonly<TransformOptions> = { intent: 'relative', bpc: true, preciseFloat: true };

const GRID_3D = 33;
const GRID_4D = 17;
const TABLE_1D = 4096;
const OUT_TABLE = 4096;

/** ICC v4 perceptual reference medium black (ICC.1:2010 §6.3.4.4), Y. */
const PERCEPTUAL_BLACK_Y = 0.0034731;

type Core =
  | { kind: 'shaper'; curves8: Float32Array[]; curves: Float32Array[]; matrix: { rows: number; cols: number; m: Float32Array; offset: Float32Array } | null }
  | { kind: 'grid'; clut: Clut }
  | { kind: 'exact' };

function shaper(cs: Curve[], m: Extract<Stage, { kind: 'matrix' }> | null): Core {
  const curves8 = cs.map((c) => {
    const t = new Float32Array(256);
    for (let i = 0; i < 256; i++) t[i] = evalCurve(c, i / 255);
    return t;
  });
  const curves = cs.map((c) => {
    const t = new Float32Array(TABLE_1D + 1);
    for (let i = 0; i <= TABLE_1D; i++) t[i] = evalCurve(c, i / TABLE_1D);
    return t;
  });
  return { kind: 'shaper', curves8, curves, matrix: m ? { rows: m.rows, cols: m.cols, m: Float32Array.from(m.m), offset: Float32Array.from(m.offset) } : null };
}

/** Linear lookup that extrapolates from the end segments (HDR floats stay usable). */
function table(t: Float32Array, x: number): number {
  const n = t.length - 1;
  const p = x * n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(p)));
  const f = p - i;
  return t[i] + (t[i + 1] - t[i]) * f;
}

function deviceWhite(cs: ColorSpace): number[] | null {
  switch (cs) {
    case 'rgb':
      return [1, 1, 1];
    case 'gray':
      return [1];
    case 'cmyk':
      return [0, 0, 0, 0];
    case 'cmy':
      return [0, 0, 0];
    case 'lab':
      return [1, 0.5, 0.5];
    default:
      return null;
  }
}

/** A colour transform from one profile's device space to another's. Build once, apply often. */
export class Transform {
  readonly inputs: number;
  readonly outputs: number;
  private core: Core;
  private post: Float32Array[] | null = null;
  private readonly mid = new Float32Array(16);
  private readonly tmp = new Float32Array(16);
  private readonly inp = new Float32Array(16);

  constructor(
    readonly pipeline: Pipeline,
    readonly options: TransformOptions
  ) {
    pipeline.optimize();
    this.inputs = pipeline.inputs;
    this.outputs = pipeline.outputs;
    const head = pipeline.stages.slice();
    const last = head[head.length - 1];
    // Trailing inverse curves become accurate output tables.
    if (last?.kind === 'inv-curves' && last.curves.length === this.outputs) {
      this.post = last.curves.map((c) => {
        const t = new Float32Array(OUT_TABLE);
        for (let i = 0; i < OUT_TABLE; i++) {
          const u = i / (OUT_TABLE - 1);
          t[i] = Math.min(1, Math.max(0, evalCurveInverse(c, u * u * u * u)));
        }
        return t;
      });
      head.pop();
      if (head[head.length - 1]?.kind === 'clamp01') head.pop();
    }
    const headPipe = new Pipeline(this.inputs, head);
    const mid = headPipe.outputs;
    const hasClut = head.some((s) => s.kind === 'clut');
    const [h0, h1] = head;
    if (head.length === 0) this.core = shaper([], null);
    else if (head.length === 1 && h0.kind === 'curves' && h0.curves.length === this.inputs) this.core = shaper(h0.curves, null);
    else if (head.length === 1 && h0.kind === 'matrix') this.core = shaper([], h0);
    else if (head.length === 2 && h0.kind === 'curves' && h0.curves.length === this.inputs && h1.kind === 'matrix') this.core = shaper(h0.curves, h1);
    else if (!hasClut) this.core = { kind: 'exact' };
    else {
      const sample = (grid: number[]) => Clut.sample(grid, mid, (i, o) => headPipe.eval(i, o));
      switch (this.inputs) {
        case 1:
          this.core = { kind: 'grid', clut: sample([TABLE_1D]) };
          break;
        case 2:
          this.core = { kind: 'grid', clut: sample([GRID_3D, GRID_3D]) };
          break;
        case 3:
          this.core = { kind: 'grid', clut: sample([GRID_3D, GRID_3D, GRID_3D]) };
          break;
        case 4:
          this.core = { kind: 'grid', clut: sample([GRID_4D, GRID_4D, GRID_4D, GRID_4D]) };
          break;
        default:
          this.core = { kind: 'exact' };
      }
    }
  }

  /** From `src` to `dst` with `intent` (and black point compensation). */
  static create(src: Profile, dst: Profile, options: Partial<TransformOptions> = {}): Transform {
    const opts = { ...DEFAULT_TRANSFORM_OPTIONS, ...options };
    const t = new Transform(new Pipeline(profileChannels(src), linkStages(src, dst, opts.intent, opts.bpc)), opts);
    if (opts.intent !== 'absolute') t.fixWhite(src.colorSpace, dst.colorSpace);
    return t;
  }

  /**
   * Soft proof `src → proof → dst` (View › Proof Setup): `intent` / `bpc` apply to the
   * document → proof step; proof → display is relative colorimetric with BPC, or absolute
   * colorimetric without it when `simulatePaper` (paper colour and black ink simulated).
   */
  static proof(src: Profile, proof: Profile, dst: Profile, intent: Intent, bpc: boolean, simulatePaper: boolean): Transform {
    const stages = linkStages(src, proof, intent, bpc);
    stages.push({ kind: 'clamp01' });
    stages.push(...(simulatePaper ? linkStages(proof, dst, 'absolute', false) : linkStages(proof, dst, 'relative', true)));
    return new Transform(new Pipeline(profileChannels(src), stages), { intent, bpc, preciseFloat: true });
  }

  /** The device-link node at the source's device white gets exactly the destination's white. */
  private fixWhite(src: ColorSpace, dst: ColorSpace): void {
    const sw = deviceWhite(src);
    let dw = deviceWhite(dst);
    if (!sw || !dw) return;
    if (this.post) {
      if (dst !== 'rgb' && dst !== 'gray') return;
      dw = dw.map(() => 1);
    }
    if (this.core.kind !== 'grid') return;
    const c = this.core.clut;
    if (c.inputs !== sw.length || c.outputs !== dw.length) return;
    let off = 0;
    let stride = c.outputs;
    for (let d = c.inputs - 1; d >= 0; d--) {
      const n = c.grid[d];
      const pos = sw[d] * (n - 1);
      if (Math.abs(pos - Math.round(pos)) > 1e-6) return;
      off += Math.round(pos) * stride;
      stride *= n;
    }
    for (let k = 0; k < c.outputs; k++) c.data[off + k] = dw[k];
  }

  /** Exact evaluation of one colour. */
  eval(input: ArrayLike<number>, out: Float32Array | number[]): void {
    this.pipeline.eval(input, out);
  }

  /** Table evaluation of one colour (what integer buffers use). */
  evalFast(input: ArrayLike<number>, out: Float32Array | number[]): void {
    const mid = this.mid;
    const core = this.core;
    if (core.kind === 'exact') {
      this.pipeline.eval(input, out);
      return;
    }
    if (core.kind === 'grid') {
      for (let d = 0; d < this.inputs; d++) this.inp[d] = Math.min(1, Math.max(0, input[d]));
      core.clut.eval(this.inp, mid);
    } else {
      const v = this.tmp;
      for (let k = 0; k < this.inputs; k++) v[k] = core.curves.length ? table(core.curves[k], input[k]) : input[k];
      applyMatrix(core.matrix, v, mid, this.inputs);
    }
    this.finish(mid, out);
  }

  private finish(mid: Float32Array, out: Float32Array | number[] | Uint8ClampedArray): void {
    const post = this.post;
    if (!post) {
      for (let k = 0; k < this.outputs; k++) out[k] = mid[k];
      return;
    }
    for (let k = 0; k < this.outputs; k++) {
      const t = post[k];
      const x = mid[k];
      const u = Math.sqrt(Math.sqrt(x < 0 ? 0 : x > 1 ? 1 : x)) * (OUT_TABLE - 1);
      const i = Math.min(OUT_TABLE - 2, Math.floor(u));
      out[k] = t[i] + (t[i + 1] - t[i]) * (u - i);
    }
  }

  /**
   * Converts 8-bit interleaved pixels: `src` has `srcStride` samples per pixel (colour first),
   * `dst` `dstStride`. With `copyExtra`, trailing channels (alpha) are copied.
   */
  convert8(src: ArrayLike<number>, srcStride: number, dst: Uint8Array | Uint8ClampedArray, dstStride: number, copyExtra = true): void {
    this.check(srcStride, dstStride);
    const extra = copyExtra ? Math.min(srcStride - this.inputs, dstStride - this.outputs) : 0;
    const n = Math.min(Math.floor(src.length / srcStride), Math.floor(dst.length / dstStride));
    const out = new Float32Array(16);
    const mid = this.mid;
    const core = this.core;
    const q = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);
    for (let p = 0; p < n; p++) {
      const s = p * srcStride;
      const d = p * dstStride;
      if (core.kind === 'shaper') {
        const v = this.tmp;
        for (let k = 0; k < this.inputs; k++) v[k] = core.curves8.length ? core.curves8[k][src[s + k]] : src[s + k] / 255;
        applyMatrix(core.matrix, v, mid, this.inputs);
        this.finish(mid, out);
      } else {
        for (let k = 0; k < this.inputs; k++) this.inp[k] = src[s + k] / 255;
        this.evalFast(this.inp, out);
      }
      for (let k = 0; k < this.outputs; k++) dst[d + k] = q(out[k]);
      for (let e = 0; e < extra; e++) dst[d + this.outputs + e] = src[s + this.inputs + e];
    }
  }

  /** Converts 16-bit interleaved pixels (see `convert8`). */
  convert16(src: ArrayLike<number>, srcStride: number, dst: Uint16Array, dstStride: number, copyExtra = true): void {
    this.check(srcStride, dstStride);
    const extra = copyExtra ? Math.min(srcStride - this.inputs, dstStride - this.outputs) : 0;
    const n = Math.min(Math.floor(src.length / srcStride), Math.floor(dst.length / dstStride));
    const out = new Float32Array(16);
    for (let p = 0; p < n; p++) {
      const s = p * srcStride;
      const d = p * dstStride;
      for (let k = 0; k < this.inputs; k++) this.inp[k] = src[s + k] / 65535;
      this.evalFast(this.inp, out);
      for (let k = 0; k < this.outputs; k++) dst[d + k] = Math.round(Math.min(1, Math.max(0, out[k])) * 65535);
      for (let e = 0; e < extra; e++) dst[d + this.outputs + e] = src[s + this.inputs + e];
    }
  }

  /** Converts float interleaved pixels (exact unless `preciseFloat` is off). */
  convertFloat(src: ArrayLike<number>, srcStride: number, dst: Float32Array, dstStride: number, copyExtra = true): void {
    this.check(srcStride, dstStride);
    const extra = copyExtra ? Math.min(srcStride - this.inputs, dstStride - this.outputs) : 0;
    const n = Math.min(Math.floor(src.length / srcStride), Math.floor(dst.length / dstStride));
    const precise = this.options.preciseFloat || this.core.kind === 'exact';
    const out = new Float32Array(16);
    for (let p = 0; p < n; p++) {
      const s = p * srcStride;
      const d = p * dstStride;
      for (let k = 0; k < this.inputs; k++) this.inp[k] = src[s + k];
      if (precise) this.pipeline.eval(this.inp, out);
      else this.evalFast(this.inp, out);
      for (let k = 0; k < this.outputs; k++) dst[d + k] = out[k];
      for (let e = 0; e < extra; e++) dst[d + this.outputs + e] = src[s + this.inputs + e];
    }
  }

  private check(ss: number, ds: number): void {
    if (ss < this.inputs || ds < this.outputs) throw new RangeError(`pixel stride smaller than the channel count (${this.inputs} → ${this.outputs})`);
  }
}

function applyMatrix(m: Extract<Core, { kind: 'shaper' }>['matrix'], v: Float32Array, out: Float32Array, n: number): void {
  if (!m) {
    for (let k = 0; k < n; k++) out[k] = v[k];
    return;
  }
  for (let r = 0; r < m.rows; r++) {
    let s = m.offset[r];
    for (let c = 0; c < m.cols; c++) s += m.m[r * m.cols + c] * v[c];
    out[r] = s;
  }
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/** Stages from `src` device values to `dst` device values. */
export function linkStages(src: Profile, dst: Profile, intent: Intent, bpc: boolean): Stage[] {
  for (const p of [src, dst]) {
    // A Lab DeviceLink stands in for an abstract profile only when it ends in Lab too.
    const labToLab = p.colorSpace === 'lab' && p.a2b.every((l) => !l || l.outputs === 3) && p.b2a.every((l) => !l || l.inputs === 3);
    if ((p.profileClass === 'link' || p.profileClass === 'named' || p.profileClass === 'abstract') && !labToLab) {
      throw new CmsError(`${p.profileClass} profiles cannot be used as a source or destination`);
    }
  }
  const s = deviceToPcs(src, intent);
  const d = pcsToDevice(dst, intent);
  const stages = s.stages.slice();
  const adjust = connection(src, dst, intent, bpc);
  if (adjust) {
    if (s.pcs === 'lab') stages.push({ kind: 'lab-to-xyz' });
    stages.push({ kind: 'matrix', rows: 3, cols: 3, m: [adjust.scale[0], 0, 0, 0, adjust.scale[1], 0, 0, 0, adjust.scale[2]], offset: adjust.offset });
    if (d.pcs === 'lab') stages.push({ kind: 'xyz-to-lab' });
  } else if (s.pcs === 'lab' && d.pcs === 'xyz') stages.push({ kind: 'lab-to-xyz' });
  else if (s.pcs === 'xyz' && d.pcs === 'lab') stages.push({ kind: 'xyz-to-lab' });
  stages.push(...d.stages);
  return stages;
}

/** Per-component XYZ scale and offset in the PCS (absolute media-white scaling or BPC), or null. */
function connection(src: Profile, dst: Profile, intent: Intent, bpc: boolean): { scale: number[]; offset: number[] } | null {
  if (intent === 'absolute') {
    const ws = mediaWhite(src);
    const wd = mediaWhite(dst);
    const usable = (w: number[]) => w.every((v) => Number.isFinite(v) && v > 0);
    if (!usable(ws) || !usable(wd)) throw new CmsError('absolute colorimetric needs a positive media white point in both profiles');
    const s = [ws[0] / wd[0], ws[1] / wd[1], ws[2] / wd[2]];
    if (s.every((v) => Math.abs(v - 1) < 1e-6)) return null;
    return { scale: s, offset: [0, 0, 0] };
  }
  if (!bpc) return null;
  const bs = blackPoint(src, intent);
  const bd = blackPoint(dst, intent);
  if (Math.abs(bs - bd) < 1e-6) return null;
  // Neutral black points mapped linearly in XYZ: source black onto destination black, white fixed.
  const scale = [1, 1, 1];
  const offset = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const s = bs * D50[i];
    const d = bd * D50[i];
    const a = (D50[i] - d) / (D50[i] - s);
    scale[i] = a;
    offset[i] = D50[i] * (1 - a);
  }
  return { scale, offset };
}

/** Luminance (Y, D50-relative) of a profile's black point for `intent`. */
export function blackPoint(p: Profile, intent: Intent): number {
  if (p.colorSpace === 'lab' || p.colorSpace === 'xyz') return 0;
  const lutBased = p.a2b.some(Boolean);
  if (lutBased && p.version[0] >= 4 && (intent === 'perceptual' || intent === 'saturation')) return PERCEPTUAL_BLACK_Y;
  const n = profileChannels(p);
  const pcsY = (st: Stage[], pcs: Pcs, dev: ArrayLike<number>) => {
    const out = new Float32Array(16);
    new Pipeline(n, st.slice()).eval(dev, out);
    const y = pcs === 'xyz' ? out[1] : labToXyz([out[0], 0, 0])[1];
    return Math.min(0.5, Math.max(0, y));
  };
  const to = deviceToPcs(p, intent);
  const additive = p.colorSpace === 'rgb' || p.colorSpace === 'gray';
  if (additive || !lutBased) return pcsY(to.stages, to.pcs, new Array(n).fill(0));
  // Subtractive LUT profile: the darkest colour it reaches.
  const colorimetric: Intent = intent === 'saturation' ? 'saturation' : 'relative';
  try {
    const from = pcsToDevice(p, colorimetric);
    const st: Stage[] = from.pcs === 'xyz' ? [{ kind: 'lab-to-xyz' }, ...from.stages] : from.stages.slice();
    const dev = new Float32Array(16);
    new Pipeline(3, st).eval([0, 0, 0], dev);
    return pcsY(to.stages, to.pcs, dev.subarray(0, n));
  } catch {
    return pcsY(to.stages, to.pcs, new Array(n).fill(1));
  }
}

// ---------------------------------------------------------------------------
// Cache, comparisons, gamut checks, display tables
// ---------------------------------------------------------------------------

const ids = new WeakMap<Profile, number>();
let nextId = 1;
const idOf = (p: Profile) => {
  let id = ids.get(p);
  if (!id) {
    id = nextId++;
    ids.set(p, id);
  }
  return id;
};

const cache = new Map<string, Transform>();

/** A transform from a small cache keyed by the profile objects and the options. */
export function cachedTransform(src: Profile, dst: Profile, options: Partial<TransformOptions> = {}): Transform {
  const opts = { ...DEFAULT_TRANSFORM_OPTIONS, ...options };
  const key = `${idOf(src)}:${idOf(dst)}:${opts.intent}:${opts.bpc}:${opts.preciseFloat}`;
  let t = cache.get(key);
  if (!t) {
    if (cache.size > 64) cache.clear();
    t = Transform.create(src, dst, opts);
    cache.set(key, t);
  }
  return t;
}

/**
 * Whether two profiles describe the same colours: same colour space, and every sample of a
 * device grid lands within ΔE*ab 0.5 through both (relative colorimetric), whatever their
 * encodings (Photoshop's v2 sRGB and a v4 parametric sRGB are the same colours).
 */
export function sameColors(a: Profile, b: Profile, lab: Profile): boolean {
  if (a === b) return true;
  if (a.bytes && b.bytes && a.bytes.length === b.bytes.length && a.bytes.every((v, i) => v === b.bytes![i])) return true;
  const n = profileChannels(a);
  if (a.colorSpace !== b.colorSpace || n === 0 || n > 4) return false;
  let ta: Transform;
  let tb: Transform;
  try {
    ta = Transform.create(a, lab, { intent: 'relative', bpc: false });
    tb = Transform.create(b, lab, { intent: 'relative', bpc: false });
  } catch {
    return false;
  }
  const steps = n <= 3 ? 17 : 9;
  const decode = (o: Float32Array) => [o[0] * 100, o[1] * 255 - 128, o[2] * 255 - 128];
  const input = new Float32Array(4);
  const la = new Float32Array(16);
  const lb = new Float32Array(16);
  const total = Math.pow(steps, n);
  for (let i = 0; i < total; i++) {
    let k = i;
    for (let c = 0; c < n; c++) {
      input[c] = (k % steps) / (steps - 1);
      k = Math.floor(k / steps);
    }
    ta.eval(input, la);
    tb.eval(input, lb);
    if (deltaE76(decode(la), decode(lb)) > 0.5) return false;
  }
  return true;
}

/** Out-of-gamut test (Photoshop's Gamut Warning): ΔE between a colour and its round trip through a proof profile. */
export class GamutCheck {
  private readonly grid: Clut | null;
  private readonly direct: Pipeline;
  private readonly via: Pipeline;

  constructor(
    src: Profile,
    proof: Profile,
    lab: Profile,
    /** ΔE*ab above which a colour is out of gamut (default 4). */
    readonly threshold = 4
  ) {
    const n = profileChannels(src);
    this.direct = new Pipeline(n, linkStages(src, lab, 'relative', false));
    const via = linkStages(src, proof, 'relative', false);
    via.push({ kind: 'clamp01' });
    via.push(...linkStages(proof, lab, 'relative', false));
    this.via = new Pipeline(n, via);
    const a = new Float32Array(16);
    const b = new Float32Array(16);
    const de = (p: ArrayLike<number>, o: Float32Array) => {
      this.direct.eval(p, a);
      this.via.eval(p, b);
      o[0] = Math.hypot((a[0] - b[0]) * 100, (a[1] - b[1]) * 255, (a[2] - b[2]) * 255);
    };
    this.grid = n === 1 ? Clut.sample([256], 1, de) : n === 3 ? Clut.sample([33, 33, 33], 1, de) : n === 4 ? Clut.sample([17, 17, 17, 17], 1, de) : null;
  }

  /** ΔE*ab of a colour (normalised device values). */
  deltaE(px: ArrayLike<number>): number {
    const o = new Float32Array(16);
    if (this.grid) this.grid.eval(px, o);
    else {
      const a = new Float32Array(16);
      const b = new Float32Array(16);
      this.direct.eval(px, a);
      this.via.eval(px, b);
      o[0] = Math.hypot((a[0] - b[0]) * 100, (a[1] - b[1]) * 255, (a[2] - b[2]) * 255);
    }
    return o[0];
  }

  outOfGamut(px: ArrayLike<number>): boolean {
    return this.deltaE(px) > this.threshold;
  }
}

/** A 3D lookup table of an RGB → RGB transform (`size`³ RGB triples, red fastest), for fast display paths. */
export class Lut3d {
  readonly data: Float32Array;

  constructor(
    t: Transform,
    readonly size = 33
  ) {
    if (t.inputs !== 3 || (t.outputs !== 3 && t.outputs !== 1)) throw new RangeError('display LUTs need a 3 → 3 or 3 → 1 transform');
    const n = size;
    this.data = new Float32Array(n * n * n * 3);
    const out = new Float32Array(16);
    const s = n - 1;
    for (let b = 0; b < n; b++) {
      for (let g = 0; g < n; g++) {
        for (let r = 0; r < n; r++) {
          t.eval([r / s, g / s, b / s], out);
          const i = (r + g * n + b * n * n) * 3;
          this.data[i] = out[0];
          this.data[i + 1] = t.outputs === 1 ? out[0] : out[1];
          this.data[i + 2] = t.outputs === 1 ? out[0] : out[2];
        }
      }
    }
  }

  /** Trilinear sample of 0..1 RGB into `out`. */
  sample(r: number, g: number, b: number, out: number[] | Float32Array): void {
    const n = this.size;
    const loc = (v: number): [number, number] => {
      const p = Math.min(1, Math.max(0, v)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(p));
      return [i, p - i];
    };
    const [r0, fr] = loc(r);
    const [g0, fg] = loc(g);
    const [b0, fb] = loc(b);
    const d = this.data;
    const at = (rr: number, gg: number, bb: number, k: number) => d[(rr + gg * n + bb * n * n) * 3 + k];
    for (let k = 0; k < 3; k++) {
      const x00 = at(r0, g0, b0, k) + (at(r0 + 1, g0, b0, k) - at(r0, g0, b0, k)) * fr;
      const x10 = at(r0, g0 + 1, b0, k) + (at(r0 + 1, g0 + 1, b0, k) - at(r0, g0 + 1, b0, k)) * fr;
      const x01 = at(r0, g0, b0 + 1, k) + (at(r0 + 1, g0, b0 + 1, k) - at(r0, g0, b0 + 1, k)) * fr;
      const x11 = at(r0, g0 + 1, b0 + 1, k) + (at(r0 + 1, g0 + 1, b0 + 1, k) - at(r0, g0 + 1, b0 + 1, k)) * fr;
      const y0 = x00 + (x10 - x00) * fg;
      const y1 = x01 + (x11 - x01) * fg;
      out[k] = y0 + (y1 - y0) * fb;
    }
  }

  /** Applies the table to 8-bit RGBA in place (alpha kept), through a per-code 8-bit cache of the lattice. */
  apply8(data: Uint8ClampedArray | Uint8Array): void {
    const o = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      this.sample(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, o);
      data[i] = Math.round(Math.min(1, Math.max(0, o[0])) * 255);
      data[i + 1] = Math.round(Math.min(1, Math.max(0, o[1])) * 255);
      data[i + 2] = Math.round(Math.min(1, Math.max(0, o[2])) * 255);
    }
  }
}
