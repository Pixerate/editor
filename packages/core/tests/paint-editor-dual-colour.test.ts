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

describe('dual-colour strokes', () => {
  it('paints the scheme side of a dual colour and records the pair', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(50), brushId: 'ink-pen', color: INK, seed: 1 });
    const [s] = c.listLiveStrokes();
    expect(s).toMatchObject({ color: '#111827', dualColor: INK });
    expect(pixels(c).equals(freshPaint([s]))).toBe(true);
  });

  it('redraws dual-colour strokes on a stroke layer when the scheme changes, without an undo step, and leaves plain ones', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    c.paintStroke({ points: line(90), brushId: 'ink-pen', color: '#dc2626', seed: 2 });
    const light = pixels(c);
    const undo = c.historyLabels().undo.length;
    c.setColorScheme('dark');
    const [a, b] = c.listLiveStrokes();
    expect(a).toMatchObject({ color: '#f9fafb', dualColor: INK });
    expect(b.color).toBe('#dc2626');
    expect(b.dualColor).toBeUndefined();
    expect(pixels(c).equals(freshPaint([a, b]))).toBe(true);
    expect(c.historyLabels().undo.length).toBe(undo);
    c.setColorScheme('light');
    expect(pixels(c).equals(light)).toBe(true);
  });

  it('keeps undo and redo drawn in the current scheme', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    c.paintStroke({ points: line(90), brushId: 'ink-pen', color: { light: '#1d4ed8', dark: '#93c5fd' }, seed: 2 });
    c.setColorScheme('dark');
    c.undo();
    expect(c.listLiveStrokes().map((s) => s.color)).toEqual(['#f9fafb']);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
    c.setColorScheme('light');
    c.redo();
    expect(c.listLiveStrokes().map((s) => s.color)).toEqual(['#111827', '#1d4ed8']);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
    c.setColorScheme('dark');
    c.undo();
    c.undo();
    expect(c.listLiveStrokes()).toEqual([]);
    c.redo();
    c.redo();
    expect(c.listLiveStrokes().map((s) => s.color)).toEqual(['#f9fafb', '#93c5fd']);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
  });

  it('follows a scheme change made mid-stroke once the stroke ends', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    const s = c.beginStroke({ brushId: 'ink-pen', color: '#dc2626', seed: 2 });
    s.push(line(90));
    c.setColorScheme('dark');
    s.end();
    expect(c.listLiveStrokes().map((x) => x.color)).toEqual(['#f9fafb', '#dc2626']);
    expect(pixels(c).equals(freshPaint(c.listLiveStrokes()))).toBe(true);
  });

  it('redraws a pixel-locked stroke layer for the scheme', () => {
    const c = editor();
    const layer = c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    c.updateLayer(layer.id, { locks: { pixels: true } });
    expect(() => c.setColorScheme('dark')).not.toThrow();
    expect(c.listLiveStrokes()[0].color).toBe('#f9fafb');
  });

  it('records the pair from setColor and from updateStroke, and drops it for a plain colour', () => {
    const c = editor('dark');
    c.addLayer({ type: 'strokes' });
    expect(c.setColor(INK)).toBe('#f9fafb');
    c.paintStroke({ points: line(40), brushId: 'ink-pen', seed: 1 });
    const [s] = c.listLiveStrokes();
    expect(s).toMatchObject({ color: '#f9fafb', dualColor: INK });
    c.setColorScheme('light');
    expect(c.getState().color).toBe('#111827');
    expect(c.updateStroke(s.id, { color: '#22c55e' }).stroke.dualColor).toBeUndefined();
    const r = c.updateStroke(s.id, { color: { light: 'red', dark: 'blue' } });
    expect(r.stroke).toMatchObject({ color: '#ff0000', dualColor: { light: '#ff0000', dark: '#0000ff' } });
    expect(() => c.setColor({ light: 'nope', dark: '#000' })).toThrow(/not a colour/);
  });

  it('keeps the pixels of a pixel layer as painted (the stroke still records the pair)', () => {
    const c = editor();
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    const before = pixels(c);
    c.setColorScheme('dark');
    expect(pixels(c).equals(before)).toBe(true);
    expect(c.getStrokes()[0]).toMatchObject({ color: '#111827', dualColor: INK });
  });

  it('round-trips the pair through a saved document and loads in the scheme of the editor', () => {
    const c = editor();
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: line(40), brushId: 'ink-pen', color: INK, seed: 1 });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    expect(json.strokes[0].dualColor).toEqual(INK);
    const d = editor('dark');
    expect(d.loadJSON(json)).toEqual([]);
    expect(d.listLiveStrokes()[0]).toMatchObject({ color: '#f9fafb', dualColor: INK });
    expect(d.getStrokes()[0].dualColor).toEqual(INK);
    expect(pixels(d).equals(freshPaint(d.listLiveStrokes()))).toBe(true);
    // A bad pair is dropped; the stroke keeps its colour.
    json.strokes[0].dualColor = { light: 'x', dark: 1 };
    const e = editor();
    e.loadJSON(json);
    expect(e.getStrokes()[0].dualColor).toBeUndefined();
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
    expect(c.listLiveStrokes()[0].color).toBe('#f9fafb');
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
