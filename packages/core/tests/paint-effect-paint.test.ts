import { describe, expect, it } from 'vitest';
import { createFakeEffectProvider } from '../src/effects';
import { PaintEditorController, createPaintEditorToolProvider, createPaintEffectsToolProvider, type PaintPixelLayer } from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const W = 32;
const H = 16;
const RED_TO_BLUE = { from: '#ff0000', to: '#0000ff', angle: 0 };
/** A hard, full-strength round tip: inside the stroke every pixel is fully covered. */
const HARD = { tip: { size: 8, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureOpacity: false, pressureSize: false, smoothing: 0 }, grain: 0 };
const LINE = [
  { x: 2, y: 8 },
  { x: 30, y: 8 },
];

function editor(provider = true) {
  const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
  if (provider) c.setEffectsProvider(createFakeEffectProvider());
  return c;
}

/** The fake gradient rendered directly by the provider, for comparing. */
async function effectPixels(values: Record<string, unknown>, id = 'fake.gradient'): Promise<Uint8ClampedArray> {
  const r = createFakeEffectProvider().createRenderer(id, { width: W, height: H });
  const out = await r.render({ time: 0, values: values as never });
  return new Uint8ClampedArray(out.data as ArrayLike<number>);
}

const surface = (c: PaintEditorController, id: string) => (c.getLayer(id) as PaintPixelLayer).surface;
const layerPx = (c: PaintEditorController, id: string, x: number, y: number) => readPixel(surface(c, id), x, y);
const fxPx = (fx: Uint8ClampedArray, x: number, y: number) => [...fx.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
const allPixels = (c: PaintEditorController, id: string) => {
  const out: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.push(...layerPx(c, id, x, y));
  return out;
};

describe('effect paint', () => {
  it('paints each pixel the colour of the effect underneath it', async () => {
    const c = editor();
    const p = await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE });
    expect(p).toMatchObject({ type: 'effect', effect: 'fake.gradient', provider: 'fake', time: 0, values: { from: '#ff0000', to: '#0000ff', angle: 0, spin: 0 } });
    expect(c.getState()).toMatchObject({ effectPaint: { effect: 'fake.gradient' }, effectPaintRendering: false });
    const layer = c.getActiveLayer()!.id;
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: LINE });
    const fx = await effectPixels(RED_TO_BLUE);
    for (const x of [6, 12, 16, 22, 26]) {
      const got = layerPx(c, layer, x, 8);
      const want = fxPx(fx, x, 8);
      expect(got[3]).toBe(255);
      for (let ch = 0; ch < 3; ch++) expect(Math.abs(got[ch] - want[ch])).toBeLessThanOrEqual(1);
    }
    // The left of the stroke is red, the right blue: the colour is fixed to the canvas, not the stroke.
    expect(layerPx(c, layer, 4, 8)[0]).toBeGreaterThan(200);
    expect(layerPx(c, layer, 28, 8)[2]).toBeGreaterThan(200);
  });

  it('works with particle and bristle brushes (per pixel) and the mixer (per dab)', async () => {
    for (const brushId of ['bristle-round', 'spring-ink']) {
      const c = editor();
      await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE });
      const layer = c.getActiveLayer()!.id;
      c.paintStroke({ brushId, points: LINE, seed: 3 });
      const fx = await effectPixels(RED_TO_BLUE);
      let painted = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const got = layerPx(c, layer, x, y);
          if (got[3] < 32) continue;
          painted++;
          const want = fxPx(fx, x, y);
          for (let ch = 0; ch < 3; ch++) expect(Math.abs(got[ch] - want[ch]), `${brushId} at ${x},${y}`).toBeLessThanOrEqual(2);
        }
      expect(painted, brushId).toBeGreaterThan(0);
    }
    const c = editor();
    const green = { from: '#00ff00', to: '#00ff00' };
    await c.setEffectPaint({ effect: 'fake.gradient', values: green });
    const layer = c.getActiveLayer()!.id;
    c.paintStroke({ brushId: 'mixer-brush', points: LINE });
    const [r, g, b, a] = layerPx(c, layer, 16, 8);
    expect(a).toBeGreaterThan(0);
    expect(g).toBeGreaterThan(r + 60);
    expect(g).toBeGreaterThan(b + 60);
  });

  it("multiplies coverage by the effect's alpha", async () => {
    const c = editor();
    // The bar is opaque in the lower third and transparent elsewhere.
    await c.setEffectPaint({ effect: 'fake.bar', values: { color: '#00ff00', height: 0.3 }, time: 2000 });
    const layer = c.getActiveLayer()!.id;
    const top = c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: [{ x: 2, y: 2 }, { x: 30, y: 2 }] });
    expect(top.bounds).toBeNull();
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: [{ x: 2, y: 13 }, { x: 30, y: 13 }] });
    expect(layerPx(c, layer, 16, 13)).toEqual([0, 255, 0, 255]);
  });

  it('refuses wet, impasto and sticker brushes, saying what to use instead; erasers ignore it', async () => {
    const c = editor();
    await c.setEffectPaint({ effect: 'fake.gradient' });
    for (const brushId of ['watercolor-round', 'impasto-brush', 'sticker-stars']) {
      expect(() => c.paintStroke({ brushId, points: LINE }), brushId).toThrow(/cannot paint with effect paint.*dry brush.*fill_layer_with_effect/);
    }
    expect(() => c.beginStroke({ brushId: 'oil-round' })).toThrow(/cannot paint with effect paint/);
    expect(c.getState().stroking).toBe(false);
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: LINE });
    const erased = c.paintStroke({ brushId: 'eraser-hard', points: LINE });
    expect(erased.bounds).not.toBeNull();
    // An explicit colour wins over the effect paint.
    const layer = c.getActiveLayer()!.id;
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: LINE, color: '#123456' });
    expect(layerPx(c, layer, 16, 8)).toEqual([0x12, 0x34, 0x56, 255]);
  });

  it('refuses strokes while it renders, and set_color / set_paint end it', async () => {
    const c = editor(false);
    // A provider whose renders wait until released.
    const fake = createFakeEffectProvider();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    c.setEffectsProvider({
      ...fake,
      createRenderer: (id, o) => {
        const r = fake.createRenderer(id, o);
        return { ...r, render: async (req) => (await gate, r.render(req)) };
      },
    });
    const pending = c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(c.getState().effectPaintRendering).toBe(true);
    expect(() => c.paintStroke({ brushId: 'ink-pen', points: LINE })).toThrow(/"fake.gradient" is still rendering; wait for set_effect_paint/);
    expect(() => c.beginStroke({ brushId: 'ink-pen' })).toThrow(/still rendering/);
    // Erasers do not take paint, so they still work.
    expect(() => c.paintStroke({ brushId: 'eraser-hard', points: LINE })).not.toThrow();
    release();
    await pending;
    expect(() => c.paintStroke({ brushId: 'ink-pen', points: LINE })).not.toThrow();

    c.setColor('#ff00ff');
    expect(c.getState().effectPaint).toBeNull();
    await c.setEffectPaint({ effect: 'fake.gradient' });
    c.setPaint({ type: 'gradient', stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] });
    expect(c.getEffectPaint()).toBeNull();

    // Changing the paint while it renders: the render does not take over.
    const raced = c.setEffectPaint({ effect: 'fake.gradient' });
    c.setColor('#00ff00');
    await expect(raced).rejects.toThrow(/paint changed while/);
    expect(c.getEffectPaint()).toBeNull();
  });

  it('is refused for filter effects and without a provider', async () => {
    await expect(editor().setEffectPaint({ effect: 'fake.invert' })).rejects.toThrow(/effect paint takes generator, overlay or title effects/);
    await expect(editor(false).setEffectPaint({ effect: 'fake.gradient' })).rejects.toThrow(/provider/i);
    await expect(editor().setEffectPaint({ effect: 'fake.gradient', values: { nope: 1 } as never })).rejects.toThrow(/not a control/);
  });

  it('records the source, replays exactly, and undo restores the layer', async () => {
    const c = editor();
    await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE });
    const layer = c.getActiveLayer()!.id;
    const empty = allPixels(c, layer);
    const r = c.paintStroke({ brushId: 'bristle-round', points: LINE, seed: 9 });
    const stroke = c.getStrokes().find((s) => s.id === r.strokeId)!;
    expect(stroke.paint).toMatchObject({ type: 'effect', effect: 'fake.gradient', provider: 'fake', values: RED_TO_BLUE });
    const painted = allPixels(c, layer);

    c.undo();
    expect(allPixels(c, layer)).toEqual(empty);
    c.redo();
    expect(allPixels(c, layer)).toEqual(painted);

    // Replayed onto a new layer after going back to a colour: the same pixels, from the recorded effect.
    c.setColor('#000000');
    const copy = c.addLayer({ name: 'Copy' }).id;
    c.replayStrokes({ strokeIds: [stroke.id], layerId: copy });
    expect(allPixels(c, copy)).toEqual(painted);

    // The high-resolution / time-lapse replay renders it in a fresh editor.
    const img = await c.renderHighRes({ scale: 1, paper: false });
    const direct = c.compositePixels({ paper: false });
    expect([...img.data]).toEqual([...direct.data]);
  });

  it('a loaded painting renders missing effect paint before replaying, or names what is missing', async () => {
    const c = editor();
    await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE });
    const r = c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: LINE });
    const saved = c.toJSON();

    const d = editor();
    d.loadJSON(saved);
    expect(d.getStrokes()[0].paint).toMatchObject({ type: 'effect', effect: 'fake.gradient' });
    expect(() => d.replayStrokes({ strokeIds: [r.strokeId!], dy: 2 })).toThrow(/paints with the effect "fake.gradient" from provider "fake", which is not rendered/);
    await d.prepareStrokeEffects();
    expect(() => d.replayStrokes({ strokeIds: [r.strokeId!], dy: 2 })).not.toThrow();

    const e = editor(false);
    e.loadJSON(saved);
    await expect(e.prepareStrokeEffects()).rejects.toThrow(/"fake.gradient" from provider "fake".*no effects provider/);
    await expect(e.renderHighRes({ scale: 2 })).rejects.toThrow(/fake.gradient/);
    // A recoloured replay paints one colour and needs no effect.
    expect(() => e.replayStrokes({ strokeIds: [r.strokeId!], color: '#ff0000' })).not.toThrow();
  });

  it('gives the panels a thumbnail', async () => {
    const c = editor();
    expect(c.effectPaintThumbnail()).toBeNull();
    await c.setEffectPaint({ effect: 'fake.gradient' });
    expect(c.effectPaintThumbnail(16)).toMatch(/^data:image\/png;base64,/);
  });
});

describe('effect paint: agent tools', () => {
  const setup = (provider = true) => {
    const c = editor(provider);
    const registry = new ToolRegistry();
    registry.register(createPaintEffectsToolProvider(c));
    registry.register(createPaintEditorToolProvider(c, { id: 'paint', namespace: '' }));
    return { c, registry };
  };
  const out = (r: { structuredContent?: unknown }) => r.structuredContent as any;
  const text = (r: { content: unknown[] }) => (r.content[0] as { text: string }).text;

  it('set_effect_paint returns the paint, and strokes paint with it', async () => {
    const { c, registry } = setup();
    const def = registry.listTools().tools.find((t) => t.name.endsWith('set_effect_paint'))!;
    expect(def.inputSchema).toMatchObject({ required: ['effect'], additionalProperties: false });
    expect(def.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const r = await registry.callTool('paint-effects__set_effect_paint', { effect: 'fake.gradient', values: RED_TO_BLUE, time: 0 });
    expect(r.isError).toBeFalsy();
    expect(out(r).effectPaint).toMatchObject({ type: 'effect', effect: 'fake.gradient', provider: 'fake', time: 0, values: { from: '#ff0000' } });
    const s = await registry.callTool('paint_stroke', { points: LINE, brushId: 'ink-pen' });
    expect(s.isError).toBeFalsy();
    expect(c.getStrokes().at(-1)!.paint).toMatchObject({ type: 'effect' });
  });

  it('lists, updates and clears the effect paint', async () => {
    const { c, registry } = setup();
    await registry.callTool('paint-effects__set_effect_paint', { effect: 'fake.gradient' });
    const list = out(await registry.callTool('paint-effects__list_applied_effects', {}));
    expect(list.targets[0]).toMatchObject({ target: 'paint', name: 'Paint', effects: [{ id: 'paint', effect: 'fake.gradient', role: 'effect paint', available: true }] });
    const u = await registry.callTool('paint-effects__update_effect', { target: 'paint', effect: 'paint', values: { from: '#ffffff' } });
    expect(out(u).effect.values).toMatchObject({ from: '#ffffff', to: '#f472b6' });
    expect(c.getEffectPaint()!.values.from).toBe('#ffffff');
    expect((await registry.callTool('paint-effects__update_effect', { target: 'paint', effect: 'paint', opacity: 0.5 })).isError).toBe(true);
    expect(out(await registry.callTool('paint-effects__remove_effect', { target: 'paint', effect: 'paint' }))).toMatchObject({ effects: [] });
    expect(c.getEffectPaint()).toBeNull();
    const gone = await registry.callTool('paint-effects__remove_effect', { target: 'paint', effect: 'paint' });
    expect(gone.isError).toBe(true);
    expect(text(gone)).toMatch(/The paint has no provider effect/);
  });

  it('fails usefully: filter effects, extra arguments, no provider, refused brushes', async () => {
    const { registry } = setup();
    const filter = await registry.callTool('paint-effects__set_effect_paint', { effect: 'fake.invert' });
    expect(filter.isError).toBe(true);
    expect(text(filter)).toMatch(/generator, overlay or title/);
    expect((await registry.callTool('paint-effects__set_effect_paint', { effect: 'fake.gradient', opacity: 1 })).isError).toBe(true);
    expect((await registry.callTool('paint-effects__set_effect_paint', {})).isError).toBe(true);
    await registry.callTool('paint-effects__set_effect_paint', { effect: 'fake.gradient' });
    const wet = await registry.callTool('paint_stroke', { points: LINE, brushId: 'watercolor-round' });
    expect(wet.isError).toBe(true);
    expect(text(wet)).toMatch(/fill_layer_with_effect/);
    const none = setup(false).registry;
    expect((await none.callTool('paint-effects__set_effect_paint', { effect: 'fake.gradient' })).isError).toBe(true);
  });

  it('replay_strokes renders the effect paint of a loaded painting first', async () => {
    const { c, registry } = setup();
    await c.setEffectPaint({ effect: 'fake.gradient', values: RED_TO_BLUE });
    const r = c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: LINE });
    const d = setup();
    d.c.loadJSON(c.toJSON());
    const rep = await d.registry.callTool('replay_strokes', { strokeIds: [r.strokeId!], dy: 3 });
    expect(rep.isError).toBeFalsy();
    expect(out(rep).strokeIds).toHaveLength(1);
    void registry;
  });
});
