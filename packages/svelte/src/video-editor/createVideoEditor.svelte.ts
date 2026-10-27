import { untrack } from "svelte";
import {
  VideoEditorController,
  createVideoEditorToolProvider,
  createVideoEffectsToolProvider,
  createVideoDialogueToolProvider,
  createVideoMusicToolProvider,
  TranscriptVideoController,
  type TranscriptVideoOptions,
  type TranscriptVideoState,
  type VideoDialogueToolProviderOptions,
  type VideoMusicToolProviderOptions,
  type VideoEffectsToolProviderOptions,
  type VideoEditorOptions,
  type VideoEditorState,
  type VideoEditorToolProviderOptions,
  type VideoEditResult,
  createVideoEditorDocument,
  type VideoProject,
} from "@pixerate/editor/video-editor";
import type { EditorDocument } from "@pixerate/editor/persistence";
import type { ToolRegistry } from "@pixerate/editor/tools";

export interface SvelteVideoEditor {
  readonly controller: VideoEditorController;
  /** The save / load / undo contract (for `createEditorAutosave` or `createDocumentToolProvider`). */
  readonly editorDocument: EditorDocument<VideoProject>;
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
  const editorDocument = createVideoEditorDocument(controller);
  return {
    controller,
    editorDocument,
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
      editorDocument.destroy();
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

/**
 * Registers the talking-head cleanup tools (`find_video_disfluencies`, `plan_video_dialogue_cleanup`)
 * for the lifetime of the calling component (skill `pixerate-talking-head-edit`).
 */
export function useVideoDialogueTools(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: VideoEditorController,
  options: VideoDialogueToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createVideoDialogueToolProvider(controller, options));
  });
}

/**
 * Registers the music and mix tools (`find_video_beats`, `plan_video_beat_snap`, `duck_video_music`,
 * `measure_video_loudness`, `normalize_video_loudness`) for the lifetime of the calling component
 * (skill `pixerate-bgm-alignment`).
 */
export function useVideoMusicTools(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: VideoEditorController,
  options: VideoMusicToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createVideoMusicToolProvider(controller, options));
  });
}


/**
 * Svelte 5 rune: a `TranscriptVideoController` over a video editor and its reactive state. It is
 * rebuilt when the editor, track or `planFirst` change, and destroyed with the calling component.
 */
export function transcriptVideoOf(
  getController: () => VideoEditorController,
  getOptions: () => TranscriptVideoOptions = () => ({}),
): { readonly current: TranscriptVideoState; readonly transcript: TranscriptVideoController } {
  const initial = untrack(() => ({ controller: getController(), ...getOptions() }));
  let built = initial;
  let transcript: TranscriptVideoController = $state.raw(new TranscriptVideoController(initial.controller, initial));
  let view: TranscriptVideoState = $state.raw(untrack(() => transcript.getState()));
  $effect(() => {
    const next = { controller: getController(), ...getOptions() };
    untrack(() => {
      if (next.controller !== built.controller || next.track !== built.track || !!next.planFirst !== !!built.planFirst) {
        transcript.destroy();
        transcript = new TranscriptVideoController(next.controller, next);
        built = next;
      }
    });
    const current = untrack(() => transcript);
    view = current.getState();
    return current.subscribe((state) => {
      view = state;
    });
  });
  $effect(() => () => untrack(() => transcript).destroy());
  return {
    get current() {
      return view;
    },
    get transcript() {
      return transcript;
    },
  };
}
