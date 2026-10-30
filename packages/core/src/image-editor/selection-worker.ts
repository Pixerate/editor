/**
 * The selection worker's entry: load it as a module worker and give the controller a factory, e.g.
 * with Vite
 *
 *   import SelectionWorker from '@pixerate/editor/image-editor/selection-worker?worker';
 *   controller.setSelectionWorker(() => new SelectionWorker());
 *
 * Outside a worker (Node, a page importing it by mistake) it does nothing. It also exports
 * `startSelectionWorker`, for a host that writes its own worker file.
 */

import { startSelectionWorker, type SelectionWorkerLike } from './selection/worker';

export { startSelectionWorker };

declare const self: unknown;
declare const window: unknown;

if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof (self as { postMessage?: unknown }).postMessage === 'function') {
  startSelectionWorker(self as SelectionWorkerLike);
}
