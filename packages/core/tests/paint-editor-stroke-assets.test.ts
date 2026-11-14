import { describe, expect, it } from 'vitest';
import { PaintEditorController } from '../src/paint-editor';
import { STROKE_CHUNK_SIZE, canonicalJSON, deserializePaintDocument, strokeChunkId, strokeChunkRuns, type ChunkedList, type PaintAssetStore } from '../src/paint-editor/serialize';

/**
 * Stroke data in the asset store (#720 follow-up, Pixerate/pixerate#676): `toJSONExternal` keeps
 * the stroke log, events and stroke layers' strokes in the store as runs of JSON, so the document
 * stays small and a save after one more stroke stores one new run; `strokes: 'replay'` keeps only
 * the log the colour-scheme replay needs, without repeating stroke layers' strokes.
 */

const W = 200;
const H = 140;
const editor = (scheme: 'light' | 'dark' = 'light') => new PaintEditorController({ width: W, height: H, paper: 'smooth', colorScheme: scheme });
/** A long pen stroke (`n` points with pressure, tilt and time (`t`), as a pointer records them). */
const long = (k: number, n = 160) =>
  Array.from({ length: n }, (_, i) => ({
    x: 10 + ((i * 1.13 + k * 7.31) % 180),
    y: 10 + ((k * 13.7 + Math.sin(i / 9 + k) * 40 + 60) % 120),
    pressure: 0.5 + 0.4 * Math.sin(i / 7 + k),
    tiltX: Math.round(Math.sin(i / 5) * 3000) / 100,
    tiltY: Math.round(Math.cos(i / 5) * 3000) / 100,
    t: 1000 * k + i * 8.333,
  }));
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels().data);
const INK = { light: '#111827', dark: '#f9fafb' };

type Put = { id: string; type: string; width: number; height: number; size: number };

function memoryStore(): PaintAssetStore & { blobs: Map<string, Blob>; puts: Put[] } {
  const blobs = new Map<string, Blob>();
  const puts: Put[] = [];
  return {
    blobs,
    puts,
    async put(blob, info) {
      puts.push({ ...info, type: blob.type, size: blob.size });
      const ref = `mem://${puts.length}`;
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

const strokePuts = (store: { puts: Put[] }) => store.puts.filter((p) => p.id.startsWith('json-'));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** An editor with a stroke layer holding `n` long ink strokes (the host's Draw on Canvas pen). */
function inked(n: number, dual = false): PaintEditorController {
  const c = editor();
  c.addLayer({ type: 'strokes' });
  for (let k = 0; k < n; k++) c.paintStroke({ points: long(k), brushId: 'ink-pen', color: dual ? INK : '#1d4ed8', seed: k + 1 });
  return c;
}

describe('stroke chunk runs', () => {
  it('cuts lists into full runs then powers of two, so one more item changes only the last run', () => {
    expect(strokeChunkRuns(0)).toEqual([]);
    expect(strokeChunkRuns(1)).toEqual([1]);
    expect(strokeChunkRuns(37)).toEqual([16, 16, 4, 1]);
    expect(strokeChunkRuns(38)).toEqual([16, 16, 4, 2]);
    expect(strokeChunkRuns(48)).toEqual([16, 16, 16]);
    for (let n = 0; n < 100; n++) {
      const a = strokeChunkRuns(n);
      const b = strokeChunkRuns(n + 1);
      expect(b.reduce((x, y) => x + y, 0)).toBe(n + 1);
      expect(b.every((r) => r <= STROKE_CHUNK_SIZE)).toBe(true);
      // Every run but the last of n + 1 items is a run of n items.
      expect(a.slice(0, b.length - 1)).toEqual(b.slice(0, -1));
    }
  });

  it('gives the same id to the same items whatever their key order', () => {
    expect(canonicalJSON([{ b: 1, a: [2, { d: null, c: 'x' }], u: undefined }])).toBe('[{"a":[2,{"c":"x","d":null}],"b":1}]');
    expect(canonicalJSON({ 10: 'a', 9: 'b', z: 1 })).toBe('{"10":"a","9":"b","z":1}');
    expect(strokeChunkId(canonicalJSON([{ x: 1, y: 2 }]))).toBe(strokeChunkId(canonicalJSON([{ y: 2, x: 1 }])));
    expect(strokeChunkId('[]')).toMatch(/^json-[0-9a-f]{14}-2$/);
  });
});

describe('stroke data in the asset store', () => {
  it('stores stroke layers, the log and events as JSON runs, and reads them back to the same document and pixels', async () => {
    const c = inked(20);
    const ink = c.getActiveLayer()!.id;
    // A stroke layer edit (a paint event), and a pixel layer with its own strokes (in the log only).
    c.updateStroke(c.listLiveStrokes(ink)[3].id, { seed: 77 });
    c.addLayer({ name: 'Pixels' });
    c.paintStroke({ points: long(40), brushId: 'soft-pastel', color: '#ca8a04', seed: 41 });
    const inline = c.toJSON();
    expect(inline.paintEvents).toHaveLength(1);
    const store = memoryStore();
    const saved = await c.toJSONExternal(store);
    const json = clone(saved) as Record<string, unknown>;
    expect((json.liveStrokes as Record<string, ChunkedList>)[ink].chunks).toHaveLength(strokeChunkRuns(20).length);
    expect((json.strokes as ChunkedList).chunks).toHaveLength(strokeChunkRuns(21).length);
    expect((json.paintEvents as ChunkedList).chunks).toHaveLength(1);
    expect(JSON.stringify(json)).not.toContain('"pressure"');
    for (const p of strokePuts(store)) expect(p).toMatchObject({ type: 'application/json', width: 0, height: 0 });
    // Equal runs are stored once (the log and the stroke layer share their first run).
    expect(new Set(strokePuts(store).map((p) => p.id)).size).toBe(strokePuts(store).length);

    const d = editor();
    expect(await d.loadJSONAsync(json, store)).toEqual([]);
    expect(d.toJSON()).toEqual(inline);
    expect(pixels(d).equals(pixels(c))).toBe(true);
    expect(d.listLiveStrokes(ink)).toEqual(c.listLiveStrokes(ink));
    expect(d.getStrokes()).toEqual(c.getStrokes());
  });

  it('uploads exactly one new stroke asset for a save after one more stroke', async () => {
    const c = inked(37);
    const store = memoryStore();
    const first = await c.toJSONExternal(store, { strokes: false });
    expect(strokePuts(store)).toHaveLength(strokeChunkRuns(37).length);
    // Saving again stores nothing new.
    store.puts.length = 0;
    await c.toJSONExternal(store, { strokes: false });
    expect(strokePuts(store)).toEqual([]);
    for (let k = 37; k < 37 + 20; k++) {
      c.paintStroke({ points: long(k), brushId: 'ink-pen', color: '#1d4ed8', seed: k + 1 });
      store.puts.length = 0;
      const next = await c.toJSONExternal(store, { strokes: false });
      expect(strokePuts(store)).toHaveLength(1);
      const runs = (Object.values(next.liveStrokes as Record<string, ChunkedList>)[0]).chunks;
      expect(runs).toHaveLength(strokeChunkRuns(k + 1).length);
    }
    // The runs of the first save are still the leading runs.
    const before = Object.values(first.liveStrokes as Record<string, ChunkedList>)[0].chunks;
    const after = Object.values((await c.toJSONExternal(store, { strokes: false })).liveStrokes as Record<string, ChunkedList>)[0].chunks;
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  });

  it('keeps the document small as strokes grow', async () => {
    const c = inked(50);
    const store = memoryStore();
    const size = async () => JSON.stringify(await c.toJSONExternal(store, { strokes: false })).length;
    const at50 = await size();
    for (let k = 50; k < 100; k++) c.paintStroke({ points: long(k), brushId: 'ink-pen', color: '#1d4ed8', seed: k + 1 });
    const at100 = await size();
    const inline = JSON.stringify(c.toJSON({ strokes: false })).length;
    // A run reference costs about 60 bytes; 100 strokes are 7 runs.
    expect(at100 - at50).toBeLessThan(1000);
    expect(at100).toBeLessThan(inline / 20);
  }, 60000);

  it('uploads no stroke data again after reopening a document from the same store', async () => {
    const c = inked(20);
    const store = memoryStore();
    const saved = clone(await c.toJSONExternal(store));
    const d = editor();
    expect(await d.loadJSONAsync(saved, store)).toEqual([]);
    store.puts.length = 0;
    // A fresh store object pointing at the same blobs: what a host has after a reload.
    const reopened = memoryStore();
    for (const [k, v] of store.blobs) reopened.blobs.set(k, v);
    const e = editor();
    expect(await e.loadJSONAsync(saved, reopened)).toEqual([]);
    const again = await e.toJSONExternal(reopened);
    expect(strokePuts(reopened)).toEqual([]);
    expect(again.liveStrokes).toEqual(saved.liveStrokes);
    expect(again.strokes).toEqual(saved.strokes);
  });

  it('reports a missing stroke asset and loads the rest', async () => {
    const c = inked(20);
    const store = memoryStore();
    const saved = clone(await c.toJSONExternal(store, { strokes: false }));
    const [layerId, list] = Object.entries(saved.liveStrokes as Record<string, ChunkedList>)[0];
    const lost = list.chunks[1];
    store.blobs.delete(saved.assets[lost]);
    const d = editor();
    const problems = await d.loadJSONAsync(saved, store);
    expect(problems).toEqual([
      `Asset "${lost}" (${saved.assets[lost]}) could not be fetched: no asset ${saved.assets[lost]}`,
      `"liveStrokes.${layerId}" refers to stroke data asset "${lost}", which could not be read; what it holds is left out.`,
    ]);
    // The first run's strokes load; the layer's pixels are its saved PNG.
    expect(d.listLiveStrokes().map((s) => s.id)).toEqual(c.listLiveStrokes().slice(0, 16).map((s) => s.id));
    expect(pixels(d).equals(pixels(c))).toBe(true);
    // The synchronous reader reports a run that is not there too.
    const sync = deserializePaintDocument({ ...saved, assets: {} });
    expect(sync.problems.some((p) => p.startsWith('"liveStrokes.'))).toBe(true);
  });

  it('still opens external documents saved with inline stroke data', async () => {
    const c = inked(5);
    c.addLayer({ name: 'Pixels' });
    c.paintStroke({ points: long(9), brushId: 'soft-pastel', color: '#ca8a04', seed: 9 });
    const inline = c.toJSON();
    const store = memoryStore();
    const saved = clone(await c.toJSONExternal(store));
    // What toJSONExternal wrote before: PNGs in the store, strokes and events inline.
    const old = { ...saved, strokes: inline.strokes, liveStrokes: inline.liveStrokes, assets: Object.fromEntries(Object.entries(saved.assets).filter(([id]) => !id.startsWith('json-'))) };
    const d = editor();
    expect(await d.loadJSONAsync(clone(old), store)).toEqual([]);
    expect(d.toJSON()).toEqual(inline);
    expect(pixels(d).equals(pixels(c))).toBe(true);
  });

  it('reads stroke data whatever media type the store gives back', async () => {
    const c = inked(3);
    const store = memoryStore();
    const saved = clone(await c.toJSONExternal(store));
    const untyped: PaintAssetStore = { put: store.put, get: async (ref) => new Blob([await (await store.get(ref)).arrayBuffer()]) };
    const d = editor();
    expect(await d.loadJSONAsync(saved, untyped)).toEqual([]);
    expect(d.toJSON()).toEqual(c.toJSON());
  });
});

describe("strokes: 'replay'", () => {
  it('leaves the log out when no pixel layer has a light / dark stroke, and keeps true and false as they were', () => {
    const c = inked(3, true);
    expect(c.toJSON({ strokes: 'replay' }).strokes).toBeUndefined();
    expect(c.toJSON({ strokes: false }).strokes).toBeUndefined();
    expect(c.toJSON().strokes).toHaveLength(3);
    expect(c.toJSON({ strokes: true })).toEqual(c.toJSON());
  });

  it('writes stroke layer strokes as references in the log, and loading puts them back', () => {
    const c = inked(3, true);
    const ink = c.getActiveLayer()!.id;
    const pixel = c.addLayer({ name: 'Wash' }).id;
    c.paintStroke({ points: long(5), brushId: 'soft-pastel', color: INK, seed: 5 });
    const live = c.listLiveStrokes(ink);
    const saved = c.toJSON({ strokes: 'replay' });
    expect(saved.strokes).toEqual([
      ...live.map((s) => ({ liveStroke: s.id, layerId: s.layerId })),
      expect.objectContaining({ layerId: pixel, dualColor: INK }),
    ]);
    expect(JSON.stringify(saved).length).toBeLessThan(JSON.stringify(c.toJSON()).length - 0.9 * JSON.stringify(c.toJSON().liveStrokes).length);
    const d = editor();
    expect(d.loadJSON(clone(saved))).toEqual([]);
    expect(d.toJSON()).toEqual(c.toJSON());
    expect(d.getStrokes()).toEqual(c.getStrokes());
  });

  it('writes a stroke edited on its stroke layer in full', () => {
    const c = inked(2, true);
    const ink = c.getActiveLayer()!.id;
    c.addLayer({ name: 'Wash' });
    c.paintStroke({ points: long(5), brushId: 'soft-pastel', color: INK, seed: 5 });
    const [a] = c.listLiveStrokes(ink);
    c.updateStroke(a.id, { seed: 99 });
    const saved = c.toJSON({ strokes: 'replay' });
    const log = saved.strokes as unknown as Array<Record<string, unknown>>;
    expect(log[0]).toMatchObject({ id: a.id, points: expect.any(Array) });
    expect(log[1]).toEqual({ liveStroke: c.listLiveStrokes(ink)[1].id, layerId: a.layerId });
    const d = editor();
    expect(d.loadJSON(clone(saved))).toEqual([]);
    expect(d.getStrokes()).toEqual(c.getStrokes());
  });

  it('reports a reference to a stroke the document does not have', () => {
    const c = inked(1, true);
    c.addLayer({ name: 'Wash' });
    c.paintStroke({ points: long(5), brushId: 'soft-pastel', color: INK, seed: 5 });
    const saved = clone(c.toJSON({ strokes: 'replay' })) as Record<string, unknown>;
    (saved.strokes as Array<Record<string, unknown>>)[0] = { liveStroke: 'nope', layerId: 'gone' };
    const d = editor();
    expect(d.loadJSON(saved)).toEqual(['strokes[0] refers to stroke "nope" of stroke layer "gone", which the document does not have; skipped.']);
    expect(d.getStrokes()).toHaveLength(1);
  });
});

describe('the colour-scheme replay after reopening from the asset store', () => {
  const wave = (y: number, n = 16) => Array.from({ length: n }, (_, i) => ({ x: 20 + (120 * i) / (n - 1), y: y + Math.sin(i / 3) * 8, pressure: 0.7 }));
  const BLUE = { light: '#1d4ed8', dark: '#93c5fd' };
  const RED = { light: '#b91c1c', dark: '#fca5a5' };
  const wet = (scheme: 'light' | 'dark' = 'light') => new PaintEditorController({ width: 160, height: 120, paper: 'cold-pressed', colorScheme: scheme, wet: { kernel: 'wasm', threads: 0 } });
  const dried = (c: PaintEditorController) => Buffer.from(c.compositePixels({ wet: 'dried' }).data);

  it("follows setColorScheme('dark') for wet dual-colour paint saved with strokes: 'replay'", async () => {
    type Side = 'light' | 'dark' | null;
    // Wet paint mixing two light / dark colours on a pixel layer, then ink on a stroke layer (the host's pen).
    const paint = async (c: PaintEditorController, side: Side) => {
      const pick = (pair: { light: string; dark: string }) => (side ? pair[side] : pair);
      await c.wetReady();
      c.paintStroke({ points: wave(40), brushId: 'watercolor-round', color: pick(BLUE), seed: 3 });
      await c.advanceWet({ steps: 5 });
      c.paintStroke({ points: wave(60), brushId: 'watercolor-round', color: pick(RED), seed: 8 });
      await c.wetIdle();
      c.addLayer({ type: 'strokes' });
      c.paintStroke({ points: wave(80), brushId: 'ink-pen', color: pick(INK), seed: 4 });
    };
    const c = wet();
    await paint(c, null);
    const store = memoryStore();
    const saved = clone(await c.toJSONExternal(store, { strokes: 'replay' }));
    // Three strokes: two runs, the ink stroke in the last a reference to the stroke layer.
    expect(saved.strokes).toEqual({ chunks: [expect.stringMatching(/^json-/), expect.stringMatching(/^json-/)] });
    const last = await store.get(saved.assets[(saved.strokes as unknown as ChunkedList).chunks[1]]);
    expect(JSON.parse(await last.text())).toEqual([{ layerId: c.getActiveLayer()!.id, liveStroke: c.getStrokes()[2].id }]);
    const d = wet();
    expect(await d.loadJSONAsync(saved, store)).toEqual([]);
    // The log came back whole: the ink stroke from its stroke layer.
    expect(d.getStrokes()).toEqual(c.getStrokes());
    d.setColorScheme('dark');
    const view = await d.colorSchemeViewReady();
    expect(view.layers.map((l) => l.view).sort()).toEqual(['replay', 'strokes']);
    expect(view.replay.state).toBe('ready');
    // The same pixels as painting the dark sides fresh.
    const f = wet();
    await paint(f, 'dark');
    expect(dried(d).equals(dried(f))).toBe(true);
    c.dispose();
    d.dispose();
    f.dispose();
  }, 60000);
});
