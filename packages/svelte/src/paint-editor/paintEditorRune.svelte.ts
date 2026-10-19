import { untrack } from 'svelte';
import { PaintEditorController, type PaintEditorOptions, type PaintEditorState } from '@pixerate/editor/paint-editor';

/**
 * A `PaintEditorController` (created from `options`, or the one given) with its state as a
 * rune: `editor.state` updates after every change. Call `destroy()` to unsubscribe.
 */
export function createReactivePaintEditor(options: PaintEditorOptions | PaintEditorController = {}) {
  const controller = options instanceof PaintEditorController ? options : new PaintEditorController(options);
  let snapshot = $state.raw<PaintEditorState>(controller.getState());
  const unsubscribe = controller.subscribe(() => {
    snapshot = controller.getState();
  });
  return {
    get controller() {
      return controller;
    },
    get state() {
      return snapshot;
    },
    destroy() {
      unsubscribe();
    },
  };
}

/** The controller's state as a rune, for components (subscribe in an effect, see GOTCHAS). */
export function paintEditorState(controller: () => PaintEditorController): { readonly current: PaintEditorState } {
  let snapshot = $state.raw<PaintEditorState>(controller().getState());
  $effect(() => {
    const c = controller();
    // Untracked, so the effect never depends on the state its listener writes (see GOTCHAS).
    return untrack(() => {
      snapshot = c.getState();
      const off = c.subscribe(() => {
        snapshot = c.getState();
      });
      return () => {
        off();
      };
    });
  });
  return {
    get current() {
      return snapshot;
    },
  };
}

export const chip = (on: boolean) => `px-2 py-1 rounded text-[11px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`;
export const button = 'px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40';
export const panel = 'flex flex-col gap-2 text-xs text-slate-200';

/** Runs `fn` and returns the error message it threw (or a rejected promise's, through `onAsync`). */
export function attempt(fn: () => unknown, onError: (msg: string | null) => void): void {
  try {
    onError(null);
    const r = fn();
    if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch((e) => onError(e instanceof Error ? e.message : String(e)));
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
  }
}
