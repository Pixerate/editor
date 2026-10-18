import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  VideoEditorController,
  createVideoEditorToolProvider,
  type VideoEditResult,
  type VideoEditorOptions,
  type VideoEditorState,
  type VideoEditorToolProviderOptions,
} from '@pixerate/editor/video-editor';
import type { ToolRegistry } from '@pixerate/editor/tools';

/** A `VideoEditorController` created once for the component's lifetime (destroyed on unmount). */
export function useVideoEditorController(options: VideoEditorOptions = {}): VideoEditorController {
  const ref = useRef<VideoEditorController | null>(null);
  if (!ref.current) ref.current = new VideoEditorController(options);
  const controller = ref.current;
  useEffect(() => () => controller.destroy(), [controller]);
  return controller;
}

/** The controller's state (re-renders on every change, including each played frame). */
export function useVideoEditorState(controller: VideoEditorController): VideoEditorState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

export interface UseVideoEditorResult {
  controller: VideoEditorController;
  state: VideoEditorState;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Moves the playhead (ms). */
  seek: (time: number) => void;
  /** Moves the playhead by whole frames (negative steps back), pausing. */
  step: (frames: number) => void;
  undo: () => void;
  redo: () => void;
  /** Splits the selected clips (or every clip) under the playhead, as one undo step. */
  splitAtPlayhead: () => VideoEditResult;
  /** Deletes the selected clips; `ripple` closes the gaps they leave. */
  deleteSelection: (options?: { ripple?: boolean }) => VideoEditResult;
}

/**
 * Subscribes to a video editor controller and exposes its state with bound actions.
 * Pass options instead of a controller to create one for the component's lifetime.
 */
export function useVideoEditor(controllerOrOptions: VideoEditorController | VideoEditorOptions = {}): UseVideoEditorResult {
  const own = useRef<VideoEditorController | null>(null);
  let controller: VideoEditorController;
  if (controllerOrOptions instanceof VideoEditorController) controller = controllerOrOptions;
  else {
    if (!own.current) own.current = new VideoEditorController(controllerOrOptions);
    controller = own.current;
  }
  useEffect(() => () => own.current?.destroy(), []);
  const state = useVideoEditorState(controller);
  const actions = useMemo(
    () => ({
      play: () => controller.play(),
      pause: () => controller.pause(),
      toggle: () => controller.toggle(),
      seek: (time: number) => controller.seek(time),
      step: (frames: number) => controller.step(frames),
      undo: () => void controller.undo(),
      redo: () => void controller.redo(),
      splitAtPlayhead: () => controller.splitAtPlayhead(),
      deleteSelection: (options?: { ripple?: boolean }) => controller.deleteSelection(options),
    }),
    [controller],
  );
  return { controller, state, ...actions };
}

/**
 * Registers the video editor's agent tools (`get_video_project`, `add_video_clip`,
 * `trim_video_clip`, …) in `registry` while mounted.
 */
export function useVideoEditorTools(
  registry: ToolRegistry | null | undefined,
  controller: VideoEditorController,
  options: VideoEditorToolProviderOptions = {},
): void {
  const { id, namespace, readOnly, rasterize } = options;
  useEffect(() => {
    if (!registry) return;
    return registry.register(createVideoEditorToolProvider(controller, { id, namespace, readOnly, rasterize }));
  }, [registry, controller, id, namespace, readOnly, rasterize]);
}
