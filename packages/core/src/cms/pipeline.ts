// Portions ported from photocraft/crates/cms/src/pipeline.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Float evaluation pipelines: stages mapping normalised device values to the profile connection
 * space (or back). This is the exact path; `Transform` builds faster tables from it.
 */

import { Clut } from './clut';
import { evalCurve, evalCurveInverse, isIdentityCurve, type Curve } from './curve';
import { D50, type Mat3 } from './math';

/** Largest channel count flowing through a pipeline. */
export const MAX_PIPE = 16;

export type Stage =
  | { kind: 'curves'; curves: Curve[] }
  | { kind: 'inv-curves'; curves: Curve[] }
  /** `out[r] = Σ m[r·cols + c]·in[c] + offset[r]`. */
  | { kind: 'matrix'; rows: number; cols: number; m: number[]; offset: number[] }
  | { kind: 'clut'; clut: Clut }
  /** Float Lab (L 0–100) → XYZ (D50, Y = 1), and back. */
  | { kind: 'lab-to-xyz' }
  | { kind: 'xyz-to-lab' }
  /** ICC v4 / 8-bit Lab encoding (normalised) ↔ float Lab. */
  | { kind: 'decode-lab-v4' }
  | { kind: 'encode-lab-v4' }
  /** ICC v2 legacy 16-bit Lab encoding (`lut16Type`) ↔ float Lab. */
  | { kind: 'decode-lab-v2' }
  | { kind: 'encode-lab-v2' }
  /** u1Fixed15 XYZ encoding ↔ XYZ. */
  | { kind: 'decode-xyz' }
  | { kind: 'encode-xyz' }
  | { kind: 'clamp01' };

const XYZ_SCALE = 65535 / 32768;
const V2_L = (100 * 65535) / 65280;
const V2_AB = (255 * 65535) / 65280;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function matrix3(m: Mat3): Stage {
  return { kind: 'matrix', rows: 3, cols: 3, m: [...m[0], ...m[1], ...m[2]], offset: [0, 0, 0] };
}

/** Output channels of a stage given `n` inputs. */
export function stageOutputs(s: Stage, n: number): number {
  return s.kind === 'matrix' ? s.rows : s.kind === 'clut' ? s.clut.outputs : n;
}

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

function runStage(s: Stage, v: Float64Array, n: number, tmp: Float64Array, tmpIn: Float32Array, tmpOut: Float32Array): number {
  switch (s.kind) {
    case 'curves':
      for (let k = 0; k < s.curves.length; k++) v[k] = evalCurve(s.curves[k], v[k]);
      return n;
    case 'inv-curves':
      for (let k = 0; k < s.curves.length; k++) v[k] = evalCurveInverse(s.curves[k], v[k]);
      return n;
    case 'matrix': {
      for (let r = 0; r < s.rows; r++) {
        let acc = s.offset[r];
        for (let c = 0; c < s.cols; c++) acc += s.m[r * s.cols + c] * v[c];
        tmp[r] = acc;
      }
      for (let r = 0; r < s.rows; r++) v[r] = tmp[r];
      return s.rows;
    }
    case 'clut': {
      const c = s.clut;
      for (let k = 0; k < c.inputs; k++) tmpIn[k] = v[k];
      c.eval(tmpIn, tmpOut);
      for (let k = 0; k < c.outputs; k++) v[k] = tmpOut[k];
      return c.outputs;
    }
    case 'lab-to-xyz': {
      const fy = (v[0] + 16) / 116;
      const fx = fy + v[1] / 500;
      const fz = fy - v[2] / 200;
      const finv = (f: number) => {
        const f3 = f * f * f;
        return f3 > EPS ? f3 : (116 * f - 16) / KAPPA;
      };
      v[0] = finv(fx) * D50[0];
      v[1] = finv(fy) * D50[1];
      v[2] = finv(fz) * D50[2];
      return 3;
    }
    case 'xyz-to-lab': {
      const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
      const fx = f(Math.max(0, v[0]) / D50[0]);
      const fy = f(Math.max(0, v[1]) / D50[1]);
      const fz = f(Math.max(0, v[2]) / D50[2]);
      v[0] = 116 * fy - 16;
      v[1] = 500 * (fx - fy);
      v[2] = 200 * (fy - fz);
      return 3;
    }
    case 'decode-lab-v4':
      v[0] *= 100;
      v[1] = v[1] * 255 - 128;
      v[2] = v[2] * 255 - 128;
      return 3;
    case 'encode-lab-v4':
      v[0] = clamp01(v[0] / 100);
      v[1] = clamp01((v[1] + 128) / 255);
      v[2] = clamp01((v[2] + 128) / 255);
      return 3;
    case 'decode-lab-v2':
      v[0] *= V2_L;
      v[1] = v[1] * V2_AB - 128;
      v[2] = v[2] * V2_AB - 128;
      return 3;
    case 'encode-lab-v2':
      v[0] = clamp01(v[0] / V2_L);
      v[1] = clamp01((v[1] + 128) / V2_AB);
      v[2] = clamp01((v[2] + 128) / V2_AB);
      return 3;
    case 'decode-xyz':
      for (let k = 0; k < 3; k++) v[k] *= XYZ_SCALE;
      return 3;
    case 'encode-xyz':
      for (let k = 0; k < 3; k++) v[k] = clamp01(v[k] / XYZ_SCALE);
      return 3;
    case 'clamp01':
      for (let k = 0; k < n; k++) v[k] = clamp01(v[k]);
      return n;
  }
}

/** A sequence of stages with fixed input and output channel counts. */
export class Pipeline {
  outputs: number;
  private readonly v = new Float64Array(MAX_PIPE);
  private readonly tmp = new Float64Array(MAX_PIPE);
  private readonly tmpIn = new Float32Array(MAX_PIPE);
  private readonly tmpOut = new Float32Array(MAX_PIPE);

  constructor(
    readonly inputs: number,
    public stages: Stage[]
  ) {
    this.outputs = stages.reduce((n, s) => stageOutputs(s, n), inputs);
  }

  extend(stages: Stage[]): void {
    for (const s of stages) {
      this.outputs = stageOutputs(s, this.outputs);
      this.stages.push(s);
    }
  }

  /** Evaluates one colour: `input` has `inputs` values, `out` receives `outputs`. */
  eval(input: ArrayLike<number>, out: Float32Array | Float64Array | number[]): void {
    const v = this.v;
    for (let k = 0; k < this.inputs; k++) v[k] = input[k];
    let n = this.inputs;
    for (const s of this.stages) n = runStage(s, v, n, this.tmp, this.tmpIn, this.tmpOut);
    for (let k = 0; k < this.outputs; k++) out[k] = v[k];
  }

  /** Removes no-op stages, cancels adjacent inverse pairs and merges consecutive 3×3 matrices. */
  optimize(): void {
    const out: Stage[] = [];
    for (const s of this.stages) {
      const noop =
        ((s.kind === 'curves' || s.kind === 'inv-curves') && s.curves.every(isIdentityCurve)) ||
        (s.kind === 'matrix' && s.rows === 3 && s.cols === 3 && s.offset.every((o) => Math.abs(o) < 1e-12) && s.m.every((v, i) => Math.abs(v - (i % 4 === 0 ? 1 : 0)) < 1e-12));
      if (noop) continue;
      const last = out[out.length - 1];
      const pair = last ? `${last.kind}>${s.kind}` : '';
      const cancels = [
        'lab-to-xyz>xyz-to-lab',
        'xyz-to-lab>lab-to-xyz',
        'encode-lab-v4>decode-lab-v4',
        'encode-lab-v2>decode-lab-v2',
        'encode-xyz>decode-xyz',
        'decode-lab-v4>encode-lab-v4',
        'decode-lab-v2>encode-lab-v2',
        'decode-xyz>encode-xyz',
      ].includes(pair);
      if (cancels) {
        out.pop();
        continue;
      }
      if (last && last.kind === 'matrix' && s.kind === 'matrix' && last.rows === 3 && last.cols === 3 && s.rows === 3 && s.cols === 3) {
        const a = last.m;
        const b = s.m;
        const m = new Array(9).fill(0);
        const off = [0, 0, 0];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) m[r * 3 + c] += b[r * 3 + k] * a[k * 3 + c];
          off[r] = b[r * 3] * last.offset[0] + b[r * 3 + 1] * last.offset[1] + b[r * 3 + 2] * last.offset[2] + s.offset[r];
        }
        out.pop();
        out.push({ kind: 'matrix', rows: 3, cols: 3, m, offset: off });
        continue;
      }
      out.push(s);
    }
    this.stages = out;
    this.outputs = out.reduce((n, s) => stageOutputs(s, n), this.inputs);
  }
}
