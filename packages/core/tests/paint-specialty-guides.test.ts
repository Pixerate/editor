import { describe, expect, it } from 'vitest';
import { PaintEditorController, brushSpecialtyGuides, createPaintEditorToolProvider, paintBrushSpecialties, runBrushSpecialtyAction, type BrushSpecialtyGuide } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';

function setup(origin?: { x: number; y: number }) {
  const controller = new PaintEditorController({ width: 120, height: 80, wet: { kernel: 'ts', threads: 0, gpu: 'off' } });
  const registry = new ToolRegistry();
  registry.register(createPaintEditorToolProvider(controller, origin ? { origin } : {}));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await registry.callTool(name, args);
    if (res.isError) throw new Error(res.content[0]?.type === 'text' ? res.content[0].text : 'Tool error');
    return res.structuredContent as Record<string, unknown>;
  };
  const guides = async () => (await call('get_specialty_guides')) as { brushId: string; specialties: string[]; guides: BrushSpecialtyGuide[] };
  return { controller, registry, call, guides };
}

describe('specialty guides', () => {
  it('returns nothing for a standard brush', async () => {
    const { call, guides } = setup();
    await call('set_brush', { id: 'pencil-6b' });
    expect(await guides()).toEqual({ brushId: 'pencil-6b', specialties: [], guides: [] });
  });

  it('refuses unknown arguments', async () => {
    const { registry } = setup();
    const r = await registry.callTool('get_specialty_guides', { brushId: 'uv-marker' });
    expect(r.isError).toBe(true);
  });

  it('guides UV ink from blacklight off to on, closing the loop through the action’s tool', async () => {
    const { call, guides } = setup();
    await call('set_brush', { id: 'uv-marker' });
    const off = (await guides()).guides[0]!;
    expect(off).toMatchObject({ kind: 'fluorescence', title: 'UV-fluorescent ink', status: 'UV blacklight is off (strokes are invisible until UV is on)', ready: false });
    expect(off.howToUse).toMatch(/UV blacklight on/);
    expect(off.actions).toEqual([{ id: 'uv-on', label: 'Turn on UV blacklight', tool: 'set_uv_light', arguments: { on: true } }]);
    await call(off.actions[0]!.tool, off.actions[0]!.arguments);
    const on = (await guides()).guides[0]!;
    expect(on).toMatchObject({ status: 'UV blacklight is on (100%)', ready: true, actions: [{ id: 'uv-off', tool: 'set_uv_light', arguments: { on: false } }] });
  });

  it('guides thermochromic ink through warming, stepping and cooling the canvas', async () => {
    const { controller, call, guides } = setup();
    await call('set_brush', { id: 'thermo-ink' });
    const cold = (await guides()).guides[0]!;
    expect(cold).toMatchObject({ kind: 'thermochromic', status: 'Canvas is cool — warm the canvas or paint heat to shift toward #ff7a18', ready: false });
    expect(cold.actions.map((a) => a.id)).toEqual(['warm-canvas']);
    expect(cold.actions[0]).toMatchObject({ tool: 'paint_heat', arguments: { points: [{ x: 60, y: 40 }], radius: 60, temperature: 1 } });
    runBrushSpecialtyAction(controller, cold.actions[0]!);
    const warm = (await guides()).guides[0]!;
    expect(warm.ready).toBe(true);
    expect(warm.status).toMatch(/^Canvas is warm \(max \d+%\)$/);
    expect(warm.actions.map((a) => a.id)).toEqual(['warm-canvas', 'step-heat', 'cool-canvas']);
    await call('clear_heat');
    expect((await guides()).guides[0]!.ready).toBe(false);
  });

  it('guides ferrofluid: add a magnet, then cure the spikes', async () => {
    const { controller, call, guides } = setup();
    await call('set_brush', { id: 'ferrofluid' });
    const none = (await guides()).guides[0]!;
    expect(none).toMatchObject({ kind: 'ferro', title: 'Ferrofluid', status: 'No magnets placed — add a magnet to pull liquid ferrofluid into 3D spikes', ready: false });
    expect(none.actions).toEqual([{ id: 'add-magnet', label: 'Add magnet', tool: 'add_magnet', arguments: { x: 60, y: 40 } }]);
    await call('paint_stroke', { points: [{ x: 30, y: 40 }, { x: 90, y: 40 }], seed: 3 });
    await call('add_magnet', none.actions[0]!.arguments);
    const one = (await guides()).guides[0]!;
    expect(one).toMatchObject({ status: '1 magnet active — cure the spikes to keep them as relief', ready: true });
    expect(one.actions.map((a) => a.id)).toEqual(['add-magnet', 'cure-ferrofluid']);
    expect(one.actions[0]!.arguments).toEqual({ x: 84, y: 40 });
    expect(runBrushSpecialtyAction(controller, one.actions[1]!)).toMatchObject({ cured: true });
  });

  it('guides iridescence with a tilt and a reset', async () => {
    const { call, guides } = setup();
    await call('set_brush', { id: 'soap-film' });
    const flat = (await guides()).guides[0]!;
    expect(flat).toMatchObject({ kind: 'iridescence', status: 'Tilt the view or move the light to shift interference colours', ready: true, actions: [{ id: 'tilt-view', tool: 'set_view_tilt', arguments: { x: 0.6, y: -0.4 } }] });
    await call('set_view_tilt', { x: 0.6, y: -0.4 });
    expect((await guides()).guides[0]!.actions).toEqual([{ id: 'reset-tilt', label: 'Reset tilt', tool: 'set_view_tilt', arguments: { x: 0, y: 0 } }]);
  });

  it('describes ghost, mutation and live-pattern paint', async () => {
    const { controller, call, guides } = setup();
    await call('set_brush', { id: 'ghost-gouache' });
    expect((await guides()).guides).toMatchObject([{ kind: 'ghost', status: 'Smears existing paint on this layer, then its own pigment fades away over 5s', ready: true, actions: [] }]);
    await call('set_brush', { id: 'mutation-wash' });
    expect((await guides()).specialties).toEqual(['mutation']);
    expect((await guides()).guides[0]).toMatchObject({ status: 'No mutation agent connected — strokes will stay as ordinary paint', ready: false });
    expect(brushSpecialtyGuides(controller.getState(), { hasMutationAgent: true })[0]).toMatchObject({ status: 'Agent connected — pauses 1.5s after your stroke so the agent can answer', ready: true });
    await call('set_brush', { id: 'turing-wash' });
    expect((await guides()).guides[0]).toMatchObject({ kind: 'livePatterns', status: 'Paint a wet wash: spot patterns grow while it is wet and freeze as it dries', actions: [] });
    await call('paint_stroke', { points: [{ x: 30, y: 40 }, { x: 90, y: 40 }], seed: 4 });
    const wet = (await guides()).guides[0]!;
    expect(wet.status).toBe('Spot patterns grow in the wet paint on this layer and freeze as it dries');
    expect(wet.actions).toEqual([{ id: 'seed-pattern', label: 'Seed pattern', tool: 'seed_live_patterns', arguments: { points: [{ x: 60, y: 40 }], radius: 16, pattern: 'spots' } }]);
    expect(runBrushSpecialtyAction(controller, wet.actions[0]!)).toMatchObject({ seededCells: expect.any(Number) });
  });

  it('names an engine brush’s specialties, a wet mutation brush as mutation only', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    c.setBrush({ id: 'mutation-wash' });
    expect(c.getState().brush.ghost).toBeDefined();
    expect(paintBrushSpecialties(c.getState().brush)).toEqual(['mutation']);
  });

  it('gives action positions in host coordinates on a hosted canvas', async () => {
    const { call, guides } = setup({ x: 1000, y: 500 });
    await call('set_brush', { id: 'ferrofluid' });
    expect((await guides()).guides[0]!.actions[0]!.arguments).toEqual({ x: 1060, y: 540 });
    await call('set_brush', { id: 'thermo-ink' });
    expect((await guides()).guides[0]!.actions[0]!.arguments).toMatchObject({ points: [{ x: 1060, y: 540 }] });
    await call('set_brush', { id: 'soap-film' });
    expect((await guides()).guides[0]!.actions[0]!.arguments).toEqual({ x: 0.6, y: -0.4 });
  });
});
