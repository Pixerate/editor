import { describe, expect, it } from 'vitest';
import { PaintEditorController, checkEvolutionStrokes, createPaintEditorToolProvider, evolutionStrokeRefusal } from '../src/paint-editor';
import type { RecordedStroke } from '../src/paint-editor/strokes';
import { readRegion } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const W = 260;
const H = 200;
const editor = (scheme: 'light' | 'dark' = 'light') => new PaintEditorController({ width: W, height: H, paper: 'smooth', colorScheme: scheme });
const wave = (y: number, n = 30, x0 = 20) => Array.from({ length: n }, (_, i) => ({ x: x0 + i * 7, y: y + Math.sin(i / 3) * 12, pressure: 0.4 + 0.6 * Math.sin((i / (n - 1)) * Math.PI) }));
const down = (x: number, n = 20) => Array.from({ length: n }, (_, i) => ({ x, y: 10 + i * 9, pressure: 0.9 }));
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels().data);
/** A layer's light channel over the whole canvas (all zero when it has none). */
const lightOf = (c: PaintEditorController, layerId: string) => {
  const l = c.getState().document.light?.[layerId];
  return Buffer.from(l ? readRegion(l, { x: 0, y: 0, width: W, height: H }) : new Uint8ClampedArray(W * H));
};
const HIGHLIGHT = { light: '#fff200', dark: '#7c3aed' };
const INK = { light: '#111827', dark: '#f9fafb' };

/** The strokes as the scheme shows them: dual-colour ones in its side. */
const shown = (strokes: readonly RecordedStroke[], scheme: 'light' | 'dark') => strokes.map((s) => (s.dualColor ? { ...s, color: s.dualColor[scheme] } : s));

/** The same strokes painted one by one on a plain pixel layer: the reference a stroke layer's redraw must match. */
function pixelPaint(strokes: readonly RecordedStroke[]): { pixels: Buffer; light: Buffer } {
  const d = editor();
  const layer = d.addLayer();
  for (const s of strokes) d.paintStroke({ points: s.points, brush: s.brush, color: s.color, seed: s.seed, copies: s.copies ?? [], ...(s.load ? { load: s.load } : {}) });
  return { pixels: pixels(d), light: lightOf(d, layer.id) };
}

/** Expects the stroke layer's pixels and light to be those of its strokes painted fresh in the scheme. */
function expectRedrawn(c: PaintEditorController, layerId: string, scheme: 'light' | 'dark' = 'light') {
  const ref = pixelPaint(shown(c.listLiveStrokes(layerId), scheme));
  expect(lightOf(c, layerId).equals(ref.light)).toBe(true);
  expect(pixels(c).equals(ref.pixels)).toBe(true);
}

describe('erasers on stroke layers', () => {
  it('redraws an eraser stroke exactly after the strokes under it are edited, moved or removed', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    const a = c.paintStroke({ points: wave(60), brushId: 'ink-pen', color: '#dc2626', seed: 1 }).strokeId!;
    const b = c.paintStroke({ points: wave(130), brushId: 'hair-strands', color: '#2563eb', seed: 2 }).strokeId!;
    const e = c.paintStroke({ points: down(120), brushId: 'eraser-soft', seed: 3 }).strokeId!;
    expect(c.listLiveStrokes().map((s) => s.id)).toEqual([a, b, e]);
    expect(c.listLiveStrokes()[2].brush.engine).toBe('eraser');
    expectRedrawn(c, layer.id);
    c.updateStroke(a, { color: '#16a34a', seed: 9 });
    expectRedrawn(c, layer.id);
    c.editStrokePoints(b, { transform: { dx: 0, dy: -60 } });
    expectRedrawn(c, layer.id);
    c.removeStrokes([a]);
    expectRedrawn(c, layer.id);
    c.editStrokePoints(b, { transform: { dx: 0, dy: 70 } });
    expectRedrawn(c, layer.id);
    // A stroke painted after the eraser lies over the erased gap.
    c.paintStroke({ points: wave(130, 30, 30), brushId: 'ink-pen', color: '#0ea5e9', seed: 4 });
    expectRedrawn(c, layer.id);
    c.reorderStroke(e, 2);
    expectRedrawn(c, layer.id);
  });

  it('redraws an edited eraser where it now erases and where it used to, including an eraser that found nothing', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: wave(60), brushId: 'ink-pen', color: '#dc2626', seed: 1 });
    const b = c.paintStroke({ points: wave(130), brushId: 'hair-strands', color: '#2563eb', seed: 2 }).strokeId!;
    const e = c.paintStroke({ points: down(120), brushId: 'eraser-soft', seed: 3 }).strokeId!;
    c.editStrokePoints(e, { transform: { dx: 40, dy: 0 } });
    expectRedrawn(c, layer.id);
    c.updateStroke(e, { brush: { tip: { size: 30 } } as never });
    expectRedrawn(c, layer.id);
    c.editStrokePoints(e, { points: down(60) });
    expectRedrawn(c, layer.id);
    // Moved off the paint it erases nothing; moving paint back under it is still erased.
    c.editStrokePoints(e, { points: down(250) });
    c.editStrokePoints(b, { transform: { dx: 30, dy: 0 } });
    expectRedrawn(c, layer.id);
    c.editStrokePoints(b, { transform: { dx: 30, dy: 0 } });
    expectRedrawn(c, layer.id);
  });

  it('keeps erasing exactly after a save and load, and undoes as one step per edit', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: wave(60), brushId: 'ink-pen', color: '#dc2626', seed: 1 });
    c.paintStroke({ points: down(100), brushId: 'eraser-soft', seed: 3 });
    const d = editor();
    expect(d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())))).toEqual([]);
    expect(pixels(d).equals(pixels(c))).toBe(true);
    const [a, e] = d.listLiveStrokes(layer.id);
    d.editStrokePoints(e.id, { transform: { dx: 50 } });
    expectRedrawn(d, layer.id);
    const moved = pixels(d);
    d.updateStroke(a.id, { seed: 8 });
    expectRedrawn(d, layer.id);
    d.undo();
    expect(pixels(d).equals(moved)).toBe(true);
    d.undo();
    expect(pixels(d).equals(pixels(c))).toBe(true);
  });

  it('paints an eraser with the pointer on a stroke layer as one recorded stroke', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: wave(60), brushId: 'ink-pen', color: '#dc2626', seed: 1 });
    const s = c.beginStroke({ brushId: 'eraser-soft', seed: 5 });
    s.push(down(90).slice(0, 6));
    s.push(down(90).slice(6));
    s.end();
    expect(c.listLiveStrokes(layer.id).map((x) => x.brush.engine)).toEqual(['dab', 'eraser']);
    expectRedrawn(c, layer.id);
  });
});

describe('light on stroke layers', () => {
  /** Neon light and a highlighter, a plain stroke over the light, and an eraser through it all. */
  function lit() {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    const neon = c.paintStroke({ points: wave(60), brushId: 'neon-marker', color: '#22d3ee', seed: 1 }).strokeId!;
    const hl = c.paintStroke({ points: wave(120), brushId: 'highlighter', color: '#fff200', seed: 2 }).strokeId!;
    const pen = c.paintStroke({ points: down(80), brushId: 'ink-pen', color: '#111827', seed: 3 }).strokeId!;
    const e = c.paintStroke({ points: down(160), brushId: 'eraser-soft', seed: 4 }).strokeId!;
    return { c, layer, neon, hl, pen, e };
  }

  it('lays light with each stroke, and the redraw matches the strokes painted fresh', () => {
    const { c, layer } = lit();
    expect(c.lightOf(layer.id).hasLight).toBe(true);
    expectRedrawn(c, layer.id);
  });

  it('moves, dims and erases light with the strokes when they are edited, reordered or removed', () => {
    const { c, layer, neon, hl, pen, e } = lit();
    c.editStrokePoints(neon, { transform: { dx: 0, dy: 40 } });
    expectRedrawn(c, layer.id);
    c.updateStroke(hl, { brush: { light: { amount: 0.9 } } as never });
    expectRedrawn(c, layer.id);
    c.reorderStroke(pen, 0);
    expectRedrawn(c, layer.id);
    c.editStrokePoints(e, { points: down(100) });
    expectRedrawn(c, layer.id);
    c.updateStroke(pen, { brushId: 'neon-marker' });
    expectRedrawn(c, layer.id);
    // Without a stroke that lays light the layer has none.
    c.removeStrokes([neon, hl, pen]);
    expect(c.getState().document.light?.[layer.id]).toBeUndefined();
    expect(c.lightOf(layer.id).hasLight).toBe(false);
    expectRedrawn(c, layer.id);
    c.undo();
    expect(c.lightOf(layer.id).hasLight).toBe(true);
    expectRedrawn(c, layer.id);
  });

  it('turns a stroke that lays no light into one that does, and back', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    const a = c.paintStroke({ points: wave(80), brushId: 'ink-pen', color: '#ec4899', seed: 1 }).strokeId!;
    expect(c.lightOf(layer.id).hasLight).toBe(false);
    c.updateStroke(a, { brush: { light: { amount: 0.8 } } as never });
    expect(c.lightOf(layer.id).hasLight).toBe(true);
    expectRedrawn(c, layer.id);
    c.updateStroke(a, { brush: { light: { amount: 0 } } as never });
    expect(c.lightOf(layer.id).hasLight).toBe(false);
    expectRedrawn(c, layer.id);
  });

  it('paints light with the pointer and keeps it after a save and load', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    const s = c.beginStroke({ brushId: 'neon-marker', color: '#a3e635', seed: 6 });
    s.push(wave(90).slice(0, 10));
    s.push(wave(90).slice(10));
    s.end();
    expectRedrawn(c, layer.id);
    const d = editor();
    expect(d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())))).toEqual([]);
    expect(pixels(d).equals(pixels(c))).toBe(true);
    d.editStrokePoints(d.listLiveStrokes(layer.id)[0].id, { transform: { dy: 30 } });
    expectRedrawn(d, layer.id);
  });
});

describe('dual-colour pens and highlighters on stroke layers', () => {
  /** A dual-colour highlighter with glow and a dual-colour pen under a plain stroke, on a stroke layer. */
  function painted(scheme: 'light' | 'dark' = 'light') {
    const c = editor(scheme);
    const layer = c.addLayer({ type: 'strokes' });
    const hl = c.paintStroke({ points: wave(70), brushId: 'highlighter', color: HIGHLIGHT, seed: 1 }).strokeId!;
    const pen = c.paintStroke({ points: wave(130), brushId: 'ink-pen', color: INK, seed: 2 }).strokeId!;
    const plain = c.paintStroke({ points: down(200), brushId: 'ink-pen', color: '#dc2626', seed: 3 }).strokeId!;
    return { c, layer, hl, pen, plain };
  }

  it('shows the dark side on a scheme switch, with its glow, and switching back restores it exactly', () => {
    const { c, layer } = painted();
    expect(c.listLiveStrokes(layer.id)[0].dualColor).toEqual(HIGHLIGHT);
    const light = pixels(c);
    const lightJson = JSON.stringify(c.toJSON());
    expectRedrawn(c, layer.id, 'light');
    c.setColorScheme('dark');
    expect(pixels(c).equals(light)).toBe(false);
    expectRedrawn(c, layer.id, 'dark');
    expect(JSON.stringify(c.toJSON())).toBe(lightJson);
    c.setColorScheme('light');
    expect(pixels(c).equals(light)).toBe(true);
  });

  it('erases part of a dual stroke, and a switch recolours only what is left', () => {
    const { c, layer } = painted();
    c.paintStroke({ points: down(110), brushId: 'eraser-soft', seed: 4 });
    expectRedrawn(c, layer.id, 'light');
    const light = pixels(c);
    c.setColorScheme('dark');
    expectRedrawn(c, layer.id, 'dark');
    // An eraser painted in the dark scheme with the pointer erases the same in both.
    const s = c.beginStroke({ brushId: 'eraser-soft', seed: 5 });
    s.push(down(40));
    s.end();
    expectRedrawn(c, layer.id, 'dark');
    c.setColorScheme('light');
    expectRedrawn(c, layer.id, 'light');
    expect(pixels(c).equals(light)).toBe(false);
  });

  it('saves the same document whatever the scheme it was painted and erased in', () => {
    const run = (scheme: 'light' | 'dark') => {
      const { c, hl } = painted(scheme);
      c.paintStroke({ points: down(110), brushId: 'eraser-soft', seed: 4 });
      c.editStrokePoints(hl, { transform: { dy: 10 } });
      let json = JSON.stringify({ ...c.toJSON(), activeLayerId: null });
      c.getState().document.layers.forEach((l, i) => (json = json.split(l.id).join(`layer${i}`)));
      return json;
    };
    expect(run('dark')).toBe(run('light'));
  });

  it('never restores the other scheme on undo or redo across a switch', () => {
    const { c, layer, pen } = painted();
    c.paintStroke({ points: down(110), brushId: 'eraser-soft', seed: 4 });
    const erased = c.getState().document;
    c.setColorScheme('dark');
    c.updateStroke(pen, { seed: 7 });
    expectRedrawn(c, layer.id, 'dark');
    c.undo();
    expect(c.getState().document).toBe(erased);
    expectRedrawn(c, layer.id, 'dark');
    c.setColorScheme('light');
    c.redo();
    expectRedrawn(c, layer.id, 'light');
    c.undo();
    c.undo();
    expectRedrawn(c, layer.id, 'light');
    c.setColorScheme('dark');
    c.redo();
    expectRedrawn(c, layer.id, 'dark');
  });

  it('spills a dual-colour glow in the side the scheme shows', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: wave(90), brushId: 'neon-marker', color: { light: '#be185d', dark: '#22d3ee' }, seed: 1 });
    expect(c.lightOf(layer.id).spill.radius).toBeGreaterThan(0);
    c.setColorScheme('dark');
    expectRedrawn(c, layer.id, 'dark');
  });

  it('leaves plain colour strokes as they are in either scheme', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: wave(70), brushId: 'neon-marker', color: '#22d3ee', seed: 1 });
    c.paintStroke({ points: down(110), brushId: 'eraser-soft', seed: 4 });
    const light = pixels(c);
    c.setColorScheme('dark');
    expect(pixels(c).equals(light)).toBe(true);
  });
});

describe('stroke layer agent tools with erasers and light', () => {
  it('paints an eraser and a glowing highlighter on a stroke layer, and edits them, through the registry', async () => {
    const c = editor();
    const registry = new ToolRegistry();
    registry.register(createPaintEditorToolProvider(c));
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await registry.callTool(name, args);
      return { data: r.structuredContent as any, error: r.isError ? (r.content[0] as { text: string }).text : null };
    };
    const layer = (await call('add_layer', { type: 'strokes' })).data;
    let r = await call('paint_stroke', { points: wave(70), brushId: 'highlighter', color: '#fff200', seed: 1 });
    expect(r.error).toBeNull();
    r = await call('paint_stroke', { points: down(110), brushId: 'eraser-soft', seed: 2 });
    expect(r.error).toBeNull();
    const e = r.data.strokeId;
    r = await call('list_strokes', { live: true });
    expect(r.data.strokes.map((s: { brushId: string }) => s.brushId)).toEqual(['highlighter', 'eraser-soft']);
    r = await call('edit_stroke_points', { id: e, transform: { dx: 30 } });
    expect(r.error).toBeNull();
    expect(r.data.bounds.width).toBeGreaterThan(0);
    r = await call('get_light', { layerId: layer.id });
    expect(r.data.hasLight).toBe(true);
    expectRedrawn(c, layer.id);
    // Wet paint is still refused, with the way out.
    r = await call('paint_stroke', { points: wave(40), brushId: 'watercolor-round' });
    expect(r.error).toMatch(/stroke layer.*wet media/);
  });
});

describe('breeding erasers', () => {
  it('refuses to breed an eraser stroke, which would be suggested on a layer of its own', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: wave(60), brushId: 'ink-pen', color: '#dc2626', seed: 1 });
    const e = c.paintStroke({ points: down(100), brushId: 'eraser-soft', seed: 3 }).strokeId!;
    const [pen, eraser] = c.listLiveStrokes();
    expect(eraser.id).toBe(e);
    expect(evolutionStrokeRefusal(eraser.brush)).toMatch(/erases.*nothing to erase/);
    expect(evolutionStrokeRefusal(pen.brush)).toBeNull();
    expect(() => checkEvolutionStrokes([pen, eraser])).toThrow(/erases/);
  });
});
