import { untrack } from 'svelte';
import { createPaintEditorDocument, createPaintEffectsToolProvider, PaintDirector, PaintEditorController, PaintPresence, type PaintDirectorOptions, type PaintEditorOptions, type PaintEditorState, type PaintEffectsToolProviderOptions } from '@pixerate/editor/paint-editor';
import type { EffectProvider } from '@pixerate/editor/effects';
import type { ToolRegistry } from '@pixerate/editor/tools';

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
  /** The save / load / undo contract, with every image as an asset reference. */
  const editorDocument = createPaintEditorDocument(controller);
  return {
    get controller() {
      return controller;
    },
    get state() {
      return snapshot;
    },
    editorDocument,
    destroy() {
      unsubscribe();
      editorDocument.destroy();
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

/**
 * A `PaintPresence` and `PaintDirector` for a paint editor: pass `presence` to `PaintEditor` (or
 * `PaintCanvas`) and `director` to `createPaintEditorToolProvider`, so agent strokes are painted
 * live by a cursor on the canvas.
 */
export function createPaintDirector(controller: PaintEditorController, options: Omit<PaintDirectorOptions, 'clock'> = {}): { presence: PaintPresence; director: PaintDirector } {
  const presence = new PaintPresence();
  return { presence, director: new PaintDirector(controller, presence, options) };
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

/** The controller's effects provider as a rune, following `setEffectsProvider`. */
export function paintEffectsProvider(controller: () => PaintEditorController): { readonly current: EffectProvider | null } {
  let provider = $state.raw<EffectProvider | null>(controller().effectsProvider);
  $effect(() => {
    const c = controller();
    return untrack(() => {
      provider = c.effectsProvider;
      return c.effects.subscribe((p) => {
        provider = p;
      });
    });
  });
  return {
    get current() {
      return provider;
    },
  };
}

/**
 * Registers the paint editor's provider-effect tools (`set_paper_effect`, `add_effect_layer`,
 * `fill_layer_with_effect`, `apply_effect`, …) for the lifetime of the calling component. Before
 * an effects provider is registered the read tools say so and the write tools refuse.
 */
export function usePaintEffectsTools(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: PaintEditorController,
  options: PaintEffectsToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === 'function' ? registry() : registry;
    if (!target) return;
    return target.register(createPaintEffectsToolProvider(controller, options));
  });
}
