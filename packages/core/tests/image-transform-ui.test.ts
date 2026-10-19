import { describe, expect, it } from 'vitest';
import { FreeTransformTool, ImageEditorController, type PixelLayer } from '../src/image-editor';

const W = 200;
const H = 160;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const data = new Uint8ClampedArray(40 * 20 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
  const id = c.addPixelLayer({ name: 'Block', pixels: { width: 40, height: 20, data }, x: 50, y: 50 });
  let changes = 0;
  const tool = new FreeTransformTool(c, { onChange: () => changes++ });
  return { c, id, tool, changes: () => changes };
}

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

const drag = (tool: FreeTransformTool, from: { x: number; y: number }, to: { x: number; y: number }, m = {}) => {
  const h = tool.down(from, 3);
  tool.move(to, m);
  tool.up();
  return h;
};

describe('FreeTransformTool', () => {
  it('opens with Ctrl/Cmd+T and shows the frame, eight handles and the reference point', () => {
    const { tool, changes } = setup();
    expect(tool.key({ key: 't', metaKey: true })).toBe(true);
    expect(tool.active).toBe(true);
    const o = tool.overlay()!;
    expect(o.outline).toEqual([{ x: 50, y: 50 }, { x: 90, y: 50 }, { x: 90, y: 70 }, { x: 50, y: 70 }]);
    expect(o.handles.map((h) => h.id)).toEqual(['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w']);
    close(o.reference, { x: 70, y: 60 });
    expect(tool.hit({ x: 90, y: 70 }, 3)).toBe('se');
    expect(tool.hit({ x: 70, y: 60 }, 3)).toBe('reference');
    expect(tool.hit({ x: 60, y: 55 }, 3)).toBe('inside');
    expect(tool.hit({ x: 10, y: 10 }, 3)).toBe('outside');
    expect(tool.cursor('se')).toBe('nwse-resize');
    expect(changes()).toBeGreaterThan(0);
  });

  it('scales a corner proportionally, freely with Shift, and from the reference with Alt', () => {
    const { tool } = setup();
    tool.begin();
    drag(tool, { x: 90, y: 70 }, { x: 130, y: 75 });
    // Proportional: the larger factor (2 in x) wins, from the opposite corner.
    expect(tool.overlay()!.outline[2]).toEqual({ x: 130, y: 90 });
    tool.cancel();
    tool.begin();
    drag(tool, { x: 90, y: 70 }, { x: 130, y: 75 }, { shiftKey: true });
    expect(tool.overlay()!.outline[2]).toEqual({ x: 130, y: 75 });
    tool.cancel();
    tool.begin();
    drag(tool, { x: 90, y: 50 }, { x: 110, y: 40 }, { altKey: true, shiftKey: true });
    // About the centre: both sides move.
    const o = tool.overlay()!.outline;
    close(o[0], { x: 30, y: 40 });
    close(o[2], { x: 110, y: 80 });
    tool.cancel();
  });

  it('scales one axis from a side, moves from inside and rotates from outside in 15° steps with Shift', () => {
    const { tool } = setup();
    tool.begin();
    drag(tool, { x: 90, y: 60 }, { x: 110, y: 64 });
    expect(tool.overlay()!.outline).toEqual([{ x: 50, y: 50 }, { x: 110, y: 50 }, { x: 110, y: 70 }, { x: 50, y: 70 }]);
    drag(tool, { x: 60, y: 55 }, { x: 64, y: 70 }, { shiftKey: true });
    expect(tool.overlay()!.outline[0]).toEqual({ x: 50, y: 65 });
    tool.cancel();
    tool.begin();
    // Start right of the centre, end almost straight below it: about 87°, snapped to 90°.
    drag(tool, { x: 120, y: 60 }, { x: 72, y: 110 }, { shiftKey: true });
    const b = tool.bar()!;
    expect(b.rotate).toBeCloseTo(90, 6);
    tool.cancel();
  });

  it('distorts a corner with Ctrl/Cmd, skews a side, and puts corners in perspective', () => {
    const { tool } = setup();
    tool.begin();
    drag(tool, { x: 90, y: 70 }, { x: 100, y: 80 }, { ctrlKey: true });
    expect(tool.overlay()!.outline[2]).toEqual({ x: 100, y: 80 });
    expect(tool.bar()!.affine).toBe(false);
    tool.cancel();
    tool.begin();
    drag(tool, { x: 70, y: 50 }, { x: 80, y: 45 }, { metaKey: true });
    expect(tool.overlay()!.outline.slice(0, 2)).toEqual([{ x: 60, y: 50 }, { x: 100, y: 50 }]);
    tool.cancel();
    tool.begin();
    tool.setMode('perspective');
    drag(tool, { x: 50, y: 50 }, { x: 60, y: 52 });
    expect(tool.overlay()!.outline.slice(0, 2)).toEqual([{ x: 60, y: 50 }, { x: 80, y: 50 }]);
    tool.cancel();
  });

  it('types numbers in the options bar, keeping W and H together', () => {
    const { tool } = setup();
    tool.begin();
    tool.setReference('top-left');
    tool.setField('scaleX', 50);
    const b = tool.bar()!;
    expect(b.scaleX).toBe(50);
    expect(b.scaleY).toBeCloseTo(50, 6);
    expect(tool.overlay()!.outline[2]).toEqual({ x: 70, y: 60 });
    tool.setField('rotate', 90);
    close(tool.overlay()!.outline[1], { x: 50, y: 70 });
    tool.proportional = false;
    tool.setField('scaleY', 100);
    expect(tool.bar()!.scaleX).toBe(50);
    tool.cancel();
  });

  it('nudges with the arrows, commits with Enter as one undo step and cancels with Escape', () => {
    const { c, id, tool } = setup();
    const before = (c.getLayer(id) as PixelLayer).surface;
    tool.begin();
    expect(tool.key({ key: 'ArrowRight', shiftKey: true })).toBe(true);
    expect(tool.key({ key: 'Escape' })).toBe(true);
    expect(tool.active).toBe(false);
    expect((c.getLayer(id) as PixelLayer).surface).toBe(before);
    tool.begin();
    tool.key({ key: 'ArrowDown' });
    drag(tool, { x: 90, y: 71 }, { x: 130, y: 91 });
    tool.setInterpolation('nearest');
    expect(tool.interpolation).toBe('nearest');
    expect(tool.key({ key: 'Enter' })).toBe(true);
    expect(tool.active).toBe(false);
    expect(tool.lastResult).toMatchObject({ changed: true, bounds: { x: 50, y: 51, width: 80, height: 40 } });
    expect(c.getLayerBounds(id)).toEqual({ x: 50, y: 51, width: 80, height: 40 });
    c.undo();
    expect((c.getLayer(id) as PixelLayer).surface).toBe(before);
  });

  it('targets the topmost visible pixel layer when none is active', () => {
    const { c, id, tool } = setup();
    c.setActiveLayer(null);
    expect(tool.begin()).toBeNull();
    expect(tool.session!.layerId).toBe(id);
    tool.cancel();
  });

  it('reports why it cannot open', () => {
    const { c, id, tool } = setup();
    c.setLayerProperties(id, { locks: { position: true } });
    expect(tool.begin()).toMatch(/position locked/);
    expect(tool.active).toBe(false);
    expect(tool.key({ key: 'Enter' })).toBe(false);
  });

  it('moves the reference point, which then follows the transform', () => {
    const { tool } = setup();
    tool.begin();
    drag(tool, { x: 70, y: 60 }, { x: 50, y: 50 });
    close(tool.referencePoint()!, { x: 50, y: 50 });
    drag(tool, { x: 120, y: 60 }, { x: 50, y: 120 });
    // Rotation about the top-left corner keeps it in place.
    close(tool.overlay()!.outline[0], { x: 50, y: 50 });
    tool.cancel();
  });

  it('warps: presets from the bar, dragging mesh points and pulling inside, committed as one step', () => {
    const { c, id, tool } = setup();
    tool.begin();
    tool.setMode('warp');
    let o = tool.overlay()!;
    expect(o.handles).toEqual([]);
    expect(o.warp!.anchors).toHaveLength(4);
    expect(o.warp!.handles).toHaveLength(8);
    expect(tool.hit({ x: 90, y: 70 }, 2)).toMatch(/^mesh:/);
    tool.setWarp({ style: 'arc', bend: 50 });
    expect(tool.warpBar()).toMatchObject({ style: 'arc', bend: 50 });
    // Arc bends the frame: its corners leave the box's corners.
    o = tool.overlay()!;
    expect(o.warp!.anchors.some((a) => a.y !== 50 && a.y !== 70)).toBe(true);
    tool.setWarp({ columns: 3, rows: 3 });
    expect(tool.overlay()!.warp!.anchors).toHaveLength(16);
    // Dragging an anchor turns the style into Custom.
    const a = tool.overlay()!.warp!.anchors[5];
    expect(tool.down(a, 1)).toMatch(/^mesh:/);
    tool.move({ x: a.x + 5, y: a.y + 5 });
    tool.up();
    expect(tool.warpBar().style).toBe('custom');
    // Pulling inside moves the surface under the pointer.
    const [p5, p10] = [tool.overlay()!.warp!.anchors[5], tool.overlay()!.warp!.anchors[10]];
    const mid = { x: (p5.x + p10.x) / 2, y: (p5.y + p10.y) / 2 };
    expect(tool.down(mid, 0.5)).toBe('inside');
    tool.move({ x: mid.x + 2, y: mid.y + 4 });
    tool.up();
    const steps = (c as unknown as { undoStack: unknown[] }).undoStack.length;
    const res = tool.commit()!;
    expect(res.changed).toBe(true);
    expect((c as unknown as { undoStack: unknown[] }).undoStack.length).toBe(steps + 1);
    expect(c.getLayerBounds(id)).not.toEqual({ x: 50, y: 50, width: 40, height: 20 });
  });

  it('keeps a warp and the corner map together', () => {
    const { c, id, tool } = setup();
    tool.begin();
    tool.setWarp({ style: 'flag', bend: 30 });
    tool.setMode('scale');
    expect(tool.overlay()!.warp).toBeUndefined();
    drag(tool, { x: 90, y: 70 }, { x: 130, y: 90 });
    tool.setMode('warp');
    expect(tool.warp).not.toBeNull();
    // The mesh is drawn through the corner map: its bottom-right anchor sits on the moved corner.
    const anchors = tool.overlay()!.warp!.anchors;
    expect(anchors[anchors.length - 1].x).toBeCloseTo(130, 6);
    tool.commit();
    expect(c.getLayerBounds(id)!.width).toBeGreaterThan(60);
  });
});
