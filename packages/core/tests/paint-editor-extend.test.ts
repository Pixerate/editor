import { describe, expect, it } from 'vitest';
import { PaintEditorController, PaintEditorError, createPaintEditorToolProvider, type PaintPixelLayer, type PixelImage } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';

const wave = (y: number, n = 30, x0 = 10, x1 = 150) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y + Math.sin(i / 4) * 10, pressure: 0.6 + 0.4 * Math.sin(i / 7) }));
const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

/** `img` cropped to `rect`. */
function crop(img: PixelImage, x: number, y: number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let r = 0; r < height; r++) out.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + width) * 4), r * width * 4);
  return out;
}

const editor = () => new PaintEditorController({ width: 160, height: 120, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0 } });

function paintSome(c: PaintEditorController) {
  c.fillLayer({ color: '#f3e0b5', grain: 0.6 });
  c.paintStroke({ points: wave(40), brushId: 'soft-pastel', color: '#c0392b' });
  c.addLayer({ name: 'Ink' });
  c.paintStroke({ points: wave(80), brushId: 'ink-pen', color: '#111111' });
}

describe('extendCanvas', () => {
  it.each([
    ['left', { left: 37 }],
    ['top', { top: 300 }],
    ['right', { right: 50 }],
    ['bottom', { bottom: 21 }],
    ['every side', { left: 5, top: 9, right: 13, bottom: 17 }],
  ])('extends on the %s, keeping the paint and the paper grain where they were', (_side, by) => {
    const c = editor();
    paintSome(c);
    const before = c.compositePixels();
    const r = c.extendCanvas(by);
    const left = by.left ?? 0;
    const top = by.top ?? 0;
    const width = 160 + left + (by.right ?? 0);
    const height = 120 + top + (by.bottom ?? 0);
    expect(r).toEqual({ canvas: { width, height, dpi: 300 }, rect: { x: 0 - left, y: 0 - top, width, height }, origin: { x: 0 - left, y: 0 - top } });
    expect(c.document.canvas).toMatchObject({ width, height });
    const after = c.compositePixels();
    // Paint and paper both: the grain moved with the paint.
    expect(same(crop(after, left, top, 160, 120), before.data)).toBe(true);
    expect(c.getState().undoLabel).toBe('Extend canvas');
    // New strokes land at the new coordinates.
    c.paintStroke({ points: [{ x: 1, y: 1 }, { x: 4, y: 4 }], brushId: 'ink-pen' });
  });

  it('is one undo step: undo brings back the size, origin, guides and pixels', () => {
    const c = editor();
    paintSome(c);
    c.setSymmetry({ mode: 'vertical', center: { x: 80, y: 60 } });
    c.setPerspective({ enabled: true, points: [{ x: 10, y: 20 }] });
    const stencil = c.addStencil({ kind: 'ruler', from: { x: 0, y: 0 }, to: { x: 50, y: 50 } });
    const before = c.compositePixels();
    const doc = c.document;
    c.extendCanvas({ left: 40, top: 30 });
    expect(c.document.origin).toEqual({ x: -40, y: -30 });
    expect(c.document.paper.offset).toEqual({ x: 40, y: 30 });
    expect(c.getState().guides.symmetry.center).toEqual({ x: 120, y: 90 });
    expect(c.getState().guides.perspective.points).toEqual([{ x: 50, y: 50 }]);
    expect(c.getState().guides.stencils.find((s) => s.id === stencil.id)).toMatchObject({ from: { x: 40, y: 30 }, to: { x: 90, y: 80 } });
    expect((c.getActiveLayer() as PaintPixelLayer).offset).toEqual({ x: 40, y: 30 });
    expect(c.getStrokes()[0].points[0].x).toBeCloseTo(50);
    expect(c.undo()).toBe('Extend canvas');
    expect(c.document).toBe(doc);
    expect(c.getState().guides.symmetry.center).toEqual({ x: 80, y: 60 });
    expect(c.getState().guides.stencils.find((s) => s.id === stencil.id)).toMatchObject({ from: { x: 0, y: 0 } });
    expect(same(c.compositePixels().data, before.data)).toBe(true);
    expect(c.redo()).toBe('Extend canvas');
    expect(c.document.canvas).toMatchObject({ width: 200, height: 150 });
    expect(c.getState().guides.symmetry.center).toEqual({ x: 120, y: 90 });
  });

  it('extends again on top of an earlier extension', () => {
    const c = editor();
    paintSome(c);
    const before = c.compositePixels();
    c.extendCanvas({ left: 10 });
    const r = c.extendCanvas({ left: 20, top: 5 });
    expect(r.origin).toEqual({ x: -30, y: -5 });
    expect(r.rect).toEqual({ x: -20, y: -5, width: 190, height: 125 });
    expect(same(crop(c.compositePixels(), 30, 5, 160, 120), before.data)).toBe(true);
  });

  it('dries wet paint first, keeps the wet settings, and undo brings the wet paint back', async () => {
    const c = editor();
    c.paintStroke({ points: wave(60), brushId: 'watercolor-round', color: '#1d4ed8' });
    await c.wetIdle();
    const layerId = c.document.activeLayerId!;
    c.setWetParams(layerId, { viscosity: 0.8 });
    expect(c.getState().wet.wet).toBe(true);
    const dried = c.compositePixels({ wet: 'dried' });
    c.extendCanvas({ left: 16, bottom: 8 });
    expect(c.getState().wet.wet).toBe(false);
    expect(same(crop(c.compositePixels(), 16, 0, 160, 120), dried.data)).toBe(true);
    expect(c.wetLayerInfo(layerId).params.viscosity).toBeCloseTo(0.8);
    // Wet paint works on the larger canvas, at the new coordinates.
    c.paintStroke({ points: wave(100, 30, 2, 170), brushId: 'watercolor-round', color: '#b91c1c' });
    await c.wetIdle();
    expect(c.getState().wet.wet).toBe(true);
    c.undo();
    c.undo();
    expect(c.document.canvas).toMatchObject({ width: 160, height: 120 });
    expect(c.getState().wet.wet).toBe(true);
  });

  describe('by whole wet tiles, while paint is wet', () => {
    // 2 × 2 wet tiles, strokes that cross the tile edges, and few steps: the flow test took
    // 5.6 s on CI with 30-point strokes, a 512 px shift down and 20 + 60 steps.
    const wetEditor = () => new PaintEditorController({ width: 512, height: 512, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0 } });
    const across = (y: number) => wave(y, 16, 140, 380);
    const down = Array.from({ length: 16 }, (_, i) => ({ x: 256 + Math.sin(i / 2) * 10, y: 140 + (240 * i) / 15, pressure: 0.7 }));

    it('keeps the paint wet, in place, and it flows on exactly as if the canvas had not grown', async () => {
      const a = wetEditor();
      const b = wetEditor();
      for (const c of [a, b]) {
        c.paintStroke({ points: across(256), brushId: 'watercolor-round', color: '#1d4ed8' });
        await c.advanceWet({ steps: 6 });
      }
      const before = b.compositePixels();
      b.extendCanvas({ left: 256, top: 256, right: 40, bottom: 7 });
      expect(b.getState().wet.wet).toBe(true);
      expect(same(crop(b.compositePixels(), 256, 256, 512, 512), before.data)).toBe(true);

      // A second stroke mixes into the first, and the paint moves on as it would have.
      a.paintStroke({ points: down, brushId: 'watercolor-round', color: '#b91c1c' });
      b.paintStroke({ points: down.map((p) => ({ ...p, x: p.x + 256, y: p.y + 256 })), brushId: 'watercolor-round', color: '#b91c1c' });
      const mixed = a.compositePixels();
      for (const c of [a, b]) await c.advanceWet({ steps: 12 });
      // The paint did move on, so matching pixels mean it moved the same way.
      expect(same(a.compositePixels().data, mixed.data)).toBe(false);
      expect(same(crop(b.compositePixels(), 256, 256, 512, 512), a.compositePixels().data)).toBe(true);
    });

    it('is one undo step: undo brings back the old size with the paint still wet, redo the larger one', async () => {
      const c = wetEditor();
      c.paintStroke({ points: across(256), brushId: 'watercolor-round', color: '#1d4ed8' });
      await c.advanceWet({ steps: 10 });
      const small = c.compositePixels();
      c.extendCanvas({ left: 256 });
      const large = c.compositePixels();
      c.undo();
      expect(c.document.canvas).toMatchObject({ width: 512, height: 512 });
      expect(c.getState().wet.wet).toBe(true);
      expect(same(c.compositePixels().data, small.data)).toBe(true);
      c.redo();
      expect(c.document.canvas).toMatchObject({ width: 768, height: 512 });
      expect(c.getState().wet.wet).toBe(true);
      expect(same(c.compositePixels().data, large.data)).toBe(true);
    });

    it('moves a wet layer that had an offset into canvas space', async () => {
      const c = wetEditor();
      c.paintStroke({ points: across(256), brushId: 'watercolor-round', color: '#1d4ed8' });
      c.extendCanvas({ top: 256 });
      const layer = c.listLayers().find((l) => l.id === c.document.activeLayerId);
      expect(layer).toBeDefined();
      const doc = c.document.layers.find((l) => l.id === layer!.id) as PaintPixelLayer;
      expect(doc.offset).toEqual({ x: 0, y: 0 });
    });
  });

  it('keeps sticker layers editable in place', () => {
    const c = editor();
    c.paintStroke({ points: wave(60), brushId: 'sticker-stars', seed: 3 });
    const layerId = c.document.activeLayerId!;
    const stickers = c.document.stickers![layerId];
    const before = c.compositePixels({ paper: false });
    c.extendCanvas({ left: 20, top: 10 });
    const moved = c.document.stickers![layerId];
    expect(moved[0].x).toBeCloseTo(stickers[0].x + 20, 5);
    expect(moved[0].y).toBeCloseTo(stickers[0].y + 10, 5);
    expect(same(crop(c.compositePixels({ paper: false }), 20, 10, 160, 120), before.data)).toBe(true);
    // Re-rendering the layer from its stickers lands them where they were (only the stamps'
    // shading noise, keyed on document pixels, differs by a few levels).
    c.replaceStickers(layerId, moved);
    const again = crop(c.compositePixels({ paper: false }), 20, 10, 160, 120);
    let worst = 0;
    for (let i = 0; i < again.length; i++) worst = Math.max(worst, Math.abs(again[i] - before.data[i]));
    expect(worst).toBeLessThanOrEqual(8);
  });

  it('round-trips through toJSON / loadJSON', () => {
    const c = editor();
    paintSome(c);
    c.extendCanvas({ left: 24, top: 12, right: 8 });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    expect(json).toMatchObject({ width: 192, height: 132, origin: { x: -24, y: -12 } });
    expect(json.paper.offset).toEqual({ x: 24, y: 12 });
    const d = new PaintEditorController();
    expect(d.loadJSON(json)).toEqual([]);
    expect(d.document.canvas).toEqual(c.document.canvas);
    expect(d.document.origin).toEqual({ x: -24, y: -12 });
    expect(d.document.paper.offset).toEqual({ x: 24, y: 12 });
    expect(same(d.compositePixels().data, c.compositePixels().data)).toBe(true);
    // A document that was never extended writes no origin.
    expect(new PaintEditorController({ width: 8, height: 8 }).toJSON().origin).toBeUndefined();
  });

  it('keeps the paper grain under the paint when the paper changes, and a new canvas resets it', () => {
    const c = editor();
    c.extendCanvas({ left: 7 });
    c.setPaper({ preset: 'rough-watercolor' });
    expect(c.document.paper.offset).toEqual({ x: 7, y: 0 });
    c.newCanvas();
    expect(c.document.paper.offset).toBeUndefined();
    expect(c.document.origin).toBeUndefined();
  });

  it('replays the extended painting to the same pixels', async () => {
    const c = editor();
    paintSome(c);
    c.extendCanvas({ left: 30, top: 20 });
    c.paintStroke({ points: wave(30, 30, 0, 180), brushId: 'charcoal-stick' });
    const t = c.createReplayTarget(1);
    const { replayPainting } = await import('../src/paint-editor/replay');
    await replayPainting(c.document, t);
    // The fill covered the old canvas only, so compare the paint of the stroke layers.
    const ink = c.listLayers().find((l) => l.name === 'Ink')!.id;
    expect(same(t.compositePixels({ paper: false, layerIds: [ink] }).data, c.compositePixels({ paper: false, layerIds: [ink] }).data)).toBe(true);
    t.dispose();
  });

  it('refuses bad sizes with a reason, changing nothing', () => {
    const c = editor();
    const doc = c.document;
    expect(() => c.extendCanvas({})).toThrow(/Nothing to extend/);
    expect(() => c.extendCanvas({ left: -1 })).toThrow(/left is -1; use a whole number/);
    expect(() => c.extendCanvas({ top: 1.5 })).toThrow(PaintEditorError);
    expect(() => c.extendCanvas({ right: 20000 })).toThrow(/limit is 16384 px per side/);
    const s = c.beginStroke({ start: { x: 1, y: 1 } });
    expect(() => c.extendCanvas({ left: 1 })).toThrow(/stroke is in progress/);
    s.cancel();
    expect(c.document).toBe(doc);
  });
});

describe('extend_canvas tool', () => {
  const setup = () => {
    const c = new PaintEditorController({ width: 64, height: 48 });
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c));
    return { c, r };
  };

  it('extends the canvas and returns the rect and origin; get_canvas_info reads the origin', async () => {
    const { r } = setup();
    const res = await r.callTool('extend_canvas', { left: 16, bottom: 4 });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ canvas: { width: 80, height: 52, dpi: 300 }, rect: { x: -16, y: 0, width: 80, height: 52 }, origin: { x: -16, y: 0 } });
    const info = await r.callTool('get_canvas_info', {});
    expect(info.structuredContent).toMatchObject({ width: 80, height: 52, origin: { x: -16, y: 0 } });
    expect((await r.callTool('undo_paint', {})).isError).toBeFalsy();
    expect((await r.callTool('get_canvas_info', {})).structuredContent).toMatchObject({ width: 64, origin: { x: 0, y: 0 } });
  });

  it('refuses invalid arguments with a useful error', async () => {
    const { r, c } = setup();
    const empty = await r.callTool('extend_canvas', {});
    expect(empty.isError).toBe(true);
    expect(JSON.stringify(empty.content)).toMatch(/Nothing to extend/);
    expect((await r.callTool('extend_canvas', { left: -4 })).isError).toBe(true);
    expect((await r.callTool('extend_canvas', { middle: 4 })).isError).toBe(true);
    const big = await r.callTool('extend_canvas', { right: 16380 });
    expect(big.isError).toBe(true);
    expect(JSON.stringify(big.content)).toMatch(/limit is 16384/);
    expect(c.document.canvas.width).toBe(64);
  });
});
