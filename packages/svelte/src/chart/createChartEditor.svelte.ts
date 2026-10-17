import { untrack } from "svelte";
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
} from "@pixerate/editor/chart";

export interface SvelteChartEditor {
  readonly controller: ChartController;
  /** The controller's state (reactive). */
  readonly state: ChartState;
  /** Shorthand for `state.spec` (reactive). */
  readonly spec: ChartState["spec"];
  /** Shorthand for `state.selection` (reactive). */
  readonly selection: ChartSelection | null;
  update(patch: ChartSpecPatch): ChartActionResult;
  setType(type: ChartType): ChartActionResult;
  setValue(seriesId: string, index: number, value: unknown): ChartActionResult;
  select(selection: ChartSelection | null): void;
  undo(): void;
  redo(): void;
  /** Stops listening to the controller. */
  destroy(): void;
}

/**
 * Svelte 5 rune: subscribes to a `ChartController` (or creates one from options) and
 * exposes its state reactively with bound actions.
 */
export function createChartEditor(controllerOrOptions: ChartController | ChartControllerOptions = {}): SvelteChartEditor {
  const controller = controllerOrOptions instanceof ChartController ? controllerOrOptions : new ChartController(controllerOrOptions);
  let state = $state.raw(controller.getState());
  const unsubscribe = controller.subscribe((next) => {
    state = next;
  });
  return {
    controller,
    get state() {
      return state;
    },
    get spec() {
      return state.spec;
    },
    get selection() {
      return state.selection;
    },
    update: (patch) => controller.update(patch),
    setType: (type) => controller.setType(type),
    setValue: (seriesId, index, value) => controller.setValue(seriesId, index, value),
    select: (selection) => controller.select(selection),
    undo: () => void controller.undo(),
    redo: () => void controller.redo(),
    destroy: unsubscribe,
  };
}

/** Reactive state of a (possibly replaced) controller prop, for use inside components. */
export function chartStateOf(getController: () => ChartController): { readonly current: ChartState } {
  let view: ChartState = $state.raw(untrack(() => getController().getState()));
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

/** Anything with `register(specs) → unregister` (a `CommandRegistry`). */
export interface ChartCommandTarget {
  register(specs: any): () => void;
}

/**
 * Registers the controller's palette / agent commands (`chart.describe`, `chart.update`,
 * `chart.setValues`, …) for the lifetime of the calling component (call it during
 * initialisation). Pass a getter to follow a changing registry.
 */
export function useChartCommands(
  registry: ChartCommandTarget | null | undefined | (() => ChartCommandTarget | null | undefined),
  controller: ChartController,
  options: ChartCommandOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createChartCommands(controller, options));
  });
}
