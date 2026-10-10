import {
  Command,
  HistoryManagerOptions,
  HistoryState,
  MergedExecutionOptions,
  SnapshotCommandOptions,
} from "./types";

/**
 * UI-agnostic History and Undo/Redo manager supporting command closures,
 * snapshot diffs, transaction batching, and high-frequency event coalescing.
 */
export class HistoryManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private readonly maxDepth: number;
  private isApplying = false;
  private batchDepth = 0;
  private currentBatch: Command[] | null = null;
  private listeners: Set<(state: HistoryState) => void> = new Set();
  private onStateChange?: (state: HistoryState) => void;
  private cachedState: HistoryState;

  constructor(options: HistoryManagerOptions = {}) {
    this.maxDepth = options.maxDepth ?? 50;
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

  private notify(): void {
    this.cachedState = this.computeState();
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

  /**
   * Executes a command and pushes it onto the undo stack.
   * Clears the redo stack.
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

    this.undoStack.push({
      ...command,
      timestamp: command.timestamp ?? Date.now(),
    });

    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }

    this.redoStack = [];
    this.notify();
  }

  /**
   * Executes a command, coalescing it with the previous command if they share
   * the same `tag` and occurred within `windowMs` (default: 300ms).
   * Useful for high-frequency interactions like slider scrubs or node drags.
   */
  public executeMerged(
    command: Command,
    options: MergedExecutionOptions = {},
  ): void {
    const windowMs = options.windowMs ?? 300;
    const now = Date.now();

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
        const initialUndo = top.undo;
        this.undoStack[this.undoStack.length - 1] = {
          name: command.name,
          tag: command.tag,
          timestamp: now,
          execute: command.execute,
          undo: initialUndo,
          redo: command.redo ?? command.execute,
        };
        this.redoStack = [];
        this.notify();
        return;
      }
    }

    this.execute({ ...command, timestamp: now });
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
      const compoundCommand: Command = {
        name,
        timestamp: Date.now(),
        execute: () => {
          for (let i = 0; i < batchCommands.length; i++) {
            (batchCommands[i].redo ?? batchCommands[i].execute)();
          }
        },
        undo: () => {
          for (let i = batchCommands.length - 1; i >= 0; i--) {
            batchCommands[i].undo();
          }
        },
        redo: () => {
          for (let i = 0; i < batchCommands.length; i++) {
            (batchCommands[i].redo ?? batchCommands[i].execute)();
          }
        },
      };

      this.undoStack.push(compoundCommand);
      if (this.undoStack.length > this.maxDepth) {
        this.undoStack.shift();
      }
      this.redoStack = [];
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

  /**
   * Reverts the most recent command on the undo stack.
   * Returns true if a command was undone, false otherwise.
   */
  public undo(): boolean {
    if (this.undoStack.length === 0 || this.isApplying || this.batchDepth > 0) {
      return false;
    }

    this.isApplying = true;
    try {
      const command = this.undoStack[this.undoStack.length - 1];
      // If undo throws, the command stays on the undo stack and the error propagates.
      command.undo();
      this.undoStack.pop();
      this.redoStack.push(command);
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
    try {
      const command = this.redoStack[this.redoStack.length - 1];
      // If redo throws, the command stays on the redo stack and the error propagates.
      (command.redo ?? command.execute)();
      this.redoStack.pop();
      this.undoStack.push(command);
      return true;
    } finally {
      this.isApplying = false;
      this.notify();
    }
  }

  /**
   * Clears both undo and redo stacks.
   */
  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
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
