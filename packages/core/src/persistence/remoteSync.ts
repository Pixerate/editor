import type { EditorDocument } from "./editorDocument";
import type { EditorAutosave } from "./editorAutosave";

export type EditorRemoteSyncState = "idle" | "pending" | "saving" | "saved" | "error";

export interface EditorRemoteSyncStatus {
  status: EditorRemoteSyncState;
  version: number;
  savedVersion: number;
  dirty: boolean;
  lastSavedAt: number | null;
  error?: unknown;
}

export interface EditorRemoteSaveContext<TDocument = unknown, TDiff = unknown> {
  document: TDocument;
  version: number;
  diff?: TDiff;
}

export interface EditorRemoteSaveResult {
  version?: number;
}

export interface EditorRemoteLocalChangeEvent<TDocument = unknown, TDiff = unknown> {
  document: TDocument;
  baseline: TDocument;
  diff?: TDiff;
  version: number;
}

export interface EditorRemoteSyncOptions<TDocument = unknown, TDiff = unknown> {
  /**
   * Persists the latest document snapshot and version to the remote backend.
   * May return `{ version }` or a numeric `version` if the server advanced the version higher.
   */
  save: (context: EditorRemoteSaveContext<TDocument, TDiff>) => Promise<EditorRemoteSaveResult | number | void>;
  /** Initial known server version of the document (default `0`). */
  initialVersion?: number;
  /** Debounce delay in milliseconds after a local edit before calling `save` (default `500`). */
  debounceMs?: number;
  /** Optional diff calculator between the current snapshot and the previous committed baseline. */
  diff?: (current: TDocument, baseline: TDocument) => TDiff;
  /**
   * Optional predicate returning `true` when `diff` represents no meaningful change.
   * When omitted, compares `JSON.stringify(current) === JSON.stringify(baseline)`.
   */
  isEmptyDiff?: (diff: TDiff, current: TDocument, baseline: TDocument) => boolean;
  /**
   * Invoked immediately whenever a local document change is detected (before `save` debounce),
   * e.g. for broadcasting incremental diffs to realtime collaborators.
   */
  onLocalChange?: (event: EditorRemoteLocalChangeEvent<TDocument, TDiff>) => void;
  /** Invoked when a remote `save` completes. */
  onSaved?: (event: { document: TDocument; version: number }) => void;
  /** Invoked when a remote `save` throws. */
  onError?: (error: unknown) => void;
  /**
   * Optional crash-recovery autosave instance. When a remote save succeeds and no newer
   * local edits occurred while it was in flight, `autosave.markClean()` is called automatically.
   */
  autosave?: Pick<EditorAutosave, "markClean">;
  /** Wall clock (default `Date.now`). */
  now?: () => number;
}

export interface EditorRemoteSync<TDocument = unknown, TDiff = unknown> {
  /** Current local version number. */
  version(): number;
  /** Last version confirmed saved by the remote server. */
  savedVersion(): number;
  /** Whether local changes are waiting to be saved or currently saving. */
  dirty(): boolean;
  /** Current sync status snapshot. */
  status(): EditorRemoteSyncStatus;
  /** Last committed local baseline snapshot. */
  baseline(): TDocument;
  /** Checks the document for changes against `baseline()` (called automatically via `doc.subscribe`). */
  notify(): boolean;
  /**
   * Runs `fn` while suppressing local change detection (so incoming collaborator diffs or
   * server loads do not echo back a save), then updates `baseline` and advances `version` /
   * `savedVersion` to `Math.max(version, remoteVersion)`.
   */
  applyRemote<TResult>(fn: () => TResult, remoteVersion?: number): TResult;
  /** Resets the baseline to `doc.getDocument()` and updates `version` / `savedVersion`. */
  resetBaseline(remoteVersion?: number): void;
  /** Cancels any debounce timer and immediately saves pending changes. */
  flush(): Promise<boolean>;
  /** Resolves when any pending or in-flight save has settled. */
  whenIdle(): Promise<void>;
  /** Subscribes to status changes. */
  subscribe(listener: (status: EditorRemoteSyncStatus) => void): () => void;
  /** Cancels timers and unsubscribes from `doc`, without discarding in-flight work. */
  destroy(): void;
}

const cloneSnapshot = <T>(value: T): T => {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
};

/**
 * Reactive, version-safe remote persistence controller for an `EditorDocument`.
 *
 * - Subscribes to `doc` so every edit (history steps, undo/redo, node drags/resizes, inline
 *   node data updates, and companion `extras` changes) automatically diffs against the last
 *   baseline, emits `onLocalChange` for realtime collaboration, and schedules a debounced save.
 * - Serializes remote `save` calls so two saves never overlap on the wire; edits made while a
 *   save is in flight are coalesced into a single follow-up save.
 * - Advances versions monotonically (`Math.max(localVersion, remoteVersion) + 1`), preventing
 *   version-mismatch wedging when collaborators or server triggers advance the remote version.
 */
export function createEditorRemoteSync<TDocument = unknown, TDiff = unknown>(
  doc: EditorDocument<TDocument>,
  options: EditorRemoteSyncOptions<TDocument, TDiff>,
): EditorRemoteSync<TDocument, TDiff> {
  const debounceMs = options.debounceMs ?? 500;
  const now = options.now ?? Date.now;

  let localVersion = options.initialVersion ?? 0;
  let confirmedVersion = localVersion;
  let localSequence = 0;
  let savedSequence = 0;

  let baselineSnapshot: TDocument = cloneSnapshot(doc.getDocument());
  let pendingDiff: TDiff | undefined = undefined;
  let state: EditorRemoteSyncState = "idle";
  let lastSavedAt: number | null = null;
  let lastError: unknown = undefined;

  let isApplyingRemote = false;
  let destroyed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlightPromise: Promise<boolean> | null = null;

  const listeners = new Set<(status: EditorRemoteSyncStatus) => void>();

  const getStatus = (): EditorRemoteSyncStatus => ({
    status: state,
    version: localVersion,
    savedVersion: confirmedVersion,
    dirty: localSequence > savedSequence,
    lastSavedAt,
    ...(lastError !== undefined ? { error: lastError } : {}),
  });

  const emit = () => {
    const currentStatus = getStatus();
    listeners.forEach((listener) => {
      try {
        listener(currentStatus);
      } catch (error) {
        console.error("[remoteSync] Error in status listener:", error);
      }
    });
  };

  const clearTimer = () => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };

  const hasChanged = (current: TDocument, baseline: TDocument): { changed: boolean; diff?: TDiff } => {
    if (options.diff) {
      const diff = options.diff(current, baseline);
      const empty = options.isEmptyDiff
        ? options.isEmptyDiff(diff, current, baseline)
        : JSON.stringify(current) === JSON.stringify(baseline);
      return { changed: !empty, diff };
    }
    return { changed: JSON.stringify(current) !== JSON.stringify(baseline) };
  };

  const executeSave = async (): Promise<boolean> => {
    if (inFlightPromise) {
      await inFlightPromise;
      if (localSequence > savedSequence && !destroyed) {
        return executeSave();
      }
      return true;
    }

    if (localSequence <= savedSequence) {
      return true;
    }

    clearTimer();

    const targetSequence = localSequence;
    const snapshotToSave = cloneSnapshot(baselineSnapshot);
    const diffToSave = pendingDiff;
    const versionToSave = Math.max(localVersion, confirmedVersion + 1);
    localVersion = versionToSave;

    state = "saving";
    lastError = undefined;
    emit();

    const run = (async (): Promise<boolean> => {
      try {
        const result = await options.save({
          document: snapshotToSave,
          version: versionToSave,
          diff: diffToSave,
        });

        const returnedVersion =
          typeof result === "number"
            ? result
            : result && typeof result === "object" && typeof result.version === "number"
              ? result.version
              : versionToSave;

        confirmedVersion = Math.max(confirmedVersion, versionToSave, returnedVersion);
        if (returnedVersion > localVersion) {
          localVersion = returnedVersion;
        }
        savedSequence = Math.max(savedSequence, targetSequence);
        lastSavedAt = now();
        lastError = undefined;

        if (localSequence <= savedSequence) {
          pendingDiff = undefined;
          state = "saved";
          await options.autosave?.markClean();
        } else {
          state = "pending";
        }

        options.onSaved?.({ document: snapshotToSave, version: confirmedVersion });
        emit();
        return true;
      } catch (error) {
        lastError = error;
        state = "error";
        options.onError?.(error);
        emit();
        return false;
      } finally {
        inFlightPromise = null;
      }
    })();

    inFlightPromise = run;
    const ok = await run;

    // If new local edits arrived while the save was in flight and no timer is waiting, save them next.
    if (ok && localSequence > savedSequence && debounceTimer === null && !destroyed) {
      return executeSave();
    }

    return ok;
  };

  const scheduleSave = () => {
    clearTimer();
    if (debounceMs <= 0) {
      void executeSave();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!destroyed) {
        void executeSave();
      }
    }, debounceMs);
  };

  const notify = (): boolean => {
    if (isApplyingRemote || destroyed) return false;
    const current = cloneSnapshot(doc.getDocument());
    const { changed, diff } = hasChanged(current, baselineSnapshot);
    if (!changed) return false;

    const previousBaseline = baselineSnapshot;
    baselineSnapshot = current;
    pendingDiff = diff;
    localSequence++;
    localVersion = Math.max(localVersion, confirmedVersion) + 1;

    if (state !== "saving") {
      state = "pending";
    }
    emit();

    options.onLocalChange?.({
      document: current,
      baseline: previousBaseline,
      diff,
      version: localVersion,
    });

    scheduleSave();
    return true;
  };

  const unsubscribeDoc = doc.subscribe(() => {
    notify();
  });

  return {
    version: () => localVersion,
    savedVersion: () => confirmedVersion,
    dirty: () => localSequence > savedSequence,
    status: getStatus,
    baseline: () => baselineSnapshot,
    notify,
    applyRemote<TResult>(fn: () => TResult, remoteVersion?: number): TResult {
      const wasApplying = isApplyingRemote;
      const wasDirty = localSequence > savedSequence;
      isApplyingRemote = true;
      try {
        const result = fn();
        baselineSnapshot = cloneSnapshot(doc.getDocument());
        if (typeof remoteVersion === "number" && Number.isFinite(remoteVersion)) {
          confirmedVersion = Math.max(confirmedVersion, remoteVersion);
          localVersion = Math.max(localVersion, remoteVersion);
        }
        if (!wasDirty) {
          savedSequence = localSequence;
        }
        emit();
        return result;
      } finally {
        isApplyingRemote = wasApplying;
      }
    },
    resetBaseline(remoteVersion?: number) {
      clearTimer();
      baselineSnapshot = cloneSnapshot(doc.getDocument());
      pendingDiff = undefined;
      if (typeof remoteVersion === "number" && Number.isFinite(remoteVersion)) {
        localVersion = remoteVersion;
        confirmedVersion = remoteVersion;
      }
      savedSequence = localSequence;
      lastError = undefined;
      state = "idle";
      emit();
    },
    async flush(): Promise<boolean> {
      clearTimer();
      notify();
      if (localSequence <= savedSequence && !inFlightPromise) {
        return true;
      }
      return executeSave();
    },
    async whenIdle(): Promise<void> {
      if (debounceTimer !== null) {
        await this.flush();
      } else if (inFlightPromise) {
        await inFlightPromise;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(getStatus());
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      destroyed = true;
      clearTimer();
      unsubscribeDoc();
      listeners.clear();
    },
  };
}
