import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, applyRefineEdits, brushStrokeMask, createImageEditorToolProvider, selectionArea, selectionValueAt } from '../src/image-editor';

const W = 100;
const H = 60;

/** Dark on the left, bright on the right, with a soft ramp from x 40 to 60 (a fuzzy edge). */
function ramp() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = x < 40 ? 20 : x >= 60 ? 235 : 20 + ((x - 40) / 20) * 215;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data };
}

function setup(segment?: (req: any) => Promise<any[]>) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, segmentation: segment ? { segment } : null });
  vi.spyOn(c, 'toDataURL').mockResolvedValue('data:image/png;base64,AAAA');
  c.setSamplePixels(ramp());
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

describe('brush strokes', () => {
  it('cover a round brush along the path, soft with less hardness', () => {
    const hard = brushStrokeMask(W, H, [{ x: 20, y: 30 }, { x: 60, y: 30 }], 10);
    expect(selectionValueAt(hard, 40, 30)).toBe(1);
    expect(selectionValueAt(hard, 40, 36)).toBe(0);
    expect(Math.abs(selectionArea(hard) - (40 * 10 + Math.PI * 25)) / (40 * 10 + Math.PI * 25)).toBeLessThan(0.08);
    const soft = brushStrokeMask(W, H, [{ x: 50, y: 30 }], 20, 0);
    expect(selectionValueAt(soft, 50, 30)).toBeGreaterThan(0.9);
    expect(selectionValueAt(soft, 57, 30)).toBeLessThan(0.5);
  });

  it('apply in order: add, subtract, and the refine brush only marks', () => {
    const { selection, refineBrush } = applyRefineEdits(null, null, [
      { kind: 'brush', points: [{ x: 10, y: 10 }, { x: 50, y: 10 }], size: 10 },
      { kind: 'brush', points: [{ x: 30, y: 10 }], size: 10, mode: 'subtract' },
      { kind: 'refine-brush', points: [{ x: 80, y: 40 }], size: 10 },
    ], W, H);
    expect(selectionValueAt(selection!, 15, 10)).toBe(1);
    expect(selectionValueAt(selection!, 30, 10)).toBe(0);
    expect(selectionValueAt(selection!, 80, 40)).toBe(0);
    expect(selectionValueAt(refineBrush!, 80, 40)).toBe(1);
  });
});

describe('refine_selection edits', () => {
  it('paints a selection from nothing and outputs it, in one undo step', async () => {
    const { c, call, fails } = setup();
    await fails('refine_selection', {}, /Nothing is selected/);
    const out = await call('refine_selection', { radius: 0, edits: [{ kind: 'brush', points: [{ x: 10, y: 30 }, { x: 30, y: 30 }], size: 20 }] });
    expect(out).toMatchObject({ empty: false, refineMode: 'color' });
    expect(out.bounds.x).toBeGreaterThanOrEqual(0);
    c.undo();
    expect(c.getSelection()).toBeNull();
    await fails('refine_selection', { edits: [{ kind: 'brush', points: [{ x: 10, y: 30 }], mode: 'subtract' }] }, /leave nothing selected/);
    await fails('refine_selection', { edits: [{ kind: 'refine-brush', points: [{ x: 10, y: 30 }], mode: 'add' }] }, /no mode/);
    await fails('refine_selection', { edits: [{ kind: 'magic', points: [{ x: 10, y: 30 }] }] }, /kind|enum/);
    await fails('refine_selection', { edits: [{ kind: 'lasso', points: [{ x: 10, y: 30 }] }] }, /at least 3 points/);
    await fails('refine_selection', { edits: [{ kind: 'object' }] }, /rect .* or point/);
  });

  it('adds a lasso and the object in a box', async () => {
    const { c, call } = setup();
    const lasso = await call('refine_selection', { radius: 0, edits: [{ kind: 'lasso', points: [{ x: 5, y: 5 }, { x: 25, y: 5 }, { x: 25, y: 25 }, { x: 5, y: 25 }] }] });
    expect(lasso.bounds).toEqual({ x: 5, y: 5, width: 20, height: 20 });
    c.deselect();
    // The dark half of the ramp image is the object in a box around it.
    const obj = await call('refine_selection', { radius: 0, edits: [{ kind: 'object', rect: { x: 0, y: 0, width: 70, height: 60 } }] });
    expect(obj.bounds.x).toBe(0);
    expect(obj.bounds.x + obj.bounds.width).toBeLessThan(65);
  });

  it('grows a quick-select stroke to the dark side', async () => {
    const { call } = setup();
    const out = await call('refine_selection', { radius: 0, edits: [{ kind: 'quick-select', points: [{ x: 10, y: 30 }, { x: 25, y: 30 }], size: 8 }] });
    expect(out.bounds.x).toBe(0);
    expect(out.bounds.x + out.bounds.width).toBeGreaterThan(38);
    expect(out.bounds.x + out.bounds.width).toBeLessThan(62);
  });

  it('re-estimates the edge where the refine brush paints, not elsewhere', async () => {
    const { c, call } = setup();
    // A hard selection up to x 50, in the middle of the soft ramp.
    await call('select_rect', { x: 0, y: 0, width: 50, height: 60, antiAlias: false });
    await call('refine_selection', { radius: 0, edits: [{ kind: 'refine-brush', points: [{ x: 50, y: 10 }, { x: 50, y: 20 }], size: 24 }] });
    const sel = c.getSelection()!;
    const soft = (y: number) => {
      let n = 0;
      for (let x = 38; x < 62; x++) {
        const v = selectionValueAt(sel, x, y);
        if (v > 0.05 && v < 0.95) n++;
      }
      return n;
    };
    // Painted rows follow the ramp softly; unpainted rows keep the hard edge.
    expect(soft(15)).toBeGreaterThan(4);
    expect(soft(50)).toBe(0);
  });
});

describe('object aware refinement', () => {
  const square = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

  it('refines from the model outline, kept near the selection', async () => {
    const requests: any[] = [];
    const { c, call } = setup(async (req) => {
      requests.push(req);
      // The object is a 20 px square; the model also returns something far away.
      return [{ label: 'object', polygon: square(20, 20, 20) }, { label: 'far', polygon: square(80, 5, 10) }];
    });
    await call('select_rect', { x: 16, y: 16, width: 30, height: 30 });
    const out = await call('refine_selection', { radius: 0, refineMode: 'object' });
    expect(out.refineMode).toBe('object');
    expect(requests[0].box).toBeDefined();
    expect(c.getSelection()!.bounds).toEqual({ x: 20, y: 20, width: 20, height: 20 });
  });

  it('needs a model', async () => {
    const { call, fails } = setup();
    await call('select_rect', { x: 16, y: 16, width: 30, height: 30 });
    await fails('refine_selection', { refineMode: 'object' }, /needs a segmentation model/);
  });
});
