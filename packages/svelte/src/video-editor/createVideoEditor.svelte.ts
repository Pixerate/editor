import { untrack } from "svelte";
import {
  VideoEditorController,
  createVideoEditorToolProvider,
  createVideoEffectsToolProvider,
  type VideoEffectsToolProviderOptions,
  type VideoEditorOptions,
  type VideoEditorState,
  type VideoEditorToolProviderOptions,
  type VideoEditResult,
} from "@pixerate/editor/video-editor";
import type { ToolRegistry } from "@pixerate/editor/tools";

export interface SvelteVideoEditor {
  readonly controller: VideoEditorController;
  /** The controller's state (reactive, including the playhead while playing). */
  readonly state: VideoEditorState;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Moves the playhead (ms). */
  seek(time: number): void;
  /** Moves the playhead by whole frames (negative steps back), pausing. */
  step(frames: number): void;
  undo(): void;
  redo(): void;
  /** Splits the selected clips (or every clip) under the playhead, as one undo step. */
  splitAtPlayhead(): VideoEditResult;
  /** Deletes the selected clips; `ripple` closes the gaps they leave. */
  deleteSelection(options?: { ripple?: boolean }): VideoEditResult;
  /** Stops listening to the controller (and destroys it when this rune created it). */
  destroy(): void;
}

/**
 * Svelte 5 rune: subscribes to a `VideoEditorController` (or creates one from options) and
 * exposes its state reactively with bound actions.
 */
export function createVideoEditor(controllerOrOptions: VideoEditorController | VideoEditorOptions = {}): SvelteVideoEditor {
  const owned = !(controllerOrOptions instanceof VideoEditorController);
  const controller = controllerOrOptions instanceof VideoEditorController ? controllerOrOptions : new VideoEditorController(controllerOrOptions);
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
    step: (frames) => controller.step(frames),
    undo: () => void controller.undo(),
    redo: () => void controller.redo(),
    splitAtPlayhead: () => controller.splitAtPlayhead(),
    deleteSelection: (options) => controller.deleteSelection(options),
    destroy: () => {
      unsubscribe();
      if (owned) controller.destroy();
    },
  };
}

/** Reactive state of a (possibly replaced) controller prop, for use inside components. */
export function videoEditorStateOf(getController: () => VideoEditorController): { readonly current: VideoEditorState } {
  let view: VideoEditorState = $state.raw(untrack(() => getController().getState()));
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
 * Registers the video editor's agent tools (`get_video_project`, `add_video_clip`,
 * `render_video_frame`, …) for the lifetime of the calling component (call it during
 * initialisation). Pass a getter to follow a changing registry.
 */
export function useVideoEditorTools(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: VideoEditorController,
  options: VideoEditorToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createVideoEditorToolProvider(controller, options));
  });
}

/**
 * Registers the video editor's effect tools (`search_effects`, `describe_effect`, `apply_effect`,
 * `add_video_effect_clip`, `set_video_effect_transition`, …) for the lifetime of the calling
 * component. They work once an effects provider is registered (see `useEffects`); before that the
 * read tools say so and the write tools refuse.
 */
export function useVideoEffectsTools(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: VideoEditorController,
  options: VideoEffectsToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createVideoEffectsToolProvider(controller, options));
  });
}
