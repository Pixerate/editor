/** WebGPU path: dense storage buffers, ping-ponged bind groups, active-tile dispatch. */
import stepWgsl from './gpu/step.wgsl?raw';
import editWgsl from './gpu/edit.wgsl?raw';
import displayWgsl from './gpu/display.wgsl?raw';
import { ActiveSet } from './active';
import { TILE, type Dab, type WetParams, type WetSim, type WetSnapshot, packParams } from './model';

/** Steps per submit. Flags are read back after each chunk, at most two chunks late. */
const CHUNK = 16;

export interface GpuInfo {
  adapter: string;
  limits: Record<string, number>;
}

export class GpuSim implements WetSim {
  readonly name = 'webgpu';
  readonly set: ActiveSet;
  private device!: GPUDevice;
  private f!: [GPUBuffer, GPUBuffer];
  private m!: [GPUBuffer, GPUBuffer];
  private ds!: GPUBuffer;
  private paperBuf!: GPUBuffer;
  private flowBuf!: GPUBuffer;
  private flags!: GPUBuffer;
  private tilesBuf!: GPUBuffer;
  private params!: GPUBuffer;
  private editU!: GPUBuffer;
  private viewU!: GPUBuffer;
  private stepPipe!: GPUComputePipeline;
  private editPipe!: GPUComputePipeline;
  private displayPipe!: GPUComputePipeline;
  private stepBG!: [GPUBindGroup, GPUBindGroup];
  private editBG!: [GPUBindGroup, GPUBindGroup];
  private viewTex!: GPUTexture;
  private ctx: GPUCanvasContext | null = null;
  private cur = 0;
  private tilesVersion = -1;
  private tileCount = 0;
  private staging: GPUBuffer[] = [];
  private pending: Promise<void>[] = [];
  info!: GpuInfo;

  private constructor(readonly width: number, readonly height: number, readonly paper: Float32Array,
    private prm: WetParams, private flow: Float32Array | null) {
    this.set = new ActiveSet(width, height);
  }

  static async create(width: number, height: number, paper: Float32Array, params: WetParams,
    flow: Float32Array | null, canvas: HTMLCanvasElement | null): Promise<GpuSim> {
    const sim = new GpuSim(width, height, paper, params, flow);
    await sim.init(canvas);
    return sim;
  }

  private async init(canvas: HTMLCanvasElement | null): Promise<void> {
    if (!navigator.gpu) throw new Error('WebGPU not available');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    const n = this.width * this.height;
    const fBytes = n * 36;
    const need = {
      maxStorageBufferBindingSize: fBytes,
      maxBufferSize: fBytes,
      maxStorageBuffersPerShaderStage: 9,
    };
    for (const [k, v] of Object.entries(need)) {
      const have = (adapter.limits as unknown as Record<string, number>)[k];
      if (have < v) throw new Error(`WebGPU limit ${k}=${have} < ${v} needed for ${this.width}x${this.height}`);
    }
    this.device = await adapter.requestDevice({ requiredLimits: need });
    const ai = adapter.info;
    this.info = {
      adapter: `${ai.vendor} ${ai.architecture} ${ai.device} ${ai.description}`.trim(),
      limits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
      },
    };
    this.device.lost.then((l) => console.error('device lost', l.message));
    const dev = this.device;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const buf = (size: number, usage = S) => dev.createBuffer({ size: Math.max(16, size), usage });
    this.f = [buf(fBytes), buf(fBytes)];
    this.m = [buf(n * 16), buf(n * 16)];
    this.ds = buf(n * 8);
    this.paperBuf = buf(n * 4);
    dev.queue.writeBuffer(this.paperBuf, 0, this.paper as Float32Array<ArrayBuffer>);
    this.flowBuf = buf(this.flow ? n * 8 : 16);
    if (this.flow) dev.queue.writeBuffer(this.flowBuf, 0, this.flow as Float32Array<ArrayBuffer>);
    const tiles = this.set.tilesX * this.set.tilesY;
    this.flags = buf(tiles * 4);
    this.tilesBuf = buf(tiles * 4);
    for (let i = 0; i < 3; i++) this.staging.push(dev.createBuffer({ size: Math.max(16, tiles * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));

    const pu = new ArrayBuffer(80);
    new Float32Array(pu, 0, 16).set(packParams(this.prm));
    new Uint32Array(pu, 64, 4).set([this.width, this.height, this.set.tilesX, this.flow ? 1 : 0]);
    this.params = buf(80, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    dev.queue.writeBuffer(this.params, 0, pu);
    this.editU = buf(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.viewU = buf(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

    const mod = (code: string) => dev.createShaderModule({ code });
    const stepMod = mod(stepWgsl);
    const info = await stepMod.getCompilationInfo();
    for (const msg of info.messages) if (msg.type === 'error') throw new Error(`WGSL: ${msg.message} @${msg.lineNum}`);
    this.stepPipe = await dev.createComputePipelineAsync({ layout: 'auto', compute: { module: stepMod, entryPoint: 'step' } });
    this.editPipe = await dev.createComputePipelineAsync({ layout: 'auto', compute: { module: mod(editWgsl), entryPoint: 'edit' } });
    this.displayPipe = await dev.createComputePipelineAsync({ layout: 'auto', compute: { module: mod(displayWgsl), entryPoint: 'display' } });

    const sbg = (c: 0 | 1) => dev.createBindGroup({
      layout: this.stepPipe.getBindGroupLayout(0),
      entries: [this.params, this.f[c], this.f[1 - c], this.m[c], this.m[1 - c], this.ds, this.paperBuf, this.flowBuf, this.flags, this.tilesBuf]
        .map((b, i) => ({ binding: i, resource: { buffer: b } })),
    });
    this.stepBG = [sbg(0), sbg(1)];
    const ebg = (c: 0 | 1) => dev.createBindGroup({
      layout: this.editPipe.getBindGroupLayout(0),
      entries: [this.editU, this.f[c], this.m[c]].map((b, i) => ({ binding: i, resource: { buffer: b } })),
    });
    this.editBG = [ebg(0), ebg(1)];

    this.viewTex = dev.createTexture({
      size: [this.width, this.height], format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    if (canvas) {
      this.ctx = canvas.getContext('webgpu');
      this.ctx!.configure({ device: dev, format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST, alphaMode: 'opaque' });
    }
    // paper everywhere
    this.encodeDisplay(0, 0, this.set.tilesX - 1, this.set.tilesY - 1, true);
    await dev.queue.onSubmittedWorkDone();
  }

  private runEdit(mode: 0 | 1, x0: number, y0: number, x1: number, y1: number, d: { cx: number; cy: number; radius: number; wetness: number; concentration: number }) {
    const u = new ArrayBuffer(48);
    new Int32Array(u, 0, 4).set([x0, y0, x1, y1]);
    new Float32Array(u, 16, 5).set([d.cx, d.cy, d.radius, d.wetness, d.concentration]);
    new Uint32Array(u, 36, 3).set([mode, this.width, this.height]);
    this.device.queue.writeBuffer(this.editU, 0, u);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.editPipe);
    pass.setBindGroup(0, this.editBG[this.cur as 0 | 1]);
    pass.dispatchWorkgroups(Math.ceil((x1 - x0 + 1) / 16), Math.ceil((y1 - y0 + 1) / 16));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  dab(d: Dab): void {
    const x0 = Math.floor(d.x - d.radius), y0 = Math.floor(d.y - d.radius);
    const x1 = Math.ceil(d.x + d.radius), y1 = Math.ceil(d.y + d.radius);
    this.runEdit(0, x0, y0, x1, y1, { cx: d.x, cy: d.y, radius: d.radius, wetness: d.wetness, concentration: d.concentration });
    this.set.markRect(d.x - d.radius, d.y - d.radius, d.x + d.radius, d.y + d.radius);
  }

  wash(x0: number, y0: number, x1: number, y1: number, wet: number, conc: number): void {
    this.runEdit(1, x0, y0, x1 - 1, y1 - 1, { cx: 0, cy: 0, radius: 1, wetness: wet, concentration: conc });
    this.set.markRect(x0, y0, x1 - 1, y1 - 1);
  }

  private syncTiles(): void {
    if (this.tilesVersion === this.set.version) return;
    const list = this.set.tiles();
    this.device.queue.writeBuffer(this.tilesBuf, 0, new Uint32Array(list));
    this.tileCount = list.length;
    this.tilesVersion = this.set.version;
  }

  private readFlags(enc: GPUCommandEncoder): void {
    const st = this.staging.find((s) => s.mapState === 'unmapped' && !(s as unknown as { busy?: boolean }).busy);
    if (!st) return; // all in flight; the next chunk will catch the flags (they are OR-accumulated)
    (st as unknown as { busy?: boolean }).busy = true;
    enc.copyBufferToBuffer(this.flags, 0, st, 0, this.flags.size);
    enc.clearBuffer(this.flags);
    this.pending.push(Promise.resolve().then(async () => {
      await st.mapAsync(GPUMapMode.READ);
      this.set.applyFlags(new Uint32Array(st.getMappedRange().slice(0)));
      st.unmap();
      (st as unknown as { busy?: boolean }).busy = false;
    }));
  }

  /** Encode and submit n steps in chunks. Does not wait for completion. */
  submitSteps(n: number): void {
    let left = n;
    while (left > 0) {
      this.syncTiles();
      const k = Math.min(CHUNK, left);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.stepPipe);
      for (let s = 0; s < k; s++) {
        pass.setBindGroup(0, this.stepBG[this.cur as 0 | 1]);
        pass.dispatchWorkgroups(16, 16, this.tileCount);
        this.cur = 1 - this.cur;
      }
      pass.end();
      this.readFlags(enc);
      this.device.queue.submit([enc.finish()]);
      left -= k;
    }
  }

  async step(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      const k = Math.min(CHUNK * 2, left);
      this.submitSteps(k);
      left -= k;
      // keep the flag lag bounded: wait for the oldest readbacks before running further ahead
      if (this.pending.length > 1) await this.pending.shift();
    }
    await this.device.queue.onSubmittedWorkDone();
    await Promise.all(this.pending.splice(0));
  }

  activeTiles(): number {
    return this.set.tiles().length;
  }

  private encodeDisplay(tx0: number, ty0: number, tx1: number, ty1: number, full = false): void {
    const dev = this.device;
    dev.queue.writeBuffer(this.viewU, 0, new Uint32Array([tx0 * TILE, ty0 * TILE, this.width, this.height]));
    const bg = dev.createBindGroup({
      layout: this.displayPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.viewU } },
        { binding: 1, resource: { buffer: this.m[this.cur] } },
        { binding: 2, resource: { buffer: this.ds } },
        { binding: 3, resource: { buffer: this.paperBuf } },
        { binding: 4, resource: this.viewTex.createView() },
      ],
    });
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.displayPipe);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups((tx1 - tx0 + 1) * 16, (ty1 - ty0 + 1) * 16);
    pass.end();
    if (this.ctx && !full) {
      enc.copyTextureToTexture({ texture: this.viewTex }, { texture: this.ctx.getCurrentTexture() }, [this.width, this.height]);
    }
    dev.queue.submit([enc.finish()]);
  }

  async present(tx0: number, ty0: number, tx1: number, ty1: number): Promise<void> {
    this.encodeDisplay(tx0, ty0, tx1, ty1);
    await this.device.queue.onSubmittedWorkDone();
  }

  /**
   * Wet layer -> RGBA8 raster tiles on the CPU: shade `tiles` tiles on the GPU, copy them into
   * one staging buffer (256 KiB per tile) and map it. This is what a CPU compositor would need.
   */
  async readTilesRgba8(tiles: number[]): Promise<Uint8Array> {
    const dev = this.device;
    const staging = dev.createBuffer({ size: tiles.length * TILE * TILE * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.encodeDisplay(0, 0, this.set.tilesX - 1, this.set.tilesY - 1, true);
    const enc = dev.createCommandEncoder();
    tiles.forEach((t, k) => {
      const tx = t % this.set.tilesX, ty = (t / this.set.tilesX) | 0;
      enc.copyTextureToBuffer({ texture: this.viewTex, origin: [tx * TILE, ty * TILE] },
        { buffer: staging, offset: k * TILE * TILE * 4, bytesPerRow: TILE * 4 }, [TILE, TILE]);
    });
    dev.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint8Array(staging.getMappedRange().slice(0));
    staging.destroy();
    return out;
  }

  private async read(src: GPUBuffer): Promise<ArrayBuffer> {
    const st = this.device.createBuffer({ size: src.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, st, 0, src.size);
    this.device.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const out = st.getMappedRange().slice(0);
    st.destroy();
    return out;
  }

  async snapshot(): Promise<WetSnapshot> {
    const n = this.width * this.height;
    const m = new Float32Array(await this.read(this.m[this.cur]));
    const ds = new Float32Array(await this.read(this.ds));
    const rho = new Float32Array(n), p = new Float32Array(n), d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      rho[i] = m[4 * i];
      p[i] = m[4 * i + 3];
      d[i] = ds[2 * i];
    }
    return { width: this.width, height: this.height, rho, p, d };
  }

  memory(): Record<string, number> {
    const n = this.width * this.height;
    return {
      distributions: n * 72,
      macro: n * 32,
      depositAndPaperWater: n * 8,
      paperAndFlow: n * 4 + (this.flow ? n * 8 : 0),
      displayTexture: n * 4,
    };
  }

  destroy(): void {
    this.device.destroy();
  }
}
