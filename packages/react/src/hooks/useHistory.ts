import { useSyncExternalStore, useRef, useCallback, useMemo } from "react";
import {
  HistoryManager,
  HistoryState,
  HistoryEntry,
  HistoryMark,
  Command,
  MergedExecutionOptions,
  createHistoryManager,
  HistoryManagerOptions,
} from "@pixerate/editor";

export interface UseHistoryResult extends HistoryState {
  manager: HistoryManager;
  /** History panel rows (undo steps, then redo steps). */
  entries: HistoryEntry[];
  undo: () => boolean;
  redo: () => boolean;
  clear: () => void;
  execute: (command: Command) => void;
  executeMerged: (command: Command, options?: MergedExecutionOptions) => void;
  batch: (name: string, fn: () => void) => void;
  /** Undoes / redoes until the entry at `index` is current (`-1` = before all). */
  goTo: (index: number) => number;
  /** Captures the current point, e.g. when a drag starts. */
  mark: () => HistoryMark;
  /** Takes back every step since `mark` without leaving redo (Escape-cancel). */
  revertTo: (mark: HistoryMark) => number;
  /** Joins every merged execute into one step until `endGesture`. */
  beginGesture: (key: string) => void;
  endGesture: () => void;
}

/**
 * React hook that subscribes to a HistoryManager instance.
 * Accepts an existing HistoryManager or config options to create an instance
 * (options are read on first render only).
 */
export function useHistory(
  managerOrOptions?: HistoryManager | HistoryManagerOptions,
): UseHistoryResult {
  // Options are read once, so passing an inline options object does not
  // create a new manager (and wipe history) on every render.
  const ownManagerRef = useRef<HistoryManager | null>(null);
  let manager: HistoryManager;
  if (managerOrOptions instanceof HistoryManager) {
    manager = managerOrOptions;
  } else {
    ownManagerRef.current ??= createHistoryManager(managerOrOptions);
    manager = ownManagerRef.current;
  }

  const state = useSyncExternalStore(
    useCallback(
      (onStoreChange) => manager.subscribe(onStoreChange),
      [manager],
    ),
    () => manager.getState(),
    () => manager.getState(),
  );

  // getEntries() is cached per history change, so `state` is a valid dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entries = useMemo(() => manager.getEntries(), [manager, state]);

  const undo = useCallback(() => manager.undo(), [manager]);
  const redo = useCallback(() => manager.redo(), [manager]);
  const clear = useCallback(() => manager.clear(), [manager]);
  const execute = useCallback(
    (cmd: Command) => manager.execute(cmd),
    [manager],
  );
  const executeMerged = useCallback(
    (cmd: Command, opts?: MergedExecutionOptions) =>
      manager.executeMerged(cmd, opts),
    [manager],
  );
  const batch = useCallback(
    (name: string, fn: () => void) => manager.batch(name, fn),
    [manager],
  );
  const goTo = useCallback((index: number) => manager.goTo(index), [manager]);
  const mark = useCallback(() => manager.mark(), [manager]);
  const revertTo = useCallback(
    (m: HistoryMark) => manager.revertTo(m),
    [manager],
  );
  const beginGesture = useCallback(
    (key: string) => manager.beginGesture(key),
    [manager],
  );
  const endGesture = useCallback(() => manager.endGesture(), [manager]);

  return {
    ...state,
    manager,
    entries,
    undo,
    redo,
    clear,
    execute,
    executeMerged,
    batch,
    goTo,
    mark,
    revertTo,
    beginGesture,
    endGesture,
  };
}
