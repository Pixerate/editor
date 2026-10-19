import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, deserializeEffects, serializeEffects, solidSurface, type PixelLayer } from '../src/image-editor';

const W = 60;
const H = 40;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const shape = c.addPixelLayer({ name: 'Shape' });
  const layer = c.getLayer(shape) as PixelLayer;
  c.setLayerEffects(shape, null, false);
  (c.getState() as { layers: unknown[] }).layers = c.getLayers().map((l) => (l.id === shape ? { ...layer, surface: solidSurface(4, { x: 20, y: 10, width: 20, height: 20 }, 0xff0000ff) } : l));
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry, shape };
}

const call = async (registry: ToolRegistry, name: string, args: Record<string, unknown>) => {
  const res = await registry.callTool(name, args);
  return { ok: !res.isError, out: res.structuredContent as Record<string, any>, text: JSON.stringify(res.content) };
};

const at = (c: ImageEditorController, x: number, y: number) => Array.from(c.compositePixels({ x, y, width: 1, height: 1 }).data);

describe('layer effect tools', () => {
  it('adds an effect with defaults and settings, returns its id and the effects, and renders it', async () => {
    const { c, registry, shape } = setup();
    expect(at(c, 45, 20)).toEqual([255, 255, 255, 255]);
    const res = await call(registry, 'add_layer_effect', { layerId: shape, kind: 'stroke', settings: { size: 4, fill: { type: 'color', color: '#0000ff' } } });
    expect(res.ok).toBe(true);
    expect(res.out.effectId).toMatch(/^fx_/);
    expect(res.out).toMatchObject({ layerId: shape, enabled: true, scale: 1, effects: [{ kind: 'stroke', size: 4, position: 'outside', label: 'Stroke' }] });
    expect(res.out.margin).toBeGreaterThanOrEqual(6);
    // The outside stroke is blue next to the shape's right edge.
    expect(at(c, 41, 20)).toEqual([0, 0, 255, 255]);
    expect(at(c, 45, 20)).toEqual([255, 255, 255, 255]);
  });

  it('is one undo step per write', async () => {
    const { c, registry, shape } = setup();
    const add = await call(registry, 'add_layer_effect', { layerId: shape, kind: 'drop-shadow' });
    await call(registry, 'update_layer_effect', { layerId: shape, effectId: add.out.effectId, settings: { distance: 9, color: '#123456' } });
    expect(c.getLayerEffects(shape).items[0]).toMatchObject({ distance: 9, color: '#123456' });
    c.undo();
    expect(c.getLayerEffects(shape).items[0]).toMatchObject({ distance: 5, color: '#000000' });
    c.undo();
    expect(c.getLayer(shape)!.effects).toBeUndefined();
  });

  it('lists effects with the global light, pattern ids and kinds', async () => {
    const { registry, shape } = setup();
    await call(registry, 'add_layer_effect', { layerId: shape, kind: 'pattern-overlay', settings: { patternId: 'dots', scale: 2 } });
    const res = await call(registry, 'list_layer_effects', { layerId: shape });
    expect(res.ok).toBe(true);
    expect(res.out.globalLight).toEqual({ angle: 120, altitude: 30 });
    expect(res.out.patterns.map((p: { id: string }) => p.id)).toContain('dots');
    expect(res.out.kinds).toContain('bevel-emboss');
    expect(res.out.effects[0]).toMatchObject({ kind: 'pattern-overlay', patternId: 'dots', scale: 2 });
    const layers = await call(registry, 'list_layers', {});
    const listed = layers.out.layers.find((l: { id: string }) => l.id === shape);
    expect(listed.effects).toMatchObject({ enabled: true, items: [{ kind: 'pattern-overlay', enabled: true }] });
  });

  it('removes effects optional parts with null and whole effects with remove_layer_effect', async () => {
    const { c, registry, shape } = setup();
    const add = await call(registry, 'add_layer_effect', {
      layerId: shape,
      kind: 'bevel-emboss',
      settings: { texture: { patternId: 'checker', scale: 1, depth: 1, invert: false }, glossContour: { name: 'Ring', points: [{ input: 0, output: 0 }, { input: 0.5, output: 1 }, { input: 1, output: 0 }] } },
    });
    expect(add.ok).toBe(true);
    const upd = await call(registry, 'update_layer_effect', { layerId: shape, effectId: add.out.effectId, settings: { texture: null } });
    expect(upd.ok).toBe(true);
    expect(upd.out.effects[0].texture).toBeUndefined();
    expect(upd.out.effects[0].glossContour.name).toBe('Ring');
    const rm = await call(registry, 'remove_layer_effect', { layerId: shape, effectId: add.out.effectId });
    expect(rm.out.effects).toEqual([]);
    expect(c.getLayer(shape)!.effects).toBeUndefined();
  });

  it('switches all effects off and scales them', async () => {
    const { c, registry, shape } = setup();
    await call(registry, 'add_layer_effect', { layerId: shape, kind: 'stroke', settings: { size: 3, fill: { type: 'color', color: '#00ff00' } } });
    const off = await call(registry, 'set_layer_effects_enabled', { layerId: shape, enabled: false });
    expect(off.out).toMatchObject({ enabled: false, margin: 0 });
    expect(at(c, 41, 20)).toEqual([255, 255, 255, 255]);
    const scaled = await call(registry, 'set_layer_effects_enabled', { layerId: shape, enabled: true, scale: 2 });
    expect(scaled.out.scale).toBe(2);
    // 3 px scaled to 6: green 5 px out from the edge.
    expect(at(c, 45, 20)).toEqual([0, 255, 0, 255]);
  });

  it('sets the global light, which follows into undo and JSON', async () => {
    const { c, registry, shape } = setup();
    await call(registry, 'add_layer_effect', { layerId: shape, kind: 'drop-shadow', settings: { distance: 6, size: 0, opacity: 1, blend: 'normal' } });
    const before = at(c, 44, 20);
    const res = await call(registry, 'set_global_light', { angle: 180 });
    expect(res.out.globalLight).toEqual({ angle: 180, altitude: 30 });
    // Light from the left now: the shadow falls to the right.
    expect(at(c, 44, 20)).toEqual([0, 0, 0, 255]);
    expect(before).not.toEqual([0, 0, 0, 255]);
    const json = c.toJSON() as unknown as Record<string, any>;
    expect(json.globalLight).toEqual({ angle: 180, altitude: 30 });
    expect(json.layers.find((l: { id: string }) => l.id === shape).effects.items[0]).toMatchObject({ kind: 'drop-shadow', distance: 6 });
    const copy = new ImageEditorController({ image: { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement });
    copy.loadJSON(json as never);
    expect(copy.getGlobalLight()).toEqual({ angle: 180, altitude: 30 });
    expect(copy.getLayerEffects(shape).items[0]).toMatchObject({ kind: 'drop-shadow', distance: 6 });
    c.undo();
    expect(c.getGlobalLight()).toEqual({ angle: 120, altitude: 30 });
  });

  it('fails usefully and changes nothing on bad input', async () => {
    const { c, registry, shape } = setup();
    const unknownLayer = await call(registry, 'add_layer_effect', { layerId: 'nope', kind: 'stroke' });
    expect(unknownLayer.ok).toBe(false);
    const badKind = await call(registry, 'add_layer_effect', { layerId: shape, kind: 'sparkle' });
    expect(badKind.ok).toBe(false);
    const wrongSetting = await call(registry, 'add_layer_effect', { layerId: shape, kind: 'inner-shadow', settings: { spread: 0.5 } });
    expect(wrongSetting.ok).toBe(false);
    expect(wrongSetting.text).toMatch(/spread: not a setting of inner-shadow/);
    expect(wrongSetting.text).toMatch(/choke/);
    const outOfRange = await call(registry, 'add_layer_effect', { layerId: shape, kind: 'stroke', settings: { size: 400 } });
    expect(outOfRange.ok).toBe(false);
    const glowPattern = await call(registry, 'add_layer_effect', { layerId: shape, kind: 'outer-glow', settings: { fill: { type: 'pattern', patternId: 'dots', scale: 1 } } });
    expect(glowPattern.ok).toBe(false);
    expect(glowPattern.text).toMatch(/glows cannot use a pattern/);
    const noEffect = await call(registry, 'update_layer_effect', { layerId: shape, effectId: 'fx_missing', settings: { size: 2 } });
    expect(noEffect.ok).toBe(false);
    expect(noEffect.text).toMatch(/list_layer_effects/);
    const empty = await call(registry, 'update_layer_effect', { layerId: shape, effectId: 'x', settings: {} });
    expect(empty.ok).toBe(false);
    const adj = c.addAdjustmentLayer({ kind: 'curves' });
    const onAdjustment = await call(registry, 'add_layer_effect', { layerId: adj, kind: 'stroke' });
    expect(onAdjustment.ok).toBe(false);
    expect(onAdjustment.text).toMatch(/adjustment layer/);
    c.setLayerProperties(shape, { locks: { all: true } });
    const locked = await call(registry, 'add_layer_effect', { layerId: shape, kind: 'stroke' });
    expect(locked.ok).toBe(false);
    expect(locked.text).toMatch(/locked/);
    const badLight = await call(registry, 'set_global_light', {});
    expect(badLight.ok).toBe(false);
    expect(c.getLayer(shape)!.effects).toBeUndefined();
  });

  it('bakes effects when merging down, as far as they reach, and leaves none live', async () => {
    const { c, registry, shape } = setup();
    await call(registry, 'add_layer_effect', { layerId: shape, kind: 'stroke', settings: { size: 3, fill: { type: 'color', color: '#0000ff' } } });
    const before = Array.from(c.compositePixels().data);
    const merged = await c.mergeDown(shape);
    expect(c.getLayer(merged)!.effects).toBeUndefined();
    expect(Array.from(c.compositePixels().data)).toEqual(before);
    expect(at(c, 41, 20)).toEqual([0, 0, 255, 255]);
  });
});

describe('layer effects in JSON', () => {
  it('round-trips effects and the PSD block they came from', () => {
    const effects = { enabled: false, scale: 1.5, items: [{ id: 'a', kind: 'color-overlay', enabled: true, blend: 'normal', opacity: 1, color: '#336699' }], psd: { key: 'lfx2', data: new Uint8Array([0, 0, 0, 0, 1, 2, 250]) } } as const;
    const stored = JSON.parse(JSON.stringify(serializeEffects(effects as never)));
    expect(typeof stored.psd.data).toBe('string');
    const back = deserializeEffects(stored)!;
    expect(back).toMatchObject({ enabled: false, scale: 1.5, items: [{ id: 'a', kind: 'color-overlay', color: '#336699' }] });
    expect(Array.from(back.psd!.data)).toEqual([0, 0, 0, 0, 1, 2, 250]);
    expect(deserializeEffects({ items: 'nope' })).toBeUndefined();
  });
});
