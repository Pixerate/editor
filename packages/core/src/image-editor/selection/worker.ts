/**
 * Running the long selections (Select Subject, Object Selection, Focus Area, Select Sky, Quick
 * Selection strokes and the Select and Mask preview) off the page in a Web Worker, with progress
 * and cancelling.
 *
 * - `runSelectionJob` does one job synchronously; the worker and the page's fallback both use it.
 * - `startSelectionWorker` answers jobs inside a worker (the `selection-worker` entry calls it).
 * - `SelectionWorkerClient` sends jobs from the page. The image is sent once per pixel buffer and
 *   kept in the worker; masks travel as their bounds and bytes. Cancelling terminates the worker
 *   (a running job can't be interrupted otherwise) and the next job starts a fresh one.
 */

import type { CropBox, ImagePoint } from '../types';
import { createSelectionMask, selectionFromRegion, type PixelBuffer, type SelectionMask } from './mask';
import { refineSelection, type RefineEdgeParams } from './refine';
import { applyRefineEdits, type RefineEdit } from './refine-edits';
import { focusArea, type FocusAreaOptions } from './segment/focus';
import { selectObjectIn, type ObjectTarget } from './segment/grabcut';
import { quickSelectStroke } from './segment/quick';
import { findSky, type SkyOptions } from './segment/sky';
import { findSubject } from './segment/subject';
import type { SelectionProgress } from './segment/work';
import { contentAwareFill } from '../../paint/heal';

/** A selection as plain data: its size, bounds and the bytes inside the bounds. */
export interface SerializedMask {
  width: number;
  height: number;
  bounds: CropBox | null;
  bytes: Uint8Array;
}

export function serializeMask(mask: SelectionMask): SerializedMask {
  const b = mask.bounds;
  if (!b) return { width: mask.width, height: mask.height, bounds: null, bytes: new Uint8Array(0) };
  const bytes = new Uint8Array(b.width * b.height);
  const data = mask.data;
  for (let y = 0; y < b.height; y++) bytes.set(data.subarray((b.y + y) * mask.width + b.x, (b.y + y) * mask.width + b.x + b.width), y * b.width);
  return { width: mask.width, height: mask.height, bounds: { ...b }, bytes };
}

export function deserializeMask(s: SerializedMask): SelectionMask {
  return s.bounds ? selectionFromRegion(s.width, s.height, s.bounds, s.bytes) : createSelectionMask(s.width, s.height);
}

/** One long selection, as data. */
export type SelectionJob =
  | { op: 'subject'; enhanceEdge?: boolean }
  | { op: 'object'; target: ObjectTarget; enhanceEdge?: boolean }
  | { op: 'focus'; options?: Omit<FocusAreaOptions, 'onProgress'> }
  | { op: 'sky'; options?: Omit<SkyOptions, 'onProgress'> }
  | { op: 'quick'; stroke: ImagePoint[]; size?: number; grow?: boolean; enhanceEdge?: boolean; selection?: SerializedMask | null }
  | { op: 'refine-preview'; base: SerializedMask | null; edits: RefineEdit[]; params: RefineEdgeParams }
  /** Content-Aware Fill's synthesis on a window (the pixels): `hole` to fill, `exclude` not to copy from. */
  | { op: 'fill'; hole: Uint8Array; exclude: Uint8Array | null; seed: number };

/** What a job found: a selection of the whole image, and the job's notes. */
export interface SelectionJobResult {
  mask: SelectionMask;
  /** Why nothing was selected (subject, sky). */
  reason?: string;
  /** Focus Area: the noise level it measured. */
  noiseLevel?: number;
  /** Content-Aware Fill: the window's pixels with the hole filled (RGBA). */
  pixels?: Uint8ClampedArray;
}

/** Runs `job` on `pixels` here and now. */
export function runSelectionJob(job: SelectionJob, pixels: PixelBuffer, onProgress?: SelectionProgress): SelectionJobResult {
  switch (job.op) {
    case 'subject': {
      const { selection, reason } = findSubject(pixels, { enhanceEdge: job.enhanceEdge, onProgress });
      return { mask: selection, reason };
    }
    case 'object':
      return { mask: selectObjectIn(pixels, job.target, { enhanceEdge: job.enhanceEdge, onProgress }) };
    case 'focus': {
      const { selection, noiseLevel } = focusArea(pixels, { ...job.options, onProgress });
      return { mask: selection, noiseLevel };
    }
    case 'sky': {
      const { selection, reason } = findSky(pixels, { ...job.options, onProgress });
      return { mask: selection, reason };
    }
    case 'quick':
      return {
        mask: quickSelectStroke(pixels, job.stroke, {
          size: job.size,
          grow: job.grow,
          enhanceEdge: job.enhanceEdge,
          selection: job.selection ? deserializeMask(job.selection) : null,
        }),
      };
    case 'fill': {
      onProgress?.(0, 'Filling');
      const filled = contentAwareFill(pixels.width, pixels.height, 4, pixels.data, job.hole, {
        seed: job.seed,
        exclude: job.exclude,
        onProgress: (f) => onProgress?.(f * 0.99, 'Filling'),
      });
      onProgress?.(1, 'Done');
      return { mask: createSelectionMask(1, 1), pixels: Uint8ClampedArray.from(filled) };
    }
    case 'refine-preview': {
      onProgress?.(0, 'Refining');
      const base = job.base ? deserializeMask(job.base) : null;
      const { selection, refineBrush } = applyRefineEdits(pixels, base, job.edits, pixels.width, pixels.height);
      const mask = selection?.bounds ? refineSelection(pixels, selection, job.params, refineBrush) : createSelectionMask(pixels.width, pixels.height);
      onProgress?.(1, 'Done');
      return { mask };
    }
  }
}

/** Messages from the page to the worker. */
export type SelectionWorkerRequest = { type: 'pixels'; key: number; pixels: PixelBuffer } | { type: 'job'; id: number; key: number; job: SelectionJob };

/** Messages from the worker to the page. */
export type SelectionWorkerResponse =
  | { type: 'progress'; id: number; fraction: number; stage: string }
  | { type: 'done'; id: number; mask: SerializedMask; reason?: string; noiseLevel?: number; pixels?: Uint8ClampedArray }
  | { type: 'error'; id: number; message: string };

/**
 * The part of a worker (or its global scope) the protocol uses; a DOM `Worker` is one. The event
 * parameters are loose so a `Worker`'s `MessageEvent` / `ErrorEvent` handlers fit.
 */
export interface SelectionWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
  terminate?(): void;
}

/** Makes a fresh selection worker, e.g. `() => new SelectionWorker()` with Vite's `?worker`. */
export type SelectionWorkerFactory = () => SelectionWorkerLike;

/** Answers selection jobs inside a worker: `scope` is the worker's global (`self`). */
export function startSelectionWorker(scope: SelectionWorkerLike): void {
  // The last two images, so a preview copy and the full image can alternate.
  const images = new Map<number, PixelBuffer>();
  scope.onmessage = (event: { data: unknown }) => {
    const msg = event.data as SelectionWorkerRequest;
    if (msg.type === 'pixels') {
      images.set(msg.key, msg.pixels);
      while (images.size > 2) images.delete(images.keys().next().value!);
      return;
    }
    const pixels = images.get(msg.key);
    try {
      if (!pixels) throw new Error('The selection worker has no image for this job; send the pixels first.');
      const result = runSelectionJob(msg.job, pixels, (fraction, stage) => scope.postMessage({ type: 'progress', id: msg.id, fraction, stage } satisfies SelectionWorkerResponse));
      const mask = serializeMask(result.mask);
      const transfer: Transferable[] = [mask.bytes.buffer];
      if (result.pixels) transfer.push(result.pixels.buffer);
      scope.postMessage({ type: 'done', id: msg.id, mask, reason: result.reason, noiseLevel: result.noiseLevel, pixels: result.pixels } satisfies SelectionWorkerResponse, transfer);
    } catch (err) {
      scope.postMessage({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) } satisfies SelectionWorkerResponse);
    }
  };
}

const abortError = () => (typeof DOMException === 'function' ? new DOMException('The selection was cancelled.', 'AbortError') : Object.assign(new Error('The selection was cancelled.'), { name: 'AbortError' }));

interface Pending {
  resolve: (r: SelectionJobResult) => void;
  reject: (e: unknown) => void;
  onProgress?: SelectionProgress;
}

/** Sends selection jobs to a worker made by `factory`, one worker at a time. */
export class SelectionWorkerClient {
  private worker: SelectionWorkerLike | null = null;
  /** Pixel buffers this worker already has, by their data array. */
  private sent = new WeakMap<object, number>();
  private nextKey = 1;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly factory: SelectionWorkerFactory) {}

  /** Runs `job` on `pixels` in the worker. Aborting `signal` terminates the worker and rejects with an `AbortError`. */
  run(job: SelectionJob, pixels: PixelBuffer, options: { signal?: AbortSignal; onProgress?: SelectionProgress } = {}): Promise<SelectionJobResult> {
    if (options.signal?.aborted) return Promise.reject(abortError());
    const worker = this.ensure();
    let key = this.sent.get(pixels.data as object);
    if (key === undefined) {
      key = this.nextKey++;
      this.sent.set(pixels.data as object, key);
      worker.postMessage({ type: 'pixels', key, pixels: { width: pixels.width, height: pixels.height, data: pixels.data } } satisfies SelectionWorkerRequest);
    }
    const id = this.nextId++;
    return new Promise<SelectionJobResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: options.onProgress });
      options.signal?.addEventListener(
        'abort',
        () => {
          if (this.pending.has(id)) this.terminate(abortError());
        },
        { once: true }
      );
      worker.postMessage({ type: 'job', id, key: key!, job } satisfies SelectionWorkerRequest);
    });
  }

  /** Stops the worker; jobs still running reject with `reason` (default an `AbortError`). */
  terminate(reason: unknown = abortError()): void {
    this.worker?.terminate?.();
    this.worker = null;
    this.sent = new WeakMap();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(reason);
  }

  private ensure(): SelectionWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.factory();
    worker.onmessage = (event: { data: unknown }) => {
      const msg = event.data as SelectionWorkerResponse;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.onProgress?.(msg.fraction, msg.stage);
      else {
        this.pending.delete(msg.id);
        if (msg.type === 'error') p.reject(new Error(msg.message));
        else p.resolve({ mask: deserializeMask(msg.mask), reason: msg.reason, noiseLevel: msg.noiseLevel, pixels: msg.pixels });
      }
    };
    worker.onerror = (event: { message?: string } | undefined) => this.terminate(new Error(event?.message || 'The selection worker failed.'));
    this.worker = worker;
    return worker;
  }
}
