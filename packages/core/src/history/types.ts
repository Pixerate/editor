export interface Command {
  execute: () => void;
  undo: () => void;
  redo?: () => void;
  name: string;
  tag?: string;
  timestamp?: number;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoName: string;
  redoName: string;
  undoCount: number;
  redoCount: number;
}

export interface HistoryManagerOptions {
  /**
   * Maximum number of undo states to keep. Defaults to 50.
   */
  maxDepth?: number;
  /**
   * Optional callback fired whenever the history state changes.
   */
  onStateChange?: (state: HistoryState) => void;
}

export interface SnapshotCommandOptions<T> {
  name: string;
  before: T;
  after: T;
  apply: (state: T) => void;
  tag?: string;
}

export interface MergedExecutionOptions {
  /**
   * Window in milliseconds during which commands with the same tag will be coalesced.
   * Defaults to 300ms.
   */
  windowMs?: number;
}
