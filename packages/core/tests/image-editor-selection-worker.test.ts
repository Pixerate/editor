import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  SelectAndMaskSession,
  SelectionWorkerClient,
  createImageEditorToolProvider,
  deserializeMask,
  rectSelection,
  runSelectionJob,
  selectionArea,
  serializeMask,
  startSelectionWorker,
  type SelectionWorkerLike,
} from '../src/image-editor';

const W = 160;
const H = 120;

/** A dark disc of radius 35 at (80, 60) on a light ground. */
function disc() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.hypot(x + 0.5 - 80, y + 0.5 - 60) < 35 ? 40 : 220;
      data.set([v, v, v + 10, 255], (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data };
}
const DISC = Math.PI * 35 * 35;

/**
 * A worker that runs `startSelectionWorker` in this thread, with messages delivered on later
 * ticks as a real worker's are. Records what the page sent.
 */
function fakeWorkers() {
  const sent: any[] = [];
  let made = 0;
  const factory = (): SelectionWorkerLike => {
    made++;
    let alive = true;
    const page: SelectionWorkerLike = {
      onmessage: null,
      postMessage(message) {
        sent.push(message);
        setTimeout(() => alive && scope.onmessage?.({ data: structuredClone(message) }), 0);
      },
      terminate() {
        alive = false;
      },
    };
    const scope: SelectionWorkerLike = {
      onmessage: null,
      postMessage(message) {
        setTimeout(() => alive && page.onmessage?.({ data: message }), 0);
      },
    };
    startSelectionWorker(scope);
    return page;
  };
  return { factory, sent, made: () => made };
}

describe('selection worker', () => {
  it('round-trips a mask as bounds and bytes', () => {
    const m = rectSelection(W, H, { x: 10, y: 20, width: 30, height: 15 }, {});
    const s = serializeMask(m);
    expect(s.bounds).toEqual({ x: 10, y: 20, width: 30, height: 15 });
    expect(s.bytes.length).toBe(30 * 15);
    expect(selectionArea(deserializeMask(s))).toBe(selectionArea(m));
    expect(deserializeMask(serializeMask(deserializeMask({ width: 4, height: 4, bounds: null, bytes: new Uint8Array(0) }))).bounds).toBeNull();
  });

  it('runs a job in the worker with the same result as here, sending the pixels once, with progress', async () => {
    const workers = fakeWorkers();
    const client = new SelectionWorkerClient(workers.factory);
    const px = disc();
    const progress: number[] = [];
    const here = runSelectionJob({ op: 'subject' }, px);
    const there = await client.run({ op: 'subject' }, px, { onProgress: (f) => progress.push(f) });
    expect(selectionArea(there.mask)).toBe(selectionArea(here.mask));
    expect(Math.abs(selectionArea(there.mask) - DISC) / DISC).toBeLessThan(0.05);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    await client.run({ op: 'object', target: { rect: { x: 35, y: 15, width: 90, height: 90 } } }, px);
    expect(workers.sent.filter((m) => m.type === 'pixels')).toHaveLength(1);
  });

  it('cancels by terminating the worker, and starts a fresh one for the next job', async () => {
    const workers = fakeWorkers();
    const client = new SelectionWorkerClient(workers.factory);
    const px = disc();
    const abort = new AbortController();
    const job = client.run({ op: 'focus' }, px, { signal: abort.signal });
    abort.abort();
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
    const after = await client.run({ op: 'sky' }, px);
    expect(after.mask).toBeDefined();
    expect(workers.made()).toBe(2);
    // The fresh worker needed the pixels again.
    expect(workers.sent.filter((m) => m.type === 'pixels')).toHaveLength(2);
  });

  it('passes a job\'s error back', async () => {
    const client = new SelectionWorkerClient(fakeWorkers().factory);
    await expect(client.run({ op: 'quick', stroke: [] }, disc())).rejects.toThrow(/at least one point/);
  });
});

describe('the controller with a selection worker', () => {
  function setup() {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
    const workers = fakeWorkers();
    const c = new ImageEditorController({ image: fake, selectionWorker: workers.factory });
    c.setSamplePixels(disc());
    return { c, workers };
  }

  it('runs Select Subject, Quick Selection and Focus Area there, with progress', async () => {
    const { c, workers } = setup();
    expect(c.hasSelectionWorker).toBe(true);
    const progress: number[] = [];
    await c.selectSubject('', { onProgress: (f) => progress.push(f) });
    expect(Math.abs(selectionArea(c.getSelection()) - DISC) / DISC).toBeLessThan(0.05);
    expect(progress.at(-1)).toBe(1);
    await c.quickSelect([[{ x: 80, y: 60 }]], { size: 10 });
    expect(Math.abs(selectionArea(c.getSelection()) - DISC) / DISC).toBeLessThan(0.05);
    expect(workers.sent.filter((m) => m.type === 'job').map((m) => m.job.op)).toEqual(['subject', 'quick']);
    c.setSelectionWorker(null);
    expect(c.hasSelectionWorker).toBe(false);
  });

  it('leaves the selection alone when cancelled, from a tool call\'s signal too', async () => {
    const { c } = setup();
    c.selectRect({ x: 0, y: 0, width: 10, height: 10 });
    const abort = new AbortController();
    const pending = c.selectSky({ signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(c.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const tool = new AbortController();
    const res = registry.callTool('select_focus_area', {}, { signal: tool.signal });
    tool.abort();
    expect((await res).isError).toBe(true);
    expect(c.getSelection()!.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('computes the Select and Mask preview there', async () => {
    const { c, workers } = setup();
    const s = new SelectAndMaskSession(c);
    await s.open();
    s.update({ tool: 'brush', brushSize: 10, params: { radius: 0 } });
    s.begin({ x: 20, y: 20 });
    s.end();
    await s.idle();
    expect(s.coverageAt(20, 20)).toBe(1);
    expect(s.computing).toBe(false);
    expect(workers.sent.some((m) => m.type === 'job' && m.job.op === 'refine-preview')).toBe(true);
  });
});

describe('the selection-worker entry', () => {
  it('does nothing when imported outside a worker', async () => {
    await expect(import('../src/image-editor/selection-worker')).resolves.toBeDefined();
  });
});
