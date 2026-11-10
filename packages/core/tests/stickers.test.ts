import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkStickerProvider,
  closestStickerRefs,
  combineStickerProviders,
  createFakeStickerProvider,
  createStickerToolProvider,
  editorStickers,
  normalizeStickerRef,
  parseStickerRef,
  stickerPage,
  StickerError,
  type StickerProvider,
} from '../src/stickers';
import { createPaintEditorToolProvider, PaintEditorController, type PaintPixelLayer } from '../src/paint-editor';
import { decodePng, parseDataUrl } from '../src/raster/png';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as any;
};
const text = (res: { content: unknown[] }) => (res.content[0] as { text: string }).text;
const line = Array.from({ length: 41 }, (_, i) => ({ x: 20 + i * 8, y: 60 }));

describe('sticker provider contract', () => {
  it('the editor set, the fake provider and a combination of them conform', async () => {
    expect(await checkStickerProvider(editorStickers())).toEqual([]);
    expect(await checkStickerProvider(createFakeStickerProvider())).toEqual([]);
    expect(await checkStickerProvider(combineStickerProviders([editorStickers(), createFakeStickerProvider()]))).toEqual([]);
  });

  it('the conformance check reports a provider that breaks the contract', async () => {
    const bad: StickerProvider = {
      id: 'bad:id',
      name: 'Bad',
      capabilities: { supportsSearch: true, supportsSvg: false, supportsRaster: true },
      list: () => ({ items: [{ id: 'a', name: 'A', category: 'x', width: 10, height: 10, formats: ['svg'], licence: { name: '', commercial: true }, tintable: false }, { id: 'a', name: 'A', category: 'x', width: 0, height: 10, formats: ['png'], licence: { name: 'L', commercial: true }, tintable: false }], total: 5 }),
      search: () => ({ items: [], total: 0 }),
      describe: () => undefined,
      load: () => ({ kind: 'svg', svg: '<svg></svg>' }),
    };
    const messages = (await checkStickerProvider(bad)).map((i) => i.message).join('\n');
    expect(messages).toMatch(/provider id contains ":"/);
    expect(messages).toMatch(/duplicate id "a"/);
    expect(messages).toMatch(/licence.name is missing/);
    expect(messages).toMatch(/lists svg but capabilities.supportsSvg is false/);
    expect(messages).toMatch(/width and height must be positive/);
    expect(messages).toMatch(/total says 5/);
    expect(messages).toMatch(/load of an unknown id did not reject/);
  });

  it('pages, filters and searches a catalogue; refs parse, normalise and suggest the closest', () => {
    const items = createFakeStickerProvider().list({ limit: 100 }) as Awaited<ReturnType<StickerProvider['list']>>;
    const all = (items as { items: any[] }).items;
    const p1 = stickerPage(all, { limit: 5 });
    expect(p1.items).toHaveLength(5);
    expect(p1.total).toBe(all.length);
    expect(stickerPage(all, { limit: 5, after: p1.next }).items[0].id).toBe(all[5].id);
    expect(stickerPage(all, { category: 'food' }).items.every((s) => s.category === 'food')).toBe(true);
    expect(stickerPage(all, { tags: ['fruit', 'cherry'] }).items.map((s) => s.id)).toEqual(['fruit-cherry']);
    expect(stickerPage(all, { licence: { commercial: true } }).items.some((s) => s.id === 'art-sketch')).toBe(false);
    expect(stickerPage(all, {}, 'sun').items.map((s) => s.id)).toEqual(['weather-sun']);
    expect(() => stickerPage(all, { limit: 0 })).toThrow(/limit must be a whole number from 1 to 100/);
    expect(() => stickerPage(all, { after: 'x' })).toThrow(/not a cursor/);
    expect(parseStickerRef('star')).toEqual({ provider: 'editor', id: 'star' });
    expect(normalizeStickerRef('fake:fruit-apple')).toBe('fake:fruit-apple');
    expect(() => parseStickerRef('teapot')).toThrow(/not a sticker ref/);
    expect(closestStickerRefs('editor:stra', ['editor:star', 'editor:ring', 'editor:dot'], 1)).toEqual(['editor:star']);
  });

  it('combines providers: namespaced ids, paging through each in turn, describe and load by ref', async () => {
    const c = combineStickerProviders([editorStickers(), createFakeStickerProvider()]);
    expect(c.namespaced).toBe(true);
    const seen: string[] = [];
    let after: string | undefined;
    let total = 0;
    do {
      const page = await c.list({ limit: 7, ...(after ? { after } : {}) });
      total = page.total;
      seen.push(...page.items.map((s) => s.id));
      after = page.next;
    } while (after);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toContain('editor:star');
    expect(seen).toContain('fake:fruit-apple');
    expect((await c.describe('fake:badge-new'))?.id).toBe('fake:badge-new');
    expect((await c.load('editor:heart', { format: 'svg' })).kind).toBe('svg');
    await expect(c.load('nope:x')).rejects.toThrow(/No sticker provider "nope"; the providers are editor, fake/);
    expect(() => combineStickerProviders([createFakeStickerProvider(), createFakeStickerProvider()])).toThrow(/Two sticker providers have the id "fake"/);
  });

  it('the editor set draws each stamp as an SVG outline and a PNG, recoloured when asked', async () => {
    const p = editorStickers();
    const svg = (await p.load('star', { colour: '#123456' })) as { kind: 'svg'; svg: string; silhouette: string };
    expect(svg.svg).toMatch(/fill="#123456"/);
    expect(svg.silhouette).toMatch(/^M[\d.]+ [\d.]+L/);
    // A ring has a hole: two loops.
    expect(((await p.load('ring')) as { svg: string }).svg.match(/M/g)!.length).toBe(2);
    const png = (await p.load('dot', { format: 'png', size: 32, colour: '#ff0000' })) as { kind: 'image'; url: string };
    const img = decodePng(parseDataUrl(png.url)!.bytes);
    const centre = ((16 * 32 + 16) * 4);
    expect([img.data[centre], img.data[centre + 1], img.data[centre + 2], img.data[centre + 3]]).toEqual([255, 0, 0, 255]);
    expect(img.data[3]).toBe(0);
    await expect(Promise.resolve().then(() => p.load('teapot'))).rejects.toThrow(/its stickers are dot, star/);
    expect(() => p.load('star', { format: 'png', size: 4 })).toThrow(/size must be a whole number of px from 8 to 1024/);
  });

  describe('find_stickers and describe_sticker', () => {
    const registry = () => {
      const r = new ToolRegistry();
      r.register(createStickerToolProvider({ provider: () => combineStickerProviders([editorStickers(), createFakeStickerProvider()]) }));
      return r;
    };

    it('finds by words, category, tags and licence, pages, and describes by ref', async () => {
      const r = registry();
      const found = ok(await r.callTool('find_stickers', { query: 'heart' }));
      expect(found.items.map((s: { ref: string }) => s.ref)).toEqual(['editor:heart']);
      expect(found.items[0]).toMatchObject({ tintable: true, licence: { spdx: 'MIT', commercial: true } });
      expect(found.items[0].thumbnail).toBeUndefined();
      expect(found.categories.map((c: { id: string }) => c.id)).toContain('food');
      const page = ok(await r.callTool('find_stickers', { limit: 3 }));
      expect(page.items).toHaveLength(3);
      const next = ok(await r.callTool('find_stickers', { limit: 3, after: page.next }));
      expect(next.items[0].ref).not.toBe(page.items[0].ref);
      expect(ok(await r.callTool('find_stickers', { category: 'food', tags: ['cherry'] })).items.map((s: { ref: string }) => s.ref)).toEqual(['fake:fruit-cherry']);
      expect(ok(await r.callTool('find_stickers', { commercial: true, limit: 100 })).items.some((s: { ref: string }) => s.ref === 'fake:art-sketch')).toBe(false);
      const d = ok(await r.callTool('describe_sticker', { ref: 'fake:art-sketch' }));
      expect(d).toMatchObject({ ref: 'fake:art-sketch', licence: { attribution: 'Fake Artist', commercial: false }, tintable: false });
    });

    it('refuses bad refs, unknown categories and limits out of range, naming the valid choices', async () => {
      const r = registry();
      const bad = await r.callTool('describe_sticker', { ref: 'editor:stra' });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/No sticker "editor:stra".*Closest: editor:star/);
      const cat = await r.callTool('find_stickers', { category: 'cars' });
      expect(text(cat)).toMatch(/No category "cars".*categories: .*food/);
      for (const limit of [0, 101]) expect((await r.callTool('find_stickers', { limit })).isError).toBe(true);
      expect(text(await r.callTool('describe_sticker', { ref: 'teapot' }))).toMatch(/not a sticker ref/);
    });
  });
});

describe('stickers in the paint editor', () => {
  /** sticker-stars on cold-pressed paper, sprayed along a wave, with a heart placed on top: the pixels before stickers had refs. */
  const BEFORE_REFS = 'f2144fb045ea';
  const wave = Array.from({ length: 81 }, (_, i) => ({ x: 30 + i * 4, y: 100 + Math.sin(i / 8) * 40, pressure: 0.5 + 0.5 * Math.sin(i / 20), t: i * 10 }));

  it('a saved brush with bare stamps reads as editor refs and paints exactly as before', () => {
    const digest = (stamps: string[]) => {
      const c = new PaintEditorController({ width: 400, height: 200, paper: 'cold-pressed' });
      c.paintStroke({ brushId: 'sticker-stars', brush: { sticker: { stamps } }, points: wave, color: '#c2410c', seed: 9 });
      c.addStickers(undefined, [{ stamp: 'heart', x: 200, y: 100, size: 40 }]);
      return createHash('sha1').update(c.compositePixels().data).digest('hex').slice(0, 12);
    };
    expect(digest(['star', 'sparkle'])).toBe(BEFORE_REFS);
    expect(digest(['editor:star', 'editor:sparkle'])).toBe(BEFORE_REFS);
    const c = new PaintEditorController({ width: 64, height: 64 });
    c.setBrush({ id: 'sticker-stars', sticker: { stamps: ['star', 'heart', 'editor:heart'] } });
    expect(c.getState().brush.sticker.stamps).toEqual(['editor:star', 'editor:heart']);
  });

  it('loads stickers saved with the old stamp field as refs', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    c.addLayer();
    const [s] = c.addStickers(undefined, [{ ref: 'editor:leaf', x: 40, y: 40, size: 30 }]);
    expect(s).toMatchObject({ ref: 'editor:leaf', stamp: 'leaf' });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    for (const list of Object.values(json.extensions?.stickers ?? json.stickers ?? {}) as Array<Array<Record<string, unknown>>>) for (const x of list) delete x.ref;
    const d = new PaintEditorController({ width: 120, height: 80 });
    expect(d.loadJSON(json)).toEqual([]);
    expect(d.listStickers(c.getActiveLayer()!.id)[0]).toMatchObject({ ref: 'editor:leaf', stamp: 'leaf' });
  });

  it('sprays a provider sticker once its art has loaded: tinted when tintable, its own colours when not', async () => {
    const c = new PaintEditorController({ width: 400, height: 140, paper: 'smooth', stickers: createFakeStickerProvider() });
    c.setBrush({ id: 'sticker-stars', sticker: { stamps: ['fake:badge-new'], sizeJitter: 0, scatter: 0, colorJitter: 0 } });
    // The load started with setBrush; a stroke before it lands skips the sticker and says so.
    const early = c.paintStroke({ points: line, color: '#7c3aed', seed: 1 });
    expect(early.skippedStickers).toEqual(['fake:badge-new']);
    await c.prepareStickers(['fake:badge-new']);
    expect(c.stickerArtStatus('fake:badge-new').status).toBe('ready');
    c.addLayer();
    c.paintStroke({ points: line, color: '#7c3aed', seed: 1 });
    const stickers = c.listStickers();
    expect(stickers.length).toBeGreaterThan(3);
    expect(stickers[0].ref).toBe('fake:badge-new');
    expect(stickers[0].stamp).toBeUndefined();
    const layer = c.getActiveLayer() as PaintPixelLayer;
    const s = stickers[0];
    // The badge's ring is drawn in the paint colour; its square notch is empty.
    const ring = readPixel(layer.surface, Math.round(s.x - s.size * 0.35), Math.round(s.y));
    expect(ring[3]).toBeGreaterThan(200);
    expect(Math.abs(ring[0] - 0x7c) + Math.abs(ring[1] - 0x3a) + Math.abs(ring[2] - 0xed)).toBeLessThan(12);
    expect(readPixel(layer.surface, Math.round(s.x), Math.round(s.y))[3]).toBe(0);
    // A two-colour tile keeps its colours.
    c.addLayer();
    await c.prepareStickers(['fake:fruit-apple']);
    const [tile] = c.addStickers(undefined, [{ ref: 'fake:fruit-apple', x: 100, y: 70, size: 60, color: '#000000' }]);
    const t = c.getActiveLayer() as PaintPixelLayer;
    expect(readPixel(t.surface, 100, 50).slice(0, 3)).toEqual([0x16, 0x65, 0x34]);
    expect(readPixel(t.surface, 100, 90).slice(0, 3)).toEqual([0xdc, 0x26, 0x26]);
    expect(c.stickerAt(undefined, tile.x, tile.y + 20)?.id).toBe(tile.id);
  });

  it('sprays animated stickers in perform (real-time) and random frame modes, and places/updates specific frames', async () => {
    const c = new PaintEditorController({ width: 320, height: 140, paper: 'smooth', stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()]) });
    await c.prepareStickers(['fake:weather-wind']);
    const windDesc = await c.stickersProvider.describe('fake:weather-wind');
    expect(windDesc).toMatchObject({ animated: true, frameCount: 4, frameDelay: 100 });

    // Perform mode (default): advances frames according to elapsed stroke time (ms).
    c.addLayer();
    c.setBrush({ id: 'sticker-stars', tip: { size: 30 }, sticker: { stamps: ['fake:weather-wind'], density: 0.5, scatter: 0, sizeJitter: 0, rotationJitter: 0 } });
    expect(c.getState().brush.sticker.frameMode).toBeUndefined();
    const timedLine = [
      { x: 20, y: 70, pressure: 0.8, t: 1000 },
      { x: 100, y: 70, pressure: 0.8, t: 1120 },
      { x: 180, y: 70, pressure: 0.8, t: 1240 },
      { x: 260, y: 70, pressure: 0.8, t: 1360 },
    ];
    c.paintStroke({ points: timedLine, color: '#14b8a6', seed: 11 });
    const performed = c.listStickers();
    expect(performed.length).toBeGreaterThanOrEqual(4);
    expect(performed[0].frame).toBeUndefined(); // frame 0 omitted
    const performFrames = performed.map((s) => s.frame ?? 0);
    expect(new Set(performFrames)).toEqual(new Set([0, 1, 2, 3]));
    // Frame progression is monotonic mod 4 along the timed stroke.
    for (let i = 1; i < performFrames.length; i++) {
      expect((performFrames[i] - performFrames[i - 1] + 4) % 4).toBeLessThanOrEqual(2);
    }

    // Random mode: picks seeded frames even without timestamps, and round-trips through facet brushes.
    c.addLayer();
    c.setBrush({ id: 'sticker-stars', tip: { size: 30 }, sticker: { stamps: ['fake:weather-wind'], density: 0.6, scatter: 0, sizeJitter: 0, rotationJitter: 0, frameMode: 'random' } });
    expect(c.getState().brush.sticker.frameMode).toBe('random');
    c.paintStroke({ points: line, color: '#14b8a6', seed: 42 });
    const randomized = c.listStickers().map((s) => s.frame ?? 0);
    expect(new Set(randomized).size).toBeGreaterThan(1);
    c.undo();
    c.paintStroke({ points: line, color: '#14b8a6', seed: 42 });
    expect(c.listStickers().map((s) => s.frame ?? 0)).toEqual(randomized);

    // Explicit frame placement and update_sticker frame change: notch moves between frames 0 and 2.
    c.addLayer();
    const [placed] = c.addStickers(undefined, [{ ref: 'fake:weather-wind', x: 120, y: 70, size: 120, color: '#0ea5e9', frame: 0 }]);
    const l0 = c.getActiveLayer() as PaintPixelLayer;
    // Frame 0 notch is at (45..75, 45..75) -> centre (120, 70) is transparent, (100, 90) is filled.
    expect(readPixel(l0.surface, 120, 70)[3]).toBe(0);
    expect(readPixel(l0.surface, 100, 90)[3]).toBeGreaterThan(200);
    // Frame 2 notch is at (35..65, 55..85) in 120x120 art -> (110, 80) in doc coords is inside the notch (transparent).
    c.updateSticker(undefined, placed.id, { frame: 2 });
    const l2 = c.getActiveLayer() as PaintPixelLayer;
    expect(readPixel(l2.surface, 110, 80)[3]).toBe(0);
  });

  it('checks a placed frame against the art through the tools: frame 0 left out, past the last refused, restamping resets it', async () => {
    const c = new PaintEditorController({ width: 160, height: 100, paper: 'smooth', stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()]) });
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c));
    c.addLayer();
    const added = ok(await r.callTool('add_stickers', { stickers: [{ ref: 'fake:weather-wind', x: 50, y: 50, size: 40, frame: 2 }, { ref: 'fake:weather-wind', x: 110, y: 50, size: 40, frame: 0 }] }));
    expect(added.stickers[0].frame).toBe(2);
    expect('frame' in added.stickers[1]).toBe(false);
    const id = added.stickers[0].id;

    // Out of range: refused before anything changes, naming the frames it has.
    const before = c.listStickers();
    const far = await r.callTool('update_sticker', { id, frame: 4 });
    expect(far.isError).toBe(true);
    expect(text(far)).toContain('"fake:weather-wind" has 4 frames, so frame is 0..3; got 4.');
    expect(c.listStickers()).toEqual(before);
    const stat = await r.callTool('add_stickers', { stickers: [{ ref: 'editor:star', x: 10, y: 10, frame: 1 }] });
    expect(stat.isError).toBe(true);
    expect(text(stat)).toContain('Sticker 0: "editor:star" is not animated, so its only frame is 0; got 1');
    expect((await r.callTool('update_sticker', { id, frame: 1.5 })).isError).toBe(true);

    // Frame 0 is the saved form of the first frame: left out, not stored as 0.
    const zero = ok(await r.callTool('update_sticker', { id, frame: 0 }));
    expect('frame' in zero).toBe(false);
    expect(c.listStickers().find((s) => s.id === id)).not.toHaveProperty('frame');

    // Hit-testing follows the frame: frame 3's notch is at art (25..55, 45..75), so (40, 60) misses there and hits at frame 0.
    expect(ok(await r.callTool('sticker_at', { x: 50 - 20 / 3, y: 50 })).sticker?.id).toBe(id);
    ok(await r.callTool('update_sticker', { id, frame: 3 }));
    expect(ok(await r.callTool('sticker_at', { x: 50 - 20 / 3, y: 50 })).sticker).toBeNull();

    // Undo and redo restore the frame; a saved and loaded document keeps it.
    ok(await r.callTool('undo_paint', {}));
    expect(c.listStickers().find((s) => s.id === id)).not.toHaveProperty('frame');
    ok(await r.callTool('redo_paint', {}));
    expect(c.listStickers().find((s) => s.id === id)?.frame).toBe(3);
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    const layerId = c.getActiveLayer()!.id;
    const saved = (json.extensions?.stickers ?? json.stickers)[layerId] as Array<Record<string, unknown>>;
    saved[1].frame = 0;
    saved.push({ ...saved[1], id: 'st99', frame: -2 });
    const d = new PaintEditorController({ width: 160, height: 100, stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()]) });
    d.loadJSON(json);
    const loaded = d.listStickers(layerId);
    expect(loaded[0].frame).toBe(3);
    expect(loaded[1]).not.toHaveProperty('frame');
    expect(loaded[2]).not.toHaveProperty('frame');

    // Restamping without a frame starts the new sticker at its first frame.
    const heart = ok(await r.callTool('update_sticker', { id, ref: 'editor:heart' }));
    expect('frame' in heart).toBe(false);
  });

  it('plays an animated sticker by stroke time in perform mode: no times, every sticker the first frame', async () => {
    const c = new PaintEditorController({ width: 320, height: 140, paper: 'smooth', stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()]) });
    await c.prepareStickers(['fake:weather-wind']);
    c.addLayer();
    c.setBrush({ id: 'sticker-stars', tip: { size: 30 }, sticker: { stamps: ['fake:weather-wind'], density: 0.5, scatter: 0, sizeJitter: 0, rotationJitter: 0 } });
    c.paintStroke({ points: line, color: '#14b8a6', seed: 3 });
    expect(c.listStickers().every((s) => s.frame === undefined)).toBe(true);
    // The frame is floor(ms since the stroke's first timed sample / frameDelay) mod frameCount, whatever the first t is.
    c.addLayer();
    c.paintStroke({ points: [{ x: 20, y: 60, t: 5000 }, { x: 300, y: 60, t: 5390 }], color: '#14b8a6', seed: 3 });
    const frames = c.listStickers().map((s) => s.frame ?? 0);
    expect(frames[0]).toBe(0);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    expect(frames.at(-1)).toBe(3);
  });

  it('refuses to redraw stickers whose art has not loaded, and reports a failed load', async () => {
    const c = new PaintEditorController({ width: 200, height: 120, stickers: createFakeStickerProvider({ failIds: ['badge-sale'] }) });
    c.addLayer();
    expect(() => c.addStickers(undefined, [{ ref: 'fake:badge-hot', x: 50, y: 50 }])).toThrow(/has not loaded yet/);
    await expect(c.prepareStickers(['fake:badge-sale'])).rejects.toThrow(/failed to load/);
    expect(c.stickerArtStatus('fake:badge-sale')).toMatchObject({ status: 'failed', error: expect.stringMatching(/failIds/) });
    await expect(c.prepareStickers(['fake:badge-nwe'])).rejects.toThrow(/Closest: fake:badge-new/);
    // Back to the editor's own stamps.
    c.setStickersProvider(null);
    expect(c.stickersProvider.id).toBe('editor');
  });

  describe('agent path', () => {
    const setup = () => {
      const c = new PaintEditorController({ width: 400, height: 140, paper: 'smooth', stickers: combineStickerProviders([editorStickers(), createFakeStickerProvider()]) });
      const r = new ToolRegistry();
      r.register(createPaintEditorToolProvider(c));
      return { c, r };
    };

    it('finds a sticker, sprays it with a sticker brush and places one, loading the art first', async () => {
      const { c, r } = setup();
      const found = ok(await r.callTool('find_stickers', { query: 'sun' }));
      const ref = found.items[0].ref;
      expect(ref).toBe('fake:weather-sun');
      ok(await r.callTool('set_brush', { id: 'sticker-stars', tip: { stamps: [ref, 'editor:star'] } }));
      ok(await r.callTool('add_layer', {}));
      const stroke = ok(await r.callTool('paint_stroke', { points: line, color: '#0ea5e9', seed: 3 }));
      expect(stroke.skippedStickers).toBeUndefined();
      const refs = new Set(c.listStickers().map((s) => s.ref));
      expect(refs).toEqual(new Set(['fake:weather-sun', 'editor:star']));
      ok(await r.callTool('add_layer', {}));
      const placed = ok(await r.callTool('add_stickers', { stickers: [{ ref: 'fake:fruit-pear', x: 60, y: 60, size: 50 }, { stamp: 'heart', x: 140, y: 60 }] }));
      expect(placed.stickers.map((s: { ref: string }) => s.ref)).toEqual(['fake:fruit-pear', 'editor:heart']);
      const changed = ok(await r.callTool('update_sticker', { id: placed.stickers[1].id, ref: 'fake:badge-free' }));
      expect(changed).toMatchObject({ ref: 'fake:badge-free' });
      expect(changed.stamp).toBeUndefined();
    });

    it('refuses unknown refs with the closest ones, and changes nothing', async () => {
      const { c, r } = setup();
      const before = c.getState().brush;
      const res = await r.callTool('set_brush', { id: 'sticker-stars', tip: { stamps: ['fake:weather-snu'] } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/No sticker "fake:weather-snu".*Closest: .*fake:weather-sun/);
      expect(c.getState().brush).toBe(before);
      ok(await r.callTool('add_layer', {}));
      const add = await r.callTool('add_stickers', { stickers: [{ ref: 'acme:logo', x: 10, y: 10 }] });
      expect(text(add)).toMatch(/No sticker "acme:logo"/);
      expect(text(await r.callTool('add_stickers', { stickers: [{ x: 10, y: 10 }] }))).toMatch(/needs ref/);
      expect(c.listStickers()).toEqual([]);
    });
  });

  it('StickerError carries a code', () => {
    expect(new StickerError('unknown_sticker', 'x').code).toBe('unknown_sticker');
  });
});
