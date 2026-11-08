import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';

function pixelAt(img: { width: number; data: Uint8ClampedArray }, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

describe('UV-fluorescent and thermochromic smart inks (#641)', () => {
  it('paints invisible UV-fluorescent ink that stays unseen in daylight and glows under UV blacklight', async () => {
    const c = new PaintEditorController({ width: 64, height: 64, paper: 'smooth' });
    const reg = new ToolRegistry({ validateArguments: true });
    reg.register(createPaintEditorToolProvider(c, { namespace: '' }));

    const blank = c.compositePixels();
    const paperPx = pixelAt(blank, 32, 32);

    const strokeRes = await reg.callTool('paint_stroke', {
      brushId: 'uv-marker',
      color: '#22d3ee',
      seed: 7,
      points: [
        { x: 16, y: 32, pressure: 1 },
        { x: 48, y: 32, pressure: 1 },
      ],
    });
    expect(strokeRes.isError).toBeFalsy();

    // Under normal daylight, invisible UV ink leaves no pigment on the layer surface.
    const daylight = c.compositePixels();
    expect(pixelAt(daylight, 32, 32)).toEqual(paperPx);

    // Turning UV blacklight on dims the paper to ambient and makes the cyan UV stroke glow and spill.
    const uvOn = await reg.callTool('set_uv_light', { on: true, strength: 1.4, ambient: 0.1 });
    expect(uvOn.isError).toBeFalsy();
    expect((uvOn.structuredContent as { on: boolean; fluorescentLayerIds: string[] }).on).toBe(true);
    expect((uvOn.structuredContent as { fluorescentLayerIds: string[] }).fluorescentLayerIds).toHaveLength(1);

    const underUv = c.compositePixels();
    const cornerUv = pixelAt(underUv, 2, 2);
    const centerUv = pixelAt(underUv, 32, 32);
    const haloUv = pixelAt(underUv, 32, 20);
    // Corner paper is dimmed to ~10% of daylight paper.
    expect(cornerUv[0]).toBeLessThan(paperPx[0] * 0.25);
    // Stroke centre glows brightly in cyan/green-blue.
    expect(centerUv[1]).toBeGreaterThan(180);
    expect(centerUv[2]).toBeGreaterThan(150);
    // Spill halo around the stroke is brighter than the dimmed corner paper.
    expect(haloUv[1]).toBeGreaterThan(cornerUv[1]);

    // Visible fluorescent ink (invisible: false) paints in daylight AND glows under UV.
    await reg.callTool('set_uv_light', { on: false });
    await reg.callTool('paint_stroke', {
      brushId: 'ink-pen',
      color: '#ff2090',
      brush: { fluorescence: { amount: 0.85, invisible: false } },
      seed: 8,
      points: [
        { x: 16, y: 48, pressure: 1 },
        { x: 48, y: 48, pressure: 1 },
      ],
    });
    const visibleDay = pixelAt(c.compositePixels(), 32, 48);
    expect(visibleDay[0]).toBeGreaterThan(180);
    await reg.callTool('set_uv_light', { on: true, strength: 1.2, ambient: 0.1 });
    const visibleUv = pixelAt(c.compositePixels(), 32, 48);
    expect(visibleUv[0]).toBeGreaterThan(150);
  });

  it('shifts thermochromic ink toward hotColor when warmed, diffuses/cools with advance_heat, and resets on clear_heat', async () => {
    const c = new PaintEditorController({ width: 64, height: 64, paper: 'smooth' });
    const reg = new ToolRegistry({ validateArguments: true });
    reg.register(createPaintEditorToolProvider(c, { namespace: '' }));

    await reg.callTool('paint_stroke', {
      brushId: 'thermo-ink',
      seed: 12,
      points: [
        { x: 12, y: 32, pressure: 1 },
        { x: 52, y: 32, pressure: 1 },
      ],
    });

    const coldPx = pixelAt(c.compositePixels(), 32, 32);
    // Cold thermo-ink is deep indigo (#1e2a78): blue > red.
    expect(coldPx[2]).toBeGreaterThan(coldPx[0]);

    // Warm the centre of the stroke.
    const heatRes = await reg.callTool('paint_heat', {
      points: [{ x: 32, y: 32 }],
      radius: 20,
      temperature: 1,
    });
    expect(heatRes.isError).toBeFalsy();
    const heatData = heatRes.structuredContent as { max: number; hotCells: number };
    expect(heatData.max).toBeGreaterThan(0.8);
    expect(heatData.hotCells).toBeGreaterThan(0);

    const hotPx = pixelAt(c.compositePixels(), 32, 32);
    // Hot thermo-ink shifts to orange (#ff7a18): red > blue, while far end (x=14) stays cold.
    expect(hotPx[0]).toBeGreaterThan(200);
    expect(hotPx[0]).toBeGreaterThan(hotPx[2]);
    const farColdPx = pixelAt(c.compositePixels(), 14, 32);
    expect(farColdPx[2]).toBeGreaterThan(farColdPx[0]);

    // Sample heat at warmed and cold points.
    const sampleRes = await reg.callTool('get_heat', {
      points: [
        { x: 32, y: 32 },
        { x: 4, y: 4 },
      ],
    });
    expect(sampleRes.isError).toBeFalsy();
    const samples = (sampleRes.structuredContent as { samples: Array<{ temperature: number }>; thermochromicLayerIds: string[] }).samples;
    expect(samples[0].temperature).toBeGreaterThan(0.7);
    expect(samples[1].temperature).toBe(0);

    // Advance heat: peak cools down while spreading outward.
    const advRes = await reg.callTool('advance_heat', { steps: 12 });
    expect(advRes.isError).toBeFalsy();
    expect((advRes.structuredContent as { max: number }).max).toBeLessThan(heatData.max);

    // Clear heat: returns to cold colour in one undoable step.
    const clearRes = await reg.callTool('clear_heat', {});
    expect(clearRes.isError).toBeFalsy();
    expect((clearRes.structuredContent as { cleared: boolean }).cleared).toBe(true);
    expect(pixelAt(c.compositePixels(), 32, 32)).toEqual(coldPx);

    // Undo brings the heat back.
    c.undo();
    expect(c.getHeat().max).toBeGreaterThan(0);
  });

  it('dries wet paint under hot tiles when paint_heat warms the canvas', async () => {
    const c = new PaintEditorController({ width: 64, height: 64, wet: { kernel: 'typescript', threads: 0, gpu: 'off' } });
    const reg = new ToolRegistry({ validateArguments: true });
    reg.register(createPaintEditorToolProvider(c, { namespace: '' }));

    await reg.callTool('paint_stroke', {
      brushId: 'watercolor-round',
      color: '#2060c0',
      seed: 5,
      points: [
        { x: 20, y: 32, pressure: 0.8 },
        { x: 44, y: 32, pressure: 0.8 },
      ],
    });
    expect(c.wetState().wet).toBe(true);

    const heatRes = await reg.callTool('paint_heat', {
      points: [{ x: 32, y: 32 }],
      radius: 120,
      temperature: 1,
    });
    expect(heatRes.isError).toBeFalsy();
    const dried = (heatRes.structuredContent as { dried: Array<{ layerId: string }> }).dried;
    expect(dried.length).toBeGreaterThan(0);
    expect(c.wetState().wet).toBe(false);
    c.dispose();
  });

  it('preserves fluor, thermo, heat and uvLight across duplicate, merge down, extendCanvas, and JSON round-trip', () => {
    const c = new PaintEditorController({ width: 64, height: 64, paper: 'smooth' });
    c.paintStroke({
      brushId: 'uv-marker',
      color: '#22d3ee',
      seed: 1,
      points: [
        { x: 16, y: 20, pressure: 1 },
        { x: 48, y: 20, pressure: 1 },
      ],
    });
    c.paintStroke({
      brushId: 'thermo-ink',
      color: '#1e3a8a',
      seed: 2,
      points: [
        { x: 16, y: 40, pressure: 1 },
        { x: 48, y: 40, pressure: 1 },
      ],
    });
    c.setUvLight({ on: true, strength: 1.5, ambient: 0.12 });
    c.paintHeat({ points: [{ x: 32, y: 40 }], radius: 18, temperature: 1 });

    // Duplicate and merge down preserve fluor and thermo channels.
    const dup = c.duplicateLayer(c.doc.activeLayerId!);
    expect(c.fluorescentLayerIds()).toContain(dup.id);
    expect(c.thermochromicLayerIds()).toContain(dup.id);
    c.mergeDown(dup.id);
    expect(c.fluorescentLayerIds()).toHaveLength(1);
    expect(c.thermochromicLayerIds()).toHaveLength(1);

    // JSON save and load round-trip.
    const beforePixels = c.compositePixels();
    const saved = c.toJSON();
    const c2 = new PaintEditorController({ width: 32, height: 32 });
    expect(c2.loadJSON(saved)).toEqual([]);
    expect(c2.getUvLight()).toEqual({ on: true, strength: 1.5, ambient: 0.12 });
    expect(c2.getHeat().max).toBeGreaterThan(0.7);
    expect(c2.compositePixels().data).toEqual(beforePixels.data);

    // extendCanvas shifts heat and keeps layer-space fluor/thermo aligned.
    c.extendCanvas({ left: 16, top: 16 });
    const shifted = c.getHeat([{ x: 32 + 16, y: 40 + 16 }]);
    expect(shifted.samples?.[0]?.temperature).toBeGreaterThan(0.7);
  });

  it('validates arguments and refuses smart inks on stroke layers with actionable errors', async () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    const reg = new ToolRegistry({ validateArguments: true });
    reg.register(createPaintEditorToolProvider(c, { namespace: '' }));

    const badUv = await reg.callTool('set_uv_light', { strength: 5 });
    expect(badUv.isError).toBe(true);

    const badHeat = await reg.callTool('paint_heat', { points: [], radius: 20 });
    expect(badHeat.isError).toBe(true);

    c.addLayer({ type: 'strokes', name: 'Strokes' });
    const strokeLayerRefusal = await reg.callTool('paint_stroke', {
      brushId: 'uv-marker',
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
      ],
    });
    expect(strokeLayerRefusal.isError).toBe(true);
    expect(JSON.stringify(strokeLayerRefusal.content)).toContain('UV-fluorescent');
  });
});
