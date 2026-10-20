import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider, replayPainting } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import { readPixel } from '../src/raster/surface';
import type { PaintPixelLayer } from '../src/paint-editor/document';

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
});
