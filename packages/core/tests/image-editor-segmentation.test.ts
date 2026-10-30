import { describe, it, expect, vi } from 'vitest';
import {
  ImageEditorController,
  createImageSegmentationToolProvider,
  segmentToSelection,
  segmentsToSelection,
  selectionArea,
  type SegmentationProvider,
  type SegmentationRequest,
  planOutlineTrace,
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

  it('needs a provider and a description', async () => {
    const c = controllerWith(null);
    await expect(c.selectSubject('dog')).rejects.toThrow(/segmentation provider/);
    c.setSegmentationProvider({ segment: async () => [] });
    expect(c.segmentationProvider).not.toBeNull();
    await expect(c.selectSubject('   ')).rejects.toThrow(/Describe/);
  });
});

describe('createImageSegmentationToolProvider', () => {
  it('offers select_subject only while a provider is set, and plays it in the select panel', async () => {
    const c = controllerWith(null);
    const provider = createImageSegmentationToolProvider(c, { id: 'img' });
    const list = () => (typeof provider.tools === 'function' ? provider.tools() : provider.tools);
    expect(list()).toEqual([]);

    c.setSegmentationProvider({ segment: async () => [{ label: 'cat', polygon: square(1, 1, 3) }] });
    const [tool] = list();
    expect(tool.name).toBe('select_subject');
    expect(tool.plan?.({ target: 'the cat' })?.[0]).toEqual({ type: 'open', ref: { kind: 'panel', id: 'select' } });
    const out: any = await tool.handler({ target: 'the cat', maxSegments: 1 }, {} as never);
    expect(out).toMatchObject({ empty: false, bounds: { x: 1, y: 1, width: 3, height: 3 }, found: [{ label: 'cat' }] });
    await expect(Promise.resolve().then(() => tool.handler({ target: '' }, {} as never))).rejects.toThrow(/target/);
  });

  it('traces what the model found under playback before selecting it', async () => {
    const c = controllerWith({ segment: async () => [{ label: 'cat', polygon: square(1, 1, 3) }] });
    const [tool] = (() => {
      const p = createImageSegmentationToolProvider(c, { id: 'img' });
      return typeof p.tools === 'function' ? p.tools() : p.tools;
    })();
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
