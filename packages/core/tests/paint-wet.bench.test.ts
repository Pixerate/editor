import { describe, it } from 'vitest';
import { WetWorld, pigmentOf, type WetPaperInput } from '../src/paint';

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
