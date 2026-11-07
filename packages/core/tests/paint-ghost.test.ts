import { describe, expect, it } from 'vitest';
import {
  PaintEditorController,
  brushEngineControls,
  createPaintBrushLibraryToolProvider,
  createPaintEditorToolProvider,
  normalizePaintBrush,
  type PaintPixelLayer,
} from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const W = 180;
const H = 120;

function setup() {
  const controller = new PaintEditorController({
    width: W,
    height: H,
    paper: 'cold-pressed',
    wet: { kernel: 'wasm', threads: 0, gpu: 'off' },
  });
  const registry = new ToolRegistry();
  registry.register(createPaintEditorToolProvider(controller));
  registry.register(createPaintBrushLibraryToolProvider(controller));
  const call = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await registry.callTool(name, args);
    if (res.isError) throw new Error(res.content[0]?.type === 'text' ? res.content[0].text : 'Tool error');
    return (res.structuredContent ?? JSON.parse(res.content[0]?.type === 'text' ? res.content[0].text : '{}')) as T;
  };
  const callRaw = (name: string, args: Record<string, unknown> = {}) => registry.callTool(name, args);
  return { controller, registry, call, callRaw };
}

const compAt = (c: PaintEditorController, x: number, y: number, wet: 'display' | 'dried' = 'display') => {
  const { data } = c.compositePixels({ wet });
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

const activeSurface = (c: PaintEditorController) => (c.getActiveLayer() as PaintPixelLayer).surface;

describe('ghost paint', { timeout: 30_000 }, () => {
  it('exposes ghost presets, normalizes ghost settings, forces pickup to 0, and surfaces UI sliders', async () => {
    const { call } = setup();
    const list = await call<{ brushes: Array<{ id: string }> }>('list_brush_presets');
    const ids = list.brushes.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['ghost-wash', 'ghost-gouache', 'ghost-oil', 'invisible-ink']));

    const norm = normalizePaintBrush({
      engine: 'wet',
      wet: { tool: 'paint' },
      behavior: { pickup: 0.8, dirty: true },
      ghost: { linger: 6, smear: 0.45 },
    });
    expect(norm.ghost).toEqual({ linger: 6, smear: 0.45 });
    expect(norm.behavior.pickup).toBe(0);
    expect(norm.behavior.dirty).toBe(false);

    const controls = brushEngineControls(norm)!;
    expect(controls.sliders.map((s) => s.path)).toEqual(expect.arrayContaining(['ghost.linger', 'ghost.smear']));
    expect(controls.sliders.map((s) => s.path)).not.toContain('behavior.pickup');
    expect(controls.load).toBe(false);
    expect(controls.dirty).toBe(false);
  });

  it('shows colour on bare paper while wet, fades over linger, and leaves bare paper byte-identical', async () => {
    const { controller, call } = setup();
    const barePaper = Buffer.from(controller.compositePixels().data);

    await call('paint_stroke', {
      brushId: 'ghost-wash',
      color: '#e11d48',
      brush: { tip: { size: 36 }, ghost: { linger: 2, smear: 0.3 } },
      points: [
        { x: 40, y: 60 },
        { x: 140, y: 60 },
      ],
      seed: 1,
    });

    // Visible while wet: green channel drops relative to bare paper under crimson wash.
    const wetMid = compAt(controller, 90, 60, 'display');
    const bareMid = [barePaper[(60 * W + 90) * 4], barePaper[(60 * W + 90) * 4 + 1], barePaper[(60 * W + 90) * 4 + 2]];
    expect(wetMid[1]).toBeLessThan(bareMid[1] - 15);

    const wetInfo1 = await call<{ layers: Array<{ ghost?: { remaining: number } }> }>('get_wet_paint');
    expect(wetInfo1.layers[0]?.ghost?.remaining).toBeGreaterThan(0);

    // Advance past linger (2s) and dry: bare paper must come back byte-identical and surface empty.
    await call('advance_wet_paint', { seconds: 2.2 });
    const wetInfo2 = await call<{ layers: Array<{ ghost?: { remaining: number } }> }>('get_wet_paint');
    expect(wetInfo2.layers[0]?.ghost).toBeUndefined();

    await call('dry_paint');
    expect(activeSurface(controller).tiles.size).toBe(0);
    expect(Buffer.from(controller.compositePixels().data).equals(barePaper)).toBe(true);
  });

  it('mixes visibly with wet paint, displaces it along the stroke, and leaves only the smeared paint with no ghost tint', async () => {
    const { controller, call } = setup();
    // Lay a vertical blue wet stripe at x = 80, y = 45..95.
    await call('paint_stroke', {
      brushId: 'watercolor-round',
      color: '#1d4ed8',
      brush: { tip: { size: 28, flow: 0.9 } },
      points: [
        { x: 80, y: 45 },
        { x: 80, y: 95 },
      ],
      seed: 2,
    });

    // Before ghost stroke, snapshot to check where blue stayed without ghost smear.
    const untouchedSnap = controller.wet.world!.snapshot();

    // Paint bright yellow ghost gouache on bare paper at y = 18, and drag it through the blue stripe at y = 68.
    await call('paint_stroke', {
      brushId: 'ghost-gouache',
      color: '#facc15',
      brush: { tip: { size: 24 }, ghost: { linger: 2, smear: 0.85 } },
      points: [
        { x: 40, y: 18 },
        { x: 120, y: 18 },
      ],
      seed: 3,
    });
    await call('paint_stroke', {
      brushId: 'ghost-gouache',
      color: '#facc15',
      brush: { tip: { size: 30 }, ghost: { linger: 2, smear: 0.85 } },
      points: [
        { x: 50, y: 68 },
        { x: 80, y: 68 },
        { x: 110, y: 68 },
        { x: 135, y: 68 },
      ],
      seed: 4,
    });

    // Where ghost paint is over bare paper (x = 80, y = 18), it looks yellow while wet.
    const wetBare = compAt(controller, 80, 18, 'display');
    expect(wetBare[0]).toBeGreaterThan(wetBare[2] + 30);

    // Finish fade and dry.
    await call('advance_wet_paint', { seconds: 2.5 });
    await call('dry_paint');

    const surface = activeSurface(controller);
    // Ghost stroke over bare paper (x = 80, y = 18) has no paint left at all.
    expect(readPixel(surface, 80, 18)[3]).toBe(0);

    // Down-stroke of the blue stripe (x = 98, y = 68) now has displaced blue pigment, with blue > red (no yellow ghost tint).
    const smeared = readPixel(surface, 98, 68);
    expect(smeared[3]).toBeGreaterThan(0);
    expect(smeared[2]).toBeGreaterThan(smeared[0] + 20);

    // Compare against untouched blue stripe at x = 98, y = 68.
    controller.wet.world!.restore(untouchedSnap);
    controller.dryPaint();
    expect(readPixel(activeSurface(controller), 98, 68)[3]).toBeLessThan(smeared[3]);
  });

  it('lifts and smears dried paint when smear > 0, and leaves dried paint byte-identical when smear is 0', async () => {
    const { controller, call } = setup();
    await call('paint_stroke', {
      brushId: 'ink-pen',
      color: '#1d4ed8',
      brush: { tip: { size: 18, hardness: 0.9, opacity: 1, flow: 1 } },
      points: [
        { x: 80, y: 25 },
        { x: 80, y: 95 },
      ],
      seed: 4,
    });
    const driedBefore = Buffer.from(controller.compositePixels().data);

    // smear: 0 passes over dried paint and leaves it unchanged after drying.
    await call('paint_stroke', {
      brushId: 'ghost-wash',
      color: '#f43f5e',
      brush: { tip: { size: 28 }, ghost: { linger: 2, smear: 0 } },
      points: [
        { x: 45, y: 60 },
        { x: 125, y: 60 },
      ],
      seed: 5,
    });
    await call('dry_paint');
    expect(Buffer.from(controller.compositePixels().data).equals(driedBefore)).toBe(true);

    // smear > 0 lifts dried paint along the stroke and displaces it into the wake (x = 92, y = 60),
    // while pixels outside the stroke (y = 26) stay byte-identical.
    expect(readPixel(activeSurface(controller), 92, 60)[3]).toBe(0);
    await call('paint_stroke', {
      brushId: 'ghost-wash',
      color: '#f43f5e',
      brush: { tip: { size: 28 }, ghost: { linger: 2, smear: 0.85 } },
      points: [
        { x: 50, y: 60 },
        { x: 80, y: 60 },
        { x: 105, y: 60 },
        { x: 125, y: 60 },
      ],
      seed: 6,
    });
    await call('dry_paint');
    const displaced = readPixel(activeSurface(controller), 92, 60);
    expect(displaced[3]).toBeGreaterThan(0);
    expect(displaced[2]).toBeGreaterThan(displaced[0]);
    // Far outside the horizontal ghost stroke (x = 80, y = 26), dried paint is untouched.
    const topIdx = (26 * W + 80) * 4;
    const afterData = controller.compositePixels().data;
    expect([afterData[topIdx], afterData[topIdx + 1], afterData[topIdx + 2]]).toEqual([
      driedBefore[topIdx],
      driedBefore[topIdx + 1],
      driedBefore[topIdx + 2],
    ]);
  });

  it('finishes the ghost immediately on dry_paint or when a dry brush paints on the layer', async () => {
    const { controller, call } = setup();
    const bare = Buffer.from(controller.compositePixels().data);

    // 1) dry_paint right after a ghost stroke finishes the ghost at once.
    await call('paint_stroke', {
      brushId: 'ghost-gouache',
      color: '#10b981',
      points: [
        { x: 40, y: 50 },
        { x: 140, y: 50 },
      ],
      seed: 7,
    });
    await call('dry_paint');
    expect(Buffer.from(controller.compositePixels().data).equals(bare)).toBe(true);

    // 2) Painting with a dry brush on the same layer bakes wet paint first and finishes the ghost without baking ghost colour.
    await call('paint_stroke', {
      brushId: 'ghost-gouache',
      color: '#10b981',
      points: [
        { x: 40, y: 40 },
        { x: 140, y: 40 },
      ],
      seed: 8,
    });
    await call('paint_stroke', {
      brushId: 'ink-pen',
      color: '#111827',
      points: [
        { x: 40, y: 90 },
        { x: 140, y: 90 },
      ],
      seed: 9,
    });
    const surface = activeSurface(controller);
    expect(readPixel(surface, 90, 40)[3]).toBe(0);
    expect(readPixel(surface, 90, 90)[3]).toBeGreaterThan(0);
  });

  it('invisible-ink shows nothing on bare paper, lays no tracer, smears paint it crosses, and does not interrupt an active ghost fade', async () => {
    const { controller, call } = setup();
    const bare = Buffer.from(controller.compositePixels().data);

    await call('paint_stroke', {
      brushId: 'invisible-ink',
      color: '#ef4444',
      points: [
        { x: 30, y: 60 },
        { x: 150, y: 60 },
      ],
      seed: 10,
    });
    // Invisible on bare paper when dried, and lays no ghost tracer.
    expect(Buffer.from(controller.compositePixels({ wet: 'dried' }).data).equals(bare)).toBe(true);
    const info = await call<{ layers: Array<{ ghost?: { remaining: number } }> }>('get_wet_paint');
    expect(info.layers[0]?.ghost).toBeUndefined();
    await call('dry_paint');

    // Now start an active coloured ghost fade at y = 35, then pass invisible-ink at y = 85.
    await call('paint_stroke', {
      brushId: 'ghost-wash',
      color: '#ef4444',
      brush: { ghost: { linger: 5, smear: 0.3 } },
      points: [
        { x: 40, y: 35 },
        { x: 140, y: 35 },
      ],
      seed: 11,
    });
    const beforeInk = await call<{ layers: Array<{ ghost?: { remaining: number } }> }>('get_wet_paint');
    const rem = beforeInk.layers[0]?.ghost?.remaining ?? 0;
    expect(rem).toBeGreaterThan(1);

    await call('paint_stroke', {
      brushId: 'invisible-ink',
      points: [
        { x: 40, y: 85 },
        { x: 140, y: 85 },
      ],
      seed: 12,
    });
    const afterInk = await call<{ layers: Array<{ ghost?: { remaining: number } }> }>('get_wet_paint');
    expect(afterInk.layers[0]?.ghost?.remaining).toBe(rem);
    // Coloured ghost at y = 35 is still visible while wet.
    expect(compAt(controller, 90, 35, 'display')[1]).toBeLessThan(bare[(35 * W + 90) * 4 + 1] - 10);
  });

  it('finishes an earlier ghost immediately when a second ghost colour lands on the same layer, keeping the first smear', async () => {
    const { controller, call } = setup();
    const bareTop = compAt(controller, 90, 40, 'dried');
    await call('paint_stroke', {
      brushId: 'ghost-gouache',
      color: '#dc2626',
      points: [
        { x: 30, y: 40 },
        { x: 150, y: 40 },
      ],
      seed: 13,
    });
    // While only the first ghost stroke is active, y = 40 is strongly red.
    const redWhileActive = compAt(controller, 90, 40, 'display');
    expect(redWhileActive[0] - redWhileActive[2]).toBeGreaterThan(bareTop[0] - bareTop[2] + 30);

    // Second ghost stroke in blue at y = 80 finishes the red ghost at y = 40 right away.
    await call('paint_stroke', {
      brushId: 'ghost-gouache',
      color: '#2563eb',
      points: [
        { x: 30, y: 80 },
        { x: 150, y: 80 },
      ],
      seed: 14,
    });
    const topPx = compAt(controller, 90, 40, 'display');
    const botPx = compAt(controller, 90, 80, 'display');
    // Top stroke's red pigment is completely gone (R - B matches bare paper within 2); bottom stroke is visibly blue.
    expect(Math.abs(topPx[0] - topPx[2] - (bareTop[0] - bareTop[2]))).toBeLessThanOrEqual(2);
    expect(botPx[2]).toBeGreaterThan(botPx[0] + 20);

    await call('dry_paint');
    expect(activeSurface(controller).tiles.size).toBe(0);
  });

  it('refuses gradient, effect, and multi-colour paint on ghost brushes, and prevents ghost and light from sharing a layer', async () => {
    const { controller, call, callRaw } = setup();

    const gradRes = await callRaw('paint_stroke', {
      brushId: 'ghost-wash',
      paint: {
        type: 'gradient',
        stops: [
          { offset: 0, color: '#ef4444' },
          { offset: 1, color: '#3b82f6' },
        ],
      },
      points: [
        { x: 30, y: 60 },
        { x: 120, y: 60 },
      ],
    });
    expect(gradRes.isError).toBe(true);
    expect(JSON.stringify(gradRes.content)).toMatch(/single colour/i);

    // Multi-colour brush settings on a ghost brush are refused.
    expect(() =>
      controller.paintStroke({
        brushId: 'ghost-wash',
        brush: { behavior: { multicolor: { mode: 'tip', colors: ['#ef4444', '#3b82f6'] } } },
        points: [
          { x: 30, y: 60 },
          { x: 120, y: 60 },
        ],
      })
    ).toThrow(/single colour/i);

    // Effect paint on a ghost brush is refused.
    expect(() =>
      controller.paintStroke({
        brushId: 'ghost-wash',
        paint: { type: 'effect', effect: 'fire', provider: 'test', name: 'Fire', values: {} } as never,
        points: [
          { x: 30, y: 60 },
          { x: 120, y: 60 },
        ],
      })
    ).toThrow(/single colour/i);

    // stroke_path works with ghost brushes and leaves bare paper byte-identical when dried.
    const bareBeforePath = Buffer.from(controller.compositePixels().data);
    await call('stroke_path', {
      brushId: 'ghost-wash',
      color: '#ec4899',
      path: 'M 30 30 L 120 30',
    });
    await call('dry_paint');
    expect(Buffer.from(controller.compositePixels().data).equals(bareBeforePath)).toBe(true);

    // Paint ghost on layer 1 -> refuse light on layer 1 while ghost is active.
    await call('paint_stroke', {
      brushId: 'ghost-wash',
      color: '#ec4899',
      points: [
        { x: 30, y: 60 },
        { x: 120, y: 60 },
      ],
    });
    const lightOnGhost = await callRaw('paint_stroke', {
      brushId: 'glow-wash',
      color: '#22d3ee',
      points: [
        { x: 30, y: 60 },
        { x: 120, y: 60 },
      ],
    });
    expect(lightOnGhost.isError).toBe(true);
    expect(JSON.stringify(lightOnGhost.content)).toMatch(/another layer|dry_paint/i);

    // Tracer never glows.
    const lightCheck = await call<{ hasLight: boolean }>('get_light');
    expect(lightCheck.hasLight).toBe(false);

    // Once ghost finishes, light is allowed on the layer; then ghost is refused on the lit layer.
    await call('dry_paint');
    await call('paint_stroke', {
      brushId: 'glow-wash',
      color: '#22d3ee',
      points: [
        { x: 30, y: 60 },
        { x: 120, y: 60 },
      ],
    });
    const ghostOnLight = await callRaw('paint_stroke', {
      brushId: 'ghost-wash',
      color: '#ec4899',
      points: [
        { x: 30, y: 60 },
        { x: 120, y: 60 },
      ],
    });
    expect(ghostOnLight.isError).toBe(true);
    expect(JSON.stringify(ghostOnLight.content)).toMatch(/another layer|clear_light/i);
  });

  it('preserves ghost state across undo/redo and save/load without turning the tracer into glowing light', async () => {
    const { controller, call } = setup();
    const bare = Buffer.from(controller.compositePixels().data);

    await call('paint_stroke', {
      brushId: 'ghost-wash',
      color: '#8b5cf6',
      brush: { ghost: { linger: 3, smear: 0.3 } },
      points: [
        { x: 40, y: 60 },
        { x: 140, y: 60 },
      ],
      seed: 15,
    });
    await call('advance_wet_paint', { seconds: 1 });

    // Save with wet state preserved, and reload into a fresh controller.
    const savedWet = JSON.parse(JSON.stringify(controller.toJSON({ wet: 'preserve' })));
    const restored = new PaintEditorController({ width: W, height: H, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0, gpu: 'off' } });
    expect(restored.loadJSON(savedWet)).toEqual([]);
    expect(restored.lightOf().hasLight).toBe(false);
    expect(restored.wet.info(restored.getActiveLayer()!.id).ghost?.remaining).toBeGreaterThan(0);
    restored.dryPaint();
    expect(restored.lightOf().hasLight).toBe(false);
    expect(Buffer.from(restored.compositePixels().data).equals(bare)).toBe(true);

    // Default toJSON (wet: 'dried') finishes the ghost cleanly without baking ghost colour or light.
    const savedDried = JSON.parse(JSON.stringify(controller.toJSON()));
    const restoredDried = new PaintEditorController({ width: W, height: H, paper: 'cold-pressed', wet: { kernel: 'wasm', threads: 0, gpu: 'off' } });
    expect(restoredDried.loadJSON(savedDried)).toEqual([]);
    expect(restoredDried.lightOf().hasLight).toBe(false);
    expect(Buffer.from(restoredDried.compositePixels().data).equals(bare)).toBe(true);

    // Undo / redo preserves ghost state.
    await call('dry_paint');
    expect(Buffer.from(controller.compositePixels().data).equals(bare)).toBe(true);
    controller.undo(); // undo dry_paint -> back to wet ghost
    expect(controller.lightOf().hasLight).toBe(false);
    expect(controller.wet.info(controller.getActiveLayer()!.id).ghost?.remaining).toBeGreaterThan(0);
    controller.dryPaint();
    expect(Buffer.from(controller.compositePixels().data).equals(bare)).toBe(true);
  });
});
