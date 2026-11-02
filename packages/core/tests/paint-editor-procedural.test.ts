import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider, replayPainting } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import { readPixel } from '../src/raster/surface';
import { oklabToOklch, rgbToOklab } from '../src/color/convert';

const hexToRgba = (hex: string) => ({ r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255, a: 1 });
import type { PaintPixelLayer } from '../src/paint-editor/document';
import { stickerSurface } from '../src/paint-editor/stickers';
import type { TiledSurface } from '../src/raster/surface';

/** The composite with the active layer's pixels swapped for `surface`. */
const compositeOf = (c: PaintEditorController, surface: TiledSurface) => {
  const d = new PaintEditorController({ width: c.document.canvas.width, height: c.document.canvas.height, paper: 'smooth' });
  d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())));
  (d as unknown as { doc: { layers: PaintPixelLayer[] } }).doc.layers = d.document.layers.map((l) => (l.id === c.document.activeLayerId ? { ...(l as PaintPixelLayer), surface } : l));
  return d.compositePixels().data;
};

const wave = (y: number, n = 40) => Array.from({ length: n }, (_, i) => ({ x: 20 + i * 6, y: y + Math.sin(i / 4) * 10, pressure: 0.5 + 0.5 * Math.sin((i / (n - 1)) * Math.PI) }));
const editor = () => new PaintEditorController({ width: 280, height: 220, paper: 'smooth' });
const covered = (c: PaintEditorController) => {
  const s = (c.getActiveLayer() as PaintPixelLayer).surface;
  let n = 0;
  for (let y = 0; y < 220; y += 2) for (let x = 0; x < 280; x += 2) if (readPixel(s, x, y)[3] > 0) n++;
  return n;
};

describe('procedural brushes', () => {
  for (const id of ['hair-strands', 'spring-ink', 'orbit-curls', 'flow-fur', 'bead-trail', 'sparkle-dust', 'bristle-round', 'bristle-flat', 'dry-brush']) {
    it(`${id} paints, and the same seed and points give the same marks`, () => {
      const a = editor();
      const b = editor();
      a.paintStroke({ points: wave(110), brushId: id, seed: 9 });
      b.paintStroke({ points: wave(110), brushId: id, seed: 9 });
      expect(covered(a)).toBeGreaterThan(20);
      expect(Buffer.from(a.compositePixels().data).equals(Buffer.from(b.compositePixels().data))).toBe(true);
    });
  }

  it('the marks do not depend on how the input was sampled', () => {
    const a = editor();
    const b = editor();
    const pts = wave(110);
    a.paintStroke({ points: pts, brushId: 'spring-ink', seed: 2 });
    const s = b.beginStroke({ brushId: 'spring-ink', seed: 2, snapToPerspective: false });
    for (let i = 0; i < pts.length; i += 3) s.push(pts.slice(i, i + 3));
    s.end();
    expect(Buffer.from(a.compositePixels().data).equals(Buffer.from(b.compositePixels().data))).toBe(true);
  });

  it('bristles splay with pressure and a dry brush runs out', () => {
    const hard = editor();
    const soft = editor();
    hard.paintStroke({ points: wave(110).map((p) => ({ ...p, pressure: 1 })), brushId: 'bristle-round', seed: 1 });
    soft.paintStroke({ points: wave(110).map((p) => ({ ...p, pressure: 0.2 })), brushId: 'bristle-round', brush: { tip: { pressureSize: false } }, seed: 1 });
    expect(covered(hard)).toBeGreaterThan(covered(soft));
    const dry = editor();
    dry.paintStroke({ points: Array.from({ length: 60 }, (_, i) => ({ x: 10 + i * 4.4, y: 110 })), brushId: 'dry-brush', seed: 3 });
    const s = (dry.getActiveLayer() as PaintPixelLayer).surface;
    const col = (x: number) => {
      let n = 0;
      for (let y = 80; y < 140; y++) if (readPixel(s, x, y)[3] > 40) n++;
      return n;
    };
    expect(col(30)).toBeGreaterThan(col(250));
  });
});

describe('stickers', () => {
  it('sprays editable stickers onto a sticker layer, edits them as undo steps, and replays them', async () => {
    const c = editor();
    const r = c.paintStroke({ points: wave(110), brushId: 'sticker-stars', color: '#eab308', seed: 4 });
    expect(r.strokeId).toBeTruthy();
    const list = c.listStickers();
    expect(list.length).toBeGreaterThan(3);
    expect(list.every((s) => ['star', 'sparkle'].includes(s.stamp))).toBe(true);
    const first = list[0];
    const moved = c.updateSticker(undefined, first.id, { x: 40, y: 40, size: 50, color: '#2563eb', rotation: 15 });
    expect(moved).toMatchObject({ x: 40, y: 40, size: 50, color: '#2563eb' });
    expect(readPixel((c.getActiveLayer() as PaintPixelLayer).surface, 40, 40)[2]).toBeGreaterThan(150);
    c.arrangeStickers(undefined, [first.id], 'front');
    expect(c.listStickers().at(-1)!.id).toBe(first.id);
    const removed = c.removeStickers(undefined, [list[1].id]);
    expect(removed).toEqual([list[1].id]);
    expect(c.listStickers()).toHaveLength(list.length - 1);
    c.undo();
    expect(c.listStickers()).toHaveLength(list.length);
    // Other paint is refused on a sticker layer, and stickers need an empty layer.
    expect(() => c.paintStroke({ points: wave(50), brushId: 'pencil-hb' })).toThrow(/sticker layer/);
    c.addLayer();
    c.paintStroke({ points: wave(50), brushId: 'pencil-hb' });
    expect(() => c.paintStroke({ points: wave(80), brushId: 'sticker-leaves' })).toThrow(/already has paint/);
    // Save and load keep the stickers; a replay rebuilds them.
    const d = editor();
    d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())));
    expect(d.listStickers(c.listLayers().find((l) => l.name === 'Layer 1')!.id)).toHaveLength(list.length);
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(Buffer.from(c.compositePixels().data))).toBe(true);
    t.dispose();
  });

  it('refuses to spray under a mask stencil, and never clips stickers, live, after an edit or on replay', async () => {
    const c = editor();
    const stencil = c.addStencil({ kind: 'shape', shape: 'rect', mode: 'mask', rect: { x: 0, y: 0, width: 150, height: 300 } });
    expect(() => c.paintStroke({ points: wave(110), brushId: 'sticker-stars', seed: 4 })).toThrow(new RegExp(`mask stencils \\(${stencil.id}\\).*update_stencil enabled false`));
    expect(c.listStickers()).toHaveLength(0);
    // A replay with recorded mask stencils (older documents) still draws stickers whole.
    const masked = c.paintStroke({ points: wave(110), brushId: 'sticker-stars', seed: 4, maskStencils: [stencil] });
    c.updateStencil(stencil.id, { enabled: false });
    expect(c.document.strokes.find((s) => s.id === masked.strokeId)?.stencils).toBeUndefined();
    const live = Buffer.from(c.compositePixels().data);
    const list = c.listStickers();
    expect(list.some((s) => s.x > 160)).toBe(true);
    // An edit redraws the layer from its stickers; the pixels must not change.
    c.updateSticker(undefined, list[0].id, { color: list[0].color });
    expect(Buffer.from(c.compositePixels().data).equals(live)).toBe(true);
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(live)).toBe(true);
    t.dispose();
  });

  it('jitters sticker colours in hue and lightness without clipping saturated colours', () => {
    const c = editor();
    c.setBrush({ id: 'sticker-confetti', sticker: { colorJitter: 1 } });
    c.paintStroke({ points: wave(110), color: '#e11d48', seed: 9 });
    const base = oklabToOklch(rgbToOklab(hexToRgba('#e11d48')));
    const colors = c.listStickers().map((s) => s.color);
    expect(new Set(colors).size).toBeGreaterThan(colors.length / 2);
    for (const hex of colors) {
      const o = oklabToOklch(rgbToOklab(hexToRgba(hex)));
      const dh = Math.abs(((o.h - base.h + 540) % 360) - 180);
      expect(dh).toBeLessThan(42);
      expect(Math.abs(o.l - base.l)).toBeLessThan(0.16);
    }
  });

  it('picks stickers by shape, previews a drag on the tiles it touches, and drops it as one undo step', async () => {
    const c = new PaintEditorController({ width: 900, height: 600, paper: 'smooth' });
    const placed = c.addStickers(undefined, [
      { stamp: 'ring', x: 100, y: 100, size: 80 },
      { stamp: 'star', x: 700, y: 400, size: 60 },
      { stamp: 'heart', x: 110, y: 100, size: 30, color: '#e11d48' },
    ]);
    // Top-most first, by shape: the ring's hole is not the ring.
    expect(c.stickerAt(undefined, 110, 100)?.id).toBe(placed[2].id);
    expect(c.stickerAt(undefined, 66, 100)?.id).toBe(placed[0].id);
    expect(c.stickerAt(undefined, 100, 82)).toBeNull();
    expect(c.stickerAt(undefined, 400, 300)).toBeNull();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    let r = await reg.callTool('sticker_at', { x: 700, y: 400 });
    expect((r.structuredContent as { sticker: { id: string } }).sticker.id).toBe(placed[1].id);
    r = await reg.callTool('sticker_at', { x: 700 });
    expect(r.isError).toBe(true);
    // A drag: previews redraw only the tiles under the old and new place; the drop is one undo step.
    const before = c.getState().document;
    const starTile = (c.getActiveLayer() as PaintPixelLayer).surface.getTile(2, 1);
    c.previewSticker(undefined, placed[2].id, { x: 200, y: 120 });
    c.previewSticker(undefined, placed[2].id, { x: 300, y: 140 });
    expect((c.getActiveLayer() as PaintPixelLayer).surface.getTile(2, 1)).toBe(starTile);
    expect(c.getState().canUndo).toBe(true);
    const undoDepth = (c as unknown as { undoStack: unknown[] }).undoStack.length;
    c.updateSticker(undefined, placed[2].id, { x: 320, y: 140 });
    expect((c as unknown as { undoStack: unknown[] }).undoStack.length).toBe(undoDepth + 1);
    const full = stickerSurface(c.listStickers());
    expect(Buffer.from(c.compositePixels().data).equals(Buffer.from(compositeOf(c, full)))).toBe(true);
    c.undo();
    expect(c.listStickers()[2]).toMatchObject({ x: 110, y: 100 });
    expect(c.getState().document.layers).toEqual(before.layers);
    // A cancelled preview puts the sticker back.
    c.previewSticker(undefined, placed[0].id, { x: 500, y: 500 });
    c.cancelStickerPreview();
    expect(c.listStickers()[0]).toMatchObject({ x: 100, y: 100 });
    // Selection is editor state.
    c.selectSticker(placed[1].id);
    expect(c.getState().selectedSticker).toBe(placed[1].id);
  });

  it('agent tools list, change, arrange and delete stickers', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const parse = (r: { content: Array<{ text?: string }>; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
    await reg.callTool('paint_stroke', { points: wave(110), brushId: 'sticker-confetti', color: '#db2777' });
    let r = await reg.callTool('list_stickers', {});
    const stickers = parse(r).stickers;
    expect(stickers.length).toBeGreaterThan(3);
    r = await reg.callTool('update_sticker', { id: stickers[0].id, stamp: 'heart', size: 30 });
    expect(parse(r)).toMatchObject({ stamp: 'heart', size: 30 });
    r = await reg.callTool('update_sticker', { id: stickers[0].id, opacity: 3 });
    expect(r.isError).toBe(true);
    r = await reg.callTool('update_sticker', { id: 'nope', size: 10 });
    expect(r.isError).toBe(true);
    r = await reg.callTool('arrange_stickers', { ids: [stickers[0].id], to: 'back' });
    expect(parse(r).order[0]).toBe(stickers[0].id);
    r = await reg.callTool('remove_stickers', {});
    expect(parse(r).removed).toHaveLength(stickers.length);
  });

  it('add_stickers places stickers exactly as one undo step, and refuses bad input before changing anything', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const parse = (r: { content: Array<{ text?: string }>; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
    c.setColor('#16a34a');
    let r = await reg.callTool('add_stickers', { stickers: [{ stamp: 'heart', x: 120, y: 80, size: 40, color: '#e11d48' }, { stamp: 'star', x: 60, y: 150 }] });
    expect(r.isError).toBeFalsy();
    const added = parse(r).stickers;
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ stamp: 'heart', x: 120, y: 80, size: 40, color: '#e11d48', rotation: 0, opacity: 1 });
    expect(added[1]).toMatchObject({ stamp: 'star', size: 48, color: '#16a34a' });
    expect(new Set(added.map((s: { id: string }) => s.id)).size).toBe(2);
    expect(readPixel((c.getActiveLayer() as PaintPixelLayer).surface, 120, 80)[0]).toBeGreaterThan(150);
    // Adding more keeps ids unique and goes on top; it is one undo step.
    r = await reg.callTool('add_stickers', { stickers: [{ stamp: 'dot', x: 120, y: 80, size: 20, seed: 3 }] });
    expect(parse(r).stickers[0].seed).toBe(3);
    expect(c.listStickers().map((s) => s.id)).toEqual([...added.map((s: { id: string }) => s.id), parse(r).stickers[0].id]);
    c.undo();
    expect(c.listStickers()).toHaveLength(2);
    // Refusals change nothing.
    r = await reg.callTool('add_stickers', { stickers: [{ stamp: 'star', x: 10, y: 10 }, { stamp: 'star', x: 10, y: 10, size: 1 }] });
    expect(r.isError).toBe(true);
    r = await reg.callTool('add_stickers', { stickers: [{ stamp: 'moon', x: 10, y: 10 }] });
    expect(r.isError).toBe(true);
    r = await reg.callTool('add_stickers', { stickers: [] });
    expect(r.isError).toBe(true);
    expect(c.listStickers()).toHaveLength(2);
    expect(() => c.addStickers(undefined, [{ stamp: 'star', x: 1, y: 1, color: 'red' }])).toThrow(/Sticker 0: color "red" must be #rrggbb/);
    expect(c.listStickers()).toHaveLength(2);
    // A painted layer is refused; a replay rebuilds placed stickers.
    c.addLayer();
    c.paintStroke({ points: wave(50), brushId: 'pencil-hb' });
    r = await reg.callTool('add_stickers', { stickers: [{ stamp: 'star', x: 10, y: 10 }] });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/already has paint/);
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(Buffer.from(c.compositePixels().data))).toBe(true);
    t.dispose();
  });
});
