import { describe, expect, it } from 'vitest';
import {
  checkStickerProvider,
  checkStickerVariant,
  combineStickerProviders,
  createFakeStickerProvider,
  createStickerToolProvider,
  editorStickers,
  StickerBrowser,
  stickerPage,
  stickerVariantFor,
  type StickerProvider,
  type StickerSummary,
} from '../src/stickers';
import { createCanvasStickerHost } from '../src/canvas/stickers';
import type { CanvasNode } from '../src/canvas/types';
import { createVectorStickerHost } from '../src/vector/stickers';
import { VectorEditorController } from '../src/vector/controller';
import { PaintEditorController, type PaintPixelLayer } from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as any;
};
const text = (res: { isError?: boolean; content: unknown[] }) => {
  expect(res.isError).toBe(true);
  return (res.content[0] as { text: string }).text;
};
const library = () => combineStickerProviders([editorStickers(), createFakeStickerProvider()]);
/** A conforming one-sticker provider with `patch` on its summary, to break one rule at a time. */
const oneSticker = (patch: Partial<StickerSummary> & Record<string, unknown>, extra: Partial<StickerProvider> = {}): StickerProvider => {
  const s = { id: 'a', name: 'A', category: 'x', width: 10, height: 10, formats: ['svg'], licence: { name: 'L', commercial: true }, tintable: false, ...patch } as StickerSummary;
  return {
    id: 'one',
    name: 'One',
    capabilities: { supportsSearch: true, supportsSvg: true, supportsRaster: false },
    list: (o) => stickerPage([s], o),
    search: (q, o) => stickerPage([s], o, q),
    describe: (id) => (id === 'a' ? { ...s } : undefined),
    load: (id, o) => {
      if (id !== 'a') throw new Error('unknown');
      checkStickerVariant(s, o?.variant);
      return { kind: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' };
    },
    ...extra,
  };
};

describe('sticker contract: AI-generated art, light / dark variants and collections', () => {
  it('the fake provider says which art is AI-generated, which has a dark variant and its collection', async () => {
    const p = createFakeStickerProvider();
    const sun = (await p.describe('weather-sun'))!;
    expect(sun).toMatchObject({ aiGenerated: true, collection: 'outdoors' });
    expect(sun.variants).toBeUndefined();
    expect(await p.describe('fruit-apple')).toMatchObject({ variants: ['light', 'dark'], collection: 'kitchen' });
    expect((await p.describe('fruit-apple'))!.aiGenerated).toBeUndefined();
    expect((await p.describe('art-sketch'))!.collection).toBeUndefined();
    expect(await p.listCollections!()).toEqual([
      { id: 'outdoors', name: 'Outdoors', description: 'Weather, AI-generated.', count: 6 },
      { id: 'kitchen', name: 'Kitchen', description: 'Fruit tiles with dark variants.', count: 5 },
      { id: 'shop', name: 'Shop', description: 'Tintable sale badges.', count: 4 },
    ]);
    const kitchen = await p.list({ collection: 'kitchen' });
    expect(kitchen.total).toBe(5);
    expect(kitchen.items.every((s) => s.collection === 'kitchen')).toBe(true);
    expect((await p.search('apple', { collection: 'shop' })).total).toBe(0);
  });

  it('loads the dark variant when asked; refuses one the sticker lacks, naming the ones it has', async () => {
    const p = createFakeStickerProvider();
    const light = await p.load('fruit-apple', { format: 'svg' });
    const dark = await p.load('fruit-apple', { format: 'svg', variant: 'dark' });
    expect(light.kind === 'svg' && light.svg).toContain('#166534');
    expect(dark.kind === 'svg' && dark.svg).toContain('#f8fafc');
    expect(await p.load('fruit-apple', { variant: 'light' })).toEqual(light);
    await expect(p.load('badge-new', { variant: 'dark' })).rejects.toMatchObject({ code: 'unsupported_variant', message: 'Sticker "badge-new" has no "dark" variant; it has light.' });
    expect(() => editorStickers().load('star', { variant: 'dark' })).toThrow(/has no "dark" variant; it has light/);
    expect(stickerVariantFor({ variants: ['light', 'dark'] }, true)).toBe('dark');
    expect(stickerVariantFor({ variants: ['light', 'dark'] }, false)).toBe('light');
    expect(stickerVariantFor({}, true)).toBe('light');
  });

  it('the conformance check passes the new fields and reports each misuse', async () => {
    expect(await checkStickerProvider(createFakeStickerProvider())).toEqual([]);
    expect(await checkStickerProvider(library())).toEqual([]);
    const issues = async (p: StickerProvider) => (await checkStickerProvider(p)).map((i) => i.message);
    expect(await issues(oneSticker({ aiGenerated: 'yes' as unknown as boolean }))).toContain('aiGenerated must be a boolean when present');
    expect(await issues(oneSticker({ variants: ['dark'] }))).toContain('variants must include light (every sticker has its light art)');
    expect(await issues(oneSticker({ variants: ['light', 'sepia' as 'dark'] }))).toContain('variants must list light and / or dark, each once');
    expect(await issues(oneSticker({ collection: 'brand' }))).toContain('is in collection "brand" but the provider has no listCollections()');
    expect(await issues(oneSticker({ collection: 'brand' }, { listCollections: () => [{ id: 'brand', name: 'Brand', count: 2 }] }))).toContain('collection "brand" says count 2 but list({ collection }) has 1');
    // A provider that ignores the variant: dark art for a sticker that has none is not refused.
    expect(await issues(oneSticker({}, { load: () => ({ kind: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) }))).toContain('load({ variant: "dark" }) did not reject for a sticker without a dark variant (checkStickerVariant does it)');
  });

  it('a combination namespaces collections by provider and filters by them', async () => {
    const c = library();
    expect((await c.listCollections!()).map((x) => [x.id, x.count])).toEqual([
      ['fake:outdoors', 6],
      ['fake:kitchen', 5],
      ['fake:shop', 4],
    ]);
    const page = await c.list({ collection: 'fake:kitchen', limit: 3 });
    expect(page.total).toBe(5);
    expect(page.items.map((s) => [s.id, s.collection])).toEqual([
      ['fake:fruit-apple', 'fake:kitchen'],
      ['fake:fruit-pear', 'fake:kitchen'],
      ['fake:fruit-cherry', 'fake:kitchen'],
    ]);
    const rest = await c.list({ collection: 'fake:kitchen', limit: 3, after: page.next });
    expect(rest.items).toHaveLength(2);
    expect(rest.next).toBeUndefined();
    expect((await c.describe('fake:fruit-pear'))?.collection).toBe('fake:kitchen');
    await expect(c.list({ collection: 'kitchen' })).rejects.toThrow(/No collection "kitchen"; collections here are "provider:collection"/);
    expect((await c.load('fake:fruit-pear', { variant: 'dark' })).kind).toBe('svg');
  });

  it('the browser behind the pickers filters by collection and forgets one the provider lacks', async () => {
    let provider: StickerProvider = createFakeStickerProvider();
    const b = new StickerBrowser(() => provider, 4);
    await b.refresh();
    expect(b.state.collections.map((c) => c.id)).toEqual(['outdoors', 'kitchen', 'shop']);
    await b.setCollection('shop');
    expect(b.state).toMatchObject({ collection: 'shop', total: 4 });
    expect(b.state.items.every((s) => s.collection === 'shop')).toBe(true);
    provider = editorStickers();
    await b.refresh();
    expect(b.state).toMatchObject({ collection: '', collections: [], total: 9 });
  });

  describe('agent tools', () => {
    const setup = (dark = false) => {
      let nodes: CanvasNode[] = [];
      const r = new ToolRegistry();
      r.register(createStickerToolProvider({ provider: library, insert: createCanvasStickerHost({ getNodes: () => nodes, setNodes: (n) => (nodes = n), dark: () => dark }) }));
      return { r, nodes: () => nodes };
    };

    it('find_stickers filters by collection and returns aiGenerated, variants and the collections', async () => {
      const { r } = setup();
      const res = ok(await r.callTool('find_stickers', { collection: 'fake:outdoors', limit: 2 }));
      expect(res.total).toBe(6);
      expect(res.items[0]).toMatchObject({ ref: 'fake:weather-sun', aiGenerated: true, collection: 'fake:outdoors' });
      expect(res.collections.map((c: { id: string }) => c.id)).toEqual(['fake:outdoors', 'fake:kitchen', 'fake:shop']);
      const fruit = ok(await r.callTool('find_stickers', { query: 'apple' }));
      expect(fruit.items[0]).toMatchObject({ ref: 'fake:fruit-apple', variants: ['light', 'dark'] });
      expect(ok(await r.callTool('describe_sticker', { ref: 'fake:fruit-apple' }))).toMatchObject({ variants: ['light', 'dark'], collection: 'fake:kitchen' });
      expect(text(await r.callTool('find_stickers', { collection: 'fake:garden' }))).toBe('No collection "fake:garden" in "Editor stickers + Fake stickers"; collections: fake:outdoors, fake:kitchen, fake:shop.');
      const plain = new ToolRegistry();
      plain.register(createStickerToolProvider({ provider: () => editorStickers() }));
      expect(ok(await plain.callTool('find_stickers', {})).collections).toBeUndefined();
      expect(text(await plain.callTool('find_stickers', { collection: 'shop' }))).toBe('"Editor stickers" has no collections; leave collection out.');
    });

    it('insert_sticker picks the dark variant on a dark background, takes one asked for, and refuses one the sticker lacks', async () => {
      const light = setup(false);
      expect(ok(await light.r.callTool('insert_sticker', { ref: 'fake:fruit-apple' })).variant).toBe('light');
      expect(ok(await light.r.callTool('insert_sticker', { ref: 'fake:fruit-apple', variant: 'dark' })).variant).toBe('dark');
      const dark = setup(true);
      const res = ok(await dark.r.callTool('insert_sticker', { ref: 'fake:fruit-apple' }));
      expect(res.variant).toBe('dark');
      expect(dark.nodes().find((n) => n.id === res.id)!.data).toMatchObject({ sticker: { ref: 'fake:fruit-apple', variant: 'dark' } });
      // No dark art: the light art, even on a dark background.
      expect(ok(await dark.r.callTool('insert_sticker', { ref: 'editor:star' })).variant).toBe('light');
      expect(ok(await dark.r.callTool('insert_sticker', { ref: 'editor:star', variant: 'light' })).variant).toBe('light');
      expect(text(await dark.r.callTool('insert_sticker', { ref: 'editor:star', variant: 'dark' }))).toBe('"editor:star" has no "dark" variant; it has light. Leave variant out to pick for the background.');
      expect(text(await dark.r.callTool('insert_sticker', { ref: 'fake:fruit-apple', variant: 'dim' }))).toMatch(/variant/);
      expect(dark.nodes()).toHaveLength(3);
    });

    it('the vector editor gets the dark art as paths', async () => {
      const c = new VectorEditorController({ width: 400, height: 300 });
      const r = new ToolRegistry();
      r.register(createStickerToolProvider({ provider: library, insert: createVectorStickerHost(c, { dark: () => true }) }));
      const res = ok(await r.callTool('insert_sticker', { ref: 'fake:fruit-pear' }));
      expect(res.variant).toBe('dark');
      expect(JSON.stringify(c.getDocument())).toContain('#f8fafc');
    });
  });

  describe('the paint editor sticker brush', () => {
    const line = Array.from({ length: 41 }, (_, i) => ({ x: 20 + i * 8, y: 70 }));
    const spray = async (scheme: 'light' | 'dark') => {
      const c = new PaintEditorController({ width: 400, height: 140, paper: 'smooth', stickers: createFakeStickerProvider(), colorScheme: scheme });
      c.setBrush({ id: 'sticker-stars', sticker: { stamps: ['fake:fruit-apple'], sizeJitter: 0, scatter: 0, colorJitter: 0, rotationJitter: 0 } });
      await c.prepareStickers(['fake:fruit-apple']);
      c.addLayer();
      c.paintStroke({ points: line, color: '#000000', seed: 1 });
      return c;
    };
    /** The top half of the first sticker: the tile's own green on light, pale on dark. */
    const top = (c: PaintEditorController) => {
      const s = c.listStickers()[0];
      return readPixel((c.getActiveLayer() as PaintPixelLayer).surface, Math.round(s.x), Math.round(s.y - s.size * 0.2)).slice(0, 3);
    };

    it('sprays the dark variant on a dark colour scheme and records it on each sticker', async () => {
      const light = await spray('light');
      expect(light.listStickers()[0].variant).toBeUndefined();
      expect(top(light)).toEqual([0x16, 0x65, 0x34]);
      const dark = await spray('dark');
      expect(dark.listStickers().every((s) => s.variant === 'dark')).toBe(true);
      expect(top(dark)).toEqual([0xf8, 0xfa, 0xfc]);
      expect(dark.stickerArtStatus('fake:fruit-apple').status).toBe('ready');
    });

    it('keeps each sticker in the variant it was drawn in across a scheme change, saving and loading', async () => {
      const c = await spray('dark');
      const layerId = c.getActiveLayer()!.id;
      c.setColorScheme('light');
      const [first] = c.listStickers();
      // Moving it redraws it in its own (dark) art.
      c.updateSticker(undefined, first.id, { x: first.x + 2 });
      expect(c.listStickers()[0].variant).toBe('dark');
      expect(top(c)).toEqual([0xf8, 0xfa, 0xfc]);
      // A new sticker on the light scheme is light; restamping picks again.
      await c.prepareStickers(['fake:fruit-pear']);
      const [placed] = c.addStickers(undefined, [{ ref: 'fake:fruit-pear', x: 200, y: 30, size: 30 }]);
      expect(placed.variant).toBeUndefined();
      c.setColorScheme('dark');
      await c.prepareStickers(['fake:fruit-pear']);
      expect(c.updateSticker(undefined, placed.id, { ref: 'fake:fruit-pear' }).variant).toBe('dark');
      expect(c.updateSticker(undefined, placed.id, { ref: 'editor:star' }).variant).toBeUndefined();
      const json = JSON.parse(JSON.stringify(c.toJSON()));
      const d = new PaintEditorController({ width: 400, height: 140, stickers: createFakeStickerProvider() });
      expect(d.loadJSON(json)).toEqual([]);
      expect(d.listStickers(layerId)[0].variant).toBe('dark');
    });
  });
});
