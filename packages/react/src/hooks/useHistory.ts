import { useSyncExternalStore, useMemo, useCallback } from "react";
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
 * Accepts an existing HistoryManager or config options to create an instance.
 */
export function useHistory(
  managerOrOptions?: HistoryManager | HistoryManagerOptions,
): UseHistoryResult {
  const manager = useMemo(() => {
    if (managerOrOptions instanceof HistoryManager) {
      return managerOrOptions;
    }
    return createHistoryManager(managerOrOptions);
  }, [managerOrOptions]);

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
