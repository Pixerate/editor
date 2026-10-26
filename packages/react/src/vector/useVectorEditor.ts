import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  VectorEditorController,
  createVectorCommands,
  createVectorEffectsToolProvider,
  createVectorGenerationToolProvider,
  type VectorEffectsToolProviderOptions,
  type VectorGenerationToolProviderOptions,
  type VectorCommandOptions,
  type VectorEditorOptions,
  type VectorEditorState,
  type VectorTool,
  createVectorEditorDocument,
  type VectorDocument,
} from '@pixerate/editor/vector';
import type { EditorDocument } from '@pixerate/editor/persistence';
import type { ToolRegistry } from '@pixerate/editor/tools';

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
  /** The save / load / undo contract (for `useEditorAutosave` or `createDocumentToolProvider`). */
  editorDocument: EditorDocument<VectorDocument>;
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
  const editorDocument = useMemo(() => createVectorEditorDocument(controller), [controller]);
  // Subscribing again reconnects it, so a StrictMode remount keeps working.
  useEffect(() => () => editorDocument.destroy(), [editorDocument]);
  return { controller, editorDocument, state, ...actions };
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

/**
 * Registers the vector editor's provider-effect tools (`search_effects`, `apply_effect`, …) in
 * `registry` while mounted. They work once an effects provider is registered (see `useEffects`).
 */
export function useVectorEffectsTools(
  registry: ToolRegistry | null | undefined,
  controller: VectorEditorController,
  options: VectorEffectsToolProviderOptions = {},
): void {
  const { id, namespace, readOnly } = options;
  useEffect(() => {
    if (!registry) return;
    return registry.register(createVectorEffectsToolProvider(controller, { id, namespace, readOnly }));
  }, [registry, controller, id, namespace, readOnly]);
}

/**
 * Registers the vector editor's generative-prompt tools (`list_vector_art_models`,
 * `generate_vector_art`, `regenerate_vector_art`) for the lifetime of the component. `models` and
 * `generate` are read fresh on every call, so they may change between renders.
 */
export function useVectorGenerationTools(registry: ToolRegistry | null | undefined, controller: VectorEditorController, options: VectorGenerationToolProviderOptions): void {
  const latest = useRef(options);
  latest.current = options;
  const { id, namespace } = options;
  useEffect(() => {
    if (!registry) return;
    const models = () => {
      const m = latest.current.models;
      return typeof m === 'function' ? m() : m;
    };
    return registry.register(
      createVectorGenerationToolProvider(controller, {
        id,
        namespace,
        models,
        generate: (request, context) => latest.current.generate(request, context),
        readOnly: () => {
          const r = latest.current.readOnly;
          return (typeof r === 'function' ? r() : r) ?? false;
        },
      }),
    );
  }, [registry, controller, id, namespace]);
}
