import { describe, expect, it, vi } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider, replayPainting } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import type { PaintPixelLayer } from '../src/paint-editor/document';
import type { RecordedStroke } from '../src/paint-editor/strokes';

const editor = () => new PaintEditorController({ width: 260, height: 200, paper: 'smooth' });
const wave = (y: number, n = 30, x0 = 20) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * 7, y: y + Math.sin(i / 3) * 12, pressure: 0.4 + 0.6 * Math.sin((i / (n - 1)) * Math.PI) }));
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels().data);

/** The same strokes painted fresh, one by one, on a new stroke layer of a new editor. */
function freshPaint(strokes: readonly RecordedStroke[]): Buffer {
  const d = editor();
  d.addLayer({ type: 'strokes' });
  for (const s of strokes) d.paintStroke({ points: s.points, brush: s.brush, color: s.color, seed: s.seed, copies: s.copies ?? [], ...(s.paint ? { paint: s.paint } : {}), ...(s.load ? { load: s.load } : {}) });
  return pixels(d);
}

/** A painted stroke layer with a particle, a dab and a bristle stroke. */
function painted() {
  const c = editor();
  const layer = c.addLayer({ type: 'strokes' });
  c.paintStroke({ points: wave(50), brushId: 'hair-strands', color: '#2563eb', seed: 3 });
  c.paintStroke({ points: wave(100), brushId: 'ink-pen', color: '#dc2626', seed: 5 });
  c.paintStroke({ points: wave(150), brushId: 'bristle-round', color: '#16a34a', seed: 7 });
  return { c, layer };
}

describe('live stroke layers', () => {
  it('keeps every stroke painted on a stroke layer as editable data', () => {
    const { c, layer } = painted();
    expect(layer.liveStrokes).toBe(0);
    const list = c.listLiveStrokes();
    expect(list.map((s) => s.brush.engine)).toEqual(['particle', 'dab', 'bristle']);
    expect(c.describeLayer(c.getLayer(layer.id)!).liveStrokes).toBe(3);
    expect(pixels(c).equals(freshPaint(list))).toBe(true);
  });

  it('edits a stroke so the layer matches a fresh paint of the edited strokes, as one undo step each', () => {
    const { c } = painted();
    const before = pixels(c);
    const [a, b, d] = c.listLiveStrokes();
    const r = c.updateStroke(a.id, { color: '#9333ea', seed: 11, brush: { particle: { count: 6 } } as never });
    expect(r.stroke).toMatchObject({ id: a.id, color: '#9333ea', seed: 11 });
    expect(r.stroke.brush.particle.count).toBe(6);
    expect(r.bounds.width).toBeGreaterThan(0);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
    c.updateStroke(b.id, { brushId: 'pencil-hb' });
    expect(c.listLiveStrokes()[1].brush.tip.size).toBe(b.brush.tip.size);
    c.editStrokePoints(d.id, { transform: { dx: 10, dy: -20, rotate: 15 } });
    c.editStrokePoints(b.id, { points: wave(120, 12) });
    expect(c.listLiveStrokes()[1].points).toHaveLength(12);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
    expect(c.reorderStroke(a.id, 2)).toEqual([b.id, d.id, a.id]);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
    expect(c.removeStrokes([d.id]).removed).toEqual([d.id]);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
    for (let i = 0; i < 6; i++) c.undo();
    expect(pixels(c).equals(before)).toBe(true);
    expect(c.listLiveStrokes().map((s) => s.id)).toEqual([a.id, b.id, d.id]);
    c.redo();
    expect(c.listLiveStrokes()[0].color).toBe('#9333ea');
  });

  it('refuses brushes it cannot redraw, and layer operations that would bake pixels, with the way out', () => {
    const { c } = painted();
    expect(() => c.paintStroke({ points: wave(80), brushId: 'eraser-soft' })).toThrow(/stroke layer.*remove_strokes/);
    expect(() => c.paintStroke({ points: wave(80), brushId: 'smudge' })).toThrow(/stroke layer.*rasterize_stroke_layer/);
    expect(() => c.paintStroke({ points: wave(80), brushId: 'watercolor-round' })).toThrow(/stroke layer.*wet media/);
    expect(() => c.paintStroke({ points: wave(80), brushId: 'sticker-stars' })).toThrow(/stroke layer.*stickers/);
    expect(() => c.paintStroke({ points: wave(80), brushId: 'impasto-brush' })).toThrow(/stroke layer.*thick paint/);
    expect(() => c.fillLayer({ color: '#000000' })).toThrow(/stroke layer.*rasterize_stroke_layer/);
    const id = c.listLiveStrokes()[0].id;
    expect(() => c.updateStroke(id, { brushId: 'eraser-soft' })).toThrow(/Erasers/);
    expect(() => c.updateStroke(id, { seed: -1 })).toThrow(/seed -1/);
    expect(() => c.updateStroke('nope', { seed: 1 })).toThrow(/Unknown stroke "nope".*list_strokes/);
    expect(() => c.editStrokePoints(id, {})).toThrow(/either points .* or transform/);
    expect(() => c.reorderStroke(id, 9)).toThrow(/use 0\.\.2/);
    expect(c.listLiveStrokes()).toHaveLength(3);
    // A baked stroke says why it can't be edited.
    c.addLayer();
    const baked = c.paintStroke({ points: wave(80), brushId: 'ink-pen' }).strokeId!;
    expect(() => c.updateStroke(baked, { seed: 1 })).toThrow(/pixel layer, so its pixels are baked/);
    // Conversion needs an empty layer.
    expect(() => c.convertToLiveStrokes()).toThrow(/already has paint/);
    c.addLayer();
    expect(c.convertToLiveStrokes().liveStrokes).toBe(0);
  });

  it('rasterizes to the same pixels, after which any brush paints', () => {
    const { c, layer } = painted();
    const before = pixels(c);
    c.rasterizeLiveStrokes(layer.id);
    expect(c.isLiveStrokeLayer(layer.id)).toBe(false);
    expect(pixels(c).equals(before)).toBe(true);
    c.paintStroke({ points: wave(80), brushId: 'eraser-soft' });
    c.undo();
    c.undo();
    expect(c.isLiveStrokeLayer(layer.id)).toBe(true);
  });

  it('saves and loads its strokes, duplicates with new ids, and edits after a load', () => {
    const { c, layer } = painted();
    const d = editor();
    expect(d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())))).toEqual([]);
    expect(d.listLiveStrokes(layer.id).map((s) => s.id)).toEqual(c.listLiveStrokes(layer.id).map((s) => s.id));
    expect(pixels(d).equals(pixels(c))).toBe(true);
    d.updateStroke(d.listLiveStrokes(layer.id)[2].id, { color: '#0ea5e9' });
    expect(pixels(d).equals(freshPaint(d.listLiveStrokes(layer.id)))).toBe(true);
    const dup = c.duplicateLayer(layer.id);
    const ids = c.listLiveStrokes(dup.id).map((s) => s.id);
    expect(ids.some((id) => c.listLiveStrokes(layer.id).some((s) => s.id === id))).toBe(false);
    expect(c.listLiveStrokes(dup.id).every((s) => s.layerId === dup.id)).toBe(true);
    // A new stroke after loading gets a fresh id.
    const next = d.paintStroke({ points: wave(30), brushId: 'ink-pen' }).strokeId!;
    expect(d.listLiveStrokes(layer.id).filter((s) => s.id === next)).toHaveLength(1);
  });

  it('replays edits, removals and rasterizing exactly, and stays aligned when the canvas grows', async () => {
    const { c, layer } = painted();
    const [a, b] = c.listLiveStrokes();
    c.updateStroke(a.id, { color: '#f59e0b' });
    c.removeStrokes([b.id]);
    c.paintStroke({ points: wave(70), brushId: 'ink-pen', color: '#0f172a', seed: 2 });
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(pixels(c))).toBe(true);
    expect(t.listLiveStrokes(layer.id).map((s) => s.color)).toEqual(c.listLiveStrokes(layer.id).map((s) => s.color));
    t.dispose();
    c.extendCanvas({ left: 30, top: 10 });
    const grown = pixels(c);
    // An edit that changes nothing redraws the same picture at the new place.
    const s = c.listLiveStrokes()[0];
    c.updateStroke(s.id, { seed: s.seed });
    expect(pixels(c).equals(grown)).toBe(true);
    expect((c.getLayer(layer.id) as PaintPixelLayer).offset).toEqual({ x: 0, y: 0 });
  });

  it('redraws only the strokes that reach the area an edit changes, and matches a full redraw', () => {
    const c = new PaintEditorController({ width: 1200, height: 400, paper: 'smooth' });
    c.addLayer({ type: 'strokes' });
    // Three far-apart groups of three strokes.
    for (let g = 0; g < 3; g++) for (let i = 0; i < 3; i++) c.paintStroke({ points: wave(150 + i * 20, 20, 40 + g * 400), brushId: 'ink-pen', color: '#334155', seed: g * 3 + i });
    const list = c.listLiveStrokes();
    const draw = vi.spyOn(c as unknown as { drawLiveStroke: () => unknown }, 'drawLiveStroke');
    c.updateStroke(list[4].id, { color: '#dc2626' });
    // The edited stroke alone (to learn where it paints), then the three strokes of its group.
    expect(draw).toHaveBeenCalledTimes(4);
    draw.mockClear();
    c.editStrokePoints(list[0].id, { transform: { dx: 400 } });
    // Moved into the middle group: its old group and its new place.
    expect(draw.mock.calls.length).toBeLessThanOrEqual(7);
    draw.mockRestore();
    expect(pixels(c).equals((() => {
      const d = new PaintEditorController({ width: 1200, height: 400, paper: 'smooth' });
      d.addLayer({ type: 'strokes' });
      for (const s of c.listLiveStrokes()) d.paintStroke({ points: s.points, brush: s.brush, color: s.color, seed: s.seed });
      return pixels(d);
    })())).toBe(true);
  });
});

describe('live stroke agent tools', () => {
  it('add, list, update, edit points, reorder, remove and rasterize through the registry', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await reg.callTool(name, args);
      return { error: r.isError ? (r.content[0] as { text: string }).text : null, data: (r.structuredContent ?? (r.isError ? null : JSON.parse((r.content[0] as { text: string }).text))) as Record<string, any> };
    };
    const layer = (await call('add_layer', { type: 'strokes' })).data;
    expect(layer.liveStrokes).toBe(0);
    await call('paint_stroke', { points: wave(60), brushId: 'hair-strands', color: '#2563eb' });
    await call('paint_stroke', { points: wave(120), brushId: 'ink-pen', color: '#dc2626' });
    let r = await call('list_strokes', { live: true });
    expect(r.error).toBeNull();
    expect(r.data.strokes).toHaveLength(2);
    expect(r.data.strokes[0]).toMatchObject({ layerId: layer.id, live: true });
    const [a, b] = r.data.strokes;
    r = await call('update_stroke', { id: a.id, color: '#16a34a', brush: { marks: { kind: 'particles', count: 5 } } });
    expect(r.error).toBeNull();
    expect(r.data.stroke).toMatchObject({ id: a.id, color: '#16a34a' });
    // The facet patch changed only the particle count; the rest of the stroke's brush is kept.
    const edited = c.listLiveStrokes(layer.id).find((s) => s.id === a.id)!.brush;
    expect(edited).toMatchObject({ id: 'hair-strands', engine: 'particle', particle: { count: 5 } });
    expect(edited.particle.kind).toBe(c.getBrush('hair-strands')!.particle.kind);
    expect(r.data.bounds.width).toBeGreaterThan(0);
    r = await call('update_stroke', { id: a.id, brush: { particle: { count: 5 } } });
    expect(r.error).toMatch(/particle/);
    r = await call('update_stroke', { id: a.id, brushId: 'eraser-soft' });
    expect(r.error).toMatch(/Erasers/);
    r = await call('update_stroke', { id: a.id });
    expect(r.error).toMatch(/Pass at least one change/);
    r = await call('edit_stroke_points', { id: b.id, transform: { dx: 15, scale: 1.2 } });
    expect(r.error).toBeNull();
    r = await call('edit_stroke_points', { id: b.id, points: [{ x: 10, y: 10 }, { x: 200, y: 40 }] });
    expect(r.data.stroke.points).toHaveLength(2);
    r = await call('edit_stroke_points', { id: b.id, points: [{ x: 10, y: 10 }], transform: { dx: 1 } });
    expect(r.error).toMatch(/not both/);
    r = await call('reorder_stroke', { id: b.id, index: 0 });
    expect(r.data.order).toEqual([b.id, a.id]);
    r = await call('remove_strokes', { ids: ['nope'] });
    expect(r.error).toMatch(/Unknown stroke "nope"/);
    expect(c.listLiveStrokes(layer.id)).toHaveLength(2);
    r = await call('remove_strokes', { ids: [a.id] });
    expect(r.data.removed).toEqual([a.id]);
    r = await call('rasterize_stroke_layer', { layerId: layer.id });
    expect(r.data.liveStrokes).toBeUndefined();
    r = await call('update_stroke', { id: b.id, seed: 1 });
    expect(r.error).toMatch(/baked/);
    r = await call('add_layer', {});
    r = await call('convert_to_stroke_layer', {});
    expect(r.data.liveStrokes).toBe(0);
  });
});
