import {
  createAutosaveController,
  createRevisionTracker,
  type AutosaveController,
  type AutosaveRecovery,
  type AutosaveStatusInfo,
  type DirtyFlagSource,
  type RevisionChangeSource,
  type StorageAdapter,
} from "@pixerate/editor/persistence";

export interface CreateAutosaveOptions<T> {
  storage: StorageAdapter;
  /** Snapshot key (the meta lives at `<key>:meta`). */
  key: string;
  /** Reads the current document. */
  getSnapshot: () => T;
  serialize?: (snapshot: T) => string;
  deserialize?: (text: string) => T;
  /** Document name stored with the snapshot. */
  name?: string | (() => string | undefined);
  /** Change notifications, e.g. `createHistory().manager`. */
  history?: RevisionChangeSource;
  /** Saved-vs-current flag, e.g. `createHistoryDirty(...).tracker` or a `bindDirtyToHistory` binding. */
  dirty?: DirtyFlagSource;
  interval?: number;
  debounceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /**
   * Whether the document has finished loading (default `true`). With `false`,
   * call `ready()` once it has. Snapshots also wait for any recovered snapshot
   * to be restored or discarded.
   */
  ready?: boolean;
  /** Look for an earlier session's snapshot (default `true`). */
  recover?: boolean;
  /** Write pending changes on `pagehide` and when the tab is hidden (default `true`). */
  flushOnHide?: boolean;
}

export interface SvelteAutosave<T> {
  /** Reactive status. */
  readonly status: AutosaveStatusInfo;
  /** An earlier session's unsaved snapshot, until restored or discarded (reactive). */
  readonly recovery: AutosaveRecovery<T> | null;
  /** True while the recovery check runs or a recovered snapshot awaits a decision (reactive). */
  readonly pendingRecovery: boolean;
  /** Takes the recovered snapshot (apply it to the editor) and starts autosaving. */
  restore(): T | undefined;
  /** Deletes the recovered snapshot and starts autosaving. */
  discard(): Promise<void>;
  /** Marks the document loaded (with `ready: false`). */
  ready(): void;
  /** Writes pending changes now. */
  flushNow(): Promise<void>;
  /** Call after an explicit save: marks the current revision saved and retires this session's snapshot. */
  markClean(): Promise<void>;
  /** Records a change made outside `history`. */
  notifyChange(): void;
  /** Resolves once the recovery check finished. */
  readonly checked: Promise<void>;
  readonly controller: AutosaveController<T>;
  /** Stops timers and listeners. */
  destroy(): void;
}

/**
 * Svelte 5 rune: crash-recovery autosave bound to a history and dirty flag,
 * with page lifecycle flushing and a recovery check (see
 * `createAutosaveController` in `@pixerate/editor/persistence`). Render
 * `<RecoveryPrompt>` with `recovery`, `restore` and `discard`.
 */
export function createAutosave<T>(options: CreateAutosaveOptions<T>): SvelteAutosave<T> {
  const revisions = createRevisionTracker({ history: options.history, dirty: options.dirty });
  const controller = createAutosaveController<T>({
    storage: options.storage,
    key: options.key,
    getSnapshot: options.getSnapshot,
    serialize: options.serialize,
    deserialize: options.deserialize,
    name: options.name,
    revision: revisions.revision,
    savedRevision: revisions.savedRevision,
    interval: options.interval,
    debounceMs: options.debounceMs,
    retryBaseMs: options.retryBaseMs,
    retryMaxMs: options.retryMaxMs,
  });

  const recover = options.recover !== false;
  let status = $state.raw<AutosaveStatusInfo>(controller.getStatus());
  let recovery = $state.raw<AutosaveRecovery<T> | null>(null);
  let pendingRecovery = $state(recover);
  let loaded = options.ready !== false;
  let destroyed = false;

  const maybeReady = () => {
    if (!destroyed && loaded && !pendingRecovery) controller.ready();
  };

  const unsubscribeStatus = controller.subscribe((info) => {
    status = info;
  });
  const unsubscribeRevisions = revisions.subscribe(() => controller.notify());

  const checked = recover
    ? controller
        .checkRecovery()
        .catch(() => null)
        .then((found) => {
          if (destroyed) return;
          recovery = found;
          pendingRecovery = found !== null;
          maybeReady();
        })
    : Promise.resolve();
  maybeReady();

  let removeListeners = () => {};
  if (options.flushOnHide !== false && typeof window !== "undefined") {
    const flush = () => void controller.flushNow();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    removeListeners = () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  return {
    get status() {
      return status;
    },
    get recovery() {
      return recovery;
    },
    get pendingRecovery() {
      return pendingRecovery;
    },
    restore() {
      const snapshot = recovery?.snapshot;
      recovery = null;
      pendingRecovery = false;
      // Deferred so the caller can apply the snapshot first.
      queueMicrotask(maybeReady);
      return snapshot;
    },
    async discard() {
      await controller.discardRecovery();
      recovery = null;
      pendingRecovery = false;
      maybeReady();
    },
    ready() {
      loaded = true;
      maybeReady();
    },
    flushNow: () => controller.flushNow(),
    async markClean() {
      revisions.markSaved();
      await controller.markClean();
    },
    notifyChange: () => revisions.bump(),
    checked,
    controller,
    destroy() {
      destroyed = true;
      removeListeners();
      unsubscribeStatus();
      unsubscribeRevisions();
      revisions.destroy();
      controller.destroy();
    },
  };
}
