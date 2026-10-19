import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_LAYER_ID,
  ImageEditorController,
  TILE,
  encodeSelectionRle,
  isLegacyShape,
  loadImageEditorDocument,
  migrateSerializedImageEditorState,
  migrateToLayeredState,
  readRegion,
  surfaceFromPixels,
  writeRegion,
  type AdjustmentLayerNode,
  type AnnotationLayer,
  type ImageLayer,
  type LegacySerializedImageEditorState,
  type PixelLayer,
  type SerializedImageEditorState,
  type SerializedLayeredImageEditorState,
} from '../src/image-editor';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const W = 64;
const H = 48;

function source(seed = 1) {
  const r = rng(seed);
  return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : Math.floor(r() * 256))) };
}

/** A controller over a W × H canvas without a DOM (the Background's pixels come from `setSamplePixels`). */
function controllerFor(initialState?: Partial<SerializedImageEditorState>) {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, initialState });
  c.setSamplePixels(source());
  return c;
}

const DEPTH = { enabled: false, maskSource: null, mode: 'threshold' as const, depthRange: [0, 255] as [number, number], softness: 10, invert: false };

function legacyDoc(seed: number): LegacySerializedImageEditorState {
  const r = rng(seed);
  const maskBytes = new Uint8Array(W * H).map((_, i) => ((i % W) < W / 2 ? 255 : (i * 7) & 255));
  const doc: LegacySerializedImageEditorState = {
    version: 1,
    crop: r() < 0.5 ? null : { x: 2, y: 3, width: 20, height: 10 },
    transform: { rotate: [0, 90, 180, 270][Math.floor(r() * 4)], flipH: r() < 0.5, flipV: false },
    adjustments: {
      brightness: Math.round(r() * 40),
      contrast: 0,
      saturation: -5,
      exposure: 0,
      temperature: 3,
      blur: r() < 0.5 ? 0 : 3,
      opacity: r() < 0.8 ? 1 : 0.5,
      ...(r() < 0.5 ? {} : { tint: 4, process: 2 as const }),
    },
    depthMask: r() < 0.5 ? DEPTH : { ...DEPTH, enabled: r() < 0.5, maskSource: 'data:depth', mode: 'brightness', depthRange: [10, 200], softness: 4, invert: true },
    annotations:
      r() < 0.5
        ? []
        : [
            { id: 'a1', type: 'rect', x: 1, y: 2, width: 3, height: 4, strokeColor: '#000', strokeWidth: 2 },
            { id: 'a2', type: 'text', x: 5, y: 6, text: 'hi', fontSize: 12, color: 'red', blend: 'multiply' },
          ],
  };
  if (r() < 0.6) {
    doc.version = 2;
    doc.adjustments.layers = [
      { id: 'l1', kind: 'invert', enabled: true, opacity: 0.5, blend: 'normal', params: {} },
      {
        id: 'l2',
        kind: 'vibrance',
        name: 'Pop',
        enabled: r() < 0.5,
        opacity: 1,
        blend: 'soft-light',
        params: { vibrance: 30, saturation: 0 },
        mask: { width: W, height: H, rle: encodeSelectionRle(maskBytes), ...(r() < 0.5 ? { density: 0.5, feather: 2 } : {}) },
      },
    ];
  }
  return migrateSerializedImageEditorState(doc) as LegacySerializedImageEditorState;
}

describe('schema v3 and migration', () => {
  it('lifts v1 / v2 into the layer stack (Background, adjustment layers, annotation layers)', () => {
    const doc = legacyDoc(2);
    doc.adjustments.layers = legacyDoc(5).adjustments.layers ?? legacyDoc(6).adjustments.layers;
    doc.annotations = legacyDoc(1).annotations.length ? legacyDoc(1).annotations : legacyDoc(3).annotations;
    const c = controllerFor(doc);
    const layers = c.getLayers();
    expect(layers[0]).toMatchObject({ type: 'pixel', id: BACKGROUND_LAYER_ID, name: 'Background', source: 'document' });
    expect((layers[0] as PixelLayer).filters?.[0]).toMatchObject({ kind: 'develop', brightness: doc.adjustments.brightness });
    const kinds = layers.map((l) => l.type);
    expect(kinds.indexOf('annotation')).toBeGreaterThan(kinds.lastIndexOf('adjustment'));
    // The compatibility views read the same values back.
    const s = c.getState();
    expect(s.adjustments.brightness).toBe(doc.adjustments.brightness);
    expect(s.adjustments.layers?.map((l) => l.id)).toEqual(doc.adjustments.layers?.map((l) => l.id));
    expect(s.annotations.map((a) => a.id)).toEqual(doc.annotations.map((a) => a.id));
  });

  it('writes old-shape documents back as v1 / v2 byte for byte', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const doc = legacyDoc(seed);
      const c = controllerFor();
      c.loadJSON(doc);
      expect(JSON.stringify(c.toJSON())).toBe(JSON.stringify(doc));
      // …and through `initialState`, and after undo / redo.
      expect(JSON.stringify(controllerFor(doc).toJSON())).toBe(JSON.stringify(doc));
      c.setAdjustments({ brightness: 77 });
      c.undo();
      expect(JSON.stringify(c.toJSON())).toBe(JSON.stringify(doc));
    }
  });

  it('switches to v3 once the stack leaves the old shape, and back when it returns', () => {
    const c = controllerFor(legacyDoc(4));
    expect(c.toJSON().version).toBeLessThan(3);
    const before = JSON.stringify(c.toJSON());
    // Hiding the Background is not expressible in v1 / v2.
    const layers = c.getLayers();
    (c.getState() as { layers: ImageLayer[] }).layers = [{ ...layers[0], visible: false } as ImageLayer, ...layers.slice(1)];
    expect(c.toJSON().version).toBe(3);
    (c.getState() as { layers: ImageLayer[] }).layers = layers;
    expect(JSON.stringify(c.toJSON())).toBe(before);
  });

  it('round-trips layered documents (pixels, masks, groups, filters, annotations) through v3', () => {
    const c = controllerFor(legacyDoc(8));
    const r = rng(9);
    const paint = new Uint8ClampedArray(30 * 20 * 4).map((_, i) => (i % 4 === 3 ? Math.floor(r() * 256) : Math.floor(r() * 256)));
    const pixel: PixelLayer = {
      type: 'pixel',
      id: 'paint',
      name: 'Paint',
      visible: true,
      opacity: 0.7,
      blend: 'multiply',
      surface: surfaceFromPixels({ width: 30, height: 20, data: paint }, 4, -5, 300),
      offset: { x: 7, y: -290 },
      fillOpacity: 0.5,
      filters: [{ id: 'f', kind: 'blur', enabled: true, radius: 2 }],
      mask: { surface: writeRegion(surfaceFromPixels({ width: 1, height: 1, data: [0] }, 1, 0, 0, 255), { x: 0, y: 0, width: 3, height: 1 }, [0, 100, 200]), defaultValue: 255, density: 0.8 },
      locks: { position: true },
    };
    const group: ImageLayer = {
      type: 'group',
      id: 'g',
      name: 'Group',
      visible: true,
      opacity: 0.9,
      blend: 'pass-through',
      children: [pixel, { ...(c.getLayers().find((l) => l.type === 'adjustment') ?? pixel), clipped: true } as ImageLayer],
      collapsed: true,
    };
    (c.getState() as { layers: ImageLayer[] }).layers = [...c.getLayers().filter((l) => l.type !== 'adjustment'), group];
    c.setActiveLayer('paint');
    const json = c.toJSON() as SerializedLayeredImageEditorState;
    expect(json.version).toBe(3);
    expect(json.width).toBe(W);
    expect(Object.keys(json.assets).length).toBe(2);
    expect(json.layers[0]).toMatchObject({ source: 'document' });
    expect(json.layers[0]).not.toHaveProperty('asset');
    // Through a JSON string and the document loader, as an app would store it.
    const loaded = loadImageEditorDocument(JSON.stringify(json));
    expect(loaded.report.problems).toEqual([]);
    const d = controllerFor();
    d.loadJSON(loaded.state);
    expect(d.lastLoadProblems).toEqual([]);
    expect(JSON.stringify(d.toJSON())).toBe(JSON.stringify(json));
    const p = d.getLayer('paint') as PixelLayer;
    expect(readRegion(p.surface, { x: -5, y: 300, width: 30, height: 20 })).toEqual(paint);
    expect(p.mask && readRegion(p.mask.surface, { x: 0, y: 0, width: 4, height: 1 })).toEqual(new Uint8ClampedArray([0, 100, 200, 255]));
    expect(d.getState().activeLayerId).toBe('paint');
    // Pixels composite the same after the round trip.
    expect(d.compositePixels().data).toEqual(c.compositePixels().data);
  });

  it('reports unreadable layers and assets but loads the rest', () => {
    const c = controllerFor();
    c.loadJSON({
      version: 3,
      width: W,
      height: H,
      layers: [
        { type: 'pixel', id: 'a', name: 'A', visible: true, opacity: 1, blend: 'normal', offset: { x: 0, y: 0 }, asset: 'missing' },
        { type: 'pixel', id: 'b', name: 'B', visible: true, opacity: 1, blend: 'normal', offset: { x: 0, y: 0 }, asset: 'bad' },
        { type: 'adjustment', id: 'c', name: 'C', visible: true, opacity: 1, blend: 'normal', kind: 'nope', params: {} },
        { type: 'annotation', id: 'n', name: 'N', visible: true, opacity: 1, blend: 'normal', annotation: { id: 'n', type: 'line', x: 0, y: 0, endX: 4, endY: 4, strokeColor: '#f00', strokeWidth: 2 } },
      ],
      assets: { bad: 'data:image/png;base64,AAAA' },
      activeLayerId: 'zzz',
      crop: null,
      transform: { rotate: 0, flipH: false, flipV: false },
      opacity: 1,
    } as SerializedLayeredImageEditorState);
    expect(c.getLayers().map((l) => l.id)).toEqual(['a', 'b', 'n']);
    expect(c.lastLoadProblems).toHaveLength(3);
    expect(c.getState().activeLayerId).toBeNull();
    expect(c.getState().annotations.map((a) => a.id)).toEqual(['n']);
  });

  it('migrateToLayeredState lifts any version into v3', () => {
    const doc = legacyDoc(12);
    const v3 = migrateToLayeredState(doc, { width: W, height: H });
    expect(v3.version).toBe(3);
    expect(v3.layers[0]).toMatchObject({ id: BACKGROUND_LAYER_ID, source: 'document' });
    const c = controllerFor();
    c.loadJSON(v3);
    // A v3 document of the old shape is written back in the old schema.
    expect(JSON.stringify(c.toJSON())).toBe(JSON.stringify(doc));
    expect(migrateToLayeredState(v3, { width: 1, height: 1 })).toEqual(migrateSerializedImageEditorState(v3));
  });
});

describe('compatibility API over layers', () => {
  it('base sliders edit the Background develop filter; blur is a filter or the migrated output blur', () => {
    const c = controllerFor();
    c.setAdjustments({ exposure: 20, blur: 5, opacity: 0.4 });
    const bg = c.getLayer(BACKGROUND_LAYER_ID) as PixelLayer;
    expect(bg.filters?.map((f) => f.kind)).toEqual(['develop', 'blur']);
    expect(c.getState().outputOpacity).toBe(0.4);
    expect(c.getState().adjustments).toMatchObject({ exposure: 20, blur: 5, opacity: 0.4 });
    c.setAdjustments({ blur: 0 });
    expect((c.getLayer(BACKGROUND_LAYER_ID) as PixelLayer).filters?.map((f) => f.kind)).toEqual(['develop']);
    // A migrated document with layers and blur keeps blurring after the layers.
    const m = controllerFor({ version: 2, adjustments: { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, blur: 4, opacity: 1, layers: [{ id: 'l', kind: 'invert', enabled: true, opacity: 1, blend: 'normal', params: {} }] } });
    expect(m.getState().legacyOutputBlur).toBe(4);
    m.setAdjustments({ blur: 6 });
    expect(m.getState().legacyOutputBlur).toBe(6);
    expect((m.getLayer(BACKGROUND_LAYER_ID) as PixelLayer).filters?.some((f) => f.kind === 'blur')).toBe(false);
  });

  it('new adjustment layers go below the annotations, as before; index and moves count adjustment layers', () => {
    const c = controllerFor(legacyDoc(1).annotations.length ? legacyDoc(1) : legacyDoc(3));
    const ann = c.addAnnotation({ type: 'line', x: 0, y: 0, endX: 3, endY: 3, strokeColor: '#000', strokeWidth: 1 });
    const a = c.addAdjustmentLayer('invert');
    const b = c.addAdjustmentLayer('posterize');
    const types = c.getLayers().map((l) => l.type);
    expect(types.slice(-c.getState().annotations.length).every((t) => t === 'annotation')).toBe(true);
    const ids = () => c.getAdjustmentLayers().map((l) => l.id);
    expect(ids().slice(-2)).toEqual([a, b]);
    const first = c.addAdjustmentLayer('threshold', 0);
    expect(ids()[0]).toBe(first);
    expect(c.moveAdjustmentLayer(first, ids().length - 1)).toBe(true);
    expect(ids()[ids().length - 1]).toBe(first);
    // Explicit placement anywhere in the stack.
    const above = c.addAdjustmentLayer({ kind: 'invert', aboveId: ann });
    expect(c.getLayers().at(-1)!.id).toBe(above);
    expect(c.toJSON().version).toBe(3);
  });

  it('annotations are layers; the annotation API keeps working', () => {
    const c = controllerFor();
    const id = c.addAnnotation({ type: 'text', x: 1, y: 1, text: 'Hello', fontSize: 10, color: '#000' });
    expect(c.getLayers().at(-1)).toMatchObject({ type: 'annotation', id, name: 'Hello' });
    c.updateAnnotation(id, { text: 'Bye' } as never);
    expect((c.getLayer(id) as AnnotationLayer).name).toBe('Bye');
    expect(c.getState().annotations[0]).toMatchObject({ text: 'Bye' });
    c.removeAnnotation(id);
    expect(c.getLayers().some((l) => l.id === id)).toBe(false);
    c.undo();
    expect(c.getState().annotations.map((a) => a.id)).toEqual([id]);
    c.clearAnnotations();
    expect(c.getState().annotations).toEqual([]);
  });

  it('the depth mask is a parametric mask on the Background', () => {
    const c = controllerFor();
    c.setDepthMask({ enabled: true, maskSource: 'data:d' });
    const bg = c.getLayer(BACKGROUND_LAYER_ID) as PixelLayer;
    expect(bg.mask?.source).toMatchObject({ enabled: true, maskSource: 'data:d' });
    expect(c.getState().depthMask).toMatchObject({ enabled: true, maskSource: 'data:d' });
    expect(isLegacyShape({ layers: c.getLayers(), outputOpacity: 1 })).toBe(true);
    c.resetDepthMask();
    expect((c.getLayer(BACKGROUND_LAYER_ID) as PixelLayer).mask).toBeUndefined();
  });

  it('adjustment layer masks are tiled surfaces; selections convert both ways', () => {
    const c = controllerFor();
    const id = c.addAdjustmentLayer('invert');
    c.selectRect({ x: 2, y: 2, width: 10, height: 5 });
    expect(c.applySelectionAsLayerMask(id, { density: 0.5 })).toBe(true);
    const node = c.getLayer(id) as AdjustmentLayerNode;
    expect(node.mask?.density).toBe(0.5);
    expect(c.getAdjustmentLayer(id)?.mask).toMatchObject({ width: W, height: H, density: 0.5 });
    c.deselect();
    expect(c.selectionFromLayerMask(id)).toBe(true);
    expect(c.getSelection()?.bounds).toEqual({ x: 2, y: 2, width: 10, height: 5 });
  });
});

describe('history over immutable layers', () => {
  it('undo and redo restore whole stacks, sharing untouched layers and tiles', () => {
    const c = controllerFor();
    const big = { width: TILE * 2, height: TILE };
    const paint: PixelLayer = {
      type: 'pixel',
      id: 'p',
      name: 'P',
      visible: true,
      opacity: 1,
      blend: 'normal',
      surface: surfaceFromPixels({ ...big, data: new Uint8ClampedArray(big.width * big.height * 4).map((_, i) => i & 255) }, 4),
      offset: { x: 0, y: 0 },
    };
    (c.getState() as { layers: ImageLayer[] }).layers = [...c.getLayers(), paint];
    const s0 = c.getLayers();
    c.setAdjustments({ exposure: 10 });
    const s1 = c.getLayers();
    expect(s1[1]).toBe(s0[1]); // the pixel layer is shared, not copied
    c.undo();
    expect(c.getLayers()).toBe(s0);
    c.redo();
    expect(c.getLayers()).toBe(s1);
    expect(c.historyBytes).toBe(0); // no tile is held only by history
  });

  it('counts tiles held only by history and drops the oldest steps over maxHistoryBytes', () => {
    const fake = { width: TILE, height: TILE, naturalWidth: TILE, naturalHeight: TILE } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake, maxHistoryBytes: TILE * TILE * 4 * 2.5 });
    const surfaceWith = (v: number) => surfaceFromPixels({ width: TILE, height: TILE, data: new Uint8ClampedArray(TILE * TILE * 4).map((_, i) => (i * v) & 255) }, 4);
    const layer = (v: number): PixelLayer => ({ type: 'pixel', id: 'p', name: 'P', visible: true, opacity: 1, blend: 'normal', surface: surfaceWith(v), offset: { x: 0, y: 0 } });
    (c.getState() as { layers: ImageLayer[] }).layers = [layer(1)];
    for (let v = 2; v <= 6; v++) {
      // A step that replaces the layer's only tile (what a stroke does).
      c.setAdjustments({ exposure: v });
      (c.getState() as { layers: ImageLayer[] }).layers = [layer(v)];
    }
    c.setAdjustments({ exposure: 99 }); // the next step trims
    expect(c.historyBytes).toBeLessThanOrEqual(TILE * TILE * 4 * 2.5);
    let undos = 0;
    while (c.undo()) undos++;
    expect(undos).toBeLessThan(5);
  });
});
