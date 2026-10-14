import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAutosaveController,
  createRevisionTracker,
  type AutosaveController,
  type AutosaveRecovery,
  type AutosaveStatusInfo,
  type DirtyFlagSource,
  type RevisionChangeSource,
  type RevisionTracker,
  type StorageAdapter,
} from '@pixerate/editor/persistence';

export interface UseAutosaveOptions<T> {
  storage: StorageAdapter;
  /** Snapshot key (the meta lives at `<key>:meta`). */
  key: string;
  /** Reads the current document (the latest function is always used). */
  getSnapshot: () => T;
  serialize?: (snapshot: T) => string;
  deserialize?: (text: string) => T;
  /** Document name stored with the snapshot. */
  name?: string;
  /** Change notifications, e.g. a `HistoryManager`. */
  history?: RevisionChangeSource;
  /** Saved-vs-current flag, e.g. `useHistoryDirty().tracker` or a `bindDirtyToHistory` binding. */
  dirty?: DirtyFlagSource;
  interval?: number;
  debounceMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /**
   * Whether the document has finished loading (default `true`). Snapshots start
   * once this is true and any recovered snapshot was restored or discarded.
   */
  ready?: boolean;
  /** Look for an earlier session's snapshot on mount (default `true`). */
  recover?: boolean;
  /** Write pending changes on `pagehide` and when the tab is hidden (default `true`). */
  flushOnHide?: boolean;
}

export interface UseAutosaveResult<T> {
  status: AutosaveStatusInfo;
  /** An earlier session's unsaved snapshot, until restored or discarded. */
  recovery: AutosaveRecovery<T> | null;
  /** True while the recovery check runs or a recovered snapshot awaits a decision. */
  pendingRecovery: boolean;
  /** Takes the recovered snapshot (apply it to the editor) and starts autosaving. */
  restore: () => T | undefined;
  /** Deletes the recovered snapshot and starts autosaving. */
  discard: () => Promise<void>;
  /** Writes pending changes now. */
  flushNow: () => Promise<void>;
  /** Call after an explicit save: marks the current revision saved and retires this session's snapshot. */
  markClean: () => Promise<void>;
  /** Records a change made outside `history`. */
  notifyChange: () => void;
  controller: AutosaveController<T> | null;
}

const IDLE: AutosaveStatusInfo = {
  status: 'idle',
  error: null,
  failures: 0,
  nextAttemptAt: null,
  lastSavedAt: null,
  ready: false,
};

/**
 * Crash-recovery autosave bound to a history and dirty flag, with page
 * lifecycle flushing and a recovery check on mount (see
 * `createAutosaveController` in `@pixerate/editor/persistence`). Render
 * `<RecoveryPrompt>` with `recovery`, `restore` and `discard`.
 */
export function useAutosave<T>(options: UseAutosaveOptions<T>): UseAutosaveResult<T> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const { storage, key, history, dirty } = options;
  const recover = options.recover !== false;
  const flushOnHide = options.flushOnHide !== false;
  const ready = options.ready !== false;

  const [controller, setController] = useState<AutosaveController<T> | null>(null);
  const [status, setStatus] = useState<AutosaveStatusInfo>(IDLE);
  const [recovery, setRecovery] = useState<AutosaveRecovery<T> | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState(recover);
  const revisionsRef = useRef<RevisionTracker | null>(null);

  useEffect(() => {
    const revisions = createRevisionTracker({ history, dirty });
    const o = optionsRef.current;
    const instance = createAutosaveController<T>({
      storage,
      key,
      getSnapshot: () => optionsRef.current.getSnapshot(),
      serialize: o.serialize,
      deserialize: o.deserialize,
      name: () => optionsRef.current.name,
      revision: revisions.revision,
      savedRevision: revisions.savedRevision,
      interval: o.interval,
      debounceMs: o.debounceMs,
      retryBaseMs: o.retryBaseMs,
      retryMaxMs: o.retryMaxMs,
    });
    const unsubscribeStatus = instance.subscribe(setStatus);
    const unsubscribeRevisions = revisions.subscribe(() => instance.notify());
    revisionsRef.current = revisions;
    setController(instance);
    setStatus(instance.getStatus());

    let active = true;
    if (recover) {
      setPendingRecovery(true);
      instance
        .checkRecovery()
        .catch(() => null)
        .then((found) => {
          if (!active) return;
          setRecovery(found);
          setPendingRecovery(found !== null);
        });
    } else {
      setRecovery(null);
      setPendingRecovery(false);
    }

    return () => {
      active = false;
      unsubscribeStatus();
      unsubscribeRevisions();
      revisions.destroy();
      instance.destroy();
      if (revisionsRef.current === revisions) revisionsRef.current = null;
    };
  }, [storage, key, history, dirty, recover]);

  useEffect(() => {
    if (controller && ready && !pendingRecovery) controller.ready();
  }, [controller, ready, pendingRecovery]);

  useEffect(() => {
    if (!controller || !flushOnHide || typeof window === 'undefined') return;
    const flush = () => void controller.flushNow();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [controller, flushOnHide]);

  const restore = useCallback(() => {
    const snapshot = recovery?.snapshot;
    setRecovery(null);
    setPendingRecovery(false);
    return snapshot;
  }, [recovery]);

  const discard = useCallback(async () => {
    if (controller) await controller.discardRecovery();
    setRecovery(null);
    setPendingRecovery(false);
  }, [controller]);

  const flushNow = useCallback(async () => {
    await controller?.flushNow();
  }, [controller]);

  const markClean = useCallback(async () => {
    revisionsRef.current?.markSaved();
    await controller?.markClean();
  }, [controller]);

  const notifyChange = useCallback(() => revisionsRef.current?.bump(), []);

  return { status, recovery, pendingRecovery, restore, discard, flushNow, markClean, notifyChange, controller };
}
