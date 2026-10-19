import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  annotationLayerFor,
  migrateSerializedImageEditorState,
  readRegion,
  splitOverlayAnnotations,
  type Annotation,
  type ImagePoint,
  type LegacySerializedImageEditorState,
  type SerializedLayeredImageEditorState,
  type ShapeLayer,
} from '../src/image-editor';

const W = 64;
const H = 48;
const CANVAS = { width: W, height: H };

function controllerFor(initialState?: Partial<LegacySerializedImageEditorState | SerializedLayeredImageEditorState>) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, initialState: initialState as never });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  return c;
}

const DEPTH = { enabled: false, maskSource: null, mode: 'threshold' as const, depthRange: [0, 255] as [number, number], softness: 10, invert: false };
const ADJ = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, blur: 0, opacity: 1 };

// ---------------------------------------------------------------------------
// A reference of what the old canvas renderer drew, by point sampling (16 × 16 per pixel)
// ---------------------------------------------------------------------------

type Rgba = [number, number, number, number];
const HEX: Record<string, Rgba> = {
  '#000': [0, 0, 0, 1],
  red: [255, 0, 0, 1],
  '#00ff00': [0, 255, 0, 1],
  'rgba(0, 0, 255, 0.5)': [0, 0, 255, 0.5],
  '#ff8800': [255, 136, 0, 1],
};

const distToSegment = (p: ImagePoint, a: ImagePoint, b: ImagePoint) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};

/** Inside a bar from `a` to `b` of width `w` with butt ends (a canvas line). */
const inBar = (p: ImagePoint, a: ImagePoint, b: ImagePoint, w: number) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
  const d = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  return t >= 0 && t <= len && d <= w / 2;
};

const inTriangle = (p: ImagePoint, a: ImagePoint, b: ImagePoint, c: ImagePoint) => {
  const s = (u: ImagePoint, v: ImagePoint, w: ImagePoint) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const d1 = s(a, b, p);
  const d2 = s(b, c, p);
  const d3 = s(c, a, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

/** Fill and stroke tests of an annotation, in its unrotated frame. */
function tests(a: Annotation): { fill?: (p: ImagePoint) => boolean; stroke?: (p: ImagePoint) => boolean } {
  switch (a.type) {
    case 'rect': {
      const x0 = Math.min(a.x, a.x + a.width);
      const x1 = Math.max(a.x, a.x + a.width);
      const y0 = Math.min(a.y, a.y + a.height);
      const y1 = Math.max(a.y, a.y + a.height);
      const h = a.strokeWidth / 2;
      return {
        fill: a.fillColor ? (p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 : undefined,
        stroke: a.strokeWidth > 0 ? (p) => p.x >= x0 - h && p.x <= x1 + h && p.y >= y0 - h && p.y <= y1 + h && !(p.x > x0 + h && p.x < x1 - h && p.y > y0 + h && p.y < y1 - h) : undefined,
      };
    }
    case 'circle': {
      // A circle: the stroke is the ring at distance |r − d| ≤ w / 2.
      const r = a.radiusX;
      return {
        fill: a.fillColor ? (p) => Math.hypot(p.x - a.x, p.y - a.y) <= r : undefined,
        stroke: a.strokeWidth > 0 ? (p) => Math.abs(Math.hypot(p.x - a.x, p.y - a.y) - r) <= a.strokeWidth / 2 : undefined,
      };
    }
    case 'line':
      return { stroke: (p) => inBar(p, a, { x: a.endX, y: a.endY }, a.strokeWidth) };
    case 'arrow': {
      const tip = { x: a.endX, y: a.endY };
      const angle = Math.atan2(a.endY - a.y, a.endX - a.x);
      const len = Math.max(12, a.strokeWidth * 3);
      const b1 = { x: tip.x - len * Math.cos(angle - Math.PI / 6), y: tip.y - len * Math.sin(angle - Math.PI / 6) };
      const b2 = { x: tip.x - len * Math.cos(angle + Math.PI / 6), y: tip.y - len * Math.sin(angle + Math.PI / 6) };
      return { stroke: (p) => inBar(p, a, tip, a.strokeWidth) || inTriangle(p, tip, b1, b2) };
    }
    case 'pen':
      return {
        stroke: (p) => {
          for (let i = 0; i + 1 < a.points.length; i++) if (distToSegment(p, a.points[i], a.points[i + 1]) <= a.strokeWidth / 2) return true;
          return false;
        },
      };
    default:
      return {};
  }
}

/** The annotation as straight RGBA bytes, the fill drawn first and the stroke over it. */
function reference(a: Annotation): Uint8ClampedArray {
  const { fill, stroke } = tests(a);
  const rot = ((a.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const local = (x: number, y: number) => ({ x: a.x + (x - a.x) * cos - (y - a.y) * sin, y: a.y + (x - a.x) * sin + (y - a.y) * cos });
  const op = a.opacity ?? 1;
  const fc = 'fillColor' in a && a.fillColor ? HEX[a.fillColor] : null;
  const sc = 'strokeColor' in a ? HEX[a.strokeColor] : null;
  const out = new Uint8ClampedArray(W * H * 4);
  const N = 16;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let fn = 0;
      let sn = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const p = local(x + (i + 0.5) / N, y + (j + 0.5) / N);
          if (fill?.(p)) fn++;
          if (stroke?.(p)) sn++;
        }
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let al = 0;
      if (fc && fn) {
        al = (fn / (N * N)) * fc[3] * op;
        [r, g, b] = fc;
      }
      // Lines and arrows paint their stroke colour as a fill in the old renderer too (one colour).
      const scol = sc;
      if (scol && sn) {
        const sa = (sn / (N * N)) * scol[3] * op;
        const ao = sa + al * (1 - sa);
        r = (scol[0] * sa + r * al * (1 - sa)) / ao;
        g = (scol[1] * sa + g * al * (1 - sa)) / ao;
        b = (scol[2] * sa + b * al * (1 - sa)) / ao;
        al = ao;
      }
      const k = (y * W + x) * 4;
      if (al > 0) out.set([Math.round(r), Math.round(g), Math.round(b), Math.round(al * 255)], k);
    }
  }
  return out;
}

/** Per-channel difference weighted by alpha (colour of nearly transparent pixels hardly matters). */
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray): { max: number; mean: number } {
  let max = 0;
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const wa = Math.max(a[i + 3], b[i + 3]) / 255;
    for (let c = 0; c < 4; c++) {
      const d = c === 3 ? Math.abs(a[i + c] - b[i + c]) : Math.abs(a[i + c] - b[i + c]) * wa;
      max = Math.max(max, d);
      total += d;
    }
  }
  return { max, mean: total / a.length };
}

const CASES: Array<[string, Annotation]> = [
  ['rectangle with fill and stroke', { id: 'r', type: 'rect', x: 8.5, y: 6.25, width: 30, height: 20, strokeColor: '#000', strokeWidth: 3, fillColor: '#00ff00' }],
  ['negative-size rectangle', { id: 'r2', type: 'rect', x: 40, y: 30, width: -25, height: -15, strokeColor: 'red', strokeWidth: 2 }],
  ['rotated, half-transparent rectangle', { id: 'r3', type: 'rect', x: 20, y: 10, width: 24, height: 14, strokeColor: '#000', strokeWidth: 2, fillColor: 'rgba(0, 0, 255, 0.5)', rotation: 25, opacity: 0.8 }],
  ['circle', { id: 'c', type: 'circle', x: 30, y: 24, radiusX: 15, radiusY: 15, strokeColor: '#ff8800', strokeWidth: 4, fillColor: '#00ff00' }],
  ['line', { id: 'l', type: 'line', x: 4, y: 40, endX: 58, endY: 9, strokeColor: '#000', strokeWidth: 3 }],
  ['arrow', { id: 'a', type: 'arrow', x: 6, y: 8, endX: 52, endY: 36, strokeColor: 'red', strokeWidth: 2 }],
  ['pen stroke', { id: 'p', type: 'pen', x: 0, y: 0, points: [{ x: 5, y: 5 }, { x: 20, y: 30 }, { x: 35, y: 12 }, { x: 55, y: 40 }], strokeColor: '#000', strokeWidth: 5 }],
];

describe('annotations migrate to shape layers that render the same', () => {
  it.each(CASES)('%s', (_name, annotation) => {
    const layer = annotationLayerFor(annotation, CANVAS) as ShapeLayer;
    expect(layer.type).toBe('shape');
    expect(layer.annotation).toBe(annotation);
    const ours = readRegion(layer.surface, { x: 0, y: 0, width: W, height: H });
    const diff = compare(ours, reference(annotation));
    // The reference samples 16 × 16 points per pixel, so its edges are within 1/32 of the truth.
    expect(diff.max).toBeLessThanOrEqual(6);
    expect(diff.mean).toBeLessThan(0.05);
  });

  it('keeps text, image and unreadable-colour annotations as annotation layers', () => {
    expect(annotationLayerFor({ id: 't', type: 'text', x: 1, y: 1, text: 'hi', fontSize: 12, color: 'red' }, CANVAS).type).toBe('annotation');
    expect(annotationLayerFor({ id: 'i', type: 'image', x: 1, y: 1, width: 4, height: 4, src: 'data:x' }, CANVAS).type).toBe('annotation');
    expect(annotationLayerFor({ id: 'v', type: 'rect', x: 1, y: 1, width: 4, height: 4, strokeColor: 'var(--accent)', strokeWidth: 1 }, CANVAS).type).toBe('annotation');
    // Without a canvas size (no render target) nothing is migrated.
    expect(annotationLayerFor({ id: 'r', type: 'rect', x: 1, y: 1, width: 4, height: 4, strokeColor: '#000', strokeWidth: 1 }).type).toBe('annotation');
  });
});

describe('old documents and the annotation API', () => {
  const annotations: Annotation[] = [
    { id: 'a1', type: 'rect', x: 1, y: 2, width: 30, height: 14, strokeColor: '#000', strokeWidth: 2, fillColor: '#00ff00' },
    { id: 'a2', type: 'text', x: 5, y: 6, text: 'hi', fontSize: 12, color: 'red' },
    { id: 'a3', type: 'arrow', x: 3, y: 40, endX: 50, endY: 20, strokeColor: 'red', strokeWidth: 2, blend: 'multiply' },
  ];

  it('loads v1 / v2 annotations as shape layers and writes the document back byte for byte', () => {
    for (const version of [1, 2] as const) {
      const doc = migrateSerializedImageEditorState({
        version,
        crop: null,
        transform: { rotate: 0, flipH: false, flipV: false },
        adjustments: version === 2 ? { ...ADJ, layers: [{ id: 'l1', kind: 'invert', enabled: true, opacity: 0.5, blend: 'normal', params: {} }] } : ADJ,
        depthMask: DEPTH,
        annotations,
      } as LegacySerializedImageEditorState) as LegacySerializedImageEditorState;
      const c = controllerFor(doc);
      expect(c.getLayers().map((l) => l.type)).toEqual(version === 2 ? ['pixel', 'adjustment', 'shape', 'annotation', 'shape'] : ['pixel', 'shape', 'annotation', 'shape']);
      // The arrow keeps its multiply blend, now on the layer.
      expect(c.getLayers().at(-1)!.blend).toBe('multiply');
      expect(c.getState().annotations).toEqual(annotations);
      expect(JSON.stringify(c.toJSON())).toBe(JSON.stringify(doc));
    }
  });

  it('draws migrated top layers through the crisp annotation overlay, as before', () => {
    const c = controllerFor({ version: 1, crop: null, transform: { rotate: 0, flipH: false, flipV: false }, adjustments: ADJ, depthMask: DEPTH, annotations });
    const split = splitOverlayAnnotations(c.getLayers());
    expect(split.composite.map((l) => l.type)).toEqual(['pixel']);
    expect(split.overlay.map((l) => l.annotation)).toEqual(annotations);
  });

  it('updateAnnotation, removeAnnotation and selectedAnnotationId keep working on migrated shapes', () => {
    const c = controllerFor({ version: 1, crop: null, transform: { rotate: 0, flipH: false, flipV: false }, adjustments: ADJ, depthMask: DEPTH, annotations });
    c.selectAnnotation('a1');
    c.updateAnnotation('a1', { x: 10, width: 20 });
    const layer = c.getLayer('a1') as ShapeLayer;
    expect(layer.type).toBe('shape');
    expect(layer.annotation).toMatchObject({ x: 10, width: 20 });
    expect(c.getShapeLayer('a1').components[0].live).toMatchObject({ kind: 'rect', x: 10, width: 20 });
    expect(c.getState().annotations[0]).toMatchObject({ id: 'a1', x: 10, width: 20 });
    expect(c.getState().selectedAnnotationId).toBe('a1');
    // A colour a shape can't hold turns it back into an annotation layer.
    c.updateAnnotation('a1', { strokeColor: 'var(--x)' } as Partial<Annotation>);
    expect(c.getLayer('a1')!.type).toBe('annotation');
    c.updateAnnotation('a1', { strokeColor: '#000' } as Partial<Annotation>);
    expect(c.getLayer('a1')!.type).toBe('shape');
    c.removeAnnotation('a3');
    expect(c.getLayer('a3')).toBeUndefined();
    c.clearAnnotations();
    expect(c.getLayers().map((l) => l.type)).toEqual(['pixel']);
  });

  it('a shape edit makes the layer a shape of its own (it leaves the annotations view)', () => {
    const c = controllerFor({ version: 1, crop: null, transform: { rotate: 0, flipH: false, flipV: false }, adjustments: ADJ, depthMask: DEPTH, annotations });
    c.setShapeStyle('a1', { fill: '#ff0000' });
    expect((c.getLayer('a1') as ShapeLayer).annotation).toBeUndefined();
    expect(c.getState().annotations.map((a) => a.id)).toEqual(['a2', 'a3']);
    expect(c.toJSON().version).toBe(3);
  });

  it('loads v3 annotation layers as shape layers and keeps them through a v3 round trip', () => {
    const c = controllerFor();
    const pixel = c.addPixelLayer({ name: 'Paint' });
    c.addAnnotation({ type: 'circle', x: 20, y: 20, radiusX: 8, radiusY: 5, strokeColor: '#000', strokeWidth: 1 });
    const json = c.toJSON() as SerializedLayeredImageEditorState;
    expect(json.version).toBe(3);
    // As an older version wrote it: an annotation layer.
    const shapeIndex = json.layers.findIndex((l) => l.type === 'shape');
    const s = json.layers[shapeIndex] as Extract<SerializedLayeredImageEditorState['layers'][number], { type: 'shape' }>;
    const old = { ...json, layers: json.layers.map((l, i) => (i === shapeIndex ? { id: s.id, name: s.name, visible: true, opacity: 0.7, blend: 'normal', type: 'annotation', annotation: s.annotation! } : l)) } as SerializedLayeredImageEditorState;
    const d = controllerFor();
    d.loadJSON(old);
    expect(d.lastLoadProblems).toEqual([]);
    const migrated = d.getLayer(s.id) as ShapeLayer;
    expect(migrated).toMatchObject({ type: 'shape', opacity: 0.7, annotation: s.annotation });
    expect(d.getLayer(pixel)!.type).toBe('pixel');
    d.loadJSON(json);
    expect(JSON.stringify(d.toJSON())).toBe(JSON.stringify(json));
  });
});
