import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { WetWorld, flowField, normalizeFlow, pigmentOf, type WetPaperInput } from '../src/paint';
import { WET_KERNEL_SOURCE_HASH } from '../src/paint/wet/kernel-wasm';

const paper: WetPaperInput = {
  absorption: 0.6,
  permeability: 0.5,
  roughness: 0.6,
  color: [247, 243, 234],
  heightAt: (x, y) => {
    const h = Math.imul(Math.floor(x) * 73856093 ^ Math.floor(y) * 19349663, 0x27d4eb2d) >>> 0;
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

/** Where the scene's marks go: around a tile boundary, plus one at the far canvas corner, inside a partial tile. */
interface Spots {
  cx: number;
  cy: number;
  corner: [number, number];
  late: [number, number];
}
const FULL: Spots = { cx: 250, cy: 250, corner: [590, 410], late: [300, 200] };
/** 2 × 1 tiles, the second one partial: the wet patch straddles the x = 256 seam. */
const SMALL: Spots = { cx: 250, cy: 90, corner: [290, 170], late: [270, 60] };

/** A scene that exercises every term: dabs of two colours, clear water, tilt, a flow map, damp paper, a push. */
function scene(world: WetWorld, phase: number, at: Spots) {
  const { cx, cy } = at;
  const blue = pigmentOf([0.15, 0.3, 0.75], 0);
  const yellow = pigmentOf([0.95, 0.8, 0.1], 0.3);
  const scale = (p: ArrayLike<number>, k: number) => Array.from(p, (v) => v * k);
  if (phase === 0) {
    world.ensureLane('a', { params: { granulation: 0.8, bloom: 0.8, bleed: 0.6 } });
    world.setTilt({ angle: 20, direction: 30 });
    world.setFlow('a', flowField(normalizeFlow({ kind: 'turbulent', scale: 60, seed: 3 }), world.width, world.height), 1);
    const w = disc(cx - 10, cy, 40);
    world.wetPaper('a', w.rect, w.cov, 1);
    const d = disc(cx, cy - 10, 30);
    world.paint('a', d.rect, d.cov, 0.4, scale(blue, 0.06));
    const e = disc(cx + 20, cy + 10, 25);
    world.paint('a', e.rect, e.cov, 0.35, scale(yellow, 0.05));
    // at the right and bottom canvas edges, inside partial tiles
    const r = disc(at.corner[0], at.corner[1], 22);
    world.paint('a', r.rect, r.cov, 0.6, scale(blue, 0.04));
  } else if (phase === 1) {
    const d = disc(cx + 5, cy + 5, 20);
    world.paint('a', d.rect, d.cov, 0.5, null);
    world.push('a', d.rect, d.cov, 0.05, -0.02);
  } else {
    const d = disc(at.late[0], at.late[1], 15);
    world.blend('a', d.rect, d.cov, 0.5);
    world.drag('a', d.rect, d.cov, 4, 2, 0.6);
  }
}

function digest(world: WetWorld): string {
  const h = createHash('sha256');
  const f = world.rawFloats;
  for (const id of world.laneIds()) {
    for (let ty = 0; ty < world.layout.tilesY; ty++)
      for (let tx = 0; tx < world.layout.tilesX; tx++) {
        const b = world.slotIndex(id, tx, ty);
        if (b < 0) continue;
        // the current set and the deposit planes, interiors only
        const p = world.currentParity;
        for (const plane of [...Array(18).keys()].map((k) => p * 18 + k).concat([36, 37, 38, 39]))
          for (let y = 1; y <= 256; y++) h.update(new Uint8Array(f.buffer, f.byteOffset + (b + plane * 258 * 258 + y * 258 + 1) * 4, 256 * 4));
      }
    const base = world.getBase(id);
    for (const [k, t] of [...base.tiles].sort((a, b) => a[0] - b[0])) {
      h.update(String(k));
      h.update(t.data);
    }
  }
  return h.digest('hex');
}

interface Setup {
  size: [number, number];
  at: Spots;
  /** Clocks at which scene phases 0, 1 and 2 run. */
  phases: [number, number, number];
}
/**
 * The CI scene: 2 tiles, 9 steps. The TypeScript kernel costs ~45 ms per tile-step, so keep it small;
 * a kernel difference shows in the bits from the first step after each phase.
 */
const QUICK: Setup = { size: [300, 180], at: SMALL, phases: [0, 3, 6] };
/** The full scene (3 × 2 tiles, 160 steps): run with WET_BENCH=1. */
const FULL_SETUP: Setup = { size: [600, 420], at: FULL, phases: [0, 40, 90] };

async function run(kernel: 'typescript' | 'wasm' | 'auto', batches: number[], setup: Setup = QUICK): Promise<WetWorld> {
  const world = new WetWorld(setup.size[0], setup.size[1], paper, { kernel, threads: 0 });
  await world.ready;
  let phase = 0;
  for (const n of batches) {
    if (phase < 3 && world.clock === setup.phases[phase]) scene(world, phase++, setup.at);
    world.stepSync(n);
  }
  return world;
}

const bench = process.env.WET_BENCH ? it : it.skip;

describe('wet kernel', () => {
  it('kernel-wasm.ts was generated from the current assembly/wet.ts', () => {
    const src = readFileSync(path.resolve(__dirname, '../assembly/wet.ts'));
    expect(createHash('sha256').update(src).digest('hex').slice(0, 16)).toBe(WET_KERNEL_SOURCE_HASH);
  });

  it('the wasm SIMD kernel gives the same bits as the TypeScript kernel', async () => {
    const batches = [3, 3, 3];
    const ts = await run('typescript', batches);
    const wasm = await run('wasm', batches);
    expect(wasm.backend().kind).toBe('wasm');
    expect(ts.backend().kind).toBe('typescript');
    expect(ts.clock).toBe(9);
    expect(ts.activeTiles()).toBe(2);
    expect(digest(wasm)).toBe(digest(ts));
  }, 20000);

  bench('the wasm SIMD kernel gives the same bits as the TypeScript kernel on the full scene (WET_BENCH)', async () => {
    const batches = [40, 50, 70];
    const ts = await run('typescript', batches, FULL_SETUP);
    const wasm = await run('wasm', batches, FULL_SETUP);
    expect(ts.clock).toBe(160);
    expect(ts.activeTiles()).toBeGreaterThan(1);
    expect(digest(wasm)).toBe(digest(ts));
  }, 300000);

  it('gives the same result however the steps are batched, on shared memory too', async () => {
    const a = await run('wasm', [3, 3, 3, 31]);
    const b = await run('auto', [1, 2, 2, 1, 1, 7, 13, 5, 8]);
    expect(b.clock).toBe(a.clock);
    expect(digest(b)).toBe(digest(a));
  });

  bench('gives the same result however the steps are batched on the full scene (WET_BENCH)', async () => {
    const a = await run('wasm', [40, 50, 70, 100], FULL_SETUP);
    const b = await run('auto', [1, 3, 36, 7, 43, 5, 25, 40, 40, 20, 13, 7, 20], FULL_SETUP);
    expect(b.clock).toBe(a.clock);
    expect(digest(b)).toBe(digest(a));
  }, 300000);
});
