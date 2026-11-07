import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  PaintDirector,
  PaintEditorController,
  PaintPresence,
  createPaintChangeFeed,
  createPaintEditorDocument,
  createPaintProposals,
  type PaintChange,
  type PaintChangeFeed,
  type PaintDirectorOptions,
  type PaintEditorOptions,
  type PaintEditorState,
  type PaintMutationInfo,
  type PaintMutationRequestListener,
  type PaintProposal,
  type PaintProposals,
  type PaintProposalsOptions,
  type SerializedPaintDocument,
} from '@pixerate/editor/paint-editor';
import type { EditorDocument } from '@pixerate/editor/persistence';

export interface UsePaintEditorReturn {
  controller: PaintEditorController;
  /** The controller's snapshot (a new object after every change). */
  state: PaintEditorState;
  /** The save / load / undo contract, with every image as an asset reference (for `useEditorAutosave` or `createDocumentToolProvider`). */
  editorDocument: EditorDocument<SerializedPaintDocument>;
}

/**
 * Creates a `PaintEditorController` once (from `options`, read on the first render) or uses the
 * one given, and re-renders on every change.
 */
export function usePaintEditor(options: PaintEditorOptions | PaintEditorController = {}): UsePaintEditorReturn {
  const [controller] = useState(() => (options instanceof PaintEditorController ? options : new PaintEditorController(options)));
  const state = usePaintEditorState(controller);
  const editorDocument = useMemo(() => createPaintEditorDocument(controller), [controller]);
  // Subscribing again reconnects it, so a StrictMode remount keeps working.
  useEffect(() => () => editorDocument.destroy(), [editorDocument]);
  return useMemo(() => ({ controller, state, editorDocument }), [controller, state, editorDocument]);
}

/** Subscribes to a controller's state. */
export function usePaintEditorState(controller: PaintEditorController): PaintEditorState {
  return useSyncExternalStore(
    (notify) => controller.subscribe(notify),
    () => controller.getState(),
    () => controller.getState()
  );
}

/**
 * A `PaintPresence` and `PaintDirector` for a paint editor: pass `presence` to `PaintEditor` (or
 * `PaintCanvas`) and `director` to `createPaintEditorToolProvider`, so agent strokes are painted
 * live by a cursor on the canvas. Options are read on the first render.
 */
export function usePaintDirector(controller: PaintEditorController, options: Omit<PaintDirectorOptions, 'clock'> = {}): { presence: PaintPresence; director: PaintDirector } {
  const [value] = useState(() => {
    const presence = new PaintPresence();
    return { presence, director: new PaintDirector(controller, presence, options) };
  });
  useEffect(() => {
    controller.setMutationDirector(value.director);
    return () => controller.setMutationDirector(null);
  }, [controller, value.director]);
  return value;
}

export interface UseMutationRequestsReturn {
  /** Pending mutations waiting for an agent to claim them (`state === 'pending'`). */
  pending: readonly PaintMutationInfo[];
  /** Every active or completed mutation in the session. */
  mutations: readonly PaintMutationInfo[];
  /** The most recently raised pending mutation, or `null`. */
  last: PaintMutationInfo | null;
}

/**
 * Subscribes to mutation requests raised when a user finishes a stroke with a `mutation` brush
 * and pauses for `settle` seconds. While mounted, marks an agent listener as connected on the
 * controller so the brush panel does not warn that no agent is listening.
 */
export function useMutationRequests(
  controller: PaintEditorController,
  onRequest?: PaintMutationRequestListener
): UseMutationRequestsReturn {
  const state = usePaintEditorState(controller);
  const cbRef = useRef(onRequest);
  cbRef.current = onRequest;
  const [last, setLast] = useState<PaintMutationInfo | null>(null);
  useEffect(() => {
    return controller.onMutationRequest((m) => {
      setLast(m);
      cbRef.current?.(m);
    });
  }, [controller]);
  const pending = useMemo(() => state.mutations.filter((m) => m.state === 'pending'), [state.mutations]);
  return {
    pending,
    mutations: state.mutations,
    last: last && state.mutations.some((m) => m.id === last.id && m.state === 'pending') ? last : (pending[pending.length - 1] ?? null),
  };
}

export interface PaintProposalsHandle {
  /** The framework-free store (for `createPaintProposalToolProvider` and agents). */
  readonly store: PaintProposals;
  /** Pending proposals; pass `store` to `PaintCanvas` (`proposals`) to draw them as ghosts. */
  proposals: readonly PaintProposal[];
  propose: PaintProposals['propose'];
  accept: PaintProposals['accept'];
  reject: PaintProposals['reject'];
  clear: PaintProposals['clear'];
}

/**
 * Paint an agent suggests without painting it: ghosts the user accepts (painted on a layer of
 * their own as one undo step, made by the proposer) or dismisses. Pass `store` to `PaintCanvas`
 * as `proposals` to draw the ghosts, and to `createPaintProposalToolProvider` for agents. Options
 * are read on the first render. The same API as the Svelte `createPaintProposalState`.
 */
export function usePaintProposals(controller: PaintEditorController, options: Omit<PaintProposalsOptions, 'controller'> = {}): PaintProposalsHandle {
  const [store] = useState(() => createPaintProposals({ ...options, controller }));
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return useMemo(() => ({ store, proposals: state.proposals, propose: store.propose, accept: store.accept, reject: store.reject, clear: store.clear }), [store, state]);
}

/**
 * What changed in the painting, after each change: strokes, fills and layers added, removed or
 * changed, and the start and end of each stroke, with who made it. For agents that paint
 * alongside the user. Returns the feed (`null` until mounted) and the latest change. The same API
 * as the Svelte `createPaintChangeWatcher`.
 */
export function usePaintChangeFeed(controller: PaintEditorController, options: { onChange?: (change: PaintChange) => void } = {}): { feed: PaintChangeFeed | null; last: PaintChange | null } {
  const onChange = useRef(options.onChange);
  onChange.current = options.onChange;
  const [last, setLast] = useState<PaintChange | null>(null);
  const [feed, setFeed] = useState<PaintChangeFeed | null>(null);
  // The feed lives in the effect, so a StrictMode unmount and remount gets a live one (see GOTCHAS).
  useEffect(() => {
    const next = createPaintChangeFeed(controller);
    next.subscribe((change) => {
      setLast(change);
      onChange.current?.(change);
    });
    setFeed(next);
    return () => next.dispose();
  }, [controller]);
  return { feed, last };
}
