import { describe, expect, it } from 'vitest';
import {
  PaintDirector,
  PaintEditorController,
  PaintPresence,
  brushEngineControls,
  createPaintBrushLibraryToolProvider,
  createPaintEditorToolProvider,
  normalizePaintBrush,
  type PaintMutationInfo,
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
  const presence = new PaintPresence();
  const director = new PaintDirector(controller, presence, { speed: 100, linger: 0, maxStrokeMs: 25 });
  controller.setMutationDirector(director);
  const registry = new ToolRegistry();
  registry.register(createPaintEditorToolProvider(controller, { director, actor: { id: 'diary', name: 'Diary' } }));
  registry.register(createPaintBrushLibraryToolProvider(controller));
  const call = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const res = await registry.callTool(name, args);
    if (res.isError) throw new Error(res.content[0]?.type === 'text' ? res.content[0].text : 'Tool error');
    return (res.structuredContent ?? JSON.parse(res.content[0]?.type === 'text' ? res.content[0].text : '{}')) as T;
  };
  const callRaw = (name: string, args: Record<string, unknown> = {}) => registry.callTool(name, args);
  return { controller, presence, director, registry, call, callRaw };
}

const compAt = (c: PaintEditorController, x: number, y: number, wet: 'display' | 'dried' = 'display') => {
  const { data } = c.compositePixels({ wet });
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

const activeSurface = (c: PaintEditorController) => (c.getActiveLayer() as PaintPixelLayer).surface;

describe('mutation paint', { timeout: 30_000 }, () => {
  it('exposes mutation-wash and mutation-ink presets, normalizes mutation settings, and surfaces UI sliders', async () => {
    const { call } = setup();
    const list = await call<{ brushes: Array<{ id: string }> }>('list_brush_presets');
    const ids = list.brushes.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['mutation-wash', 'mutation-ink']));

    const wetNorm = normalizePaintBrush({
      engine: 'wet',
      wet: { tool: 'paint' },
      mutation: { settle: 2, patience: 60, fade: 3 },
    });
    expect(wetNorm.mutation).toEqual({ settle: 2, patience: 60, fade: 3 });
    expect(wetNorm.ghost).toEqual({ linger: 3, smear: 0.3, trigger: 'agent' });
    expect(wetNorm.behavior.pickup).toBe(0);

    const dryNorm = normalizePaintBrush({
      engine: 'dab',
      mutation: { settle: 1, patience: 30, fade: 1.5 },
    });
    expect(dryNorm.mutation).toEqual({ settle: 1, patience: 30, fade: 1.5 });
    expect(dryNorm.ghost).toBeUndefined();

    const controls = brushEngineControls(dryNorm)!;
    expect(controls.sliders.map((s) => s.path)).toEqual(
      expect.arrayContaining(['mutation.settle', 'mutation.patience', 'mutation.fade'])
    );
  });

  it('runs the wet mutation lifecycle: holds evaporation until claimed, fades user wash on read_mutation, and paints agent answer', async () => {
    const { controller, call } = setup();
    const barePaper = Buffer.from(controller.compositePixels().data);
    const requests: PaintMutationInfo[] = [];
    const off = controller.onMutationRequest((m) => requests.push(m));

    await call('set_brush', { id: 'mutation-wash' });
    await call('paint_stroke', {
      color: '#1d4ed8',
      points: [
        { x: 40, y: 60, pressure: 0.8 },
        { x: 140, y: 60, pressure: 0.8 },
      ],
      seed: 1,
    });

    // While waiting for claim, evaporation is held at 0 so the wash stays wet even over many seconds.
    const wetBeforeClaim = await call<{ layers: Array<{ params: { evaporation: number }; ghost?: { remaining: number } }> }>('get_wet_paint');
    expect(wetBeforeClaim.layers[0]?.params.evaporation).toBe(0);

    // Advance past settle (1.5s): onMutationRequest fires once and state becomes 'pending'.
    await call('advance_wet_paint', { seconds: 2 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.id).toBe('m1');
    expect(requests[0]?.state).toBe('pending');
    expect(requests[0]?.medium).toBe('wet');

    // Claim via read_mutation: returns strokes, cropPng and canvasPng, restores evaporation, and starts the fade.
    const read = await call<{
      id: string;
      state: string;
      medium: string;
      strokes: Array<{ color: string }>;
      cropPng: { width: number; height: number; data: string };
      canvasPng: { width: number; height: number; data: string };
    }>('read_mutation', { id: 'm1' });
    expect(read.id).toBe('m1');
    expect(read.state).toBe('claimed');
    expect(read.strokes[0]?.color).toBe('#1d4ed8');
    expect(read.cropPng.data.length).toBeGreaterThan(20);
    expect(read.canvasPng.data.length).toBeGreaterThan(20);

    const wetAfterClaim = await call<{ layers: Array<{ params: { evaporation: number } }> }>('get_wet_paint');
    expect(wetAfterClaim.layers[0]?.params.evaporation).toBeGreaterThan(0);

    // Advance past fade (2s) and dry before answering: the user's wash vanishes completely on bare paper.
    await call('advance_wet_paint', { seconds: 2.5 });
    await call('dry_paint');
    expect(Buffer.from(controller.compositePixels().data).equals(barePaper)).toBe(true);

    // Now paint the agent's answer.
    const ans = await call<{ id: string; state: string; strokeIds: string[]; origin: string }>('answer_mutation', {
      id: 'm1',
      note: 'Answered with a warm line',
      strokes: [
        {
          brushId: 'ink-pen',
          brush: { tip: { size: 10 } },
          color: '#dc2626',
          points: [
            { x: 50, y: 80, pressure: 0.9 },
            { x: 130, y: 80, pressure: 0.9 },
          ],
        },
      ],
    });
    expect(ans.state).toBe('answered');
    expect(ans.strokeIds).toHaveLength(1);
    expect(readPixel(activeSurface(controller), 90, 80)[3]).toBeGreaterThan(0);

    off();
  });

  it('runs the dry mutation lifecycle: routes to a temporary layer, fades and removes it on claim, and keeps undo clean', async () => {
    const { controller, call } = setup();
    const targetLayerId = controller.document.activeLayerId!;

    await call('set_brush', { id: 'mutation-ink' });
    // Two strokes within settle window join the same mutation and share the temporary layer.
    await call('paint_stroke', {
      color: '#1e293b',
      points: [
        { x: 30, y: 50, pressure: 0.8 },
        { x: 80, y: 50, pressure: 0.8 },
      ],
    });
    await call('paint_stroke', {
      color: '#1e293b',
      points: [
        { x: 80, y: 50, pressure: 0.8 },
        { x: 130, y: 50, pressure: 0.8 },
      ],
    });

    // Active layer stays on targetLayerId; a temporary "Mutation" layer sits above it.
    expect(controller.document.activeLayerId).toBe(targetLayerId);
    const allLayers = controller.listLayers();
    const tempLayer = allLayers.find((l) => l.temporary);
    expect(tempLayer).toBeDefined();
    expect(tempLayer?.name).toBe('Mutation');
    expect(compAt(controller, 60, 50)[0]).toBeLessThan(100);

    //Settle and claim.
    controller.advanceMutations(2);
    const listed = await call<{ mutations: PaintMutationInfo[] }>('list_mutations');
    expect(listed.mutations).toHaveLength(1);
    expect(listed.mutations[0]?.strokeCount).toBe(2);

    await call('read_mutation', { id: 'm1' });

    // Halfway through the 2s fade, the temporary layer's opacity is ~0.5.
    controller.advanceMutations(1);
    const midLayer = controller.listLayers().find((l) => l.id === tempLayer!.id);
    expect(midLayer?.opacity).toBeCloseTo(0.5, 1);

    // Finish the fade: the temporary layer and its recorded strokes are removed without pushing an undo step.
    controller.advanceMutations(1.2);
    expect(controller.listLayers().some((l) => l.temporary)).toBe(false);
    expect(controller.document.strokes).toHaveLength(0);

    // Paint the agent's answer on the target layer; active brush is still mutation-ink, which must not start a new mutation.
    await call('answer_mutation', {
      id: 'm1',
      strokes: [
        {
          brushId: 'ink-pen',
          brush: { tip: { size: 8 } },
          color: '#16a34a',
          points: [
            { x: 40, y: 90, pressure: 0.9 },
            { x: 140, y: 90, pressure: 0.9 },
          ],
        },
      ],
    });
    expect(controller.listMutations()).toHaveLength(0);
    expect(controller.document.strokes).toHaveLength(1);
    expect(readPixel(activeSurface(controller), 90, 90)[3]).toBeGreaterThan(0);

    // Undoing once removes the agent's answer.
    controller.undo();
    expect(readPixel(activeSurface(controller), 90, 90)[3]).toBe(0);
  });

  it('keeps paint as ordinary paint on decline_mutation or patience timeout for both dry and wet mutations', async () => {
    const { controller, call } = setup();
    const targetLayerId = controller.document.activeLayerId!;

    // 1. Dry mutation declined -> merges down into targetLayerId.
    await call('set_brush', { id: 'mutation-ink' });
    await call('paint_stroke', {
      color: '#0f172a',
      points: [
        { x: 30, y: 40, pressure: 0.9 },
        { x: 120, y: 40, pressure: 0.9 },
      ],
    });
    controller.advanceMutations(2);
    const dec = await call<{ id: string; state: string; reason?: string }>('decline_mutation', {
      id: 'm1',
      reason: 'Keep user sketch',
    });
    expect(dec.state).toBe('declined');
    expect(controller.listLayers().some((l) => l.temporary)).toBe(false);
    expect(readPixel(activeSurface(controller), 75, 40)[3]).toBeGreaterThan(0);
    expect(controller.document.strokes[0]?.layerId).toBe(targetLayerId);

    // 2. Wet mutation times out after patience -> keeps pigment when dried.
    await call('set_brush', { id: 'mutation-wash', mutation: { settle: 1, patience: 5, fade: 2 } });
    await call('paint_stroke', {
      color: '#dc2626',
      points: [
        { x: 30, y: 90, pressure: 0.9 },
        { x: 120, y: 90, pressure: 0.9 },
      ],
    });
    controller.advanceMutations(1.2); // settle -> pending
    controller.advanceMutations(5.5); // patience expires -> declined + keepGhost
    const all = await call<{ mutations: PaintMutationInfo[] }>('list_mutations', { includeAll: true });
    expect(all.mutations.find((m) => m.id === 'm2')?.state).toBe('declined');
    await call('dry_paint');
    expect(readPixel(activeSurface(controller), 75, 90)[3]).toBeGreaterThan(0);
  });

  it('merges unclaimed dry temporary layers and bakes unclaimed wet mutation paint on toJSON()', async () => {
    const { controller, call } = setup();
    const targetLayerId = controller.document.activeLayerId!;

    await call('set_brush', { id: 'mutation-ink' });
    await call('paint_stroke', {
      color: '#1e293b',
      points: [
        { x: 25, y: 35, pressure: 0.9 },
        { x: 105, y: 35, pressure: 0.9 },
      ],
    });

    await call('set_brush', { id: 'mutation-wash' });
    await call('paint_stroke', {
      color: '#2563eb',
      points: [
        { x: 25, y: 85, pressure: 0.9 },
        { x: 105, y: 85, pressure: 0.9 },
      ],
    });

    const saved = controller.toJSON();
    // No temporary layers in saved JSON, and strokes belong to targetLayerId.
    expect(saved.layers.some((l) => (l as { temporary?: boolean }).temporary)).toBe(false);
    expect(saved.strokes.every((s) => s.layerId === targetLayerId)).toBe(true);
    // Saved wet settings have non-zero pre-hold evaporation and no agent ghost state.
    const wetLayers = (saved.wet as { layers?: Record<string, { params: { evaporation: number }; ghost?: unknown }> } | undefined)?.layers;
    expect(wetLayers?.[targetLayerId]?.params.evaporation).toBeGreaterThan(0);
    expect(wetLayers?.[targetLayerId]?.ghost).toBeUndefined();
  });

  it('refuses double-claim, double-answer, and invalid brush combinations', async () => {
    const { controller, call, callRaw } = setup();

    await call('set_brush', { id: 'mutation-ink' });
    await call('paint_stroke', {
      color: '#1e293b',
      points: [
        { x: 40, y: 40, pressure: 0.8 },
        { x: 100, y: 40, pressure: 0.8 },
      ],
    });
    controller.advanceMutations(2);

    // Answering before read_mutation is refused.
    const earlyAnswer = await callRaw('answer_mutation', {
      id: 'm1',
      strokes: [{ points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] }],
    });
    expect(earlyAnswer.isError).toBe(true);

    // First claim succeeds; second claim is refused.
    await call('read_mutation', { id: 'm1' });
    const secondClaim = await callRaw('read_mutation', { id: 'm1' });
    expect(secondClaim.isError).toBe(true);

    // First answer succeeds; second answer is refused.
    await call('answer_mutation', {
      id: 'm1',
      strokes: [{ brushId: 'ink-pen', color: '#dc2626', points: [{ x: 10, y: 10 }, { x: 50, y: 50 }] }],
    });
    const secondAnswer = await callRaw('answer_mutation', {
      id: 'm1',
      strokes: [{ brushId: 'ink-pen', color: '#dc2626', points: [{ x: 10, y: 10 }, { x: 50, y: 50 }] }],
    });
    expect(secondAnswer.isError).toBe(true);

    // Stroke layers refuse mutation brushes.
    const strokeLayer = controller.addLayer({ type: 'strokes', name: 'Live' });
    controller.setActiveLayer(strokeLayer.id);
    await call('set_brush', { id: 'mutation-ink' });
    const onStrokeLayer = await callRaw('paint_stroke', {
      points: [{ x: 20, y: 20 }, { x: 60, y: 60 }],
    });
    expect(onStrokeLayer.isError).toBe(true);
  });
});
