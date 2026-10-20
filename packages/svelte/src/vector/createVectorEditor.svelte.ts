import {
  VectorEditorController,
  createVectorCommands,
  createVectorEffectsToolProvider,
  createVectorGenerationToolProvider,
  type VectorEffectsToolProviderOptions,
  type VectorGenerationToolProviderOptions,
  type VectorCommandOptions,
  type VectorEditorOptions,
  type VectorEditorState,
  type VectorTool,
} from "@pixerate/editor/vector";
import type { ToolRegistry } from "@pixerate/editor/tools";

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

/**
 * Registers the vector editor's provider-effect tools (`search_effects`, `apply_effect`, …) for the
 * lifetime of the calling component. They work once an effects provider is registered (see
 * `useEffects`).
 */
export function useVectorEffectsTools(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: VectorEditorController,
  options: VectorEffectsToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createVectorEffectsToolProvider(controller, options));
  });
}

/**
 * Registers the vector editor's generative-prompt tools (`list_vector_art_models`,
 * `generate_vector_art`, `regenerate_vector_art`) for the lifetime of the calling component.
 * Pass `options` as a function to change models or the generator later.
 */
export function useVectorGenerationTools(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: VectorEditorController,
  options: VectorGenerationToolProviderOptions | (() => VectorGenerationToolProviderOptions),
): void {
  const current = () => (typeof options === "function" ? options() : options);
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    const { id, namespace } = current();
    return target.register(
      createVectorGenerationToolProvider(controller, {
        id,
        namespace,
        models: () => {
          const m = current().models;
          return typeof m === "function" ? m() : m;
        },
        generate: (request, context) => current().generate(request, context),
        readOnly: () => {
          const r = current().readOnly;
          return (typeof r === "function" ? r() : r) ?? false;
        },
      }),
    );
  });
}
