import { describe, expect, it } from 'vitest';
import { ImageEditorController, PathEditGesture, imageToolCanvasMode, imageToolForShortcut, imageToolGroup, isPathEditTool } from '../src/image-editor';

const W = 100;
const H = 80;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) });
  const g = new PathEditGesture(c);
  g.setView(1);
  return { c, g };
}

/** A saved path: the square (10,10)–(50,50), anchors clockwise from the top left. */
function square(c: ImageEditorController) {
  return c.addPath({ name: 'Square', subpaths: [{ anchors: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }], closed: true }] });
}

const anchors = (c: ImageEditorController, id: string) => c.getPath(id)!.components[0].subpaths[0].anchors;

describe('path tools', () => {
  it('are annotate-mode tools in their own toolbar groups with Photoshop shortcuts', () => {
    expect(isPathEditTool('path-pen')).toBe(true);
    expect(isPathEditTool('pen')).toBe(false);
    expect(imageToolCanvasMode('direct-select')).toBe('annotate');
    expect(imageToolGroup('direct-select').tools).toEqual(['path-pen', 'path-select', 'direct-select']);
    expect(imageToolForShortcut('p')).toBe('path-pen');
    expect(imageToolForShortcut('a')).toBe('path-select');
    expect(imageToolForShortcut('a', true)).toBe('direct-select');
  });

  it('targets the active path, else the active shape layer, else its vector mask', () => {
    const { c } = setup();
    expect(c.pathEditTarget()).toBeNull();
    const shape = c.addShapeLayer({ shape: { kind: 'rect', x: 5, y: 5, width: 20, height: 20 }, fill: '#ff0000' });
    expect(c.pathEditTarget()).toEqual({ kind: 'shape', layerId: shape });
    const path = square(c);
    expect(c.pathEditTarget()).toEqual({ kind: 'path', id: path.id });
    c.setActivePath(null);
    expect(c.pathEditTarget()).toEqual({ kind: 'shape', layerId: shape });
  });

  it('drags an anchor with Direct Selection as one undo step', () => {
    const { c, g } = setup();
    const path = square(c);
    g.down({ x: 51, y: 11 }, 'direct-select');
    expect(g.selection).toEqual([{ component: 0, subpath: 0, anchor: 1 }]);
    g.move({ x: 55, y: 15 });
    g.move({ x: 61, y: 21 });
    g.up();
    expect(anchors(c, path.id)[1]).toMatchObject({ x: 60, y: 20 });
    expect(anchors(c, path.id)[0]).toMatchObject({ x: 10, y: 10 });
    c.undo();
    expect(anchors(c, path.id)[1]).toMatchObject({ x: 50, y: 10 });
  });

  it('selects anchors with a marquee and Shift, moves them together, and deletes them', () => {
    const { c, g } = setup();
    const path = square(c);
    g.down({ x: 40, y: 0 }, 'direct-select');
    g.move({ x: 60, y: 60 });
    g.up();
    expect(g.selection.map((r) => r.anchor).sort()).toEqual([1, 2]);
    g.down({ x: 10, y: 10 }, 'direct-select', { shift: true });
    g.up();
    expect(g.selection.map((r) => r.anchor).sort()).toEqual([0, 1, 2]);
    g.down({ x: 50, y: 50 }, 'direct-select');
    g.move({ x: 55, y: 52 }, { shift: true });
    g.up();
    // Shift keeps the move on one axis.
    expect(anchors(c, path.id).map((a) => [a.x, a.y])).toEqual([[15, 10], [55, 10], [55, 50], [10, 50]]);
    expect(g.key('Delete')).toBe(true);
    expect(anchors(c, path.id).map((a) => [a.x, a.y])).toEqual([[10, 50]]);
  });

  it('drags a selected anchor’s handle, keeping a smooth anchor smooth (Alt breaks it)', () => {
    const { c, g } = setup();
    const path = c.addPath({
      subpaths: [{ anchors: [{ x: 10, y: 40 }, { x: 50, y: 20, in: { x: 40, y: 20 }, out: { x: 60, y: 20 } }, { x: 90, y: 40 }], closed: false }],
    });
    g.down({ x: 50, y: 20 }, 'direct-select');
    g.up();
    expect(g.overlay('direct-select')!.handles).toHaveLength(2);
    g.down({ x: 60, y: 20 }, 'direct-select');
    g.move({ x: 60, y: 30 });
    g.up();
    let a = anchors(c, path.id)[1];
    expect(a.out).toMatchObject({ x: 60, y: 30 });
    expect(a.in!.x).toBeCloseTo(40);
    expect(a.in!.y).toBeCloseTo(10);
    g.down({ x: 60, y: 30 }, 'direct-select', { alt: true });
    g.move({ x: 60, y: 10 });
    g.up();
    a = anchors(c, path.id)[1];
    expect(a.out).toMatchObject({ x: 60, y: 10 });
    expect(a.in!.y).toBeCloseTo(10);
  });

  it('bends a segment through the pointer', () => {
    const { c, g } = setup();
    const path = square(c);
    g.down({ x: 30, y: 10 }, 'direct-select');
    g.move({ x: 30, y: 0 });
    g.up();
    const [a, b] = anchors(c, path.id);
    expect(a.out).toBeDefined();
    expect(b.in).toBeDefined();
    expect(a.out!.y).toBeLessThan(10);
  });

  it('Alt-clicks an anchor to convert it between corner and smooth', () => {
    const { c, g } = setup();
    const path = square(c);
    g.down({ x: 50, y: 10 }, 'direct-select', { alt: true });
    expect(anchors(c, path.id)[1].in).toBeDefined();
    expect(anchors(c, path.id)[1].out).toBeDefined();
    g.down({ x: 50, y: 10 }, 'direct-select', { alt: true });
    expect(anchors(c, path.id)[1].in).toBeUndefined();
  });

  it('moves a whole component with Path Selection, clicking inside its fill', () => {
    const { c, g } = setup();
    const path = square(c);
    g.down({ x: 30, y: 30 }, 'path-select');
    g.move({ x: 35, y: 40 });
    g.up();
    expect(anchors(c, path.id).map((a) => [a.x, a.y])).toEqual([[15, 20], [55, 20], [55, 60], [15, 60]]);
    expect(g.overlay('path-select')!.handles).toEqual([]);
    expect(g.overlay('path-select')!.anchors.every((a) => a.selected)).toBe(true);
  });

  it('draws a new Work Path with the Pen: clicks, a drag for handles, closing on the first anchor', () => {
    const { c, g } = setup();
    g.down({ x: 10, y: 10 }, 'path-pen');
    g.up();
    const id = c.getState().activePathId!;
    expect(c.getPath(id)).toMatchObject({ name: 'Work Path', work: true });
    expect(g.isDrawing).toBe(true);
    g.down({ x: 50, y: 10 }, 'path-pen');
    g.move({ x: 60, y: 10 });
    g.up();
    g.hover({ x: 50, y: 50 });
    expect(g.overlay('path-pen')!.preview).toHaveLength(4);
    g.down({ x: 50, y: 50 }, 'path-pen');
    g.up();
    g.down({ x: 11, y: 11 }, 'path-pen');
    g.up();
    expect(g.isDrawing).toBe(false);
    const sp = c.getPath(id)!.components[0].subpaths[0];
    expect(sp.closed).toBe(true);
    expect(sp.anchors).toHaveLength(3);
    expect(sp.anchors[1]).toMatchObject({ x: 50, y: 10, out: { x: 60, y: 10 }, in: { x: 40, y: 10 } });
    // Each click was one undo step.
    c.undo();
    expect(c.getPath(id)!.components[0].subpaths[0].closed).toBe(false);
  });

  it('ends an open Pen subpath with Enter, and a later Pen click starts another subpath', () => {
    const { c, g } = setup();
    g.down({ x: 10, y: 10 }, 'path-pen');
    g.up();
    g.down({ x: 40, y: 10 }, 'path-pen');
    g.up();
    expect(g.key('Enter')).toBe(true);
    expect(g.isDrawing).toBe(false);
    g.down({ x: 10, y: 60 }, 'path-pen');
    g.up();
    const id = c.getState().activePathId!;
    const subs = c.getPath(id)!.components[0].subpaths;
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({ closed: false });
    expect(subs[1].anchors).toEqual([{ x: 10, y: 60 }]);
  });

  it('adds an anchor on a segment and deletes one on an anchor with the Pen', () => {
    const { c, g } = setup();
    const path = square(c);
    g.down({ x: 30, y: 10 }, 'path-pen');
    g.up();
    expect(anchors(c, path.id)).toHaveLength(5);
    expect(anchors(c, path.id)[1]).toMatchObject({ x: 30, y: 10 });
    g.down({ x: 30, y: 10 }, 'path-pen');
    g.up();
    expect(anchors(c, path.id).map((a) => [a.x, a.y])).toEqual([[10, 10], [50, 10], [50, 50], [10, 50]]);
  });

  it('edits a shape layer (dropping its live shape) and a vector mask', () => {
    const { c, g } = setup();
    const shape = c.addShapeLayer({ shape: { kind: 'rect', x: 10, y: 10, width: 40, height: 40 }, fill: '#ff0000' });
    expect(c.getShapeLayer(shape).components[0].live).not.toBeNull();
    g.down({ x: 50, y: 10 }, 'direct-select');
    g.move({ x: 70, y: 10 });
    g.up();
    const info = c.getShapeLayer(shape);
    expect(info.components[0].live).toBeNull();
    expect(info.geometryBounds!.width).toBeCloseTo(60);

    const pixel = c.addPixelLayer({ name: 'Pixels' });
    c.addVectorMask(pixel, 'path', { shape: { kind: 'rect', x: 20, y: 20, width: 20, height: 20 } });
    expect(c.pathEditTarget()).toEqual({ kind: 'vector-mask', layerId: pixel });
    g.down({ x: 20, y: 20 }, 'direct-select');
    g.move({ x: 15, y: 15 });
    g.up();
    expect(c.getPathEditComponents({ kind: 'vector-mask', layerId: pixel })[0].subpaths[0].anchors.some((a) => a.x === 15 && a.y === 15)).toBe(true);
  });

  it('refuses to empty a shape layer, and reports a missing target', () => {
    const { c, g } = setup();
    g.down({ x: 10, y: 10 }, 'direct-select');
    expect(g.error).toMatch(/no path to edit/);
    const shape = c.addShapeLayer({ shape: { kind: 'rect', x: 10, y: 10, width: 40, height: 40 }, fill: '#ff0000' });
    g.down({ x: 0, y: 0 }, 'direct-select');
    g.move({ x: 60, y: 60 });
    g.up();
    expect(g.key('Backspace')).toBe(true);
    expect(g.error).toMatch(/delete the layer instead/);
    expect(c.getShapeLayer(shape).components).toHaveLength(1);
  });

  it('drops its selection when undo takes the anchors away', () => {
    const { c, g } = setup();
    const path = square(c);
    g.down({ x: 30, y: 10 }, 'path-pen');
    g.up();
    g.down({ x: 30, y: 10 }, 'direct-select');
    g.up();
    expect(g.selection).toHaveLength(1);
    c.undo();
    c.undo();
    expect(c.getPath(path.id)).toBeNull();
    expect(g.overlay('direct-select')).toBeNull();
    expect(g.selection).toEqual([]);
  });
});
