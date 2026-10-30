import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  DEFAULT_SELECTION_TOOL_OPTIONS,
  GridGraph,
  ImageEditorController,
  SelectionGesture,
  createImageEditorToolProvider,
  imagePlaybackPanel,
  quickSelectStroke,
  selectionArea,
  selectionValueAt,
} from '../src/image-editor';

/** A w × h image: a disc of radius r at (cx, cy) in `inner` on `outer`, with a little noise. */
function disc(w: number, h: number, cx: number, cy: number, r: number, inner = [200, 40, 40], outer = [60, 150, 70]) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 3;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 13) - 6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) < r ? inner : outer;
      const p = (y * w + x) * 4;
      data[p] = c[0] + noise();
      data[p + 1] = c[1] + noise();
      data[p + 2] = c[2] + noise();
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe('grid max-flow', () => {
  it('finds a cut whose cost equals the flow on random grids', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 1000) / 100;
    for (let trial = 0; trial < 20; trial++) {
      const w = 3 + (trial % 5);
      const h = 2 + (trial % 4);
      const g = new GridGraph(w, h);
      const caps: [number, number, number][] = [];
      const tr: number[] = [];
      for (let p = 0; p < w * h; p++) {
        const s = rnd();
        const t = rnd();
        g.addTerminal(p, s, t);
        tr.push(s - t);
        if ((p % w) + 1 < w) {
          const c = rnd();
          g.setEdge(p, 0, c);
          caps.push([p, p + 1, c]);
        }
        if (p + w < w * h) {
          const c = rnd();
          g.setEdge(p, 1, c);
          caps.push([p, p + w, c]);
        }
      }
      const flow = g.maxflow();
      let cut = 0;
      for (let p = 0; p < w * h; p++) cut += g.inSource(p) ? Math.max(0, -tr[p]) : Math.max(0, tr[p]);
      for (const [p, q, c] of caps) if (g.inSource(p) !== g.inSource(q)) cut += c;
      expect(cut).toBeCloseTo(flow, 6);
      // No labelling is cheaper: check every one on the small grids.
      if (w * h <= 12) {
        let best = Infinity;
        for (let m = 0; m < 1 << (w * h); m++) {
          let c = 0;
          for (let p = 0; p < w * h; p++) c += m & (1 << p) ? Math.max(0, -tr[p]) : Math.max(0, tr[p]);
          for (const [p, q, e] of caps) if (Boolean(m & (1 << p)) !== Boolean(m & (1 << q))) c += e;
          best = Math.min(best, c);
        }
        expect(flow).toBeCloseTo(best, 6);
      }
    }
  });
});

describe('quick selection', () => {
  it('grows a stroke inside a disc out to its edge', () => {
    const px = disc(240, 180, 120, 90, 50);
    const sel = quickSelectStroke(px, [{ x: 110, y: 90 }, { x: 130, y: 92 }], { size: 10 });
    const area = Math.PI * 50 * 50;
    expect(Math.abs(selectionArea(sel) - area) / area).toBeLessThan(0.05);
    expect(selectionValueAt(sel, 120, 50)).toBe(1);
    expect(selectionValueAt(sel, 20, 20)).toBe(0);
  });

  it('selects the background around the disc from a stroke on it', () => {
    const px = disc(240, 180, 120, 90, 50);
    const sel = quickSelectStroke(px, [{ x: 20, y: 20 }, { x: 40, y: 25 }], { size: 10 });
    const area = 240 * 180 - Math.PI * 50 * 50;
    expect(Math.abs(selectionArea(sel) - area) / area).toBeLessThan(0.05);
    expect(selectionValueAt(sel, 120, 90)).toBe(0);
  });

  it('works on a reduced copy of a large image and anti-aliases the edge at full size', () => {
    const px = disc(2000, 1500, 1000, 750, 400);
    const sel = quickSelectStroke(px, [{ x: 950, y: 750 }, { x: 1050, y: 760 }], { size: 60 });
    const area = Math.PI * 400 * 400;
    expect(Math.abs(selectionArea(sel) - area) / area).toBeLessThan(0.02);
    // The edge lands within a couple of pixels of the disc's, though the cut ran at a quarter size.
    let soft = 0;
    for (let x = 1390; x < 1410; x++) {
      const v = selectionValueAt(sel, x, 750) * 255;
      if (v > 0 && v < 255) soft++;
      if (x < 1397) expect(v, `x ${x}`).toBeGreaterThan(127);
      if (x > 1402) expect(v, `x ${x}`).toBeLessThan(128);
    }
    expect(soft).toBeLessThanOrEqual(4);
  });
});

function setup() {
  const W = 240;
  const H = 180;
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  // Two discs: a red one at (70, 90) and a blue one at (180, 90).
  const px = disc(W, H, 70, 90, 40);
  const blue = disc(W, H, 180, 90, 35, [40, 60, 210]);
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    if (x >= 125) for (let k = 0; k < 4; k++) px.data[i * 4 + k] = blue.data[i * 4 + k];
  }
  c.setSamplePixels(px);
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

const RED = Math.PI * 40 * 40;
const BLUE = Math.PI * 35 * 35;

describe('quick_select', () => {
  it('selects a disc, adds the other with a second stroke, and takes one undo step', async () => {
    const { c, call, fails } = setup();
    const one = await call('quick_select', { strokes: [[{ x: 60, y: 90 }, { x: 80, y: 90 }]], size: 8 });
    expect(Math.abs(one.area - RED) / RED).toBeLessThan(0.06);
    expect(one.bounds.x).toBeGreaterThanOrEqual(28);
    const both = await call('quick_select', { strokes: [[{ x: 60, y: 90 }], [{ x: 175, y: 90 }, { x: 185, y: 95 }]], size: 8 });
    expect(Math.abs(both.area - RED - BLUE) / (RED + BLUE)).toBeLessThan(0.06);
    c.undo();
    expect(Math.abs(selectionArea(c.getSelection()) - RED) / RED).toBeLessThan(0.06);
    const cut = await call('quick_select', { strokes: [[{ x: 70, y: 90 }]], size: 8, mode: 'subtract' });
    expect(cut.empty).toBe(true);
    const smooth = await call('quick_select', { strokes: [[{ x: 175, y: 90 }]], size: 8, enhanceEdge: true });
    expect(Math.abs(smooth.area - BLUE) / BLUE).toBeLessThan(0.06);
    await fails('quick_select', { strokes: [] }, /strokes|minItems/);
    await fails('quick_select', { strokes: [[{ x: 900, y: 900 }]] }, /entirely outside the image/);
    await fails('quick_select', { strokes: [[{ x: 10, y: 10 }]], size: 0 }, /size|minimum/);
  });

  it('paints with the Quick Selection brush: a stroke selects, the next adds, Alt subtracts', async () => {
    const { c } = setup();
    const opts = { ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'quick' as const, quickSize: 8 };
    const g = new SelectionGesture(c, () => opts);
    await g.begin({ x: 60, y: 90 });
    g.move({ x: 80, y: 92 });
    expect(g.draftPath).toHaveLength(2);
    g.end({ x: 80, y: 92 });
    await g.settled;
    expect(Math.abs(selectionArea(c.getSelection()) - RED) / RED).toBeLessThan(0.06);
    // New mode with a selection already there adds.
    await g.begin({ x: 180, y: 90 });
    g.end();
    await g.settled;
    expect(Math.abs(selectionArea(c.getSelection()) - RED - BLUE) / (RED + BLUE)).toBeLessThan(0.06);
    await g.begin({ x: 180, y: 90 }, { altKey: true });
    g.end(undefined, { altKey: true });
    await g.settled;
    expect(Math.abs(selectionArea(c.getSelection()) - RED) / RED).toBeLessThan(0.06);
  });

  it('reports when the pixels cannot be read, and plays back on the Select panel', async () => {
    const fake = { width: 50, height: 50, naturalWidth: 50, naturalHeight: 50, src: 'data:fake' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    const g = new SelectionGesture(c, () => ({ ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'quick' }));
    await g.begin({ x: 10, y: 10 });
    g.end();
    await g.settled;
    expect(g.error).toMatch(/pixels/);
    expect(imagePlaybackPanel('quick_select')).toBe('select');
  });
});
