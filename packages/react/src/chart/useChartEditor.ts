import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  ChartController,
  createChartCommands,
  type ChartActionResult,
  type ChartCommandOptions,
  type ChartControllerOptions,
  type ChartSelection,
  type ChartSpecPatch,
  type ChartState,
  type ChartType,
} from '@pixerate/editor/chart';

/** A `ChartController` created once for the component's lifetime. */
export function useChartController(options: ChartControllerOptions = {}): ChartController {
  const ref = useRef<ChartController | null>(null);
  if (!ref.current) ref.current = new ChartController(options);
  return ref.current;
}

/** The controller's state (re-renders on every change). */
export function useChartState(controller: ChartController): ChartState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

export interface UseChartEditorResult {
  controller: ChartController;
  state: ChartState;
  spec: ChartState['spec'];
  selection: ChartSelection | null;
  update: (patch: ChartSpecPatch) => ChartActionResult;
  setType: (type: ChartType) => ChartActionResult;
  setValue: (seriesId: string, index: number, value: unknown) => ChartActionResult;
  select: (selection: ChartSelection | null) => void;
  undo: () => void;
  redo: () => void;
}

/**
 * Subscribes to a chart controller and exposes its state with bound actions. Pass options
 * instead of a controller to create one for the component's lifetime.
 */
export function useChartEditor(controllerOrOptions: ChartController | ChartControllerOptions = {}): UseChartEditorResult {
  const own = useRef<ChartController | null>(null);
  let controller: ChartController;
  if (controllerOrOptions instanceof ChartController) controller = controllerOrOptions;
  else {
    if (!own.current) own.current = new ChartController(controllerOrOptions);
    controller = own.current;
  }
  const state = useChartState(controller);
  const actions = useMemo(
    () => ({
      update: (patch: ChartSpecPatch) => controller.update(patch),
      setType: (type: ChartType) => controller.setType(type),
      setValue: (seriesId: string, index: number, value: unknown) => controller.setValue(seriesId, index, value),
      select: (selection: ChartSelection | null) => controller.select(selection),
      undo: () => void controller.undo(),
      redo: () => void controller.redo(),
    }),
    [controller],
  );
  return { controller, state, spec: state.spec, selection: state.selection, ...actions };
}

/** Anything with `register(specs) → unregister` (a `CommandRegistry`). */
export interface ChartCommandTarget {
  register(specs: any): () => void;
}

/**
 * Registers the controller's palette / agent commands (`chart.describe`, `chart.update`,
 * `chart.setValues`, …) in `registry` while mounted.
 */
export function useChartCommands(registry: ChartCommandTarget | null | undefined, controller: ChartController, options: ChartCommandOptions = {}): void {
  const { prefix, group, scope } = options;
  useEffect(() => {
    if (!registry) return;
    return registry.register(createChartCommands(controller, { prefix, group, scope }));
  }, [registry, controller, prefix, group, scope]);
}
