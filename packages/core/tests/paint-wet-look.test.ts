/**
 * A look harness for tuning wet media (not a test): renders scenes at a few steps into one PNG.
 * `WET_LOOK=/tmp/look.png pnpm vitest run tests/paint-wet-look.test.ts` (optionally `WET_SCENES` JSON).
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { WetWorld, pigmentOf, type WetParams } from '../src/paint';
import { encodePng } from '../src/raster/png';
import { readRegion } from '../src/raster/surface';

const OUT = process.env.WET_LOOK!;
const grain = (x: number, y: number) => {
  const h = Math.imul((Math.floor(x) * 73856093) ^ (Math.floor(y) * 19349663), 0x27d4eb2d) >>> 0;
  return 0.25 + 0.5 * ((h % 1000) / 1000);
};
function disc(cx: number, cy: number, r: number) {
  const x0 = Math.floor(cx - r), y0 = Math.floor(cy - r), w = Math.ceil(2 * r) + 1;
  const cov = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) { const dx = x0 + x + 0.5 - cx, dy = y0 + y + 0.5 - cy; cov[y * w + x] = dx * dx + dy * dy < r * r ? 1 : 0; }
  return { rect: { x: x0, y: y0, width: w, height: w }, cov };
}
const BLUE = Array.from(pigmentOf([0.1, 0.25, 0.8], 0), (v) => v * 0.06);
const YEL = Array.from(pigmentOf([0.95, 0.75, 0.1], 0), (v) => v * 0.06);

it.runIf(OUT)('look', async () => {
  const S = 256;
  type Scene = { name: string; params?: Partial<WetParams>; tilt?: number; damp?: boolean; wet?: number; steps: number[]; prm?: Record<string, number> };
  const scenes: Scene[] = process.env.WET_SCENES ? JSON.parse(process.env.WET_SCENES) : [
    { name: 'dab', steps: [0, 100, 400, 3000] },
    { name: 'damp', damp: true, steps: [0, 100, 400, 3000] },
    { name: 'tilt', tilt: 70, steps: [0, 100, 400, 3000] },
    { name: 'two', steps: [0, 100, 400, 3000] },
  ];
  const W = S * 4, H = S * scenes.length;
  const img = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let si = 0; si < scenes.length; si++) {
    const sc = scenes[si];
    const w = new WetWorld(S, S, { absorption: 0.6, permeability: 0.5, roughness: 0.6, color: [255, 255, 255], heightAt: grain }, { kernel: 'wasm', threads: 0 });
    await w.ready;
    w.ensureLane('a', { params: sc.params });
    if (sc.tilt) w.setTilt({ angle: sc.tilt, direction: 0 });
    if (sc.damp) w.wetPaper('a', { x: 0, y: 0, width: S, height: S }, null, 1);
    const d = disc(128, 100, 30);
    w.paint('a', d.rect, d.cov, sc.wet ?? 0.5, BLUE);
    if (sc.prm) for (const [k, v] of Object.entries(sc.prm)) (w as any).f32[(w.layout.params >> 2) + Number(k)] = v;
    if (sc.name === 'two') { const e = disc(160, 130, 25); w.paint('a', e.rect, e.cov, 0.5, YEL); }
    let t = 0;
    for (let k = 0; k < sc.steps.length; k++) {
      w.stepSync(sc.steps[k] - t);
      t = sc.steps[k];
      const px = readRegion(w.display('a').surface, { x: 0, y: 0, width: S, height: S });
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4, o = ((si * S + y) * W + k * S + x) * 4, a = px[i + 3] / 255;
        for (let c = 0; c < 3; c++) img[o + c] = px[i + c] * a + 255 * (1 - a);
      }
      if (k === 0) console.log(sc.name, w.stats('a'));
      if (k === sc.steps.length - 1) console.log(sc.name, 'end', w.stats('a'), w.activeTiles());
    }
  }
  writeFileSync(OUT, encodePng(W, H, img));
}, 120000);
