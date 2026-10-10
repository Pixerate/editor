import { useSyncExternalStore, useRef, useCallback } from "react";
import {
  HistoryManager,
  HistoryState,
  Command,
  createHistoryManager,
  HistoryManagerOptions,
} from "@pixerate/editor";

export interface UseHistoryResult extends HistoryState {
  manager: HistoryManager;
  undo: () => boolean;
  redo: () => boolean;
  clear: () => void;
  execute: (command: Command) => void;
  executeMerged: (command: Command, options?: { windowMs?: number }) => void;
  batch: (name: string, fn: () => void) => void;
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

  const undo = useCallback(() => manager.undo(), [manager]);
  const redo = useCallback(() => manager.redo(), [manager]);
  const clear = useCallback(() => manager.clear(), [manager]);
  const execute = useCallback(
    (cmd: Command) => manager.execute(cmd),
    [manager],
  );
  const executeMerged = useCallback(
    (cmd: Command, opts?: { windowMs?: number }) =>
      manager.executeMerged(cmd, opts),
    [manager],
  );
  const batch = useCallback(
    (name: string, fn: () => void) => manager.batch(name, fn),
    [manager],
  );

  return {
    ...state,
    manager,
    undo,
    redo,
    clear,
    execute,
    executeMerged,
    batch,
  };
}
