import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  contentBounds,
  readRegion,
  surfaceFromPixels,
  LayerCompositor,
  convertToSmartObject,
  renderSmartObject,
  type ImageLayer,
  type PixelLayer,
  type SmartObjectLayer,
} from '../src/image-editor';

const W = 64;
const H = 48;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([x * 4, y * 5, 120, 255], (y * W + x) * 4);
  c.setSamplePixels({ width: W, height: H, data });
  return c;
}

/** A layer with a 20 × 12 patterned block at (x, y). */
function block(c: ImageEditorController, x = 10, y = 8, name = 'Block') {
  const w = 20;
  const h = 12;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data.set([(i * 13) % 256, (j * 21) % 256, ((i + j) * 7) % 256, i < 2 ? 128 : 255], (j * w + i) * 4);
  return c.addPixelLayer({ name, pixels: { width: w, height: h, data }, x, y });
}

const composite = (c: ImageEditorController) => c.compositePixels().data;
const smart = (c: ImageEditorController, id: string) => c.getLayer(id) as SmartObjectLayer;
const steps = (c: ImageEditorController) => (c as unknown as { undoStack: unknown[] }).undoStack.length;

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('convert to smart object', () => {
  it('keeps a pixel layer looking exactly the same (offset, mask, effects, filters as smart filters)', () => {
    const c = setup();
    const id = block(c);
    c.offsetLayer(id, { dx: 3, dy: -2 });
    c.selectRect({ x: 12, y: 8, width: 8, height: 6 });
    c.addLayerMask(id, 'selection');
    c.deselect();
    c.setLayerProperties(id, { opacity: 0.8, blend: 'multiply', fillOpacity: 0.9 });
    c.addLayerEffect(id, 'drop-shadow', { distance: 3, size: 2 });
    c.addLayerFilter(id, { kind: 'develop', exposure: 30, saturation: -20 });
    c.addLayerFilter(id, { kind: 'blur', radius: 2 });
    const before = composite(c);
    const sid = c.convertToSmartObject([id]);
    expect(sid).toBe(id);
    const layer = smart(c, sid);
    expect(layer.type).toBe('smart');
    expect(layer.contents.kind).toBe('raster');
    expect(layer.contents).toMatchObject({ width: 20, height: 12 });
    expect(layer.smartFilters?.filters.map((f) => [f.kind, f.blend, f.opacity])).toEqual([
      ['develop', 'normal', 1],
      ['blur', 'normal', 1],
    ]);
    expect(layer).toMatchObject({ opacity: 0.8, blend: 'multiply', fillOpacity: 0.9 });
    expect(Array.from(composite(c))).toEqual(Array.from(before));
  });

  it('nests several layers as a document that renders like an isolated group', () => {
    const c = setup();
    const a = block(c, 4, 4, 'A');
    const b = block(c, 20, 16, 'B');
    c.setLayerProperties(b, { blend: 'screen', opacity: 0.7 });
    const g = c.groupLayers([a, b]);
    c.setLayerProperties(g, { blend: 'normal' });
    const grouped = composite(c);
    c.undo();
    c.undo();
    const sid = c.convertToSmartObject([a, b], { name: 'Pair' });
    const layer = smart(c, sid);
    expect(layer.name).toBe('Pair');
    expect(layer.contents.kind).toBe('document');
    expect(layer.contents.document!.layers.map((l) => l.name)).toEqual(['A', 'B']);
    expect(layer.contents).toMatchObject({ width: 36, height: 24 });
    expect(Array.from(composite(c))).toEqual(Array.from(grouped));
    expect(c.getLayers().map((l) => l.id)).toEqual([c.getLayers()[0].id, sid]);
  });

  it('refuses layers in different groups, annotations and empty layers, changing nothing', () => {
    const c = setup();
    const a = block(c);
    const empty = c.addPixelLayer({ name: 'Empty' });
    const g = c.addGroup();
    const inner = c.addPixelLayer({ parentId: g, color: '#ff0000' });
    const before = c.getLayers();
    expect(() => c.convertToSmartObject([a, inner])).toThrow(/share one parent/);
    expect(() => c.convertToSmartObject([empty])).toThrow(/no pixels/);
    expect(() => c.convertToSmartObject(['nope'])).toThrow(/Unknown layer "nope"/);
    expect(c.getLayers()).toBe(before);
  });

  it('is one undo step', () => {
    const c = setup();
    const id = block(c);
    const n = steps(c);
    c.convertToSmartObject([id]);
    expect(steps(c)).toBe(n + 1);
    c.undo();
    expect(c.getLayer(id)!.type).toBe('pixel');
  });
});

describe('placement', () => {
  it('re-renders from the contents, so many small transforms equal one big one', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c, 20, 18)]);
    for (let i = 0; i < 12; i++) c.transformLayer({ layerId: id, params: { rotate: 30 } });
    const after12 = composite(c);
    const corners12 = smart(c, id).placement.corners;
    // A full turn: back where it started, without the blur twelve resamples of the pixels would leave.
    c.setSmartObjectTransform(id, { rotate: 0, scaleX: 100, scaleY: 100 });
    const straight = composite(c);
    expect(maxDiff(after12, straight)).toBeLessThanOrEqual(1);
    expect(corners12[0].x).toBeCloseTo(20, 6);
    expect(corners12[0].y).toBeCloseTo(18, 6);
  });

  it('reports scale relative to the contents and sets it absolutely', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c, 10, 10)]);
    c.transformLayer({ layerId: id, params: { scaleX: 50, scaleY: 50 } });
    c.transformLayer({ layerId: id, params: { scaleX: 50, scaleY: 50 } });
    const info = c.getSmartObject(id);
    expect(info.placement.scaleX).toBeCloseTo(25, 6);
    const res = c.setSmartObjectTransform(id, { scaleX: 200, scaleY: 100, rotate: 90, x: 30, y: 20 });
    expect(res.scaleX).toBeCloseTo(200, 6);
    expect(res.rotate).toBeCloseTo(90, 6);
    expect(res.center.x).toBeCloseTo(30, 6);
    expect(res.center.y).toBeCloseTo(20, 6);
    // 40 × 12 turned a quarter: 12 wide, 40 tall about (30, 20).
    expect(res.bounds).toMatchObject({ x: expect.closeTo(24, 6), y: expect.closeTo(0, 6), width: expect.closeTo(12, 6), height: expect.closeTo(40, 6) });
  });

  it('keeps a warp in contents pixels and removes it with null', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c, 10, 10)]);
    c.setSmartObjectTransform(id, { warp: { style: 'arc', bend: 40 } });
    expect(smart(c, id).placement.warp).toBeTruthy();
    const warped = composite(c);
    c.setSmartObjectTransform(id, { scaleX: 150 });
    expect(smart(c, id).placement.warp).toBeTruthy();
    c.setSmartObjectTransform(id, { scaleX: 100, warp: null });
    expect(smart(c, id).placement.warp).toBeUndefined();
    expect(maxDiff(composite(c), warped)).toBeGreaterThan(10);
  });

  it('moves with offset_layer by whole pixels without resampling, and its linked mask follows', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c, 10, 10)]);
    c.selectRect({ x: 12, y: 12, width: 4, height: 4 });
    c.addLayerMask(id, 'selection');
    c.deselect();
    const before = smart(c, id);
    c.offsetLayer(id, { dx: 5, dy: 3 });
    const after = smart(c, id);
    expect(after.placement.corners[0]).toEqual({ x: 15, y: 13 });
    expect(Array.from(readRegion(after.surface, { x: 15, y: 13, width: 20, height: 12 }))).toEqual(Array.from(readRegion(before.surface, { x: 10, y: 10, width: 20, height: 12 })));
    expect(contentBounds(after.mask!.surface)).toEqual({ x: 17, y: 15, width: 4, height: 4 });
  });

  it('refuses a folded quad and a locked position', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c, 10, 10)]);
    const bad = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }] as const;
    expect(() => c.setSmartObjectTransform(id, { corners: bad as never })).toThrow(/convex/);
    c.setLayerProperties(id, { locks: { position: true } });
    expect(() => c.setSmartObjectTransform(id, { rotate: 10 })).toThrow(/position locked/);
  });

  it('transforms through a Free Transform session, editing the placement', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c, 10, 10)]);
    c.selectRect({ x: 0, y: 0, width: 5, height: 5 });
    const s = c.beginFreeTransform({ layerId: id });
    expect(s.smartObject).toBe(true);
    expect(s.content).toBe('layer');
    expect(s.box).toEqual({ x: 0, y: 0, width: 20, height: 12 });
    expect(s.geometry.corners[0]).toEqual({ x: 10, y: 10 });
    s.update({ corners: s.geometry.corners.map((p) => ({ x: p.x + 4, y: p.y })) as never }, { scale: 0.5 });
    const res = s.commit();
    expect(res.changed).toBe(true);
    expect(smart(c, id).placement.corners[0]).toEqual({ x: 14, y: 10 });
    c.undo();
    expect(smart(c, id).placement.corners[0]).toEqual({ x: 10, y: 10 });
  });
});

describe('smart filters', () => {
  it('render like the same filters on a pixel layer', () => {
    const c = setup();
    const p = block(c, 6, 6);
    c.addLayerFilter(p, { kind: 'develop', contrast: 40, temperature: 25 });
    c.addLayerFilter(p, { kind: 'blur', radius: 3 });
    const filtered = composite(c);
    c.removeLayerFilter(p, (c.getLayer(p) as PixelLayer).filters![1].id);
    c.removeLayerFilter(p, (c.getLayer(p) as PixelLayer).filters![0].id);
    const id = c.convertToSmartObject([p]);
    c.addSmartFilter(id, { kind: 'develop', contrast: 40, temperature: 25 });
    c.addSmartFilter(id, { kind: 'blur', radius: 3 });
    expect(Array.from(composite(c))).toEqual(Array.from(filtered));
  });

  it('blends each filter over the result below it by its opacity, and allows repeated kinds', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const plain = composite(c);
    const f = c.addSmartFilter(id, { kind: 'develop', exposure: 80, opacity: 0 });
    expect(Array.from(composite(c))).toEqual(Array.from(plain));
    c.updateSmartFilter(id, f.id, { opacity: 1 });
    const full = composite(c);
    c.updateSmartFilter(id, f.id, { opacity: 0.5 });
    const half = composite(c);
    const i = (12 * W + 15) * 4;
    expect(half[i]).toBeGreaterThan(Math.min(plain[i], full[i]) - 1);
    expect(half[i]).toBeLessThan(Math.max(plain[i], full[i]) + 1);
    c.addSmartFilter(id, { kind: 'develop', saturation: -100 });
    expect(c.getSmartObject(id).smartFilters.filters).toHaveLength(2);
  });

  it('mixes in the unfiltered contents where the filter mask hides', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const plain = composite(c);
    c.addSmartFilter(id, { kind: 'develop', exposure: 80 });
    const filtered = composite(c);
    c.setSmartFilterMask(id, 'hide-all');
    expect(c.getState().activeTarget).toBe('filter-mask');
    expect(Array.from(composite(c))).toEqual(Array.from(plain));
    c.setSmartFilterMask(id, 'keep', { enabled: false });
    expect(Array.from(composite(c))).toEqual(Array.from(filtered));
    c.setSmartFilterMask(id, 'keep', { enabled: true });
    // Paint the mask white over part of the block: the filter shows there only.
    c.fillPixels({ layerId: id, channel: 'filter-mask', color: '#ffffff', useSelection: false });
    expect(Array.from(composite(c))).toEqual(Array.from(filtered));
  });

  it('reorders, disables as a stack, and removes', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const a = c.addSmartFilter(id, { kind: 'develop', exposure: 50 });
    const b = c.addSmartFilter(id, { kind: 'blur', radius: 2 });
    expect(c.moveSmartFilter(id, b.id, 0).map((f) => f.id)).toEqual([b.id, a.id]);
    const on = composite(c);
    c.setSmartFiltersEnabled(id, false);
    expect(c.getSmartObject(id).smartFilters.enabled).toBe(false);
    expect(maxDiff(composite(c), on)).toBeGreaterThan(0);
    c.setSmartFiltersEnabled(id, true);
    expect(Array.from(composite(c))).toEqual(Array.from(on));
    expect(c.removeSmartFilter(id, a.id).map((f) => f.id)).toEqual([b.id]);
    expect(() => c.removeSmartFilter(id, 'gone')).toThrow(/no smart filter "gone"/);
    expect(() => c.addSmartFilter(id, { kind: 'sharpen' })).toThrow(/Unknown filter kind/);
    expect(() => c.addSmartFilter(id, { kind: 'blur', blend: 'pigment' })).toThrow(/blend mode/);
  });

  it('layer effects, masks and clipping still apply on top', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const plain = composite(c);
    c.addLayerEffect(id, 'stroke', { size: 2 });
    expect(maxDiff(composite(c), plain)).toBeGreaterThan(0);
    const clip = c.addPixelLayer({ color: '#00ff00' });
    c.setLayerProperties(clip, { clipped: true });
    const out = composite(c);
    const inside = (14 * W + 20) * 4;
    expect([out[inside], out[inside + 1], out[inside + 2]]).toEqual([0, 255, 0]);
    expect(out[(40 * W + 60) * 4 + 1]).not.toBe(255);
  });
});

describe('linked instances and contents', () => {
  it('shares contents with a linked duplicate and replaces them in both', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const linked = c.copySmartObject(id, true);
    const own = c.copySmartObject(id, false);
    c.offsetLayer(linked, { dx: 20, dy: 20 });
    expect(c.getSmartObject(id).contents.instances).toEqual([id, linked]);
    const red = new Uint8ClampedArray(10 * 10 * 4);
    for (let i = 0; i < red.length; i += 4) red.set([255, 0, 0, 255], i);
    const res = c.replaceSmartObjectContents(id, { pixels: { width: 10, height: 10, data: red } });
    expect(res.layerIds).toEqual([id, linked]);
    expect(smart(c, linked).contents).toBe(smart(c, id).contents);
    expect(smart(c, own).contents.width).toBe(20);
    // Same scale about the old centre: a 10 × 10 square centred where the 20 × 12 block was.
    expect(c.getSmartObject(id).placement.corners[0]).toEqual({ x: 15, y: 9 });
  });

  it('edits contents as a document of their own and saves them back to every instance', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const linked = c.copySmartObject(id, true);
    c.offsetLayer(linked, { dx: 25, dy: 20 });
    const n = steps(c);
    const res = c.editSmartObjectContents(id);
    expect(res).toMatchObject({ width: 20, height: 12, depth: 1 });
    expect(c.getState().editingContents).toEqual([{ layerId: id, name: 'Block' }]);
    expect(c.getState().imageDimensions).toEqual({ width: 20, height: 12 });
    c.fillPixels({ color: '#0000ff', useSelection: false });
    expect(c.canUndo).toBe(true);
    const closed = c.closeSmartObjectContents();
    expect(closed).toMatchObject({ layerId: id, changed: true, layerIds: [id, linked] });
    expect(c.getState().editingContents).toBeUndefined();
    expect(steps(c)).toBe(n + 1);
    const px = (x: number, y: number) => Array.from(composite(c).slice((y * W + x) * 4, (y * W + x) * 4 + 4));
    expect(px(15, 12)).toEqual([0, 0, 255, 255]);
    expect(px(40, 32)).toEqual([0, 0, 255, 255]);
    c.undo();
    expect(px(15, 12)).not.toEqual([0, 0, 255, 255]);
  });

  it('drops edits when closed without saving, and nests', () => {
    const c = setup();
    const inner = c.convertToSmartObject([block(c)]);
    const outer = c.convertToSmartObject([inner, block(c, 30, 30, 'Other')]);
    const before = c.getLayers();
    c.editSmartObjectContents(outer);
    const nested = c.getLayers().find((l) => l.type === 'smart')!;
    c.editSmartObjectContents(nested.id);
    expect(c.getEditingContents()).toHaveLength(2);
    c.fillPixels({ color: '#ff00ff', useSelection: false });
    c.closeSmartObjectContents(false);
    expect(c.closeSmartObjectContents(false)).toMatchObject({ changed: false });
    expect(c.getLayers()).toBe(before);
    expect(() => c.closeSmartObjectContents()).toThrow(/No smart object contents are open/);
  });

  it('rasterizes to a pixel layer holding what it rendered', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    c.transformLayer({ layerId: id, params: { rotate: 15 } });
    c.addSmartFilter(id, { kind: 'blur', radius: 1 });
    const before = composite(c);
    c.rasterizeSmartObject(id);
    expect(c.getLayer(id)!.type).toBe('pixel');
    expect(Array.from(composite(c))).toEqual(Array.from(before));
  });

  it('exports raster contents as PNG and a nested document as PSD', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const png = c.exportSmartObjectContents(id);
    expect(png).toMatchObject({ name: 'Block.png', mimeType: 'image/png' });
    expect(Array.from(png.bytes.slice(1, 4))).toEqual([80, 78, 71]);
    const doc = c.convertToSmartObject([id, block(c, 30, 30)]);
    const psd = c.exportSmartObjectContents(doc);
    expect(psd.mimeType).toBe('image/vnd.adobe.photoshop');
    expect(String.fromCharCode(...psd.bytes.slice(0, 4))).toBe('8BPS');
  });
});

describe('serialization', () => {
  it('round-trips smart objects, shared contents and filters, rendering the same', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    c.setSmartObjectTransform(id, { rotate: 20, warp: { style: 'flag', bend: 30 } });
    c.addSmartFilter(id, { kind: 'develop', exposure: 30, blend: 'screen', opacity: 0.6 });
    c.setSmartFilterMask(id, 'reveal-all');
    const linked = c.copySmartObject(id, true);
    c.offsetLayer(linked, { dx: 10, dy: 10 });
    const nested = c.convertToSmartObject([linked, block(c, 40, 30, 'Late')]);
    const json = c.toJSON();
    expect(json.version).toBe(3);
    expect((json as { smartContents?: unknown[] }).smartContents).toHaveLength(2);
    const before = composite(c);
    const d = setup();
    d.loadJSON(JSON.parse(JSON.stringify(json)));
    expect(d.lastLoadProblems).toEqual([]);
    expect(Array.from(composite(d))).toEqual(Array.from(before));
    const a = d.getLayer(id) as SmartObjectLayer;
    const inner = (d.getLayer(nested) as SmartObjectLayer).contents.document!.layers.find((l) => l.type === 'smart') as SmartObjectLayer;
    expect(inner.contents).toBe(a.contents);
    expect(a.smartFilters!.filters[0]).toMatchObject({ kind: 'develop', exposure: 30, blend: 'screen', opacity: 0.6 });
    expect(a.placement.warp).toBeTruthy();
  });

  it('re-renders a stored smart object without its pixels', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    c.transformLayer({ layerId: id, params: { scaleX: 150 } });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    const layer = json.layers.find((l: { id: string }) => l.id === id);
    delete json.assets[layer.asset];
    delete layer.asset;
    const d = setup();
    d.loadJSON(json);
    expect(Array.from(composite(d))).toEqual(Array.from(composite(c)));
  });

  it('reports missing contents and drops the layer', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    json.smartContents = [];
    const d = setup();
    d.loadJSON(json);
    expect(d.getLayer(id)).toBeUndefined();
    expect(d.lastLoadProblems.join(' ')).toMatch(/contents .* missing/);
  });

  it('serializes the document, not the open contents', () => {
    const c = setup();
    const id = c.convertToSmartObject([block(c)]);
    const json = JSON.stringify(c.toJSON());
    c.editSmartObjectContents(id);
    c.fillPixels({ color: '#00ff00', useSelection: false });
    expect(JSON.stringify(c.toJSON())).toBe(json);
  });
});

describe('rendering', () => {
  it('a smart object placed 1:1 renders its contents exactly (compositor equivalence)', () => {
    const data = new Uint8ClampedArray(30 * 20 * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
    const pixel: PixelLayer = { type: 'pixel', id: 'p', name: 'P', visible: true, opacity: 0.7, blend: 'overlay', surface: surfaceFromPixels({ width: 30, height: 20, data }, 4), offset: { x: 7, y: 5 } };
    const backdrop: PixelLayer = { type: 'pixel', id: 'b', name: 'B', visible: true, opacity: 1, blend: 'normal', surface: surfaceFromPixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(150) }, 4), offset: { x: 0, y: 0 } };
    const canvas = { width: W, height: H };
    const sources = { width: W, height: H };
    const a = new LayerCompositor().composite([backdrop, pixel], { x: 0, y: 0, width: W, height: H }, sources);
    const converted = convertToSmartObject([backdrop, pixel] as ImageLayer[], ['p'], canvas, { surfaceOf: (l) => l.surface });
    const b = new LayerCompositor().composite(converted.layers, { x: 0, y: 0, width: W, height: H }, sources);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(contentBounds(renderSmartObject(converted.layer, canvas))).toEqual({ x: 7, y: 5, width: 30, height: 20 });
  });
});
