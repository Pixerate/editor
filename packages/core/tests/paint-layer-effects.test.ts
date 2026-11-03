import { describe, expect, it } from 'vitest';
import { createPaintEditorToolProvider, PaintEditorController, PaintEditorError } from '../src/paint-editor';
import { importPsd } from '../src/image-editor/psd/import';
import { ToolRegistry } from '../src/tools/registry';

const W = 120;
const H = 80;
/** White ink on black paper: a glow shows as colour where there was none. */
const editor = () => {
  const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
  c.setPaper({ color: '#000000' });
  c.paintStroke({ brushId: 'ink-pen', brush: { tip: { size: 8, hardness: 1 }, grain: 0 }, points: [{ x: 20, y: 30 }, { x: 100, y: 30 }], color: '#ffffff' });
  return c;
};
const layerId = (c: PaintEditorController) => c.getActiveLayer()!.id;
const px = (c: PaintEditorController, x: number, y: number) => {
  const d = c.compositePixels().data;
  const i = (y * W + x) * 4;
  return [d[i], d[i + 1], d[i + 2]];
};
const pixels = (c: PaintEditorController) => Buffer.from(c.compositePixels().data);
const RED_GLOW = { fill: { type: 'color', color: '#ff0000' }, size: 16, opacity: 1 };

describe('paint editor layer effects', () => {
  it('a glow is drawn from the layer and follows later painting', () => {
    const c = editor();
    expect(px(c, 60, 42)).toEqual([0, 0, 0]);
    const { effect, effects } = c.addLayerEffect(layerId(c), 'outer-glow', RED_GLOW);
    expect(effect.kind).toBe('outer-glow');
    expect(effects.items).toHaveLength(1);
    const [r, g, b] = px(c, 60, 42);
    expect(r).toBeGreaterThan(30);
    expect(g + b).toBe(0);
    // Paint more: the glow follows the new paint.
    expect(px(c, 60, 72)[0]).toBe(0);
    c.paintStroke({ brushId: 'ink-pen', brush: { tip: { size: 8, hardness: 1 }, grain: 0 }, points: [{ x: 20, y: 60 }, { x: 100, y: 60 }], color: '#ffffff' });
    expect(px(c, 60, 72)[0]).toBeGreaterThan(30);
    expect(c.listLayers().find((l) => l.id === layerId(c))!.effects).toBe(1);
  });

  it('changes, hides, scales and removes effects, each one undo step; a drag folds into one', () => {
    const c = editor();
    const id = layerId(c);
    const { effect } = c.addLayerEffect(id, 'outer-glow', RED_GLOW);
    const red = pixels(c);
    c.updateLayerEffect(id, effect.id, { fill: { type: 'color', color: '#00ff00' } });
    expect(px(c, 60, 42)[1]).toBeGreaterThan(30);
    expect(px(c, 60, 42)[0]).toBe(0);
    expect(c.undo()).toBeTruthy();
    expect(pixels(c).equals(red)).toBe(true);
    // A slider drag: later values fold into the first step.
    c.updateLayerEffect(id, effect.id, { size: 10 }, true);
    c.updateLayerEffect(id, effect.id, { size: 20 }, false);
    c.updateLayerEffect(id, effect.id, { size: 30 }, false);
    expect(c.getLayerEffects(id).items[0]).toMatchObject({ size: 30 });
    c.undo();
    expect(c.getLayerEffects(id).items[0]).toMatchObject({ size: 16 });
    c.setLayerEffectsEnabled(id, false);
    expect(px(c, 60, 42)).toEqual([0, 0, 0]);
    c.setLayerEffectsEnabled(id, true, 2);
    expect(c.getLayerEffects(id)).toMatchObject({ enabled: true, scale: 2 });
    c.removeLayerEffect(id, effect.id);
    expect(c.getLayerEffects(id).items).toHaveLength(0);
    expect(c.getActiveLayer()!.effects).toMatchObject({ scale: 2 });
    c.setLayerEffects(id, null);
    expect(c.getActiveLayer()!.effects).toBeUndefined();
    c.undo();
    c.undo();
    expect(c.getLayerEffects(id).items).toHaveLength(1);
  });

  it('refuses bad input before changing anything, with errors that say what to do', () => {
    const c = editor();
    const id = layerId(c);
    expect(() => c.addLayerEffect('nope', 'outer-glow')).toThrow(/Unknown layer "nope"/);
    expect(() => c.addLayerEffect(id, 'sparkle' as never)).toThrow(/Unknown effect kind "sparkle". Kinds: /);
    expect(() => c.addLayerEffect(id, 'outer-glow', { size: -5 })).toThrow(PaintEditorError);
    expect(() => c.updateLayerEffect(id, 'fx-missing', { size: 3 })).toThrow(/no effect "fx-missing".*list_layer_effects/);
    expect(() => c.setLayerEffectsEnabled(id, true, 50)).toThrow(/scale must be from 0.01 to 10/);
    expect(c.getActiveLayer()!.effects).toBeUndefined();
    c.updateLayer(id, { locks: { all: true } });
    expect(() => c.addLayerEffect(id, 'outer-glow')).toThrow(/fully locked/);
  });

  it('is saved and loaded, duplicated with its layer, and written to PSD as a layer style', () => {
    const c = editor();
    const id = layerId(c);
    c.addLayerEffect(id, 'outer-glow', RED_GLOW);
    c.addLayerEffect(id, 'stroke', { size: 2, fill: { type: 'color', color: '#2563eb' } });
    const before = pixels(c);
    const d = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
    expect(d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())))).toEqual([]);
    expect(pixels(d).equals(before)).toBe(true);
    expect(d.getLayerEffects(id).items.map((e) => e.kind)).toEqual(['outer-glow', 'stroke']);
    const dup = c.duplicateLayer(id);
    expect(c.getLayerEffects(dup.id).items).toHaveLength(2);
    const psd = importPsd(c.exportPsd().bytes);
    const styled = psd.layers.filter((l) => l.effects?.items.length);
    expect(styled.length).toBe(2);
    expect(styled[0].effects!.items.map((e) => e.kind).sort()).toEqual(['outer-glow', 'stroke']);
  });

  describe('agent tools', () => {
    const setup = () => {
      const c = editor();
      const r = new ToolRegistry();
      r.register(createPaintEditorToolProvider(c));
      return { c, r };
    };
    const ok = (res: { isError?: boolean; structuredContent?: unknown; content: unknown[] }) => {
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      return res.structuredContent as any;
    };
    const text = (res: { content: unknown[] }) => (res.content[0] as { text: string }).text;

    it('adds, reads, changes, switches off and removes effects; ids close the loop', async () => {
      const { c, r } = setup();
      const id = layerId(c);
      const added = ok(await r.callTool('add_layer_effect', { layerId: id, kind: 'outer-glow', settings: { fill: { type: 'color', color: '#22d3ee' }, size: 24, blend: 'linear-dodge' } }));
      expect(added.effectId).toEqual(expect.any(String));
      expect(added.effects[0]).toMatchObject({ kind: 'outer-glow', size: 24, blend: 'linear-dodge', label: expect.any(String) });
      const listed = ok(await r.callTool('list_layer_effects', { layerId: id }));
      expect(listed).toMatchObject({ layerId: id, enabled: true, scale: 1, globalLight: { angle: 120, altitude: 30 } });
      expect(listed.kinds).toContain('inner-glow');
      expect(listed.patterns.length).toBeGreaterThan(0);
      const changed = ok(await r.callTool('update_layer_effect', { layerId: id, effectId: added.effectId, settings: { size: 40 } }));
      expect(changed.effects[0].size).toBe(40);
      ok(await r.callTool('set_layer_effects_enabled', { layerId: id, enabled: false }));
      expect(c.getLayerEffects(id).enabled).toBe(false);
      const removed = ok(await r.callTool('remove_layer_effect', { layerId: id, effectId: added.effectId }));
      expect(removed.effects).toEqual([]);
      // The paint editor has no global light to set.
      expect(r.hasTool('set_global_light')).toBe(false);
      expect(r.hasTool('add_layer_effect')).toBe(true);
    });

    it('refuses invalid arguments with useful errors and changes nothing', async () => {
      const { c, r } = setup();
      const id = layerId(c);
      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ['add_layer_effect', { layerId: 'nope', kind: 'outer-glow' }, /Unknown layer/],
        ['add_layer_effect', { layerId: id, kind: 'glitter' }, /kind/],
        ['add_layer_effect', { layerId: id, kind: 'outer-glow', settings: { size: 999 } }, /size/],
        ['update_layer_effect', { layerId: id, effectId: 'x', settings: { size: 3 } }, /no effect "x"/],
        ['update_layer_effect', { layerId: id, effectId: 'x', settings: {} }, /at least one setting/],
        ['set_layer_effects_enabled', { layerId: id }, /enabled/],
      ];
      for (const [tool, args, msg] of cases) {
        const res = await r.callTool(tool, args);
        expect(res.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
        expect(text(res)).toMatch(msg);
      }
      expect(c.getActiveLayer()!.effects).toBeUndefined();
    });
  });
});
