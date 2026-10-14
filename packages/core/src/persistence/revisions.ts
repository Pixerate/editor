/** Anything that notifies on every document change (`HistoryManager` satisfies it). */
export interface RevisionChangeSource {
  subscribe(listener: (...args: any[]) => void): () => void;
}

/** Anything with a dirty flag (`DirtyTracker` and `HistoryDirtyBinding` satisfy it). */
export interface DirtyFlagSource {
  readonly dirty: boolean;
  subscribe(listener: (dirty: boolean) => void): () => void;
}

export interface RevisionTrackerOptions {
  /** Change notifications (e.g. a `HistoryManager`). Every notification is a new revision. */
  history?: RevisionChangeSource;
  /**
   * Saved-vs-current flag (e.g. `bindDirtyToHistory(...)` or a `DirtyTracker`).
   * Whenever it reads clean, the current revision counts as saved, so undoing
   * back to the saved state needs no snapshot. Without it, call `markSaved()`.
   */
  dirty?: DirtyFlagSource;
}

export interface RevisionTracker {
  /** Bumped on every change. */
  revision(): number;
  /** Revision of the last save; equals `revision()` while clean. */
  savedRevision(): number;
  /** Records a change made outside `history`. */
  bump(): void;
  /** Marks the current revision saved. */
  markSaved(): void;
  /** Called after every change, save or dirty flip. */
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

/**
 * Derives the `revision` / `savedRevision` pair an autosave controller needs
 * from a history and a dirty flag (`bindDirtyToHistory` or `DirtyTracker`).
 * Structural types only, so this entry stays dependency-free.
 */
export function createRevisionTracker(options: RevisionTrackerOptions = {}): RevisionTracker {
  let revision = 0;
  let saved = 0;
  const listeners = new Set<() => void>();
  const emit = () =>
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        console.error("[autosave] Error in revision listener:", error);
      }
    });
  const syncSaved = () => {
    // Read lazily: the dirty binding may update after our history listener ran.
    if (options.dirty && !options.dirty.dirty) saved = revision;
  };

  const unsubscribers: (() => void)[] = [];
  if (options.history) {
    unsubscribers.push(
      options.history.subscribe(() => {
        revision++;
        emit();
      }),
    );
  }
  if (options.dirty) {
    let first = true;
    unsubscribers.push(
      options.dirty.subscribe((dirty) => {
        if (first) {
          first = false;
          // DirtyTracker calls back immediately with the current value.
          if (dirty && revision === saved) revision++;
          return;
        }
        if (dirty && revision === saved) revision++;
        if (!dirty) saved = revision;
        emit();
      }),
    );
  }

  return {
    revision: () => revision,
    savedRevision: () => {
      syncSaved();
      return saved;
    },
    bump() {
      revision++;
      emit();
    },
    markSaved() {
      saved = revision;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      unsubscribers.forEach((fn) => fn());
      unsubscribers.length = 0;
      listeners.clear();
    },
  };
}
