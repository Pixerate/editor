import {
  createPaintChangeFeed,
  createPaintProposals,
  type PaintChange,
  type PaintChangeFeed,
  type PaintEditorController,
  type PaintMutationInfo,
  type PaintMutationRequestListener,
  type PaintProposal,
  type PaintProposals,
  type PaintProposalsOptions,
} from '@pixerate/editor/paint-editor';

export interface PaintProposalStateRune {
  /** The framework-free store (for `createPaintProposalToolProvider` and agents). */
  readonly store: PaintProposals;
  /** Pending proposals (reactive); pass `store` to `PaintCanvas` (`proposals`) to draw them as ghosts. */
  readonly proposals: readonly PaintProposal[];
  propose: PaintProposals['propose'];
  accept: PaintProposals['accept'];
  reject: PaintProposals['reject'];
  clear: PaintProposals['clear'];
}

/**
 * Paint an agent suggests without painting it, as a Svelte 5 rune: ghosts the user accepts
 * (painted on a layer of their own as one undo step, made by the proposer) or dismisses. Pass
 * `store` to `PaintCanvas` as `proposals` to draw the ghosts, and to
 * `createPaintProposalToolProvider` for agents. The same API as React's `usePaintProposals`.
 */
export function createPaintProposalState(controller: PaintEditorController, options: Omit<PaintProposalsOptions, 'controller'> = {}): PaintProposalStateRune {
  const store = createPaintProposals({ ...options, controller });
  let state = $state.raw(store.getState());
  store.subscribe((next) => {
    state = next;
  });
  return {
    store,
    get proposals() {
      return state.proposals;
    },
    propose: store.propose,
    accept: store.accept,
    reject: store.reject,
    clear: store.clear,
  };
}

export interface PaintChangeWatcherRune {
  readonly feed: PaintChangeFeed;
  /** The latest change (reactive). */
  readonly last: PaintChange | null;
}

/**
 * What changed in the painting, as a Svelte 5 rune: strokes, fills and layers added, removed or
 * changed, and the start and end of each stroke, with who made it. For agents that paint
 * alongside the user. Call during component initialisation; the feed stops on unmount. The same
 * API as React's `usePaintChangeFeed`.
 */
export function createPaintChangeWatcher(controller: PaintEditorController, options: { onChange?: (change: PaintChange) => void } = {}): PaintChangeWatcherRune {
  const feed = createPaintChangeFeed(controller);
  let last = $state.raw<PaintChange | null>(null);
  feed.subscribe((change) => {
    last = change;
    options.onChange?.(change);
  });
  $effect(() => () => feed.dispose());
  return {
    feed,
    get last() {
      return last;
    },
  };
}

export interface PaintMutationRequestsRune {
  /** Pending mutations waiting for an agent to claim them (`state === 'pending'`). */
  readonly pending: readonly PaintMutationInfo[];
  /** Every active or completed mutation in the session. */
  readonly mutations: readonly PaintMutationInfo[];
  /** The most recently raised pending mutation, or `null`. */
  readonly last: PaintMutationInfo | null;
  destroy(): void;
}

/**
 * Subscribes to mutation requests raised when a user finishes a stroke with a `mutation` brush
 * and pauses for `settle` seconds, as a Svelte 5 rune. While active, marks an agent listener as
 * connected on the controller. The same API as React's `useMutationRequests`.
 */
export function createMutationRequests(
  controller: PaintEditorController,
  onRequest?: PaintMutationRequestListener
): PaintMutationRequestsRune {
  let mutations = $state.raw<readonly PaintMutationInfo[]>(controller.listMutations({ includeAll: true }));
  let last = $state.raw<PaintMutationInfo | null>(null);
  const offState = controller.subscribe(() => {
    mutations = controller.listMutations({ includeAll: true });
  });
  const offReq = controller.onMutationRequest((m) => {
    last = m;
    onRequest?.(m);
  });
  $effect(() => () => {
    offState();
    offReq();
  });
  return {
    get pending() {
      return mutations.filter((m) => m.state === 'pending');
    },
    get mutations() {
      return mutations;
    },
    get last() {
      const p = mutations.filter((m) => m.state === 'pending');
      return last && p.some((m) => m.id === last!.id) ? last : (p[p.length - 1] ?? null);
    },
    destroy() {
      offState();
      offReq();
    },
  };
}
