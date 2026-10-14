import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DirtyTracker,
  bindDirtyToHistory,
  type DirtyTrackerOptions,
  type HistoryDirtyBinding,
  type HistoryManager,
} from "@pixerate/editor";

export interface UseHistoryDirtyOptions<T> extends DirtyTrackerOptions<T> {
  /** The history whose changes re-check the document. */
  history: HistoryManager;
  /** Reads the current document value (the latest function is always used). */
  getValue: () => T;
  /** Existing tracker to drive (read on first render only). */
  tracker?: DirtyTracker<T>;
}

export interface UseHistoryDirtyResult<T> {
  /** Whether the document differs from the saved state. Feed it to `useNavigationGuard`. */
  isDirty: boolean;
  /** Marks the current document as saved. */
  markClean: () => void;
  /** Runs a load / restore without marking the document dirty (re-entrant). */
  suppress: <R>(fn: () => R) => R;
  /** Re-checks after a change made outside the history. */
  refresh: () => boolean;
  tracker: DirtyTracker<T>;
}

/**
 * Dirty-vs-saved tracking bound to a HistoryManager: undoing back to the saved
 * state makes the document clean again, selection/viewport changes can be
 * ignored with `normalize`, and programmatic loads can be wrapped in `suppress`.
 * Options other than `getValue` and `history` are read on first render only.
 */
export function useHistoryDirty<T>(
  options: UseHistoryDirtyOptions<T>,
): UseHistoryDirtyResult<T> {
  const getValueRef = useRef(options.getValue);
  getValueRef.current = options.getValue;

  const [tracker] = useState(
    () =>
      options.tracker ??
      new DirtyTracker<T>(options.getValue(), {
        isEqual: options.isEqual,
        normalize: options.normalize,
      }),
  );

  const bindingRef = useRef<HistoryDirtyBinding<T> | null>(null);
  useEffect(() => {
    const binding = bindDirtyToHistory<T>({
      history: options.history,
      getValue: () => getValueRef.current(),
      tracker,
    });
    bindingRef.current = binding;
    return () => {
      binding.destroy();
      if (bindingRef.current === binding) bindingRef.current = null;
    };
  }, [options.history, tracker]);

  const isDirty = useSyncExternalStore(
    useCallback((onChange) => tracker.subscribe(onChange), [tracker]),
    () => tracker.dirty,
    () => tracker.dirty,
  );

  const markClean = useCallback(
    () => tracker.markClean(getValueRef.current()),
    [tracker],
  );
  const suppress = useCallback(
    <R,>(fn: () => R): R =>
      bindingRef.current ? bindingRef.current.suppress(fn) : tracker.suppress(fn),
    [tracker],
  );
  const refresh = useCallback(
    () => tracker.update(getValueRef.current()),
    [tracker],
  );

  return { isDirty, markClean, suppress, refresh, tracker };
}
