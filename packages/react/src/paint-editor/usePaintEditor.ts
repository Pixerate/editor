import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { PaintDirector, PaintEditorController, PaintPresence, createPaintEditorDocument, type PaintDirectorOptions, type PaintEditorOptions, type PaintEditorState, type SerializedPaintDocument } from '@pixerate/editor/paint-editor';
import type { EditorDocument } from '@pixerate/editor/persistence';

export interface UsePaintEditorReturn {
  controller: PaintEditorController;
  /** The controller's snapshot (a new object after every change). */
  state: PaintEditorState;
  /** The save / load / undo contract, with every image as an asset reference (for `useEditorAutosave` or `createDocumentToolProvider`). */
  editorDocument: EditorDocument<SerializedPaintDocument>;
}

/**
 * Creates a `PaintEditorController` once (from `options`, read on the first render) or uses the
 * one given, and re-renders on every change.
 */
export function usePaintEditor(options: PaintEditorOptions | PaintEditorController = {}): UsePaintEditorReturn {
  const [controller] = useState(() => (options instanceof PaintEditorController ? options : new PaintEditorController(options)));
  const state = usePaintEditorState(controller);
  const editorDocument = useMemo(() => createPaintEditorDocument(controller), [controller]);
  // Subscribing again reconnects it, so a StrictMode remount keeps working.
  useEffect(() => () => editorDocument.destroy(), [editorDocument]);
  return useMemo(() => ({ controller, state, editorDocument }), [controller, state, editorDocument]);
}

/** Subscribes to a controller's state. */
export function usePaintEditorState(controller: PaintEditorController): PaintEditorState {
  return useSyncExternalStore(
    (notify) => controller.subscribe(notify),
    () => controller.getState(),
    () => controller.getState()
  );
}

/**
 * A `PaintPresence` and `PaintDirector` for a paint editor: pass `presence` to `PaintEditor` (or
 * `PaintCanvas`) and `director` to `createPaintEditorToolProvider`, so agent strokes are painted
 * live by a cursor on the canvas. Options are read on the first render.
 */
export function usePaintDirector(controller: PaintEditorController, options: Omit<PaintDirectorOptions, 'clock'> = {}): { presence: PaintPresence; director: PaintDirector } {
  const [value] = useState(() => {
    const presence = new PaintPresence();
    return { presence, director: new PaintDirector(controller, presence, options) };
  });
  return value;
}
