import { describe, expect, it } from 'vitest';
import {
  PaintEditorController,
  createPaintEditorToolProvider,
  deviceOrientationToViewTilt,
} from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import { readPixel } from '../src/raster/surface';
import type { PaintPixelLayer } from '../src/paint-editor/document';

const W = 240;
const H = 160;
const line = (y = 80, x0 = 40, x1 = 200, n = 36, pressure = 0.9) =>
  Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y, pressure }));
const editor = () => new PaintEditorController({ width: W, height: H, paper: 'smooth', wet: { kernel: 'wasm', threads: 0, gpu: 'off' } });
const px = (c: PaintEditorController, x: number, y: number) => {
  const img = c.compositePixels();
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

describe('structural colour & thin-film iridescence', () => {
  it('built-in iridescent presets (scarab-lacquer, soap-film, pearl-glaze) write film channel and shift hue with view tilt', () => {
    const c = editor();
    c.paintStroke({ points: line(80), brushId: 'scarab-lacquer', color: '#1b4332' });
    const relief = c.reliefOf()!;
    expect(relief.maxHeight).toBeGreaterThan(20);
    expect(relief.bounds).not.toBeNull();
    const id = c.document.activeLayerId!;
    const filmPx = readPixel(c.document.thick![id].film, 120, 80);
    expect(filmPx[3]).toBeGreaterThan(200);

    const flatView = px(c, 120, 76);
    const undoBefore = c.historyLabels().undo.length;
    c.setViewTilt({ x: 0.85, y: -0.65 });
    expect(c.getViewTilt()).toEqual({ x: 0.85, y: -0.65 });
    expect(c.historyLabels().undo.length).toBe(undoBefore);
    const tiltedView = px(c, 120, 76);
    const delta = Math.abs(tiltedView[0] - flatView[0]) + Math.abs(tiltedView[1] - flatView[1]) + Math.abs(tiltedView[2] - flatView[2]);
    expect(delta).toBeGreaterThan(12);
  });

  it('works on flat paint without impasto height and shifts colour when viewTilt or light changes', () => {
    const c = editor();
    c.paintStroke({ points: line(80), brushId: 'soap-film', color: '#22223b' });
    const relief = c.reliefOf()!;
    expect(relief.maxHeight).toBe(0);
    expect(relief.bounds).not.toBeNull();

    const base = px(c, 120, 80);
    c.setViewTilt({ x: 0.9, y: 0.7 });
    const tilted = px(c, 120, 80);
    expect(Math.abs(tilted[0] - base[0]) + Math.abs(tilted[1] - base[1]) + Math.abs(tilted[2] - base[2])).toBeGreaterThan(10);

    c.setLighting({ azimuth: 120, elevation: 15 });
    const relit = px(c, 120, 80);
    expect(Math.abs(relit[0] - tilted[0]) + Math.abs(relit[1] - tilted[1]) + Math.abs(relit[2] - tilted[2])).toBeGreaterThan(8);
  });

  it('pressureToThickness shifts interference thickness and hue between light and heavy pressure', () => {
    const c = editor();
    c.paintStroke({
      points: line(50, 40, 200, 36, 0.15),
      brushId: 'ink-pen',
      brush: {
        tip: { size: 28, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureSize: false, pressureOpacity: false },
        iridescence: { thickness: 520, pressureToThickness: 1, ior: 1.5 },
      },
      color: '#1e293b',
    });
    c.paintStroke({
      points: line(110, 40, 200, 36, 1.0),
      brushId: 'ink-pen',
      brush: {
        tip: { size: 28, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureSize: false, pressureOpacity: false },
        iridescence: { thickness: 520, pressureToThickness: 1, ior: 1.5 },
      },
      color: '#1e293b',
    });
    const id = c.document.activeLayerId!;
    const film = c.document.thick![id].film;
    const lowD = readPixel(film, 120, 50)[0];
    const highD = readPixel(film, 120, 110)[0];
    expect(highD).toBeGreaterThan(lowD + 30);

    const lowRgb = px(c, 120, 50);
    const highRgb = px(c, 120, 110);
    const diff = Math.abs(highRgb[0] - lowRgb[0]) + Math.abs(highRgb[1] - lowRgb[1]) + Math.abs(highRgb[2] - lowRgb[2]);
    expect(diff).toBeGreaterThan(15);
  });

  it('saves and restores film channel in document JSON, while viewTilt stays transient; erasing and flattenRelief clear film', () => {
    const c = editor();
    c.paintStroke({ points: line(80), brushId: 'pearl-glaze', color: '#f8fafc' });
    c.setViewTilt({ x: 0.5, y: -0.4 });
    const id = c.document.activeLayerId!;
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    expect(json.layerChannels?.[id]?.film).toBeDefined();
    expect((json as Record<string, unknown>).viewTilt).toBeUndefined();

    const restored = editor();
    expect(restored.loadJSON(json)).toEqual([]);
    expect(restored.getViewTilt()).toEqual({ x: 0, y: 0 });
    expect(restored.reliefOf()!.bounds).toEqual(c.reliefOf()!.bounds);

    // Erasing removes film where erased (and drops the layer's thick channels when completely erased)
    c.paintStroke({ points: line(80), brushId: 'eraser-hard', brush: { tip: { size: 40 } } });
    expect(c.reliefOf()).toBeNull();

    // flattenRelief removes thick channels including film
    restored.flattenRelief();
    expect(restored.reliefOf()).toBeNull();
    expect((restored.getActiveLayer() as PaintPixelLayer).surface.tiles.size).toBeGreaterThan(0);
  });

  it('set_view_tilt and get_view_tilt tools validate inputs and return descriptive errors', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await reg.callTool(name, args);
      return { error: r.isError ? (r.content[0] as { text: string }).text : null, data: r.structuredContent as Record<string, unknown> };
    };

    const initial = await call('get_view_tilt');
    expect(initial.error).toBeNull();
    expect(initial.data).toEqual({ x: 0, y: 0 });

    const updated = await call('set_view_tilt', { x: 0.4, y: -0.75 });
    expect(updated.error).toBeNull();
    expect(updated.data).toEqual({ x: 0.4, y: -0.75 });
    expect((await call('get_view_tilt')).data).toEqual({ x: 0.4, y: -0.75 });

    const rangeErrX = await call('set_view_tilt', { x: 1.5 });
    expect(rangeErrX.error).toMatch(/x/);

    const rangeErrY = await call('set_view_tilt', { y: -2 });
    expect(rangeErrY.error).toMatch(/y/);

    expect(() => c.setViewTilt({ x: 1.5 })).toThrow(/x .* out of range; use -1\.\.1/);
    expect(() => c.setViewTilt({ y: -2 })).toThrow(/y .* out of range; use -1\.\.1/);
  });

  it('deviceOrientationToViewTilt maps beta and gamma angles into clamped -1..1 tilt coordinates', () => {
    expect(deviceOrientationToViewTilt({ beta: 45, gamma: 0 })).toEqual({ x: 0, y: 0 });
    expect(deviceOrientationToViewTilt({ beta: 80, gamma: 35 })).toEqual({ x: 1, y: 1 });
    expect(deviceOrientationToViewTilt({ beta: 10, gamma: -35 })).toEqual({ x: -1, y: -1 });
  });
});
