import {
  ParametersController,
  createParameterCommands,
  type ParameterCommandOptions,
  type ParametersControllerOptions,
  type ParameterSetResult,
  type ParametersState,
  type ParameterValue,
  createParametersEditorDocument,
  type ParametersSnapshot,
} from "@pixerate/editor/parameters";
import type { EditorDocument } from "@pixerate/editor/persistence";

export interface SvelteParameters {
  readonly controller: ParametersController;
  /** The save / load / undo contract (for `createEditorAutosave` or `createDocumentToolProvider`). */
  readonly editorDocument: EditorDocument<ParametersSnapshot>;
  /** The controller's state (reactive). */
  readonly state: ParametersState;
  /** Shorthand for `state.values` (reactive). */
  readonly values: ParametersState["values"];
  setValue(id: string, value: ParameterValue): ParameterSetResult;
  undo(): void;
  redo(): void;
  reset(ids?: readonly string[]): void;
  randomize(ids?: readonly string[]): void;
  /** Stops listening to the controller. */
  destroy(): void;
}

/**
 * Svelte 5 rune: subscribes to a `ParametersController` (or creates one from options) and
 * exposes its state reactively with bound actions.
 */
export function createParameters(controllerOrOptions: ParametersController | ParametersControllerOptions): SvelteParameters {
  const controller =
    controllerOrOptions instanceof ParametersController ? controllerOrOptions : new ParametersController(controllerOrOptions);
  let state = $state.raw(controller.getState());
  const unsubscribe = controller.subscribe((next) => {
    state = next;
  });
  const editorDocument = createParametersEditorDocument(controller);
  return {
    controller,
    editorDocument,
    get state() {
      return state;
    },
    get values() {
      return state.values;
    },
    setValue: (id, value) => controller.setValue(id, value),
    undo: () => void controller.undo(),
    redo: () => void controller.redo(),
    reset: (ids) => void controller.reset(ids),
    randomize: (ids) => void controller.randomize({ ids }),
    destroy: () => {
      unsubscribe();
      editorDocument.destroy();
    },
  };
}

/** Anything with `register(specs) → unregister` (a `CommandRegistry`). */
export interface ParameterCommandTarget {
  register(specs: any): () => void;
}

/**
 * Registers the controller's palette / agent commands (`parameters.set`, `…randomize`, …)
 * for the lifetime of the calling component (call it during initialisation), so
 * `createCommandToolProvider` exposes them to agents. Pass a getter to follow a changing
 * registry.
 */
export function useParameterCommands(
  registry: ParameterCommandTarget | null | undefined | (() => ParameterCommandTarget | null | undefined),
  controller: ParametersController,
  options: ParameterCommandOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createParameterCommands(controller, options));
  });
}
