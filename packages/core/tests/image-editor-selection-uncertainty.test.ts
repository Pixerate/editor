import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, createSelectionMask, selectionUncertainty } from '../src/image-editor';

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
      const inside = Math.hypot(x + 0.5 - CX, y + 0.5 - CY) <= R;
      data.set(inside ? [40, 60, 160, 255] : [235, 225, 200, 255], (y * W + x) * 4);
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

describe('selection uncertainty (trimap)', () => {
  it('finds nothing uncertain where the edge follows the image', () => {
    const { c } = setup();
    c.selectEllipse({ x: CX - R, y: CY - R, width: 2 * R, height: 2 * R });
    const u = c.selectionUncertainty();
    expect(u.count).toBe(0);
    expect(u.regions).toEqual([]);
    expect(u.confidence).toBeGreaterThan(0.9);
    expect(u.unknown.bounds).toBeNull();
  });

  it('marks the stretch of edge with no image edge under it, least confident first', () => {
    const { c } = setup();
    // The disc's left half: its straight right side cuts through the disc.
    c.selectEllipse({ x: CX - R, y: CY - R, width: 2 * R, height: 2 * R });
    c.selectRect({ x: CX, y: 0, width: W - CX, height: H }, { mode: 'subtract' });
    const u = c.selectionUncertainty({ band: 3 });
    expect(u.count).toBeGreaterThanOrEqual(1);
    const [worst] = u.regions;
    expect(worst.confidence).toBeLessThan(0.5);
    expect(worst.bounds.x).toBeLessThanOrEqual(CX);
    expect(worst.bounds.x + worst.bounds.width).toBeGreaterThanOrEqual(CX);
    expect(worst.bounds.height).toBeGreaterThan(R);
    // The unknown band covers the cut, not the curved side.
    expect(u.unknown.data[CY * W + CX - 1]).toBe(255);
    expect(u.unknown.data[CY * W + CX - R]).toBe(0);
    expect(u.confidence).toBeLessThan(0.9);
  });

  it('is empty for an empty mask', () => {
    const u = selectionUncertainty(createSelectionMask(W, H), { x: 0, y: 0, width: W, height: H, data: discPixels() });
    expect(u).toMatchObject({ regions: [], count: 0, confidence: 1 });
  });

  it('comes back from the smart selection tools', async () => {
    const { call } = setup();
    const obj = await call('select_object', { rect: { x: CX - R - 10, y: CY - R - 10, width: 2 * R + 20, height: 2 * R + 20 } });
    expect(Array.isArray(obj.uncertainRegions)).toBe(true);
    expect(typeof obj.uncertainCount).toBe('number');
    expect(obj.edgeConfidence).toBeGreaterThan(0.5);
    const qs = await call('quick_select', { strokes: [[{ x: CX, y: CY }, { x: CX + 5, y: CY }]], size: 6 });
    expect(qs).toHaveProperty('uncertainRegions');
    expect(qs).toHaveProperty('edgeConfidence');
    const sky = await call('select_sky');
    expect(sky).toHaveProperty('uncertainRegions');
    const subject = await call('select_subject');
    expect(subject).toHaveProperty('uncertainRegions');
  });

  it('refines only inside regions', async () => {
    const { c, call } = setup();
    c.selectRect({ x: CX - R - 6, y: CY - R - 6, width: 2 * R + 12, height: 2 * R + 12 });
    const before = c.getSelection()!.data.slice();
    const region = { x: CX - R - 10, y: CY - 10, width: 20, height: 20 };
    await call('refine_selection', { radius: 12, contrast: 60, regions: [region] });
    const after = c.getSelection()!.data;
    let changedInside = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inside = x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
        if (!inside) expect(after[i], `outside at ${x},${y}`).toBe(before[i]);
        else if (after[i] !== before[i]) changedInside++;
      }
    }
    expect(changedInside).toBeGreaterThan(0);
  });

  it('rejects regions that miss the image', async () => {
    const { c, fails } = setup();
    c.selectRect({ x: 10, y: 10, width: 40, height: 40 });
    const before = c.getSelection();
    await fails('refine_selection', { regions: [{ x: 500, y: 500, width: 10, height: 10 }] }, /regions\[0\] must overlap the image/);
    await fails('refine_selection', { regions: [] }, /regions|minItems|at least/);
    expect(c.getSelection()).toBe(before);
  });
});
