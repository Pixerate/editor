import {
  DirtyTracker,
  bindDirtyToHistory,
  type DirtyTrackerOptions,
  type HistoryManager,
} from "@pixerate/editor/history";

export interface CreateHistoryDirtyOptions<T> extends DirtyTrackerOptions<T> {
  /** The history whose changes re-check the document (a `createHistory().manager`). */
  history: HistoryManager;
  /** Reads the current document value. */
  getValue: () => T;
  /** Existing tracker to drive. */
  tracker?: DirtyTracker<T>;
}

export interface SvelteHistoryDirty<T> {
  /** Whether the document differs from the saved state (reactive). */
  readonly isDirty: boolean;
  /** Marks the current document as saved. */
  markClean(): void;
  /** Runs a load / restore without marking the document dirty (re-entrant). */
  suppress<R>(fn: () => R): R;
  /** Re-checks after a change made outside the history. */
  refresh(): boolean;
  readonly tracker: DirtyTracker<T>;
  /** Stops following the history. */
  destroy(): void;
}

/**
 * Svelte 5 rune: dirty-vs-saved tracking bound to a HistoryManager. Undoing
 * back to the saved state makes the document clean again, so a navigation
 * guard fed with `isDirty` stops prompting.
 *
 * Usage: `createNavigationGuard({ isDirty: () => dirty.isDirty })`.
 */
export function createHistoryDirty<T>(
  options: CreateHistoryDirtyOptions<T>,
): SvelteHistoryDirty<T> {
  const binding = bindDirtyToHistory<T>(options);
  let isDirty = $state(binding.dirty);
  const unsubscribe = binding.subscribe((dirty) => {
    isDirty = dirty;
  });

  return {
    get isDirty() {
      return isDirty;
    },
    markClean: () => binding.markClean(),
    suppress: <R>(fn: () => R): R => binding.suppress(fn),
    refresh: () => binding.refresh(),
    get tracker() {
      return binding.tracker;
    },
    destroy() {
      unsubscribe();
      binding.destroy();
    },
  };
}
