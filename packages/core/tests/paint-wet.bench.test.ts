import { describe, it } from 'vitest';
import { createWetGpuEngine, WetWorld, pigmentOf, type WetGpuJob, type WetGpuProvider, type WetPaperInput } from '../src/paint';
import { PLANE, SLOT_PLANES } from '../src/paint/wet/model';

/**
 * Wet-media throughput in Node (one thread): `WET_BENCH=1 pnpm vitest run tests/paint-wet.bench.test.ts`.
 * Compare with the spike (spikes/wet-media/RESULTS.md, M4 Pro): one wasm worker stepped a fully wet
 * 2048² canvas at 24 steps/s (41 ms per 64 tiles, 0.65 ms per tile); TypeScript at 2.6 steps/s.
 */
const paper: WetPaperInput = { absorption: 0.5, permeability: 0.5, roughness: 0.5, color: [250, 248, 240], heightAt: (x, y) => 0.5 + 0.25 * Math.sin(x * 0.7) * Math.cos(y * 0.9) };

describe.runIf(process.env.WET_BENCH)('wet bench', () => {
  for (const kernel of ['wasm', 'typescript'] as const) {
    for (const side of kernel === 'typescript' ? [512] : [512, 1024, 2048]) {
      it(`${kernel} ${side}² fully wet`, async () => {
        const w = new WetWorld(side, side, paper, { kernel, threads: 0 });
        await w.ready;
        w.ensureLane('a');
        const blue = pigmentOf([0.2, 0.3, 0.8], 0);
        w.paint('a', { x: 0, y: 0, width: side, height: side }, null, 0.4, blue.map((v) => v * 0.05) as number[]);
        w.stepSync(4);
        const steps = kernel === 'typescript' ? 4 : side >= 2048 ? 16 : 64;
        const t0 = performance.now();
        w.stepSync(steps);
        const ms = (performance.now() - t0) / steps;
        const tiles = w.activeTiles();
        // shading every live tile once (the display path)
        const t1 = performance.now();
        w.display('a');
        const shade = performance.now() - t1;
        console.log(`${kernel} ${side}²: ${tiles} tiles, ${ms.toFixed(2)} ms/step (${(1000 / ms).toFixed(1)} steps/s, ${(ms / tiles).toFixed(3)} ms/tile/step); shading ${(shade / tiles).toFixed(2)} ms/tile; memory ${(w.memoryBytes() / 1e6).toFixed(0)} MB`);
      }, 600000);
    }
  }
});

/**
 * Engine B (WebGPU) throughput: `WET_BENCH=1 WET_GPU=/path/to/node_modules/webgpu pnpm vitest run
 * tests/paint-wet.bench.test.ts`. Node's `webgpu` package is Dawn, the WebGPU implementation in
 * Chrome, so on one machine it compares with the spike's Chrome WebGPU column (M4 Pro): 1024² fully
 * wet 1626 steps/s, 2048² 50% 807, 2048² 100% 402, 4096² 50% 198, 4096² 100% 101; and with its
 * readback (64 tiles shaded and read back in 4.4 ms).
 */
describe.runIf(process.env.WET_BENCH && process.env.WET_GPU)('wet bench: Engine B', () => {
  const cases: [number, number][] = [
    [1024, 1],
    [2048, 0.5],
    [2048, 1],
    [4096, 0.5],
    [4096, 1],
  ];
  let provider: WetGpuProvider | null = null;
  const gpu = async () => {
    if (provider) return provider;
    const { createRequire } = await import('node:module');
    const mod = createRequire(import.meta.url)(process.env.WET_GPU!) as { create: (o: string[]) => WetGpuProvider; globals: object };
    Object.assign(globalThis, mod.globals);
    provider = mod.create([]);
    return provider;
  };
  for (const [side, share] of cases) {
    it(`WebGPU ${side}² ${share * 100}% wet`, async () => {
      const { engine, support } = await createWetGpuEngine(await gpu());
      if (!engine) throw new Error(support.reason ?? 'no engine');
      // One wet tile from the CPU engine, copied into every slot of a grid of `share` of the canvas.
      const w = new WetWorld(256, 256, paper, { kernel: 'wasm', threads: 0 });
      await w.ready;
      w.ensureLane('a');
      w.paint('a', { x: 0, y: 0, width: 256, height: 256 }, null, 0.4, pigmentOf([0.2, 0.3, 0.8], 0).map((v) => v * 0.05) as number[]);
      w.stepSync(4);
      const slotFloats = SLOT_PLANES * PLANE;
      const slot0 = w.rawFloats.subarray(w.slotIndex('a', 0, 0), w.slotIndex('a', 0, 0) + slotFloats);
      const per = side / 256;
      const rows = Math.max(1, Math.round(per * share));
      const n = rows * per;
      engine.ensureSlots(n);
      for (let s = 0; s < n; s++) engine.writeSlot(s, 0, slot0);
      engine.setParams(0, w.rawFloats.subarray(w.layout.params >> 2, (w.layout.params >> 2) + 32));
      const at = (x: number, y: number) => (x < 0 || y < 0 || x >= per || y >= rows ? -1 : y * per + x);
      const jobs: WetGpuJob[] = [];
      for (let y = 0; y < rows; y++) for (let x = 0; x < per; x++) jobs.push({ slot: at(x, y), lane: 0, neighbours: [at(x, y - 1), at(x, y + 1), at(x - 1, y), at(x + 1, y), at(x - 1, y - 1), at(x + 1, y - 1), at(x - 1, y + 1), at(x + 1, y + 1)], width: 256, height: 256 });
      await engine.step(jobs, 0, 8, true);
      let steps = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 2000) {
        await engine.step(jobs, steps & 1, 16, true);
        steps += 16;
      }
      const ms = (performance.now() - t0) / steps;
      const shown = jobs.slice(0, 64);
      await engine.shade(shown, 0, shown.map(() => null), [250, 248, 240]);
      const t1 = performance.now();
      for (let i = 0; i < 5; i++) await engine.shade(shown, 0, shown.map(() => null), [250, 248, 240]);
      const shade = (performance.now() - t1) / 5;
      console.log(`WebGPU (${support.adapter}) ${side}² ${share * 100}% wet: ${n} tiles, ${ms.toFixed(2)} ms/step (${(1000 / ms).toFixed(0)} steps/s, ${((n * 65536) / ms / 1000).toFixed(0)} M cell-steps/s); shade + read back ${shown.length} tiles ${shade.toFixed(1)} ms; GPU memory ${(engine.memoryBytes() / 1e6).toFixed(0)} MB`);
      engine.destroy();
    }, 600000);
  }
});
