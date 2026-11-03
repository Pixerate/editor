import { describe, expect, it } from 'vitest';
import { combineStickerProviders, createFakeStickerProvider, createStickerToolProvider, editorStickers, type StickerProvider } from '../src/stickers';
import { createFakeEffectProvider, type EffectDescription, type EffectProvider } from '../src/effects';
import { createVectorStickerHost, VectorEditorController, vectorNodeBounds, type VectorGroupNode } from '../src/vector';
import { createImageEffectsToolProvider, createImageStickerHost, ImageEditorController, readRegion, type PixelLayer, type SmartObjectLayer } from '../src/image-editor';
import { createCanvasStickerHost, getNodeShape, type CanvasNode } from '../src/canvas';
import { HistoryManager } from '../src/history';
import { ToolRegistry } from '../src/tools/registry';

const library = () => combineStickerProviders([editorStickers(), createFakeStickerProvider()]);
const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return res.structuredContent as any;
};
const text = (res: { content: unknown[] }) => (res.content[0] as { text: string }).text;

/** A provider whose only sticker has PNG art and no outline. */
const pngOnly = (): StickerProvider => {
  const base = createFakeStickerProvider({ id: 'png' });
  return {
    ...base,
    capabilities: { ...base.capabilities, supportsSvg: false },
    list: async (o) => {
      const p = await base.list({ ...o, category: 'food' });
      return { ...p, items: p.items.map((s) => ({ ...s, formats: ['png' as const] })) };
    },
    describe: async (id) => {
      const d = await base.describe(id);
      return d && { ...d, formats: ['png' as const], silhouette: undefined };
    },
  };
};

describe('insert_sticker', () => {
  describe('vector editor', () => {
    const setup = (provider: StickerProvider = library()) => {
      const c = new VectorEditorController();
      const r = new ToolRegistry();
      r.register(createStickerToolProvider({ provider: () => provider, insert: createVectorStickerHost(c) }));
      return { c, r };
    };

    it('puts a sticker in as a group of editable paths, placed, sized, tinted and one undo step', async () => {
      const { c, r } = setup();
      // A dot is symmetric, so its outline is centred in its box (the box is what is placed).
      const res = ok(await r.callTool('insert_sticker', { ref: 'editor:dot', x: 300, y: 200, width: 80, color: '#123456' }));
      expect(res).toMatchObject({ ref: 'editor:dot', width: 80, height: 80, licence: { spdx: 'MIT' } });
      const group = c.getNode(res.id) as VectorGroupNode;
      expect(group).toMatchObject({ type: 'group', name: 'Dot' });
      expect(group.children[0]).toMatchObject({ type: 'path' });
      expect(JSON.stringify(group)).toMatch(/#123456/);
      const b = vectorNodeBounds(group)!;
      expect(b.x + b.width / 2).toBeCloseTo(300, 0);
      expect(b.y + b.height / 2).toBeCloseTo(200, 0);
      expect(b.width).toBeGreaterThan(60);
      expect(b.width).toBeLessThanOrEqual(80);
      c.undo();
      expect(c.getNode(res.id)).toBeUndefined();
      // Without a place it goes in the middle of the document.
      const mid = ok(await r.callTool('insert_sticker', { ref: 'fake:badge-new' }));
      const mb = vectorNodeBounds(c.getNode(mid.id)!)!;
      expect(mb.x + mb.width / 2).toBeCloseTo(c.getDocument().width / 2, 0);
    });

    it('refuses raster-only art, a tint on art with its own colours, and unknown refs', async () => {
      const { r } = setup(combineStickerProviders([editorStickers(), pngOnly()]));
      expect(text(await r.callTool('insert_sticker', { ref: 'png:fruit-apple' }))).toMatch(/only raster art; the vector editor takes stickers with SVG art/);
      expect(text(await setup().r.callTool('insert_sticker', { ref: 'fake:fruit-apple', color: '#ff0000' }))).toMatch(/not tintable/);
      expect(text(await setup().r.callTool('insert_sticker', { ref: 'editor:hart' }))).toMatch(/Closest: editor:heart/);
      expect((await setup().r.callTool('insert_sticker', { ref: 'editor:star', width: -4 })).isError).toBe(true);
    });
  });

  describe('image editor', () => {
    const W = 200;
    const H = 120;
    const image = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;

    /**
     * The fake effects plus `test.holo`: an overlay effect whose picture input is called `image`
     * (not `source`), drawing the inverse of it, like a holo-foil sticker treatment.
     */
    const withHolo = (): EffectProvider => {
      const base = createFakeEffectProvider();
      const holo: EffectDescription = { ...(base.describe('fake.invert') as EffectDescription), id: 'test.holo', name: 'Holo', uses: ['overlay'], inputs: [{ name: 'image', kind: 'image', description: 'The sticker.', required: true }] };
      return {
        ...base,
        describe: (id) => (id === 'test.holo' ? structuredClone(holo) : base.describe(id)),
        createRenderer: async (id, o) => {
          if (id !== 'test.holo') return base.createRenderer(id, o);
          const inner = await base.createRenderer('fake.invert', o);
          return { ...inner, effectId: id, render: (req) => inner.render({ ...req, inputs: { source: req.inputs!.image } }) };
        },
      } as EffectProvider;
    };

    it('puts a sticker in as a pixel layer; an effect that takes a picture gets the sticker as its input', async () => {
      const c = new ImageEditorController({ image, effects: withHolo() });
      const r = new ToolRegistry();
      r.register(createStickerToolProvider({ provider: library, insert: createImageStickerHost(c), id: 'stickers', namespace: 'stickers' }));
      r.register(createImageEffectsToolProvider(c, { id: 'fx', namespace: 'fx' }));
      const res = ok(await r.callTool('stickers__insert_sticker', { ref: 'fake:badge-new', x: 100, y: 60, width: 96 }));
      expect(res).toMatchObject({ layerWidth: 96, layerHeight: 96 });
      const layer = c.getLayer(res.id) as PixelLayer;
      expect(layer).toMatchObject({ type: 'pixel', name: 'New badge' });
      // The badge's ring, in its own green: x 16 of 96 is on the ring (the middle is a notch).
      // Document point (68, 60): the layer is 96 px wide, centred on (100, 60), so its left edge is at 52.
      const ring = (l: PixelLayer | SmartObjectLayer) => [...readRegion(l.surface, { x: 68 - l.offset.x, y: 60 - l.offset.y, width: 1, height: 1 })];
      expect(ring(layer)).toEqual([0x16, 0xa3, 0x4a, 255]);
      // Through the agent tools: an overlay effect whose input is named "image" gets the sticker.
      const fx = ok(await r.callTool('fx__apply_effect', { target: res.id, effect: 'test.holo' }));
      expect(fx.effect).toMatchObject({ role: 'smart filter', effect: 'test.holo' });
      await c.effectsIdle();
      expect(ring(c.getLayer(res.id) as SmartObjectLayer)).toEqual([255 - 0x16, 255 - 0xa3, 255 - 0x4a, 255]);
      // The same treatment on a whole set is a loop of the two calls.
      for (const ref of ['fake:badge-sale', 'fake:badge-hot']) {
        const s = ok(await r.callTool('stickers__insert_sticker', { ref, width: 48 }));
        ok(await r.callTool('fx__apply_effect', { target: s.id, effect: 'test.holo' }));
      }
      await c.effectsIdle();
      expect(c.getLayers().filter((l) => (l as SmartObjectLayer).smartFilters?.filters.some((f) => (f as { effect?: string }).effect === 'test.holo')).length).toBe(3);
    });
  });

  describe('canvas', () => {
    const setup = (provider: StickerProvider = library()) => {
      let nodes: CanvasNode[] = [{ id: 'a', position: { x: 0, y: 0 }, width: 400, height: 300, data: {} }];
      const history = new HistoryManager();
      const host = createCanvasStickerHost({ getNodes: () => nodes, setNodes: (n) => (nodes = n), history });
      const r = new ToolRegistry();
      r.register(createStickerToolProvider({ provider: () => provider, insert: host }));
      return { r, history, nodes: () => nodes };
    };

    it('puts a sticker in as a shape node from its outline, in its tint or its own colour, one undo step', async () => {
      const { r, history, nodes } = setup();
      const res = ok(await r.callTool('insert_sticker', { ref: 'editor:heart', x: 100, y: 100, width: 60, color: '#e11d48' }));
      const node = nodes().find((n) => n.id === res.id)!;
      expect(node).toMatchObject({ type: 'shape', position: { x: 70, y: 70 }, width: 60, height: 60, data: { label: 'Heart', sticker: { ref: 'editor:heart' } } });
      expect(getNodeShape(node)).toMatchObject({ kind: 'path', fill: '#e11d48', fillRule: 'evenodd', viewBox: [0, 0, 100, 100] });
      expect(getNodeShape(node)!.kind === 'path' && getNodeShape(node)!.d).toMatch(/^M/);
      history.undo();
      expect(nodes().some((n) => n.id === res.id)).toBe(false);
      // Art with its own colours is reduced to its outline in its dominant colour; no place: the middle of the canvas.
      const tile = ok(await r.callTool('insert_sticker', { ref: 'fake:fruit-apple' }));
      const t = nodes().find((n) => n.id === tile.id)!;
      expect(getNodeShape(t)).toMatchObject({ fill: '#dc2626' });
      expect(t.position.x + (t.width ?? 0) / 2).toBeCloseTo(200);
    });

    it('refuses a sticker without an outline, naming what it needs', async () => {
      const { r } = setup(combineStickerProviders([editorStickers(), pngOnly()]));
      expect(text(await r.callTool('insert_sticker', { ref: 'png:fruit-apple' }))).toMatch(/has no outline \(silhouette\)/);
    });
  });
});
