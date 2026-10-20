// Portions ported from photocraft/crates/cms/src/clut.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Multidimensional colour lookup tables (ICC CLUTs): node values normalised to 0..1, evaluated
 * with tetrahedral interpolation for 3 inputs, two tetrahedra lerped along the first input for 4,
 * and multilinear otherwise.
 */

export const MAX_CHANNELS = 15;

export class Clut {
  readonly inputs: number;
  readonly strides: number[];

  constructor(
    readonly grid: number[],
    readonly outputs: number,
    readonly data: Float32Array
  ) {
    const inputs = grid.length;
    if (inputs < 1 || inputs > MAX_CHANNELS || outputs < 1 || outputs > MAX_CHANNELS) throw new RangeError('bad CLUT dimensions');
    this.inputs = inputs;
    this.strides = new Array(inputs).fill(0);
    let s = outputs;
    for (let i = inputs - 1; i >= 0; i--) {
      this.strides[i] = s;
      s *= Math.max(1, grid[i]);
    }
    if (data.length !== s) throw new RangeError(`CLUT data length ${data.length}, expected ${s}`);
  }

  get nodes(): number {
    return this.data.length / this.outputs;
  }

  /** A table sampled from `f` at every node. */
  static sample(grid: number[], outputs: number, f: (input: Float32Array, out: Float32Array) => void): Clut {
    const inputs = grid.length;
    const total = grid.reduce((a, b) => a * b, 1);
    const data = new Float32Array(total * outputs);
    const idx = new Array(inputs).fill(0);
    const inp = new Float32Array(inputs);
    for (let node = 0; node < total; node++) {
      let rem = node;
      for (let d = inputs - 1; d >= 0; d--) {
        idx[d] = rem % grid[d];
        rem = Math.floor(rem / grid[d]);
      }
      for (let d = 0; d < inputs; d++) inp[d] = grid[d] > 1 ? idx[d] / (grid[d] - 1) : 0;
      f(inp, data.subarray(node * outputs, (node + 1) * outputs));
    }
    return new Clut(grid, outputs, data);
  }

  /** Base offset, fraction and stride along input `d` at `v`. */
  locate(d: number, v: number, out: number[], k: number): void {
    const n = this.grid[d];
    if (n < 2) {
      out[k] = 0;
      out[k + 1] = 0;
      out[k + 2] = 0;
      return;
    }
    const p = Math.min(1, Math.max(0, v)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(p));
    out[k] = i * this.strides[d];
    out[k + 1] = p - i;
    out[k + 2] = this.strides[d];
  }

  private readonly loc = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  private readonly lo = new Float32Array(MAX_CHANNELS);
  private readonly hi = new Float32Array(MAX_CHANNELS);

  eval(input: ArrayLike<number>, out: Float32Array | number[]): void {
    const L = this.loc;
    switch (this.inputs) {
      case 1: {
        this.locate(0, input[0], L, 0);
        const [b, r, s] = L;
        for (let k = 0; k < this.outputs; k++) {
          const a = this.data[b + k];
          const c = s > 0 ? this.data[b + s + k] : a;
          out[k] = a + (c - a) * r;
        }
        return;
      }
      case 3:
        this.locate(0, input[0], L, 0);
        this.locate(1, input[1], L, 3);
        this.locate(2, input[2], L, 6);
        this.tetra(L[0] + L[3] + L[6], L[2], L[5], L[8], L[1], L[4], L[7], out);
        return;
      case 4: {
        this.locate(0, input[0], L, 0);
        this.locate(1, input[1], L, 3);
        this.locate(2, input[2], L, 6);
        this.locate(3, input[3], L, 9);
        const base = L[0] + L[3] + L[6] + L[9];
        const r0 = L[1];
        const s0 = L[2];
        this.tetra(base, L[5], L[8], L[11], L[4], L[7], L[10], this.lo);
        if (r0 > 0 && s0 > 0) {
          this.tetra(base + s0, L[5], L[8], L[11], L[4], L[7], L[10], this.hi);
          for (let k = 0; k < this.outputs; k++) out[k] = this.lo[k] + (this.hi[k] - this.lo[k]) * r0;
        } else for (let k = 0; k < this.outputs; k++) out[k] = this.lo[k];
        return;
      }
      default:
        this.evalMultilinear(input, out);
    }
  }

  /** Tetrahedral interpolation in one cube at `base` with strides `sx, sy, sz` and fractions `rx, ry, rz`. */
  tetra(base: number, sx: number, sy: number, sz: number, rx: number, ry: number, rz: number, out: Float32Array | number[]): void {
    const d = this.data;
    let p1: number, p2: number, p3: number, w1: number, w2: number, w3: number;
    const sxy = sx + sy;
    const sall = sxy + sz;
    if (rx >= ry) {
      if (ry >= rz) {
        p1 = sx; p2 = sxy; p3 = sall; w1 = rx; w2 = ry; w3 = rz;
      } else if (rx >= rz) {
        p1 = sx; p2 = sx + sz; p3 = sall; w1 = rx; w2 = rz; w3 = ry;
      } else {
        p1 = sz; p2 = sx + sz; p3 = sall; w1 = rz; w2 = rx; w3 = ry;
      }
    } else if (rx >= rz) {
      p1 = sy; p2 = sxy; p3 = sall; w1 = ry; w2 = rx; w3 = rz;
    } else if (ry >= rz) {
      p1 = sy; p2 = sy + sz; p3 = sall; w1 = ry; w2 = rz; w3 = rx;
    } else {
      p1 = sz; p2 = sy + sz; p3 = sall; w1 = rz; w2 = ry; w3 = rx;
    }
    for (let k = 0; k < this.outputs; k++) {
      const v0 = d[base + k];
      const v1 = d[base + p1 + k];
      const v2 = d[base + p2 + k];
      const v3 = d[base + p3 + k];
      out[k] = v0 + (v1 - v0) * w1 + (v2 - v1) * w2 + (v3 - v2) * w3;
    }
  }

  evalMultilinear(input: ArrayLike<number>, out: Float32Array | number[]): void {
    const n = this.inputs;
    let base = 0;
    const r = new Array(n);
    const s = new Array(n);
    const L = [0, 0, 0];
    for (let d = 0; d < n; d++) {
      this.locate(d, input[d], L, 0);
      base += L[0];
      r[d] = L[1];
      s[d] = L[2];
    }
    const o = this.outputs;
    for (let k = 0; k < o; k++) out[k] = 0;
    for (let corner = 0; corner < 1 << n; corner++) {
      let w = 1;
      let off = base;
      for (let d = 0; d < n; d++) {
        if (corner & (1 << d)) {
          w *= r[d];
          off += s[d];
        } else w *= 1 - r[d];
      }
      if (w === 0) continue;
      for (let k = 0; k < o; k++) out[k] += w * this.data[off + k];
    }
  }
}
