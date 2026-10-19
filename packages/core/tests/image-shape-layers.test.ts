import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  LayerCompositor,
  createShapeLayer,
  flattenPath,
  liveShapeSubpaths,
  rasterizeCoverage,
  readRegion,
  renderShape,
  renderShapeRect,
  shapeGeometryBounds,
  liveComponent,
  parseCssColor,
  type ShapeLayer,
} from '../src/image-editor';
import { subpathsToBezier } from '../src/vector/geometry';

const W = 64;
const H = 48;
const ENV = { width: W, height: H };

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  return c;
}

const steps = (c: ImageEditorController) => (c as unknown as { undoStack: unknown[] }).undoStack.length;
const shape = (c: ImageEditorController, id: string) => c.getLayer(id) as ShapeLayer;
const sum = (a: ArrayLike<number> | null) => (a ? Array.from(a).reduce((s, v) => s + v, 0) : 0);
const square = (x: number, y: number, s: number) => [{ type: 'M' as const, x, y }, { type: 'L' as const, x: x + s, y }, { type: 'L' as const, x: x + s, y: y + s }, { type: 'L' as const, x, y: y + s }, { type: 'Z' as const }];

/** Alpha coverage (0..1) of a layer's rendered surface over the canvas. */
function alphaOf(layer: ShapeLayer, rect = { x: 0, y: 0, width: W, height: H }): Float32Array {
  const px = readRegion(layer.surface, rect);
  const out = new Float32Array(rect.width * rect.height);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4 + 3] / 255;
  return out;
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('coverage rasterizer', () => {
  it('gives the exact area of a pixel-unaligned rectangle', () => {
    const flat = flattenPath(square(1.25, 2.5, 3.5));
    const cov = rasterizeCoverage(flat, { x: 0, y: 0, width: 8, height: 8 })!;
    expect(sum(cov)).toBeCloseTo(3.5 * 3.5, 6);
    // Corner pixel (1, 2): 0.75 wide, 0.5 tall.
    expect(cov[2 * 8 + 1]).toBeCloseTo(0.375, 6);
    expect(cov[3 * 8 + 2]).toBeCloseTo(1, 6);
  });

  it('clips on every side exactly like a window into a larger render', () => {
    const flat = flattenPath(subpathsToBezier(liveShapeSubpaths({ kind: 'ellipse', x: 3.3, y: 2.7, width: 40.2, height: 25.9 })));
    const whole = rasterizeCoverage(flat, { x: -10, y: -10, width: 80, height: 60 })!;
    for (const r of [
      { x: 0, y: 0, width: 16, height: 16 },
      { x: 30, y: 20, width: 16, height: 16 },
      { x: -4, y: 10, width: 10, height: 30 },
      { x: 40, y: -3, width: 30, height: 9 },
    ]) {
      const part = rasterizeCoverage(flat, r);
      for (let y = 0; y < r.height; y++) {
        for (let x = 0; x < r.width; x++) {
          const expected = whole[(r.y + y + 10) * 80 + r.x + x + 10];
          expect(part ? part[y * r.width + x] : 0).toBeCloseTo(expected, 5);
        }
      }
    }
  });

  it('applies nonzero and even-odd to overlapping contours', () => {
    const flat = flattenPath([...square(0, 0, 4), ...square(2, 2, 4)]);
    const r = { x: 0, y: 0, width: 8, height: 8 };
    expect(sum(rasterizeCoverage(flat, r, 'nonzero'))).toBeCloseTo(28, 6);
    expect(sum(rasterizeCoverage(flat, r, 'evenodd'))).toBeCloseTo(24, 6);
  });
});

describe('live shapes and path operations', () => {
  const area = (layer: ShapeLayer) => sum(alphaOf(layer));

  it('draws each live shape kind with the expected area', () => {
    const fill = { type: 'color' as const, color: '#000000' };
    const rect = createShapeLayer({ components: [liveComponent({ kind: 'rect', x: 4, y: 4, width: 20, height: 10 })], fill }, ENV);
    expect(area(rect)).toBeCloseTo(200, 0);
    const round = createShapeLayer({ components: [liveComponent({ kind: 'rect', x: 4, y: 4, width: 20, height: 10, radii: [5, 5, 5, 5] })], fill }, ENV);
    // Four corners lose (1 − π/4) · r² each.
    expect(Math.abs(area(round) - (200 - 4 * (1 - Math.PI / 4) * 25))).toBeLessThan(1.5);
    const ellipse = createShapeLayer({ components: [liveComponent({ kind: 'ellipse', x: 10, y: 10, width: 30, height: 20 })], fill }, ENV);
    expect(area(ellipse)).toBeCloseTo(Math.PI * 15 * 10, 0);
    const poly = createShapeLayer({ components: [liveComponent({ kind: 'polygon', x: 10, y: 10, width: 20, height: 20, sides: 4 })], fill }, ENV);
    expect(area(poly)).toBeCloseTo(200, 0);
    const star = createShapeLayer({ components: [liveComponent({ kind: 'star', x: 10, y: 10, width: 20, height: 20, points: 5, innerRatio: 0.5 })], fill }, ENV);
    expect(area(star)).toBeGreaterThan(80);
    expect(area(star)).toBeLessThan(200);
    const line = createShapeLayer({ components: [liveComponent({ kind: 'line', x1: 5, y1: 20, x2: 45, y2: 20, weight: 4, endArrow: { width: 12, length: 8 } })], fill }, ENV);
    // Bar 40 × 4, plus the head outside the bar: 12 · 8 / 2 minus the overlap 4 · 8 · (1 − 4 / 12 · ½)… keep it loose.
    expect(area(line)).toBeGreaterThan(160 + 20);
    expect(area(line)).toBeLessThan(160 + 48);
  });

  it('folds components with combine, subtract, intersect and exclude', () => {
    const a = liveComponent({ kind: 'rect', x: 0, y: 0, width: 20, height: 20 });
    const fill = { type: 'color' as const, color: '#000000' };
    const areaOf = (op: 'combine' | 'subtract' | 'intersect' | 'exclude') =>
      area(createShapeLayer({ components: [a, liveComponent({ kind: 'rect', x: 10, y: 10, width: 20, height: 20 }, op)], fill }, ENV));
    expect(areaOf('combine')).toBeCloseTo(700, 0);
    expect(areaOf('subtract')).toBeCloseTo(300, 0);
    expect(areaOf('intersect')).toBeCloseTo(100, 0);
    expect(areaOf('exclude')).toBeCloseTo(600, 0);
  });

  it('strokes the combined outline, centred, inside or outside', () => {
    const c = liveComponent({ kind: 'rect', x: 10, y: 10, width: 20, height: 20 });
    const stroke = (align: 'inside' | 'center' | 'outside') =>
      area(createShapeLayer({ components: [c], fill: null, stroke: { width: 4, paint: { type: 'color', color: '#ff0000' }, align } }, ENV));
    expect(stroke('center')).toBeCloseTo(24 * 24 - 16 * 16, 0);
    expect(stroke('inside')).toBeCloseTo(20 * 20 - 12 * 12, 0);
    expect(stroke('outside')).toBeCloseTo(28 * 28 - 20 * 20, 0);
    const dashed = area(createShapeLayer({ components: [c], fill: null, stroke: { width: 2, paint: { type: 'color', color: '#ff0000' }, dashes: [2, 2] } }, ENV));
    const solid = area(createShapeLayer({ components: [c], fill: null, stroke: { width: 2, paint: { type: 'color', color: '#ff0000' } } }, ENV));
    expect(dashed / solid).toBeGreaterThan(0.4);
    expect(dashed / solid).toBeLessThan(0.6);
    // Two overlapping squares combined: the stroke follows the union, not each square.
    const union = createShapeLayer({ components: [c, liveComponent({ kind: 'rect', x: 20, y: 20, width: 20, height: 20 })], fill: null, stroke: { width: 2, paint: { type: 'color', color: '#ff0000' } } }, ENV);
    const px = readRegion(union.surface, { x: 25, y: 25, width: 1, height: 1 });
    expect(px[3]).toBe(0); // inside both squares, where their own outlines would have crossed
  });

  it('paints gradients and patterns, and fill under stroke', () => {
    const c = liveComponent({ kind: 'rect', x: 0, y: 0, width: 40, height: 10 });
    const g = createShapeLayer(
      { components: [c], fill: { type: 'gradient', gradient: { stops: [{ position: 0, color: '#000000' }, { position: 1, color: '#ffffff' }], style: 'linear', angle: 0, scale: 1, reverse: false, align: true, offset: { x: 0, y: 0 } } } },
      ENV
    );
    const row = readRegion(g.surface, { x: 0, y: 5, width: 40, height: 1 });
    expect(row[0]).toBeLessThan(20);
    expect(row[39 * 4]).toBeGreaterThan(235);
    expect(row[20 * 4]).toBeGreaterThan(row[10 * 4]);
    const p = createShapeLayer({ components: [c], fill: { type: 'pattern', patternId: 'checker', scale: 1 } }, ENV);
    expect(sum(alphaOf(p))).toBeGreaterThan(0);
    const both = createShapeLayer({ components: [c], fill: { type: 'color', color: '#00ff00' }, stroke: { width: 4, paint: { type: 'color', color: '#0000ff', opacity: 0.5 } } }, ENV);
    const edge = readRegion(both.surface, { x: 20, y: 1, width: 1, height: 1 });
    // Half-transparent blue over opaque green.
    expect(Array.from(edge)).toEqual([0, 128, 128, 255]);
  });

  it('renders tile by tile exactly as a single region', () => {
    const layer = createShapeLayer(
      { components: [liveComponent({ kind: 'star', x: -30, y: 200, width: 400, height: 300, points: 7, innerRatio: 0.4 })], fill: { type: 'color', color: '#336699' }, stroke: { width: 9, paint: { type: 'color', color: '#ff0000' }, join: 'round' } },
      { width: 600, height: 600 }
    );
    const rect = { x: 200, y: 240, width: 140, height: 90 };
    const direct = renderShapeRect(layer, rect, { width: 600, height: 600 })!;
    expect(maxDiff(readRegion(layer.surface, rect), direct)).toBe(0);
  });
});

describe('shape layers in the controller', () => {
  it('adds, restyles and edits components, one undo step each', () => {
    const c = setup();
    const n = steps(c);
    const id = c.addShapeLayer({ shape: { kind: 'rect', x: 10, y: 10, width: 20, height: 10 }, fill: '#ff0000' });
    expect(steps(c)).toBe(n + 1);
    expect(c.getState().activeLayerId).toBe(id);
    expect(c.getShapeLayer(id)).toMatchObject({ name: 'Rectangle', fill: { type: 'color', color: '#ff0000' }, stroke: null, components: [{ index: 0, op: 'combine', live: { kind: 'rect' } }] });
    expect(c.getLayerBounds(id)).toEqual({ x: 10, y: 10, width: 20, height: 10 });

    c.setShapeStyle(id, { stroke: { width: 2, paint: '#0000ff' } });
    expect(c.getShapeLayer(id).stroke).toEqual({ width: 2, paint: { type: 'color', color: '#0000ff' } });
    c.setShapeStyle(id, { stroke: { dashes: [3, 1], cap: 'round' } });
    expect(c.getShapeLayer(id).stroke).toEqual({ width: 2, paint: { type: 'color', color: '#0000ff' }, cap: 'round', dashes: [3, 1] });
    expect(steps(c)).toBe(n + 3);

    // Only the radii change; the rest of the live rect stays.
    c.setShapeComponent(id, 0, { shape: { radii: [4, 4, 0, 0] } });
    expect(c.getShapeLayer(id).components[0].live).toEqual({ kind: 'rect', x: 10, y: 10, width: 20, height: 10, radii: [4, 4, 0, 0] });

    c.addShapeComponent(id, { shape: { kind: 'ellipse', x: 20, y: 5, width: 20, height: 20 }, op: 'subtract' });
    expect(c.getShapeLayer(id).components.map((x) => x.op)).toEqual(['combine', 'subtract']);
    const before = c.compositePixels().data;
    c.mergeShapeComponents(id);
    const merged = c.getShapeLayer(id);
    expect(merged.components).toHaveLength(1);
    expect(merged.components[0].live).toBeNull();
    expect(maxDiff(before, c.compositePixels().data)).toBeLessThanOrEqual(3);
    expect(steps(c)).toBe(n + 6);

    c.undo();
    expect(c.getShapeLayer(id).components).toHaveLength(2);
    c.removeShapeComponent(id, 1);
    expect(c.getShapeLayer(id).components).toHaveLength(1);
  });

  it('refuses bad input before changing anything', () => {
    const c = setup();
    const id = c.addShapeLayer({ shape: { kind: 'ellipse', x: 0, y: 0, width: 10, height: 10 } });
    const n = steps(c);
    expect(() => c.addShapeLayer({ shape: { kind: 'blob' } as never })).toThrow(/kind must be one of rect, ellipse/);
    expect(() => c.addShapeLayer({ shape: { kind: 'rect', x: 0, y: 0, width: 5, height: 5 }, fill: 'notacolour' })).toThrow(/not a colour/);
    expect(() => c.addShapeLayer({ shape: { kind: 'rect', x: 0, y: 0, width: 5, height: 5 }, fill: null })).toThrow(/neither fill nor stroke/);
    expect(() => c.setShapeComponent(id, 3, { op: 'subtract' })).toThrow(/componentIndex must be 0\.\.0/);
    expect(() => c.removeShapeComponent(id, 0)).toThrow(/only component/);
    expect(() => c.setShapeStyle(id, { stroke: { paint: '#000' } })).toThrow(/stroke.width/);
    expect(() => c.getShapeLayer('background')).toThrow(/not a shape layer/);
    expect(steps(c)).toBe(n);
  });

  it('refuses painting into a shape and rasterizes it into a pixel layer', async () => {
    const c = setup();
    const id = c.addShapeLayer({ shape: { kind: 'rect', x: 4, y: 4, width: 8, height: 8 }, fill: '#123456' });
    expect(() => c.paintStroke({ points: [{ x: 5, y: 5 }] })).toThrow(/shape layer; its pixels are drawn from its paths/);
    const before = c.compositePixels().data;
    await c.rasterizeLayer(id);
    expect(c.getLayer(id)!.type).toBe('pixel');
    expect(maxDiff(before, c.compositePixels().data)).toBe(0);
  });

  it('moves and transforms the paths, not pixels, and keeps live shapes live under affine maps', () => {
    const c = setup();
    const id = c.addShapeLayer({ shape: { kind: 'ellipse', x: 10, y: 10, width: 20, height: 10 }, fill: '#000000' });
    c.offsetLayer(id, { dx: 5, dy: 3 });
    expect(c.getShapeLayer(id).geometryBounds).toEqual({ x: 15, y: 13, width: 20, height: 10 });
    expect(c.getShapeLayer(id).components[0].live).toMatchObject({ kind: 'ellipse', transform: [1, 0, 0, 1, 5, 3] });

    // Scale up 4× and back down: the result is the original shape again, sharp.
    const sharp = alphaOf(shape(c, id));
    c.transformLayer({ layerId: id, params: { scaleX: 400, scaleY: 400 } });
    c.transformLayer({ layerId: id, params: { scaleX: 25, scaleY: 25 } });
    expect(maxDiff(alphaOf(shape(c, id)), sharp)).toBeLessThan(1 / 255 + 1e-6);
    expect(c.getShapeLayer(id).components[0].live?.kind).toBe('ellipse');

    // A rotation keeps the live ellipse; perspective turns it into a plain path.
    c.transformLayer({ layerId: id, params: { rotate: 30 } });
    expect(c.getShapeLayer(id).components[0].live?.kind).toBe('ellipse');
    const f = c.getFreeTransform();
    expect(f).toBeNull();
    const s = c.beginFreeTransform({ layerId: id });
    expect(s.shapeLayer).toBe(true);
    const k = s.startGeometry.corners;
    s.update({ corners: [k[0], { x: k[1].x + 6, y: k[1].y }, k[2], k[3]] }, false);
    s.commit();
    expect(c.getShapeLayer(id).components[0].live).toBeNull();
  });

  it('takes masks, clipping, blend modes and layer effects like a pixel layer', () => {
    const c = setup();
    const id = c.addShapeLayer({ shape: { kind: 'rect', x: 10, y: 10, width: 20, height: 20 }, fill: '#ff0000' });
    c.addLayerEffect(id, 'drop-shadow', { distance: 4, size: 0, angle: 90, opacity: 1, color: '#000000' });
    const shadow = c.compositePixels({ x: 20, y: 32, width: 1, height: 1 }).data;
    expect(shadow[0]).toBeLessThan(80);
    c.selectRect({ x: 0, y: 0, width: 20, height: 48 });
    c.addLayerMask(id, 'selection');
    c.deselect();
    expect(c.compositePixels({ x: 25, y: 15, width: 1, height: 1 }).data[1]).toBe(255);
    c.setLayerProperties(id, { blend: 'multiply', fillOpacity: 0.5 });
    const px = c.compositePixels({ x: 15, y: 15, width: 1, height: 1 }).data;
    expect(px[0]).toBe(255);
    expect(px[1]).toBeGreaterThan(100);
    // A linked mask moves with the shape.
    c.offsetLayer(id, { dx: 10 });
    expect(c.compositePixels({ x: 25, y: 15, width: 1, height: 1 }).data[1]).toBeLessThan(255);
  });

  it('round-trips through JSON (vector data, re-rendered on load)', () => {
    const c = setup();
    const id = c.addShapeLayer({
      components: [{ shape: { kind: 'star', x: 5, y: 5, width: 30, height: 30, points: 6, innerRatio: 0.6 } }, { subpaths: 'M 10 10 L 30 12 L 20 30 Z', op: 'exclude' }],
      fill: { type: 'gradient', gradient: { stops: [{ position: 0, color: '#ff0000' }, { position: 1, color: '#0000ff' }], style: 'radial', angle: 0, scale: 1, reverse: false, align: true, offset: { x: 0, y: 0 } } },
      stroke: { width: 3, paint: 'rgba(0, 128, 0, 0.5)', join: 'bevel', align: 'outside' },
      fillRule: 'evenodd',
    });
    const json = c.toJSON();
    const d = setup();
    d.loadJSON(json);
    expect(d.lastLoadProblems).toEqual([]);
    expect(d.getShapeLayer(id)).toEqual(c.getShapeLayer(id));
    expect(maxDiff(d.compositePixels().data, c.compositePixels().data)).toBe(0);
    expect(JSON.stringify(d.toJSON())).toBe(JSON.stringify(json));
  });

  it('composites like any layer in a stand-alone compositor', () => {
    const layer = createShapeLayer({ components: [liveComponent({ kind: 'rect', x: 2, y: 2, width: 4, height: 4 })], fill: { type: 'color', color: '#00ff00' } }, ENV);
    const out = new LayerCompositor().composite([layer], { x: 0, y: 0, width: 8, height: 8 }, ENV);
    expect(Array.from(out.slice((3 * 8 + 3) * 4, (3 * 8 + 3) * 4 + 4))).toEqual([0, 255, 0, 255]);
    expect(shapeGeometryBounds(layer)).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    expect(renderShape(layer, ENV, { clip: { x: 0, y: 0, width: 1, height: 1 } }).tileCount).toBe(0);
  });
});

describe('css colours', () => {
  it('reads hex, rgb(), hsl() and names with their alpha', () => {
    expect(parseCssColor('#f00')).toEqual({ hex: '#ff0000', alpha: 1 });
    expect(parseCssColor('#ff000080')).toEqual({ hex: '#ff0000', alpha: 128 / 255 });
    expect(parseCssColor('rgba(0, 0, 255, 0.5)')).toEqual({ hex: '#0000ff', alpha: 0.5 });
    expect(parseCssColor('hsl(120, 100%, 50%)')).toEqual({ hex: '#00ff00', alpha: 1 });
    expect(parseCssColor('Tomato')).toEqual({ hex: '#ff6347', alpha: 1 });
    expect(parseCssColor('var(--x)')).toBeNull();
  });
});
