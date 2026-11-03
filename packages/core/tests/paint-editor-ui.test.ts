import { describe, expect, it } from 'vitest';
import {
  BLEND_MENU_GROUPS,
  BUILTIN_BRUSHES,
  PAD_SAMPLE_SIZES,
  brushEngineControls,
  brushLoadColor,
  multiColorSliders,
  padSampleRadius,
  patchBrushValue,
  BLEND_MODES,
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
  it('the Select stroke tool picks a stroke of a stroke layer and drags it, one undo step at the drop', () => {
    const { c, g } = setup();
    g.tool = 'stroke';
    g.down(ev(50, 50));
    expect(g.error).toMatch(/Pick a stroke layer/);
    c.addLayer({ type: 'strokes' });
    c.paintStroke({ points: [{ x: 20, y: 50 }, { x: 90, y: 50 }], brushId: 'ink-pen', color: '#000000' });
    const [s] = c.listLiveStrokes();
    expect(g.down(ev(150, 90))).toBe(false);
    expect(c.getState().selectedStroke).toBeNull();
    expect(g.down(ev(50, 50))).toBe(true);
    expect(c.getState().selectedStroke).toBe(s.id);
    g.move(ev(70, 60));
    expect(g.strokeDrag).toEqual({ id: s.id, dx: 20, dy: 10 });
    const outline = guideOverlay(c, g.strokeDrag).filter((l) => l.kind === 'stroke');
    expect(outline).toHaveLength(4);
    expect(outline[0].from.x).toBe(c.liveStrokeArea(s.id)!.x + 20);
    g.up(ev(70, 60));
    expect(g.strokeDrag).toBeNull();
    expect(c.listLiveStrokes()[0].points[0]).toMatchObject({ x: 40, y: 60 });
    expect(c.getState().undoLabel).toBe('Edit stroke points');
    c.undo();
    expect(c.listLiveStrokes()[0].points[0]).toMatchObject({ x: 20, y: 50 });
  });

  it('the Stickers tool places, picks and drags stickers, each one undo step', () => {
    const { c, g } = setup();
    c.setBrush({ id: 'sticker-stars', tip: { size: 30 } });
    c.setColor('#2563eb');
    g.tool = 'sticker';
    // Pressing empty canvas places the brush's first stamp and picks it; nothing to drag.
    expect(g.down(ev(50, 50))).toBe(false);
    const [placed] = c.listStickers();
    expect(placed).toMatchObject({ stamp: c.getState().brush.sticker.stamps[0], x: 50, y: 50, size: 30, color: '#2563eb' });
    expect(c.getState().selectedSticker).toBe(placed.id);
    // Pressing a sticker picks it and dragging moves it; the drop is one undo step.
    c.selectSticker(null);
    expect(g.down(ev(52, 50))).toBe(true);
    expect(c.getState().selectedSticker).toBe(placed.id);
    g.move(ev(90, 60));
    g.move(ev(120, 70));
    expect(c.listStickers()[0]).toMatchObject({ x: 118, y: 70 });
    g.up(ev(120, 70));
    expect(c.listStickers()).toHaveLength(1);
    c.undo();
    expect(c.listStickers()[0]).toMatchObject({ x: 50, y: 50 });
    // A cancelled drag puts it back.
    g.down(ev(50, 50));
    g.move(ev(150, 50));
    g.cancel();
    expect(c.listStickers()[0]).toMatchObject({ x: 50, y: 50 });
    // A painted layer refuses placing, with the reason.
    c.addLayer();
    c.paintStroke({ points: [{ x: 10, y: 10 }, { x: 60, y: 30 }], brushId: 'pencil-hb' });
    g.down(ev(150, 80));
    expect(g.error).toMatch(/already has paint/);
  });

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
  it('describes each engine\'s controls, patches any brush value and reads the load', () => {
    const by = (id: string) => BUILTIN_BRUSHES.find((b) => b.id === id)!;
    expect(brushEngineControls(by('blender'))!.sliders.map((s) => s.path)).toEqual(['blender.strength', 'blender.distance']);
    expect(brushEngineControls(by('smudge'))).toMatchObject({ mixingPath: 'smudge.mixing', dirty: false, multicolor: false });
    expect(brushEngineControls(by('mixer-brush'))!.sliders.map((s) => s.path)).toEqual(['behavior.pickup', 'behavior.mix', 'mixer.load', 'light.amount']);
    expect(brushEngineControls(by('glow-gel'))!.sliders.map((s) => s.path).slice(-3)).toEqual(['light.amount', 'impasto.rim', 'impasto.clarity']);
    expect(brushEngineControls(by('blender'))!.light).toBeUndefined();
    expect(brushEngineControls(by('pencil-6b'))).toMatchObject({ mixingPath: 'behavior.mixing', dirty: true, multicolor: true, load: true });
    expect(brushEngineControls(by('eraser-soft'))).toBeNull();
    expect(multiColorSliders('off')).toEqual([]);
    expect(multiColorSliders('dab').map((s) => s.path)).toEqual(['behavior.multicolor.softness', 'behavior.multicolor.length']);
    const c = new PaintEditorController();
    const b = c.setBrush({ id: 'dirty-round' });
    c.setBrush(patchBrushValue(b, 'behavior.multicolor.mode', 'tip'));
    expect(c.getState().brush.behavior.multicolor.mode).toBe('tip');
    expect(c.getState().brush.behavior.pickup).toBe(b.behavior.pickup);
    c.setBrush(patchBrushValue(c.getState().brush, 'behavior.mixing', 'rgb'));
    expect(c.getState().brush.behavior.mixing).toBe('rgb');
    expect(brushLoadColor({ reservoir: [1, 0, 0], amount: 1, pickup: null })).toBe('#ff0000');
    expect(brushLoadColor({ reservoir: [1, 0, 0], amount: 1, pickup: [0, 0, 1] })).toBe('#0000ff');
    expect(brushLoadColor({ reservoir: null, amount: 0, pickup: null })).toBeNull();
    expect(PAD_SAMPLE_SIZES.map(padSampleRadius)).toEqual([0, 1, 2, 4, 7]);
  });

  it('groups the blend menu into standard and paint modes, every mode once', () => {
    expect(BLEND_MENU_GROUPS.map((g) => g.label)).toEqual(['Standard', 'Paint']);
    expect(BLEND_MENU_GROUPS[0].modes).toHaveLength(26);
    expect(BLEND_MENU_GROUPS[1].modes.map((m) => m.id)).toEqual(['pigment', 'watercolor', 'tint', 'highlight', 'shadow']);
    expect(BLEND_MENU_GROUPS.flatMap((g) => g.modes.map((m) => m.id)).sort()).toEqual(BLEND_MODES.map((m) => m.id).sort());
    for (const m of BLEND_MENU_GROUPS[1].modes) expect(m.description).toBeTruthy();
  });

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
