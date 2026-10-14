import {
  HistoryManager,
  HistoryState,
  HistoryEntry,
  HistoryMark,
  MergedExecutionOptions,
  Command,
  createHistoryManager,
  HistoryManagerOptions,
} from "@pixerate/editor/history";

export interface SvelteHistory extends HistoryState {
  readonly manager: HistoryManager;
  /** History panel rows (undo steps, then redo steps). */
  readonly entries: HistoryEntry[];
  undo(): boolean;
  redo(): boolean;
  clear(): void;
  execute(command: Command): void;
  executeMerged(command: Command, options?: MergedExecutionOptions): void;
  batch(name: string, fn: () => void): void;
  /** Undoes / redoes until the entry at `index` is current (`-1` = before all). */
  goTo(index: number): number;
  /** Captures the current point, e.g. when a drag starts. */
  mark(): HistoryMark;
  /** Takes back every step since `mark` without leaving redo (Escape-cancel). */
  revertTo(mark: HistoryMark): number;
  /** Joins every merged execute into one step until `endGesture`. */
  beginGesture(key: string): void;
  endGesture(): void;
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
    get entries() {
      // Reading `state` makes the getter reactive; getEntries() is cached per change.
      void state;
      return manager.getEntries();
    },
    undo: () => manager.undo(),
    redo: () => manager.redo(),
    clear: () => manager.clear(),
    execute: (cmd: Command) => manager.execute(cmd),
    executeMerged: (cmd: Command, opts?: MergedExecutionOptions) =>
      manager.executeMerged(cmd, opts),
    batch: (name: string, fn: () => void) => manager.batch(name, fn),
    goTo: (index: number) => manager.goTo(index),
    mark: () => manager.mark(),
    revertTo: (m: HistoryMark) => manager.revertTo(m),
    beginGesture: (key: string) => manager.beginGesture(key),
    endGesture: () => manager.endGesture(),
    subscribe: (run: (value: HistoryState) => void) => manager.subscribe(run),
  };
}
