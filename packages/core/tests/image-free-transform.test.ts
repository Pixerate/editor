import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  contentBounds,
  describeTransform,
  identityTransform,
  matrixFromParams,
  cornersFromMatrix,
  readPixel,
  readRegion,
  type PixelLayer,
} from '../src/image-editor';

const W = 64;
const H = 48;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 100, 50, 255], i);
  c.setSamplePixels({ width: W, height: H, data });
  return c;
}

/** A layer with a 10 × 8 red block at (10, 10), active. */
function withBlock(c: ImageEditorController, extra: { x?: number; y?: number } = {}) {
  const data = new Uint8ClampedArray(10 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
  return c.addPixelLayer({ name: 'Block', pixels: { width: 10, height: 8, data }, x: extra.x ?? 10, y: extra.y ?? 10 });
}

const layer = (c: ImageEditorController, id: string) => c.getLayer(id) as PixelLayer;
/** A layer's pixel (or mask value) at a document position. */
const pixelAt = (c: ImageEditorController, id: string, x: number, y: number, mask = false) => {
  const l = layer(c, id);
  return readPixel(mask ? l.mask!.surface : l.surface, x - l.offset.x, y - l.offset.y);
};
/** A layer mask's painted bounds in document pixels. */
const maskBounds = (c: ImageEditorController, id: string) => {
  const l = layer(c, id);
  const b = contentBounds(l.mask!.surface);
  return b && { ...b, x: b.x + l.offset.x, y: b.y + l.offset.y };
};
const docBounds = (c: ImageEditorController, id: string) => c.getLayerBounds(id);

describe('transform geometry helpers', () => {
  it('turns params into a matrix and reads them back', () => {
    const box = { x: 10, y: 10, width: 100, height: 50 };
    const m = matrixFromParams(box, { scaleX: 150, scaleY: 80, rotate: 30, skewX: 10, dx: 5, dy: -3, reference: 'top-left' });
    const read = describeTransform({ box, corners: cornersFromMatrix(box, m) }, 'top-left');
    expect(read.affine).toBe(true);
    expect(read.scaleX).toBeCloseTo(150, 6);
    expect(read.scaleY).toBeCloseTo(80, 6);
    expect(read.rotate).toBeCloseTo(30, 6);
    expect(read.skewX).toBeCloseTo(10, 6);
    expect(read.x).toBeCloseTo(15, 6);
    expect(read.y).toBeCloseTo(7, 6);
    expect(describeTransform(identityTransform(box)).scaleX).toBe(100);
  });
});

describe('Free Transform on layers', () => {
  it('scales a layer as one undo step and returns its new bounds', () => {
    const c = setup();
    const id = withBlock(c);
    const before = layer(c, id).surface;
    const res = c.transformLayer({ layerId: id, params: { scaleX: 200, scaleY: 200, reference: 'top-left' }, interpolation: 'nearest' });
    expect(res).toMatchObject({ layerId: id, content: 'layer', moved: ['pixels'], changed: true, box: { x: 10, y: 10, width: 10, height: 8 } });
    expect(res.bounds).toEqual({ x: 10, y: 10, width: 20, height: 16 });
    expect(docBounds(c, id)).toEqual(res.bounds);
    expect(c.undo()).toBe(true);
    expect(layer(c, id).surface).toBe(before);
  });

  it('keeps layer offsets: a moved layer transforms where it shows', () => {
    const c = setup();
    const id = withBlock(c);
    c.offsetLayer(id, { dx: 7, dy: 3 });
    const res = c.transformLayer({ layerId: id, matrix: [1, 0, 0, 1, 2, 0], interpolation: 'nearest' });
    expect(res.box).toEqual({ x: 17, y: 13, width: 10, height: 8 });
    expect(res.bounds).toEqual({ x: 19, y: 13, width: 10, height: 8 });
  });

  it('moves a linked mask with the pixels and leaves an unlinked one in place', () => {
    const c = setup();
    const id = withBlock(c);
    c.selectRect({ x: 10, y: 10, width: 5, height: 8 });
    c.addLayerMask(id, 'selection');
    c.deselect();
    c.transformLayer({ layerId: id, matrix: [1, 0, 0, 1, 20, 0], channel: 'pixels' });
    expect(maskBounds(c, id)).toEqual({ x: 30, y: 10, width: 5, height: 8 });
    c.undo();
    c.setLayerMaskProps(id, { linked: false });
    c.transformLayer({ layerId: id, matrix: [1, 0, 0, 1, 20, 0], channel: 'pixels' });
    expect(maskBounds(c, id)).toEqual({ x: 10, y: 10, width: 5, height: 8 });
    expect(docBounds(c, id)).toEqual({ x: 30, y: 10, width: 10, height: 8 });
  });

  it('transforms an unlinked mask alone with channel mask', () => {
    const c = setup();
    const id = withBlock(c);
    c.selectRect({ x: 12, y: 12, width: 4, height: 4 });
    c.addLayerMask(id, 'selection');
    c.deselect();
    c.setLayerMaskProps(id, { linked: false });
    const pixels = layer(c, id).surface;
    const res = c.transformLayer({ layerId: id, channel: 'mask', params: { scaleX: 200, scaleY: 200, reference: 'top-left' }, interpolation: 'nearest' });
    expect(res.moved).toEqual(['mask']);
    expect(res.bounds).toEqual({ x: 12, y: 12, width: 8, height: 8 });
    expect(layer(c, id).surface).toBe(pixels);
  });

  it('keeps an unlinked mask in place when the layer moves', () => {
    const c = setup();
    const id = withBlock(c);
    c.selectRect({ x: 10, y: 10, width: 5, height: 5 });
    c.addLayerMask(id, 'selection');
    c.deselect();
    c.setLayerMaskProps(id, { linked: false });
    c.offsetLayer(id, { dx: 6, dy: 0 });
    const l = layer(c, id);
    const mb = contentBounds(l.mask!.surface)!;
    expect({ ...mb, x: mb.x + l.offset.x, y: mb.y + l.offset.y }).toEqual({ x: 10, y: 10, width: 5, height: 5 });
  });

  it('flips and rotates by quarter turns exactly', () => {
    const c = setup();
    const id = withBlock(c);
    const flip = c.flipLayer('horizontal', { layerId: id });
    expect(flip.bounds).toEqual({ x: 10, y: 10, width: 10, height: 8 });
    const rot = c.rotateLayer90(90, { layerId: id });
    expect(rot.bounds).toEqual({ x: 11, y: 9, width: 8, height: 10 });
    expect(pixelAt(c, id, 12, 12)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(c, id, 18, 18)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(c, id, 10, 12)[3]).toBe(0);
  });

  it('refuses locked, hidden and non-pixel layers with a reason', () => {
    const c = setup();
    const id = withBlock(c);
    c.setLayerProperties(id, { locks: { position: true } });
    expect(() => c.transformLayer({ layerId: id, matrix: [2, 0, 0, 2, 0, 0] })).toThrow(/position locked/);
    c.setLayerProperties(id, { locks: {}, visible: false });
    expect(() => c.transformLayer({ layerId: id, matrix: [2, 0, 0, 2, 0, 0] })).toThrow(/hidden/);
    const adj = c.addAdjustmentLayer('invert');
    expect(() => c.transformLayer({ layerId: adj, matrix: [2, 0, 0, 2, 0, 0] })).toThrow(/works on pixel, shape, type and smart object layers/);
    expect(() => c.transformLayer({ layerId: id, matrix: [0, 0, 0, 0, 0, 0] })).toThrow(/singular/);
    expect(() => c.transformLayer({ layerId: id, matrix: [1, 0, 0, 1, 0, 0], params: {} })).toThrow(/only one/);
  });

  it('drops the document flag when the Background is transformed', () => {
    const c = setup();
    const bg = c.getState().layers[0] as PixelLayer;
    expect(bg.source).toBe('document');
    c.transformLayer({ layerId: bg.id, params: { scaleX: 50, scaleY: 50, reference: 'top-left' } });
    const after = layer(c, bg.id);
    expect(after.source).toBeUndefined();
    expect(docBounds(c, bg.id)).toEqual({ x: 0, y: 0, width: 32, height: 24 });
  });
});

describe('Free Transform with a selection', () => {
  it('moves only the selected pixels, leaves the hole transparent and moves the outline', () => {
    const c = setup();
    const id = withBlock(c);
    c.selectRect({ x: 10, y: 10, width: 5, height: 8 });
    const res = c.transformLayer({ layerId: id, matrix: [1, 0, 0, 1, 30, 0] });
    expect(res.content).toBe('selection');
    expect(res.moved).toEqual(['pixels', 'selection']);
    expect(pixelAt(c, id, 12, 12)[3]).toBe(0);
    expect(pixelAt(c, id, 17, 12)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(c, id, 42, 12)).toEqual([255, 0, 0, 255]);
    expect(c.getState().selection!.bounds).toEqual({ x: 40, y: 10, width: 5, height: 8 });
    expect(c.undo()).toBe(true);
    expect(c.getState().selection!.bounds).toEqual({ x: 10, y: 10, width: 5, height: 8 });
  });

  it('transforms a copy on a new layer (Layer via Copy) and keeps the original', () => {
    const c = setup();
    const id = withBlock(c);
    const original = layer(c, id).surface;
    c.selectRect({ x: 10, y: 10, width: 5, height: 8 });
    const res = c.transformLayer({ layerId: id, content: 'selection-copy', matrix: [1, 0, 0, 1, 30, 0] });
    expect(res.layerId).not.toBe(id);
    expect(layer(c, id).surface).toBe(original);
    expect(docBounds(c, res.layerId!)).toEqual({ x: 40, y: 10, width: 5, height: 8 });
    expect(c.getState().activeLayerId).toBe(res.layerId);
    c.undo();
    expect(c.getLayer(res.layerId!)).toBeUndefined();
  });

  it('transforms just the outline (Transform Selection)', () => {
    const c = setup();
    const id = withBlock(c);
    const pixels = layer(c, id).surface;
    c.selectRect({ x: 10, y: 10, width: 10, height: 10 });
    const res = c.transformLayer({ content: 'selection-outline', params: { scaleX: 200, scaleY: 50, reference: 'top-left' }, interpolation: 'nearest' });
    expect(res).toMatchObject({ layerId: null, moved: ['selection'], bounds: { x: 10, y: 10, width: 20, height: 5 } });
    expect(layer(c, id).surface).toBe(pixels);
  });

  it('moves the same part of a linked mask as the selected pixels', () => {
    const c = setup();
    const id = withBlock(c);
    c.addLayerMask(id, 'hide-all');
    c.selectRect({ x: 10, y: 10, width: 5, height: 8 });
    c.transformLayer({ layerId: id, channel: 'pixels', matrix: [1, 0, 0, 1, 30, 0], interpolation: 'nearest' });
    // A hide-all mask stays hide-all where the pixels came from and where they went.
    expect(pixelAt(c, id, 12, 12, true)).toEqual([0]);
    expect(pixelAt(c, id, 42, 12, true)).toEqual([0]);
  });
});

describe('Free Transform sessions', () => {
  it('previews without history, then commits one undo step', () => {
    const c = setup();
    const id = withBlock(c);
    const steps = (c as unknown as { undoStack: unknown[] }).undoStack.length;
    const s = c.beginFreeTransform({ layerId: id });
    expect(c.getFreeTransform()).toBe(s);
    const g = s.geometry;
    s.update({ corners: cornersFromMatrix(g.box, [1, 0, 0, 1, 5, 0]) }, { scale: 0.25 });
    expect(docBounds(c, id)!.x).toBeGreaterThanOrEqual(12);
    s.update({ corners: cornersFromMatrix(g.box, [1, 0, 0, 1, 20, 0]) });
    expect((c as unknown as { undoStack: unknown[] }).undoStack.length).toBe(steps);
    const res = s.commit();
    expect(res.bounds).toEqual({ x: 30, y: 10, width: 10, height: 8 });
    expect((c as unknown as { undoStack: unknown[] }).undoStack.length).toBe(steps + 1);
    expect(c.getFreeTransform()).toBeNull();
    expect(() => s.update({ corners: g.corners })).toThrow(/already been committed/);
  });

  it('cancel restores the original surfaces and records nothing', () => {
    const c = setup();
    const id = withBlock(c);
    const before = layer(c, id).surface;
    const s = c.beginFreeTransform({ layerId: id });
    s.update({ corners: cornersFromMatrix(s.box, [2, 0, 0, 2, 0, 0]) });
    expect(layer(c, id).surface).not.toBe(before);
    s.cancel();
    expect(layer(c, id).surface).toBe(before);
    expect(c.getFreeTransform()).toBeNull();
  });

  it('abandons the transform when the document changes under it', () => {
    const c = setup();
    const id = withBlock(c);
    const s = c.beginFreeTransform({ layerId: id });
    expect(() => c.beginFreeTransform({ layerId: id })).toThrow(/already open/);
    c.addPixelLayer({ name: 'other' });
    expect(() => s.update({ corners: cornersFromMatrix(s.box, [2, 0, 0, 2, 0, 0]) })).toThrow(/document changed/);
  });

  it('rejects corners that fold the frame', () => {
    const c = setup();
    const id = withBlock(c);
    const s = c.beginFreeTransform({ layerId: id });
    const [tl, tr, br, bl] = s.geometry.corners;
    expect(() => s.update({ corners: [tl, br, tr, bl] })).toThrow(/convex/);
    s.cancel();
  });
});

describe('Free Transform keeps layer effects, documents and PSD working', () => {
  it('renders effects on the transformed pixels', () => {
    const c = setup();
    const id = withBlock(c);
    c.addLayerEffect(id, 'stroke', { size: 2, position: 'outside', fill: { type: 'color', color: '#00ff00' } });
    c.transformLayer({ layerId: id, matrix: [1, 0, 0, 1, 20, 0], interpolation: 'nearest' });
    expect(layer(c, id).effects?.items[0].kind).toBe('stroke');
    // The stroke now sits outside the moved block, not around where it was.
    const px = (x: number, y: number) => Array.from(c.compositePixels({ x, y, width: 1, height: 1 }).data);
    expect(px(29, 13)[1]).toBe(255);
    expect(px(9, 13)).toEqual([200, 100, 50, 255]);
  });

  it('round-trips transformed layers and the mask link through JSON and PSD', async () => {
    const c = setup();
    const id = withBlock(c);
    c.addLayerMask(id, 'reveal-all');
    c.setLayerMaskProps(id, { linked: false });
    // The new mask is the active target; channel pixels transforms the pixels (an unlinked mask stays).
    c.transformLayer({ layerId: id, channel: 'pixels', params: { rotate: 30 } });
    const surface = layer(c, id).surface;
    const json = c.toJSON();
    const d = setup();
    d.loadJSON(json);
    expect(layer(d, id).mask!.linked).toBe(false);
    const b = contentBounds(surface)!;
    expect(readRegion(layer(d, id).surface, b)).toEqual(readRegion(surface, b));

    const psd = await c.toPsd();
    const e = setup();
    e.loadPsd(psd.bytes);
    const imported = e.getState().layers.find((l) => l.name === 'Block') as PixelLayer;
    expect(imported.mask!.linked).toBe(false);
    const ib = { x: b.x + layer(c, id).offset.x, y: b.y + layer(c, id).offset.y, width: b.width, height: b.height };
    const got = readRegion(imported.surface, { ...ib, x: ib.x - imported.offset.x, y: ib.y - imported.offset.y });
    expect(got).toEqual(readRegion(surface, b));
  });
});

