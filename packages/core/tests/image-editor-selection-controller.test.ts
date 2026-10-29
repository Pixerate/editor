// The selection-mixing cases are re-expressed from photocraft/crates/algo/src/tests_selection_mix.rs
// (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, it, expect, vi } from 'vitest';
import {
  ImageEditorController,
  ImageEditorRenderer,
  applyAdjustmentLayers,
  adjustmentLayersKey,
  buildLayerMaskPlanes,
  createAdjustmentLayer,
  decodeLayerMask,
  layerMaskCoverage,
  layerMaskFromSelection,
  loadImageEditorDocument,
  normalizeAdjustmentLayer,
  projectMaskCoverage,
  rectSelection,
  serializeSelection,
  createImageEditorToolProvider,
  SelectionGesture,
  startMarchingAnts,
  MARCHING_ANTS_STEP_MS,
  DEFAULT_SELECTION_TOOL_OPTIONS,
  type SelectionToolOptions,
  type PixelBuffer,
} from '../src/image-editor';

function img(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): PixelBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

/** A controller over a w×h image whose pixels the selection tools sample directly. */
function controllerWith(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
  const image = { width: w, height: h, naturalWidth: w, naturalHeight: h, src: '' } as unknown as HTMLImageElement;
  const controller = new ImageEditorController({ image });
  controller.setSamplePixels(img(w, h, f));
  return controller;
}

const twoSquares = (x: number) => ((x >= 2 && x < 6) || (x >= 12 && x < 16) ? [255, 0, 0, 255] : [255, 255, 255, 255]) as [number, number, number, number];

describe('controller selection', () => {
  it('magic wand with modes is undoable step by step', async () => {
    const c = controllerWith(20, 10, twoSquares);
    expect(c.getSelection()).toBeNull();
    await c.magicWand({ x: 3, y: 3 }, { tolerance: 10, antiAlias: false });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 4, height: 10 });
    await c.magicWand({ x: 13, y: 3 }, { tolerance: 10, antiAlias: false, mode: 'add' });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 14, height: 10 });
    c.selectRect({ x: 0, y: 0, width: 20, height: 5 }, { mode: 'intersect', antiAlias: false });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 14, height: 5 });
    c.undo();
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 14, height: 10 });
    c.undo();
    c.undo();
    expect(c.getSelection()).toBeNull();
    c.redo();
    expect(c.getSelection()!.bounds!.width).toBe(4);
    // No-ops record nothing.
    const depth = (c as any).undoStack.length;
    await c.magicWand({ x: 3, y: 3 }, { tolerance: 10, antiAlias: false });
    expect((c as any).undoStack.length).toBe(depth);
    expect(c.deselect()).toBe(true);
    expect(c.deselect()).toBe(false);
  });

  it('select all, inverse, modify and colour range', async () => {
    const c = controllerWith(20, 10, twoSquares);
    c.selectAll();
    expect(c.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    c.invertSelection();
    expect(c.getSelection()).toBeNull();
    c.invertSelection();
    expect(c.getSelection()!.bounds!.width).toBe(20);
    await c.selectColorRange([{ color: '#ff0000' }], { fuzziness: 0 });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 14, height: 10 });
    c.selectRect({ x: 5, y: 3, width: 4, height: 4 }, { antiAlias: false });
    expect(c.modifySelection('grow', 1)).toBe(true);
    expect(c.getSelection()!.bounds).toEqual({ x: 4, y: 2, width: 6, height: 6 });
    c.deselect();
    expect(c.modifySelection('grow', 1)).toBe(false);
  });

  it('samples the adjusted image with sampleMerged', async () => {
    // Left half black, right half dark grey: an Invert + Threshold stack makes them identical.
    const c = controllerWith(10, 4, (x) => (x < 5 ? [0, 0, 0, 255] : [40, 40, 40, 255]));
    await c.magicWand({ x: 0, y: 0 }, { tolerance: 8, antiAlias: false });
    expect(c.getSelection()!.bounds!.width).toBe(5);
    c.addAdjustmentLayer({ kind: 'threshold', params: { level: 128 } });
    await c.magicWand({ x: 0, y: 0 }, { tolerance: 8, antiAlias: false, sampleMerged: true });
    expect(c.getSelection()!.bounds!.width).toBe(10);
  });

  it('loads an AI mask of another size and refines it to the image edge', async () => {
    const w = 64;
    const h = 48;
    const c = controllerWith(w, h, (x) => (x < 30 ? [230, 200, 40, 255] : [20, 40, 120, 255]));
    // A quarter-resolution mask whose edge is at 9/16 of the width (x = 36) instead of 30.
    const mask = img(16, 12, (x) => (x < 9 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    await c.loadSelectionFromImage(mask);
    const edgeAt = () => {
      const s = c.getSelection()!;
      for (let x = w - 1; x >= 0; x--) if (s.data[24 * w + x] >= 128) return x + 1;
      return 0;
    };
    expect(Math.abs(edgeAt() - 36)).toBeLessThanOrEqual(1);
    await c.refineSelection({ radius: 12, contrast: 50 });
    expect(Math.abs(edgeAt() - 30)).toBeLessThan(Math.abs(36 - 30));
    // Refining needs pixels.
    const bare = new ImageEditorController();
    bare.selectAll();
    await expect(bare.refineSelection({ radius: 4 })).rejects.toThrow(/pixels/);
  });

  it('quick mask is view state only', () => {
    const c = controllerWith(4, 4, () => [0, 0, 0, 255]);
    c.setQuickMask(true);
    expect(c.getState().quickMask).toBe(true);
    expect(c.canUndo).toBe(false);
  });
});

describe('selection serialisation', () => {
  it('selection-free documents serialise exactly as before', () => {
    const c = new ImageEditorController();
    const json = c.toJSON();
    expect('selection' in json).toBe(false);
    expect(JSON.stringify(json)).toBe(
      JSON.stringify({
        version: 1,
        crop: null,
        transform: { rotate: 0, flipH: false, flipV: false },
        adjustments: { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, blur: 0, opacity: 1, process: 2 },
        depthMask: { enabled: false, maskSource: null, mode: 'threshold', depthRange: [0, 255], softness: 10, invert: false },
        annotations: [],
      })
    );
    const loaded = loadImageEditorDocument(json);
    expect('selection' in loaded.state).toBe(false);
    expect(loaded.report.problems).toEqual([]);
  });

  it('round-trips a selection through toJSON / loadJSON / the document loader', () => {
    const c = controllerWith(30, 20, () => [0, 0, 0, 255]);
    c.selectEllipse({ x: 3, y: 2, width: 20, height: 12 });
    const json = JSON.parse(JSON.stringify(c.toJSON()));
    expect(json.version).toBe(1);
    expect(json.selection.rle.startsWith('r1:')).toBe(true);
    const d = controllerWith(30, 20, () => [0, 0, 0, 255]);
    d.loadJSON(json);
    expect(d.getSelection()!.data).toEqual(c.getSelection()!.data);
    d.undo();
    expect(d.getSelection()).toBeNull();
    const fromInitial = new ImageEditorController({ initialState: json });
    expect(fromInitial.getSelection()!.bounds).toEqual(c.getSelection()!.bounds);

    const doc = loadImageEditorDocument(JSON.stringify(json));
    expect(doc.state.selection).toEqual(json.selection);
    const damaged = loadImageEditorDocument({ ...json, selection: { width: 30, height: 20, rle: 'r1:AAAA' } });
    expect(damaged.report.problems.map((p) => p.section)).toEqual(['selection']);
    expect('selection' in damaged.state).toBe(false);
    // Loading a document without a selection clears the current one.
    d.loadJSON({ ...json, selection: undefined });
    expect(d.getSelection()).toBeNull();
  });
});

describe('layer masks', () => {
  it('mask-free layers serialise without a mask key; masked ones keep it', () => {
    const plain = createAdjustmentLayer('invert', { id: 'a' });
    expect('mask' in plain).toBe(false);
    const sel = rectSelection(10, 10, { x: 0, y: 0, width: 5, height: 10 });
    const masked = normalizeAdjustmentLayer({ ...plain, mask: { ...layerMaskFromSelection(sel), density: 2, feather: -3, extra: 1 } })!;
    expect(masked.mask).toEqual({ width: 10, height: 10, rle: serializeSelection(sel).rle });
    expect(normalizeAdjustmentLayer({ ...plain, mask: { width: 10, height: 10, rle: 'bogus' } })!.mask).toBeUndefined();
    expect(adjustmentLayersKey([plain])).not.toBe(adjustmentLayersKey([masked]));
    const soft = normalizeAdjustmentLayer({ ...plain, mask: { ...masked.mask!, density: 0.5, feather: 2, enabled: false } })!;
    expect(soft.mask).toMatchObject({ density: 0.5, feather: 2, enabled: false });
    expect(adjustmentLayersKey([soft])).not.toBe(adjustmentLayersKey([masked]));
  });

  it('applies the selection as a mask, edits density / feather, loads it back, all undoable', () => {
    const c = controllerWith(20, 10, twoSquares);
    const id = c.addAdjustmentLayer('invert');
    expect(c.applySelectionAsLayerMask(id)).toBe(false);
    c.selectRect({ x: 0, y: 0, width: 10, height: 10 }, { antiAlias: false });
    expect(c.applySelectionAsLayerMask(id, { density: 0.25 })).toBe(true);
    const json = c.toJSON();
    expect(json.version).toBe(2);
    expect(json.adjustments.layers![0].mask).toMatchObject({ width: 20, height: 10, density: 0.25 });
    expect(c.setAdjustmentLayerMaskProps(id, { feather: 3 })).toBe(true);
    expect(c.getAdjustmentLayer(id)!.mask).toMatchObject({ density: 0.25, feather: 3 });
    c.deselect();
    expect(c.selectionFromLayerMask(id)).toBe(true);
    expect(c.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    c.undo();
    c.undo();
    c.undo();
    expect(c.getAdjustmentLayer(id)!.mask!.density).toBe(0.25);
    expect(c.getAdjustmentLayer(id)!.mask!.feather).toBeUndefined();
    expect(c.setAdjustmentLayerMask(id, null)).toBe(true);
    expect(c.getAdjustmentLayer(id)!.mask).toBeUndefined();
    // Reload keeps the mask.
    const d = new ImageEditorController();
    d.loadJSON(json);
    expect(decodeLayerMask(d.getAdjustmentLayer(id)!.mask!)!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('mask coverage mixes the layer per pixel, with exact endpoints (photocraft selection mixing)', () => {
    const layer = createAdjustmentLayer('invert', { id: 'inv' });
    const data = new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 255, 200, 100, 50, 255, 200, 100, 50, 0]);
    applyAdjustmentLayers({ data }, [layer], new Map([['inv', [0, 1, 0.5, 1]]]));
    expect(Array.from(data.slice(0, 4))).toEqual([200, 100, 50, 255]);
    expect(Array.from(data.slice(4, 8))).toEqual([55, 155, 205, 255]);
    expect(Array.from(data.slice(8, 12))).toEqual([128, 128, 128, 255]);
    // Transparent pixels and alpha are left alone.
    expect(Array.from(data.slice(12))).toEqual([200, 100, 50, 0]);
    // Without masks, exactly the old path.
    const a = new Uint8ClampedArray([10, 20, 30, 255]);
    const b = new Uint8ClampedArray([10, 20, 30, 255]);
    applyAdjustmentLayers({ data: a }, [layer]);
    applyAdjustmentLayers({ data: b }, [layer], new Map());
    expect(a).toEqual(b);
  });

  it('density and feather shape the effective coverage', () => {
    const sel = rectSelection(20, 1, { x: 0, y: 0, width: 10, height: 1 }, { antiAlias: false });
    const dense = layerMaskCoverage(layerMaskFromSelection(sel, { density: 0.5 }))!;
    expect(dense[0]).toBe(1);
    expect(dense[15]).toBe(0.5);
    const feathered = layerMaskCoverage(layerMaskFromSelection(sel, { feather: 2 }))!;
    expect(feathered[9]).toBeGreaterThan(0.5);
    expect(feathered[9]).toBeLessThan(1);
    expect(feathered[10]).toBeLessThan(0.5);
    expect(feathered[10]).toBeGreaterThan(0);
    expect(layerMaskCoverage(layerMaskFromSelection(sel, { enabled: false }))).toBeNull();
  });

  it('projects masks through crop, rotation and flips like the image', () => {
    // An 8×4 mask covering the left half; crop to x 2..8, rotate 90° (base is 4×6), flip H.
    const w = 8;
    const h = 4;
    const cov = new Float32Array(w * h);
    for (let i = 0; i < cov.length; i++) cov[i] = i % w < 4 ? 1 : 0;
    const region = { x: 2, y: 0, width: 6, height: 4 };
    const projection = { region, angle: 90, flipH: false, flipV: false, scale: 1, originX: 2, originY: 3 };
    const out = projectMaskCoverage(cov, w, h, w, h, projection, 4, 6);
    // After a 90° clockwise turn the image's left (x 2..3 selected) ends up at the top rows.
    const row = (y: number) => Array.from(out.slice(y * 4, y * 4 + 4)).map((v) => Math.round(v));
    expect(row(0)).toEqual([1, 1, 1, 1]);
    expect(row(1)).toEqual([1, 1, 1, 1]);
    expect(row(2)).toEqual([0, 0, 0, 0]);
    expect(row(5)).toEqual([0, 0, 0, 0]);
    // A half-resolution mask maps the same way.
    const half = new Float32Array(4 * 2);
    for (let i = 0; i < half.length; i++) half[i] = i % 4 < 2 ? 1 : 0;
    const out2 = projectMaskCoverage(half, 4, 2, w, h, projection, 4, 6);
    expect(Math.round(out2[0])).toBe(1);
    expect(Math.round(out2[5 * 4])).toBe(0);
    // Mask-free stacks build no planes at all.
    expect(buildLayerMaskPlanes([createAdjustmentLayer('invert')], w, h, projection, 4, 6)).toBeUndefined();
  });
});

describe('selection overlay rendering', () => {
  it('draws marching ants along the outline, nothing with selectionDisplay none', async () => {
    const calls: { name: string; args: any[] }[] = [];
    const ctx: any = { lineWidth: 1 };
    for (const m of ['clearRect', 'save', 'restore', 'translate', 'scale', 'rotate', 'drawImage', 'beginPath', 'stroke', 'moveTo', 'lineTo', 'rect', 'clip', 'closePath', 'setLineDash', 'fillRect', 'strokeRect']) {
      ctx[m] = (...args: any[]) => calls.push({ name: m, args });
    }
    const target = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const source = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10, src: '' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: source });
    c.selectRect({ x: 2, y: 3, width: 4, height: 2 }, { antiAlias: false });
    const renderer = new ImageEditorRenderer();
    await renderer.renderToCanvas(target, source, c.getState(), { viewportWidth: 200, viewportHeight: 100 });
    const moves = calls.filter((k) => k.name === 'moveTo').map((k) => k.args);
    expect(moves).toEqual(expect.arrayContaining([[2, 3], [2, 5], [2, 3], [6, 3]]));
    expect(calls.filter((k) => k.name === 'stroke').length).toBe(2);
    calls.length = 0;
    await renderer.renderToCanvas(target, source, c.getState(), { viewportWidth: 200, viewportHeight: 100, selectionDisplay: 'none' });
    expect(calls.some((k) => k.name === 'moveTo')).toBe(false);
  });

  it('keeps the ants one screen pixel wide under a host scale and dashes them from antsOffset', async () => {
    const widths: number[] = [];
    const offsets: number[] = [];
    const ctx: any = {};
    let lineWidth = 1;
    Object.defineProperty(ctx, 'lineWidth', { get: () => lineWidth, set: (v) => (lineWidth = v) });
    Object.defineProperty(ctx, 'lineDashOffset', { get: () => 0, set: (v) => offsets.push(v) });
    for (const m of ['clearRect', 'save', 'restore', 'translate', 'scale', 'rotate', 'drawImage', 'beginPath', 'moveTo', 'lineTo', 'rect', 'clip', 'closePath', 'setLineDash', 'fillRect', 'strokeRect', 'setTransform']) {
      ctx[m] = () => {};
    }
    ctx.stroke = () => widths.push(lineWidth);
    const target = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    const source = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10, src: '' } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: source });
    c.selectRect({ x: 2, y: 3, width: 4, height: 2 }, { antiAlias: false });
    const renderer = new ImageEditorRenderer();
    await renderer.renderToCanvas(target, source, c.getState(), { viewportWidth: 200, viewportHeight: 100 });
    const plain = widths.slice(-2);
    widths.length = 0;
    await renderer.renderToCanvas(target, source, c.getState(), { viewportWidth: 200, viewportHeight: 100, hostScale: 3, antsOffset: 2 });
    const scaled = widths.slice(-2);
    // A host zoomed 3× draws the line a third as wide in CSS pixels: still one pixel on screen.
    expect(scaled[0]).toBeCloseTo(plain[0] / 3);
    expect(offsets.at(-1)).toBeCloseTo(-2 * scaled[0]);
  });
});

describe('marching ants', () => {
  it('steps the dash offset until stopped', () => {
    vi.useFakeTimers();
    try {
      const ticks: number[] = [];
      const stop = startMarchingAnts((o) => ticks.push(o));
      vi.advanceTimersByTime(MARCHING_ANTS_STEP_MS * 9);
      expect(ticks).toEqual([1, 2, 3, 4, 5, 6, 7, 0, 1]);
      stop();
      vi.advanceTimersByTime(MARCHING_ANTS_STEP_MS * 4);
      expect(ticks.length).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands still when reduced motion is requested', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }));
    try {
      const tick = vi.fn();
      const stop = startMarchingAnts(tick);
      vi.advanceTimersByTime(MARCHING_ANTS_STEP_MS * 5);
      expect(tick).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe('selection gestures', () => {
  function setup(tool: SelectionToolOptions['tool'], extra: Partial<SelectionToolOptions> = {}) {
    const c = controllerWith(20, 10, twoSquares);
    const options: SelectionToolOptions = { ...DEFAULT_SELECTION_TOOL_OPTIONS, tool, antiAlias: false, ...extra };
    return { c, g: new SelectionGesture(c, () => options), options };
  }

  it('wand clicks select at once; Shift adds and Alt subtracts', async () => {
    const { c, g } = setup('wand', { tolerance: 10 });
    await g.begin({ x: 3, y: 3 });
    expect(g.active).toBe(false);
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 4, height: 10 });
    await g.begin({ x: 13, y: 3 }, { shiftKey: true });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 0, width: 14, height: 10 });
    await g.begin({ x: 3, y: 3 }, { altKey: true });
    expect(c.getSelection()!.bounds).toEqual({ x: 12, y: 0, width: 4, height: 10 });
    // Errors are reported, not thrown.
    const bare = new SelectionGesture(new ImageEditorController(), () => DEFAULT_SELECTION_TOOL_OPTIONS);
    await bare.begin({ x: 1, y: 1 });
    expect(bare.error).toMatch(/pixels/);
  });

  it('rectangle and ellipse drags show a draft and commit; a click deselects', async () => {
    const { c, g, options } = setup('rect');
    await g.begin({ x: 8, y: 6 });
    expect(g.draftPath).toBeNull();
    expect(g.move({ x: 2, y: 2 })).toBe(true);
    expect(g.draftPath).toHaveLength(4);
    expect(g.end({ x: 2, y: 1 })).toBe(true);
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 1, width: 6, height: 5 });
    options.tool = 'ellipse';
    await g.begin({ x: 0, y: 0 });
    g.move({ x: 20, y: 10 });
    expect(g.draftPath!.length).toBeGreaterThan(16);
    g.end(undefined, { shiftKey: true, altKey: true });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 1, width: 6, height: 5 });
    await g.begin({ x: 5, y: 5 });
    expect(g.end({ x: 5, y: 5 })).toBe(true);
    expect(c.getSelection()).toBeNull();
  });

  it('lasso collects a path and closes it; cancel abandons', async () => {
    const { c, g } = setup('lasso');
    await g.begin({ x: 1, y: 1 });
    g.move({ x: 1.2, y: 1.1 });
    g.move({ x: 11, y: 1 });
    g.move({ x: 11, y: 9 });
    expect(g.draftPath).toHaveLength(3);
    g.end({ x: 1, y: 9 });
    expect(c.getSelection()!.bounds).toEqual({ x: 1, y: 1, width: 10, height: 8 });
    await g.begin({ x: 0, y: 0 });
    g.move({ x: 5, y: 5 });
    g.cancel();
    expect(g.active).toBe(false);
    expect(g.end({ x: 9, y: 9 })).toBe(false);
  });
});

describe('selection agent tools', () => {
  it('select, modify, refine and mask through the image editor tool provider', async () => {
    const c = controllerWith(20, 10, twoSquares);
    const provider = createImageEditorToolProvider(c);
    const tool = (name: string) => provider.tools.find((t) => t.name === name)!;
    expect(provider.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['get_selection', 'select_region', 'select_by_color', 'modify_selection', 'refine_selection', 'apply_selection_as_mask'])
    );
    expect(await tool('get_selection').handler({}, {} as never)).toMatchObject({ empty: true, area: 0 });
    const wand: any = await tool('select_by_color').handler({ x: 3, y: 3, tolerance: 10 }, {} as never);
    expect(wand.bounds).toEqual({ x: 1, y: 0, width: 6, height: 10 });
    const range: any = await tool('select_by_color').handler({ color: '#ff0000', fuzziness: 0, mode: 'replace' }, {} as never);
    expect(range.area).toBe(80);
    const rect: any = await tool('select_region').handler({ shape: 'rect', x: 0, y: 0, width: 10, height: 5, mode: 'intersect' }, {} as never);
    expect(rect.area).toBe(4 * 5);
    const grown: any = await tool('modify_selection').handler({ op: 'grow', radius: 1 }, {} as never);
    expect(grown.bounds).toEqual({ x: 1, y: 0, width: 6, height: 6 });
    await tool('refine_selection').handler({ radius: 2 }, {} as never);
    const masked: any = await tool('apply_selection_as_mask').handler({ kind: 'invert', density: 0.5 }, {} as never);
    expect(masked.kind).toBe('invert');
    expect(masked.mask).toMatchObject({ width: 20, height: 10, density: 0.5 });
    expect(c.getAdjustmentLayer(masked.layerId)!.mask).toBeDefined();
    await expect(Promise.resolve().then(() => tool('select_region').handler({ shape: 'rect' }, {} as never))).rejects.toThrow(/numeric/);
    // The lasso: a triangle traced around the left square.
    const lasso: any = await tool('select_region').handler(
      { shape: 'polygon', points: [{ x: 2, y: 0 }, { x: 6, y: 0 }, { x: 2, y: 10 }] },
      {} as never
    );
    expect(lasso.bounds).toMatchObject({ x: 2, y: 0 });
    expect(lasso.area).toBeGreaterThan(15);
    expect(lasso.area).toBeLessThan(25);
    await expect(Promise.resolve().then(() => tool('select_region').handler({ shape: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, {} as never))).rejects.toThrow(/at least 3/);
    await tool('select_region').handler({ shape: 'none' }, {} as never);
    await expect(Promise.resolve().then(() => tool('modify_selection').handler({ op: 'grow', radius: 1 }, {} as never))).rejects.toThrow(/Nothing/);
  });
});
