// Brush cases re-expressed from photocraft/crates/paint/src/lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  createImageEditorToolProvider,
  dabCoverage,
  normalizeBrush,
  readPixel,
  smoothPoints,
  walkDabs,
  type PixelLayer,
} from '../src/image-editor';

const W = 100;
const H = 40;

function setup(fill = 255) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(fill) });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, registry };
}

const line = (y = 10, x0 = 10, x1 = 90) => [{ x: x0, y }, { x: x1, y }];
const pixel = (c: ImageEditorController, id: string, x: number, y: number) => {
  const l = c.getLayer(id) as PixelLayer;
  return readPixel(l.surface, x - l.offset.x, y - l.offset.y);
};

describe('brush engine', () => {
  it('spaces dabs by a fraction of the diameter', () => {
    const brush = normalizeBrush({ size: 10, pressureSize: false });
    const n = walkDabs([{ x: 0, y: 0 }, { x: 100, y: 0 }], brush).length;
    expect(n).toBeGreaterThanOrEqual(95);
    expect(n).toBeLessThanOrEqual(105);
    expect(walkDabs([{ x: 0, y: 0 }, { x: 100, y: 0 }], { ...brush, spacing: 1 })).toHaveLength(11);
    expect(walkDabs([{ x: 5, y: 5 }], brush)).toHaveLength(1);
  });

  it('has photocraft’s round tip profile', () => {
    expect(dabCoverage(0, 10, 1)).toBe(1);
    expect(dabCoverage(20, 10, 1)).toBe(0);
    const soft = dabCoverage(5, 10, 0);
    expect(soft).toBeGreaterThan(0.2);
    expect(soft).toBeLessThan(0.8);
    expect(dabCoverage(8.5, 10, 1)).toBeGreaterThan(0.99);
    expect(dabCoverage(9.5, 10, 1)).toBeGreaterThan(0.5);
    expect(dabCoverage(11, 10, 1)).toBeLessThan(0.05);
  });

  it('pressure changes size; smoothing keeps the endpoints', () => {
    const d = walkDabs([{ x: 0, y: 0, pressure: 0.1 }, { x: 100, y: 0, pressure: 1 }], normalizeBrush({ size: 20 }));
    expect(d[0].radius).toBeLessThan(d[d.length - 1].radius);
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: i % 2 ? 10 : 0 }));
    const s = smoothPoints(pts, 0.8);
    expect(s[0]).toEqual(pts[0]);
    expect(s[19]).toEqual(pts[19]);
    const jitter = (list: typeof pts) => list.slice(1, 19).reduce((a, p) => a + Math.abs(p.y - 5), 0);
    expect(jitter(s)).toBeLessThan(jitter(pts));
  });
});

describe('painting layers', () => {
  it('a hard brush paints a solid line, as one undo step', () => {
    const { c } = setup();
    const id = c.addPixelLayer();
    const res = c.paintStroke({ points: line(), brush: { size: 8, pressureSize: false }, color: '#000000' });
    expect(res.layerId).toBe(id);
    expect(res.bounds!.x).toBeLessThanOrEqual(6);
    expect(res.dabs).toBeGreaterThan(50);
    expect(pixel(c, id, 50, 10)).toEqual([0, 0, 0, 255]);
    expect(pixel(c, id, 50, 30)[3]).toBe(0);
    c.undo();
    expect(pixel(c, id, 50, 10)[3]).toBe(0);
    c.redo();
    expect(pixel(c, id, 50, 10)[3]).toBe(255);
  });

  it('opacity caps overlapping dabs; flow builds up towards it', () => {
    const { c } = setup();
    const id = c.addPixelLayer();
    c.paintStroke({ points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 10, y: 10 }], brush: { size: 10, opacity: 0.5, pressureSize: false } });
    expect(Math.abs(pixel(c, id, 30, 10)[3] - 128)).toBeLessThanOrEqual(5);
    const b = c.addPixelLayer();
    c.paintStroke({ points: [{ x: 10, y: 30 }, { x: 60, y: 30 }], brush: { size: 10, flow: 0.2, spacing: 0.25, pressureSize: false } });
    const built = pixel(c, b, 30, 30)[3];
    // About four dabs overlap each pixel: 1 − 0.8⁴ ≈ 0.59.
    expect(built).toBeGreaterThan(120);
    expect(built).toBeLessThan(255);
  });

  it('the selection limits paint; lock transparency keeps alpha; the eraser removes it', () => {
    const { c } = setup();
    const id = c.addPixelLayer({ color: '#ff0000' });
    c.selectRect({ x: 0, y: 0, width: 50, height: H });
    c.paintStroke({ points: line(), brush: { size: 8, pressureSize: false }, color: '#0000ff' });
    expect(pixel(c, id, 20, 10)).toEqual([0, 0, 255, 255]);
    expect(pixel(c, id, 70, 10)).toEqual([255, 0, 0, 255]);
    c.deselect();
    c.paintStroke({ tool: 'eraser', points: line(20), brush: { size: 8, pressureSize: false } });
    expect(pixel(c, id, 50, 20)[3]).toBe(0);
    expect(pixel(c, id, 50, 1)[3]).toBe(255);
    // Transparency locked: the brush keeps alpha, the eraser paints the background colour.
    const t = c.addPixelLayer();
    c.paintStroke({ points: line(30, 10, 50), brush: { size: 8, pressureSize: false }, color: '#ffffff' });
    c.setLayerProperties(t, { locks: { transparency: true } });
    c.paintStroke({ points: line(30), brush: { size: 8, pressureSize: false }, color: '#000000' });
    expect(pixel(c, t, 20, 30)).toEqual([0, 0, 0, 255]);
    expect(pixel(c, t, 70, 30)[3]).toBe(0);
    c.setPaintOptions({ background: '#00ff00' });
    c.paintStroke({ tool: 'eraser', points: line(30, 10, 30), brush: { size: 8, pressureSize: false } });
    expect(pixel(c, t, 20, 30)).toEqual([0, 255, 0, 255]);
  });

  it('paints masks in grey: black hides, white reveals', () => {
    const { c } = setup();
    const id = c.addPixelLayer({ color: '#ff0000' });
    c.addLayerMask(id, 'reveal-all');
    expect(c.getState().activeTarget).toBe('mask');
    const res = c.paintStroke({ points: line(), brush: { size: 8, pressureSize: false }, color: '#000000' });
    expect(res.channel).toBe('mask');
    const at = (x: number, y: number) => Array.from(c.compositePixels({ x, y, width: 1, height: 1 }).data);
    expect(at(50, 10)).toEqual([255, 255, 255, 255]);
    expect(at(50, 30)).toEqual([255, 0, 0, 255]);
    c.paintStroke({ tool: 'eraser', points: line(), brush: { size: 8, pressureSize: false } });
    expect(at(50, 10)).toEqual([255, 0, 0, 255]);
  });

  it('refuses locked, hidden and non-pixel targets with reasons, changing nothing', () => {
    const { c } = setup();
    const adj = c.addAdjustmentLayer('invert');
    expect(() => c.paintStroke({ layerId: adj, points: line() })).toThrow(/adjustment layer; paint on a pixel layer, or on this layer's mask/);
    expect(() => c.paintStroke({ layerId: adj, channel: 'mask', points: line() })).toThrow(/no mask/);
    const id = c.addPixelLayer();
    c.setLayerProperties(id, { locks: { pixels: true } });
    expect(() => c.paintStroke({ points: line() })).toThrow(/pixels locked/);
    c.setLayerProperties(id, { locks: {}, visible: false });
    const before = c.getLayers();
    expect(() => c.paintStroke({ points: line() })).toThrow(/hidden/);
    expect(() => c.paintStroke({ points: [] })).toThrow(/at least one/);
    expect(c.getLayers()).toBe(before);
  });

  it('a live stroke changes the stack without history, then commits once; cancel restores', () => {
    const { c } = setup();
    const id = c.addPixelLayer();
    const undoDepth = () => {
      let n = 0;
      while (c.canUndo && c.undo()) n++;
      for (let i = 0; i < n; i++) c.redo();
      return n;
    };
    const depth = undoDepth();
    const s = c.beginStroke({ brush: { size: 6, pressureSize: false } });
    s.push([{ x: 10, y: 10 }, { x: 30, y: 10 }]);
    expect(pixel(c, id, 20, 10)[3]).toBe(255);
    s.push([{ x: 50, y: 10 }]);
    expect(pixel(c, id, 40, 10)[3]).toBe(255);
    s.cancel();
    expect(pixel(c, id, 20, 10)[3]).toBe(0);
    expect(undoDepth()).toBe(depth);
    const t = c.beginStroke({ brush: { size: 6, pressureSize: false } });
    t.push([{ x: 10, y: 10 }]);
    t.push([{ x: 50, y: 10 }]);
    t.end();
    expect(undoDepth()).toBe(depth + 1);
  });

  it('painting the Background makes it own its pixels (and the document v3)', () => {
    const { c } = setup(200);
    c.setActiveLayer('background');
    c.paintStroke({ points: line(), brush: { size: 4, pressureSize: false }, color: '#000000' });
    const bg = c.getLayer('background') as PixelLayer;
    expect(bg.source).toBeUndefined();
    expect(readPixel(bg.surface, 50, 10)).toEqual([0, 0, 0, 255]);
    expect(readPixel(bg.surface, 50, 30)).toEqual([200, 200, 200, 200]);
    expect(c.toJSON().version).toBe(3);
  });

  it('fills and clears inside the selection or everywhere', () => {
    const { c } = setup();
    const id = c.addPixelLayer();
    c.selectRect({ x: 10, y: 10, width: 20, height: 10 });
    const f = c.fillPixels({ color: '#00ff00' });
    expect(f.bounds).toEqual({ x: 10, y: 10, width: 20, height: 10 });
    expect(pixel(c, id, 15, 15)).toEqual([0, 255, 0, 255]);
    expect(pixel(c, id, 5, 5)[3]).toBe(0);
    c.fillPixels({ color: '#ff0000', opacity: 0.5, useSelection: false });
    expect(pixel(c, id, 5, 5)).toEqual([255, 0, 0, 128]);
    c.clearPixels();
    expect(pixel(c, id, 15, 15)[3]).toBe(0);
    expect(pixel(c, id, 5, 5)[3]).toBe(128);
  });

  it('agent tools paint, fill and clear, and refuse bad input', async () => {
    const { c, registry } = setup();
    const id = c.addPixelLayer();
    const ok = await registry.callTool('paint_stroke', {
      points: [{ x: 10, y: 10, pressure: 0.5 }, { x: 90, y: 10, pressure: 1 }],
      color: '#123456',
      brush: { size: 12, hardness: 0.5 },
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ layerId: id, channel: 'pixels', bounds: expect.any(Object) });
    expect(pixel(c, id, 80, 10)).toEqual([0x12, 0x34, 0x56, 255]);
    const fill = await registry.callTool('fill_pixels', { color: '#ffffff', useSelection: false });
    expect(fill.structuredContent).toMatchObject({ bounds: { x: 0, y: 0, width: W, height: H } });
    expect((await registry.callTool('clear_pixels', { useSelection: false })).isError).toBeFalsy();
    expect(pixel(c, id, 80, 10)[3]).toBe(0);
    for (const [args, pattern] of [
      [{ points: [] }, /fewer than 1|Invalid arguments/],
      [{ points: [{ x: 1 }] }, /Invalid arguments|required/],
      [{ points: [{ x: 1, y: 1 }], brush: { size: 0 } }, /Invalid arguments|minimum/],
      [{ points: [{ x: 1, y: 1 }], layerId: 'nope' }, /Unknown layer "nope"/],
      [{ points: [{ x: 1, y: 1 }], channel: 'mask' }, /no mask/],
      [{ points: [{ x: 1, y: 1 }], color: 'blue' }, /Invalid colour/],
    ] as const) {
      const res = await registry.callTool('paint_stroke', args as never);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(String((res.content?.[0] as { text?: string })?.text)).toMatch(pattern);
    }
  });
});
