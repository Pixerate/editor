import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  AnimationEditorController,
  createAnimationEditorToolProvider,
  createAnimationEffectsToolProvider,
  type AnimationEffectsToolProviderOptions,
  type AnimationEditorOptions,
  type AnimationEditorState,
  type AnimationEditorToolProviderOptions,
} from '@pixerate/editor/animation-editor';
import type { ToolRegistry } from '@pixerate/editor/tools';

/** An `AnimationEditorController` created once for the component's lifetime (destroyed on unmount). */
export function useAnimationEditorController(options: AnimationEditorOptions = {}): AnimationEditorController {
  const ref = useRef<AnimationEditorController | null>(null);
  if (!ref.current) ref.current = new AnimationEditorController(options);
  const controller = ref.current;
  useEffect(() => () => controller.destroy(), [controller]);
  return controller;
}

/** The controller's state (re-renders on every change, including each played frame). */
export function useAnimationEditorState(controller: AnimationEditorController): AnimationEditorState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

export interface UseAnimationEditorResult {
  controller: AnimationEditorController;
  state: AnimationEditorState;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  undo: () => void;
  redo: () => void;
  /** The frame at the playhead as SVG. */
  toSvg: () => string;
}

/**
 * Subscribes to an animation editor controller and exposes its state with bound actions.
 * Pass options instead of a controller to create one for the component's lifetime.
 */
export function useAnimationEditor(controllerOrOptions: AnimationEditorController | AnimationEditorOptions = {}): UseAnimationEditorResult {
  const own = useRef<AnimationEditorController | null>(null);
  let controller: AnimationEditorController;
  if (controllerOrOptions instanceof AnimationEditorController) controller = controllerOrOptions;
  else {
    if (!own.current) own.current = new AnimationEditorController(controllerOrOptions);
    controller = own.current;
  }
  useEffect(() => () => own.current?.destroy(), []);
  const state = useAnimationEditorState(controller);
  const actions = useMemo(
    () => ({
      play: () => controller.play(),
      pause: () => controller.pause(),
      toggle: () => controller.toggle(),
      seek: (time: number) => controller.seek(time),
      undo: () => void controller.undo(),
      redo: () => void controller.redo(),
      toSvg: () => controller.toSvg(),
    }),
    [controller],
  );
  return { controller, state, ...actions };
}

/**
 * Registers the animation editor's agent tools (`get_animation`, `add_commands`,
 * `export_flair_effect`, …) in `registry` while mounted.
 */
export function useAnimationEditorTools(
  registry: ToolRegistry | null | undefined,
  controller: AnimationEditorController,
  options: AnimationEditorToolProviderOptions = {},
): void {
  const { id, namespace, readOnly, rasterize } = options;
  useEffect(() => {
    if (!registry) return;
    return registry.register(createAnimationEditorToolProvider(controller, { id, namespace, readOnly, rasterize }));
  }, [registry, controller, id, namespace, readOnly, rasterize]);
}

/**
 * Registers the animation editor's provider-effect tools (`search_effects`, `apply_effect`,
 * `add_vector_effect`, …) in `registry` while mounted. They work once an effects provider is
 * registered (see `useEffects`).
 */
export function useAnimationEffectsTools(
  registry: ToolRegistry | null | undefined,
  controller: AnimationEditorController,
  options: AnimationEffectsToolProviderOptions = {},
): void {
  const { id, namespace, readOnly } = options;
  useEffect(() => {
    if (!registry) return;
    return registry.register(createAnimationEffectsToolProvider(controller, { id, namespace, readOnly }));
  }, [registry, controller, id, namespace, readOnly]);
}
