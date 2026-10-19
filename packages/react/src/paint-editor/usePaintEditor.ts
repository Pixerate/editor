import { useMemo, useState, useSyncExternalStore } from 'react';
import { PaintEditorController, type PaintEditorOptions, type PaintEditorState } from '@pixerate/editor/paint-editor';

export interface UsePaintEditorReturn {
  controller: PaintEditorController;
  /** The controller's snapshot (a new object after every change). */
  state: PaintEditorState;
}

/**
 * Creates a `PaintEditorController` once (from `options`, read on the first render) or uses the
 * one given, and re-renders on every change.
 */
export function usePaintEditor(options: PaintEditorOptions | PaintEditorController = {}): UsePaintEditorReturn {
  const [controller] = useState(() => (options instanceof PaintEditorController ? options : new PaintEditorController(options)));
  const state = usePaintEditorState(controller);
  return useMemo(() => ({ controller, state }), [controller, state]);
}

/** Subscribes to a controller's state. */
export function usePaintEditorState(controller: PaintEditorController): PaintEditorState {
  return useSyncExternalStore(
    (notify) => controller.subscribe(notify),
    () => controller.getState(),
    () => controller.getState()
  );
}
