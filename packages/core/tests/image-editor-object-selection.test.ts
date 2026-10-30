import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ColorGmm,
  DEFAULT_SELECTION_TOOL_OPTIONS,
  ImageEditorController,
  SelectionGesture,
  createImageEditorToolProvider,
  imagePlaybackPanel,
  selectObjectIn,
  selectionArea,
  selectionValueAt,
} from '../src/image-editor';

const W = 300;
const H = 200;
/** An ellipse at (150, 100), 70 × 55 px half-axes, in red and yellow stripes. */
const inObject = (x: number, y: number) => ((x - 150) / 70) ** 2 + ((y - 100) / 55) ** 2 < 1;
const AREA = Math.PI * 70 * 55;

/** The striped object on a background of blue and green blotches, with noise. */
function scene() {
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 5;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 15) - 7;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c: number[];
      if (inObject(x + 0.5, y + 0.5)) c = Math.floor(y / 12) % 2 ? [220, 50, 40] : [230, 200, 60];
      else c = Math.sin(x / 17) + Math.cos(y / 13) > 0 ? [50, 90, 180] : [60, 160, 80];
      const p = (y * W + x) * 4;
      data[p] = c[0] + noise();
      data[p + 1] = c[1] + noise();
      data[p + 2] = c[2] + noise();
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels(scene());
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

/** Pixels where the selection disagrees with the object by more than half. */
function wrong(sel: ReturnType<typeof selectObjectIn>) {
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((selectionValueAt(sel, x, y) >= 0.5) !== inObject(x + 0.5, y + 0.5)) n++;
  return n;
}

describe('colour mixtures', () => {
  it('cost less for colours they were fitted to', () => {
    const rgb = new Float32Array([200, 40, 40, 205, 45, 38, 30, 200, 60, 28, 195, 66]);
    const g = new ColorGmm();
    g.fit(rgb, [0, 1, 2, 3], new Uint8Array([0, 0, 1, 1]));
    expect(g.cost(202, 42, 40)).toBeLessThan(g.cost(40, 40, 200));
    expect(g.nearest(30, 198, 62)).toBe(1);
  });
});

describe('object selection', () => {
  it('cuts a two-coloured object out of a box on a busy background', () => {
    const sel = selectObjectIn(scene(), { rect: { x: 70, y: 35, width: 160, height: 130 } });
    expect(Math.abs(selectionArea(sel) - AREA) / AREA).toBeLessThan(0.05);
    expect(wrong(sel)).toBeLessThan(AREA * 0.05);
  });

  it('finds the object under a click', () => {
    const sel = selectObjectIn(scene(), { point: { x: 150, y: 100 } });
    expect(Math.abs(selectionArea(sel) - AREA) / AREA).toBeLessThan(0.08);
    expect(selectionValueAt(sel, 10, 10)).toBe(0);
  });

  it('selects through select_object by box or point, combined by mode, in one undo step', async () => {
    const { c, call, fails } = setup();
    const boxed = await call('select_object', { rect: { x: 70, y: 35, width: 160, height: 130 } });
    expect(Math.abs(boxed.area - AREA) / AREA).toBeLessThan(0.05);
    expect(boxed.bounds.x).toBeGreaterThanOrEqual(76);
    await call('select_rect', { x: 0, y: 0, width: 300, height: 200 });
    const cut = await call('select_object', { point: { x: 150, y: 100 }, mode: 'subtract' });
    expect(Math.abs(cut.area - (W * H - AREA)) / (W * H - AREA)).toBeLessThan(0.05);
    c.undo();
    expect(selectionArea(c.getSelection())).toBe(W * H);
    await fails('select_object', {}, /Pass rect .* or point/);
    await fails('select_object', { rect: { x: 0, y: 0, width: 10, height: 10 }, point: { x: 1, y: 1 } }, /not both/);
    await fails('select_object', { point: { x: 500, y: 10 } }, /outside the image/);
    await fails('select_object', { rect: { x: 400, y: 300, width: 10, height: 10 } }, /outside the image/);
  });

  it('draws a box or clicks with the Object Selection tool', async () => {
    const { c } = setup();
    const opts = { ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'object' as const };
    const g = new SelectionGesture(c, () => opts);
    await g.begin({ x: 70, y: 35 });
    g.move({ x: 230, y: 165 });
    expect(g.draftPath).toHaveLength(4);
    g.end({ x: 230, y: 165 });
    await g.settled;
    expect(Math.abs(selectionArea(c.getSelection()) - AREA) / AREA).toBeLessThan(0.05);
    c.deselect();
    await g.begin({ x: 150, y: 100 });
    g.end({ x: 150, y: 100 });
    await g.settled;
    expect(Math.abs(selectionArea(c.getSelection()) - AREA) / AREA).toBeLessThan(0.08);
    expect(imagePlaybackPanel('select_object')).toBe('select');
  });
});
