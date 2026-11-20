import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider, replayPainting } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import type { PaintPixelLayer } from '../src/paint-editor/document';
import { BAKED_STROKE_REASON, withTailLog } from '../src/paint-editor/stroke-tails';

/**
 * Every stroke selectable, whatever the layer (#902): a pixel layer keeps the strokes painted on it
 * since its last flattening point editable over the pixels under them, with the stroke log edited to
 * match, so replays, saves and the agent tools all see the edited strokes.
 */

const editor = () => new PaintEditorController({ width: 260, height: 200, paper: 'smooth' });
const wave = (y: number, n = 30, x0 = 20) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * 7, y: y + Math.sin(i / 3) * 12, pressure: 0.4 + 0.6 * Math.sin((i / (n - 1)) * Math.PI) }));
const down = (x: number) => Array.from({ length: 20 }, (_, i) => ({ x: x + Math.sin(i / 2) * 6, y: 10 + i * 9, pressure: 0.8 }));
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels().data);
const surfaceOf = (c: PaintEditorController, id: string) => (c.getLayer(id) as PaintPixelLayer).surface;

/** A pixel layer flattened by a smudge over an ink stroke, then strokes of every redrawable kind on top. */
function painted() {
  const c = editor();
  const layer = c.getActiveLayer()!.id;
  const under = c.paintStroke({ points: wave(80), brushId: 'ink-pen', color: '#0f172a', seed: 1 }).strokeId!;
  const smudge = c.paintStroke({ points: down(110), brushId: 'smudge', seed: 2 }).strokeId!;
  const tail = [
    c.paintStroke({ points: wave(50), brushId: 'hair-strands', color: '#2563eb', seed: 3 }).strokeId!,
    c.paintStroke({ points: wave(100), brushId: 'ink-pen', color: '#dc2626', seed: 5 }).strokeId!,
    c.paintStroke({ points: wave(150), brushId: 'bristle-round', color: '#16a34a', seed: 7 }).strokeId!,
    c.paintStroke({ points: down(60), brushId: 'eraser-soft', seed: 8 }).strokeId!,
    c.paintStroke({ points: wave(120, 20, 60), brushId: 'pencil-hb', color: '#f59e0b', seed: 9 }).strokeId!,
  ];
  return { c, layer, under, smudge, tail };
}

/** `steps` painted fresh on a new editor: what the layer should show. */
function fresh(steps: (c: PaintEditorController) => void): Buffer {
  const d = editor();
  steps(d);
  const out = pixels(d);
  d.dispose();
  return out;
}

describe('editable strokes on pixel layers', () => {
  it('keeps the strokes since the last flattening point editable, and redraws them to the same pixels', () => {
    const { c, layer, under, smudge, tail } = painted();
    expect(c.editableStrokes(layer)!.map((s) => s.id)).toEqual(tail);
    expect(c.isStrokeEditable(under)).toBe(false);
    expect(c.isStrokeEditable(smudge)).toBe(false);
    expect(() => c.updateStroke(under, { color: '#000000' })).toThrow(/can't be edited.*flattened/);
    // An edit that changes nothing redraws exactly what was painted.
    const before = pixels(c);
    const was = surfaceOf(c, layer);
    c.updateStroke(tail[1], { seed: 5 });
    expect(surfaceOf(c, layer)).not.toBe(was);
    expect(pixels(c).equals(before)).toBe(true);
  });

  it('edits, moves, reorders and removes them as the strokes would have painted, one undo step each', () => {
    const { c, layer, tail } = painted();
    const before = pixels(c);
    c.updateStroke(tail[0], { color: '#9333ea', seed: 11 });
    c.editStrokePoints(tail[2], { transform: { dx: 10, dy: -20, rotate: 15 } });
    expect(c.reorderStroke(tail[1], 0)).toEqual([tail[1], tail[0], tail[2], tail[3], tail[4]]);
    expect(c.removeStrokes([tail[4]]).removed).toEqual([tail[4]]);
    const now = c.editableStrokes(layer)!;
    expect(now.map((s) => s.id)).toEqual([tail[1], tail[0], tail[2], tail[3]]);
    const expected = fresh((d) => {
      d.paintStroke({ points: wave(80), brushId: 'ink-pen', color: '#0f172a', seed: 1 });
      d.paintStroke({ points: down(110), brushId: 'smudge', seed: 2 });
      for (const s of now) d.paintStroke({ points: s.points, brush: s.brush, color: s.color, seed: s.seed, ...(s.load ? { load: s.load } : {}) });
    });
    expect(pixels(c).equals(expected)).toBe(true);
    // The log holds the edited strokes in their new order, without the removed one.
    expect(c.getStrokes().map((s) => s.id).slice(2)).toEqual(now.map((s) => s.id));
    expect(c.getStrokes().find((s) => s.id === tail[0])!.color).toBe('#9333ea');
    for (let i = 0; i < 4; i++) c.undo();
    expect(pixels(c).equals(before)).toBe(true);
    expect(c.editableStrokes(layer)!.map((s) => s.id)).toEqual(tail);
    c.redo();
    expect(c.editableStrokes(layer)![0].color).toBe('#9333ea');
  });

  it('ends at anything that can’t be redrawn, and starts again over the pixels after it', () => {
    const c = editor();
    const layer = c.getActiveLayer()!.id;
    const a = c.paintStroke({ points: wave(50), brushId: 'ink-pen', color: '#2563eb', seed: 1 }).strokeId!;
    expect(c.editableStrokes(layer)!.map((s) => s.id)).toEqual([a]);
    c.fillRegion({ x: 100, y: 100, color: '#fde68a' } as never);
    expect(c.editableStrokes(layer)).toEqual([]);
    const b = c.paintStroke({ points: wave(100), brushId: 'ink-pen', color: '#dc2626', seed: 2 }).strokeId!;
    expect(c.editableStrokes(layer)!.map((s) => s.id)).toEqual([b]);
    // A layer change outside the strokes (a move) bakes them too.
    c.transformLayer({ layerId: layer, translateX: 5 });
    expect(c.editableStrokes(layer)).toEqual([]);
    expect(c.isStrokeEditable(a) || c.isStrokeEditable(b)).toBe(false);
    // Locked layers and brushes that read the paint under them don't start one.
    const other = c.addLayer({ name: 'Locked' }).id;
    c.updateLayer(other, { locks: { transparency: true } });
    c.paintStroke({ points: wave(60), brushId: 'ink-pen', color: '#16a34a', seed: 3, layerId: other });
    expect(c.editableStrokes(other)).toEqual([]);
  });

  it('keeps the log in order when strokes are removed between events on other layers', async () => {
    const c = editor();
    const ink = c.getActiveLayer()!.id;
    const a = c.paintStroke({ points: wave(50), brushId: 'ink-pen', color: '#2563eb', seed: 1 }).strokeId!;
    const other = c.addLayer({ name: 'Other' }).id;
    c.fillLayer({ color: '#fef3c7', layerId: other } as never);
    c.setActiveLayer(ink);
    c.paintStroke({ points: wave(110), brushId: 'hair-strands', color: '#dc2626', seed: 2 });
    c.removeStrokes([a]);
    expect(c.document.paintEvents!.at(-1)!.at).toBe(0);
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(pixels(c))).toBe(true);
    t.dispose();
  });

  it('replays and exports the edited strokes', async () => {
    const { c, tail } = painted();
    c.updateStroke(tail[1], { color: '#7c3aed', brushId: 'pencil-hb' });
    c.removeStrokes([tail[3]]);
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    expect(Buffer.from(t.compositePixels().data).equals(pixels(c))).toBe(true);
    t.dispose();
  });

  it('saves and opens them, editable after the load, and drops them when the log is not saved', () => {
    const { c, layer, tail } = painted();
    const json = c.toJSON();
    expect(Object.keys((json as { strokeTails?: object }).strokeTails ?? {})).toEqual([layer]);
    const d = editor();
    expect(d.loadJSON(json)).toEqual([]);
    expect(d.editableStrokes(layer)!.map((s) => s.id)).toEqual(tail);
    expect(pixels(d).equals(pixels(c))).toBe(true);
    c.updateStroke(tail[2], { color: '#0891b2' });
    d.updateStroke(tail[2], { color: '#0891b2' });
    expect(pixels(d).equals(pixels(c))).toBe(true);
    // Saved again unchanged: the same file.
    const e = editor();
    e.loadJSON(d.toJSON());
    expect(JSON.stringify(e.toJSON())).toBe(JSON.stringify(d.toJSON()));
    // Without the stroke log the ids name nothing: the strokes load baked.
    const bare = c.toJSON({ strokes: false }) as { strokeTails?: object };
    expect(bare.strokeTails).toBeUndefined();
    // A tail naming a stroke the log doesn't have is reported, not trusted.
    const bad = JSON.parse(JSON.stringify(json));
    bad.strokeTails[layer].ids.push('s999');
    const f = editor();
    expect(f.loadJSON(bad)).toEqual([expect.stringMatching(/editable strokes of layer .* could not be read \(stroke "s999" is not in the stroke log/)]);
    expect(f.editableStrokes(layer)).toEqual([]);
  });

  it('picks the stroke under a point on a pixel layer', () => {
    const { c, layer, tail } = painted();
    const s = c.editableStrokes(layer)!.find((x) => x.id === tail[2])!;
    const p = s.points[Math.floor(s.points.length / 2)];
    expect(c.liveStrokeAt(layer, p.x, p.y)?.id).toBe(tail[2]);
    expect(c.liveStrokeAt(layer, 255, 2)).toBeNull();
  });
});

describe('withTailLog', () => {
  it('fills the tail’s places in the new order and moves later events down past removed strokes', () => {
    const st = (id: string) => ({ id, layerId: 'a' }) as never;
    const doc = {
      strokes: [st('x'), st('t1'), st('y'), st('t2'), st('t3')],
      wetEvents: [{ clock: 0, at: 2, kind: 'dry' }, { clock: 0, at: 4, kind: 'dry' }],
      paintEvents: [{ at: 1, kind: 'fill', layerId: 'b' }, { at: 5, kind: 'fill', layerId: 'b' }],
    } as never;
    const r = withTailLog(doc, ['t1', 't2', 't3'], [st('t3'), st('t1')]);
    expect(r.strokes.map((s) => s.id)).toEqual(['x', 't3', 'y', 't1']);
    expect(r.wetEvents!.map((e) => e.at)).toEqual([2, 3]);
    expect(r.paintEvents!.map((e) => e.at)).toEqual([1, 4]);
  });
});

describe('editable pixel-layer strokes through the agent tools', () => {
  it('lists them live, says why the others are not, and edits them', async () => {
    const { c, layer, under, tail } = painted();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await reg.callTool(name, args);
      return { error: r.isError ? (r.content[0] as { text: string }).text : null, data: (r.structuredContent ?? (r.isError ? null : JSON.parse((r.content[0] as { text: string }).text))) as Record<string, any> };
    };
    let r = await call('list_strokes', { live: true, layerId: layer });
    expect(r.error).toBeNull();
    expect(r.data.strokes.map((s: { id: string }) => s.id)).toEqual(tail);
    r = await call('list_strokes', { layerId: layer });
    const first = r.data.strokes.find((s: { id: string }) => s.id === under);
    expect(first).toMatchObject({ live: false, notEditable: BAKED_STROKE_REASON });
    expect(r.data.strokes.find((s: { id: string }) => s.id === tail[0])).toMatchObject({ live: true });
    expect(r.data.strokes.find((s: { id: string }) => s.id === tail[0]).notEditable).toBeUndefined();
    r = await call('update_stroke', { id: tail[0], color: '#16a34a', brush: { marks: { kind: 'particles', count: 5 } } });
    expect(r.error).toBeNull();
    expect(r.data.stroke).toMatchObject({ id: tail[0], color: '#16a34a', live: true });
    r = await call('update_stroke', { id: under, color: '#16a34a' });
    expect(r.error).toMatch(/can't be edited/);
    r = await call('remove_strokes', { ids: [tail[1], under] });
    expect(r.error).toMatch(/can't be edited/);
    expect(c.editableStrokes(layer)).toHaveLength(5);
    const s = c.editableStrokes(layer)![2];
    const p = s.points[Math.floor(s.points.length / 2)];
    r = await call('stroke_at', { layerId: layer, x: p.x, y: p.y });
    expect(r.data.stroke).toMatchObject({ id: s.id, live: true });
    r = await call('remove_strokes', { ids: [tail[1]] });
    expect(r.error).toBeNull();
    expect(r.data.removed).toEqual([tail[1]]);
  });
});
