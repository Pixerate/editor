import { describe, expect, it } from 'vitest';
import {
  BRUSH_SLIDERS,
  PAPER_SLIDERS,
  PaintCanvasPresenter,
  PaintEditorController,
  PaintGesture,
  guideOverlay,
  handlePaintShortcut,
  patchPath,
  readPath,
  wheelAngle,
  wheelPoint,
  type PaintPointerEvent,
} from '../src/paint-editor';

const BOX = { left: 0, top: 0, width: 200, height: 100 };
const ev = (x: number, y: number, extra: Partial<PaintPointerEvent> = {}): PaintPointerEvent => ({ pointerId: 1, clientX: x, clientY: y, pointerType: 'mouse', button: 0, ...extra });

function setup() {
  // The canvas equals the viewport at zoom 1, so screen = document pixels.
  const c = new PaintEditorController({ width: 200, height: 100, paper: 'smooth' });
  return { c, g: new PaintGesture(c, () => BOX) };
}

describe('PaintGesture', () => {
  it('paints a stroke from pointer events, with coalesced samples and a predicted tail', () => {
    const { c, g } = setup();
    c.setBrush({ id: 'ink-pen' });
    expect(g.down(ev(10, 50))).toBe(true);
    expect(c.getState().stroking).toBe(true);
    g.move(ev(60, 50, { getCoalescedEvents: () => [ev(30, 50), ev(45, 50), ev(60, 50)], getPredictedEvents: () => [ev(80, 50)] }));
    expect(g.predicted).toEqual([{ x: 80, y: 50, pressure: 1 }]);
    g.up(ev(60, 50));
    expect(g.predicted).toEqual([]);
    expect(c.getState().stroking).toBe(false);
    expect(c.getStrokes()[0].points.map((p) => p.x)).toEqual([10, 30, 45, 60]);
  });

  it('reads pen pressure and tilt through the view', () => {
    const { c, g } = setup();
    g.down(ev(10, 10, { pointerType: 'pen', pressure: 0.4, tiltX: 30, tiltY: 0 }));
    g.up(ev(10, 10, { pointerType: 'pen', pressure: 0 }));
    const p = c.getStrokes()[0].points[0];
    expect(p.pressure).toBe(0.4);
    expect(p.altitude).toBeLessThan(Math.PI / 2);
  });

  it('rejects the palm while a pen is down and reports refusals', () => {
    const { c, g } = setup();
    expect(g.down(ev(50, 50, { pointerType: 'pen', pointerId: 2 }))).toBe(true);
    expect(g.down(ev(80, 80, { pointerType: 'touch', pointerId: 3 }))).toBe(false);
    g.up(ev(50, 50, { pointerType: 'pen', pointerId: 2 }));
    c.updateLayer(c.document.activeLayerId!, { visible: false });
    expect(g.down(ev(10, 10))).toBe(false);
    expect(g.error).toMatch(/hidden/);
  });

  it('pans, rotates, zooms about the pointer and picks colours', () => {
    const { c, g } = setup();
    g.tool = 'pan';
    g.down(ev(10, 10));
    g.move(ev(30, 25));
    g.up(ev(30, 25));
    expect(c.getState().view.pan).toEqual({ x: 20, y: 15 });
    c.resetView();
    g.tool = 'rotate';
    g.down(ev(200, 50));
    g.move(ev(100, 100));
    g.up(ev(100, 100));
    expect(c.getState().view.rotation).toBeCloseTo(90, 6);
    c.resetView();
    g.wheel({ clientX: 100, clientY: 50, deltaY: -200 });
    expect(c.getState().view.zoom).toBeGreaterThan(1);
    expect(c.getState().view.pan).toEqual({ x: 0, y: 0 });
    g.wheel({ clientX: 100, clientY: 50, deltaY: 100, shiftKey: true });
    expect(c.getState().view.rotation).toBe(5);
    c.resetView();
    c.fillLayer({ color: '#ff8800' });
    g.tool = 'eyedropper';
    g.down(ev(5, 5));
    expect(c.getState().color).toBe('#ff8800');
    // Middle button pans whatever the tool.
    g.tool = 'brush';
    expect(g.down(ev(5, 5, { button: 1 }))).toBe(true);
    g.cancel();
    expect(g.active).toBe(false);
  });

  it('shortcuts: tools, undo / redo, brush size, swap, mirror', () => {
    const { c, g } = setup();
    c.paintStroke({ points: [{ x: 5, y: 5 }] });
    expect(handlePaintShortcut(c, g, { key: 'z', metaKey: true })).toBe(true);
    expect(c.getStrokes()).toHaveLength(0);
    handlePaintShortcut(c, g, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(c.getStrokes()).toHaveLength(1);
    handlePaintShortcut(c, g, { key: 'i' });
    expect(g.tool).toBe('eyedropper');
    const size = c.getState().brush.tip.size;
    handlePaintShortcut(c, g, { key: ']' });
    expect(c.getState().brush.tip.size).toBeGreaterThan(size);
    handlePaintShortcut(c, g, { key: 'm' });
    expect(c.getState().view.mirror).toBe(true);
    handlePaintShortcut(c, g, { key: 'x' });
    expect(c.getState().color).toBe('#ffffff');
    expect(handlePaintShortcut(c, g, { key: 'q' })).toBe(false);
  });
});

describe('PaintCanvasPresenter', () => {
  it('uploads every tile once, then only the tiles a stroke changed', () => {
    const c = new PaintEditorController({ width: 600, height: 300, paper: 'smooth' });
    const puts: Array<[number, number, number, number]> = [];
    const ctx = {
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (_img: never, dx: number, dy: number, _sx?: number, _sy?: number, sw?: number, sh?: number) => puts.push([dx, dy, sw!, sh!]),
    };
    const p = new PaintCanvasPresenter(c);
    expect(p.render(ctx)).toBe(6);
    expect(puts).toContainEqual([512, 256, 88, 44]);
    expect(p.render(ctx)).toBe(0);
    c.paintStroke({ points: [{ x: 10, y: 10 }, { x: 40, y: 10 }], brushId: 'ink-pen' });
    expect(p.render(ctx)).toBe(1);
  });
});

describe('panel helpers', () => {
  it('reads and patches brush and paper settings by path', () => {
    const c = new PaintEditorController();
    const b = c.getState().brush;
    for (const s of BRUSH_SLIDERS) expect(typeof readPath(b, s.path)).toBe('number');
    for (const s of PAPER_SLIDERS) expect(readPath(c.document.paper, s.path)).toBeGreaterThanOrEqual(0);
    c.setBrush(patchPath(b as never, 'tip.size', 33) as never);
    expect(c.getState().brush.tip.size).toBe(33);
    expect(c.getState().brush.tip.hardness).toBe(b.tip.hardness);
    expect(patchPath({ dry: { contrast: 1, invert: true } }, 'dry.contrast', 2)).toEqual({ dry: { contrast: 2, invert: true } });
  });

  it('wheel geometry round-trips, red at the top', () => {
    const p = wheelPoint(0, 10);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(-10, 6);
    for (const a of [0, 90, 200, 359]) {
      const q = wheelPoint(a, 5);
      expect(wheelAngle(q.x, q.y)).toBeCloseTo(a, 6);
    }
  });

  it('guide overlay lines', () => {
    const c = new PaintEditorController({ width: 100, height: 80 });
    expect(guideOverlay(c)).toEqual([]);
    c.setSymmetry({ mode: 'dual' });
    c.setPerspective({ enabled: true, points: [{ x: 50, y: -100 }] });
    const lines = guideOverlay(c);
    expect(lines.filter((l) => l.kind === 'symmetry')).toHaveLength(2);
    expect(lines.filter((l) => l.kind === 'perspective')).toHaveLength(16);
  });
});
