import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  VectorEditorController,
  createVectorCommands,
  type VectorCommandOptions,
  type VectorEditorOptions,
  type VectorEditorState,
  type VectorTool,
} from '@pixerate/editor/vector';

/** A `VectorEditorController` created once for the component's lifetime (destroyed on unmount). */
export function useVectorEditorController(options: VectorEditorOptions = {}): VectorEditorController {
  const ref = useRef<VectorEditorController | null>(null);
  if (!ref.current) ref.current = new VectorEditorController(options);
  const controller = ref.current;
  useEffect(() => () => controller.destroy(), [controller]);
  return controller;
}

/** The controller's state (re-renders on every change). */
export function useVectorEditorState(controller: VectorEditorController): VectorEditorState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

export interface UseVectorEditorResult {
  controller: VectorEditorController;
  state: VectorEditorState;
  setTool: (tool: VectorTool) => void;
  undo: () => void;
  redo: () => void;
  deleteSelection: () => void;
  toSvg: () => string;
}

/**
 * Subscribes to a vector editor controller and exposes its state with bound actions. Pass
 * options instead of a controller to create one for the component's lifetime.
 */
export function useVectorEditor(controllerOrOptions: VectorEditorController | VectorEditorOptions = {}): UseVectorEditorResult {
  const own = useRef<VectorEditorController | null>(null);
  let controller: VectorEditorController;
  if (controllerOrOptions instanceof VectorEditorController) controller = controllerOrOptions;
  else {
    if (!own.current) own.current = new VectorEditorController(controllerOrOptions);
    controller = own.current;
  }
  const state = useVectorEditorState(controller);
  const actions = useMemo(
    () => ({
      setTool: (tool: VectorTool) => controller.setTool(tool),
      undo: () => void controller.undo(),
      redo: () => void controller.redo(),
      deleteSelection: () => void controller.deleteSelection(),
      toSvg: () => controller.toSvg(),
    }),
    [controller],
  );
  return { controller, state, ...actions };
}

/** Anything with `register(specs) → unregister` (a `CommandRegistry`). */
export interface VectorCommandTarget {
  register(specs: any): () => void;
}

/**
 * Registers the controller's palette / agent commands (`vector.addShape`, `vector.boolean`, …)
 * in `registry` while mounted, so `createCommandToolProvider` exposes them to agents.
 */
export function useVectorCommands(
  registry: VectorCommandTarget | null | undefined,
  controller: VectorEditorController,
  options: VectorCommandOptions = {},
): void {
  const { prefix, group, scope } = options;
  useEffect(() => {
    if (!registry) return;
    return registry.register(createVectorCommands(controller, { prefix, group, scope }));
  }, [registry, controller, prefix, group, scope]);
}
