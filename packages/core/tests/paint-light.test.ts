import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintBrushLibraryToolProvider, createPaintEditorToolProvider, replayPainting, type PaintPixelLayer } from '../src/paint-editor';
import { readPixel } from '../src/raster/surface';
import { ToolRegistry } from '../src/tools/registry';

const W = 160;
const H = 100;
const editor = () => new PaintEditorController({ width: W, height: H, paper: 'smooth' });
const LINE = [
  { x: 20, y: 50 },
  { x: 140, y: 50 },
];
const HARD = { tip: { size: 12, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureSize: false, pressureOpacity: false, smoothing: 0 }, grain: 0 };
const layerId = (c: PaintEditorController) => c.getActiveLayer()!.id;
const lightAt = (c: PaintEditorController, x: number, y: number, id = layerId(c)) => {
  const l = c.document.light?.[id];
  return l ? readPixel(l, x, y)[0] : 0;
};
const comp = (c: PaintEditorController, x: number, y: number) => {
  const { data } = c.compositePixels();
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
};
const sum = (p: number[]) => p[0] + p[1] + p[2];

describe('light paint', () => {
  it('a brush without light changes nothing: no light channel and the same pixels', () => {
    const a = editor();
    a.paintStroke({ brushId: 'ink-pen', brush: HARD, points: LINE, color: '#2563eb' });
    expect(a.document.light).toBeUndefined();
    const b = editor();
    b.paintStroke({ brushId: 'ink-pen', brush: { ...HARD, light: { amount: 0 } }, points: LINE, color: '#2563eb' });
    expect(Buffer.from(b.compositePixels().data).equals(Buffer.from(a.compositePixels().data))).toBe(true);
  });

  it('lays light by the stroke\'s coverage for dab, particle, bristle, mixer and impasto brushes', () => {
    for (const brushId of ['neon-marker', 'spark-trail', 'bristle-round', 'mixer-brush', 'glow-gel']) {
      const c = editor();
      c.paintStroke({ brushId, brush: { light: { amount: 1 }, ...(brushId === 'neon-marker' ? HARD : {}) }, points: LINE, color: '#22d3ee', seed: 4 });
      const l = c.document.light?.[layerId(c)];
      expect(l, brushId).toBeDefined();
      const layer = c.getActiveLayer() as PaintPixelLayer;
      // Light only where paint is.
      let inside = 0;
      let outside = 0;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        const v = readPixel(l!, x, y)[0];
        if (readPixel(layer.surface, x, y)[3] > 0) inside = Math.max(inside, v);
        else outside = Math.max(outside, v);
      }
      expect(inside, brushId).toBeGreaterThan(100);
      expect(outside, brushId).toBe(0);
    }
    const c = editor();
    c.paintStroke({ brushId: 'neon-marker', brush: HARD, points: LINE, color: '#22d3ee' });
    expect(lightAt(c, 80, 50)).toBe(255);
  });

  it('refuses sticker brushes with light, naming what to use (wet brushes take it: see paint-wet-light.test.ts)', () => {
    const c = editor();
    expect(() => c.paintStroke({ brushId: 'sticker-stars', brush: { light: { amount: 1 } }, points: LINE })).toThrow(/stickers.*light.amount to 0/);
  });

  it('plain paint over glowing paint dims its light, erasers take it away, and smudges move it', () => {
    const c = editor();
    c.paintStroke({ brushId: 'neon-marker', brush: HARD, points: LINE, color: '#22d3ee' });
    c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: [{ x: 20, y: 50 }, { x: 60, y: 50 }], color: '#000000' });
    expect(lightAt(c, 40, 50)).toBe(0);
    expect(lightAt(c, 100, 50)).toBe(255);
    c.paintStroke({ brushId: 'eraser-hard', brush: { tip: { size: 12 } }, points: [{ x: 110, y: 50 }, { x: 140, y: 50 }] });
    expect(lightAt(c, 125, 50)).toBeLessThan(40);
    // A smudge across the remaining glow drags light below the line, where none was laid.
    expect(lightAt(c, 85, 70)).toBe(0);
    c.paintStroke({ brushId: 'smudge', brush: { tip: { size: 20 } }, points: Array.from({ length: 12 }, (_, i) => ({ x: 85, y: 44 + i * 3 })) });
    expect(lightAt(c, 85, 62)).toBeGreaterThan(0);
  });

  it('glows in the paint\'s colour whatever the light direction, and spills around it, without repainting', () => {
    const plain = editor();
    plain.setPaper({ color: '#111111' } as never);
    plain.paintStroke({ brushId: 'ink-pen', brush: HARD, points: LINE, color: '#3b82f6' });
    const lit = editor();
    lit.setPaper({ color: '#111111' } as never);
    lit.paintStroke({ brushId: 'neon-marker', brush: HARD, points: LINE, color: '#3b82f6' });
    // Glow: the paint itself is brighter.
    expect(sum(comp(lit, 80, 50))).toBeGreaterThan(sum(comp(plain, 80, 50)));
    // Spill: the paper next to the stroke picks up blue.
    const near = comp(lit, 80, 62);
    expect(near[2] - comp(plain, 80, 62)[2]).toBeGreaterThan(5);
    expect(near[2]).toBeGreaterThan(near[0]);
    // Far beyond the radius: untouched.
    expect(comp(lit, 80, 98)).toEqual(comp(plain, 80, 98));
    const before = Buffer.from(lit.compositePixels().data);
    lit.setLighting({ azimuth: 45 });
    expect(Buffer.from(lit.compositePixels().data).equals(before)).toBe(true);
    // Spill settings re-render without a new undo step.
    const undoDepth = lit.getState().undoLabel;
    expect(lit.setLightSpill(undefined, { radius: 0 })).toEqual({ radius: 0, strength: 1 });
    expect(comp(lit, 80, 62)).toEqual(comp(plain, 80, 62));
    expect(lit.getState().undoLabel).toBe(undoDepth);
    expect(() => lit.setLightSpill(undefined, { strength: 3 })).toThrow(/strength 3 is out of range/);
  });

  it('gives glassy beads a rim and clarity: brighter, clearer edges in the middle', () => {
    const c = editor();
    c.setPaper({ color: '#ffffff' } as never);
    c.paintStroke({ brushId: 'glow-gel', brush: { tip: { size: 30 }, impasto: { rim: 1, clarity: 1 } }, points: LINE, color: '#ef4444' });
    const layer = c.getActiveLayer() as PaintPixelLayer;
    const material = c.document.thick![layer.id].material;
    expect(readPixel(material, 80, 50)[2]).toBeGreaterThan(200);
    expect(readPixel(material, 80, 50)[3]).toBeLessThan(10);
    // Clarity: the middle of the bead lets more paper through than its edge.
    const mid = comp(c, 80, 50);
    const edge = comp(c, 80, 40);
    expect(sum(mid)).toBeGreaterThan(sum(edge));
    // Without clarity (material A = 255) the paint is solid.
    const d = editor();
    d.setPaper({ color: '#ffffff' } as never);
    d.paintStroke({ brushId: 'glow-gel', brush: { tip: { size: 30 }, impasto: { rim: 0, clarity: 0 } }, points: LINE, color: '#ef4444' });
    expect(readPixel(d.document.thick![d.getActiveLayer()!.id].material, 80, 50)[3]).toBe(255);
  });

  it('undoes, saves and loads, duplicates, merges and clears light, and replays exactly', async () => {
    const c = editor();
    c.paintStroke({ brushId: 'neon-marker', brush: HARD, points: LINE, color: '#22d3ee' });
    c.setLightSpill(undefined, { radius: 12, strength: 1.5 });
    c.paintStroke({ brushId: 'smudge', brush: { tip: { size: 20 } }, points: [{ x: 60, y: 44 }, { x: 60, y: 70 }] });
    const pixels = Buffer.from(c.compositePixels().data);
    const t = c.createReplayTarget(1);
    await replayPainting(c.document, t);
    t.setLightSpill(t.getActiveLayer()!.id, { radius: 12, strength: 1.5 });
    expect(Buffer.from(t.compositePixels().data).equals(pixels)).toBe(true);
    t.dispose();
    const d = editor();
    expect(d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())))).toEqual([]);
    expect(Buffer.from(d.compositePixels().data).equals(pixels)).toBe(true);
    expect(d.lightOf().spill).toEqual({ radius: 12, strength: 1.5 });
    c.undo();
    c.undo();
    expect(c.lightOf().hasLight).toBe(false);
    c.redo();
    const id = layerId(c);
    const dup = c.duplicateLayer(id);
    expect(lightAt(c, 80, 50, dup.id)).toBe(255);
    c.mergeDown(dup.id);
    expect(lightAt(c, 80, 50, id)).toBe(255);
    expect(c.clearLight(id)).toEqual({ layerId: id, cleared: true });
    expect(c.lightOf(id).hasLight).toBe(false);
    expect(readPixel((c.getLayer(id) as PaintPixelLayer).surface, 80, 50)[3]).toBe(255);
    c.undo();
    expect(c.lightOf(id).peak).toBe(255);
  });

  it('the highlighter keeps text under it dark and glows brighter than a plain marker (with the layer\'s spill off)', () => {
    const band = (brushId: string) => {
      const c = new PaintEditorController({ width: W, height: H, paper: 'smooth' });
      c.paintStroke({ brushId: 'ink-pen', brush: { tip: { size: 3 } }, points: LINE, color: '#111111' });
      c.paintStroke({ brushId, points: LINE, color: '#f5f53a' });
      c.setLightSpill(undefined, { radius: 0 });
      return { ink: comp(c, 80, 50), band: comp(c, 80, 44) };
    };
    const marker = band('marker');
    const hl = band('highlighter');
    expect(sum(hl.ink)).toBeLessThan(90);
    expect(sum(hl.band)).toBeGreaterThan(sum(marker.band) + 12);
  });

  it('writes spill to PSD as a Linear Dodge layer above its layer, and says light becomes pixels', () => {
    const c = editor();
    c.paintStroke({ brushId: 'neon-marker', brush: HARD, points: LINE, color: '#22d3ee' });
    const name = c.getActiveLayer()!.name;
    const r = c.exportPsd();
    expect(r.warnings.some((w) => /Light paint is written as pixels/.test(w))).toBe(true);
    const text = Buffer.from(r.bytes).toString('latin1');
    // The spill layer is named after its layer and blended with Linear Dodge (PSD key "lddg").
    expect(text).toContain(`${name} light`);
    expect(text).toContain('lddg');
  });

  it('agent tools read, spill and clear light, and set_brush takes light, rim and clarity', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    reg.register(createPaintBrushLibraryToolProvider(c));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await reg.callTool(name, args);
      return { error: r.isError ? (r.content[0] as { text: string }).text : null, data: r.structuredContent as any };
    };
    let r = await call('get_light', {});
    expect(r.data).toMatchObject({ hasLight: false, bounds: null, peak: 0, spill: { radius: 24, strength: 1 } });
    r = await call('set_brush', { id: 'glow-gel', light: { amount: 0.5, pressure: true }, behaviour: { thick: { rim: 0.3, clarity: 0.2 } } });
    expect(r.data).toMatchObject({ engine: 'impasto', brush: { light: { amount: 0.5, pressure: true }, behaviour: { surface: 'thick', thick: { rim: 0.3, clarity: 0.2 } } } });
    expect(c.getState().brush).toMatchObject({ light: { amount: 0.5, pressure: true }, impasto: { rim: 0.3, clarity: 0.2 } });
    await call('paint_stroke', { points: LINE, color: '#a855f7' });
    r = await call('get_light', {});
    expect(r.data.hasLight).toBe(true);
    expect(r.data.bounds.width).toBeGreaterThan(100);
    r = await call('set_light_spill', { radius: 40, strength: 0.5 });
    expect(r.data).toEqual({ radius: 40, strength: 0.5 });
    r = await call('set_light_spill', { radius: -1 });
    expect(r.error).not.toBeNull();
    r = await call('clear_light', {});
    expect(r.data.cleared).toBe(true);
    r = await call('clear_light', {});
    expect(r.data.cleared).toBe(false);
    r = await call('list_brush_presets', {});
    expect(r.data.brushes.filter((b: { category: string }) => b.category === 'light').map((b: { id: string; light: number }) => [b.id, b.light])).toEqual([['glow-gel', 0.85], ['neon-marker', 1], ['light-airbrush', 0.7], ['spark-trail', 1], ['light-ribbon', 0.8], ['flame-ribbon', 1], ['neon-strand', 1], ['smoke-ribbon', 0.3], ['bokeh-dots', 0.9], ['twinkle-sparks', 1], ['glow-wash', 0.7], ['highlighter', 0.5], ['antimatter-flare', 0.9]]);
  });
});
