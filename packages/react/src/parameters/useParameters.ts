import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  ParametersController,
  createParameterCommands,
  type ParameterCommandOptions,
  type ParametersControllerOptions,
  type ParametersState,
  type ParameterValue,
  type ParameterSetResult,
} from '@pixerate/editor/parameters';

/**
 * A `ParametersController` created once for the component's lifetime. When `options.schema`
 * changes (a new object), the controller's schema is replaced and fitting values are kept.
 */
export function useParametersController(options: ParametersControllerOptions): ParametersController {
  const ref = useRef<ParametersController | null>(null);
  if (!ref.current) ref.current = new ParametersController(options);
  const controller = ref.current;
  const schema = options.schema;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    controller.setSchema(schema);
  }, [controller, schema]);
  return controller;
}

/** The controller's state (re-renders on every change). */
export function useParametersState(controller: ParametersController): ParametersState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

export interface UseParametersResult {
  controller: ParametersController;
  state: ParametersState;
  values: ParametersState['values'];
  setValue: (id: string, value: ParameterValue) => ParameterSetResult;
  undo: () => void;
  redo: () => void;
  reset: (ids?: readonly string[]) => void;
  randomize: (ids?: readonly string[]) => void;
}

/**
 * Subscribes to a parameters controller and exposes its state with bound actions. Pass
 * options instead of a controller to create one for the component's lifetime.
 */
export function useParameters(controllerOrOptions: ParametersController | ParametersControllerOptions): UseParametersResult {
  const own = useRef<ParametersController | null>(null);
  let controller: ParametersController;
  if (controllerOrOptions instanceof ParametersController) controller = controllerOrOptions;
  else {
    if (!own.current) own.current = new ParametersController(controllerOrOptions);
    controller = own.current;
  }
  const state = useParametersState(controller);
  const actions = useMemo(
    () => ({
      setValue: (id: string, value: ParameterValue) => controller.setValue(id, value),
      undo: () => void controller.undo(),
      redo: () => void controller.redo(),
      reset: (ids?: readonly string[]) => void controller.reset(ids),
      randomize: (ids?: readonly string[]) => void controller.randomize({ ids }),
    }),
    [controller],
  );
  return { controller, state, values: state.values, ...actions };
}

/** Anything with `register(specs) → unregister` (a `CommandRegistry`). */
export interface ParameterCommandTarget {
  register(specs: any): () => void;
}

/**
 * Registers the controller's palette / agent commands (`parameters.set`, `…randomize`, …)
 * in `registry` while mounted, so `createCommandToolProvider` exposes them to agents.
 */
export function useParameterCommands(
  registry: ParameterCommandTarget | null | undefined,
  controller: ParametersController,
  options: ParameterCommandOptions = {},
): void {
  const { prefix, group, scope } = options;
  useEffect(() => {
    if (!registry) return;
    return registry.register(createParameterCommands(controller, { prefix, group, scope }));
  }, [registry, controller, prefix, group, scope]);
}
