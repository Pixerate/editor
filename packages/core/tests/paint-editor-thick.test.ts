import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import { readPixel } from '../src/raster/surface';
import type { PaintPixelLayer } from '../src/paint-editor/document';

const line = (y = 128, x0 = 40, x1 = 260, n = 40) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y, pressure: 0.9 }));
const editor = () => new PaintEditorController({ width: 320, height: 256, paper: 'smooth', wet: { kernel: 'wasm', threads: 0 } });
const px = (c: PaintEditorController, x: number, y: number) => {
  const img = c.compositePixels();
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const layerPx = (c: PaintEditorController, x: number, y: number) => readPixel((c.getActiveLayer() as PaintPixelLayer).surface, x, y);

describe('thick paint', () => {
  it('an impasto stroke raises relief that is lit at render time (one undo step)', () => {
    const c = editor();
    const r = c.paintStroke({ points: line(), brushId: 'impasto-brush', color: '#c0392b' });
    expect(r.strokeId).toBeTruthy();
    const relief = c.reliefOf()!;
    expect(relief.maxHeight).toBeGreaterThan(40);
    expect(relief.bounds).not.toBeNull();
    // The layer keeps the paint's flat colour; the render shades it.
    const flat = layerPx(c, 150, 128);
    let differs = 0;
    for (let y = 110; y < 146; y += 2) {
      const l = layerPx(c, 150, y);
      const p = px(c, 150, y);
      if (l[3] === 255 && Math.abs(p[0] - l[0]) + Math.abs(p[1] - l[1]) + Math.abs(p[2] - l[2]) > 6) differs++;
    }
    expect(flat[3]).toBe(255);
    expect(differs).toBeGreaterThan(3);
    c.undo();
    expect(c.reliefOf()).toBeNull();
  });

  it('moving the light relights without repainting', () => {
    const c = editor();
    c.paintStroke({ points: line(), brushId: 'gloop-pen', color: '#2e86de' });
    const surface = (c.getActiveLayer() as PaintPixelLayer).surface;
    const undo = c.historyLabels().undo.length;
    const before = c.compositePixels().data.slice();
    c.setLighting({ azimuth: 135, elevation: 20 });
    expect((c.getActiveLayer() as PaintPixelLayer).surface).toBe(surface);
    expect(c.historyLabels().undo.length).toBe(undo);
    const after = c.compositePixels().data;
    let changed = 0;
    for (let i = 0; i < after.length; i += 4) if (after[i] !== before[i]) changed++;
    expect(changed).toBeGreaterThan(100);
    // Lit from above, the top of the bead is brighter than its bottom; from below, the other way round.
    c.setLighting({ azimuth: 0, elevation: 30 });
    const top = px(c, 150, 123);
    const bottom = px(c, 150, 133);
    expect(top[2]).toBeGreaterThan(bottom[2]);
    c.setLighting({ azimuth: 180 });
    expect(px(c, 150, 123)[2]).toBeLessThan(px(c, 150, 133)[2]);
  });

  it('the palette knife scrapes the relief flat; tube, roller and metallic paint each leave their mark', () => {
    const c = editor();
    c.paintStroke({ points: line(), brushId: 'paint-tube', color: '#f1c40f' });
    expect(c.reliefOf()!.maxHeight).toBeGreaterThan(150);
    const along = () => {
      const h = c.document.thick![c.document.activeLayerId!].height;
      let s = 0;
      for (let x = 60; x < 240; x++) s += readPixel(h, x, 128)[0];
      return s;
    };
    const tube = along();
    c.paintStroke({ points: line(), brushId: 'palette-knife' });
    expect(along()).toBeLessThan(tube * 0.6);
    c.addLayer({ name: 'Roller' });
    c.paintStroke({ points: line(60), brushId: 'paint-roller', color: '#16a085' });
    expect(c.reliefOf()!.maxHeight).toBeGreaterThan(10);
    c.addLayer({ name: 'Gold' });
    c.paintStroke({ points: line(200), brushId: 'metallic-paint', color: '#d4a017' });
    const id = c.document.activeLayerId!;
    const m = c.document.thick![id].material;
    expect(readPixel(m, 150, 200)[1]).toBeGreaterThan(200);
  });

  it('paint runs out along the stroke with a low load, and thinner flattens it', () => {
    const c = editor();
    c.paintStroke({ points: line(), brushId: 'impasto-brush', brush: { impasto: { load: 0, thickness: 1 } }, color: '#8e44ad' });
    const ch = c.document.thick![c.document.activeLayerId!];
    const mean = (x0: number) => {
      let s = 0;
      for (let y = 112; y < 144; y++) for (let x = x0; x < x0 + 20; x++) s += readPixel(ch.height, x, y)[0];
      return s;
    };
    expect(mean(45)).toBeGreaterThan(mean(230) * 1.5);
    const d = editor();
    d.paintStroke({ points: line(), brushId: 'impasto-brush', color: '#8e44ad' });
    const thick = d.reliefOf()!.maxHeight;
    const e = editor();
    e.paintStroke({ points: line(), brushId: 'impasto-brush', brush: { impasto: { thinner: 1 } }, color: '#8e44ad' });
    expect(e.reliefOf()!.maxHeight).toBeLessThan(thick);
  });

  it('saves and opens relief, material and lighting', () => {
    const c = editor();
    c.paintStroke({ points: line(), brushId: 'metallic-paint', color: '#b87333' });
    c.setLighting({ azimuth: 200, elevation: 25, relief: 0.9 });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    expect(json.layerChannels).toBeDefined();
    const d = editor();
    expect(d.loadJSON(json)).toEqual([]);
    expect(d.getLighting()).toEqual({ azimuth: 200, elevation: 25, relief: 0.9 });
    expect(d.reliefOf()!.maxHeight).toBe(c.reliefOf()!.maxHeight);
    expect(Buffer.from(d.compositePixels().data).equals(Buffer.from(c.compositePixels().data))).toBe(true);
    expect(d.toJSON().layerChannels).toEqual(json.layerChannels);
  });

  it('metallic paper catches the light', () => {
    const c = new PaintEditorController({ width: 64, height: 64, paper: 'cold-pressed' });
    const plain = c.compositePixels().data.slice();
    c.setPaper({ metallic: 1 });
    const metal = c.compositePixels().data;
    let diff = 0;
    for (let i = 0; i < metal.length; i += 4) diff += Math.abs(metal[i] - plain[i]);
    expect(diff / (64 * 64)).toBeGreaterThan(2);
  });
});

describe('wet oil', () => {
  it('an oil layer takes the oil medium and stays wet; instant dry dries each stroke at once', async () => {
    const c = editor();
    const r = c.paintStroke({ points: line(), brushId: 'oil-round', color: '#1e3799' });
    expect(r.wet).toBe(true);
    expect(c.wetLayerInfo().params.viscosity).toBeGreaterThan(0.9);
    await c.wetReady();
    // Oil barely evaporates (watercolour is 0.45 and dries here in ~450 steps).
    expect(c.wetLayerInfo().params.evaporation).toBeLessThan(0.1);
    await c.advanceWet({ steps: 200 });
    expect(c.getState().wet.wet).toBe(true);
    // A second stroke picks up and mixes the wet oil (pigment mixing).
    const r2 = c.paintStroke({ points: line(132), brushId: 'oil-round', brush: { behavior: { dirty: true } }, color: '#f6e58d' });
    expect(r2.mixerLoad?.pickup).toBeTruthy();
    c.setInstantDry(true);
    const r3 = c.paintStroke({ points: line(200), brushId: 'oil-flat', color: '#e55039' });
    expect(r3.wet).toBe(false);
    expect(c.getState().wet.wet).toBe(false);
    c.undo();
    expect(c.getState().wet.wet).toBe(true);
    c.dispose();
  });
});

describe('thick paint agent tools', () => {
  it('lights, reads and flattens relief, and switches instant dry', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const call = (name: string, args: Record<string, unknown> = {}) => reg.callTool(name, args);
    const parse = (r: { content: Array<{ text?: string }>; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
    await call('paint_stroke', { points: line(), brushId: 'impasto-brush', color: '#c0392b' });
    let r = await call('get_relief', {});
    expect(parse(r).relief.maxHeight).toBeGreaterThan(0);
    r = await call('set_lighting', { azimuth: 90, elevation: 30 });
    expect(parse(r)).toMatchObject({ azimuth: 90, elevation: 30 });
    r = await call('set_lighting', { elevation: 2 });
    expect(r.isError).toBe(true);
    r = await call('flatten_relief', {});
    expect(parse(r).flattened).toBe(true);
    r = await call('get_relief', {});
    expect(parse(r).relief).toBeNull();
    r = await call('set_instant_dry', { on: true });
    expect(parse(r).instantDry).toBe(true);
    r = await call('paint_stroke', { points: line(), brushId: 'paint-tube', brush: { impasto: { thickness: 2 } } });
    expect(r.isError).toBe(true);
    c.dispose();
  });
});
