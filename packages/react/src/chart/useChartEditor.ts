import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ToolRegistry } from '@pixerate/editor/tools';
import {
  ChartController,
  ChartDirector,
  ChartPresence,
  createChartCommands,
  createChartRasterizer,
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
  createChartEditorDocument,
  type ChartSpec,
} from '@pixerate/editor/chart';
import type { EditorDocument } from '@pixerate/editor/persistence';

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
  /** The save / load / undo contract (for `useEditorAutosave` or `createDocumentToolProvider`). */
  editorDocument: EditorDocument<ChartSpec>;
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
  const editorDocument = useMemo(() => createChartEditorDocument(controller), [controller]);
  // Subscribing again reconnects it, so a StrictMode remount keeps working.
  useEffect(() => () => editorDocument.destroy(), [editorDocument]);
  return { controller, editorDocument, state, spec: state.spec, selection: state.selection, ...actions };
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

/** `useChartToolProvider` options: `rasterize` defaults to a canvas rasterizer in the browser (`false` turns PNG off). */
export type ChartToolProviderHookOptions = Omit<ChartToolProviderOptions, 'rasterize'> & { rasterize?: ChartToolProviderOptions['rasterize'] | false };

/**
 * Registers the chart's agent tools (`createChartToolProvider`) with a `ToolRegistry` while
 * mounted. Options are read when the controller or registry changes. In the browser,
 * `render_chart { format: "png" }` works out of the box (`createChartRasterizer`).
 */
export function useChartToolProvider(registry: ToolRegistry | null | undefined, controller: ChartController, options: ChartToolProviderHookOptions = {}): void {
  const latest = useRef(options);
  latest.current = options;
  const { id, namespace, playbackSurface } = options;
  useEffect(() => {
    if (!registry) return;
    const { rasterize, ...rest } = latest.current;
    return registry.register(createChartToolProvider(controller, { ...rest, id, namespace, playbackSurface, rasterize: rasterize === false ? undefined : (rasterize ?? createChartRasterizer()) }));
  }, [registry, controller, id, namespace, playbackSurface]);
}

/**
 * Registers the Office-file chart tools (`createOfficeChartToolProvider`: `list_file_charts`,
 * `get_file_chart`, and `load_file_chart` with a `controller`) while mounted. `files` and
 * `readOnly` are read on every call, so they can change without re-registering.
 */
export function useOfficeChartToolProvider(registry: ToolRegistry | null | undefined, options: OfficeChartToolProviderOptions = {}): void {
  const latest = useRef(options);
  latest.current = options;
  const { id, namespace, controller } = options;
  const hasFiles = !!options.files;
  useEffect(() => {
    if (!registry) return;
    const current = latest.current;
    return registry.register(
      createOfficeChartToolProvider({
        ...current,
        id,
        namespace,
        controller,
        files: hasFiles ? () => latest.current.files?.() ?? [] : undefined,
        readOnly: () => {
          const r = latest.current.readOnly;
          return (typeof r === 'function' ? r() : r) ?? false;
        },
      }),
    );
  }, [registry, id, namespace, controller, hasFiles]);
}

/**
 * A `ChartPresence` and `ChartDirector` for a chart: pass `presence` and `sceneRef` to
 * `ChartCanvas`, and `director` to `useChartToolProvider` so agent edits are acted out with a
 * cursor.
 */
export function useChartDirector(controller: ChartController, options: { speed?: number; size?: { width: number; height: number } } = {}) {
  const sceneRef = useRef<ChartScene | null>(null);
  const ref = useRef<{ presence: ChartPresence; director: ChartDirector } | null>(null);
  if (!ref.current) {
    const presence = new ChartPresence();
    const size = options.size ?? { width: 640, height: 400 };
    const director = new ChartDirector(controller, presence, { scene: () => sceneRef.current ?? layoutChart(controller.getSpec(), size), speed: options.speed });
    ref.current = { presence, director };
  }
  return { ...ref.current, sceneRef };
}
