---
'@pixerate/editor': minor
'@pixerate/editor-react': minor
'@pixerate/editor-svelte': minor
---

The long selections can run in a Web Worker, and they report progress and can be cancelled. This covers Select Subject without a model, Object Selection, Focus Area, Select Sky, Quick Selection strokes and the Select and Mask preview.

- **Using a worker:** pass a factory as the `selectionWorker` option or to `controller.setSelectionWorker`, e.g. with Vite `import SelectionWorker from '@pixerate/editor/image-editor/selection-worker?worker'` and `() => new SelectionWorker()`. The new `./image-editor/selection-worker` entry starts the worker side. Without a worker, the jobs run on the page as before.
- **Images:** the image is sent to the worker once per pixel buffer and kept there.
- **Progress:** the algorithms report their stages through `onProgress` (`SelectionProgress`). The controller methods accept `onProgress` and `signal`.
- **Cancelling:** cancelling terminates the worker and rejects with an `AbortError`, leaving the selection unchanged; the next job starts a fresh worker. The agent tools pass the tool call's signal.
- **UI:** React and Svelte show a progress bar with the current stage and a Cancel button for Select Subject, Select Sky and Focus Area. The Select and Mask workspace shows "Updating preview…" while the worker computes it.
- **New exports:** `SelectionWorkerClient`, `startSelectionWorker`, `runSelectionJob`, `serializeMask`, `deserializeMask`, `controller.runSelectionJob` and `hasSelectionWorker`, and the types `SelectionJob`, `SelectionJobResult`, `SelectionWorkerLike`, `SelectionWorkerFactory`, `SerializedMask` and `SelectionProgress`.
