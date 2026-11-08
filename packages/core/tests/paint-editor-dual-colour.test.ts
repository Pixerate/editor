import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools';
import { deserializePaintDocumentAsync, serializePaintDocumentExternal, type PaintAssetStore } from '../src/paint-editor/serialize';
import type { RecordedStroke } from '../src/paint-editor/strokes';
import { pngDataUrl } from '../src/raster/png';

const editor = (scheme: 'light' | 'dark' = 'light') => new PaintEditorController({ width: 200, height: 140, paper: 'smooth', colorScheme: scheme });
const line = (y: number, n = 24) => Array.from({ length: n }, (_, i) => ({ x: 20 + i * 7, y: y + Math.sin(i / 3) * 8, pressure: 0.8 }));
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels().data);
const INK = { light: '#111827', dark: '#f9fafb' };

/** The strokes painted fresh in the given colours on a new stroke layer of a new editor. */
function freshPaint(strokes: readonly RecordedStroke[]): Buffer {
  const d = editor();
  d.addLayer({ type: 'strokes' });
  for (const s of strokes) d.paintStroke({ points: s.points, brush: s.brush, color: s.color, seed: s.seed });
  return pixels(d);
}

function memoryStore(): PaintAssetStore & { blobs: Map<string, Blob> } {
  const blobs = new Map<string, Blob>();
  return {
    blobs,
    async put(blob, info) {
      const ref = `mem://${info.id}`;
      blobs.set(ref, blob);
      return ref;
    },
    async get(ref) {
      const b = blobs.get(ref);
      if (!b) throw new Error(`no asset ${ref}`);
      return b;
    },
  };
}

/** Every string in `value` that is a data URL. */
function dataUrls(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('data:') ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(dataUrls);
  if (value && typeof value === 'object') return Object.values(value).flatMap(dataUrls);
  return [];
}

/** The strokes as the scheme shows them: dual-colour ones in its side. */
const shown = (strokes: readonly RecordedStroke[], scheme: 'light' | 'dark') => strokes.map((s) => (s.dualColor ? { ...s, color: s.dualColor[scheme] } : s));
/** The saved layers and assets, which must not depend on the viewer's scheme. */
const saved = (c: PaintEditorController) => {
  let json = JSON.stringify({ ...c.toJSON(), activeLayerId: null });
  c.getState().document.layers.forEach((l, i) => (json = json.split(l.id).join(`layer${i}`)));
  return json;
};

describe('dual-colour strokes', () => {
  it('records the pair, and the document draws a stroke layer in the light side', () => {
    const c = editor('dark');
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(50), brushId: 'ink-pen', color: INK, seed: 1 });
    const [s] = c.listLiveStrokes();
    expect(s).toMatchObject({ color: '#111827', dualColor: INK });
    // The view shows the dark side; the document's pixels are the light side.
    expect(pixels(c).equals(freshPaint(shown([s], 'dark')))).toBe(true);
    const light = editor();
    light.loadJSON(c.toJSON());
    expect(pixels(light).equals(freshPaint([s]))).toBe(true);
  });

  it('shows dual-colour strokes in the scheme without changing the document, an undo step or a commit', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    c.paintStroke({ points: line(90), brushId: 'ink-pen', color: '#dc2626', seed: 2 });
    const light = pixels(c);
    const doc = c.getState().document;
    const json = saved(c);
    const undo = c.historyLabels().undo.length;
    const commits: string[] = [];
    c.onCommit((e) => commits.push(e.kind));
    c.setColorScheme('dark');
    expect(c.getState().document).toBe(doc);
    expect(saved(c)).toBe(json);
    expect(c.historyLabels().undo.length).toBe(undo);
    expect(commits).toEqual([]);
    expect(pixels(c).equals(freshPaint(shown(c.listLiveStrokes(), 'dark')))).toBe(true);
    expect(c.listLiveStrokes()[1].color).toBe('#dc2626');
    c.setColorScheme('light');
    expect(pixels(c).equals(light)).toBe(true);
  });

  it('saves the same document whichever scheme it was painted in', () => {
    const paint = (scheme: 'light' | 'dark') => {
      const c = editor(scheme);
      c.addLayer({ type: 'strokes' });
      c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
      const s = c.beginStroke({ brushId: 'ink-pen', color: { light: '#1d4ed8', dark: '#93c5fd' }, seed: 2 });
      s.push(line(90));
      s.end();
      const t = c.beginStroke({ brushId: 'ink-pen', color: '#dc2626', seed: 3 });
      t.push(line(70));
      t.end();
      return c;
    };
    const [l, d] = [paint('light'), paint('dark')];
    expect(saved(d)).toBe(saved(l));
    expect(pixels(d).equals(freshPaint(shown(d.listLiveStrokes(), 'dark')))).toBe(true);
    expect(pixels(l).equals(freshPaint(l.listLiveStrokes()))).toBe(true);
  });

  it('paints a pointer stroke on the view of the scheme, so other dual strokes stay in it while drawing', () => {
    const c = editor('dark');
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    const before = pixels(c);
    const s = c.beginStroke({ brushId: 'ink-pen', color: '#dc2626', seed: 2 });
    s.push(line(110).slice(0, 3));
    // Away from the new stroke, the view is unchanged (the first stroke still in its dark side).
    const mid = c.compositePixels();
    const at = (img: { width: number; data: ArrayLike<number> }, x: number, y: number) => Array.from(img.data).slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
    const first = c.listLiveStrokes()[0].points[5];
    expect(at(mid, Math.round(first.x), Math.round(first.y))).toEqual(at({ width: 200, data: before }, Math.round(first.x), Math.round(first.y)));
    s.push(line(110).slice(3));
    s.end();
    expect(pixels(c).equals(freshPaint(shown(c.listLiveStrokes(), 'dark')))).toBe(true);
  });

  it('keeps undo and redo in the scheme, and they restore the same documents', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    const one = c.getState().document;
    c.paintStroke({ points: line(90), brushId: 'ink-pen', color: { light: '#1d4ed8', dark: '#93c5fd' }, seed: 2 });
    const two = c.getState().document;
    c.setColorScheme('dark');
    c.undo();
    expect(c.getState().document).toBe(one);
    expect(pixels(c).equals(freshPaint(shown(c.listLiveStrokes(), 'dark')))).toBe(true);
    c.setColorScheme('light');
    c.redo();
    expect(c.getState().document).toBe(two);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
    c.setColorScheme('dark');
    c.undo();
    c.undo();
    expect(c.listLiveStrokes()).toEqual([]);
    c.redo();
    c.redo();
    expect(pixels(c).equals(freshPaint(shown(c.listLiveStrokes(), 'dark')))).toBe(true);
    // Edits, reorders and removals in the dark scheme keep the view in step.
    const [a, b] = c.listLiveStrokes();
    c.updateStroke(a.id, { seed: 9 });
    c.reorderStroke(b.id, 0);
    expect(pixels(c).equals(freshPaint(shown(c.listLiveStrokes(), 'dark')))).toBe(true);
    c.removeStrokes([a.id]);
    expect(pixels(c).equals(freshPaint(shown(c.listLiveStrokes(), 'dark')))).toBe(true);
  });

  it('shows strokes loaded from a saved document in the scheme of the viewer', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    expect(json.strokes[0].dualColor).toEqual(INK);
    const d = editor('dark');
    expect(d.loadJSON(json)).toEqual([]);
    expect(d.listLiveStrokes()[0]).toMatchObject({ color: '#111827', dualColor: INK });
    expect(pixels(d).equals(freshPaint(shown(d.listLiveStrokes(), 'dark')))).toBe(true);
    expect(saved(d)).toBe(saved(c));
    // A bad pair is dropped; the stroke keeps its colour.
    json.strokes[0].dualColor = { light: 'x', dark: 1 };
    const e = editor();
    e.loadJSON(json);
    expect(e.getStrokes()[0].dualColor).toBeUndefined();
  });

  it('shows the scheme in image exports, and leaves pixel-locked layers alone', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    c.updateLayer(layer.id, { locks: { pixels: true } });
    c.setColorScheme('dark');
    expect(pixels(c).equals(freshPaint(shown(c.listLiveStrokes(), 'dark')))).toBe(true);
    const dark = Buffer.from(c.exportPng());
    c.setColorScheme('light');
    expect(Buffer.from(c.exportPng()).equals(dark)).toBe(false);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
  });

  it('records the pair from setColor and from updateStroke, and drops it for a plain colour', () => {
    const c = editor('dark');
    c.addLayer({ type: 'strokes' });
    expect(c.setColor(INK)).toBe('#f9fafb');
    c.paintStroke({ points: line(40), brushId: 'ink-pen', seed: 1 });
    const [s] = c.listLiveStrokes();
    expect(s).toMatchObject({ color: '#111827', dualColor: INK });
    c.setColorScheme('light');
    expect(c.getState().color).toBe('#111827');
    expect(c.updateStroke(s.id, { color: '#22c55e' }).stroke.dualColor).toBeUndefined();
    const r = c.updateStroke(s.id, { color: { light: 'red', dark: 'blue' } });
    expect(r.stroke).toMatchObject({ color: '#ff0000', dualColor: { light: '#ff0000', dark: '#0000ff' } });
    expect(() => c.setColor({ light: 'nope', dark: '#000' })).toThrow(/not a colour/);
  });

  it('bakes the side painted on a pixel layer (no stroke data to redraw it from)', () => {
    const c = editor('dark');
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    const before = pixels(c);
    c.setColorScheme('light');
    expect(pixels(c).equals(before)).toBe(true);
    expect(c.getStrokes()[0]).toMatchObject({ color: '#f9fafb', dualColor: INK });
  });
});

describe('set_color dualColor', () => {
  it('sets a light / dark pair through the tool, and refuses bad arguments', async () => {
    const c = editor();
    const registry = new ToolRegistry();
    registry.register(createPaintEditorToolProvider(c, { id: 'paint', namespace: 'paint' }));
    const r = await registry.callTool('paint__set_color', { dualColor: { light: '#111827', dark: '#F9FAFB' } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ color: '#111827', dualColor: INK });
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', seed: 1 });
    c.setColorScheme('dark');
    expect(pixels(c).equals(freshPaint(shown(c.listLiveStrokes(), 'dark')))).toBe(true);
    expect((await registry.callTool('paint__set_color', { color: '#000000', dualColor: INK })).isError).toBe(true);
    expect((await registry.callTool('paint__set_color', { dualColor: { light: '#000000' } })).isError).toBe(true);
    expect((await registry.callTool('paint__set_color', { locked: true })).structuredContent).not.toHaveProperty('dualColor');
  });
});

describe('external save of extension PNGs', () => {
  const png = (v: number) => pngDataUrl(2, 2, new Array(16).fill(v));

  it('stores every extension PNG in the asset store and reads them back', async () => {
    const c = editor();
    const store = memoryStore();
    const saved = await serializePaintDocumentExternal(c.getState().document, store, {
      extensions: { light: { l1: { png: png(10) } }, layerChannels: { l1: { height: png(20) } }, brushSources: [png(30), png(30)], later: { deep: [png(40)] } },
      mixingPad: { current: png(50), saved: [{ id: 'p', name: 'Pad', png: png(60) }] },
    });
    const { assets, ...rest } = saved;
    expect(dataUrls(rest)).toEqual([]);
    expect(dataUrls(assets)).toEqual([]);
    expect((saved.brushSources as string[])[0]).toBe((saved.brushSources as string[])[1]);
    expect((saved.brushSources as string[])[0]).toMatch(/^asset:ext-/);
    // One upload per distinct PNG.
    expect(store.blobs.size).toBe(6);
    const loaded = await deserializePaintDocumentAsync(JSON.parse(JSON.stringify(saved)), store);
    expect(loaded.problems).toEqual([]);
    expect(loaded.mixingPad).toEqual({ current: png(50), saved: [{ id: 'p', name: 'Pad', png: png(60) }] });
    expect(loaded.extensions).toMatchObject({ light: { l1: { png: png(10) } }, layerChannels: { l1: { height: png(20) } }, brushSources: [png(30), png(30)], later: { deep: [png(40)] } });
  });

  it('saves light paint externally from the controller and loads the same picture', async () => {
    const c = editor();
    c.paintStroke({ points: line(60), brushId: 'neon-marker', color: '#22d3ee', seed: 4 });
    const inline = c.toJSON();
    expect(inline.light).toBeDefined();
    const store = memoryStore();
    const saved = await c.toJSONExternal(store);
    const { assets, ...rest } = saved;
    expect(dataUrls(rest)).toEqual([]);
    expect(Object.values(assets).every((r) => r.startsWith('mem://'))).toBe(true);
    const d = editor();
    expect(await d.loadJSONAsync(JSON.parse(JSON.stringify(saved)), store)).toEqual([]);
    expect(pixels(d).equals(pixels(c))).toBe(true);
  });

  it('reports a missing extension asset and loads the rest', async () => {
    const store = memoryStore();
    const saved = await serializePaintDocumentExternal(editor().getState().document, store, { extensions: { later: png(70) } });
    store.blobs.clear();
    const loaded = await deserializePaintDocumentAsync(saved, store);
    expect(loaded.problems.some((p) => p.includes('"later"'))).toBe(true);
  });
});
