import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider, replayPainting } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools';

const W = 160;
const H = 120;
const editor = () => new PaintEditorController({ width: W, height: H, paper: 'cold-pressed', wet: { kernel: 'ts', threads: 0, gpu: 'off' } });
const LINE = [
  { x: 40, y: 60 },
  { x: 120, y: 60 },
];

function setupTools(c = editor()) {
  const registry = new ToolRegistry();
  registry.register(createPaintEditorToolProvider(c));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await registry.callTool(name, args);
    const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
    return { isError: Boolean(res.isError), body, text };
  };
  return { c, registry, call };
}

describe('live patterns in wet paint (#644)', { timeout: 30_000 }, () => {
  it('exposes get_live_patterns, set_live_patterns, and seed_live_patterns with strict schemas and useful errors', async () => {
    const { c, call } = setupTools();
    const layerId = c.getActiveLayer()!.id;

    const initial = await call('get_live_patterns', {});
    expect(initial.isError).toBe(false);
    expect(initial.body.brushPresets).toEqual(['turing-wash', 'coral-ink']);
    expect(initial.body.presets.spots).toMatchObject({ feed: 0.035, kill: 0.065 });
    expect(initial.body.layers[0]).toMatchObject({
      layerId,
      enabled: false,
      patternCells: 0,
      wetPatternCells: 0,
    });

    // Invalid layerId
    const badLayer = await call('set_live_patterns', { layerId: 'nope', pattern: 'coral' });
    expect(badLayer.isError).toBe(true);
    expect(badLayer.text).toContain('nope');

    // Invalid secondColor
    const badColor = await call('set_live_patterns', { secondColor: 'not-a-hex' });
    expect(badColor.isError).toBe(true);

    // Unknown property rejected by strict schema
    const extraProp = await call('seed_live_patterns', { points: [{ x: 50, y: 50 }], unknownField: 1 });
    expect(extraProp.isError).toBe(true);

    // Valid set_live_patterns is one undo step
    const configured = await call('set_live_patterns', {
      pattern: 'coral',
      scale: 1.25,
      contrast: 1.4,
      secondColor: '#0f766e',
      relief: 0.5,
    });
    expect(configured.isError).toBe(false);
    expect(configured.body.settings).toEqual({
      pattern: 'coral',
      feed: 0.0545,
      kill: 0.062,
      scale: 1.25,
      contrast: 1.4,
      secondColor: '#0f766e',
      relief: 0.5,
    });
  });

  it('grows Gray-Scott patterns during advance_wet_paint and freezes when dried with dry_paint', async () => {
    const { c, call } = setupTools();
    const layerId = c.getActiveLayer()!.id;

    // Pre-wet paper and seed a live pattern in the wet region
    await call('wet_paper', { amount: 0.7 });
    const seeded = await call('seed_live_patterns', {
      layerId,
      points: [{ x: 80, y: 60 }],
      radius: 18,
      seed: 42,
      pattern: 'spots',
      contrast: 1.3,
      secondColor: '#1d4ed8',
    });
    expect(seeded.isError).toBe(false);
    expect(seeded.body.patternCells).toBeGreaterThan(0);
    expect(seeded.body.wetPatternCells).toBeGreaterThan(0);
    const cellsBefore = seeded.body.patternCells;

    // Advance wet paint: reaction-diffusion diffuses and grows where water is present
    await call('advance_wet_paint', { steps: 30 });
    const grown = await call('get_live_patterns', { layerId });
    expect(grown.isError).toBe(false);
    const statsAfterGrow = grown.body.layers[0];
    expect(statsAfterGrow.patternCells).toBeGreaterThan(cellsBefore);
    expect(statsAfterGrow.wetPatternCells).toBeGreaterThan(0);

    // Dry the paint: pattern freezes and bakes into the layer
    const dried = await call('dry_paint', { layerId });
    expect(dried.isError).toBe(false);
    expect(dried.body.stillWet).toBe(false);

    const frozen = await call('get_live_patterns', { layerId });
    expect(frozen.body.layers[0].wetPatternCells).toBe(0);
    expect(frozen.body.layers[0].patternCells).toBe(statsAfterGrow.patternCells);
    const pixelsAfterDry = Buffer.from(c.compositePixels().data);

    // Subsequent advance_wet_paint calls do not alter the frozen pattern or pixels
    await call('advance_wet_paint', { steps: 40 });
    const afterDryAdvance = await call('get_live_patterns', { layerId });
    expect(afterDryAdvance.body.layers[0].patternCells).toBe(statsAfterGrow.patternCells);
    expect(afterDryAdvance.body.layers[0].maxV).toBe(frozen.body.layers[0].maxV);
    expect(Buffer.from(c.compositePixels().data).equals(pixelsAfterDry)).toBe(true);
  });

  it('paints with built-in turing-wash and coral-ink presets, writes relief height when relief > 0, and supports undo/redo and persistence', async () => {
    const { c, call } = setupTools();
    const layerId = c.getActiveLayer()!.id;

    // Paint with turing-wash and relief > 0
    const stroke = await call('paint_stroke', {
      brushId: 'turing-wash',
      brush: { livePatterns: { relief: 0.6, secondColor: '#0e7490' } },
      color: '#38bdf8',
      points: LINE,
      seed: 7,
    });
    expect(stroke.isError).toBe(false);

    const info = await call('get_live_patterns', { layerId });
    expect(info.body.layers[0].enabled).toBe(true);
    expect(info.body.layers[0].patternCells).toBeGreaterThan(0);
    expect(info.body.layers[0].settings.relief).toBe(0.6);

    await call('advance_wet_paint', { steps: 20 });

    // Relief height should be written into doc.thick[layerId] so ridges catch the light
    const relief = await call('get_relief', { layerId });
    expect(relief.isError).toBe(false);
    expect(relief.body.relief).not.toBeNull();
    expect(relief.body.relief.maxHeight).toBeGreaterThan(0);

    // Undo and redo restore the live pattern state
    c.undo();
    expect(c.getLivePatterns(layerId).layers[0].patternCells).toBe(0);
    c.redo();
    expect(c.getLivePatterns(layerId).layers[0].patternCells).toBeGreaterThan(0);

    // Persistence (toJSON / loadJSON) and replay produce identical pixels
    const saved = JSON.parse(JSON.stringify(c.toJSON()));
    c.dryPaint();
    const expectedPixels = Buffer.from(c.compositePixels().data);

    const loaded = editor();
    expect(loaded.loadJSON(saved)).toEqual([]);
    expect(Buffer.from(loaded.compositePixels().data).equals(expectedPixels)).toBe(true);
    expect(loaded.getLivePatterns(layerId).layers[0].enabled).toBe(true);
    expect(loaded.getLivePatterns(layerId).layers[0].settings).toMatchObject({
      pattern: 'spots',
      secondColor: '#0e7490',
      relief: 0.6,
    });

    const replayTarget = c.createReplayTarget(1);
    await replayPainting(c.document, replayTarget);
    expect(Buffer.from(replayTarget.compositePixels().data).equals(expectedPixels)).toBe(true);
    replayTarget.dispose();
  });
});
