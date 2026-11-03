import { describe, expect, it } from 'vitest';
import { PaintEditorController, replayPainting, type PaintPixelLayer } from '../src/paint-editor';
import { WetWorld, pigmentOf, type WetPaperInput } from '../src/paint';
import { MASS_CHANNELS, P_D0, P_L, P_P0, PLANE, SET_PLANES } from '../src/paint/wet/model';
import { readPixel } from '../src/raster/surface';

const W = 220;
const H = 160;
const editor = () => new PaintEditorController({ width: W, height: H, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0, gpu: 'off' } });
const LINE = [
  { x: 40, y: 80 },
  { x: 180, y: 80 },
];
const id = (c: PaintEditorController) => c.getActiveLayer()!.id;
const lightAt = (c: PaintEditorController, x: number, y: number, layer = id(c)) => {
  const l = c.document.light?.[layer];
  return l ? readPixel(l, x, y)[0] : 0;
};
const sumLight = (c: PaintEditorController, layer = id(c)) => {
  const l = c.document.light?.[layer];
  let s = 0;
  if (l) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) s += readPixel(l, x, y)[0];
  return s;
};

function correlation(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}

const paper: WetPaperInput = { absorption: 0.6, permeability: 0.5, roughness: 0.6, color: [247, 243, 234], heightAt: () => 0.5 };
function disc(cx: number, cy: number, r: number) {
  const x0 = Math.floor(cx - r);
  const y0 = Math.floor(cy - r);
  const w = Math.ceil(2 * r) + 1;
  const cov = new Float32Array(w * w);
  for (let y = 0; y < w; y++)
    for (let x = 0; x < w; x++) {
      const q = ((x0 + x + 0.5 - cx) ** 2 + (y0 + y + 0.5 - cy) ** 2) / (r * r);
      cov[y * w + x] = q < 1 ? (1 - q) * (1 - q) : 0;
    }
  return { rect: { x: x0, y: y0, width: w, height: w }, cov };
}

/** The current set's planes and the deposit planes of a lane's tile (0, 0), by plane name. */
function planes(world: WetWorld) {
  const f = world.rawFloats;
  const b = world.slotIndex('a', 0, 0);
  const set = b + world.currentParity * SET_PLANES * PLANE;
  const read = (base: number) => f.slice(base, base + PLANE);
  return {
    water: [...Array(P_P0).keys()].map((k) => read(set + k * PLANE)),
    pigment: [0, 1, 2, 3].map((q) => read(set + (P_P0 + q) * PLANE)),
    settled: [0, 1, 2, 3].map((q) => read(b + (P_D0 + q) * PLANE)),
    light: read(set + P_L * PLANE),
    settledLight: read(b + (P_D0 + 4) * PLANE),
  };
}

async function scene(light: number): Promise<WetWorld> {
  const world = new WetWorld(200, 200, paper, { kernel: 'wasm', threads: 0 });
  await world.ready;
  world.ensureLane('a', { params: { granulation: 0.8, bloom: 0.8, bleed: 0.6 } });
  world.setTilt({ angle: 15, direction: 20 });
  const blue = pigmentOf([0.15, 0.3, 0.75], 0);
  const d = disc(100, 90, 40);
  world.paint('a', d.rect, d.cov, 0.4, Array.from(blue, (v) => v * 0.06), null, light);
  world.stepSync(30);
  const e = disc(110, 100, 20);
  world.paint('a', e.rect, e.cov, 0.5, null);
  world.blend('a', e.rect, e.cov, 0.5);
  world.drag('a', e.rect, e.cov, 4, 2, 0.6);
  world.stepSync(30);
  return world;
}

describe('wet light paint: the simulation', () => {
  it('light never changes the water or pigment, and without light its planes stay empty', async () => {
    const lit = planes(await scene(0.8));
    const plain = planes(await scene(0));
    expect(MASS_CHANNELS).toBe(5);
    for (const k of ['water', 'pigment', 'settled'] as const) lit[k].forEach((p, i) => expect(Buffer.from(p.buffer).equals(Buffer.from(plain[k][i].buffer)), `${k} ${i}`).toBe(true));
    expect(plain.light.every((v) => v === 0) && plain.settledLight.every((v) => v === 0)).toBe(true);
    expect(lit.light.some((v) => v > 0) && lit.settledLight.some((v) => v > 0)).toBe(true);
  });

  it('moves light exactly as pigment mass: its light is the K red channel scaled, cell for cell', async () => {
    // With light laid in proportion to one pigment channel, the same flux keeps them in proportion.
    const world = new WetWorld(200, 200, paper, { kernel: 'wasm', threads: 0 });
    await world.ready;
    world.ensureLane('a');
    const d = disc(100, 100, 40);
    world.paint('a', d.rect, d.cov, 0.4, [0.02, 0, 0, 0], null, 0.02);
    world.stepSync(40);
    const p = planes(world);
    let worst = 0;
    for (let i = 0; i < PLANE; i++) worst = Math.max(worst, Math.abs(p.light[i] - p.pigment[0][i]), Math.abs(p.settledLight[i] - p.settled[0][i]));
    expect(worst).toBe(0);
  });
});

describe('wet light paint: brushes', () => {
  it('a wet brush lays light that flows with the paint, then bakes into the layer when it dries', async () => {
    const c = editor();
    c.paintStroke({ brushId: 'glow-wash', brush: { tip: { size: 60 } }, points: LINE, color: '#22d3ee', seed: 3 });
    expect(c.getState().wet.wet).toBe(true);
    expect(lightAt(c, 110, 80)).toBeGreaterThan(100);
    const before = sumLight(c);
    await c.advanceWet({ steps: 400 });
    // It moved: the light changed while the paint flowed.
    expect(sumLight(c)).not.toBe(before);
    c.dryPaint();
    expect(c.getState().wet.layerIds).toEqual([]);
    // Light went where the paint went, denser where the pigment is denser (the simulation moves them alike).
    const surface = (c.getActiveLayer() as PaintPixelLayer).surface;
    const light = Array.from({ length: 60 }, (_, i) => lightAt(c, 110, 20 + i));
    const paint = Array.from({ length: 60 }, (_, i) => readPixel(surface, 110, 20 + i)[3]);
    light.forEach((v, i) => expect(v > 0, `y ${20 + i}`).toBe(paint[i] > 0));
    expect(paint.some((v) => v === 0) && paint.some((v) => v > 0)).toBe(true);
    expect(correlation(light.filter((_, i) => paint[i] > 0), paint.filter((v) => v > 0))).toBeGreaterThan(0.9);
    // Ordinary light paint now: glow and spill in the render.
    expect(c.lightOf().hasLight).toBe(true);
  });

  it('on dark paper a glowing glaze shows and glows its own hue, where a plain glaze only darkens', () => {
    const paint = (brushId: string) => {
      const c = editor();
      c.setPaper({ color: '#101626' } as never);
      c.paintStroke({ brushId, brush: { tip: { size: 50 } }, points: LINE, color: '#22d3ee', seed: 3 });
      c.dryPaint();
      const { data } = c.compositePixels();
      const i = (80 * W + 110) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const plain = paint('watercolor-round');
    const glow = paint('glow-wash');
    expect(plain[1] + plain[2]).toBeLessThan(80);
    // Cyan: much more green and blue than red, and bright.
    expect(glow[1]).toBeGreaterThan(150);
    expect(glow[2]).toBeGreaterThan(150);
    expect(glow[0]).toBeLessThan(glow[1] - 60);
  });

  it('plain wet paint over glowing paint dims it; blot lifts it; re-wetting lifts dried light', async () => {
    const c = editor();
    c.paintStroke({ brushId: 'glow-wash', brush: { tip: { size: 50 } }, points: LINE, color: '#a855f7', seed: 1 });
    c.dryPaint();
    const lit = lightAt(c, 110, 80);
    expect(lit).toBeGreaterThan(100);
    // A dark wash over it, without light.
    c.paintStroke({ brushId: 'watercolor-round', brush: { tip: { size: 50 } }, points: [{ x: 90, y: 80 }, { x: 130, y: 80 }], color: '#1e293b', seed: 2 });
    c.dryPaint();
    expect(lightAt(c, 110, 80)).toBeLessThan(lit - 20);
    expect(lightAt(c, 60, 80)).toBeGreaterThan(100);

    const d = editor();
    d.paintStroke({ brushId: 'glow-wash', brush: { tip: { size: 50 } }, points: LINE, color: '#a855f7', seed: 1 });
    const wet = lightAt(d, 70, 80);
    d.paintStroke({ brushId: 'blot', brush: { tip: { size: 40 } }, points: [{ x: 60, y: 80 }, { x: 80, y: 80 }] });
    d.dryPaint();
    expect(lightAt(d, 70, 80)).toBeLessThan(wet * 0.8);

    // Re-wetting: clear water over the dried glow lifts some of its light back into the water, which moves it.
    const e = editor();
    e.paintStroke({ brushId: 'glow-wash', brush: { tip: { size: 50 } }, points: LINE, color: '#a855f7', seed: 1 });
    e.dryPaint();
    const dried = e.document.light![id(e)];
    e.paintStroke({ brushId: 'add-water', brush: { tip: { size: 50 }, wet: { rewet: 1 } }, points: [{ x: 100, y: 80 }, { x: 120, y: 80 }, { x: 140, y: 80 }] });
    const world = e.wet.world!;
    expect(world.getLight(id(e))).not.toBe(dried);
    await e.advanceWet({ steps: 60 });
    e.dryPaint();
    expect(e.document.light![id(e)]).not.toBe(dried);
  });

  it('wet blend and wet smudge move light with the pigment', async () => {
    const c = editor();
    c.paintStroke({ brushId: 'glow-wash', brush: { tip: { size: 30 } }, points: LINE, color: '#22d3ee', seed: 3 });
    expect(lightAt(c, 110, 112)).toBe(0);
    c.paintStroke({ brushId: 'wet-drag', brush: { tip: { size: 30 } }, points: Array.from({ length: 16 }, (_, i) => ({ x: 110, y: 76 + i * 3 })) });
    c.dryPaint();
    expect(lightAt(c, 110, 112)).toBeGreaterThan(0);
  });

  it('undoes, replays exactly, and saves wet light dried where it is', async () => {
    const c = editor();
    c.paintStroke({ brushId: 'glow-wash', points: LINE, color: '#f472b6', seed: 5 });
    await c.advanceWet({ steps: 120 });
    // Saving dries the light as it dries the paint, without changing the editor.
    const saved = JSON.parse(JSON.stringify(c.toJSON()));
    expect(c.getState().wet.wet).toBe(true);
    c.dryPaint();
    const pixels = Buffer.from(c.compositePixels().data);
    const d = editor();
    expect(d.loadJSON(saved)).toEqual([]);
    expect(Buffer.from(d.compositePixels().data).equals(pixels)).toBe(true);
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(pixels)).toBe(true);
    t.dispose();
    c.undo(); // the dry
    c.undo(); // the stroke
    expect(c.lightOf().hasLight).toBe(false);
    expect((c.getActiveLayer() as PaintPixelLayer).surface.tiles.size).toBe(0);
  });

  it('clear_light on wet glowing paint dries it first and takes its light away in one undo step', async () => {
    const c = editor();
    c.paintStroke({ brushId: 'glow-wash', points: LINE, color: '#f472b6', seed: 5 });
    expect(c.clearLight()).toEqual({ layerId: id(c), cleared: true });
    expect(c.getState().wet.wet).toBe(false);
    expect(c.lightOf().hasLight).toBe(false);
    c.undo();
    expect(c.getState().wet.wet).toBe(true);
    expect(c.lightOf().hasLight).toBe(true);
  });
});
