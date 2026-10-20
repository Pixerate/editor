import { describe, expect, it } from 'vitest';
import { createFakeEffectProvider } from '../src/effects';
import { PaintEditorController, createPaintEffectsToolProvider, type PaintPixelLayer } from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const W = 32;
const H = 16;

function editor(provider = true) {
  const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
  if (provider) c.setEffectsProvider(createFakeEffectProvider());
  return c;
}

const layerPx = (c: PaintEditorController, id: string, x = 0, y = 0) => readPixel((c.getLayer(id) as PaintPixelLayer).surface, x, y);
const canvasPx = (c: PaintEditorController, x: number, y: number, paper = true) => {
  const img = c.compositePixels({ paper });
  return [...img.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
};
const steps = (c: PaintEditorController) => c.historyLabels().undo.length;

describe('paint provider effects: effect paper', () => {
  it('draws a generator over the paper and under the paint, in one undo step', async () => {
    const c = editor();
    const plain = canvasPx(c, 0, 0);
    const before = steps(c);
    const p = await c.setPaperEffect('fake.gradient', { values: { from: '#ff0000', to: '#ff0000' } });
    expect(p).toMatchObject({ effect: 'fake.gradient', name: 'Gradient', provider: 'fake', blend: 'multiply', opacity: 1, values: { from: '#ff0000' } });
    expect(steps(c)).toBe(before + 1);
    const tinted = canvasPx(c, 0, 0);
    // Multiplied over the paper: red stays, green and blue go dark.
    expect(tinted[0]).toBeGreaterThan(200);
    expect(tinted[1]).toBeLessThan(plain[1] / 4);
    // Without the paper there is no effect paper either.
    expect(canvasPx(c, 0, 0, false)[3]).toBe(0);
    c.undo();
    expect(c.getPaperEffect()).toBeNull();
    expect(canvasPx(c, 0, 0)).toEqual(plain);
  });

  it('changes values, opacity and blend, and removes it', async () => {
    const c = editor();
    await c.setPaperEffect('fake.gradient');
    const u = await c.updatePaperEffect({ values: { from: '#00ff00' }, opacity: 0.5, blend: 'normal' });
    expect(u).toMatchObject({ opacity: 0.5, blend: 'normal', values: { from: '#00ff00', to: '#f472b6' } });
    const r = await c.updatePaperEffect({ values: { from: null } });
    expect(r.values.from).toBe('#1e3a8a');
    expect(await c.setPaperEffect(null)).toBeNull();
    expect(c.getPaperEffect()).toBeNull();
  });

  it('folds the later values of a slider drag into one undo step', async () => {
    const c = editor();
    await c.setPaperEffect('fake.gradient');
    const before = steps(c);
    await c.updatePaperEffect({ values: { angle: 10 } });
    await c.updatePaperEffect({ values: { angle: 20 } }, false);
    await c.updatePaperEffect({ values: { angle: 30 } }, false);
    expect(steps(c)).toBe(before + 1);
    c.undo();
    expect(c.getPaperEffect()!.values.angle).toBe(90);
    c.redo();
    expect(c.getPaperEffect()!.values.angle).toBe(30);
  });

  it('refuses effects that are not generators, bad values and missing providers, saying what to do', async () => {
    const c = editor();
    await expect(c.setPaperEffect('fake.invert')).rejects.toThrow(/apply_effect/);
    await expect(c.setPaperEffect('fake.bar')).rejects.toThrow(/add_effect_layer/);
    await expect(c.setPaperEffect('fake.gradient', { values: { angle: 999 } })).rejects.toThrow();
    await expect(c.setPaperEffect('fake.gradient', { opacity: 2 })).rejects.toThrow(/0\.\.1/);
    await expect(c.updatePaperEffect({ opacity: 1 })).rejects.toThrow(/set_paper_effect/);
    await expect(editor(false).setPaperEffect('fake.gradient')).rejects.toThrow(/provider/i);
  });
});

describe('paint provider effects: effect layers and fills', () => {
  it('adds an effect layer above the active layer, draws it again and rasterizes it', async () => {
    const c = editor();
    const below = c.getActiveLayer()!.id;
    const { layer, source } = await c.addEffectLayer('fake.gradient', { values: { from: '#000000', to: '#000000' }, blend: 'multiply' });
    expect(source).toMatchObject({ effect: 'fake.gradient', values: { from: '#000000' } });
    expect(layer).toMatchObject({ name: 'Gradient', blend: 'multiply', active: true });
    expect(c.listLayers().map((l) => l.id).indexOf(layer.id)).toBeLessThan(c.listLayers().map((l) => l.id).indexOf(below));
    expect(layerPx(c, layer.id)).toEqual([0, 0, 0, 255]);
    await c.updateEffectLayer(layer.id, { values: { from: '#ffffff', to: '#ffffff' } });
    expect(layerPx(c, layer.id)).toEqual([255, 255, 255, 255]);
    expect(c.listEffectLayers()).toEqual([{ layerId: layer.id, name: 'Gradient', source: expect.objectContaining({ values: expect.objectContaining({ from: '#ffffff' }) }) }]);
    c.rasterizeEffectLayer(layer.id);
    expect(c.getEffectLayer(layer.id)).toBeUndefined();
    expect(layerPx(c, layer.id)).toEqual([255, 255, 255, 255]);
    c.undo();
    expect(c.getEffectLayer(layer.id)).toBeDefined();
    await expect(c.updateEffectLayer(below, {})).rejects.toThrow(/add_effect_layer/);
    await expect(c.addEffectLayer('fake.invert')).rejects.toThrow(/apply_effect/);
  });

  it('fills a layer with an effect, keeping transparency when asked', async () => {
    const c = editor();
    const id = c.getActiveLayer()!.id;
    await c.fillLayerWithEffect('fake.gradient', { values: { from: '#102030', to: '#102030' } });
    expect(layerPx(c, id)).toEqual([16, 32, 48, 255]);
    const empty = c.addLayer({ name: 'Empty' }).id;
    await c.fillLayerWithEffect('fake.gradient', { layerId: empty, lockTransparency: true });
    expect(layerPx(c, empty)[3]).toBe(0);
    expect(c.getEffectLayer(id)).toBeUndefined();
  });
});

describe('paint provider effects: light on dried paint', () => {
  it('bakes a filter into the paint at a strength, keeping transparency, in one undo step', async () => {
    const c = editor();
    const id = c.getActiveLayer()!.id;
    c.fillLayer({ color: '#0a141e' });
    const before = steps(c);
    const r = await c.applyLightEffect(id, 'fake.invert');
    expect(r).toMatchObject({ layerId: id, amount: 1, source: { effect: 'fake.invert' } });
    expect(steps(c)).toBe(before + 1);
    expect(layerPx(c, id)).toEqual([245, 235, 225, 255]);
    c.undo();
    await c.applyLightEffect(id, 'fake.invert', { amount: 0.5 });
    expect(layerPx(c, id).slice(0, 3).every((v) => v >= 126 && v <= 129)).toBe(true);
  });

  it('refuses empty layers, generators and bad strengths', async () => {
    const c = editor();
    const id = c.getActiveLayer()!.id;
    await expect(c.applyLightEffect(id, 'fake.invert')).rejects.toThrow(/no paint/);
    c.fillLayer({ color: '#808080' });
    await expect(c.applyLightEffect(id, 'fake.gradient')).rejects.toThrow(/add_effect_layer/);
    await expect(c.applyLightEffect(id, 'fake.invert', { amount: 3 })).rejects.toThrow(/0\.\.1/);
    await expect(c.applyLightEffect(id, 'fake.invert', { values: { nope: 1 } as never })).rejects.toThrow(/not a control/);
  });
});

describe('paint provider effects: saving', () => {
  it('saves and opens the effect paper and effect layers', async () => {
    const c = editor();
    await c.setPaperEffect('fake.gradient', { opacity: 0.7, blend: 'soft-light' });
    const { layer } = await c.addEffectLayer('fake.bar');
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    expect(json.effectLayers[layer.id]).toMatchObject({ effect: 'fake.bar' });
    expect(json.paperEffect).toMatchObject({ effect: 'fake.gradient', opacity: 0.7, blend: 'soft-light' });
    const d = new PaintEditorController({ width: 8, height: 8 });
    expect(d.loadJSON(json)).toEqual([]);
    expect(d.getPaperEffect()).toMatchObject({ effect: 'fake.gradient', opacity: 0.7, blend: 'soft-light' });
    expect(d.getEffectLayer(layer.id)).toMatchObject({ effect: 'fake.bar' });
    expect(canvasPx(d as never, 0, 0)).toEqual(canvasPx(c, 0, 0));
    // Saved again, nothing is lost or doubled.
    expect(JSON.parse(JSON.stringify(d.toJSON())).paperEffect.png).toBe(json.paperEffect.png);
  });

  it('reports effect paper it cannot read and opens the rest', () => {
    const c = editor();
    const json = { ...JSON.parse(JSON.stringify(c.toJSON())), paperEffect: { effect: 'fake.gradient', values: {} } };
    const d = new PaintEditorController({ width: 8, height: 8 });
    expect(d.loadJSON(json)[0]).toMatch(/effect paper could not be read/);
    expect(d.getPaperEffect()).toBeNull();
  });
});

describe('paint provider effects: agent tools', () => {
  const setup = (provider = true) => {
    const c = editor(provider);
    const registry = new ToolRegistry();
    registry.register(createPaintEffectsToolProvider(c));
    return { c, registry };
  };
  const out = (r: { structuredContent?: unknown }) => r.structuredContent as any;
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it('lists the shared tools and the paint ones', () => {
    const names = setup().registry.listTools().tools.map((t) => t.name);
    for (const n of ['search_effects', 'describe_effect', 'list_applied_effects', 'apply_effect', 'update_effect', 'remove_effect', 'set_paper_effect', 'add_effect_layer', 'fill_layer_with_effect']) expect(names).toContain(n);
  });

  it('sets, lists, updates and removes the effect paper and effect layers', async () => {
    const { c, registry } = setup();
    const p = await registry.callTool('set_paper_effect', { effect: 'fake.gradient', opacity: 0.8 });
    expect(out(p).paperEffect).toMatchObject({ effect: 'fake.gradient', opacity: 0.8, blend: 'multiply' });
    const a = await registry.callTool('add_effect_layer', { effect: 'fake.bar', name: 'Caption' });
    const layerId = out(a).layer.id;
    expect(out(a).effects).toEqual([expect.objectContaining({ id: 'effect', role: 'effect layer', effect: 'fake.bar' })]);
    const list = out(await registry.callTool('list_applied_effects', {}));
    expect(JSON.stringify(list)).toContain('effect paper');
    expect(JSON.stringify(list)).toContain(layerId);
    const u = await registry.callTool('update_effect', { target: 'paper', effect: 'paper', values: { from: '#ffffff' }, opacity: 0.4 });
    expect(out(u).effect).toMatchObject({ opacity: 0.4, values: { from: '#ffffff' } });
    const bad = await registry.callTool('update_effect', { target: layerId, effect: 'effect', opacity: 0.2 });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/update_layer/);
    expect(out(await registry.callTool('remove_effect', { target: layerId, effect: 'effect' }))).toMatchObject({ keptPixels: true, effects: [] });
    expect(c.getEffectLayer(layerId)).toBeUndefined();
    expect((await registry.callTool('remove_effect', { target: 'paper', effect: 'paper' })).isError).toBeFalsy();
    expect(c.getPaperEffect()).toBeNull();
  });

  it('applies light to a layer and fills one, with useful errors', async () => {
    const { c, registry } = setup();
    const id = c.getActiveLayer()!.id;
    const empty = await registry.callTool('apply_effect', { target: id, effect: 'fake.invert' });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toMatch(/no paint/);
    const f = await registry.callTool('fill_layer_with_effect', { effect: 'fake.gradient', values: { from: '#0a141e', to: '#0a141e' } });
    expect(out(f)).toMatchObject({ layerId: id, source: { effect: 'fake.gradient' } });
    const l = await registry.callTool('apply_effect', { target: id, effect: 'fake.invert', opacity: 1 });
    expect(out(l)).toMatchObject({ baked: true, effect: { id: 'light', role: 'baked light' } });
    expect(layerPx(c, id)).toEqual([245, 235, 225, 255]);
    const paper = await registry.callTool('apply_effect', { target: 'paper', effect: 'fake.invert' });
    expect(text(paper)).toMatch(/set_paper_effect/);
    const unknown = await registry.callTool('apply_effect', { target: 'nope', effect: 'fake.invert' });
    expect(text(unknown)).toMatch(/list_layers/);
    const gone = await registry.callTool('remove_effect', { target: id, effect: 'light' });
    expect(text(gone)).toMatch(/undo/);
  });

  it('reads without a provider and refuses writes with the reason', async () => {
    const { registry } = setup(false);
    expect(out(await registry.callTool('list_applied_effects', {}))).toBeDefined();
    const r = await registry.callTool('set_paper_effect', { effect: 'fake.gradient' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/provider/i);
  });
});
