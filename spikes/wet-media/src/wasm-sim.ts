/** Main-thread side of the wasm SIMD path: shared memory, workers, dabs, readback. */
import {
  CTL_ACTIVE_COUNT, CTL_OVERFLOW, CTL_PARITY, CTL_SLOTS_CAP, CTL_SLOTS_USED, PAPER_ADDR, PARAMS_ADDR,
  P_D, P_P, P_RHO, S, SET_PLANES, SLOT_BYTES,
  type Layout, Views, activate, bytesFor, fillHalo, idx, makeLayout, tilesNearRect,
} from './wasm-layout';
import { TILE, W, type Dab, type WetParams, type WetSim, type WetSnapshot, dabFalloff, packParams, shade } from './model';

let modulePromise: Promise<WebAssembly.Module> | null = null;
function loadModule(): Promise<WebAssembly.Module> {
  modulePromise ??= WebAssembly.compileStreaming(fetch(`${import.meta.env.BASE_URL}step.wasm`));
  return modulePromise;
}

export class WasmSim implements WetSim {
  readonly name: string;
  readonly layout: Layout;
  private mem!: WebAssembly.Memory;
  private v!: Views;
  private workers: Worker[] = [];
  private ctx: CanvasRenderingContext2D | null;
  lastBusyMs: number[] = [];

  private constructor(readonly width: number, readonly height: number, readonly paper: Float32Array,
    private params: WetParams, private flow: Float32Array | null, canvas: HTMLCanvasElement | null, public nWorkers: number) {
    this.name = `wasm×${nWorkers}`;
    this.layout = makeLayout(width, height, !!flow);
    this.ctx = canvas ? canvas.getContext('2d') : null;
  }

  static async create(width: number, height: number, paper: Float32Array, params: WetParams,
    flow: Float32Array | null, canvas: HTMLCanvasElement | null, nWorkers: number, initialSlots = 4): Promise<WasmSim> {
    const sim = new WasmSim(width, height, paper, params, flow, canvas, nWorkers);
    await sim.init(initialSlots);
    return sim;
  }

  private async init(initialSlots: number): Promise<void> {
    const bytes = bytesFor(this.layout, initialSlots);
    this.mem = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536), maximum: 65536, shared: true });
    this.v = new Views(this.mem.buffer);
    this.v.table.fill(-1);
    this.v.ctl[CTL_SLOTS_CAP] = initialSlots;
    this.v.f32.set(packParams(this.params), PARAMS_ADDR >> 2);
    this.v.f32.set(this.paper, PAPER_ADDR >> 2);
    if (this.flow) this.v.f32.set(this.flow, this.layout.flowAddr >> 2);
    const module = await loadModule();
    const ready: Promise<void>[] = [];
    for (let i = 0; i < this.nWorkers; i++) {
      const w = new Worker(new URL('./wasm-worker.ts', import.meta.url), { type: 'module' });
      ready.push(new Promise((res) => {
        w.onmessage = (e) => { if (e.data.type === 'ready') res(); };
      }));
      w.postMessage({ type: 'init', module, memory: this.mem, layout: this.layout, id: i, nWorkers: this.nWorkers });
      this.workers.push(w);
    }
    await Promise.all(ready);
  }

  /** Make sure `extra` more slots fit, growing the shared memory if needed. */
  private reserve(extra: number): void {
    const want = this.v.ctl[CTL_SLOTS_USED] + extra;
    if (want <= this.v.ctl[CTL_SLOTS_CAP]) return;
    const need = bytesFor(this.layout, want);
    const have = this.mem.buffer.byteLength;
    if (need > have) this.mem.grow(Math.ceil((need - have) / 65536));
    this.v = new Views(this.mem.buffer);
    this.v.ctl[CTL_SLOTS_CAP] = want;
  }

  /** Tiles that could be activated during the next batch: the ring around the active set. */
  private ringCount(): number {
    const l = this.layout, v = this.v;
    let ring = 0;
    for (let ty = 0; ty < l.tilesY; ty++) {
      for (let tx = 0; tx < l.tilesX; tx++) {
        if (v.table[ty * l.tilesX + tx] >= 0) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const x = tx + dx, y = ty + dy;
            if (x >= 0 && y >= 0 && x < l.tilesX && y < l.tilesY && v.table[y * l.tilesX + x] >= 0) near = true;
          }
        if (near) ring++;
      }
    }
    return ring;
  }

  /** Apply a per-cell edit to the current set, activating tiles first, then refresh halos. */
  private edit(x0: number, y0: number, x1: number, y1: number, fn: (x: number, y: number) => [number, number] | null): void {
    const l = this.layout;
    const tiles = tilesNearRect(l, x0, y0, x1, y1);
    this.reserve(tiles.length);
    for (const t of tiles) activate(l, this.v, t);
    const set = this.v.ctl[CTL_PARITY];
    const f = this.v.f32;
    const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(this.width - 1, x1), cy1 = Math.min(this.height - 1, y1);
    for (let y = cy0; y <= cy1; y++) {
      for (let x = cx0; x <= cx1; x++) {
        const r = fn(x, y);
        if (!r) continue;
        const [dw, dp] = r;
        const tile = (y >> 8) * l.tilesX + (x >> 8);
        const slot = this.v.table[tile];
        const lx = (x & 255) + 1, ly = (y & 255) + 1;
        const base = idx(l, slot, set * SET_PLANES, lx, ly);
        for (let k = 0; k < 9; k++) f[base + k * S * S] += W[k] * dw;
        f[base + 9 * S * S] += dw;
        f[base + 12 * S * S] += dp;
      }
    }
    // halos of the edited tiles and of their neighbours
    const touched = new Set<number>();
    for (const t of tiles) {
      const tx = t % l.tilesX, ty = (t / l.tilesX) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = tx + dx, y = ty + dy;
          if (x >= 0 && y >= 0 && x < l.tilesX && y < l.tilesY && this.v.table[y * l.tilesX + x] >= 0) touched.add(y * l.tilesX + x);
        }
    }
    for (const t of touched) fillHalo(l, this.v, t, set);
  }

  dab(d: Dab): void {
    this.edit(Math.floor(d.x - d.radius), Math.floor(d.y - d.radius), Math.ceil(d.x + d.radius), Math.ceil(d.y + d.radius), (x, y) => {
      const a = dabFalloff(d, x, y);
      if (a <= 0) return null;
      const dw = d.wetness * a;
      return [dw, d.concentration * dw];
    });
  }

  wash(x0: number, y0: number, x1: number, y1: number, wet: number, conc: number): void {
    this.edit(x0, y0, x1 - 1, y1 - 1, () => [wet, conc * wet]);
  }

  async step(n: number): Promise<void> {
    this.reserve(this.ringCount());
    const nw = this.nWorkers;
    const done = this.workers.slice(0, nw).map((w) => new Promise<number>((res) => {
      w.onmessage = (e) => { if (e.data.type === 'done') res(e.data.busy); };
    }));
    for (let i = 0; i < nw; i++) this.workers[i].postMessage({ type: 'run', steps: n, nWorkers: nw });
    this.lastBusyMs = await Promise.all(done);
    if (this.v.ctl[CTL_OVERFLOW]) throw new Error('wasm: tile slots overflowed during a batch; batch too long');
  }

  activeTiles(): number {
    return this.v.ctl[CTL_ACTIVE_COUNT];
  }

  private readPlane(plane: number, setRel: boolean): Float32Array {
    const l = this.layout, v = this.v;
    const out = new Float32Array(this.width * this.height);
    const set = setRel ? v.ctl[CTL_PARITY] * SET_PLANES : 0;
    for (let t = 0; t < l.tilesX * l.tilesY; t++) {
      const slot = v.table[t];
      if (slot < 0) continue;
      const tx = t % l.tilesX, ty = (t / l.tilesX) | 0;
      for (let y = 0; y < 256; y++) {
        const s0 = idx(l, slot, set + plane, 1, y + 1);
        out.set(v.f32.subarray(s0, s0 + 256), (ty * 256 + y) * this.width + tx * 256);
      }
    }
    return out;
  }

  async snapshot(): Promise<WetSnapshot> {
    return {
      width: this.width, height: this.height,
      rho: this.readPlane(P_RHO, true), p: this.readPlane(P_P, true), d: this.readPlane(P_D, false),
    };
  }

  async present(tx0: number, ty0: number, tx1: number, ty1: number): Promise<void> {
    if (!this.ctx) return;
    const l = this.layout, v = this.v, f = v.f32;
    const set = v.ctl[CTL_PARITY] * SET_PLANES;
    const w = (tx1 - tx0 + 1) * TILE, hh = (ty1 - ty0 + 1) * TILE;
    const img = this.ctx.createImageData(w, hh);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const slot = v.table[ty * l.tilesX + tx];
        for (let y = 0; y < 256; y++) {
          const gy = ty * 256 + y;
          const rowRho = slot >= 0 ? idx(l, slot, set + P_RHO, 1, y + 1) : -1;
          const rowP = slot >= 0 ? idx(l, slot, set + P_P, 1, y + 1) : -1;
          const rowD = slot >= 0 ? idx(l, slot, P_D, 1, y + 1) : -1;
          for (let x = 0; x < 256; x++) {
            const gx = tx * 256 + x;
            const o = ((gy - ty0 * TILE) * w + (gx - tx0 * TILE)) * 4;
            if (slot < 0) shade(this.paper[gy * this.width + gx], 0, 0, 0, img.data, o);
            else shade(this.paper[gy * this.width + gx], f[rowRho + x], f[rowP + x], f[rowD + x], img.data, o);
          }
        }
      }
    }
    this.ctx.putImageData(img, tx0 * TILE, ty0 * TILE);
  }

  /** Wet layer -> RGBA8 raster tiles: shade each tile's interior on the main thread. */
  readTilesRgba8(tiles: number[]): Uint8ClampedArray {
    const l = this.layout, v = this.v, f = v.f32;
    const set = v.ctl[CTL_PARITY] * SET_PLANES;
    const out = new Uint8ClampedArray(tiles.length * TILE * TILE * 4);
    tiles.forEach((t, k) => {
      const slot = v.table[t];
      const tx = t % l.tilesX, ty = (t / l.tilesX) | 0;
      for (let y = 0; y < 256; y++) {
        const r = idx(l, slot, set + P_RHO, 1, y + 1), p = idx(l, slot, set + P_P, 1, y + 1), d = idx(l, slot, P_D, 1, y + 1);
        const prow = (ty * 256 + y) * this.width + tx * 256;
        for (let x = 0; x < 256; x++) shade(this.paper[prow + x], f[r + x], f[p + x], f[d + x], out, ((k * 256 + y) * 256 + x) * 4);
      }
    });
    return out;
  }

  memory(): Record<string, number> {
    const slots = this.v.ctl[CTL_SLOTS_USED];
    const n = this.width * this.height * 4;
    return {
      tileSlots: slots * SLOT_BYTES,
      paperAndFlow: n + (this.flow ? 2 * n : 0),
      wasmMemoryTotal: this.mem.buffer.byteLength,
    };
  }

  destroy(): void {
    for (const w of this.workers) w.terminate();
  }
}
