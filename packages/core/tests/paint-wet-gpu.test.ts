import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createWetGpuEngine, flowField, normalizeFlow, pigmentOf, wetGpuSupport, WetWorld, type WetGpuJob, type WetGpuProvider, type WetPaperInput } from '../src/paint';
import { P_D0, P_P0, P_RHO, P_SW, PLANE, SET_PLANES, SLOT_PLANES, WET_TILE } from '../src/paint/wet/model';
import { shadeTile } from '../src/paint/wet/film';

/**
 * Engine B needs a GPU. In Node the capability checks run against fake providers; the GPU-vs-CPU
 * comparison runs when WET_GPU names a Node WebGPU module (e.g. the `webgpu` package, Dawn):
 *   WET_GPU=/path/to/node_modules/webgpu pnpm vitest run tests/paint-wet-gpu.test.ts
 */
function nodeGpu(): WetGpuProvider | null {
  const path = process.env.WET_GPU;
  if (!path) return null;
  const mod = createRequire(import.meta.url)(path) as { create: (o: string[]) => WetGpuProvider; globals: object };
  Object.assign(globalThis, mod.globals);
  return mod.create([]);
}
const gpu = nodeGpu();
const withGpu = gpu ? it : it.skip;

const SLOT_FLOATS = SLOT_PLANES * PLANE;

const paper: WetPaperInput = {
  absorption: 0.6,
  permeability: 0.5,
  roughness: 0.6,
  color: [247, 243, 234],
  heightAt: (x, y) => {
    const h = Math.imul((Math.floor(x) * 73856093) ^ (Math.floor(y) * 19349663), 0x27d4eb2d) >>> 0;
    return 0.3 + 0.4 * ((h % 1000) / 1000);
  },
};

function disc(cx: number, cy: number, r: number) {
  const x0 = Math.floor(cx - r);
  const y0 = Math.floor(cy - r);
  const w = Math.ceil(2 * r) + 1;
  const cov = new Float32Array(w * w);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const dx = x0 + x + 0.5 - cx;
      const dy = y0 + y + 0.5 - cy;
      const q = (dx * dx + dy * dy) / (r * r);
      cov[y * w + x] = q < 1 ? (1 - q) * (1 - q) : 0;
    }
  return { rect: { x: x0, y: y0, width: w, height: w }, cov };
}

describe('Engine B capability check (no GPU needed)', () => {
  it('says why it cannot run: no WebGPU, no adapter, too little memory, a failed device', async () => {
    expect((await wetGpuSupport(null)).reason).toMatch(/no WebGPU/);
    expect(await wetGpuSupport({ requestAdapter: async () => null })).toMatchObject({ supported: false, reason: expect.stringMatching(/no adapter/) });
    const tiny = { limits: { maxStorageBufferBindingSize: 32 << 20, maxBufferSize: 256 << 20 }, info: { vendor: 'test' }, requestDevice: async () => ({}) };
    const s = await wetGpuSupport({ requestAdapter: async () => tiny });
    expect(s.supported).toBe(false);
    expect(s.reason).toMatch(/at least 4/);
    expect(s.adapter).toBe('test');
    const failing = { limits: { maxStorageBufferBindingSize: 2 ** 31, maxBufferSize: 2 ** 31 }, requestDevice: async () => Promise.reject(new Error('lost')) };
    expect((await wetGpuSupport({ requestAdapter: async () => failing })).reason).toMatch(/did not start \(lost\)/);
  });
});

describe('Engine B on a GPU (WET_GPU)', () => {
  withGpu('steps and shades within 1/255 of the CPU engine', async () => {
    const { engine, support } = await createWetGpuEngine(gpu);
    expect(support.reason).toBeNull();
    const e = engine!;
    const world = new WetWorld(600, 420, paper, { kernel: 'wasm', threads: 0 });
    await world.ready;
    world.ensureLane('a', { params: { granulation: 0.8, bloom: 0.8, bleed: 0.6 } });
    world.setTilt({ angle: 20, direction: 30 });
    world.setFlow('a', flowField(normalizeFlow({ kind: 'turbulent', scale: 60, seed: 3 }), world.width, world.height), 1);
    const blue = Array.from(pigmentOf([0.15, 0.3, 0.75], 0), (v) => v * 0.06);
    const yellow = Array.from(pigmentOf([0.95, 0.8, 0.1], 0.3), (v) => v * 0.05);
    const w = disc(250, 250, 40);
    world.wetPaper('a', w.rect, w.cov, 1);
    const d1 = disc(255, 240, 30);
    world.paint('a', d1.rect, d1.cov, 0.4, blue);
    const d2 = disc(275, 262, 25);
    world.paint('a', d2.rect, d2.cov, 0.35, yellow);
    world.stepSync(8);

    // Mirror the CPU state on the GPU: same slots, same layout.
    const f = world.rawFloats;
    const slotsBase = world.layout.slots >> 2;
    const tiles: { tx: number; ty: number; slot: number }[] = [];
    for (let ty = 0; ty < world.layout.tilesY; ty++)
      for (let tx = 0; tx < world.layout.tilesX; tx++) {
        const b = world.slotIndex('a', tx, ty);
        if (b >= 0) tiles.push({ tx, ty, slot: (b - slotsBase) / SLOT_FLOATS });
      }
    expect(tiles.length).toBeGreaterThan(1);
    expect(e.ensureSlots(Math.max(...tiles.map((t) => t.slot)) + 1)).toBe(true);
    for (const t of tiles) e.writeSlot(t.slot, 0, f.subarray(slotsBase + t.slot * SLOT_FLOATS, slotsBase + (t.slot + 1) * SLOT_FLOATS));
    e.setParams(0, f.subarray((world.layout.params >> 2) + 0, (world.layout.params >> 2) + 32));
    const slotAt = (tx: number, ty: number) => {
      const b = world.slotIndex('a', tx, ty);
      return b < 0 ? -1 : (b - slotsBase) / SLOT_FLOATS;
    };
    const jobs: WetGpuJob[] = tiles.map((t) => ({
      slot: t.slot,
      lane: 0,
      neighbours: [slotAt(t.tx, t.ty - 1), slotAt(t.tx, t.ty + 1), slotAt(t.tx - 1, t.ty), slotAt(t.tx + 1, t.ty), slotAt(t.tx - 1, t.ty - 1), slotAt(t.tx + 1, t.ty - 1), slotAt(t.tx - 1, t.ty + 1), slotAt(t.tx + 1, t.ty + 1)],
      width: Math.min(WET_TILE, world.width - t.tx * WET_TILE),
      height: Math.min(WET_TILE, world.height - t.ty * WET_TILE),
    }));
    // 24 more steps on both, within one CPU batch (no tiles wake or free in between).
    const n = 24;
    const flags = await e.step(jobs, world.currentParity, n, true);
    world.stepSync(n);
    expect(world.activeTiles()).toBe(tiles.length);
    expect([...flags!].every((fl) => fl & 1)).toBe(true);

    const p = world.currentParity;
    let maxWater = 0;
    let maxPigment = 0;
    let maxDeposit = 0;
    for (const t of tiles) {
      const gpuSlot = await e.readSlot(t.slot, 0, SLOT_FLOATS);
      const cpu = f.subarray(slotsBase + t.slot * SLOT_FLOATS, slotsBase + (t.slot + 1) * SLOT_FLOATS);
      for (let y = 1; y <= 256; y++)
        for (let x = 1; x <= 256; x++) {
          const c = y * 258 + x;
          const set = p * SET_PLANES * PLANE;
          maxWater = Math.max(maxWater, Math.abs(gpuSlot[set + P_RHO * PLANE + c] - cpu[set + P_RHO * PLANE + c]));
          for (let q = 0; q < 4; q++) {
            maxPigment = Math.max(maxPigment, Math.abs(gpuSlot[set + (P_P0 + q) * PLANE + c] - cpu[set + (P_P0 + q) * PLANE + c]));
            maxDeposit = Math.max(maxDeposit, Math.abs(gpuSlot[(P_D0 + q) * PLANE + c] - cpu[(P_D0 + q) * PLANE + c]));
          }
        }
    }
    // The spike saw ~3e-6 after 500 steps.
    expect(maxWater).toBeLessThan(1e-4);
    expect(maxPigment).toBeLessThan(1e-4);
    expect(maxDeposit).toBeLessThan(1e-4);

    // Shading: the GPU's display tiles against the CPU's, from the CPU state, within 1/255.
    for (const t of tiles) e.writeSlot(t.slot, 0, f.subarray(slotsBase + t.slot * SLOT_FLOATS, slotsBase + (t.slot + 1) * SLOT_FLOATS));
    const src = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = (i * 7) % 256;
      src[i + 1] = 200;
      src[i + 2] = 90;
      src[i + 3] = (i >> 2) % 3 === 0 ? 0 : 160;
    }
    const shaded = await e.shade(jobs, p, jobs.map((_, i) => (i === 0 ? src : null)), [247, 243, 234], 'display');
    let worst = 0;
    let overOne = 0;
    let compared = 0;
    let shadedPixels = 0;
    tiles.forEach((t, i) => {
      const b = slotsBase + t.slot * SLOT_FLOATS;
      const cur = b + p * SET_PLANES * PLANE;
      const base = i === 0 ? src : null;
      const out = base ? new Uint8ClampedArray(base) : new Uint8ClampedArray(256 * 256 * 4);
      shadeTile(f, PLANE, 258, b + P_D0 * PLANE, cur + P_P0 * PLANE, cur + P_RHO * PLANE, cur + P_SW * PLANE, base, out, jobs[i].width, jobs[i].height, new Uint8Array([247, 243, 234]));
      // What shows: the layer over the paper (straight RGB at a tiny alpha magnifies 1-level differences).
      const paperRgb = [247, 243, 234];
      for (let k = 0; k < out.length; k += 4)
        for (let ch = 0; ch < 3; ch++) {
          const over = (px: Uint8ClampedArray) => (px[k + 3] / 255) * px[k + ch] + (1 - px[k + 3] / 255) * paperRgb[ch];
          const dv = Math.abs(over(out) - over(shaded[i]));
          if (dv > worst) worst = dv;
          if (dv > 1) overOne++;
          compared++;
        }
      for (let k = 3; k < out.length; k += 4) if (out[k] !== (base ? base[k] : 0)) shadedPixels++;
    });
    expect(shadedPixels).toBeGreaterThan(1000);
    // Both sides round colour and alpha to bytes: up to ~1.5 levels apart on the paper, rarely over 1.
    expect(worst).toBeLessThanOrEqual(2);
    expect(overOne / compared).toBeLessThan(1e-4);
    e.destroy();
  }, 60000);

  withGpu('a world mirrors its edits, wake-ups and steps on the GPU, and its display stays within 1/255', async () => {
    const { engine } = await createWetGpuEngine(gpu);
    const make = async () => {
      const w = new WetWorld(600, 420, paper, { kernel: 'wasm', threads: 0 });
      await w.ready;
      w.ensureLane('a', { params: { granulation: 0.8, bloom: 0.8 } });
      w.setTilt({ angle: 30, direction: 20 });
      return w;
    };
    const cpu = await make();
    const mirrored = await make();
    mirrored.attachGpu(engine);
    mirrored.gpuMinTiles = 1;
    const blue = Array.from(pigmentOf([0.15, 0.3, 0.75], 0), (v) => v * 0.06);
    const red = Array.from(pigmentOf([0.8, 0.2, 0.15], 0.2), (v) => v * 0.05);
    const script = async (w: WetWorld) => {
      const a = disc(250, 250, 45);
      w.paint('a', a.rect, a.cov, 0.4, blue);
      w.stepSync(40); // wakes neighbouring tiles
      const b = disc(300, 230, 25);
      w.paint('a', b.rect, b.cov, 0.4, red);
      w.push('a', b.rect, b.cov, 0.04, 0.01);
      w.stepSync(30);
      const c = disc(240, 280, 20);
      w.blend('a', c.rect, c.cov, 0.5);
      w.drag('a', c.rect, c.cov, 3, -2, 0.6);
      w.stepSync(26);
    };
    await script(cpu);
    await script(mirrored);
    expect(mirrored.gpuActive).toBe(true);
    expect(mirrored.gpuError).toBeNull();
    const want = cpu.display('a');
    const got = await mirrored.displayGpu('a');
    expect(got.gpu).toBe(true);
    expect(got.changed.length).toBe(mirrored.activeTiles());
    const paperRgb = [247, 243, 234];
    let worst = 0;
    let overOne = 0;
    let compared = 0;
    let painted = 0;
    for (const [k, t] of want.surface.tiles) {
      const g = got.surface.tiles.get(k);
      expect(g, `tile ${k}`).toBeTruthy();
      for (let i = 0; i < t.data.length; i += 4) {
        if (t.data[i + 3] > 0) painted++;
        for (let ch = 0; ch < 3; ch++) {
          const over = (px: Uint8ClampedArray) => (px[i + 3] / 255) * px[i + ch] + (1 - px[i + 3] / 255) * paperRgb[ch];
          const dv = Math.abs(over(t.data) - over(g!.data));
          worst = Math.max(worst, dv);
          if (dv > 1) overOne++;
          compared++;
        }
      }
    }
    expect(painted).toBeGreaterThan(5000);
    expect(worst).toBeLessThanOrEqual(2);
    expect(overOne / compared).toBeLessThan(1e-3);
    // The CPU state is the authority: the mirror changes nothing in it.
    expect(mirrored.stats('a')).toEqual(cpu.stats('a'));
    expect(mirrored.clock).toBe(cpu.clock);
    engine!.destroy();
  }, 60000);

  withGpu('in the paint editor the GPU shades large washes, and what is saved is the CPU result, byte for byte', async () => {
    const { PaintEditorController } = await import('../src/paint-editor');
    const make = (gpuOn: boolean) =>
      new PaintEditorController({ width: 700, height: 540, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0, gpu: gpuOn ? 'auto' : 'off', gpuMinTiles: 2, gpuProvider: gpu } });
    const paintIt = async (c: InstanceType<typeof PaintEditorController>) => {
      c.wetPaper({ rect: { x: 100, y: 80, width: 420, height: 360 } });
      for (let i = 0; i < 4; i++) c.paintStroke({ points: Array.from({ length: 30 }, (_, k) => ({ x: 120 + k * 12, y: 140 + i * 70 + Math.sin(k / 3) * 15, pressure: 0.8 })), brushId: 'watercolor-round', color: i % 2 ? '#c0392b' : '#1d4ed8', seed: i });
      await c.setWetEngine({});
      await c.advanceWet({ steps: 60 });
    };
    const on = make(true);
    const off = make(false);
    await paintIt(on);
    await paintIt(off);
    expect(on.wetEngine()).toMatchObject({ state: 'active', mode: 'auto' });
    expect(on.getState().wet.gpuActive).toBe(true);
    expect(off.wetEngine().state).toBe('off');
    // The live display: within 1/255 on the paper.
    const a = on.compositePixels({ wet: 'display' }).data;
    const b = off.compositePixels({ wet: 'display' }).data;
    let worst = 0;
    let differ = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      worst = Math.max(worst, d);
      if (d > 1) differ++;
    }
    expect(worst).toBeLessThanOrEqual(2);
    expect(differ / a.length).toBeLessThan(1e-3);
    // Dried, saved and exported: the CPU's bits.
    expect(Buffer.from(on.compositePixels({ wet: 'dried' }).data).equals(Buffer.from(off.compositePixels({ wet: 'dried' }).data))).toBe(true);
    // The saved layers (their pixels are assets; ids are generated, so compare what they point at).
    const saved = (c: InstanceType<typeof PaintEditorController>) => {
      const doc = c.toJSON() as { layers: { asset?: string }[]; assets?: Record<string, unknown> };
      return JSON.stringify(doc.layers.map((l) => ({ ...l, id: undefined, asset: l.asset ? doc.assets?.[l.asset] : undefined })));
    };
    const sa = saved(on);
    expect(sa.length).toBeGreaterThan(1000);
    expect(sa).toBe(saved(off));
    on.dispose();
    off.dispose();
  }, 120000);

  withGpu('between strokes the GPU runs ahead within the CPU batch, never past it, and shows the right step', async () => {
    const { engine } = await createWetGpuEngine(gpu);
    const make = async () => {
      const w = new WetWorld(600, 420, paper, { kernel: 'wasm', threads: 0 });
      await w.ready;
      w.ensureLane('a', { params: { granulation: 0.8 } });
      w.setTilt({ angle: 40, direction: 0 });
      const a = disc(260, 200, 60);
      w.paint('a', a.rect, a.cov, 0.6, Array.from(pigmentOf([0.15, 0.3, 0.75], 0), (v) => v * 0.06));
      w.stepSync(8);
      return w;
    };
    const lead = await make();
    lead.attachGpu(engine);
    lead.gpuMinTiles = 1;
    lead.stepSync(8); // mirrored, in lockstep
    lead.gpuLeadMode = true;
    lead.stepSync(16); // the CPU runs the batch; the GPU has not started it
    expect(lead.gpuLead(5)).toBe(5);
    const at = async (steps: number) => {
      const cpu = await make();
      cpu.stepSync(8 + steps);
      return cpu.display('a').surface;
    };
    const compare = (want: { tiles: Map<number, { data: Uint8ClampedArray }> }, got: { tiles: Map<number, { data: Uint8ClampedArray }> }) => {
      let worst = 0;
      for (const [k, t] of want.tiles) {
        const g = got.tiles.get(k)!;
        for (let i = 0; i < t.data.length; i += 4)
          for (let ch = 0; ch < 3; ch++) {
            const over = (px: Uint8ClampedArray) => (px[i + 3] / 255) * px[i + ch] + (1 - px[i + 3] / 255) * paper.color[ch];
            worst = Math.max(worst, Math.abs(over(t.data) - over(g.data)));
          }
      }
      return worst;
    };
    const mid = await lead.displayGpu('a', Infinity, true);
    expect(mid.gpu).toBe(true);
    expect(compare(await at(5), mid.surface)).toBeLessThanOrEqual(2);
    // Ahead of step 5 it is not: the GPU really shows step 5 of 16.
    expect(compare(await at(16), mid.surface)).toBeGreaterThan(2);
    expect(lead.gpuLead(100)).toBe(11);
    expect(lead.gpuLead(1)).toBe(0);
    const end = await lead.displayGpu('a', Infinity, true);
    expect(compare(await at(16), end.surface)).toBeLessThanOrEqual(2);
    // Back in step: the next batch picks up from the same clock.
    lead.gpuLeadMode = false;
    lead.stepSync(8);
    const after = await lead.displayGpu('a');
    expect(after.gpu).toBe(true);
    expect(compare(await at(24), after.surface)).toBeLessThanOrEqual(2);
    engine!.destroy();
  }, 60000);
});
