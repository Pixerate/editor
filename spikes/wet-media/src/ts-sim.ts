/**
 * Reference implementation: plain TypeScript on dense Float32Array planes.
 * This file defines the model; the wasm and WGSL versions are ports of `stepTile`.
 */
import { ActiveSet, edgeBits } from './active';
import {
  DRY_EPS, EX, EY, OPP, TILE, U_MAX, W,
  type Dab, type WetParams, type WetSim, type WetSnapshot,
  dabFalloff, packParams, shade,
} from './model';

export interface DenseState {
  width: number;
  height: number;
  /** 9 planes of post-collision distributions, src and dst. */
  f: [Float32Array, Float32Array];
  /** Macro state written by the previous step: water depth, velocity, suspended pigment. */
  rho: [Float32Array, Float32Array];
  ux: [Float32Array, Float32Array];
  uy: [Float32Array, Float32Array];
  p: [Float32Array, Float32Array];
  /** Deposited pigment and water held in the paper (cell-local, updated in place). */
  d: Float32Array;
  s: Float32Array;
  h: Float32Array;
  /** Optional interleaved vec2 flow map. */
  flow: Float32Array | null;
  cur: 0 | 1;
}

export function createDense(width: number, height: number, paper: Float32Array, flow: Float32Array | null): DenseState {
  const n = width * height;
  const pair = (k = 1): [Float32Array, Float32Array] => [new Float32Array(n * k), new Float32Array(n * k)];
  return {
    width, height, f: pair(9), rho: pair(), ux: pair(), uy: pair(), p: pair(),
    d: new Float32Array(n), s: new Float32Array(n), h: paper, flow, cur: 0,
  };
}

/** Add water and pigment in a disc to the current (src) state. */
export function applyDab(st: DenseState, dab: Dab): void {
  const { width, height } = st;
  const n = width * height;
  const c = st.cur;
  const f = st.f[c], rho = st.rho[c], p = st.p[c];
  const x0 = Math.max(0, Math.floor(dab.x - dab.radius)), x1 = Math.min(width - 1, Math.ceil(dab.x + dab.radius));
  const y0 = Math.max(0, Math.floor(dab.y - dab.radius)), y1 = Math.min(height - 1, Math.ceil(dab.y + dab.radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const a = dabFalloff(dab, x, y);
      if (a <= 0) continue;
      const i = y * width + x;
      const dw = dab.wetness * a;
      for (let k = 0; k < 9; k++) f[k * n + i] += W[k] * dw;
      rho[i] += dw;
      p[i] += dab.concentration * dw;
    }
  }
}

export function applyWash(st: DenseState, x0: number, y0: number, x1: number, y1: number, wet: number, conc: number): void {
  const { width } = st;
  const n = width * st.height;
  const c = st.cur;
  const f = st.f[c], rho = st.rho[c], p = st.p[c];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      for (let k = 0; k < 9; k++) f[k * n + i] += W[k] * wet;
      rho[i] += wet;
      p[i] += conc * wet;
    }
  }
}

/**
 * One step for the cells of one tile. Reads src (`cur`), writes dst. Returns the tile's flag bits.
 *
 * Per cell x:
 *  1. Streaming with partial bounce-back (Chu & Tai): for each direction i, the source cell is
 *     n = x - e_i and the blocking factor is b = max(k(x), k(n)), k = (1 - permeability) * grain.
 *     b = 1 if n is off the canvas, or the front is pinned: one side dry and the other's depth
 *     below the pin threshold (raised by grain roughness). Symmetric in x and n, so mass is
 *     conserved: f_i(x) = (1 - b) f*_i(n) + b f*_opp(i)(x).
 *  2. Moments rho, u; velocity shift by tilt / flow-map acceleration (u += tau g), capped at U_MAX.
 *  3. BGK collision towards the D2Q9 equilibrium.
 *  4. Absorption into the paper (until it holds `capacity`) and evaporation, stronger at the
 *     wet edge; all f scaled by the depth ratio.
 *  5. Pigment: upwind flux through the 4 faces using the previous step's velocities (scaled by
 *     mobility); faces into dry cells or off-canvas carry nothing.
 *  6. Deposition (more in grain valleys: granulation) and pickup; on drying, everything settles.
 */
export function stepTile(st: DenseState, prm: Float32Array, tx: number, ty: number): number {
  const { width, height, h, d, s, flow } = st;
  const n = width * height;
  const c = st.cur, o = (1 - c) as 0 | 1;
  const fs = st.f[c], fd = st.f[o];
  const rs = st.rho[c], rd = st.rho[o];
  const uxs = st.ux[c], uxd = st.ux[o];
  const uys = st.uy[c], uyd = st.uy[o];
  const ps = st.p[c], pd = st.p[o];

  const omega = prm[0], tau = prm[1], evap = prm[2], edgeEvap = prm[3];
  const mobility = prm[4], depRate = prm[5], pickup = prm[6], absorption = prm[7];
  const invCap = prm[8], blockScale = prm[9], rough = prm[10], pinT = prm[11];
  const gx0 = prm[12], gy0 = prm[13], flowK = prm[14];

  const fin = new Float64Array(9);
  let flags = 0;
  const x0 = tx * TILE, y0 = ty * TILE;
  for (let y = y0; y < y0 + TILE; y++) {
    for (let x = x0; x < x0 + TILE; x++) {
      const i = y * width + x;
      const hx = h[i];
      const kx = blockScale * hx;
      const rx = rs[i];
      const pinX = pinT + rough * hx;

      // 1. streaming with partial bounce-back and pinning
      fin[0] = fs[i];
      let dryNb = 0;
      for (let k = 1; k < 9; k++) {
        const nx = x - EX[k], ny = y - EY[k];
        const bounce = fs[OPP[k] * n + i];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          fin[k] = bounce;
          continue;
        }
        const j = ny * width + nx;
        const hn = h[j];
        const rn = rs[j];
        if (rn < DRY_EPS) dryNb++;
        let b = Math.max(kx, blockScale * hn);
        if ((rx < DRY_EPS && rn < pinX) || (rn < DRY_EPS && rx < pinT + rough * hn)) b = 1;
        fin[k] = (1 - b) * fs[k * n + j] + b * bounce;
      }

      // 2. moments + forcing
      let rho = 0, mx = 0, my = 0;
      for (let k = 0; k < 9; k++) {
        rho += fin[k];
        mx += fin[k] * EX[k];
        my += fin[k] * EY[k];
      }
      let ux = 0, uy = 0;
      if (rho > DRY_EPS) {
        let gx = gx0, gy = gy0;
        if (flow) {
          gx += flowK * flow[2 * i];
          gy += flowK * flow[2 * i + 1];
        }
        ux = mx / rho + tau * gx;
        uy = my / rho + tau * gy;
        const sp2 = ux * ux + uy * uy;
        if (sp2 > U_MAX * U_MAX) {
          const sc = U_MAX / Math.sqrt(sp2);
          ux *= sc;
          uy *= sc;
        }
      }

      // 4. absorption + evaporation (computed before collision; applied as a scale on f*)
      const sx = s[i];
      const absorbed = Math.min(rho, absorption * (1 - 0.5 * hx) * rho * Math.max(0, 1 - sx * invCap));
      const ev = rho > 0 ? evap * (1 + edgeEvap * dryNb * 0.125) : 0;
      const rhoNew = Math.max(0, rho - absorbed - ev);
      const scale = rho > 1e-9 ? rhoNew / rho : 0;
      s[i] = Math.max(0, sx + absorbed - (sx > 0 ? evap * 0.5 : 0));

      // 3. collision, then scale
      const usq = 1.5 * (ux * ux + uy * uy);
      for (let k = 0; k < 9; k++) {
        const eu = EX[k] * ux + EY[k] * uy;
        const feq = W[k] * rho * (1 + 3 * eu + 4.5 * eu * eu - usq);
        fd[k * n + i] = (fin[k] + omega * (feq - fin[k])) * scale;
      }

      // 5. pigment upwind advection with last step's velocities
      const pc = ps[i];
      let pNew = pc;
      if (rx >= DRY_EPS) {
        const uxc = uxs[i], uyc = uys[i];
        // east face
        if (x + 1 < width && rs[i + 1] >= DRY_EPS) {
          const uf = 0.5 * mobility * (uxc + uxs[i + 1]);
          pNew -= uf > 0 ? uf * pc : uf * ps[i + 1];
        }
        if (x > 0 && rs[i - 1] >= DRY_EPS) {
          const uf = 0.5 * mobility * (uxs[i - 1] + uxc);
          pNew += uf > 0 ? uf * ps[i - 1] : uf * pc;
        }
        if (y + 1 < height && rs[i + width] >= DRY_EPS) {
          const uf = 0.5 * mobility * (uyc + uys[i + width]);
          pNew -= uf > 0 ? uf * pc : uf * ps[i + width];
        }
        if (y > 0 && rs[i - width] >= DRY_EPS) {
          const uf = 0.5 * mobility * (uys[i - width] + uyc);
          pNew += uf > 0 ? uf * ps[i - width] : uf * pc;
        }
      }

      // 6. deposition and pickup
      const dx = d[i];
      let dep: number, lift: number;
      if (rhoNew < DRY_EPS) {
        dep = pNew;
        lift = 0;
      } else {
        dep = Math.min(pNew, pNew * depRate * (1 + rough * (1 - hx)));
        lift = dx * pickup * Math.min(rhoNew, 1);
      }
      pd[i] = pNew - dep + lift;
      d[i] = dx + dep - lift;
      rd[i] = rhoNew;
      const wet = rhoNew >= DRY_EPS;
      uxd[i] = wet ? ux : 0;
      uyd[i] = wet ? uy : 0;
      if (wet) flags |= edgeBits(x - x0, y - y0);
    }
  }
  return flags;
}

export class TsSim implements WetSim {
  readonly name = 'ts';
  readonly st: DenseState;
  readonly set: ActiveSet;
  private prm: Float32Array;
  private ctx: CanvasRenderingContext2D | null;
  private flags: Uint32Array;

  constructor(readonly width: number, readonly height: number, readonly paper: Float32Array, params: WetParams,
    flow: Float32Array | null, canvas: HTMLCanvasElement | null) {
    this.st = createDense(width, height, paper, flow);
    this.set = new ActiveSet(width, height);
    this.prm = packParams(params);
    this.flags = new Uint32Array(this.set.tilesX * this.set.tilesY);
    this.ctx = canvas ? canvas.getContext('2d') : null;
  }

  dab(d: Dab): void {
    applyDab(this.st, d);
    this.set.markRect(d.x - d.radius, d.y - d.radius, d.x + d.radius, d.y + d.radius);
  }

  wash(x0: number, y0: number, x1: number, y1: number, wet: number, conc: number): void {
    applyWash(this.st, x0, y0, x1, y1, wet, conc);
    this.set.markRect(x0, y0, x1 - 1, y1 - 1);
  }

  stepSync(): void {
    this.flags.fill(0);
    for (const t of this.set.tiles()) {
      const tx = t % this.set.tilesX, ty = (t / this.set.tilesX) | 0;
      this.flags[t] = stepTile(this.st, this.prm, tx, ty);
    }
    this.st.cur = (1 - this.st.cur) as 0 | 1;
    this.set.applyFlags(this.flags);
  }

  async step(n: number): Promise<void> {
    for (let i = 0; i < n; i++) this.stepSync();
  }

  activeTiles(): number {
    return this.set.tiles().length;
  }

  async present(tx0: number, ty0: number, tx1: number, ty1: number): Promise<void> {
    if (!this.ctx) return;
    const c = this.st.cur;
    const w = (tx1 - tx0 + 1) * TILE, hh = (ty1 - ty0 + 1) * TILE;
    const img = this.ctx.createImageData(w, hh);
    const rho = this.st.rho[c], p = this.st.p[c];
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        const i = (ty0 * TILE + y) * this.width + tx0 * TILE + x;
        shade(this.paper[i], rho[i], p[i], this.st.d[i], img.data, (y * w + x) * 4);
      }
    }
    this.ctx.putImageData(img, tx0 * TILE, ty0 * TILE);
  }

  async snapshot(): Promise<WetSnapshot> {
    const c = this.st.cur;
    return { width: this.width, height: this.height, rho: this.st.rho[c].slice(), p: this.st.p[c].slice(), d: this.st.d.slice() };
  }

  memory(): Record<string, number> {
    const n = this.width * this.height * 4;
    return { distributions: n * 18, macro: n * 8, paperAndDeposit: n * 3 + (this.st.flow ? n * 2 : 0) };
  }

  destroy(): void {}
}
