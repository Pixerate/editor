import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import { readPixel } from '../src/raster/surface';
import type { PaintPixelLayer } from '../src/paint-editor/document';

const line = (y = 128, x0 = 60, x1 = 200) => Array.from({ length: 30 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 29, y, pressure: 0.8 }));

async function editor(w = 320, h = 256) {
  const c = new PaintEditorController({ width: w, height: h, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0 } });
  return c;
}

function layerPixel(c: PaintEditorController, x: number, y: number) {
  const l = c.getActiveLayer() as PaintPixelLayer;
  return readPixel(l.surface, x, y);
}

describe('paint editor wet media', () => {
  it('a watercolour stroke is wet, shows on the layer, and is one undo step', async () => {
    const c = await editor();
    const r = c.paintStroke({ points: line(), brushId: 'watercolor-round', color: '#1d4ed8' });
    await c.wetReady();
    expect(r.wet).toBe(true);
    expect(r.strokeId).toBeTruthy();
    expect(r.bounds).not.toBeNull();
    expect(c.getState().wet.wet).toBe(true);
    expect(layerPixel(c, 130, 128)[3]).toBeGreaterThan(0);
    const stroke = c.getStrokes().at(-1)!;
    expect(stroke.steps?.length).toBe(stroke.points.length);
    expect(c.undo()).toBe('Watercolour round stroke');
    expect(c.getState().wet.wet).toBe(false);
    expect(layerPixel(c, 130, 128)[3]).toBe(0);
    c.redo();
    expect(c.getState().wet.wet).toBe(true);
    expect(layerPixel(c, 130, 128)[3]).toBeGreaterThan(0);
    c.dispose();
  });

  it('flows over time, dries at once with dry_paint, and the layer becomes ordinary pixels', async () => {
    const c = await editor();
    c.paintStroke({ points: line(), brushId: 'watercolor-round', color: '#1d4ed8' });
    await c.wetReady();
    const a = await c.advanceWet({ steps: 64 });
    expect(a.steps).toBe(64);
    expect(a.stillWet).toBe(true);
    const d = c.dryPaint();
    expect(d.stillWet).toBe(false);
    expect(d.dried[0].bounds).not.toBeNull();
    expect(c.getState().wet.layerIds).toEqual([]);
    expect(layerPixel(c, 130, 128)[3]).toBeGreaterThan(0);
    expect(c.historyLabels().undo.at(-1)).toBe('Dry paint');
    c.undo();
    expect(c.getState().wet.wet).toBe(true);
    c.dispose();
  });

  it('saves wet paint dried, without drying the editor', async () => {
    const c = await editor();
    c.paintStroke({ points: line(), brushId: 'watercolor-wash', color: '#b91c1c' });
    await c.wetReady();
    const saved = c.toJSON();
    expect(c.getState().wet.wet).toBe(true);
    const d = new PaintEditorController({ width: 10, height: 10 });
    d.loadJSON(saved);
    const fresh = await editor();
    fresh.loadJSON(saved);
    // The saved pixels are the dried bake of the paint as it was.
    const dried = c.compositePixels({ wet: 'dried' });
    const reopened = d.compositePixels();
    expect(Buffer.from(reopened.data).equals(Buffer.from(dried.data))).toBe(true);
    expect((saved as { wet?: unknown }).wet).toBeDefined();
    c.dispose();
  });

  it('a dry brush on wet paint dries it first, in the same undo step', async () => {
    const c = await editor();
    c.paintStroke({ points: line(), brushId: 'watercolor-round', color: '#1d4ed8' });
    c.paintStroke({ points: line(150), brushId: 'pencil-hb' });
    expect(c.getState().wet.layerIds).toEqual([]);
    c.undo();
    expect(c.getState().wet.wet).toBe(true);
    c.dispose();
  });

  it('is deterministic: the same strokes and steps give the same dried pixels', async () => {
    const run = async () => {
      const c = await editor();
      c.setCanvasTilt({ angle: 30 });
      c.wetPaper({ rect: { x: 40, y: 80, width: 200, height: 100 }, amount: 0.8 });
      c.paintStroke({ points: line(), brushId: 'watercolor-wash', color: '#0f766e', seed: 3 });
      await c.wetReady();
      // Differences show from the first steps; more steps only made it slow (100 + 70 took ~2.5 s).
      await c.advanceWet({ steps: 30 });
      c.paintStroke({ points: line(140, 80, 240), brushId: 'gouache', color: '#facc15', seed: 4 });
      await c.advanceWet({ steps: 20 });
      const out = c.exportPng();
      c.dispose();
      return Buffer.from(out).toString('base64');
    };
    expect(await run()).toBe(await run());
  });

  it('every wet tool runs', async () => {
    const c = await editor();
    c.paintStroke({ points: line(), brushId: 'watercolor-wash', color: '#1d4ed8' });
    for (const id of ['add-water', 'hair-dryer', 'blow', 'wet-blend', 'wet-drag', 'blot', 'gouache', 'watercolor-detail']) {
      const r = c.paintStroke({ points: line(130), brushId: id, color: '#a21caf' });
      expect(r.wet, id).toBeDefined();
      expect(r.dabs, id).toBeGreaterThan(0);
    }
    c.dispose();
  });

  it('renders thumbnails of wet brushes', () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    const t = c.brushThumbnail('watercolor-round');
    expect(t.data.length).toBe(t.width * t.height * 4);
    const blot = c.brushThumbnail('blot');
    expect(blot.width).toBeGreaterThan(0);
  });
});

describe('wet media agent tools', () => {
  it('paint, read, flow, dry, wet the paper and steer the water through the registry', async () => {
    const c = await editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await reg.callTool(name, args);
      return r;
    };
    const parse = (r: { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
    let r = await call('paint_stroke', { points: line(), brushId: 'watercolor-round', color: '#1d4ed8' });
    expect(r.isError).toBeFalsy();
    expect(parse(r).wet).toBe(true);
    r = await call('get_wet_paint');
    expect(parse(r).wet).toBe(true);
    expect(parse(r).layers[0].wetCells).toBeGreaterThan(0);
    r = await call('set_wet_settings', { granulation: 0.9, bloom: 1 });
    expect(parse(r).params.granulation).toBe(0.9);
    r = await call('set_wet_settings', { granulation: 2 });
    expect(r.isError).toBe(true);
    r = await call('set_flow_map', { kind: 'swirl', strength: 0.4 });
    expect(parse(r).flow.kind).toBe('swirl');
    r = await call('set_canvas_tilt', { angle: 45, direction: 0 });
    expect(parse(r).tilt.angle).toBe(45);
    r = await call('advance_wet_paint', { steps: 40 });
    expect(parse(r).steps).toBe(40);
    r = await call('wet_paper', { rect: { x: 0, y: 0, width: 100, height: 100 } });
    expect(parse(r).wet).toBe(true);
    r = await call('wet_paper', { rect: { x: 1000, y: 0, width: 10, height: 10 } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outside/);
    r = await call('pause_wet_paint', { paused: true, speed: 60 });
    expect(parse(r)).toMatchObject({ paused: true, speed: 60, stillWet: true });
    r = await call('set_water_overlay', { visible: true });
    expect(parse(r).visible).toBe(true);
    r = await call('dry_paint', { layerId: 'nope' });
    expect(r.isError).toBe(true);
    r = await call('dry_paint', {});
    expect(parse(r).stillWet).toBe(false);
    expect(parse(r).dried.length).toBe(1);
    r = await call('advance_wet_paint', { steps: 2000000 });
    expect(r.isError).toBe(true);
    c.dispose();
  });
});

describe('Engine B (WebGPU) setting, without a GPU', () => {
  it('reports why the GPU is not used, and forcing the CPU is a setting, not an undo step', async () => {
    const c = await editor();
    expect(c.wetEngine()).toMatchObject({ mode: 'auto', state: 'not-started', minTiles: 16 });
    c.paintStroke({ points: line(), brushId: 'watercolor-round', color: '#1d4ed8' });
    const info = await c.setWetEngine({});
    expect(info).toMatchObject({ mode: 'auto', state: 'unavailable', adapter: null, maxTiles: 0 });
    expect(info.reason).toMatch(/no WebGPU/);
    expect(info.cpu?.kind).toBe('wasm');
    const undo = c.getState().undoLabel;
    const off = await c.setWetEngine({ gpu: 'off', minTiles: 8 });
    expect(off).toMatchObject({ mode: 'off', state: 'off', minTiles: 8 });
    expect(c.getState().wet).toMatchObject({ gpu: 'off', gpuActive: false });
    expect(c.getState().undoLabel).toBe(undo);
    expect(c.wetState().engine.state).toBe('off');
    await expect(c.setWetEngine({ gpu: 'fast' as never })).rejects.toThrow(/gpu must be auto or off/);
    await expect(c.setWetEngine({ minTiles: 0 })).rejects.toThrow(/minTiles 0 is out of range/);
    c.dispose();
  });

  it('a GPU that cannot hold enough tiles is unavailable, with the reason', async () => {
    const tiny = { limits: { maxStorageBufferBindingSize: 16 << 20, maxBufferSize: 16 << 20 }, info: { vendor: 'tiny', architecture: 'test' }, requestDevice: async () => ({}) };
    const c = new PaintEditorController({ width: 320, height: 256, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0, gpuProvider: { requestAdapter: async () => tiny } } });
    c.paintStroke({ points: line(), brushId: 'watercolor-round', color: '#1d4ed8' });
    const info = await c.setWetEngine({ gpu: 'auto' });
    expect(info).toMatchObject({ state: 'unavailable', adapter: 'tiny test' });
    expect(info.reason).toMatch(/hold 1 wet tiles; at least 4/);
    c.dispose();
  });

  it('set_wet_engine and get_wet_paint through the tool registry', async () => {
    const c = await editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const parse = (r: { content: Array<{ text?: string }>; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
    let r = await reg.callTool('set_wet_engine', { gpu: 'off' });
    expect(r.isError).toBeFalsy();
    expect(parse(r).engine).toMatchObject({ mode: 'off', state: 'off' });
    r = await reg.callTool('get_wet_paint', {});
    expect(parse(r).engine.mode).toBe('off');
    r = await reg.callTool('set_wet_engine', { gpu: 'auto', minTiles: 4 });
    expect(parse(r).engine).toMatchObject({ mode: 'auto', minTiles: 4 });
    r = await reg.callTool('set_wet_engine', { gpu: 'gpu-only' });
    expect(r.isError).toBe(true);
    r = await reg.callTool('set_wet_engine', { gpu: 'auto', minTiles: 0 });
    expect(r.isError).toBe(true);
    r = await reg.callTool('set_wet_engine', {});
    expect(r.isError).toBe(true);
    c.dispose();
  });
});
