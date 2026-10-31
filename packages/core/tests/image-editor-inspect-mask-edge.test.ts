import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, MASK_EDGE_THRESHOLDS, createImageEditorToolProvider, createSelectionMask, inspectMaskEdge } from '../src/image-editor';

const W = 160;
const H = 120;
const CX = 80;
const CY = 60;
const R = 30;

/** A dark disc (radius 30 at 80,60) on a light background. */
function discPixels(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = Math.hypot(x + 0.5 - CX, y + 0.5 - CY) <= R;
      data.set(inside ? [40, 60, 160, 255] : [235, 225, 200, 255], i);
    }
  }
  return data;
}

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: discPixels() });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await registry.callTool(name, args);
    if (res.isError) throw new Error(String((res.content?.[0] as { text?: string })?.text ?? 'tool error'));
    return res.structuredContent as Record<string, any>;
  };
  const fails = async (name: string, args: Record<string, unknown>, pattern: RegExp) => {
    const res = await registry.callTool(name, args);
    expect(res.isError, `${name} should fail`).toBe(true);
    expect(String((res.content?.[0] as { text?: string })?.text)).toMatch(pattern);
  };
  return { c, call, fails };
}

const disc = (grow = 0) => ({ x: CX - R - grow, y: CY - R - grow, width: 2 * (R + grow), height: 2 * (R + grow) });

describe('inspect_mask_edge', () => {
  it('passes a selection that follows the subject', async () => {
    const { call } = setup();
    await call('select_ellipse', disc());
    const r = await call('inspect_mask_edge');
    expect(r.target).toBe('selection');
    expect(r.haloScore).toBeLessThan(MASK_EDGE_THRESHOLDS.halo);
    expect(r.edgeAlignment).toBeGreaterThan(0.9);
    expect(r.jaggedness).toBeLessThan(MASK_EDGE_THRESHOLDS.jaggedness);
    expect(r.softFraction).toBeGreaterThan(0);
    expect(r.softFraction).toBeLessThan(MASK_EDGE_THRESHOLDS.soft);
    expect(r.holes.count).toBe(0);
    expect(r.islands.count).toBe(0);
    expect(r.issues).toEqual([]);
    expect(r.edgeLength).toBeGreaterThan(100);
    expect(r.area).toBeGreaterThan(2500);
  });

  it('reports a halo when the selection leaks onto the background', async () => {
    const { call } = setup();
    await call('select_ellipse', disc(3));
    const r = await call('inspect_mask_edge');
    expect(r.haloScore).toBeGreaterThanOrEqual(MASK_EDGE_THRESHOLDS.halo);
    expect(r.issues.some((s: string) => s.startsWith('Halo'))).toBe(true);
    expect(r.worst.length).toBeGreaterThan(0);
    expect(r.worst[0].reason).toMatch(/halo|alignment/);
  });

  it('reports an edge that does not follow the image', async () => {
    const { call } = setup();
    await call('select_rect', { x: 5, y: 5, width: 30, height: 20 });
    const r = await call('inspect_mask_edge');
    expect(r.edgeAlignment).toBeLessThan(MASK_EDGE_THRESHOLDS.alignment);
    expect(r.issues.some((s: string) => s.startsWith('Off the image'))).toBe(true);
    for (const w of r.worst) {
      expect(w.bounds.x).toBeGreaterThanOrEqual(0);
      expect(w.bounds.y + w.bounds.height).toBeLessThanOrEqual(H);
    }
  });

  it('tells a jagged outline from a smooth one', async () => {
    const { call } = setup();
    const zigzag = Array.from({ length: 48 }, (_, i) => {
      const t = (i / 48) * Math.PI * 2;
      const r = R + (i % 2 ? 4 : -4);
      return { x: CX + r * Math.cos(t), y: CY + r * Math.sin(t) };
    });
    await call('select_polygon', { points: zigzag });
    const jagged = await call('inspect_mask_edge');
    expect(jagged.jaggedness).toBeGreaterThanOrEqual(MASK_EDGE_THRESHOLDS.jaggedness);
    expect(jagged.issues.some((s: string) => s.startsWith('Jagged'))).toBe(true);
    await call('select_ellipse', { x: 10, y: 10, width: 140, height: 100 });
    expect((await call('inspect_mask_edge')).jaggedness).toBeLessThan(MASK_EDGE_THRESHOLDS.jaggedness);
  });

  it('counts holes and islands above minArea', async () => {
    const { call } = setup();
    await call('select_ellipse', disc());
    await call('select_rect', { x: 75, y: 55, width: 6, height: 6, mode: 'subtract' });
    await call('select_rect', { x: 140, y: 100, width: 8, height: 8, mode: 'add' });
    await call('select_rect', { x: 5, y: 5, width: 2, height: 2, mode: 'add' });
    const r = await call('inspect_mask_edge');
    expect(r.holes.count).toBe(1);
    expect(r.holes.largest[0].area).toBe(36);
    expect(r.holes.largest[0].bounds).toEqual({ x: 75, y: 55, width: 6, height: 6 });
    expect(r.islands.count).toBe(1);
    expect(r.islands.largest[0].bounds).toEqual({ x: 140, y: 100, width: 8, height: 8 });
    expect(r.issues.some((s: string) => s.includes('hole'))).toBe(true);
    expect(r.issues.some((s: string) => s.includes('island'))).toBe(true);
    // The 2×2 speck counts once minArea allows it.
    expect((await call('inspect_mask_edge', { minArea: 4 })).islands.count).toBe(2);
  });

  it('inspects layer masks against the layer’s own pixels, and vector masks', async () => {
    const { c, call } = setup();
    const id = c.getLayers()[0].id;
    await call('select_ellipse', disc());
    await call('add_layer_mask', { layerId: id, from: 'selection' });
    await call('deselect');
    const m = await call('inspect_mask_edge', { target: 'layer-mask', layerId: id });
    expect(m).toMatchObject({ target: 'layer-mask', layerId: id });
    expect(m.edgeAlignment).toBeGreaterThan(0.9);
    c.addVectorMask(id, 'path', { shape: { kind: 'rect', x: 20, y: 20, width: 40, height: 30 } });
    const v = await call('inspect_mask_edge', { target: 'vector-mask', layerId: id });
    expect(v.bounds).toMatchObject({ x: 20, y: 20, width: 40, height: 30 });
  });

  it('fails usefully', async () => {
    const { c, call, fails } = setup();
    await fails('inspect_mask_edge', {}, /Nothing is selected/);
    await fails('inspect_mask_edge', { target: 'layer-mask' }, /needs layerId/);
    await fails('inspect_mask_edge', { target: 'layer-mask', layerId: 'nope' }, /no layer "nope"/);
    const id = c.getLayers()[0].id;
    await fails('inspect_mask_edge', { target: 'layer-mask', layerId: id }, /no painted mask/);
    await fails('inspect_mask_edge', { target: 'vector-mask', layerId: id }, /no vector mask/);
    await call('select_all');
    await fails('inspect_mask_edge', { layerId: id }, /only for target layer-mask/);
    await fails('inspect_mask_edge', { target: 'hybrid' }, /target/);
  });

  it('is a pure function over a mask and pixels', () => {
    const data = new Uint8Array(W * H);
    for (let y = 40; y < 80; y++) data.fill(255, y * W + 60, y * W + 100);
    const r = inspectMaskEdge(createSelectionMask(W, H, data), { x: 0, y: 0, width: W, height: H, data: discPixels() });
    expect(r.bounds).toEqual({ x: 60, y: 40, width: 40, height: 40 });
    expect(r.softFraction).toBe(0);
    expect(r.jaggedness).toBeLessThan(MASK_EDGE_THRESHOLDS.jaggedness);
    expect(() => inspectMaskEdge(createSelectionMask(W, H), { x: 0, y: 0, width: W, height: H, data: discPixels() })).toThrow(/empty/);
  });
});
