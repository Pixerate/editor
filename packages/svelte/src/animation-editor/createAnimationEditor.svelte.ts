import { untrack } from "svelte";
import {
  AnimationEditorController,
  createAnimationEditorToolProvider,
  type AnimationEditorOptions,
  type AnimationEditorState,
  type AnimationEditorToolProviderOptions,
} from "@pixerate/editor/animation-editor";
import type { ToolRegistry } from "@pixerate/editor/tools";

export interface SvelteAnimationEditor {
  readonly controller: AnimationEditorController;
  /** The controller's state (reactive, including each played frame). */
  readonly state: AnimationEditorState;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(time: number): void;
  undo(): void;
  redo(): void;
  /** The frame at the playhead as SVG. */
  toSvg(): string;
  /** Stops listening to the controller (and destroys it when this rune created it). */
  destroy(): void;
}

/**
 * Svelte 5 rune: subscribes to an `AnimationEditorController` (or creates one from options)
 * and exposes its state reactively with bound actions.
 */
export function createAnimationEditor(controllerOrOptions: AnimationEditorController | AnimationEditorOptions = {}): SvelteAnimationEditor {
  const owned = !(controllerOrOptions instanceof AnimationEditorController);
  const controller = controllerOrOptions instanceof AnimationEditorController ? controllerOrOptions : new AnimationEditorController(controllerOrOptions);
  let state = $state.raw(controller.getState());
  const unsubscribe = controller.subscribe((next) => {
    state = next;
  });
  return {
    controller,
    get state() {
      return state;
    },
    play: () => controller.play(),
    pause: () => controller.pause(),
    toggle: () => controller.toggle(),
    seek: (time) => controller.seek(time),
    undo: () => void controller.undo(),
    redo: () => void controller.redo(),
    toSvg: () => controller.toSvg(),
    destroy: () => {
      unsubscribe();
      if (owned) controller.destroy();
    },
  };
}

/** Reactive state of a (possibly replaced) controller prop, for use inside components. */
export function animationEditorStateOf(getController: () => AnimationEditorController): { readonly current: AnimationEditorState } {
  let view: AnimationEditorState = $state.raw(untrack(() => getController().getState()));
  $effect(() => {
    const controller = getController();
    view = controller.getState();
    return untrack(() =>
      controller.subscribe((next) => {
        view = next;
      }),
    );
  });
  return {
    get current() {
      return view;
    },
  };
}

/**
 * Registers the animation editor's agent tools (`get_animation`, `add_commands`,
 * `export_flair_effect`, …) for the lifetime of the calling component (call it during
 * initialisation). Pass a getter to follow a changing registry.
 */
export function useAnimationEditorTools(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: AnimationEditorController,
  options: AnimationEditorToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createAnimationEditorToolProvider(controller, options));
  });
}
