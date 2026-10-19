import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHAPE_TOOL_OPTIONS,
  DEFAULT_TYPE_TOOL_OPTIONS,
  ImageEditorController,
  ShapeDrawGesture,
  TextEditSession,
  TypeToolGesture,
  applyShapeOptions,
  createOutlineTextShaper,
  liveShapeForDrag,
  typeLayerAt,
  type ShapeToolOptions,
} from '../src/image-editor';
import { boxFont } from './helpers/box-font';

const W = 200;
const H = 120;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, textShaper: createOutlineTextShaper([boxFont('Box')]) });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  return c;
}
const steps = (c: ImageEditorController) => (c as unknown as { undoStack: unknown[] }).undoStack.length;

describe('shape tool', () => {
  it('maps drags to live shapes, with Shift and Alt', () => {
    const o = { ...DEFAULT_SHAPE_TOOL_OPTIONS };
    expect(liveShapeForDrag(o, { x: 10, y: 10 }, { x: 40, y: 30 })).toEqual({ kind: 'rect', x: 10, y: 10, width: 30, height: 20 });
    expect(liveShapeForDrag(o, { x: 10, y: 10 }, { x: 40, y: 30 }, { shift: true })).toEqual({ kind: 'rect', x: 10, y: 10, width: 30, height: 30 });
    expect(liveShapeForDrag({ ...o, kind: 'ellipse' }, { x: 50, y: 50 }, { x: 60, y: 55 }, { alt: true })).toEqual({ kind: 'ellipse', x: 40, y: 45, width: 20, height: 10 });
    expect(liveShapeForDrag({ ...o, kind: 'line', arrow: true }, { x: 0, y: 0 }, { x: 30, y: 2 }, { shift: true })).toMatchObject({ kind: 'line', x2: expect.closeTo(30.07, 1), y2: 0, endArrow: { width: 16, length: 16 } });
    expect(liveShapeForDrag(o, { x: 10, y: 10 }, { x: 10.5, y: 30 })).toBeNull();
  });

  it('draws a shape in one undo step, live while dragging, and restyles it from the options bar', () => {
    const c = setup();
    let options: ShapeToolOptions = { ...DEFAULT_SHAPE_TOOL_OPTIONS, kind: 'star', stroke: '#000000' };
    const g = new ShapeDrawGesture(c, () => options);
    const n = steps(c);
    g.down({ x: 20, y: 20 });
    g.move({ x: 30, y: 30 });
    g.move({ x: 80, y: 70 });
    const id = g.up()!;
    expect(steps(c)).toBe(n + 1);
    expect(c.getShapeLayer(id).components[0].live).toMatchObject({ kind: 'star', x: 20, y: 20, width: 60, height: 50 });
    expect(c.getShapeLayer(id).stroke).toEqual({ width: 2, paint: { type: 'color', color: '#000000' } });
    applyShapeOptions(c, id, { fill: '#ff0000', points: 8, strokeWidth: 5 });
    expect(c.getShapeLayer(id)).toMatchObject({ fill: { color: '#ff0000' }, stroke: { width: 5 }, components: [{ live: { points: 8 } }] });
    options = { ...options, kind: 'line', fill: '#00ff00' };
    g.down({ x: 0, y: 0 });
    g.up();
    expect(c.getLayers()).toHaveLength(2);
  });
});

describe('type tool and on-canvas editing', () => {
  it('adds point text on click, types into it as one undo step, and names the layer after its text', () => {
    const c = setup();
    const tool = new TypeToolGesture(c, () => ({ ...DEFAULT_TYPE_TOOL_OPTIONS, fontFamily: 'Box', fontSize: 10 }));
    tool.down({ x: 20, y: 40 });
    const s = tool.up({ x: 20, y: 40 })!;
    const n = steps(c);
    for (const ch of 'Hi there') s.handleKey({ key: ch });
    expect(s.text).toBe('Hi there');
    expect(steps(c)).toBe(n + 1);
    s.handleKey({ key: 'Backspace' });
    s.handleKey({ key: 'ArrowLeft', shiftKey: true });
    s.handleKey({ key: 'ArrowLeft', shiftKey: true });
    expect([s.start, s.end]).toEqual([5, 7]);
    s.setStyle({ color: '#ff0000' });
    expect(c.getTextLayer(s.layerId).runs.map((r) => [r.start, r.end, r.style.color])).toEqual([
      [0, 5, '#111827'],
      [5, 7, '#ff0000'],
    ]);
    s.handleKey({ key: 'Enter' });
    expect(s.text).toBe('Hi th\n');
    s.insert('Next');
    expect(c.getTextLayer(s.layerId).lines).toHaveLength(2);
    expect(steps(c)).toBe(n + 1);
    const o = s.overlay();
    expect(o.caret).not.toBeNull();
    expect(o.frame).toHaveLength(4);
    tool.finish();
    expect(c.getLayer(s.layerId)!.name).toBe('Hi th');
    c.undo();
    expect(c.getTextLayer(s.layerId).text).toBe('');
  });

  it('clicks into existing text at the character, moves by lines, and removes empty new text', () => {
    const c = setup();
    const id = c.addTextLayer({ text: 'ABC\nDEF', x: 50, y: 50, style: { fontFamily: 'Box', fontSize: 10 } });
    expect(typeLayerAt(c, { x: 57, y: 47 })).toBe(id);
    expect(typeLayerAt(c, { x: 150, y: 100 })).toBeNull();
    const tool = new TypeToolGesture(c, () => DEFAULT_TYPE_TOOL_OPTIONS);
    tool.down({ x: 57, y: 47 });
    const s = tool.session!;
    expect(s.focus).toBe(1);
    s.move('down');
    expect(s.focus).toBe(5);
    s.move('end');
    expect(s.focus).toBe(7);
    s.handleKey({ key: 'a', metaKey: true });
    expect([s.start, s.end]).toEqual([0, 7]);
    // A click elsewhere ends this session and starts a new layer, which an empty close removes.
    tool.down({ x: 150, y: 100 });
    tool.up({ x: 150, y: 100 });
    const empty = tool.session!.layerId;
    tool.finish();
    expect(c.getLayer(empty)).toBeUndefined();
    expect(c.getLayer(id)).toBeDefined();
  });

  it('a drag adds paragraph text in the dragged box', () => {
    const c = setup();
    const tool = new TypeToolGesture(c, () => ({ ...DEFAULT_TYPE_TOOL_OPTIONS, fontFamily: 'Box', fontSize: 10 }));
    tool.down({ x: 10, y: 10 });
    const s = tool.up({ x: 70, y: 60 })!;
    expect(c.getTextLayer(s.layerId).frame).toEqual({ kind: 'box', width: 60, height: 50 });
    s.insert('AAAA AAAA AAAA');
    expect(c.getTextLayer(s.layerId).lines.length).toBeGreaterThan(1);
    expect(new TextEditSession(c, s.layerId).focus).toBe(14);
  });
});
