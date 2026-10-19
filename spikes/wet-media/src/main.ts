/**
 * Benchmark page. Modes (query string):
 *   (none)                    interactive: paint with the mouse
 *   ?mode=bench&impl=gpu|wasm|ts&size=2048&wet=0.5[&workers=12]
 *   ?mode=latency&impl=...&size=...[&busy=0.5]
 *   ?mode=diverge             all implementations, 500 steps, compared with the TS reference
 *   ?mode=scaling&size=2048   wasm steps/s against worker count
 * Results go to window.__result (and to POST /__result when &report=1, for browsers without automation).
 */
import { STRIP } from './active';
import { GpuSim } from './gpu-sim';
import {
  TILE, defaultParams, dryToRgba8, makeFlowMap, makePaper, wetToRgba8,
  type Dab, type WetParams, type WetSim, type WetSnapshot,
} from './model';
import { TsSim } from './ts-sim';
import { WasmSim } from './wasm-sim';

const q = new URLSearchParams(location.search);
const out = document.getElementById('out')!;
const canvasEl = document.getElementById('c') as HTMLCanvasElement;
const log = (s: string) => {
  out.textContent += s + '\n';
  console.log(s);
};

declare global {
  interface Window {
    __result?: unknown;
    __error?: string;
    __phase?: (name: string) => Promise<void>;
  }
}

const defaultWorkers = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 14));

async function makeSim(impl: string, size: number, opts: { canvas?: HTMLCanvasElement | null; flow?: boolean; params?: WetParams; workers?: number } = {}): Promise<WetSim> {
  const paper = makePaper(size, size);
  const flow = opts.flow ? makeFlowMap(size, size) : null;
  const params = opts.params ?? defaultParams;
  const canvas = opts.canvas === undefined ? freshCanvas(size, impl) : opts.canvas;
  if (impl === 'ts') return new TsSim(size, size, paper, params, flow, canvas);
  if (impl === 'wasm') return WasmSim.create(size, size, paper, params, flow, canvas, opts.workers ?? defaultWorkers);
  if (impl === 'gpu') return GpuSim.create(size, size, paper, params, flow, canvas);
  throw new Error(`unknown impl ${impl}`);
}

function freshCanvas(size: number, impl: string): HTMLCanvasElement {
  // A WebGPU and a 2D context can't share a canvas, so each sim gets its own element.
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  c.className = 'sim';
  c.dataset.impl = impl;
  canvasEl.replaceWith(c);
  c.id = 'c';
  return c;
}

/** Tile-aligned block covering about `frac` of the tiles; washed with an inset so no neighbour activates. */
function wetBlock(size: number, frac: number) {
  const tiles = size / TILE;
  const k = Math.max(1, frac * tiles * tiles);
  let bw: number, bh: number;
  if (k >= tiles * 2) {
    bw = tiles;
    bh = Math.min(tiles, Math.round(k / tiles));
  } else {
    bh = Math.max(1, Math.round(Math.sqrt(k)));
    bw = Math.min(tiles, Math.max(1, Math.round(k / bh)));
  }
  const inset = STRIP + 16;
  const x1t = bw * TILE, y1t = bh * TILE;
  return {
    tiles: bw * bh,
    x0: 0, y0: 0,
    x1: x1t >= size ? size : x1t - inset,
    y1: y1t >= size ? size : y1t - inset,
  };
}

function setupWash(sim: WetSim, size: number, frac: number): number {
  const b = wetBlock(size, frac);
  sim.wash(b.x0, b.y0, b.x1, b.y1, 0.5, 0.4);
  // stir with dabs on a 128 px grid so velocities are non-trivial
  for (let y = 64; y < b.y1 - 48; y += 128)
    for (let x = 64; x < b.x1 - 48; x += 128) sim.dab({ x, y, radius: 32, wetness: 0.6, concentration: 0.8 });
  return b.tiles;
}

function heapMB(): number | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? m.usedJSHeapSize / 2 ** 20 : null;
}

async function phase(name: string) {
  if (window.__phase) await window.__phase(name);
}

async function bench() {
  const impl = q.get('impl') ?? 'gpu';
  const size = Number(q.get('size') ?? 1024);
  const frac = Number(q.get('wet') ?? 0.5);
  const workers = q.has('workers') ? Number(q.get('workers')) : undefined;
  const budgetMs = Number(q.get('budget') ?? 4000);
  const sim = await makeSim(impl, size, { workers });
  const blockTiles = setupWash(sim, size, frac);
  // warm-up: JIT, pipeline creation, page faults of fresh memory
  const tw = performance.now();
  await sim.step(impl === 'ts' && size >= 4096 ? 1 : 8);
  const warmMs = performance.now() - tw;
  const active = sim.activeTiles();
  await phase('measure');
  const batches: number[] = [];
  let steps = 0;
  const t0 = performance.now();
  // size batches to ~250 ms so per-batch overhead (submit, worker wake-up) is amortised but visible
  let batch = 1;
  while (performance.now() - t0 < budgetMs || batches.length < 3) {
    const tb = performance.now();
    await sim.step(batch);
    const dt = performance.now() - tb;
    batches.push(dt / batch);
    steps += batch;
    batch = Math.max(1, Math.min(256, Math.round((250 / Math.max(dt / batch, 0.01)))));
    if (batches.length >= 3 && performance.now() - t0 > budgetMs * 3) break;
  }
  const total = performance.now() - t0;
  await phase('idle');
  const sorted = batches.slice(1).sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1] : batches[0];
  const res = {
    impl: sim.name, size, wetTarget: frac, blockTiles, activeTiles: active, totalTiles: (size / TILE) ** 2,
    steps, totalMs: total, msPerStep: median, stepsPerSec: 1000 / median, warmMs,
    memory: sim.memory(), jsHeapMB: heapMB(),
    gpu: sim instanceof GpuSim ? sim.info : undefined,
    workerBusyMs: sim instanceof WasmSim ? sim.lastBusyMs : undefined,
  };
  sim.destroy();
  return res;
}

async function latency() {
  const impl = q.get('impl') ?? 'gpu';
  const size = Number(q.get('size') ?? 1024);
  const busy = Number(q.get('busy') ?? 0);
  const sim = await makeSim(impl, size);
  if (busy > 0) {
    setupWash(sim, size, busy);
    await sim.step(2);
  }
  const samples: number[] = [];
  // dabs in the dry half of the canvas (bottom-right), each on fresh paper, so tiles get activated
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 9; i++) pts.push([size * (0.55 + 0.4 * ((i % 3) / 2)), size * (0.55 + 0.4 * (Math.floor(i / 3) / 2))]);
  for (const [x, y] of pts) {
    const dab: Dab = { x: Math.round(x), y: Math.round(y), radius: 32, wetness: 1, concentration: 0.8 };
    await new Promise((r) => requestAnimationFrame(r));
    const t0 = performance.now();
    sim.dab(dab);
    await sim.step(1);
    const tx0 = Math.floor((dab.x - 32) / TILE), ty0 = Math.floor((dab.y - 32) / TILE);
    const tx1 = Math.floor((dab.x + 32) / TILE), ty1 = Math.floor((dab.y + 32) / TILE);
    await sim.present(tx0, ty0, tx1, ty1);
    const t1 = performance.now();
    samples.push(t1 - t0);
  }
  const warm = samples.slice(1).sort((a, b) => a - b);
  const res = { impl: sim.name, size, busy, activeTiles: sim.activeTiles(), firstMs: samples[0], medianMs: warm[warm.length >> 1], maxMs: Math.max(...warm), samples };
  sim.destroy();
  return res;
}

function hash(a: Uint8ClampedArray | Float32Array): string {
  const u = new Uint32Array(a.buffer, a.byteOffset, Math.floor(a.byteLength / 4));
  let h = 2166136261;
  for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

function compare(ref: WetSnapshot, s: WetSnapshot, paper: Float32Array) {
  const stat = (a: Float32Array, b: Float32Array) => {
    let max = 0, sq = 0, refSq = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (!(d <= max)) max = d; // NaN-safe
      sq += d * d;
      refSq += a[i] * a[i];
    }
    return { maxAbs: max, rms: Math.sqrt(sq / a.length), relRms: Math.sqrt(sq / Math.max(refSq, 1e-30)) };
  };
  const px = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let max = 0, over1 = 0, any = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > max) max = d;
      if (d > 1) over1++;
      if (d > 0) any++;
    }
    const n = a.length / 4;
    return { maxChannelDiff: max, fracPixelsDiffer: any / n, fracPixelsOver1: over1 / n };
  };
  return {
    rho: stat(ref.rho, s.rho), p: stat(ref.p, s.p), d: stat(ref.d, s.d),
    wetRgba8: px(wetToRgba8(ref, paper), wetToRgba8(s, paper)),
    dryRgba8: px(dryToRgba8(ref, paper), dryToRgba8(s, paper)),
  };
}

function totals(s: WetSnapshot) {
  let w = 0, p = 0, d = 0;
  for (let i = 0; i < s.rho.length; i++) {
    w += s.rho[i];
    p += s.p[i];
    d += s.d[i];
  }
  return { water: w, suspended: p, deposited: d, pigment: p + d };
}

async function diverge() {
  const size = Number(q.get('size') ?? 512);
  const steps = Number(q.get('steps') ?? 500);
  const every = 100;
  const params: WetParams = { ...defaultParams, tiltX: 1e-5, tiltY: 3e-5, flowStrength: 1 };
  const paper = makePaper(size, size);
  const dabsAt = new Map<number, Dab[]>([
    [0, [
      { x: 180, y: 200, radius: 32, wetness: 1, concentration: 0.8 },
      { x: 230, y: 230, radius: 32, wetness: 1, concentration: 0.5 },
      { x: 256, y: 256, radius: 32, wetness: 1.2, concentration: 0.3 }, // on the tile corner
      { x: 300, y: 170, radius: 48, wetness: 0.8, concentration: 1 },
    ]],
    [150, [{ x: 240, y: 300, radius: 32, wetness: 1, concentration: 0 }]], // clear water re-wets: pickup
    [300, [{ x: 330, y: 250, radius: 32, wetness: 1, concentration: 0.6 }]],
  ]);
  const runs: Array<{ impl: string; workers?: number }> = [
    { impl: 'ts' }, { impl: 'wasm', workers: defaultWorkers }, { impl: 'wasm', workers: 1 }, { impl: 'gpu' }, { impl: 'gpu' },
  ];
  const snaps: WetSnapshot[][] = [];
  const meta: unknown[] = [];
  for (const r of runs) {
    const sim = await makeSim(r.impl, size, { flow: true, params, workers: r.workers, canvas: null });
    const list: WetSnapshot[] = [];
    const t0 = performance.now();
    for (let s = 0; s <= steps; s++) {
      for (const d of dabsAt.get(s) ?? []) sim.dab(d);
      if (s % every === 0) list.push(await sim.snapshot());
      if (s < steps) await sim.step(1);
    }
    meta.push({ impl: sim.name, ms: performance.now() - t0, activeTiles: sim.activeTiles(), totalsAtEnd: totals(list[list.length - 1]), totalsAtStart: totals(list[0]) });
    snaps.push(list);
    sim.destroy();
    log(`diverge: ${sim.name} done`);
  }
  const ref = snaps[0];
  const cmp = runs.slice(1).map((r, k) => ({
    impl: (meta[k + 1] as { impl: string }).impl,
    byStep: ref.map((rs, j) => ({ step: j * every, ...compare(rs, snaps[k + 1][j], paper) })),
  }));
  const last = ref.length - 1;
  const dryHash = snaps.map((l, k) => ({ impl: (meta[k] as { impl: string }).impl, dryBake: hash(dryToRgba8(l[last], paper)), state: hash(l[last].d) + hash(l[last].p) + hash(l[last].rho) }));
  // dry-bake determinism: same snapshot baked twice
  const again = hash(dryToRgba8(ref[last], paper)) === dryHash[0].dryBake;
  const images: Record<string, string> = {};
  for (const j of [1, 3, ref.length - 1]) images[`ts-wet-step${j * every}`] = await png(wetToRgba8(ref[j], paper), size);
  images[`ts-dry-step${last * every}`] = await png(dryToRgba8(ref[last], paper), size);
  images[`gpu-dry-step${last * every}`] = await png(dryToRgba8(snaps[3][last], paper), size);
  return { size, steps, meta, cmp, dryHash, bakeRepeatable: again, conservation: await conservation(), images };
}

async function png(rgba: Uint8ClampedArray, size: number): Promise<string> {
  const c = new OffscreenCanvas(size, size);
  c.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
  const b = await c.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(s);
}

/** With evaporation and absorption off, water and pigment must be conserved by every implementation. */
async function conservation() {
  const params: WetParams = { ...defaultParams, evaporation: 0, paperAbsorption: 0, tiltY: 5e-5 };
  const out = [];
  for (const impl of ['ts', 'wasm', 'gpu']) {
    const sim = await makeSim(impl, 512, { params, canvas: null });
    sim.dab({ x: 200, y: 200, radius: 40, wetness: 1, concentration: 0.8 });
    sim.dab({ x: 260, y: 250, radius: 40, wetness: 1, concentration: 0.4 });
    const a = totals(await sim.snapshot());
    await sim.step(300);
    const b = totals(await sim.snapshot());
    out.push({ impl: sim.name, waterDrift: (b.water - a.water) / a.water, pigmentDrift: (b.pigment - a.pigment) / a.pigment });
    sim.destroy();
  }
  return out;
}

async function scaling() {
  const size = Number(q.get('size') ?? 2048);
  const frac = Number(q.get('wet') ?? 1);
  const res = [];
  for (const w of [1, 2, 4, 6, 8, 10, 12, 14]) {
    if (w > (navigator.hardwareConcurrency || 4)) break;
    const sim = await makeSim('wasm', size, { workers: w, canvas: null });
    setupWash(sim, size, frac);
    await sim.step(4);
    const t0 = performance.now();
    let n = 0;
    while (performance.now() - t0 < 2000) {
      await sim.step(4);
      n += 4;
    }
    const ms = (performance.now() - t0) / n;
    res.push({ workers: w, msPerStep: ms, stepsPerSec: 1000 / ms });
    log(`scaling ${w}: ${ms.toFixed(2)} ms/step`);
    sim.destroy();
  }
  // single-thread TS for the same config, few steps
  const ts = await makeSim('ts', size, { canvas: null });
  setupWash(ts, size, frac);
  await ts.step(1);
  const t0 = performance.now();
  await ts.step(3);
  res.push({ workers: 'ts', msPerStep: (performance.now() - t0) / 3, stepsPerSec: 3000 / (performance.now() - t0) });
  return { size, wet: frac, hardwareConcurrency: navigator.hardwareConcurrency, res };
}

/** Cost of turning the wet layer into RGBA8 raster tiles on the CPU (what the shared compositor needs). */
async function readback() {
  const size = Number(q.get('size') ?? 2048);
  const res = [];
  for (const impl of ['gpu', 'wasm']) {
    const sim = await makeSim(impl, size, { canvas: null });
    setupWash(sim, size, 1);
    await sim.step(4);
    const all = Array.from({ length: (size / TILE) ** 2 }, (_, i) => i);
    for (const k of [1, 4, 16, 64]) {
      if (k > all.length) break;
      const tiles = all.slice(0, k);
      const times: number[] = [];
      for (let r = 0; r < 7; r++) {
        const t0 = performance.now();
        if (sim instanceof GpuSim) await sim.readTilesRgba8(tiles);
        else (sim as WasmSim).readTilesRgba8(tiles);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      res.push({ impl: sim.name, tiles: k, medianMs: times[3], mbPerFrame: (k * 256 * 256 * 4) / 2 ** 20 });
    }
    sim.destroy();
  }
  return { size, res };
}

async function interactive() {
  const impl = q.get('impl') ?? (navigator.gpu ? 'gpu' : 'wasm');
  const size = Number(q.get('size') ?? 1024);
  const perFrame = Number(q.get('spf') ?? 4);
  const sim = await makeSim(impl, size);
  log(`interactive: ${sim.name} ${size}² — drag to paint; ${perFrame} steps per frame`);
  const c = document.getElementById('c') as HTMLCanvasElement;
  let down = false;
  const dabAt = (e: PointerEvent) => {
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * size, y = ((e.clientY - r.top) / r.height) * size;
    sim.dab({ x, y, radius: 24, wetness: 0.8, concentration: e.shiftKey ? 0 : 0.7 });
  };
  c.addEventListener('pointerdown', (e) => { down = true; dabAt(e); });
  window.addEventListener('pointerup', () => { down = false; });
  c.addEventListener('pointermove', (e) => { if (down) dabAt(e); });
  const fps = document.createElement('div');
  document.body.append(fps);
  let last = performance.now();
  for (;;) {
    await new Promise((r) => requestAnimationFrame(r));
    await sim.step(perFrame);
    await sim.present(0, 0, size / TILE - 1, size / TILE - 1);
    const now = performance.now();
    fps.textContent = `${(1000 / (now - last)).toFixed(0)} fps, ${sim.activeTiles()} active tiles`;
    last = now;
  }
}

async function main() {
  const mode = q.get('mode');
  log(`UA: ${navigator.userAgent}; cores ${navigator.hardwareConcurrency}; crossOriginIsolated ${self.crossOriginIsolated}; webgpu ${!!navigator.gpu}`);
  try {
    let result: unknown;
    if (mode === 'bench') result = await bench();
    else if (mode === 'latency') result = await latency();
    else if (mode === 'diverge') result = await diverge();
    else if (mode === 'scaling') result = await scaling();
    else if (mode === 'readback') result = await readback();
    else return interactive();
    window.__result = result;
    log(JSON.stringify(result, null, 1));
    if (q.get('report')) await fetch('/__result', { method: 'POST', body: JSON.stringify({ ua: navigator.userAgent, query: location.search, result }) });
  } catch (e) {
    window.__error = String((e as Error)?.stack ?? e);
    log(`ERROR ${window.__error}`);
    if (q.get('report')) await fetch('/__result', { method: 'POST', body: JSON.stringify({ ua: navigator.userAgent, query: location.search, error: window.__error }) });
  }
}

main();
