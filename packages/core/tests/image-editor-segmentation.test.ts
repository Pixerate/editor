import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  createImageEditorToolProvider,
  createImageSegmentationToolProvider,
  segmentToSelection,
  segmentsToSelection,
  selectionArea,
  type SegmentationProvider,
  type SegmentationRequest,
  planOutlineTrace,
  createImageSubjectSelectionTool,
} from '../src/image-editor';
import type { PlaybackStep } from '../src/tools';

const fakeImage = (w: number, h: number) =>
  ({ width: w, height: h, naturalWidth: w, naturalHeight: h, src: '' }) as unknown as HTMLImageElement;

/** A controller whose export is stubbed (no canvas in Node). */
function controllerWith(provider: SegmentationProvider | null, w = 20, h = 10) {
  const controller = new ImageEditorController({ image: fakeImage(w, h), segmentation: provider });
  vi.spyOn(controller, 'toDataURL').mockResolvedValue('data:image/png;base64,AAAA');
  return controller;
}

const square = (x: number, y: number, s: number) => [
  { x, y },
  { x: x + s, y },
  { x: x + s, y: y + s },
  { x, y: y + s },
];

describe('segmentToSelection', () => {
  it('fills a polygon, adds several rings and a whole-image mask', () => {
    const one = segmentToSelection(20, 10, { polygon: square(2, 2, 4) })!;
    expect(one.bounds).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    expect(selectionArea(one)).toBeCloseTo(16);

    const two = segmentToSelection(20, 10, { polygon: [square(0, 0, 2), square(10, 0, 2)] })!;
    expect(selectionArea(two)).toBeCloseTo(8);

    // A 10×5 mask (white right half) resampled onto the 20×10 image, added to the polygon.
    const data = new Uint8ClampedArray(10 * 5 * 4);
    for (let y = 0; y < 5; y++) for (let x = 5; x < 10; x++) data.set([255, 255, 255, 255], (y * 10 + x) * 4);
    const withMask = segmentToSelection(20, 10, { polygon: square(0, 0, 2), mask: { width: 10, height: 5, data } })!;
    expect(withMask.bounds).toMatchObject({ x: 0, y: 0, height: 10 });
    expect(selectionArea(withMask)).toBeGreaterThan(90);
  });

  it('ignores results without a usable shape', () => {
    expect(segmentToSelection(20, 10, { polygon: [{ x: 0, y: 0 }, { x: 1, y: 1 }] })).toBeNull();
    expect(segmentToSelection(20, 10, { label: 'nothing' })).toBeNull();
    expect(segmentsToSelection(20, 10, [])).toBeNull();
  });
});

describe('ImageEditorController.selectSubject', () => {
  it('sends the flattened image and target, and selects the outlines as one undo step', async () => {
    const requests: SegmentationRequest[] = [];
    const provider: SegmentationProvider = {
      segment: async (req) => {
        requests.push(req);
        return [{ label: 'dog', polygon: square(2, 2, 4), score: 0.9 }, { label: 'empty' }];
      },
    };
    const c = controllerWith(provider);
    const { segments } = await c.selectSubject('  the dog ', { maxSegments: 1 });
    expect(requests[0]).toMatchObject({ image: 'data:image/png;base64,AAAA', width: 20, height: 10, target: 'the dog', maxSegments: 1 });
    expect(segments).toEqual([{ label: 'dog', bounds: { x: 2, y: 2, width: 4, height: 4 }, score: 0.9 }]);
    expect(c.getSelection()?.bounds).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    c.undo();
    expect(c.getSelection()).toBeNull();
  });

  it('combines by mode, and leaves the selection when nothing is found', async () => {
    let result = [{ polygon: square(0, 0, 4) }];
    const c = controllerWith({ segment: async () => result });
    c.selectRect({ x: 2, y: 0, width: 8, height: 4 }, { antiAlias: false });
    await c.selectSubject('x', { mode: 'subtract' });
    expect(c.getSelection()?.bounds).toEqual({ x: 4, y: 0, width: 6, height: 4 });
    result = [];
    const before = c.getSelection();
    expect((await c.selectSubject('nothing')).segments).toEqual([]);
    expect(c.getSelection()).toBe(before);
  });

  it('needs a description with a provider, and falls back to the salient subject without one', async () => {
    const c = controllerWith(null);
    // A dark square in the middle of a light image.
    const data = new Uint8ClampedArray(20 * 10 * 4).fill(230);
    for (let y = 3; y < 7; y++) for (let x = 8; x < 12; x++) data.set([30, 30, 30, 255], (y * 20 + x) * 4);
    c.setSamplePixels({ width: 20, height: 10, data });
    const out = await c.selectSubject('dog');
    expect(out).toMatchObject({ method: 'saliency', segments: [{ label: 'subject' }] });
    expect(out.note).toMatch(/"dog" was not used/);
    expect(c.getSelection()!.bounds).toEqual({ x: 8, y: 3, width: 4, height: 4 });
    c.setSegmentationProvider({ segment: async () => [] });
    expect(c.segmentationProvider).not.toBeNull();
    await expect(c.selectSubject('   ')).rejects.toThrow(/Describe/);
  });
});

describe('createImageSegmentationToolProvider', () => {
  it('is deprecated: select_subject is in the image editor provider, with or without a model', async () => {
    const c = controllerWith(null);
    const provider = createImageSegmentationToolProvider(c, { id: 'img' });
    expect(typeof provider.tools === 'function' ? provider.tools() : provider.tools).toEqual([]);
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const name = registry.listTools().tools.map((t) => t.name).find((n) => n.endsWith('select_subject'))!;
    expect(name).toBeTruthy();
    // Without a model the description isn't needed.
    const data = new Uint8ClampedArray(20 * 10 * 4).fill(230);
    for (let y = 3; y < 7; y++) for (let x = 8; x < 12; x++) data.set([30, 30, 30, 255], (y * 20 + x) * 4);
    c.setSamplePixels({ width: 20, height: 10, data });
    const plain: any = await registry.callTool(name, {});
    expect(plain.structuredContent).toMatchObject({ empty: false, method: 'saliency', found: [{ label: 'subject' }] });
    expect(plain.structuredContent.note).toMatch(/No segmentation model/);
    c.setSegmentationProvider({ segment: async () => [{ label: 'cat', polygon: square(1, 1, 3) }] });
    const res: any = await registry.callTool(name, { target: 'the cat', maxSegments: 1 });
    expect(res.structuredContent).toMatchObject({ empty: false, bounds: { x: 1, y: 1, width: 3, height: 3 }, found: [{ label: 'cat' }], method: 'model' });
    const missing: any = await registry.callTool(name, { target: '' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/target must describe/);
  });

  it('traces what the model found under playback before selecting it', async () => {
    const c = controllerWith({ segment: async () => [{ label: 'cat', polygon: square(1, 1, 3) }] });
    const tool = createImageSubjectSelectionTool(c);
    const performed: PlaybackStep[][] = [];
    const selectedWhenTraced: boolean[] = [];
    await tool.handler({ target: 'the cat' }, {
      perform: async (steps: readonly PlaybackStep[]) => {
        selectedWhenTraced.push(Boolean(c.getState().selection?.bounds));
        performed.push([...steps]);
      },
    } as never);
    expect(selectedWhenTraced).toEqual([false]);
    const [steps] = performed;
    expect(steps[0]).toEqual({ type: 'move', to: { x: 1, y: 1 } });
    expect(steps[1]).toEqual({ type: 'press', gesture: 'path' });
    // Closed: the trace returns to where it started.
    expect(steps.at(-2)).toMatchObject({ type: 'drag', to: { x: 1, y: 1 } });
    expect(c.getState().selection?.bounds).toEqual({ x: 1, y: 1, width: 3, height: 3 });
  });

  it('passes the outlines (or a mask result\'s bounds) to beforeApply', async () => {
    const mask = { width: 20, height: 10, data: new Uint8ClampedArray(20 * 10 * 4) };
    for (let y = 2; y < 6; y++) for (let x = 10; x < 14; x++) mask.data.set([255, 255, 255, 255], (y * 20 + x) * 4);
    const c = controllerWith({ segment: async () => [{ polygon: square(1, 1, 3) }, { mask }] });
    const seen: unknown[] = [];
    await c.selectSubject('things', { beforeApply: (outlines) => void seen.push(outlines) });
    expect(seen).toHaveLength(1);
    const [outlines] = seen as { x: number; y: number }[][][];
    expect(outlines[0]).toEqual(square(1, 1, 3));
    expect(outlines[1]).toHaveLength(4);
  });
});

describe('planOutlineTrace', () => {
  it('traces each closed outline as a lasso drag, thinning long ones', () => {
    const ring = Array.from({ length: 100 }, (_, i) => ({ x: Math.cos(i / 16) * 10, y: Math.sin(i / 16) * 10 }));
    const steps = planOutlineTrace([square(0, 0, 4), ring, [{ x: 0, y: 0 }]], { maxPoints: 16 });
    const presses = steps.filter((s) => s.type === 'press');
    expect(presses).toEqual([{ type: 'press', gesture: 'path' }, { type: 'press', gesture: 'path' }]);
    expect(steps.filter((s) => s.type === 'drag').length).toBe(4 + 15);
    expect(planOutlineTrace([square(0, 0, 1), square(2, 0, 1)], { maxOutlines: 1 }).filter((s) => s.type === 'press')).toHaveLength(1);
  });
});

describe('the segmentation model behind Select Sky and Object Selection', () => {
  it('asks for the object in the box and keeps what lies mostly inside it', async () => {
    const requests: SegmentationRequest[] = [];
    const c = controllerWith({
      segment: async (req) => {
        requests.push(req);
        return [
          { label: 'cup', polygon: square(2, 2, 4) },
          { label: 'table', polygon: square(12, 2, 6) },
        ];
      },
    });
    const out = await c.selectObject({ rect: { x: 1, y: 1, width: 7, height: 7 } });
    expect(out.method).toBe('model');
    expect(requests[0]).toMatchObject({ box: { x: 1, y: 1, width: 7, height: 7 }, maxSegments: 4 });
    expect(c.getSelection()!.bounds).toEqual({ x: 2, y: 2, width: 4, height: 4 });
    // A point keeps the piece under it.
    const byPoint = await c.selectObject({ point: { x: 14, y: 4 } });
    expect(byPoint.method).toBe('model');
    expect(requests[1]).toMatchObject({ point: { x: 14, y: 4 } });
    expect(c.getSelection()!.bounds).toEqual({ x: 12, y: 2, width: 6, height: 6 });
  });

  it('falls back to GrabCut when nothing the model returns fits, or when asked not to use it', async () => {
    const segment = vi.fn(async () => [{ label: 'elsewhere', polygon: square(14, 1, 3) }]);
    const c = controllerWith({ segment });
    const data = new Uint8ClampedArray(20 * 10 * 4).fill(230);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) data.set([30, 30, 30, 255], (y * 20 + x) * 4);
    c.setSamplePixels({ width: 20, height: 10, data });
    expect((await c.selectObject({ rect: { x: 1, y: 1, width: 8, height: 8 } })).method).toBe('grabcut');
    expect(c.getSelection()!.bounds).toEqual({ x: 3, y: 3, width: 4, height: 4 });
    segment.mockClear();
    expect((await c.selectObject({ rect: { x: 1, y: 1, width: 8, height: 8 } }, { useModel: false })).method).toBe('grabcut');
    expect(segment).not.toHaveBeenCalled();
  });

  it('asks for the sky, says when the model finds none, and finds it classically when asked', async () => {
    const segment = vi.fn(async (req: SegmentationRequest) => (req.target === 'the sky' ? [{ label: 'sky', polygon: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 4 }, { x: 0, y: 4 }] }] : []));
    const c = controllerWith({ segment });
    expect(await c.selectSky()).toMatchObject({ method: 'model' });
    expect(c.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 20, height: 4 });
    segment.mockResolvedValueOnce([]);
    expect(await c.selectSky()).toMatchObject({ method: 'model', note: expect.stringMatching(/found no sky/) });
    // Classical: a plain brown image has no sky.
    c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(20 * 10 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 140 : 80)) });
    segment.mockClear();
    expect(await c.selectSky({ useModel: false })).toMatchObject({ method: 'classical', note: expect.stringMatching(/No sky/) });
    expect(segment).not.toHaveBeenCalled();
  });
});
