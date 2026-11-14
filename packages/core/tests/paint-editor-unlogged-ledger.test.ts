import { describe, expect, it } from 'vitest';
import { PaintEditorController, type SerializedPaintDocument } from '../src/paint-editor';
import { pixelsMatch } from '../src/paint-editor/scheme-replay';
import { emptySurface, fillRect, surfacesEqual, translateSurface, type TiledSurface } from '../src/raster/surface';

/**
 * Pixel layers whose pixels the stroke log can't rebuild are marked `unlogged` after opening,
 * whatever saved the document (#720): saves keep the marks with `unloggedComplete`, and a document
 * without that flag has its layers marked (named nowhere in the log) or checked against a replay
 * of the log (named in it) once the colour scheme needs them.
 */

const W = 160;
const H = 120;
const editor = (scheme: 'light' | 'dark' = 'light') => new PaintEditorController({ width: W, height: H, paper: 'cold-pressed', colorScheme: scheme, wet: { kernel: 'wasm', threads: 0 } });
const wave = (y: number, n = 16, x0 = 20, x1 = 140) => Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y + Math.sin(i / 3) * 8, pressure: 0.7 }));
const BLUE = { light: '#1d4ed8', dark: '#93c5fd' };
const RED = { light: '#b91c1c', dark: '#fca5a5' };

/** `json` as an editor from before the marks wrote it: no `unlogged`, no `unloggedComplete`. */
function older(json: SerializedPaintDocument): SerializedPaintDocument {
  const out = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
  delete out.unlogged;
  delete out.unloggedComplete;
  return out as unknown as SerializedPaintDocument;
}

const docSurface = (c: PaintEditorController, id: string): TiledSurface => {
  const l = c.document.layers.find((x) => x.id === id) as { surface: TiledSurface };
  return l.surface;
};

/** One layer painted fresh with `strokes` in their `side` (the reference for a replayed layer). */
function freshLayer(strokes: Array<{ y: number; color: string | { light: string; dark: string }; seed: number }>, side: 'light' | 'dark'): TiledSurface {
  const e = editor();
  for (const s of strokes) e.paintStroke({ points: wave(s.y), brushId: 'ink-pen', color: typeof s.color === 'string' ? s.color : s.color[side], seed: s.seed });
  const out = docSurface(e, e.getActiveLayer()!.id);
  e.dispose();
  return out;
}

/** Ink (dual strokes only) and Photo (a plain stroke, the "imported" pixels, then a dual stroke). */
function painting(): { json: SerializedPaintDocument; ink: string; photo: string } {
  const c = editor();
  const ink = c.getActiveLayer()!.id;
  c.paintStroke({ points: wave(30), brushId: 'ink-pen', color: BLUE, seed: 1 });
  const photo = c.addLayer({ name: 'Photo' }).id;
  c.paintStroke({ points: wave(80), brushId: 'ink-pen', color: '#ca8a04', seed: 2 });
  c.paintStroke({ points: wave(60), brushId: 'ink-pen', color: RED, seed: 3 });
  const json = c.toJSON();
  c.dispose();
  return { json, ink, photo };
}

/** The document as an older editor that imported Photo's plain pixels (not in its log) saved it. */
function importedOlder(): { json: SerializedPaintDocument; ink: string; photo: string } {
  const p = painting();
  const json = older(p.json);
  json.strokes = json.strokes!.filter((s) => (s as { seed?: number }).seed !== 2);
  return { ...p, json };
}

describe('saving the unlogged marks', () => {
  it('keeps the marks without dual-colour strokes, and says they are complete only next to the log', () => {
    const c = editor();
    const under = c.getActiveLayer()!.id;
    c.paintStroke({ points: wave(80), brushId: 'ink-pen', color: '#ca8a04', seed: 1 });
    const top = c.addLayer({ name: 'Top' }).id;
    c.paintStroke({ points: wave(40), brushId: 'ink-pen', color: '#1d4ed8', seed: 2 });
    c.mergeDown(top);
    expect(c.document.unlogged).toEqual({ [under]: 'Merge down' });
    const json = c.toJSON() as unknown as Record<string, unknown>;
    expect(json.unlogged).toEqual({ [under]: 'Merge down' });
    expect(json.unloggedComplete).toBe(true);
    const d = editor();
    d.loadJSON(json);
    expect(d.document.unlogged).toEqual({ [under]: 'Merge down' });
    expect(d.toJSON()).toEqual(json);
    // Without the log, the marks are kept but can't be complete.
    const bare = c.toJSON({ strokes: false }) as unknown as Record<string, unknown>;
    expect(bare.unlogged).toEqual({ [under]: 'Merge down' });
    expect(bare.unloggedComplete).toBeUndefined();
    expect((c.toJSON({ strokes: 'replay' }) as unknown as Record<string, unknown>).unloggedComplete).toBeUndefined();
    // A fresh painting with nothing unlogged says so too.
    const e = editor();
    e.paintStroke({ points: wave(40), brushId: 'ink-pen', color: BLUE, seed: 1 });
    const fresh = e.toJSON() as unknown as Record<string, unknown>;
    expect(fresh.unlogged).toBeUndefined();
    expect(fresh.unloggedComplete).toBe(true);
    for (const x of [c, d, e]) x.dispose();
  });

  it('marks layers with pixels that a document saved without its log has, on opening', async () => {
    const c = editor();
    const layer = c.getActiveLayer()!.id;
    c.paintStroke({ points: wave(60), brushId: 'ink-pen', color: '#ca8a04', seed: 1 });
    const d = editor();
    d.loadJSON(c.toJSON({ strokes: false }));
    expect(d.document.unlogged).toEqual({ [layer]: 'Opened without its stroke log' });
    // Dual-colour paint added now keeps the layer's colours instead of replaying it without them.
    d.paintStroke({ points: wave(30), brushId: 'ink-pen', color: BLUE, seed: 2 });
    d.setColorScheme('dark');
    const view = await d.colorSchemeViewReady();
    expect(view.layers).toEqual([{ layerId: layer, name: expect.any(String), view: 'kept', reason: expect.stringContaining('from "Opened without its stroke log"') }]);
    expect(surfacesEqual(d.viewLayerSurface(layer)!, docSurface(d, layer))).toBe(true);
    // Saved with the log now, the marks are complete.
    expect((d.toJSON() as unknown as Record<string, unknown>).unloggedComplete).toBe(true);
    c.dispose();
    d.dispose();
  });
});

describe('opening a document saved without marks', () => {
  it('marks a layer the log never names on opening, and keeps its colours when dual paint is added', async () => {
    const p = painting();
    const json = older(p.json);
    // Photo's strokes were never logged (an import): only Ink is named.
    json.strokes = json.strokes!.filter((s) => (s as { layerId?: string }).layerId !== p.photo);
    const d = editor();
    d.loadJSON(json);
    expect(d.document.unlogged).toEqual({ [p.photo]: 'Opened from an older document' });
    const photoPixels = docSurface(d, p.photo);
    d.setActiveLayer(p.photo);
    d.paintStroke({ points: wave(100), brushId: 'ink-pen', color: RED, seed: 9 });
    d.setColorScheme('dark');
    const view = await d.colorSchemeViewReady();
    expect(view.layers.find((l) => l.layerId === p.photo)).toMatchObject({ view: 'kept', reason: expect.stringContaining('from "Opened from an older document"') });
    expect(view.layers.find((l) => l.layerId === p.ink)).toMatchObject({ view: 'replay', state: 'ready' });
    expect(pixelsMatch(docSurface(d, p.photo), photoPixels)).toBe(false);
    expect(surfacesEqual(d.viewLayerSurface(p.photo)!, docSurface(d, p.photo))).toBe(true);
    d.dispose();
  });

  it('checks a layer the log names against a replay, and keeps it when the replay misses pixels', async () => {
    const { json, ink, photo } = importedOlder();
    const d = editor('dark');
    d.loadJSON(json);
    // Nothing is marked yet: both layers are named in the log.
    expect(d.document.unlogged).toBeUndefined();
    const first = d.colorSchemeView();
    expect(first.layers).toEqual([
      { layerId: photo, name: 'Photo', view: 'replay', state: 'building', reason: expect.stringMatching(/checked against a replay of the log/) },
      { layerId: ink, name: expect.any(String), view: 'replay', state: 'building', reason: expect.stringMatching(/checked against a replay of the log/) },
    ]);
    const view = await d.colorSchemeViewReady();
    expect(view.layers).toEqual([
      { layerId: photo, name: 'Photo', view: 'kept', reason: expect.stringMatching(/^Its pixels are not all in the stroke log \(opened from an older document/) },
      { layerId: ink, name: expect.any(String), view: 'replay', state: 'ready' },
    ]);
    // Photo keeps its colours (the imported pixels included); Ink shows its dark side.
    expect(surfacesEqual(d.viewLayerSurface(photo)!, docSurface(d, photo))).toBe(true);
    expect(pixelsMatch(d.viewLayerSurface(ink)!, freshLayer([{ y: 30, color: BLUE, seed: 1 }], 'dark'), null, 0)).toBe(true);
    // The check is view state: the marks are not saved, and the file is the same in either scheme.
    const l = editor('light');
    l.loadJSON(json);
    await l.colorSchemeViewReady();
    expect(JSON.stringify(d.toJSON())).toBe(JSON.stringify(l.toJSON()));
    const saved = d.toJSON() as unknown as Record<string, unknown>;
    expect(saved.unlogged).toBeUndefined();
    expect(saved.unloggedComplete).toBeUndefined();
    // Clearing the layer makes it replayable again.
    d.clearLayer(photo);
    expect((await d.colorSchemeViewReady()).layers.find((x) => x.layerId === photo)).toMatchObject({ view: 'replay', state: 'ready' });
    d.undo();
    expect((await d.colorSchemeViewReady()).layers.find((x) => x.layerId === photo)).toMatchObject({ view: 'kept' });
    d.dispose();
    l.dispose();
  });

  it('does not mark a fully logged document, and recolours it', async () => {
    const { json, ink, photo } = painting();
    const d = editor('dark');
    d.loadJSON(older(json));
    const view = await d.colorSchemeViewReady();
    expect(view.layers).toEqual([
      { layerId: photo, name: 'Photo', view: 'replay', state: 'ready' },
      { layerId: ink, name: expect.any(String), view: 'replay', state: 'ready' },
    ]);
    expect(d.document.unlogged).toBeUndefined();
    expect(pixelsMatch(d.viewLayerSurface(ink)!, freshLayer([{ y: 30, color: BLUE, seed: 1 }], 'dark'), null, 0)).toBe(true);
    const photoDark = freshLayer([
      { y: 80, color: '#ca8a04', seed: 2 },
      { y: 60, color: RED, seed: 3 },
    ], 'dark');
    expect(pixelsMatch(d.viewLayerSurface(photo)!, photoDark, null, 0)).toBe(true);
    d.dispose();
  });

  it('does not mark wet paint that flowed on after the last logged item', async () => {
    const c = editor();
    await c.wetReady();
    const layer = c.getActiveLayer()!.id;
    c.paintStroke({ points: wave(40), brushId: 'watercolor-round', color: BLUE, seed: 3 });
    await c.wetIdle();
    // Flow the log doesn't have: the save dries it where it got to.
    await c.advanceWet({ steps: 30 });
    const json = older(c.toJSON());
    const d = editor('dark');
    d.loadJSON(json);
    const view = await d.colorSchemeViewReady();
    expect(view.layers).toEqual([{ layerId: layer, name: expect.any(String), view: 'replay', state: 'ready' }]);
    c.dispose();
    d.dispose();
  }, 60000);
});

describe('pixelsMatch', () => {
  it('compares premultiplied pixels within the tolerance, leaving out the skipped rectangle', () => {
    const a = fillRect(emptySurface(4), { x: 10, y: 10, width: 20, height: 20 }, [200, 40, 40, 255]);
    expect(pixelsMatch(a, a)).toBe(true);
    expect(pixelsMatch(a, emptySurface(4))).toBe(false);
    expect(pixelsMatch(a, fillRect(emptySurface(4), { x: 10, y: 10, width: 20, height: 20 }, [204, 40, 40, 255]))).toBe(true);
    expect(pixelsMatch(a, fillRect(emptySurface(4), { x: 10, y: 10, width: 20, height: 20 }, [230, 40, 40, 255]))).toBe(false);
    // The colour of a fully transparent pixel doesn't count.
    expect(pixelsMatch(fillRect(emptySurface(4), { x: 0, y: 0, width: 4, height: 4 }, [255, 0, 0, 0]), emptySurface(4))).toBe(true);
    // Moved pixels differ; inside the skipped rectangle anything goes.
    const moved = translateSurface(a, 300, 0);
    expect(pixelsMatch(a, moved)).toBe(false);
    expect(pixelsMatch(a, moved, { x: 0, y: 0, width: 400, height: 40 })).toBe(true);
    expect(pixelsMatch(a, moved, { x: 0, y: 0, width: 30, height: 40 })).toBe(false);
  });
});
