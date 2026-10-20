/**
 * Engine B: the wet-media step and display shading on WebGPU, an accelerator for large wet areas.
 *
 * The CPU engine (`WetWorld`, WebAssembly SIMD) stays the authority: it owns the clock, edits,
 * drying, save, export and replay, and gives the same bits everywhere. This engine mirrors the CPU
 * state on the GPU (same slot layout, uploaded region by region as the CPU edits it), steps it and
 * shades it into RGBA8 tiles for display. Its results stay within about 1/255 of the CPU's but are
 * not bit-identical (shader compilers differ), so nothing it computes is ever saved.
 *
 * DOM-free and dependency-free: it takes a `navigator.gpu`-like object (or finds one) and uses
 * only the WebGPU API. Without one, `createWetGpuEngine` says why and the CPU does everything.
 */

import { GPU_JOB_WORDS, GPU_NONE, WGSL_HALO, WGSL_SHADE, WGSL_STEP } from './gpu-kernels';
import { MAX_WET_LANES, MAX_WET_SLOTS } from './world';
import { PARAM_FLOATS, SET_PLANES, SLOT_BYTES, SLOT_PLANES, PLANE } from './model';

/** Floats per slot. */
const SLOT_FLOATS = SLOT_PLANES * PLANE;
const TILE_WORDS = 256 * 256;

// WebGPU constants (GPUBufferUsage, GPUMapMode), so this runs without the globals.
const MAP_READ = 0x1;
const COPY_SRC = 0x4;
const COPY_DST = 0x8;
const UNIFORM = 0x40;
const STORAGE = 0x80;

/* Just the WebGPU surface this engine uses (the repo has no @webgpu/types). */
interface GBuffer {
  readonly size: number;
  destroy(): void;
  mapAsync(mode: number, offset?: number, size?: number): Promise<void>;
  getMappedRange(offset?: number, size?: number): ArrayBuffer;
  unmap(): void;
}
interface GPass {
  setPipeline(p: unknown): void;
  setBindGroup(i: number, g: unknown): void;
  dispatchWorkgroups(x: number, y?: number, z?: number): void;
  end(): void;
}
interface GEncoder {
  beginComputePass(): GPass;
  copyBufferToBuffer(src: GBuffer, so: number, dst: GBuffer, d: number, size: number): void;
  clearBuffer(b: GBuffer, offset?: number, size?: number): void;
  finish(): unknown;
}
interface GQueue {
  writeBuffer(b: GBuffer, offset: number, data: ArrayBufferView | ArrayBufferLike, dataOffset?: number, size?: number): void;
  submit(cmds: unknown[]): void;
  onSubmittedWorkDone(): Promise<void>;
}
interface GPipeline {
  getBindGroupLayout(i: number): unknown;
}
interface GDevice {
  readonly queue: GQueue;
  readonly limits: Record<string, number>;
  readonly lost?: Promise<{ message?: string; reason?: string }>;
  createBuffer(d: { size: number; usage: number; label?: string }): GBuffer;
  createShaderModule(d: { code: string; label?: string }): unknown;
  createComputePipeline(d: { layout: 'auto'; compute: { module: unknown; entryPoint: string }; label?: string }): GPipeline;
  createComputePipelineAsync?(d: { layout: 'auto'; compute: { module: unknown; entryPoint: string }; label?: string }): Promise<GPipeline>;
  createBindGroup(d: { layout: unknown; entries: { binding: number; resource: { buffer: GBuffer; offset?: number; size?: number } }[] }): unknown;
  createCommandEncoder(): GEncoder;
  pushErrorScope?(filter: string): void;
  popErrorScope?(): Promise<{ message: string } | null>;
  destroy(): void;
}
interface GAdapter {
  readonly limits: Record<string, number>;
  readonly info?: { vendor?: string; architecture?: string; description?: string };
  requestDevice(d?: { requiredLimits?: Record<string, number>; label?: string }): Promise<GDevice>;
}
/** A `navigator.gpu`-like object. */
export interface WetGpuProvider {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<unknown>;
}

/** Whether Engine B can run here, and if not, why. */
export interface WetGpuSupport {
  supported: boolean;
  /** Why not (no WebGPU, no adapter, too little buffer space, the device failed), or `null`. */
  reason: string | null;
  /** The GPU's vendor and architecture, when known. */
  adapter: string | null;
  /** Most wet tiles (256 px, all layers) the GPU can hold. */
  maxSlots: number;
}

/** A tile to step or shade: its slot, lane, the slots of its 8 neighbours, and its size on the canvas. */
export interface WetGpuJob {
  slot: number;
  lane: number;
  /** Neighbour slots in the order n, s, w, e, nw, ne, sw, se; −1 for none. */
  neighbours: readonly number[];
  /** Pixels of the tile on the canvas (256 except at the right and bottom edges). */
  width: number;
  height: number;
}

/** The `navigator.gpu` of this context, if any. */
export function findWebGpu(): WetGpuProvider | null {
  const nav = (globalThis as { navigator?: { gpu?: WetGpuProvider } }).navigator;
  return nav?.gpu ?? null;
}

/**
 * Starts Engine B on `gpu` (default `navigator.gpu`). Resolves with the engine, or `null` and the
 * reason it cannot run (no WebGPU, no adapter, too little storage-buffer space, a failed device).
 */
export async function createWetGpuEngine(gpu: WetGpuProvider | null = findWebGpu()): Promise<{ engine: WetGpuEngine | null; support: WetGpuSupport }> {
  const no = (reason: string, adapter: string | null = null) => ({ engine: null, support: { supported: false, reason, adapter, maxSlots: 0 } });
  if (!gpu || typeof gpu.requestAdapter !== 'function') return no('This browser has no WebGPU (navigator.gpu); wet paint runs on the CPU.');
  let adapter: GAdapter | null;
  try {
    adapter = (await gpu.requestAdapter({ powerPreference: 'high-performance' })) as GAdapter | null;
  } catch (e) {
    return no(`WebGPU gave no adapter (${(e as Error).message}); wet paint runs on the CPU.`);
  }
  if (!adapter) return no('WebGPU gave no adapter (the GPU may be blocklisted); wet paint runs on the CPU.');
  const name = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ') || null;
  const binding = Math.min(adapter.limits.maxStorageBufferBindingSize ?? 0, adapter.limits.maxBufferSize ?? 0);
  const maxSlots = Math.min(MAX_WET_SLOTS, Math.floor(binding / SLOT_BYTES));
  if (maxSlots < 4) return no(`The GPU's storage buffers hold ${Math.max(0, maxSlots)} wet tiles; at least 4 are needed. Wet paint runs on the CPU.`, name);
  let device: GDevice;
  try {
    device = await adapter.requestDevice({
      label: 'pixerate wet media',
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
  } catch (e) {
    return no(`The WebGPU device did not start (${(e as Error).message}); wet paint runs on the CPU.`, name);
  }
  try {
    const engine = await WetGpuEngine.start(device, maxSlots, name);
    return { engine, support: { supported: true, reason: null, adapter: name, maxSlots } };
  } catch (e) {
    device.destroy?.();
    return no(`The wet-media shaders did not compile on this GPU (${(e as Error).message}); wet paint runs on the CPU.`, name);
  }
}

/** Whether Engine B can run here (starts and stops a device). */
export async function wetGpuSupport(gpu: WetGpuProvider | null = findWebGpu()): Promise<WetGpuSupport> {
  const { engine, support } = await createWetGpuEngine(gpu);
  engine?.destroy();
  return support;
}

async function pipeline(device: GDevice, code: string, label: string): Promise<GPipeline> {
  device.pushErrorScope?.('validation');
  const module = device.createShaderModule({ code, label }) as { getCompilationInfo?: () => Promise<{ messages: readonly { type: string; message: string; lineNum: number }[] }> };
  const info = await module.getCompilationInfo?.();
  const errors = info?.messages.filter((m) => m.type === 'error') ?? [];
  if (errors.length) {
    await device.popErrorScope?.();
    throw new Error(`${label}: ${errors.map((m) => `line ${m.lineNum}: ${m.message}`).join('; ')}`);
  }
  const desc = { layout: 'auto' as const, compute: { module, entryPoint: 'main' }, label };
  const p = device.createComputePipelineAsync ? await device.createComputePipelineAsync(desc) : device.createComputePipeline(desc);
  const err = await device.popErrorScope?.();
  if (err) throw new Error(`${label}: ${err.message}`);
  return p;
}

/** The engine on a started device. Make one with `createWetGpuEngine`. */
export class WetGpuEngine {
  /** Steps run on the GPU so far (for stats). */
  steps = 0;
  /** Set once the device is lost; the engine does nothing after that. */
  lostReason: string | null = null;
  private state: GBuffer;
  private slots = 0;
  private readonly params: GBuffer;
  private jobs: GBuffer;
  private jobCap = 0;
  private flags: GBuffer;
  private flagsRead: GBuffer;
  private readonly uni: GBuffer[];
  private readonly shadeUni: GBuffer;
  private srcTiles: GBuffer | null = null;
  private outTiles: GBuffer | null = null;
  private outRead: GBuffer | null = null;
  private tileCap = 0;
  private groups: { step: unknown[]; halo: unknown[] } | null = null;

  private constructor(
    private readonly device: GDevice,
    /** Most tiles the GPU can hold. */
    readonly maxSlots: number,
    /** The GPU, when known. */
    readonly adapter: string | null,
    private readonly stepPipe: GPipeline,
    private readonly haloPipe: GPipeline,
    private readonly shadePipe: GPipeline
  ) {
    const d = device;
    this.state = d.createBuffer({ size: SLOT_BYTES, usage: STORAGE | COPY_DST | COPY_SRC, label: 'wet state' });
    this.slots = 1;
    this.params = d.createBuffer({ size: MAX_WET_LANES * PARAM_FLOATS * 4, usage: STORAGE | COPY_DST, label: 'wet params' });
    this.jobs = d.createBuffer({ size: 64 * GPU_JOB_WORDS * 4, usage: STORAGE | COPY_DST, label: 'wet jobs' });
    this.jobCap = 64;
    this.flags = d.createBuffer({ size: 64 * 4, usage: STORAGE | COPY_DST | COPY_SRC, label: 'wet flags' });
    this.flagsRead = d.createBuffer({ size: 64 * 4, usage: MAP_READ | COPY_DST, label: 'wet flags read' });
    this.uni = [0, 1].map((p) => {
      const b = d.createBuffer({ size: 16, usage: UNIFORM | COPY_DST, label: `wet parity ${p}` });
      d.queue.writeBuffer(b, 0, new Uint32Array([p, 0, 0, 0]));
      return b;
    });
    this.shadeUni = d.createBuffer({ size: 16, usage: UNIFORM | COPY_DST, label: 'wet shade' });
    void device.lost?.then((info) => {
      this.lostReason = info?.message || info?.reason || 'the GPU device was lost';
    });
  }

  /** @internal Compiles the kernels; use `createWetGpuEngine`. */
  static async start(device: GDevice, maxSlots: number, adapter: string | null): Promise<WetGpuEngine> {
    const [step, halo, shade] = await Promise.all([pipeline(device, WGSL_STEP, 'wet step'), pipeline(device, WGSL_HALO, 'wet halo'), pipeline(device, WGSL_SHADE, 'wet shade')]);
    return new WetGpuEngine(device, maxSlots, adapter, step, halo, shade);
  }

  /** Bytes of GPU memory in use. */
  memoryBytes(): number {
    return this.state.size + this.jobs.size + (this.srcTiles?.size ?? 0) + (this.outTiles?.size ?? 0) * 2;
  }

  /** Slots the state buffer holds now. */
  get capacity(): number {
    return this.slots;
  }

  /** Grows the state buffer to hold `n` slots (keeping its contents). Returns false past `maxSlots`. */
  ensureSlots(n: number): boolean {
    if (n <= this.slots) return true;
    if (n > this.maxSlots) return false;
    const want = Math.min(this.maxSlots, Math.max(n, Math.ceil(this.slots * 1.5)));
    const next = this.device.createBuffer({ size: want * SLOT_BYTES, usage: STORAGE | COPY_DST | COPY_SRC, label: 'wet state' });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.state, 0, next, 0, this.slots * SLOT_BYTES);
    this.device.queue.submit([enc.finish()]);
    this.state.destroy();
    this.state = next;
    this.slots = want;
    this.groups = null;
    return true;
  }

  /** Writes floats into a slot (`offset` floats from the slot's start). */
  writeSlot(slot: number, offset: number, data: Float32Array): void {
    if (slot >= this.slots) throw new Error(`Slot ${slot} is past the GPU's ${this.slots}; call ensureSlots first.`);
    this.device.queue.writeBuffer(this.state, (slot * SLOT_FLOATS + offset) * 4, data.buffer, data.byteOffset, data.byteLength);
  }

  /** Sets a lane's packed parameters (`packWetParams`). */
  setParams(lane: number, prm: Float32Array): void {
    this.device.queue.writeBuffer(this.params, lane * PARAM_FLOATS * 4, prm.buffer, prm.byteOffset, PARAM_FLOATS * 4);
  }

  private writeJobs(jobs: readonly WetGpuJob[], src?: readonly number[]): void {
    if (jobs.length > this.jobCap) {
      this.jobs.destroy();
      this.flags.destroy();
      this.flagsRead.destroy();
      this.jobCap = Math.max(jobs.length, this.jobCap * 2);
      this.jobs = this.device.createBuffer({ size: this.jobCap * GPU_JOB_WORDS * 4, usage: STORAGE | COPY_DST, label: 'wet jobs' });
      this.flags = this.device.createBuffer({ size: this.jobCap * 4, usage: STORAGE | COPY_DST | COPY_SRC, label: 'wet flags' });
      this.flagsRead = this.device.createBuffer({ size: this.jobCap * 4, usage: MAP_READ | COPY_DST, label: 'wet flags read' });
      this.groups = null;
    }
    const words = new Uint32Array(jobs.length * GPU_JOB_WORDS);
    jobs.forEach((j, i) => {
      if (j.slot < 0 || j.slot >= this.slots) throw new Error(`Job ${i} is on slot ${j.slot}, past the GPU's ${this.slots}.`);
      const o = i * GPU_JOB_WORDS;
      words[o] = j.slot * SLOT_FLOATS;
      words[o + 1] = j.lane;
      for (let k = 0; k < 8; k++) {
        const n = j.neighbours[k] ?? -1;
        words[o + 2 + k] = n >= 0 ? n * SLOT_FLOATS : GPU_NONE;
      }
      words[o + 10] = j.width;
      words[o + 11] = j.height;
      words[o + 12] = src && src[i] >= 0 ? src[i] : GPU_NONE;
    });
    this.device.queue.writeBuffer(this.jobs, 0, words);
  }

  private bindGroups(): { step: unknown[]; halo: unknown[] } {
    if (this.groups) return this.groups;
    const d = this.device;
    const step = [0, 1].map((p) =>
      d.createBindGroup({
        layout: this.stepPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.state } },
          { binding: 1, resource: { buffer: this.params } },
          { binding: 2, resource: { buffer: this.jobs } },
          { binding: 3, resource: { buffer: this.flags } },
          { binding: 4, resource: { buffer: this.uni[p] } },
        ],
      })
    );
    const halo = [0, 1].map((p) =>
      d.createBindGroup({
        layout: this.haloPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.state } },
          { binding: 2, resource: { buffer: this.jobs } },
          { binding: 4, resource: { buffer: this.uni[p] } },
        ],
      })
    );
    this.groups = { step, halo };
    return this.groups;
  }

  /**
   * Runs `steps` steps of `jobs` from set `parity` (as the CPU's `runHere`: each step, then each
   * tile's halo in the new set). With `readFlags`, resolves with each job's flag bits OR-ed over
   * the steps (`FLAG_*`); otherwise once the work is submitted.
   */
  async step(jobs: readonly WetGpuJob[], parity: number, steps: number, readFlags = false): Promise<Uint32Array | null> {
    if (this.lostReason) throw new Error(`The GPU is gone (${this.lostReason}).`);
    if (!jobs.length || steps <= 0) return readFlags ? new Uint32Array(jobs.length) : null;
    this.writeJobs(jobs);
    const g = this.bindGroups();
    const enc = this.device.createCommandEncoder();
    enc.clearBuffer(this.flags, 0, jobs.length * 4);
    let p = parity & 1;
    for (let s = 0; s < steps; s++) {
      const a = enc.beginComputePass();
      a.setPipeline(this.stepPipe);
      a.setBindGroup(0, g.step[p]);
      a.dispatchWorkgroups(16, 16, jobs.length);
      a.end();
      const b = enc.beginComputePass();
      b.setPipeline(this.haloPipe);
      b.setBindGroup(0, g.halo[1 - p]);
      b.dispatchWorkgroups(Math.ceil((4 * 258) / 64), SET_PLANES, jobs.length);
      b.end();
      p = 1 - p;
    }
    if (readFlags) enc.copyBufferToBuffer(this.flags, 0, this.flagsRead, 0, jobs.length * 4);
    this.device.queue.submit([enc.finish()]);
    this.steps += steps;
    if (!readFlags) return null;
    await this.flagsRead.mapAsync(MAP_READ, 0, jobs.length * 4);
    const out = new Uint32Array(this.flagsRead.getMappedRange(0, jobs.length * 4).slice(0));
    this.flagsRead.unmap();
    return out;
  }

  /** Refills each job's halo in set `parity` from its neighbours (after uploads). */
  refreshHalos(jobs: readonly WetGpuJob[], parity: number): void {
    if (this.lostReason || !jobs.length) return;
    this.writeJobs(jobs);
    const g = this.bindGroups();
    const enc = this.device.createCommandEncoder();
    const b = enc.beginComputePass();
    b.setPipeline(this.haloPipe);
    b.setBindGroup(0, g.halo[parity & 1]);
    b.dispatchWorkgroups(Math.ceil((4 * 258) / 64), SET_PLANES, jobs.length);
    b.end();
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Shades `jobs` (set `parity`) over their base tiles (`src[i]`: RGBA8 256 × 256, or `null` for
   * transparent) on paper `paper` (sRGB bytes). `mode` 'display' darkens wet paper a little;
   * 'dried' shows the paint as it would dry. Resolves with one RGBA8 tile per job.
   */
  async shade(jobs: readonly WetGpuJob[], parity: number, src: readonly (Uint8ClampedArray | null)[], paper: readonly [number, number, number], mode: 'display' | 'dried' = 'display'): Promise<Uint8ClampedArray[]> {
    if (this.lostReason) throw new Error(`The GPU is gone (${this.lostReason}).`);
    if (!jobs.length) return [];
    const n = jobs.length;
    const srcIndex: number[] = [];
    let srcCount = 0;
    for (const s of src) srcIndex.push(s ? srcCount++ : -1);
    this.writeJobs(jobs, srcIndex);
    const d = this.device;
    const tileBytes = TILE_WORDS * 4;
    if (n > this.tileCap || !this.outTiles || !this.outRead || !this.srcTiles) {
      this.srcTiles?.destroy();
      this.outTiles?.destroy();
      this.outRead?.destroy();
      this.tileCap = Math.max(n, this.tileCap * 2, 4);
      this.srcTiles = d.createBuffer({ size: this.tileCap * tileBytes, usage: STORAGE | COPY_DST, label: 'wet base tiles' });
      this.outTiles = d.createBuffer({ size: this.tileCap * tileBytes, usage: STORAGE | COPY_SRC, label: 'wet shaded tiles' });
      this.outRead = d.createBuffer({ size: this.tileCap * tileBytes, usage: MAP_READ | COPY_DST, label: 'wet shaded read' });
    }
    src.forEach((s, i) => {
      if (s) d.queue.writeBuffer(this.srcTiles!, srcIndex[i] * tileBytes, s.buffer, s.byteOffset, tileBytes);
    });
    d.queue.writeBuffer(this.shadeUni, 0, new Uint32Array([parity & 1, mode === 'display' ? 0 : 1, paper[0] | (paper[1] << 8) | (paper[2] << 16), 0]));
    const group = d.createBindGroup({
      layout: this.shadePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.state } },
        { binding: 1, resource: { buffer: this.srcTiles } },
        { binding: 2, resource: { buffer: this.jobs } },
        { binding: 3, resource: { buffer: this.outTiles } },
        { binding: 4, resource: { buffer: this.shadeUni } },
      ],
    });
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.shadePipe);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(16, 16, n);
    pass.end();
    enc.copyBufferToBuffer(this.outTiles, 0, this.outRead, 0, n * tileBytes);
    d.queue.submit([enc.finish()]);
    const read = this.outRead;
    await read.mapAsync(MAP_READ, 0, n * tileBytes);
    const all = new Uint8ClampedArray(read.getMappedRange(0, n * tileBytes).slice(0));
    read.unmap();
    const out: Uint8ClampedArray[] = [];
    for (let i = 0; i < n; i++) out.push(all.subarray(i * tileBytes, (i + 1) * tileBytes));
    return out;
  }

  /** Reads floats back from a slot (tests and diagnostics). */
  async readSlot(slot: number, offset: number, count: number): Promise<Float32Array> {
    const bytes = count * 4;
    const buf = this.device.createBuffer({ size: Math.ceil(bytes / 4) * 4, usage: MAP_READ | COPY_DST, label: 'wet read' });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.state, (slot * SLOT_FLOATS + offset) * 4, buf, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(MAP_READ, 0, bytes);
    const out = new Float32Array(buf.getMappedRange(0, bytes).slice(0));
    buf.unmap();
    buf.destroy();
    return out;
  }

  /** Waits for submitted work. */
  idle(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone();
  }

  destroy(): void {
    for (const b of [this.state, this.params, this.jobs, this.flags, this.flagsRead, ...this.uni, this.shadeUni, this.srcTiles, this.outTiles, this.outRead]) b?.destroy();
    this.device.destroy();
  }
}
