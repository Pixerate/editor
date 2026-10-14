// Portions ported from filmcraft-main/crates/engine/src/lib.rs, soundcraft-main/crates/engine/src/lib.rs
// and photocraft-main/crates/ops/src/lib.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// See THIRD_PARTY_NOTICES.md.
import {
  Command,
  HistoryEntry,
  HistoryManagerOptions,
  HistoryMark,
  HistoryState,
  MergedExecutionOptions,
  SnapshotCommandOptions,
} from "./types";

/** One reversible piece of a step. A gesture step holds one part per distinct command. */
interface Part {
  undo: () => void;
  redo: () => void;
  tag?: string;
  bytes: number;
}

/** One undo step. */
interface Entry {
  id: number;
  name: string;
  tag?: string;
  timestamp: number;
  parts: Part[];
  bytes: number;
}

const sumBytes = (parts: Part[]) => parts.reduce((n, p) => n + p.bytes, 0);

function undoParts(parts: Part[]): void {
  for (let i = parts.length - 1; i >= 0; i--) parts[i].undo();
}

function redoParts(parts: Part[]): void {
  for (let i = 0; i < parts.length; i++) parts[i].redo();
}

/**
 * UI-agnostic History and Undo/Redo manager supporting command closures,
 * snapshot diffs, transaction batching, high-frequency event coalescing,
 * keyed gestures, undo marks, a memory budget and a History-panel listing.
 */
export class HistoryManager {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private readonly maxDepth: number;
  private readonly maxBytes: number;
  private readonly sizeOf?: (command: Command) => number;
  private isApplying = false;
  private batchDepth = 0;
  private currentBatch: Command[] | null = null;
  private listeners: Set<(state: HistoryState) => void> = new Set();
  private onStateChange?: (state: HistoryState) => void;
  private cachedState: HistoryState;
  private cachedEntries: HistoryEntry[] | null = null;

  private nextId = 1;
  private revision = 0;
  /** Bumped by `clear()`; marks from an earlier epoch are stale. */
  private epoch = 0;
  /** Number of steps dropped from the bottom (depth / byte budget) so far. */
  private dropped = 0;
  /** Key of the gesture that the top step belongs to (see `executeMerged`). */
  private gestureKey: string | null = null;
  private gestureEntryId: number | null = null;
  /** Key every merged execute takes while a gesture is held (`beginGesture`). */
  private heldKey: string | null = null;

  constructor(options: HistoryManagerOptions = {}) {
    this.maxDepth = options.maxDepth ?? 50;
    this.maxBytes = Math.max(0, options.maxBytes ?? 0);
    this.sizeOf = options.sizeOf;
    this.onStateChange = options.onStateChange;
    this.cachedState = this.computeState();
  }

  private computeState(): HistoryState {
    const canUndo = this.undoStack.length > 0;
    const canRedo = this.redoStack.length > 0;
    return {
      canUndo,
      canRedo,
      undoName: canUndo ? this.undoStack[this.undoStack.length - 1].name : "",
      redoName: canRedo ? this.redoStack[this.redoStack.length - 1].name : "",
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
    };
  }

  /**
   * Returns a snapshot of the current history state.
   * Cached to maintain referential equality across renders for useSyncExternalStore.
   */
  public getState(): HistoryState {
    return this.cachedState;
  }

  /**
   * Monotonic counter bumped on every history change (execute, merge, undo,
   * redo, revert, clear). Useful as a cache key, e.g. for `DirtyTracker`.
   */
  public getRevision(): number {
    return this.revision;
  }

  private notify(): void {
    this.revision++;
    this.cachedState = this.computeState();
    this.cachedEntries = null;
    const state = this.cachedState;
    this.onStateChange?.(state);
    this.listeners.forEach((listener) => {
      try {
        listener(state);
      } catch (err) {
        console.error("[HistoryManager] Error in state listener:", err);
      }
    });
  }

  private measure(command: Command): number {
    const n = this.sizeOf ? this.sizeOf(command) : (command.byteSize ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private makeEntry(command: Command, timestamp: number): Entry {
    const part: Part = {
      undo: command.undo,
      redo: command.redo ?? command.execute,
      tag: command.tag,
      bytes: this.measure(command),
    };
    return {
      id: this.nextId++,
      name: command.name,
      tag: command.tag,
      timestamp,
      parts: [part],
      bytes: part.bytes,
    };
  }

  /** Pushes a step, clears redo and applies the depth and byte limits. */
  private record(entry: Entry): void {
    this.undoStack.push(entry);
    while (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
      this.dropped++;
    }
    this.redoStack = [];
    this.trim();
  }

  /**
   * Keeps the stacks within `maxBytes`: the oldest undo steps that do not fit
   * are dropped, but the most recent undo step is always kept.
   */
  private trim(): void {
    if (this.maxBytes <= 0 || this.undoStack.length <= 1) return;
    let total = this.getByteSize();
    while (total > this.maxBytes && this.undoStack.length > 1) {
      total -= this.undoStack.shift()!.bytes;
      this.dropped++;
    }
  }

  /** Approximate bytes held by the undo and redo stacks (see `maxBytes`). */
  public getByteSize(): number {
    let total = 0;
    for (const e of this.undoStack) total += e.bytes;
    for (const e of this.redoStack) total += e.bytes;
    return total;
  }

  private resetGesture(): void {
    this.gestureKey = null;
    this.gestureEntryId = null;
  }

  /**
   * Executes a command and pushes it onto the undo stack.
   * Clears the redo stack and ends the current gesture.
   */
  public execute(command: Command): void {
    if (this.isApplying) {
      command.execute();
      return;
    }

    if (this.batchDepth > 0 && this.currentBatch) {
      command.execute();
      this.currentBatch.push({
        ...command,
        timestamp: command.timestamp ?? Date.now(),
      });
      return;
    }

    command.execute();
    this.record(this.makeEntry(command, command.timestamp ?? Date.now()));
    this.resetGesture();
    this.notify();
  }

  /**
   * Executes a command as part of a continuous interaction (slider scrub, node drag).
   *
   * - With `options.key` (or while a gesture is held with `beginGesture`):
   *   consecutive merged executes with the same key fold into one undo step,
   *   however long the gesture lasts. Recording any other command, undo, redo,
   *   `revertTo`, `goTo`, `clear` or `endGesture()` ends the gesture.
   * - Without a key: coalesces with the previous command if they share the same
   *   `tag` and occurred within `windowMs` (default: 300ms).
   */
  public executeMerged(
    command: Command,
    options: MergedExecutionOptions = {},
  ): void {
    const now = Date.now();
    const key = this.heldKey ?? options.key;

    if (key !== undefined) {
      if (this.isApplying || this.batchDepth > 0) {
        this.execute({ ...command, timestamp: now });
        return;
      }
      const top = this.undoStack[this.undoStack.length - 1];
      if (top && this.gestureKey === key && this.gestureEntryId === top.id) {
        command.execute();
        const redo = command.redo ?? command.execute;
        const bytes = this.measure(command);
        const last = top.parts[top.parts.length - 1];
        if (last.tag !== undefined && last.tag === command.tag) {
          // Same (absolute) command again: keep the pre-gesture undo, take the new redo.
          top.parts[top.parts.length - 1] = { undo: last.undo, redo, tag: last.tag, bytes };
        } else {
          top.parts.push({ undo: command.undo, redo, tag: command.tag, bytes });
        }
        top.bytes = sumBytes(top.parts);
        top.timestamp = now;
        this.redoStack = [];
        this.trim();
        this.notify();
        return;
      }
      this.execute({ ...command, timestamp: now });
      const pushed = this.undoStack[this.undoStack.length - 1];
      if (pushed) {
        this.gestureKey = key;
        this.gestureEntryId = pushed.id;
      }
      return;
    }

    const windowMs = options.windowMs ?? 300;

    if (
      command.tag &&
      this.undoStack.length > 0 &&
      this.batchDepth === 0 &&
      !this.isApplying
    ) {
      const top = this.undoStack[this.undoStack.length - 1];
      const elapsed = top.timestamp ? now - top.timestamp : Infinity;

      if (top.tag === command.tag && elapsed <= windowMs) {
        command.execute();
        // Replace top with merged command keeping the original initial undo
        const initialParts = top.parts;
        const bytes = this.measure(command);
        this.undoStack[this.undoStack.length - 1] = {
          id: top.id,
          name: command.name,
          tag: command.tag,
          timestamp: now,
          parts: [
            {
              undo: () => undoParts(initialParts),
              redo: command.redo ?? command.execute,
              tag: command.tag,
              bytes,
            },
          ],
          bytes,
        };
        this.redoStack = [];
        this.resetGesture();
        this.trim();
        this.notify();
        return;
      }
    }

    this.execute({ ...command, timestamp: now });
  }

  /**
   * Holds a gesture: until `endGesture()`, every `executeMerged` call (whatever
   * its own key or tag) joins one undo step, e.g. an automation pass and
   * whatever is dragged during it. Commands recorded with `execute` still end
   * the current step; the next merged execute then starts a new one.
   */
  public beginGesture(key: string): void {
    if (this.heldKey === key) return;
    this.heldKey = key;
    this.resetGesture();
  }

  /** Ends the current (keyed or held) gesture; the next merged execute starts a new step. */
  public endGesture(): void {
    this.heldKey = null;
    this.resetGesture();
  }

  /** The key of the gesture currently merging into the top step, if any. */
  public getGestureKey(): string | null {
    return this.heldKey ?? this.gestureKey;
  }

  /**
   * Batches multiple commands executed within `fn` into a single atomic undo entry.
   */
  public batch(name: string, fn: () => void): void {
    if (this.isApplying) {
      fn();
      return;
    }

    if (this.batchDepth > 0) {
      // Already inside a batch; execute directly
      fn();
      return;
    }

    this.batchDepth++;
    this.currentBatch = [];

    try {
      fn();
    } catch (error) {
      const executed = this.currentBatch ?? [];
      this.batchDepth--;
      this.currentBatch = null;
      this.rollback(executed);
      throw error;
    }

    this.batchDepth--;
    const batchCommands: Command[] = this.currentBatch ?? [];
    this.currentBatch = null;

    if (batchCommands.length > 0) {
      const run = () => {
        for (let i = 0; i < batchCommands.length; i++) {
          (batchCommands[i].redo ?? batchCommands[i].execute)();
        }
      };
      const bytes = batchCommands.reduce((n, c) => n + this.measure(c), 0);
      this.record({
        id: this.nextId++,
        name,
        timestamp: Date.now(),
        parts: [
          {
            undo: () => {
              for (let i = batchCommands.length - 1; i >= 0; i--) {
                batchCommands[i].undo();
              }
            },
            redo: run,
            bytes,
          },
        ],
        bytes,
      });
      this.resetGesture();
      this.notify();
    }
  }

  /**
   * Reverts already-executed commands of an aborted batch, newest first.
   * Commands executed by the undo closures themselves are not recorded.
   */
  private rollback(commands: Command[]): void {
    const wasApplying = this.isApplying;
    this.isApplying = true;
    try {
      for (let i = commands.length - 1; i >= 0; i--) {
        try {
          commands[i].undo();
        } catch (err) {
          console.error(
            `[HistoryManager] Error rolling back "${commands[i].name}" of a failed batch:`,
            err,
          );
        }
      }
    } finally {
      this.isApplying = wasApplying;
    }
  }

  /** Undoes the top step (caller holds `isApplying`). Throws leave it on the stack. */
  private undoOne(): void {
    const entry = this.undoStack[this.undoStack.length - 1];
    undoParts(entry.parts);
    this.undoStack.pop();
    this.redoStack.push(entry);
  }

  private redoOne(): void {
    const entry = this.redoStack[this.redoStack.length - 1];
    redoParts(entry.parts);
    this.redoStack.pop();
    this.undoStack.push(entry);
  }

  /**
   * Reverts the most recent command on the undo stack.
   * Returns true if a command was undone, false otherwise.
   */
  public undo(): boolean {
    if (this.undoStack.length === 0 || this.isApplying || this.batchDepth > 0) {
      return false;
    }

    this.isApplying = true;
    this.resetGesture();
    try {
      // If undo throws, the command stays on the undo stack and the error propagates.
      this.undoOne();
      return true;
    } finally {
      this.isApplying = false;
      this.notify();
    }
  }

  /**
   * Re-applies the most recent undone command on the redo stack.
   * Returns true if a command was redone, false otherwise.
   */
  public redo(): boolean {
    if (this.redoStack.length === 0 || this.isApplying || this.batchDepth > 0) {
      return false;
    }

    this.isApplying = true;
    this.resetGesture();
    try {
      // If redo throws, the command stays on the redo stack and the error propagates.
      this.redoOne();
      return true;
    } finally {
      this.isApplying = false;
      this.notify();
    }
  }

  /**
   * Captures the current point in the history (its top step), for `revertTo`.
   */
  public mark(): HistoryMark {
    const top = this.undoStack[this.undoStack.length - 1];
    return {
      topId: top ? top.id : null,
      nextId: this.nextId,
      epoch: this.epoch,
      dropped: this.dropped,
    };
  }

  /** Whether `mark` still points into the undo history. */
  public isMarkValid(mark: HistoryMark): boolean {
    if (mark.epoch !== this.epoch) return false;
    if (mark.topId === null) return mark.dropped === this.dropped;
    return this.undoStack.some((e) => e.id === mark.topId);
  }

  /**
   * Takes back every step made since `mark` (merged or not), e.g. to cancel a
   * drag with Escape: the state returns to how it was at `mark`, and neither
   * undo nor redo keeps the reverted steps. Does nothing when `mark` has left
   * the history (undone past, dropped by the limits, or cleared).
   * Returns how many steps were taken back.
   */
  public revertTo(mark: HistoryMark): number {
    if (this.isApplying || this.batchDepth > 0 || !this.isMarkValid(mark)) {
      return 0;
    }
    const redoBefore = this.redoStack.length;
    let n = 0;
    this.isApplying = true;
    this.resetGesture();
    try {
      while (this.undoStack.length > 0) {
        const top = this.undoStack[this.undoStack.length - 1];
        if (top.id === mark.topId) break;
        undoParts(top.parts);
        this.undoStack.pop();
        n++;
      }
    } finally {
      this.isApplying = false;
      // Steps made after the mark are gone for good, including undone ones.
      this.redoStack =
        n > 0 ? [] : this.redoStack.filter((e) => e.id < mark.nextId);
      if (n > 0 || this.redoStack.length !== redoBefore) this.notify();
    }
    return n;
  }

  /**
   * Lists the steps for a History panel: undo steps oldest first, then redo
   * steps (the next redo first). Cached until the history changes.
   */
  public getEntries(): HistoryEntry[] {
    if (this.cachedEntries) return this.cachedEntries;
    const u = this.undoStack.length;
    const entries: HistoryEntry[] = this.undoStack.map((e, index) => ({
      id: e.id,
      label: e.name,
      index,
      current: index === u - 1,
      undone: false,
    }));
    for (let i = this.redoStack.length - 1; i >= 0; i--) {
      const e = this.redoStack[i];
      entries.push({
        id: e.id,
        label: e.name,
        index: entries.length,
        current: false,
        undone: true,
      });
    }
    this.cachedEntries = entries;
    return entries;
  }

  /**
   * Undoes or redoes until the step at `index` (from `getEntries`) is the
   * current one; `-1` undoes everything. Returns how many steps were applied.
   */
  public goTo(index: number): number {
    if (this.isApplying || this.batchDepth > 0) return 0;
    const total = this.undoStack.length + this.redoStack.length;
    const target = Math.max(0, Math.min(total, Math.floor(index) + 1));
    if (target === this.undoStack.length) return 0;
    let n = 0;
    this.isApplying = true;
    this.resetGesture();
    try {
      while (this.undoStack.length > target) {
        this.undoOne();
        n++;
      }
      while (this.undoStack.length < target) {
        this.redoOne();
        n++;
      }
    } finally {
      this.isApplying = false;
      this.notify();
    }
    return n;
  }

  /**
   * Clears both undo and redo stacks.
   */
  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.epoch++;
    this.resetGesture();
    this.notify();
  }

  /**
   * Subscribes to history state changes.
   * The listener is immediately invoked with the current state.
   * Returns an unsubscribe function.
   */
  public subscribe(listener: (state: HistoryState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Utility helper to create a Command from before/after state snapshots.
   */
  public static createSnapshotCommand<T>(
    options: SnapshotCommandOptions<T>,
  ): Command {
    return {
      name: options.name,
      tag: options.tag,
      execute: () => options.apply(options.after),
      undo: () => options.apply(options.before),
      redo: () => options.apply(options.after),
    };
  }
}

/**
 * Creates and initializes a new HistoryManager instance.
 */
export function createHistoryManager(
  options: HistoryManagerOptions = {},
): HistoryManager {
  return new HistoryManager(options);
}
