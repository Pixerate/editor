import { describe, expect, it } from 'vitest';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';
import { ToolRegistry } from '../src/tools/registry';
import { readPixel } from '../src/raster/surface';
import type { PaintPixelLayer } from '../src/paint-editor/document';

const alpha = (c: PaintEditorController, x: number, y: number) => readPixel((c.getActiveLayer() as PaintPixelLayer).surface, x, y)[3];
const editor = () => new PaintEditorController({ width: 200, height: 200, paper: 'smooth', wet: { kernel: 'wasm', threads: 0 } });

describe('stencils', () => {
  it('a ruler makes a stroke that starts near it follow it exactly', () => {
    const c = editor();
    c.addStencil({ kind: 'ruler', from: { x: 0, y: 100 }, to: { x: 200, y: 100 } });
    const r = c.paintStroke({ points: [{ x: 20, y: 110 }, { x: 100, y: 130 }, { x: 180, y: 90 }], brushId: 'ink-pen' });
    const s = c.getStrokes().find((x) => x.id === r.strokeId)!;
    expect(s.points.every((p) => Math.abs(p.y - 100) < 1e-9)).toBe(true);
    // Far from the ruler, strokes are free.
    const r2 = c.paintStroke({ points: [{ x: 20, y: 20 }, { x: 100, y: 40 }] });
    expect(c.getStrokes().find((x) => x.id === r2.strokeId)!.points[1].y).toBe(40);
  });

  it('an arc guide keeps the stroke on the circle', () => {
    const c = editor();
    c.addStencil({ kind: 'arc', center: { x: 100, y: 100 }, radius: 60 });
    const r = c.paintStroke({ points: [{ x: 165, y: 100 }, { x: 140, y: 150 }, { x: 100, y: 170 }], brushId: 'ink-pen' });
    for (const p of c.getStrokes().find((x) => x.id === r.strokeId)!.points) expect(Math.hypot(p.x - 100, p.y - 100)).toBeCloseTo(60, 6);
  });

  it('a shape mask keeps paint inside (or outside, inverted), for dry, wet and thick paint', async () => {
    const c = editor();
    const st = c.addStencil({ kind: 'shape', shape: 'ellipse', rect: { x: 50, y: 50, width: 100, height: 100 } });
    c.paintStroke({ points: [{ x: 10, y: 100 }, { x: 190, y: 100 }], brushId: 'soft-pastel', brush: { tip: { size: 40 } } });
    expect(alpha(c, 100, 100)).toBeGreaterThan(0);
    expect(alpha(c, 20, 100)).toBe(0);
    c.updateStencil(st.id, { invert: true });
    c.addLayer();
    c.paintStroke({ points: [{ x: 10, y: 100 }, { x: 190, y: 100 }], brushId: 'impasto-brush', brush: { tip: { size: 40 } } });
    expect(alpha(c, 20, 100)).toBeGreaterThan(0);
    expect(alpha(c, 100, 100)).toBe(0);
    c.addLayer();
    c.updateStencil(st.id, { invert: false });
    c.paintStroke({ points: [{ x: 10, y: 100 }, { x: 190, y: 100 }], brushId: 'watercolor-round', brush: { tip: { size: 40 } } });
    expect(alpha(c, 100, 100)).toBeGreaterThan(0);
    expect(alpha(c, 20, 100)).toBe(0);
    // The mask is recorded with the stroke, so a replay keeps to it even after the stencil is gone.
    const strokes = c.getStrokes();
    expect(strokes.at(-1)!.stencils?.length).toBe(1);
    c.removeStencils();
    c.dryPaint();
    const t = c.createReplayTarget(1);
    const { replayPainting } = await import('../src/paint-editor/replay');
    await replayPainting(c.document, t);
    await t.wetIdle();
    t.dryPaint();
    expect(Buffer.from(t.compositePixels().data).equals(Buffer.from(c.compositePixels().data))).toBe(true);
    t.dispose();
    c.dispose();
  }, 60000);

  it('a line masks one side; stencils save and load', () => {
    const c = editor();
    c.addStencil({ kind: 'line', from: { x: 100, y: 0 }, to: { x: 100, y: 200 } });
    c.paintStroke({ points: [{ x: 10, y: 100 }, { x: 190, y: 100 }], brushId: 'soft-pastel' });
    const left = alpha(c, 60, 100);
    const right = alpha(c, 140, 100);
    expect(Math.min(left, right)).toBe(0);
    expect(Math.max(left, right)).toBeGreaterThan(0);
    const d = editor();
    d.loadJSON(JSON.parse(JSON.stringify(c.toJSON())));
    expect(d.listStencils()).toHaveLength(1);
    expect(() => c.addStencil({ kind: 'shape', shape: 'polygon', points: [{ x: 0, y: 0 }] })).toThrow(/at least 3 points/);
  });

  it('agent tools add, update and remove stencils', async () => {
    const c = editor();
    const reg = new ToolRegistry();
    reg.register(createPaintEditorToolProvider(c));
    const parse = (r: { content: Array<{ text?: string }>; structuredContent?: unknown }) => (r.structuredContent ?? JSON.parse(r.content[0].text!)) as Record<string, any>;
    let r = await reg.callTool('add_stencil', { kind: 'ruler', from: { x: 0, y: 50 }, to: { x: 200, y: 50 } });
    const id = parse(r).id;
    expect(parse(r).mode).toBe('guide');
    r = await reg.callTool('update_stencil', { id, mode: 'mask' });
    expect(parse(r).mode).toBe('mask');
    r = await reg.callTool('get_guides', {});
    expect(parse(r).stencils).toHaveLength(1);
    r = await reg.callTool('update_stencil', { id: 'nope' });
    expect(r.isError).toBe(true);
    r = await reg.callTool('add_stencil', { kind: 'arc', center: { x: 1, y: 1 } });
    expect(r.isError).toBe(true);
    r = await reg.callTool('remove_stencils', {});
    expect(parse(r).removed).toEqual([id]);
  });
});
