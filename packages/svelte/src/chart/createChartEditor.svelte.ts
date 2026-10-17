import { untrack } from "svelte";
import type { ToolRegistry } from "@pixerate/editor/tools";
import {
  ChartController,
  ChartDirector,
  ChartPresence,
  createChartCommands,
  createChartToolProvider,
  createOfficeChartToolProvider,
  type OfficeChartToolProviderOptions,
  layoutChart,
  type ChartScene,
  type ChartToolProviderOptions,
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

/**
 * Registers the chart's agent tools (`createChartToolProvider`) with a `ToolRegistry` for the
 * lifetime of the calling component. Pass a getter to follow a changing registry.
 */
export function useChartToolProvider(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  controller: ChartController,
  options: ChartToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createChartToolProvider(controller, options));
  });
}

/**
 * Registers the Office-file chart tools (`createOfficeChartToolProvider`: `list_file_charts`,
 * `get_file_chart`, and `load_file_chart` with a `controller`) for the lifetime of the calling
 * component. Pass a getter to follow a changing registry.
 */
export function useOfficeChartToolProvider(
  registry: ToolRegistry | null | undefined | (() => ToolRegistry | null | undefined),
  options: OfficeChartToolProviderOptions = {},
): void {
  $effect(() => {
    const target = typeof registry === "function" ? registry() : registry;
    if (!target) return;
    return target.register(createOfficeChartToolProvider(untrack(() => options)));
  });
}

/**
 * A `ChartPresence` and `ChartDirector` for a chart: pass `presence` and `sceneRef` to
 * `ChartCanvas`, and `director` to `useChartToolProvider` so agent edits are acted out with a
 * cursor.
 */
export function createChartDirector(controller: ChartController, options: { speed?: number; size?: { width: number; height: number } } = {}) {
  const sceneRef: { current: ChartScene | null } = { current: null };
  const presence = new ChartPresence();
  const size = options.size ?? { width: 640, height: 400 };
  const director = new ChartDirector(controller, presence, { scene: () => sceneRef.current ?? layoutChart(controller.getSpec(), size), speed: options.speed });
  return { presence, director, sceneRef };
}
