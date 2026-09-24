import {
  HistoryManager,
  HistoryState,
  Command,
  createHistoryManager,
  HistoryManagerOptions,
} from "@pixerate/editor";

export interface SvelteHistory extends HistoryState {
  readonly manager: HistoryManager;
  undo(): boolean;
  redo(): boolean;
  clear(): void;
  execute(command: Command): void;
  executeMerged(command: Command, options?: { windowMs?: number }): void;
  batch(name: string, fn: () => void): void;
  subscribe(run: (value: HistoryState) => void): () => void;
}

/**
 * Creates a reactive Svelte 5 rune-based and Svelte store-compatible history adapter.
 */
export function createHistory(
  managerOrOptions?: HistoryManager | HistoryManagerOptions,
): SvelteHistory {
  const manager =
    managerOrOptions instanceof HistoryManager
      ? managerOrOptions
      : createHistoryManager(managerOrOptions);

  let state = $state<HistoryState>(manager.getState());

  manager.subscribe((newState) => {
    state = newState;
  });

  return {
    get canUndo() {
      return state.canUndo;
    },
    get canRedo() {
      return state.canRedo;
    },
    get undoName() {
      return state.undoName;
    },
    get redoName() {
      return state.redoName;
    },
    get undoCount() {
      return state.undoCount;
    },
    get redoCount() {
      return state.redoCount;
    },
    get manager() {
      return manager;
    },
    undo: () => manager.undo(),
    redo: () => manager.redo(),
    clear: () => manager.clear(),
    execute: (cmd: Command) => manager.execute(cmd),
    executeMerged: (cmd: Command, opts?: { windowMs?: number }) =>
      manager.executeMerged(cmd, opts),
    batch: (name: string, fn: () => void) => manager.batch(name, fn),
    subscribe: (run: (value: HistoryState) => void) => manager.subscribe(run),
  };
}
