/**
 * Loading the wet-media WebAssembly kernel and its Web Workers.
 *
 * - The kernel is two small modules (shared memory for workers, ordinary memory for one thread),
 *   embedded base64 in `kernel-wasm.ts`, which is only ever imported dynamically, so bundlers split
 *   it into its own chunk and nothing loads until the first wet stroke.
 * - Workers run from a Blob URL of `wetWorkerMain`'s source: no extra file for the host to serve
 *   and no bundler configuration. They share one `WebAssembly.Memory`, which needs
 *   `SharedArrayBuffer`, which browsers only give cross-origin isolated pages (COOP `same-origin`
 *   plus COEP `require-corp` or `credentialless`). Without it the kernel runs on one thread.
 * - Everything here is optional: without WebAssembly SIMD the TypeScript kernel runs, with the same
 *   results (only slower).
 */

/** What the wet engine can use here, and why not when it cannot. */
export interface WetSupport {
  /** WebAssembly with SIMD. */
  simd: boolean;
  /** `SharedArrayBuffer` and shared wasm memory (cross-origin isolation in browsers). */
  sharedMemory: boolean;
  /** Web Workers. */
  workers: boolean;
  /** Logical cores reported (`navigator.hardwareConcurrency`, 1 when unknown). */
  cores: number;
  /** A sentence for the user when wet paint will run slower than it could, else `null`. */
  message: string | null;
}

let modules: { shared?: Promise<WebAssembly.Module>; single?: Promise<WebAssembly.Module> } = {};

function decode(base64: string): Uint8Array {
  const g = globalThis as { atob?: (s: string) => string; Buffer?: { from(s: string, e: string): Uint8Array } };
  if (g.Buffer) return new Uint8Array(g.Buffer.from(base64, 'base64'));
  const bin = g.atob!(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compiles the kernel (`shared`: the shared-memory variant). Cached; loads the chunk once. */
export function loadWetKernel(shared: boolean): Promise<WebAssembly.Module> {
  const key = shared ? 'shared' : 'single';
  let p = modules[key];
  if (!p) {
    p = import('./kernel-wasm').then((m) => WebAssembly.compile(decode(shared ? m.WET_KERNEL_SHARED : m.WET_KERNEL_SINGLE) as BufferSource));
    p.catch(() => {
      modules = { ...modules, [key]: undefined };
    });
    modules[key] = p;
  }
  return p;
}

/** Whether shared wasm memory can be made here. */
export function canShareMemory(): boolean {
  const g = globalThis as { SharedArrayBuffer?: unknown; crossOriginIsolated?: boolean };
  if (typeof g.SharedArrayBuffer !== 'function') return false;
  if (g.crossOriginIsolated === false) return false;
  try {
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return true;
  } catch {
    return false;
  }
}

let simdCache: boolean | null = null;

/** Whether this runtime validates WebAssembly SIMD (checked against the kernel itself). */
export async function wetSimdSupported(): Promise<boolean> {
  if (simdCache !== null) return simdCache;
  if (typeof WebAssembly === 'undefined') return (simdCache = false);
  try {
    await loadWetKernel(false);
    simdCache = true;
  } catch {
    simdCache = false;
  }
  return simdCache;
}

/** What the wet engine can use (SIMD is only known after `wetSimdSupported`). */
export function wetSupport(simd = simdCache ?? typeof WebAssembly !== 'undefined'): WetSupport {
  const g = globalThis as { Worker?: unknown; navigator?: { hardwareConcurrency?: number } };
  const sharedMemory = canShareMemory();
  const workers = typeof g.Worker === 'function' && typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  const cores = Math.max(1, Math.floor(g.navigator?.hardwareConcurrency ?? 1));
  let message: string | null = null;
  if (!simd) message = 'This browser has no WebAssembly SIMD, so wet paint runs in plain JavaScript: it flows much more slowly (the results are the same).';
  else if (workers && !sharedMemory)
    message =
      'Wet paint runs on one thread because this page is not cross-origin isolated, so it flows more slowly. Serve the page with "Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp" (or "credentialless") to use every core.';
  return { simd, sharedMemory, workers, cores, message };
}

/**
 * The worker's whole program. It is turned into source with `toString()`, so it must not use
 * anything from outside its own body: every constant arrives in the `init` message.
 */
function wetWorkerMain(): void {
  type Exports = {
    step: (base: number, parity: number, prm: number) => number;
    halo: (table: number, slots: number, key: number, perLane: number, tilesX: number, tilesY: number, set: number) => void;
  };
  type Layout = { ctl: number; params: number; table: number; list: number; flags: number; last: number; slots: number; slotBytes: number; perLane: number; tilesX: number; tilesY: number; keys: number };
  const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown): void };
  let exports: Exports | null = null;
  let memory: WebAssembly.Memory | null = null;
  let L: Layout | null = null;
  let id = 0;

  function barrier(ctl: Int32Array, n: number): void {
    const gen = Atomics.load(ctl, 1);
    if (Atomics.add(ctl, 0, 1) === n - 1) {
      Atomics.store(ctl, 0, 0);
      Atomics.add(ctl, 1, 1);
      Atomics.notify(ctl, 1);
    } else {
      while (Atomics.load(ctl, 1) === gen) Atomics.wait(ctl, 1, gen);
    }
  }

  function run(steps: number, n: number): void {
    const ex = exports!;
    const l = L!;
    const buf = memory!.buffer;
    const ctl = new Int32Array(buf, l.ctl, 16);
    const table = new Int32Array(buf, l.table, l.keys);
    const list = new Int32Array(buf, l.list, l.keys);
    const flags = new Uint32Array(buf, l.flags, l.keys);
    const last = new Uint32Array(buf, l.last, l.keys);
    const count = ctl[4];
    let parity = ctl[5];
    for (let s = 0; s < steps; s++) {
      for (;;) {
        const a = Atomics.add(ctl, 2, 1);
        if (a >= count) break;
        const key = list[a];
        const lane = (key / l.perLane) | 0;
        const f = ex.step(l.slots + table[key] * l.slotBytes, parity, l.params + lane * 128);
        flags[key] |= f;
        last[key] = f;
      }
      if (id === 0) Atomics.store(ctl, 3, 0);
      barrier(ctl, n);
      for (;;) {
        const a = Atomics.add(ctl, 3, 1);
        if (a >= count) break;
        ex.halo(l.table, l.slots, list[a], l.perLane, l.tilesX, l.tilesY, 1 - parity);
      }
      if (id === 0) Atomics.store(ctl, 2, 0);
      barrier(ctl, n);
      parity = 1 - parity;
    }
  }

  scope.onmessage = (e: MessageEvent) => {
    const m = e.data as { type: string; module?: WebAssembly.Module; memory?: WebAssembly.Memory; layout?: Layout; id?: number; steps?: number; workers?: number };
    if (m.type === 'init') {
      memory = m.memory!;
      L = m.layout!;
      id = m.id!;
      WebAssembly.instantiate(m.module!, { env: { memory } }).then(
        (inst) => {
          exports = inst.exports as unknown as Exports;
          scope.postMessage({ type: 'ready', id });
        },
        (err: unknown) => scope.postMessage({ type: 'error', id, message: String(err) })
      );
    } else if (m.type === 'layout') {
      L = m.layout!;
    } else if (m.type === 'run') {
      try {
        run(m.steps!, m.workers!);
        scope.postMessage({ type: 'done', id });
      } catch (err) {
        scope.postMessage({ type: 'error', id, message: String(err) });
      }
    }
  };
}

/** The layout numbers a worker needs. */
export interface WetWorkerLayout {
  ctl: number;
  params: number;
  table: number;
  list: number;
  flags: number;
  last: number;
  slots: number;
  slotBytes: number;
  perLane: number;
  tilesX: number;
  tilesY: number;
  keys: number;
}

/** A pool of workers stepping one shared memory together. */
export class WetWorkerPool {
  private constructor(
    private readonly workers: Worker[],
    private readonly url: string
  ) {}

  get size(): number {
    return this.workers.length;
  }

  /** Starts `count` workers on `memory` (shared) with the shared kernel. Rejects if any fails. */
  static async create(count: number, module: WebAssembly.Module, memory: WebAssembly.Memory, layout: WetWorkerLayout): Promise<WetWorkerPool> {
    const source = `(${wetWorkerMain.toString()})();`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const workers: Worker[] = [];
    try {
      const ready: Promise<void>[] = [];
      for (let i = 0; i < count; i++) {
        const w = new Worker(url);
        workers.push(w);
        ready.push(
          new Promise<void>((resolve, reject) => {
            w.onmessage = (e: MessageEvent) => {
              if (e.data?.type === 'ready') resolve();
              else if (e.data?.type === 'error') reject(new Error(e.data.message));
            };
            w.onerror = (e) => reject(new Error(e.message || 'The wet-media worker failed to start.'));
          })
        );
        w.postMessage({ type: 'init', module, memory, layout, id: i });
      }
      await Promise.all(ready);
    } catch (e) {
      for (const w of workers) w.terminate();
      URL.revokeObjectURL(url);
      throw e;
    }
    return new WetWorkerPool(workers, url);
  }

  /** Runs `steps` steps over the active list in shared memory; resolves when every worker is done. */
  run(steps: number): Promise<void> {
    const n = this.workers.length;
    return Promise.all(
      this.workers.map(
        (w, i) =>
          new Promise<void>((resolve, reject) => {
            w.onmessage = (e: MessageEvent) => {
              if (e.data?.type === 'done') resolve();
              else if (e.data?.type === 'error') reject(new Error(e.data.message));
            };
            w.postMessage({ type: 'run', steps, workers: n, id: i });
          })
      )
    ).then(() => undefined);
  }

  destroy(): void {
    for (const w of this.workers) w.terminate();
    URL.revokeObjectURL(this.url);
  }
}
