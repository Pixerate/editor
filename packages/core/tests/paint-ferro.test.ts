import { describe, expect, it } from 'vitest';
import {
  PaintEditorController,
  createPaintBrushLibraryToolProvider,
  createPaintEditorToolProvider,
  ferroFieldAt,
  ferroSpikeHeightAt,
  replayPainting,
  type PaintPixelLayer,
} from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const W = 160;
const H = 100;
const editor = () => new PaintEditorController({ width: W, height: H, paper: 'smooth' });
const LINE = [
  { x: 30, y: 50 },
  { x: 130, y: 50 },
];
const HARD = {
  tip: { size: 16, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureSize: false, pressureOpacity: false, smoothing: 0 },
  grain: 0,
};
const layerId = (c: PaintEditorController) => c.getActiveLayer()!.id;
const ferroAt = (c: PaintEditorController, x: number, y: number, id = layerId(c)) => {
  const f = c.document.ferro?.[id];
  const l = c.getLayer(id) as PaintPixelLayer | null;
  const ox = l?.offset.x ?? 0;
  const oy = l?.offset.y ?? 0;
  return f ? readPixel(f, x - ox, y - oy)[0] : 0;
};

describe('ferrofluid paint and magnets', () => {
  it('ships built-in ferrofluid and ferro-ink presets and supports numeric or object ferro facets', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c, { namespace: '' }));
    reg.register(createPaintBrushLibraryToolProvider(c, { namespace: '' }));

    const listed = await reg.callTool('list_brush_presets', { variety: 'ferrofluid' });
    expect(listed.isError).toBeUndefined();
    const ids = (listed.structuredContent as { brushes: Array<{ id: string }> }).brushes.map((b) => b.id);
    expect(ids).toEqual(['ferrofluid', 'ferro-ink']);

    // Numeric shorthand on set_brush
    const setNum = await reg.callTool('set_brush', { id: 'ink-pen', ferro: 0.75 });
    expect(setNum.isError).toBeUndefined();
    expect((setNum.structuredContent as { brush: { ferro: { amount: number } } }).brush.ferro).toMatchObject({ amount: 0.75 });
    expect(c.getState().brush.ferro.amount).toBe(0.75);

    // Object form on set_brush
    const setObj = await reg.callTool('set_brush', { ferro: { amount: 0.9, wavelength: 12, threshold: 0.12 } });
    expect(setObj.isError).toBeUndefined();
    expect(c.getState().brush.ferro).toEqual({ amount: 0.9, wavelength: 12, threshold: 0.12 });

    // Unset ferro
    const unset = await reg.callTool('set_brush', { unset: ['ferro'] });
    expect(unset.isError).toBeUndefined();
    expect(c.getState().brush.ferro.amount).toBe(0);
  });

  it('computes analytical dipole fields and hexagonal Rosensweig spikes above threshold', () => {
    const magnets = [{ id: 'mag1', x: 80, y: 50, strength: 0.9, radius: 60 }];
    const centre = ferroFieldAt(80, 50, magnets);
    const far = ferroFieldAt(5, 5, magnets);
    expect(centre.magnitude).toBeGreaterThan(0.8);
    expect(far.magnitude).toBeLessThan(centre.magnitude);

    // Below threshold or without ferrofluid: 0 height
    expect(ferroSpikeHeightAt(80, 50, 0, magnets, { amount: 1, wavelength: 14, threshold: 0.18 })).toBe(0);
    expect(ferroSpikeHeightAt(80, 50, 255, [], { amount: 1, wavelength: 14, threshold: 0.18 })).toBe(0);

    // Above threshold: hexagonal spikes vary across a wavelength cell
    let maxSpike = 0;
    let minSpike = 255;
    for (let x = 70; x <= 90; x++) {
      const h = ferroSpikeHeightAt(x, 50, 255, magnets, { amount: 1, wavelength: 12, threshold: 0.15 });
      maxSpike = Math.max(maxSpike, h);
      minSpike = Math.min(minSpike, h);
    }
    expect(maxSpike).toBeGreaterThan(150);
    expect(maxSpike - minSpike).toBeGreaterThan(40);
  });

  it('lays liquid ferrofluid with ferrofluid presets, gathers toward magnets, shades spikes live and cures into relief', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c, { namespace: '' }));

    await reg.callTool('paint_stroke', { brushId: 'ferrofluid', points: LINE });
    expect(ferroAt(c, 80, 50)).toBeGreaterThan(180);

    const beforeMag = await reg.callTool('get_ferrofluid', {});
    expect(beforeMag.structuredContent).toMatchObject({
      ferro: true,
      magnetCount: 0,
      activeSpikeArea: 0,
      maxSpikeHeight: 0,
    });
    const flatComp = Buffer.from(c.compositePixels().data);

    // Place a magnet near (80, 44): liquid gathers toward y=44 and rises into lit spikes
    const beforeNorth = ferroAt(c, 80, 36);
    const added = await reg.callTool('add_magnet', { x: 80, y: 36, strength: 0.9, radius: 70 });
    expect(added.isError).toBeUndefined();
    expect(added.structuredContent).toEqual({ id: 'mag1', x: 80, y: 36, strength: 0.9, radius: 70 });
    // Deterministic advection pulled liquid ferrofluid closer to (80, 36)
    expect(ferroAt(c, 80, 36)).toBeGreaterThanOrEqual(beforeNorth);

    const withMag = await reg.callTool('get_ferrofluid', {});
    expect(withMag.isError).toBeUndefined();
    const stats = withMag.structuredContent as {
      ferro: boolean;
      activeSpikeArea: number;
      maxSpikeHeight: number;
      magnetCount: number;
    };
    expect(stats.ferro).toBe(true);
    expect(stats.magnetCount).toBe(1);
    expect(stats.activeSpikeArea).toBeGreaterThan(50);
    expect(stats.maxSpikeHeight).toBeGreaterThan(100);

    // Composite pixels change immediately because LitCache shades the spikes
    const spikedComp = Buffer.from(c.compositePixels().data);
    expect(spikedComp.equals(flatComp)).toBe(false);

    // Moving the magnet updates the composite and is one undo step
    const moved = await reg.callTool('update_magnet', { id: 'mag1', x: 110, y: 50, strength: 1 });
    expect(moved.isError).toBeUndefined();
    expect(moved.structuredContent).toEqual({ id: 'mag1', x: 110, y: 50, strength: 1, radius: 70 });
    const movedComp = Buffer.from(c.compositePixels().data);
    expect(movedComp.equals(spikedComp)).toBe(false);

    // Cure ferrofluid into permanent impasto relief
    const cured = await reg.callTool('cure_ferrofluid', {});
    expect(cured.isError).toBeUndefined();
    expect(cured.structuredContent).toMatchObject({
      layerId: layerId(c),
      cured: true,
    });
    expect((cured.structuredContent as { maxSpikeHeight: number }).maxSpikeHeight).toBeGreaterThan(100);
    expect(c.document.ferro?.[layerId(c)]).toBeUndefined();
    expect(c.reliefOf()?.maxHeight).toBeGreaterThan(100);

    // Removing magnets after curing leaves the cured relief intact
    const curedComp = Buffer.from(c.compositePixels().data);
    const removed = await reg.callTool('remove_magnets', {});
    expect(removed.structuredContent).toEqual({ removed: ['mag1'] });
    expect(Buffer.from(c.compositePixels().data).equals(curedComp)).toBe(true);

    // Undo remove_magnets and cure_ferrofluid brings back liquid ferrofluid and magnets
    c.undo(); // undo remove_magnets
    expect(c.listMagnets()).toHaveLength(1);
    c.undo(); // undo cure_ferrofluid
    expect(c.getFerrofluid().ferro).toBe(true);
  });

  it('validates tool inputs and refuses wet brushes, sticker sprays and stroke layers with clear messages', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c, { namespace: '' }));

    const badUpdateEmpty = await reg.callTool('update_magnet', { id: 'mag1' });
    expect(badUpdateEmpty.isError).toBe(true);
    expect((badUpdateEmpty.structuredContent as { error: { message: string } }).error.message).toMatch(/Pass at least one change/);

    const badUpdateId = await reg.callTool('update_magnet', { id: 'nope', x: 10 });
    expect(badUpdateId.isError).toBe(true);
    expect((badUpdateId.structuredContent as { error: { message: string } }).error.message).toMatch(/Unknown magnet "nope"/);

    const badRemoveId = await reg.callTool('remove_magnets', { ids: ['nope'] });
    expect(badRemoveId.isError).toBe(true);
    expect((badRemoveId.structuredContent as { error: { message: string } }).error.message).toMatch(/Unknown magnet "nope"/);

    const badLayer = await reg.callTool('get_ferrofluid', { layerId: 'nope' });
    expect(badLayer.isError).toBe(true);
    expect((badLayer.structuredContent as { error: { message: string } }).error.message).toMatch(/Unknown layer "nope"/);

    // Wet and sticker brushes refuse ferro.amount > 0
    expect(() => c.paintStroke({ brushId: 'watercolor-round', brush: { ferro: { amount: 0.8, wavelength: 14, threshold: 0.18 } }, points: LINE })).toThrow(
      /Wet brushes cannot lay ferrofluid/
    );
    expect(() => c.paintStroke({ brushId: 'sticker-stars', brush: { ferro: { amount: 0.8, wavelength: 14, threshold: 0.18 } }, points: LINE })).toThrow(
      /Sticker brushes spray objects and cannot lay ferrofluid/
    );

    // Stroke layers refuse ferrofluid brushes
    c.addLayer({ type: 'strokes', name: 'Live' });
    expect(() => c.paintStroke({ brushId: 'ferrofluid', points: LINE })).toThrow(/stroke layer.*lays ferrofluid/);
  });

  it('preserves ferrofluid and magnets across layer operations, extendCanvas, JSON save/load and replay', async () => {
    const c = editor();
    c.paintStroke({ brushId: 'ferrofluid', brush: HARD, points: LINE });
    c.addMagnet({ x: 80, y: 50, strength: 0.85, radius: 65 });

    // Duplicate layer copies ferrofluid
    const firstId = layerId(c);
    const dup = c.duplicateLayer(firstId) as PaintPixelLayer;
    expect(c.getFerrofluid(dup.id).ferro).toBe(true);

    // Merge down combines ferrofluid
    c.mergeDown(dup.id);
    expect(c.getFerrofluid(firstId).ferro).toBe(true);

    // Extend canvas shifts magnet coordinates and ferrofluid tiles
    c.extendCanvas({ left: 20, top: 10 });
    expect(c.listMagnets()[0]).toMatchObject({ id: 'mag1', x: 100, y: 60 });
    expect(ferroAt(c, 100, 60, firstId)).toBeGreaterThan(150);

    // Save and load JSON round-trip
    const pixels = Buffer.from(c.compositePixels().data);
    const d = editor();
    expect(d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())))).toEqual([]);
    expect(d.listMagnets()).toEqual(c.listMagnets());
    expect(d.getFerrofluid(firstId).ferro).toBe(true);
    expect(Buffer.from(d.compositePixels().data).equals(pixels)).toBe(true);

    // Replay on a fresh canvas
    const r = editor();
    r.paintStroke({ brushId: 'ferro-ink', brush: HARD, points: LINE });
    r.addMagnet({ x: 80, y: 50, strength: 0.9, radius: 60 });
    r.cureFerrofluid();
    const expectedReplay = Buffer.from(r.compositePixels().data);
    const target = r.createReplayTarget(1);
    await replayPainting(r.document, target);
    expect(Buffer.from(target.compositePixels().data).equals(expectedReplay)).toBe(true);
    target.dispose();
  });
});
