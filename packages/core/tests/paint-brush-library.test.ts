import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRUSH_PRESETS, createBrushLibrary, resolveBrush } from '../src/brushes';
import { createMemoryStorage } from '../src/persistence';
import { brushSpecOf, engineChanges } from '../src/paint-editor/brush-library';
import { BUILTIN_BRUSHES, createPaintBrushLibraryToolProvider, createPaintEditorToolProvider, PaintEditorController, replayPainting, serializePaintDocument } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools';

const wave = (y: number, n = 14) => Array.from({ length: n }, (_, i) => ({ x: 6 + i * 6, y: y + Math.sin(i / 2) * 6, pressure: 0.4 + (i % 5) * 0.12, t: i * 16 }));
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels().data).toString('base64');
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/paint-document-v1.json', import.meta.url), 'utf8')) as Record<string, any>;

describe('the paint editor on a shared brush library', () => {
  it('lists the library as the engine paints it: the presets resolve to the built-in brushes', () => {
    const c = new PaintEditorController();
    expect(c.getState().brushes).toEqual(BUILTIN_BRUSHES);
    expect(c.getBrushSpec('highlighter')).toEqual(BRUSH_PRESETS.find((b) => b.id === 'highlighter'));
    expect(c.getBrushSpec()).toMatchObject({ id: 'pencil-6b', medium: 'dry' });
  });

  it('shows a brush saved in one editor in every editor that shares the library, and paints with it', async () => {
    const library = createBrushLibrary();
    const a = new PaintEditorController({ width: 64, height: 32, brushLibrary: library });
    const b = new PaintEditorController({ width: 64, height: 32, brushLibrary: library });
    a.setBrushFacets({ tip: { size: 9 }, colour: { palette: ['#ff6ec7'] } }, 'highlighter');
    await a.saveBrush({ id: 'pink-highlighter', name: 'Pink highlighter' });
    await b.whenBrushesLoaded();
    expect(b.getState().brushes.map((x) => x.id)).toContain('pink-highlighter');
    expect(b.getBrushSpec('pink-highlighter')).toMatchObject({ variety: 'highlighter', tip: { size: 9 }, colour: { palette: ['#ff6ec7'] }, light: { spill: { radius: 0 } } });
    b.setBrush({ id: 'pink-highlighter' });
    expect(b.paintStroke({ points: wave(16, 8), color: '#ff6ec7' }).dabs).toBeGreaterThan(0);
    // Removed in the other editor: gone here too.
    await b.removeBrush('pink-highlighter');
    await a.whenBrushesLoaded();
    expect(a.getBrush('pink-highlighter')).toBeUndefined();
    a.dispose();
    b.dispose();
  });

  it('reads saved brushes from storage, and chooses the brush asked for once they are listed', async () => {
    const storage = createMemoryStorage();
    const first = createBrushLibrary({ storage });
    await first.save({ ...BRUSH_PRESETS.find((p) => p.id === 'ink-pen')!, id: 'my-pen', name: 'My pen', tip: { shape: 'round', size: 3 } });
    const c = new PaintEditorController({ brushLibrary: createBrushLibrary({ storage }), brushId: 'my-pen' });
    expect(c.getState().brush.id).toBe('pencil-6b');
    await c.whenBrushesLoaded();
    expect(c.getState().brush).toMatchObject({ id: 'my-pen', tip: { size: 3 } });
    expect(c.getUserBrushes().map((b) => b.id)).toEqual(['my-pen']);
  });

  it('starts the default library with the brushes option, and adds them to a library that is passed', async () => {
    const mine = { ...BUILTIN_BRUSHES.find((b) => b.id === 'soft-pastel')!, id: 'mine', name: 'Mine', grain: 0.3 };
    const c = new PaintEditorController({ brushes: [mine], brushId: 'mine' });
    expect(c.getState().brush).toMatchObject({ id: 'mine', grain: 0.3 });
    expect(await c.brushLibrary.get('mine')).toMatchObject({ builtin: false, brush: { behaviour: { grain: 0.3 } } });
    const library = createBrushLibrary();
    const d = new PaintEditorController({ brushes: [mine], brushLibrary: library });
    await d.whenBrushesLoaded();
    await new Promise((r) => setTimeout(r, 0));
    expect((await library.list({ source: 'user' })).map((e) => e.brush.id)).toEqual(['mine']);
  });

  it('keeps what the engine does not read when a brush is edited by its settings or its facets', () => {
    const c = new PaintEditorController();
    c.setBrush({ id: 'highlighter', tip: { size: 12 } });
    const spec = c.getBrushSpec()!;
    expect(spec).toMatchObject({ id: 'highlighter', medium: 'ink', variety: 'highlighter', tip: { size: 12 }, light: { spill: { radius: 0 } } });
    expect(spec.colour?.palette?.length).toBeGreaterThan(0);
    const r = c.setBrushFacets({ tip: { opacity: 0.4 } });
    expect(r.spec).toMatchObject({ variety: 'highlighter', tip: { size: 12, opacity: 0.4 }, light: { spill: { radius: 0 } } });
    expect(r.brush.tip).toMatchObject({ size: 12, opacity: 0.4 });
    // A hint that would change the engine is dropped: a wet variety on a dab brush.
    const plain = brushSpecOf(c.getState().brush, { ...spec, kind: 'mark', variety: 'watercolor', behaviour: { surface: 'wet' } });
    expect(resolveBrush(plain).engine).toBe('dab');
  });

  it('turns a facet patch into the engine settings it changes', () => {
    const c = new PaintEditorController();
    expect(c.brushChanges({ tip: { size: 40 } }, 'airbrush')).toEqual({ tip: { size: 40 } });
    expect(c.brushChanges({ behaviour: { exchange: { pickup: 0.5 } } }, 'pencil-6b')).toEqual({ behavior: { pickup: 0.5 } });
    const toParticles = c.brushChanges({ marks: { kind: 'particles', count: 4 } }, 'ink-pen');
    expect(toParticles).toMatchObject({ engine: 'particle', particle: { count: 4 } });
    expect(engineChanges(BUILTIN_BRUSHES[0], BUILTIN_BRUSHES[0])).toEqual({});
    expect(() => c.brushChanges({ tip: { size: 4 } }, 'nope')).toThrow(/Unknown brush "nope"/);
  });
});

describe('recorded strokes as facet brushes', () => {
  it('saves strokes and live strokes with facet brushes (document version 2) that replay to the same pixels', async () => {
    const c = new PaintEditorController({ width: 96, height: 72 });
    c.paintStroke({ brushId: 'gradient-round', points: wave(20), seed: 1 });
    c.paintStroke({ brushId: 'hair-strands', points: wave(40), color: '#2563eb', seed: 2 });
    c.paintStroke({ brushId: 'dirty-round', brush: c.brushChanges({ behaviour: { exchange: { pickup: 0.4 } } }, 'dirty-round'), points: wave(30), color: '#dc2626', seed: 3 });
    const live = c.addLayer({ type: 'strokes' });
    c.paintStroke({ layerId: live.id, brushId: 'bristle-round', points: wave(50), color: '#16a34a', seed: 4 });
    const json = JSON.parse(JSON.stringify(c.toJSON())) as Record<string, any>;
    expect(json.version).toBe(2);
    for (const s of [...json.strokes, ...json.liveStrokes[live.id]]) expect(s.brush.engine).toBeUndefined();
    expect(json.strokes[0].brush.colour.default.type).toBe('gradient');
    const d = new PaintEditorController();
    expect(d.loadJSON(json)).toEqual([]);
    expect(d.getStrokes().map((s) => s.brush)).toEqual(c.getStrokes().map((s) => ({ ...s.brush, category: d.getStrokes().find((x) => x.id === s.id)!.brush.category })));
    const t = d.createReplayTarget(1);
    await replayPainting(d.document, t);
    const r = c.createReplayTarget(1);
    await replayPainting(c.document, r);
    expect(pixels(t)).toBe(pixels(r));
    t.dispose();
    r.dispose();
  });

  it('loads a version 1 document (flat engine brushes) and replays it to the pixels it was saved with', async () => {
    const v1 = fixture();
    expect(v1.version).toBe(1);
    expect(v1.strokes.every((s: { brush: { engine?: string } }) => typeof s.brush.engine === 'string')).toBe(true);
    const d = new PaintEditorController();
    expect(d.loadJSON(v1)).toEqual([]);
    const saved = pixels(d);
    expect(d.getStrokes()).toHaveLength(8);
    // Replayed from its v1 strokes, the painting comes out as it was saved.
    const t = d.createReplayTarget(1);
    await replayPainting(d.document, t);
    expect(pixels(t)).toBe(saved);
    t.dispose();
    // Saved again it is version 2, and replays the same.
    const v2 = JSON.parse(JSON.stringify(serializePaintDocument(d.document)));
    expect(v2.version).toBe(2);
    const e = new PaintEditorController();
    e.loadJSON(JSON.parse(JSON.stringify(d.toJSON())));
    const u = e.createReplayTarget(1);
    await replayPainting(e.document, u);
    expect(pixels(u)).toBe(saved);
    u.dispose();
    // A live stroke of version 1 still redraws when it is changed.
    const layerId = Object.keys(v1.liveStrokes)[0];
    const [stroke] = e.listLiveStrokes(layerId);
    expect(stroke.brush).toMatchObject({ id: 'ink-pen', tip: { size: 5 } });
    expect(e.updateStroke(stroke.id, { seed: 9 }).bounds).toBeTruthy();
  });

  it('refuses a document newer than it reads', () => {
    const d = new PaintEditorController();
    expect(() => d.loadJSON({ ...fixture(), version: 3 })).toThrow(/version 3 is newer than this editor reads \(2\)/);
  });
});

describe('the paint brush library tools', () => {
  const setup = () => {
    const c = new PaintEditorController({ width: 96, height: 48 });
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c, { id: 'paint', namespace: 'paint' }));
    r.register(createPaintBrushLibraryToolProvider(c));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await r.callTool(name, args);
      return { error: res.isError ? (res.content[0] as { text: string }).text : null, data: res.structuredContent as any, content: res.content };
    };
    return { c, call };
  };

  it('creates a brush in the library, picks it with set_brush and paints with it (create → preview → set → paint)', async () => {
    const { c, call } = setup();
    let r = await call('brushes__create_brush', { id: 'pink-highlighter', name: 'Pink highlighter', basedOn: 'highlighter', colour: { default: '#ff6ec7' } });
    expect(r.error).toBeNull();
    r = await call('brushes__preview_brush', { id: 'pink-highlighter', width: 120, height: 40 });
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    await c.whenBrushesLoaded();
    r = await call('paint__set_brush', { id: 'pink-highlighter' });
    expect(r.data).toMatchObject({ engine: 'dab', brush: { id: 'pink-highlighter', colour: { default: '#ff6ec7' } } });
    r = await call('paint__paint_stroke', { points: wave(20, 10), color: '#ff6ec7' });
    expect(r.data.strokeId).toBe('s1');
    expect(c.getStrokes()[0].brush.id).toBe('pink-highlighter');
  });

  it('refuses unknown brushes and patches with what to do', async () => {
    const { call } = setup();
    expect((await call('paint__set_brush', { id: 'highliter' })).error).toMatch(/Unknown brush "highliter"\. Closest: highlighter.*list_brush_presets/);
    expect((await call('paint__get_brush', { id: 'nope' })).error).toMatch(/Unknown brush "nope"/);
    expect((await call('paint__paint_stroke', { points: wave(10), brush: { tip: { size: 0 } } })).error).toMatch(/size/);
    expect((await call('paint__set_brush', { tip: { stamps: ['editor:star'] } })).data.problems.join(' ')).toMatch(/stamp/);
    expect((await call('paint__set_brush', { unset: ['tip'] })).error).toMatch(/unset/);
  });
});
