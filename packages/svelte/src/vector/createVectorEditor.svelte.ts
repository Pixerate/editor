import {
  VectorEditorController,
  createVectorCommands,
  type VectorCommandOptions,
  type VectorEditorOptions,
  type VectorEditorState,
  type VectorTool,
} from "@pixerate/editor/vector";

export interface SvelteVectorEditor {
  readonly controller: VectorEditorController;
  /** The controller's state (reactive). */
  readonly state: VectorEditorState;
  setTool(tool: VectorTool): void;
  undo(): void;
  redo(): void;
  deleteSelection(): void;
  toSvg(): string;
  /** Stops listening to the controller (and destroys it when this rune created it). */
  destroy(): void;
}

/**
 * Svelte 5 rune: subscribes to a `VectorEditorController` (or creates one from options) and
 * exposes its state reactively with bound actions.
 */
export function createVectorEditor(controllerOrOptions: VectorEditorController | VectorEditorOptions = {}): SvelteVectorEditor {
  const owned = !(controllerOrOptions instanceof VectorEditorController);
  const controller =
    controllerOrOptions instanceof VectorEditorController ? controllerOrOptions : new VectorEditorController(controllerOrOptions);
  let state = $state.raw(controller.getState());
  const unsubscribe = controller.subscribe((next) => {
    state = next;
  });
  return {
    controller,
    get state() {
      return state;
    },
    setTool: (tool) => controller.setTool(tool),
    undo: () => void controller.undo(),
    redo: () => void controller.redo(),
    deleteSelection: () => void controller.deleteSelection(),
    toSvg: () => controller.toSvg(),
    destroy: () => {
      unsubscribe();
      if (owned) controller.destroy();
    },
  };
}

/** Anything with `register(specs) → unregister` (a `CommandRegistry`). */
export interface VectorCommandTarget {
  register(specs: any): () => void;
}

/**
 * Registers the controller's palette / agent commands (`vector.addShape`, `vector.boolean`, …)
 * for the lifetime of the calling component (call it during initialisation), so
 * `createCommandToolProvider` exposes them to agents. Pass a getter to follow a changing
 * registry.
 */
export function useVectorCommands(
  registry: VectorCommandTarget | null | undefined | (() => VectorCommandTarget | null | undefined),
  controller: VectorEditorController,
  options: VectorCommandOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createVectorCommands(controller, options));
  });
}
