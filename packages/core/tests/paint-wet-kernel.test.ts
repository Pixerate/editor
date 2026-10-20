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

/** A scene that exercises every term: dabs of two colours, clear water, tilt, a flow map, damp paper, a push. */
function scene(world: WetWorld, phase: number) {
  const blue = pigmentOf([0.15, 0.3, 0.75], 0);
  const yellow = pigmentOf([0.95, 0.8, 0.1], 0.3);
  const scale = (p: ArrayLike<number>, k: number) => Array.from(p, (v) => v * k);
  if (phase === 0) {
    world.ensureLane('a', { params: { granulation: 0.8, bloom: 0.8, bleed: 0.6 } });
    world.setTilt({ angle: 20, direction: 30 });
    world.setFlow('a', flowField(normalizeFlow({ kind: 'turbulent', scale: 60, seed: 3 }), world.width, world.height), 1);
    const w = disc(240, 250, 40);
    world.wetPaper('a', w.rect, w.cov, 1);
    const d = disc(250, 240, 30);
    world.paint('a', d.rect, d.cov, 0.4, scale(blue, 0.06));
    const e = disc(270, 260, 25);
    world.paint('a', e.rect, e.cov, 0.35, scale(yellow, 0.05));
    // at the right and bottom canvas edges, inside partial tiles
    const r = disc(590, 410, 22);
    world.paint('a', r.rect, r.cov, 0.6, scale(blue, 0.04));
  } else if (phase === 1) {
    const d = disc(255, 255, 20);
    world.paint('a', d.rect, d.cov, 0.5, null);
    world.push('a', d.rect, d.cov, 0.05, -0.02);
  } else {
    const d = disc(300, 200, 15);
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

async function run(kernel: 'typescript' | 'wasm' | 'auto', batches: number[], size = [600, 420]): Promise<WetWorld> {
  const world = new WetWorld(size[0], size[1], paper, { kernel, threads: 0 });
  await world.ready;
  let phase = 0;
  for (const n of batches) {
    if (phase < 3 && (world.clock === 0 || world.clock === 40 || world.clock === 90)) scene(world, phase++);
    world.stepSync(n);
  }
  return world;
}

describe('wet kernel', () => {
  it('kernel-wasm.ts was generated from the current assembly/wet.ts', () => {
    const src = readFileSync(path.resolve(__dirname, '../assembly/wet.ts'));
    expect(createHash('sha256').update(src).digest('hex').slice(0, 16)).toBe(WET_KERNEL_SOURCE_HASH);
  });

  it('the wasm SIMD kernel gives the same bits as the TypeScript kernel', async () => {
    const batches = [40, 50, 70];
    const ts = await run('typescript', batches);
    const wasm = await run('wasm', batches);
    expect(wasm.backend().kind).toBe('wasm');
    expect(ts.backend().kind).toBe('typescript');
    expect(ts.clock).toBe(160);
    expect(ts.activeTiles()).toBeGreaterThan(1);
    expect(digest(wasm)).toBe(digest(ts));
  }, 60000);

  it('gives the same result however the steps are batched, on shared memory too', async () => {
    const a = await run('wasm', [40, 50, 70, 100]);
    const b = await run('auto', [1, 3, 36, 7, 43, 5, 25, 40, 40, 20, 13, 7, 20]);
    expect(b.clock).toBe(a.clock);
    expect(digest(b)).toBe(digest(a));
  }, 60000);
});
