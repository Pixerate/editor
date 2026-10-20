import { describe, expect, it } from 'vitest';
import { dexp, dlog, dpow, filmPixel, flowField, normalizeFlow, pigmentColor, pigmentOf, shadeTile, WetWorld, type WetPaperInput, type WetParams } from '../src/paint';
import { readPixel } from '../src/raster/surface';

const grain = (x: number, y: number) => {
  const h = Math.imul((Math.floor(x) * 73856093) ^ (Math.floor(y) * 19349663), 0x27d4eb2d) >>> 0;
  return 0.25 + 0.5 * ((h % 1000) / 1000);
};
const paperOf = (o: Partial<WetPaperInput> = {}): WetPaperInput => ({ absorption: 0.6, permeability: 0.5, roughness: 0.6, color: [255, 255, 255], heightAt: grain, ...o });

function disc(cx: number, cy: number, r: number) {
  const x0 = Math.floor(cx - r);
  const y0 = Math.floor(cy - r);
  const w = Math.ceil(2 * r) + 1;
  const cov = new Float32Array(w * w);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const dx = x0 + x + 0.5 - cx;
      const dy = y0 + y + 0.5 - cy;
      cov[y * w + x] = dx * dx + dy * dy < r * r ? 1 : 0;
    }
  return { rect: { x: x0, y: y0, width: w, height: w }, cov };
}

async function world(o: { size?: number; paper?: Partial<WetPaperInput>; params?: Partial<WetParams> } = {}) {
  const w = new WetWorld(o.size ?? 512, o.size ?? 512, paperOf(o.paper), { kernel: 'wasm', threads: 0 });
  await w.ready;
  w.ensureLane('a', { params: o.params });
  return w;
}

const BLUE = Array.from(pigmentOf([0.1, 0.25, 0.8], 0), (v) => v * 0.06);
const YELLOW = Array.from(pigmentOf([0.95, 0.85, 0.1], 0), (v) => v * 0.06);

describe('deterministic maths', () => {
  it('dexp, dlog and dpow match Math within 1e-13', () => {
    for (const x of [-30, -5.5, -1, -0.3, 0, 0.2, 1, 3.7]) expect(Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x)).toBeLessThan(1e-13);
    for (const x of [1e-6, 0.01, 0.5, 1, 1.9, 7, 1234.5]) expect(Math.abs(dlog(x) - Math.log(x))).toBeLessThan(1e-13);
    expect(Math.abs(dpow(0.4, 2.4) - Math.pow(0.4, 2.4))).toBeLessThan(1e-13);
  });

  it('a full-strength transparent wash over white shows the colour it came from', () => {
    for (const rgb of [[0.1, 0.25, 0.8], [0.95, 0.85, 0.1], [0.6, 0.1, 0.2]] as const) {
      const k = pigmentOf(rgb, 0);
      const c = pigmentColor(k[0] * 0.25, k[1] * 0.25, k[2] * 0.25, k[3] * 0.25);
      for (let i = 0; i < 3; i++) expect(Math.abs(c[i] - rgb[i])).toBeLessThan(2 / 255);
    }
  });

  it('opaque paint hides what is under it; transparent paint glazes', () => {
    const white = pigmentOf([1, 1, 1], 1);
    expect(pigmentColor(white[0] * 0.25, white[1] * 0.25, white[2] * 0.25, white[3] * 0.25).every((v) => v > 0.98)).toBe(true);
    // blue and yellow glazes make green
    const k = BLUE.map((v, i) => v + YELLOW[i]);
    const g = pigmentColor(k[0] / 0.24, k[1] / 0.24, k[2] / 0.24, 0);
    expect(g[1]).toBeGreaterThan(g[0]);
    expect(g[1]).toBeGreaterThan(g[2]);
  });

  it('shadeTile gives filmPixel’s pixels', () => {
    const plane = 258 * 258;
    const f = new Float32Array(plane * 10);
    for (let i = 0; i < f.length; i++) f[i] = ((i * 2654435761) % 1000) / 4000;
    const src = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 7919) % 256;
    const out = new Uint8ClampedArray(src);
    const paper = new Uint8Array([247, 243, 234]);
    shadeTile(f, plane, 258, 0, 4 * plane, 8 * plane, 9 * plane, src, out, 256, 256, paper);
    const one = new Uint8ClampedArray(4);
    for (const [x, y] of [[0, 0], [17, 3], [255, 255], [100, 200]]) {
      const c = (y + 1) * 258 + x + 1;
      const k = [0, 1, 2, 3].map((q) => f[q * plane + c] + f[(4 + q) * plane + c]);
      const wet = Math.min(1, f[8 * plane + c] * 4 + f[9 * plane + c]);
      filmPixel(k[0], k[1], k[2], k[3], src, (y * 256 + x) * 4, paper, wet, one, 0);
      expect([...out.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)]).toEqual([...one]);
    }
  });
});

describe('wet world', () => {
  it('conserves water and pigment when nothing evaporates or soaks in', async () => {
    const w = await world({ paper: { absorption: 0 }, params: { evaporation: 0, bleed: 1 } });
    w.setTilt({ angle: 30, direction: 45 });
    const d = disc(240, 250, 50);
    w.paint('a', d.rect, d.cov, 0.4, BLUE);
    const s0 = w.stats('a');
    w.stepSync(300);
    const s1 = w.stats('a');
    expect(Math.abs(s1.water - s0.water) / s0.water).toBeLessThan(1e-4);
    expect(Math.abs(s1.pigment - s0.pigment) / s0.pigment).toBeLessThan(1e-4);
  });

  it('spreads further on damp paper (wet-in-wet) than on dry paper', async () => {
    const dry = await world();
    const damp = await world();
    damp.wetPaper('a', { x: 0, y: 0, width: 512, height: 512 }, null, 1);
    for (const w of [dry, damp]) {
      const d = disc(256, 256, 20);
      w.paint('a', d.rect, d.cov, 0.3, BLUE);
      w.stepSync(200);
    }
    // the share of the pigment that left the brushed disc
    const outside = (w: WetWorld) => {
      const all = w.sample('a', { x: 0, y: 0, width: 512, height: 512 }, null);
      const d = disc(256, 256, 22);
      const s = w.sample('a', d.rect, d.cov);
      return 1 - (s.pigment[2] + s.settled[2]) / (all.pigment[2] + all.settled[2]);
    };
    expect(outside(damp)).toBeGreaterThan(1.5 * outside(dry));
  });

  it('runs downhill when the canvas is tilted', async () => {
    const w = await world({ paper: { absorption: 0.2 } });
    w.setTilt({ angle: 60, direction: 0 });
    const d = disc(256, 200, 30);
    w.paint('a', d.rect, d.cov, 0.8, BLUE);
    w.stepSync(250);
    const top = w.sample('a', { x: 200, y: 140, width: 112, height: 60 }, null).water;
    const bottom = w.sample('a', { x: 200, y: 240, width: 112, height: 60 }, null).water;
    expect(bottom).toBeGreaterThan(top);
  });

  it('wakes neighbouring tiles as water crosses into them and frees them once dry', async () => {
    const w = await world({ size: 768 });
    w.wetPaper('a', { x: 200, y: 200, width: 120, height: 120 }, null, 1);
    const d = disc(250, 250, 12);
    w.paint('a', d.rect, d.cov, 0.8, BLUE);
    expect(w.activeTiles()).toBe(4);
    await w.stepUntilDry(20000);
    expect(w.isWet('a')).toBe(false);
    expect(w.activeTiles()).toBe(0);
    const base = w.getBase('a');
    const [r, g, b, a] = readPixel(base, 250, 250);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(r);
    void g;
  }, 30000);

  it('darkens the edges of a drying wash', async () => {
    const run = async (darkening: number) => {
      const w = await world({ params: { edgeDarkening: darkening, granulation: 0 }, paper: { roughness: 0 } });
      const d = disc(256, 256, 60);
      w.paint('a', d.rect, d.cov, 0.35, BLUE);
      await w.stepUntilDry(20000);
      const settled = (x: number, y: number) => readPixel(w.getBase('a'), x, y)[3];
      let edge = 0;
      for (let r = 40; r < 100; r++) edge = Math.max(edge, settled(256 + r, 256), settled(256 - r, 256), settled(256, 256 + r));
      return { edge, centre: settled(256, 256) };
    };
    const strong = await run(1);
    expect(strong.edge).toBeGreaterThan(strong.centre);
  }, 30000);

  it('granulates: pigment collects in the paper’s valleys', async () => {
    const w = await world({ params: { granulation: 1, edgeDarkening: 0 }, paper: { roughness: 1 } });
    w.paint('a', { x: 100, y: 100, width: 300, height: 300 }, null, 0.3, BLUE);
    await w.stepUntilDry(20000);
    let sxy = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let n = 0;
    for (let y = 150; y < 350; y += 3)
      for (let x = 150; x < 350; x += 3) {
        const valley = 1 - grain(x + 0.5, y + 0.5);
        const ink = readPixel(w.getBase('a'), x, y)[3];
        sxy += valley * ink;
        sx += valley;
        sy += ink;
        sxx += valley * valley;
        syy += ink * ink;
        n++;
      }
    const corr = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    expect(corr).toBeGreaterThan(0.2);
  }, 30000);

  it('glazes: a dried wash stays under the next one, and yellow under blue makes green', async () => {
    const w = await world({ params: { pickup: 0 } });
    const full = (p: number[]) => p.map((v) => (v / 0.06) * 0.25);
    w.paint('a', { x: 100, y: 100, width: 300, height: 300 }, null, 0.3, full(YELLOW));
    w.dry('a');
    const over = (p: number[]) => p.slice(0, 3).map((v) => v * (p[3] / 255) + 255 * (1 - p[3] / 255));
    const yellow = over(readPixel(w.getBase('a'), 250, 250));
    expect(yellow[0]).toBeGreaterThan(yellow[2]);
    w.paint('a', { x: 100, y: 100, width: 300, height: 300 }, null, 0.3, full(BLUE));
    w.dry('a');
    const [r, g, b] = over(readPixel(w.getBase('a'), 250, 250));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('re-wetting lifts dried paint back into the water', async () => {
    const w = await world();
    w.paint('a', { x: 100, y: 100, width: 300, height: 300 }, null, 0.3, BLUE);
    w.dry('a');
    const before = readPixel(w.getBase('a'), 250, 250)[3];
    const d = disc(250, 250, 30);
    w.paint('a', d.rect, d.cov, 0.5, null);
    w.rewet('a', d.rect, d.cov, 0.6, [255, 255, 255]);
    expect(readPixel(w.getBase('a'), 250, 250)[3]).toBeLessThan(before);
    expect(w.sample('a', d.rect, d.cov).settled[2]).toBeGreaterThan(0);
  });

  it('blotting takes wet paint away; a hair dryer takes only water', async () => {
    const w = await world();
    const d = disc(250, 250, 30);
    w.paint('a', d.rect, d.cov, 0.5, BLUE);
    const p0 = w.sample('a', d.rect, d.cov);
    w.remove('a', d.rect, d.cov, 0.9, 0, 0);
    const p1 = w.sample('a', d.rect, d.cov);
    expect(p1.water).toBeLessThan(p0.water * 0.2);
    expect(p1.pigment[2]).toBeCloseTo(p0.pigment[2], 4);
    w.remove('a', d.rect, d.cov, 0.9, 0.9, 0.5);
    expect(w.sample('a', d.rect, d.cov).pigment[2]).toBeLessThan(p0.pigment[2] * 0.2);
  });

  it('a snapshot restores the simulation exactly', async () => {
    const a = await world();
    const b = await world();
    for (const w of [a, b]) {
      w.setFlow('a', flowField(normalizeFlow({ kind: 'swirl' }), 512, 512), 1);
      const d = disc(250, 250, 40);
      w.paint('a', d.rect, d.cov, 0.5, BLUE);
      w.stepSync(50);
    }
    const snap = a.snapshot();
    const d = disc(270, 240, 20);
    a.paint('a', d.rect, d.cov, 0.5, YELLOW);
    a.stepSync(30);
    a.restore(snap);
    expect(a.clock).toBe(b.clock);
    a.stepSync(64);
    b.stepSync(64);
    const sa = a.stats('a');
    const sb = b.stats('a');
    expect(sa).toEqual(sb);
  });
});
