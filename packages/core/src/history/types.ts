export interface Command {
  execute: () => void;
  undo: () => void;
  redo?: () => void;
  name: string;
  tag?: string;
  timestamp?: number;
  /**
   * Approximate memory held by this command (closures, snapshots), in bytes.
   * Counted against `HistoryManagerOptions.maxBytes` when no `sizeOf` hook is set.
   */
  byteSize?: number;
  /**
   * Who made the change: `user` (the default) or `agent:<id>` for an agent. Falls back to the
   * origin set with `HistoryManager.withOrigin`, then to `user`.
   */
  origin?: string;
}

/** The origin of changes no one has claimed: the person at the keyboard. */
export const USER_ORIGIN = "user";

/** The origin of an agent's changes: `agent:<id>`. */
export function agentOrigin(agentId: string): string {
  return `agent:${agentId}`;
}

/** The agent id of an `agent:<id>` origin, or `null` for any other origin. */
export function originAgentId(origin: string | undefined): string | null {
  return origin?.startsWith("agent:") ? origin.slice("agent:".length) || null : null;
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
   * Approximate memory budget in bytes for the undo and redo stacks
   * (0 or omitted = unlimited). The oldest undo steps that do not fit are
   * dropped; the most recent one is always kept so the last step can be undone.
   */
  maxBytes?: number;
  /**
   * Measures a command for `maxBytes`. Defaults to `command.byteSize ?? 0`.
   */
  sizeOf?: (command: Command) => number;
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
   * Defaults to 300ms. Ignored when `key` is set or a gesture is held.
   */
  windowMs?: number;
  /**
   * Gesture key. Consecutive merged executes with the same key fold into one
   * undo step regardless of timing, until another command is recorded, undo /
   * redo / `revertTo` / `goTo` runs, or `endGesture()` is called.
   */
  key?: string;
}

/** One row of a History panel (see `HistoryManager.getEntries`). */
export interface HistoryEntry {
  /** Stable id of the step (unchanged while a gesture merges into it). */
  id: number;
  /** The step's command name. */
  label: string;
  /** Position in the timeline: undo steps first (oldest = 0), then redo steps. */
  index: number;
  /** True for the step that produced the current state (the top of the undo stack). */
  current: boolean;
  /** True for steps on the redo stack (undone, can be redone). */
  undone: boolean;
  /** Who made the step: `user` or `agent:<id>` (see `Command.origin`). */
  origin: string;
  /** The step's command tag, when it has one (see `Command.tag`). */
  tag?: string;
}

/**
 * What a `HistoryManager.onCommit` listener hears:
 * - `execute`: a new step was recorded (also a `batch`).
 * - `merge`: a change folded into the top step (a gesture or a coalesced `executeMerged`).
 * - `undo` / `redo`: one step was taken back or re-applied (`goTo` reports one per step).
 * - `revert`: `revertTo` took steps back for good.
 * - `drop`: `dropSteps` removed steps without running them.
 * - `clear`: the history was emptied.
 */
export type HistoryCommitKind =
  | "execute"
  | "merge"
  | "undo"
  | "redo"
  | "revert"
  | "drop"
  | "clear";

export interface HistoryCommitEvent {
  kind: HistoryCommitKind;
  /** The step recorded, merged into, undone or redone. Absent for `revert`, `drop` and `clear`. */
  entry?: HistoryEntry;
  /** Who made the change: the step's origin for `execute` / `merge`, else the origin in effect. */
  origin: string;
  /** `HistoryManager.getRevision()` after the change. */
  revision: number;
}

/**
 * A point in the undo history, from `HistoryManager.mark()`, for `revertTo`.
 * Treat it as opaque.
 */
export interface HistoryMark {
  readonly topId: number | null;
  readonly nextId: number;
  readonly epoch: number;
  readonly dropped: number;
}
