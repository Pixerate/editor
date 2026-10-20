import { describe, expect, it, vi } from 'vitest';
import { createEffectPixels, createFakeEffectProvider, encodeEffectFloat } from '../src/effects';
import { ToolRegistry } from '../src/tools';
import { surfaceDepth } from '../src/raster/deep';
import {
  ImageEditorController,
  createImageEffectsToolProvider,
  effectPixelsToSurface,
  isSmartSurfaceIncomplete,
  readRegion,
  type PixelLayer,
  type SmartObjectLayer,
} from '../src/image-editor';

const W = 16;
const H = 8;

function setup(effects = createFakeEffectProvider() as ReturnType<typeof createFakeEffectProvider> | null) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, effects });
  return c;
}

/** A layer of solid `rgba` over the whole canvas. */
function solid(c: ImageEditorController, rgba: [number, number, number, number], name = 'Solid') {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return c.addPixelLayer({ name, pixels: { width: W, height: H, data } });
}

const pixel = (c: ImageEditorController, id: string, x = 0, y = 0) => [...readRegion((c.getLayer(id) as SmartObjectLayer | PixelLayer).surface, { x, y, width: 1, height: 1 })];
const steps = (c: ImageEditorController) => (c as unknown as { undoStack: unknown[] }).undoStack.length;

describe('image provider effects: smart filters', () => {
  it('applies a filter effect as a smart filter, converting a pixel layer in the same undo step', async () => {
    const c = setup();
    const id = solid(c, [10, 20, 30, 255]);
    const before = steps(c);
    const r = await c.applyEffectFilter(id, 'fake.invert');
    expect(r).toMatchObject({ layerId: id, converted: true, filter: { kind: 'effect', effect: 'fake.invert', name: 'Invert', provider: 'fake', values: { amount: 1 }, blend: 'normal', opacity: 1 } });
    expect(steps(c)).toBe(before + 1);
    // Drawn without the effect while it renders, then with it.
    expect(isSmartSurfaceIncomplete((c.getLayer(id) as SmartObjectLayer).surface)).toBe(true);
    expect(pixel(c, id)).toEqual([10, 20, 30, 255]);
    await c.effectsIdle();
    expect(pixel(c, id)).toEqual([245, 235, 225, 255]);
    expect(steps(c)).toBe(before + 1);
    c.undo();
    expect(c.getLayer(id)?.type).toBe('pixel');
  });

  it('stacks with blend and opacity, updates values, reorders and removes', async () => {
    const c = setup();
    const id = solid(c, [0, 0, 0, 255]);
    const { filter: tint } = await c.applyEffectFilter(id, 'fake.tint', { values: { color: '#ffffff', amount: 1 } });
    const { filter: inv } = await c.applyEffectFilter(id, 'fake.invert', { opacity: 0.5 });
    await c.effectsIdle();
    // White, then half inverted: grey.
    expect(pixel(c, id)[0]).toBe(128);
    await c.updateEffectFilter(id, inv.id, { index: 0 });
    await c.effectsIdle();
    // Half inverted black is grey, then tinted fully white.
    expect(pixel(c, id)[0]).toBe(255);
    const updated = await c.updateEffectFilter(id, tint.id, { values: { amount: null, color: '#000000' } });
    expect(updated).toMatchObject({ values: { amount: 0.5, color: '#000000' } });
    await c.effectsIdle();
    expect(pixel(c, id)[0]).toBe(64);
    c.removeSmartFilter(id, tint.id);
    await c.effectsIdle();
    expect(pixel(c, id)[0]).toBe(128);
  });

  it('respects the smart filter mask', async () => {
    const c = setup();
    const id = solid(c, [0, 0, 0, 255]);
    await c.applyEffectFilter(id, 'fake.invert');
    c.setSmartFilterMask(id, 'hide-all');
    await c.effectsIdle();
    expect(pixel(c, id)).toEqual([0, 0, 0, 255]);
  });

  it('refuses bad values, unknown effects and effects that do not fit, changing nothing', async () => {
    const c = setup();
    const id = solid(c, [0, 0, 0, 255]);
    const n = steps(c);
    await expect(c.applyEffectFilter(id, 'fake.tint', { values: { amount: 3 } })).rejects.toThrow(/\/amount/);
    await expect(c.applyEffectFilter(id, 'nope')).rejects.toThrow(/Unknown effect "nope"/);
    await expect(c.applyEffectFilter(id, 'fake.gradient')).rejects.toThrow(/add_effect_layer/);
    await expect(c.applyEffectFilter('zz', 'fake.tint')).rejects.toThrow(/no layer "zz"/);
    expect(steps(c)).toBe(n);
    expect(c.getLayer(id)?.type).toBe('pixel');
  });

  it('redraws effect filters after undo and when the provider changes', async () => {
    const c = setup();
    const id = solid(c, [0, 0, 0, 255]);
    await c.applyEffectFilter(id, 'fake.invert');
    await c.effectsIdle();
    c.setEffectsProvider(null);
    await c.effectsIdle();
    // Without a provider the filter passes the pixels through, and is kept.
    expect(pixel(c, id)).toEqual([0, 0, 0, 255]);
    expect((c.getLayer(id) as SmartObjectLayer).smartFilters?.filters[0]).toMatchObject({ kind: 'effect', effect: 'fake.invert' });
    c.setEffectsProvider(createFakeEffectProvider());
    await c.effectsIdle();
    await c.effectsIdle();
    expect(pixel(c, id)).toEqual([255, 255, 255, 255]);
  });

  it('round-trips effect filters and effect layers through JSON without a provider', async () => {
    const c = setup();
    const id = solid(c, [0, 0, 0, 255]);
    await c.applyEffectFilter(id, 'fake.tint', { values: { color: '#102030' } });
    const layer = await c.addEffectLayer('fake.gradient', { values: { angle: 0 } });
    await c.effectsIdle();
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    const d = setup(null);
    d.loadJSON(json);
    expect(d.lastLoadProblems).toEqual([]);
    expect((d.getLayer(id) as SmartObjectLayer).smartFilters?.filters[0]).toMatchObject({ kind: 'effect', effect: 'fake.tint', values: { color: '#102030', amount: 0.5 } });
    expect((d.getLayer(layer) as PixelLayer).generator).toEqual({ effect: 'fake.gradient', provider: 'fake', name: 'Gradient', values: { from: '#1e3a8a', to: '#f472b6', angle: 0, spin: 0 } });
    // The effect layer keeps its pixels without a provider.
    expect(pixel(d, layer)).toEqual(pixel(c, layer));
    expect(JSON.parse(JSON.stringify(d.toJSON())).layers).toEqual(json.layers);
  });
});

describe('image provider effects: without a provider', () => {
  it('behaves as before', async () => {
    const a = setup(null);
    const b = new ImageEditorController({ image: { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement });
    for (const c of [a, b]) {
      const id = solid(c, [1, 2, 3, 255]);
      c.convertToSmartObject([id]);
      c.addSmartFilter(id, { kind: 'develop', exposure: 20 });
    }
    expect([...a.compositePixels().data]).toEqual([...b.compositePixels().data]);
    expect(a.effectsProvider).toBeNull();
    await expect(a.applyEffectFilter(a.getLayers()[0].id, 'fake.tint')).rejects.toThrow(/No effects provider/);
    await expect(a.addEffectLayer('fake.gradient')).rejects.toThrow(/No effects provider/);
  });
});

describe('image provider effects: effect layers', () => {
  it('adds a generator layer at document size, redraws it with new values and rasterizes it', async () => {
    const c = setup();
    const id = await c.addEffectLayer('fake.gradient', { values: { from: '#000000', to: '#ffffff', angle: 0 } });
    const layer = c.getLayer(id) as PixelLayer;
    expect(layer).toMatchObject({ type: 'pixel', name: 'Gradient', generator: { effect: 'fake.gradient' } });
    expect(c.getState().activeLayerId).toBe(id);
    expect(pixel(c, id, 0)[0]).toBeLessThan(pixel(c, id, W - 1)[0]);
    await c.updateEffectLayer(id, { values: { from: '#ff0000', to: '#ff0000' } });
    expect(pixel(c, id, 3)).toEqual([255, 0, 0, 255]);
    await expect(c.addEffectLayer('fake.invert')).rejects.toThrow(/apply_effect/);
    c.rasterizeEffectLayer(id);
    expect((c.getLayer(id) as PixelLayer).generator).toBeUndefined();
    expect(pixel(c, id, 3)).toEqual([255, 0, 0, 255]);
  });

  it('renders at the document bit depth', async () => {
    for (const depth of [16, 32] as const) {
      const provider = createFakeEffectProvider();
      const create = vi.spyOn(provider, 'createRenderer');
      const c = setup(provider);
      c.setBitDepth(depth);
      await c.addEffectLayer('fake.bar', { time: 5000 });
      expect(create).toHaveBeenCalledWith('fake.bar', { width: W, height: H, depth });
    }
    // Float output becomes deep samples (8-bit-exact samples are stored as 8-bit tiles).
    const p = createEffectPixels(2, 1, true);
    p.float!.set([0.123, 0.5, 0.25, 1, 0.9, 0.1, 0.3, 0.5]);
    encodeEffectFloat(p);
    expect(surfaceDepth(effectPixelsToSurface(p, 32))).toBe(32);
    expect(surfaceDepth(effectPixelsToSurface(p, 16))).toBe(16);
    expect(surfaceDepth(effectPixelsToSurface(p, 8))).toBe(8);
  });
});

describe('image provider effect tools', () => {
  const tools = (c = setup()) => {
    const registry = new ToolRegistry();
    registry.register(createImageEffectsToolProvider(c));
    return { c, registry };
  };
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it('lists the tools, read-only hides the writes', () => {
    expect(tools().registry.listTools().tools.map((t) => t.name)).toEqual(['search_effects', 'describe_effect', 'list_applied_effects', 'apply_effect', 'update_effect', 'remove_effect', 'add_effect_layer']);
    const registry = new ToolRegistry();
    registry.register(createImageEffectsToolProvider(setup(), { readOnly: 'Locked for review.' }));
    expect(registry.listTools().tools.map((t) => t.name)).toEqual(['search_effects', 'describe_effect', 'list_applied_effects']);
  });

  it('applies, updates and removes through the registry, returning what changed', async () => {
    const { c, registry } = tools();
    const id = solid(c, [0, 0, 0, 255]);
    const applied = await registry.callTool('apply_effect', { target: id, effect: 'fake.tint', values: { amount: 0.25 } });
    expect(applied.isError).toBeFalsy();
    const s = applied.structuredContent as any;
    expect(s).toMatchObject({ target: id, converted: true, effect: { role: 'smart filter', effect: 'fake.tint', values: { amount: 0.25 } } });
    const fx = s.effect.id;
    const upd = await registry.callTool('update_effect', { target: id, effect: fx, values: { amount: 0.75 }, enabled: false });
    expect((upd.structuredContent as any).effect).toMatchObject({ enabled: false, values: { amount: 0.75 } });
    const layer = await registry.callTool('add_effect_layer', { effect: 'fake.gradient', blend: 'screen', opacity: 0.5 });
    const lid = (layer.structuredContent as any).layerId;
    expect(c.getLayer(lid)).toMatchObject({ blend: 'screen', opacity: 0.5 });
    const list = (await registry.callTool('list_applied_effects', {})).structuredContent as any;
    expect(list.targets.map((t: { target: string }) => t.target).sort()).toEqual([id, lid].sort());
    expect(text(await registry.callTool('update_effect', { target: lid, effect: 'generator', opacity: 1 }))).toMatch(/only takes values/);
    const removed = await registry.callTool('remove_effect', { target: lid, effect: 'generator' });
    expect((removed.structuredContent as any).effects).toEqual([]);
    expect(text(await registry.callTool('remove_effect', { target: id, effect: 'nope' }))).toMatch(/no provider effect "nope"/);
  });

  it('without a provider: read tools say so, write tools refuse', async () => {
    const { registry } = tools(setup(null));
    expect((await registry.callTool('search_effects', {})).structuredContent).toMatchObject({ available: false });
    const r = await registry.callTool('add_effect_layer', { effect: 'fake.gradient' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No effects provider/);
  });

  it('re-lists tools when the provider changes', async () => {
    const c = setup(null);
    const { registry } = tools(c);
    const changed = vi.fn();
    registry.onListChanged(changed);
    c.setEffectsProvider(createFakeEffectProvider());
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).toHaveBeenCalled();
  });
});
