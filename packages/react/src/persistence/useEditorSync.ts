import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createEditorRemoteSync,
  type EditorDocument,
  type EditorRemoteSync,
  type EditorRemoteSyncOptions,
  type EditorRemoteSyncStatus,
} from '@pixerate/editor/persistence';

export interface UseEditorSyncOptions<TDocument = unknown, TDiff = unknown> extends EditorRemoteSyncOptions<TDocument, TDiff> {
  /**
   * Flush pending debounced changes when the tab hides or unloads (`visibilitychange` to
   * `"hidden"`, `pagehide`; default `true`).
   */
  flushOnHide?: boolean;
}

export interface UseEditorSyncResult<TDocument = unknown, TDiff = unknown> {
  status: EditorRemoteSyncStatus;
  version: number;
  savedVersion: number;
  dirty: boolean;
  /** The controller, once mounted (`null` during the first render). */
  controller: EditorRemoteSync<TDocument, TDiff> | null;
  baseline(): TDocument | undefined;
  notify(): boolean;
  /** Runs `fn` without saving or reporting it as a local change (before mount, just runs `fn`). */
  applyRemote<TResult>(fn: () => TResult, remoteVersion?: number): TResult;
  resetBaseline(remoteVersion?: number): void;
  flush(): Promise<boolean>;
  whenIdle(): Promise<void>;
}

/**
 * React hook wrapping `createEditorRemoteSync`: saves `doc` to a remote backend after each change
 * (debounced, one save at a time, monotonic versions) and re-renders on status changes. Callbacks
 * in `options` may change between renders; `initialVersion` and `debounceMs` are read when `doc`
 * is first synced. Pending changes are flushed on unmount. Pass a stable `doc`.
 */
export function useEditorSync<TDocument = unknown, TDiff = unknown>(
  doc: EditorDocument<TDocument>,
  options: UseEditorSyncOptions<TDocument, TDiff>,
): UseEditorSyncResult<TDocument, TDiff> {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [controller, setController] = useState<EditorRemoteSync<TDocument, TDiff> | null>(null);
  const [status, setStatus] = useState<EditorRemoteSyncStatus>(() => ({
    status: 'idle',
    version: options.initialVersion ?? 0,
    savedVersion: options.initialVersion ?? 0,
    dirty: false,
    lastSavedAt: null,
  }));

  // Created in an effect (like `useAutosave`) so StrictMode's mount / unmount / mount never
  // leaves a destroyed controller in use.
  useEffect(() => {
    const { flushOnHide: _flushOnHide, ...initial } = optionsRef.current;
    const instance = createEditorRemoteSync<TDocument, TDiff>(doc, {
      ...initial,
      save: (context) => optionsRef.current.save(context),
      diff: initial.diff ? (current, baseline) => optionsRef.current.diff!(current, baseline) : undefined,
      isEmptyDiff: initial.isEmptyDiff
        ? (diff, current, baseline) => optionsRef.current.isEmptyDiff!(diff, current, baseline)
        : undefined,
      onLocalChange: (event) => optionsRef.current.onLocalChange?.(event),
      onSaved: (event) => optionsRef.current.onSaved?.(event),
      onError: (error) => optionsRef.current.onError?.(error),
      onConflict: initial.onConflict ? (context) => optionsRef.current.onConflict!(context) : undefined,
      autosave: { markClean: async () => optionsRef.current.autosave?.markClean() },
    });
    const unsubscribe = instance.subscribe(setStatus);
    setController(instance);
    return () => {
      unsubscribe();
      void instance.flush();
      instance.destroy();
    };
  }, [doc]);

  const flushOnHide = options.flushOnHide ?? true;
  useEffect(() => {
    if (!controller || !flushOnHide || typeof window === 'undefined') return;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') void controller.flush();
    };
    const onPageHide = () => void controller.flush();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [controller, flushOnHide]);

  const applyRemote = useCallback(
    <TResult,>(fn: () => TResult, remoteVersion?: number): TResult =>
      controller ? controller.applyRemote(fn, remoteVersion) : fn(),
    [controller],
  );

  return useMemo(
    () => ({
      status,
      version: status.version,
      savedVersion: status.savedVersion,
      dirty: status.dirty,
      controller,
      baseline: () => controller?.baseline(),
      notify: () => controller?.notify() ?? false,
      applyRemote,
      resetBaseline: (remoteVersion?: number) => controller?.resetBaseline(remoteVersion),
      flush: () => controller?.flush() ?? Promise.resolve(true),
      whenIdle: () => controller?.whenIdle() ?? Promise.resolve(),
    }),
    [status, controller, applyRemote],
  );
}
