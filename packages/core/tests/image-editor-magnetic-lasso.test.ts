import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  DEFAULT_SELECTION_TOOL_OPTIONS,
  EdgeMap,
  ImageEditorController,
  SelectionGesture,
  createImageEditorToolProvider,
  liveWire,
  selectionArea,
  snapPolygonToEdges,
  snapToEdge,
} from '../src/image-editor';

const W = 200;
const H = 160;
/** A dark disc of radius 50 at (100, 80) on a light ground, with a little noise. */
const CX = 100;
const CY = 80;
const R = 50;

function discPixels(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 9) - 4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - CX, y + 0.5 - CY);
      const v = (d < R ? 60 : 200) + noise();
      const p = (y * W + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels(discPixels());
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

/** Points on a circle of radius `r` around the disc. */
const ring = (r: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({ x: CX + r * Math.cos((i / n) * 2 * Math.PI), y: CY + r * Math.sin((i / n) * 2 * Math.PI) }));

describe('magnetic lasso', () => {
  it('snaps a point to the nearest strong edge within the width', () => {
    const map = new EdgeMap(discPixels());
    const p = snapToEdge(map, { x: CX + R + 6, y: CY }, 10);
    expect(Math.abs(p.x - (CX + R))).toBeLessThan(2);
    // Nothing that close: unchanged.
    expect(snapToEdge(map, { x: 5, y: 5 }, 10)).toEqual({ x: 5, y: 5 });
    // Edges below the contrast are ignored.
    expect(snapToEdge(new EdgeMap(discPixels(), { contrast: 0.9 }), { x: CX + R + 6, y: CY }, 10)).toEqual({ x: CX + R + 6, y: CY });
  });

  it('follows the curved edge between two points instead of the chord', () => {
    const map = new EdgeMap(discPixels());
    const a = { x: CX + R, y: CY };
    const b = { x: CX, y: CY + R };
    const path = liveWire(map, a, b);
    // Every point of the path lies on the circle, not across it.
    for (const p of path) expect(Math.abs(Math.hypot(p.x - CX, p.y - CY) - R)).toBeLessThan(2);
  });

  it('selects the disc from a rough ring of points through select_polygon', async () => {
    const { c, call, fails } = setup();
    const sel = await call('select_polygon', { points: ring(R + 6, 10), snapToEdges: { width: 10 } });
    const disc = Math.PI * R * R;
    expect(Math.abs(sel.area - disc) / disc).toBeLessThan(0.04);
    expect(sel.bounds.x).toBeGreaterThanOrEqual(CX - R - 2);
    expect(sel.bounds.width).toBeLessThanOrEqual(2 * R + 4);
    // Without snapping, the ring itself.
    const plain = await call('select_polygon', { points: ring(R + 6, 10) });
    expect(plain.area).toBeGreaterThan(disc * 1.15);
    c.undo();
    expect(Math.abs(selectionArea(c.getSelection()) - disc) / disc).toBeLessThan(0.04);
    await fails('select_polygon', { points: ring(R, 5), snapToEdges: { width: 0 } }, /width|minimum/);
    await fails('select_polygon', { points: ring(R, 5), snapToEdges: { contrast: 2 } }, /contrast|maximum/);
  });

  it('snaps polygons without the controller as well', () => {
    const outline = snapPolygonToEdges(discPixels(), ring(R - 5, 8), { width: 10 });
    for (const p of outline) expect(Math.abs(Math.hypot(p.x - CX, p.y - CY) - R)).toBeLessThan(2.5);
  });

  it('draws with the Magnetic Lasso tool: anchors as the pointer moves, a click on the start closes', async () => {
    const { c } = setup();
    const opts = { ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'magnetic' as const, magneticWidth: 10, magneticFrequency: 57 };
    const g = new SelectionGesture(c, () => opts);
    const pts = ring(R + 4, 72);
    await g.begin(pts[0]);
    expect(g.active).toBe(true);
    for (let i = 1; i < pts.length; i++) g.move(pts[i]);
    // Anchors were placed along the way, and the draft runs along the edge.
    expect(g.magneticAnchors.length).toBeGreaterThan(3);
    for (const p of g.draftPath!) expect(Math.abs(Math.hypot(p.x - CX, p.y - CY) - R)).toBeLessThan(2.5);
    // Backspace drops the last anchor; a click near the first closes.
    const anchors = g.magneticAnchors.length;
    expect(g.key('Backspace')).toBe(true);
    expect(g.magneticAnchors.length).toBe(anchors - 1);
    await g.begin(pts[0]);
    expect(g.active).toBe(false);
    const disc = Math.PI * R * R;
    expect(Math.abs(selectionArea(c.getSelection()) - disc) / disc).toBeLessThan(0.04);
    // Escape abandons one.
    await g.begin(pts[0]);
    g.move(pts[5]);
    expect(g.key('Escape')).toBe(true);
    expect(g.active).toBe(false);
  });

  it('reports when the pixels cannot be read', async () => {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    const g = new SelectionGesture(c, () => ({ ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'magnetic' }));
    await g.begin({ x: 10, y: 10 });
    expect(g.error).toMatch(/pixels/);
    expect(g.active).toBe(false);
  });
});
