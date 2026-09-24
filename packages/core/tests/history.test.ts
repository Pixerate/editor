import { describe, it, expect, vi } from "vitest";
import { HistoryManager, createHistoryManager, Command } from "../src/history";

describe("HistoryManager", () => {
  it("initializes with empty state", () => {
    const history = createHistoryManager();
    const state = history.getState();
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.undoName).toBe("");
    expect(state.redoName).toBe("");
    expect(state.undoCount).toBe(0);
    expect(state.redoCount).toBe(0);
  });

  it("executes commands and updates undo stack", () => {
    const history = new HistoryManager();
    let value = 0;

    const cmd: Command = {
      name: "Increment",
      execute: () => {
        value += 1;
      },
      undo: () => {
        value -= 1;
      },
    };

    history.execute(cmd);
    expect(value).toBe(1);
    expect(history.getState().canUndo).toBe(true);
    expect(history.getState().canRedo).toBe(false);
    expect(history.getState().undoName).toBe("Increment");
    expect(history.getState().undoCount).toBe(1);
  });

  it("supports undo and redo cycles", () => {
    const history = new HistoryManager();
    let text = "initial";

    history.execute({
      name: "Set Hello",
      execute: () => {
        text = "hello";
      },
      undo: () => {
        text = "initial";
      },
    });

    expect(text).toBe("hello");

    const undone = history.undo();
    expect(undone).toBe(true);
    expect(text).toBe("initial");
    expect(history.getState().canUndo).toBe(false);
    expect(history.getState().canRedo).toBe(true);
    expect(history.getState().redoName).toBe("Set Hello");

    const redone = history.redo();
    expect(redone).toBe(true);
    expect(text).toBe("hello");
    expect(history.getState().canUndo).toBe(true);
    expect(history.getState().canRedo).toBe(false);
  });

  it("clears redo stack upon new execution", () => {
    const history = new HistoryManager();
    let count = 0;

    history.execute({
      name: "Add 1",
      execute: () => {
        count += 1;
      },
      undo: () => {
        count -= 1;
      },
    });

    history.undo();
    expect(history.getState().canRedo).toBe(true);

    history.execute({
      name: "Add 10",
      execute: () => {
        count += 10;
      },
      undo: () => {
        count -= 10;
      },
    });

    expect(history.getState().canRedo).toBe(false);
    expect(history.getState().undoName).toBe("Add 10");
  });

  it("enforces maxDepth stack limitation", () => {
    const history = new HistoryManager({ maxDepth: 3 });
    let val = 0;

    for (let i = 1; i <= 5; i++) {
      history.execute({
        name: `Step ${i}`,
        execute: () => {
          val = i;
        },
        undo: () => {
          val = i - 1;
        },
      });
    }

    const state = history.getState();
    expect(state.undoCount).toBe(3);

    // Should only be able to undo 3 times
    expect(history.undo()).toBe(true); // Step 5 -> 4
    expect(history.undo()).toBe(true); // Step 4 -> 3
    expect(history.undo()).toBe(true); // Step 3 -> 2
    expect(history.undo()).toBe(false);
  });

  it("notifies subscribers of state changes", () => {
    const history = new HistoryManager();
    const listener = vi.fn();

    const unsubscribe = history.subscribe(listener);
    // Called immediately on subscription
    expect(listener).toHaveBeenCalledTimes(1);

    history.execute({
      name: "Action",
      execute: () => {},
      undo: () => {},
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ canUndo: true, undoName: "Action" }),
    );

    unsubscribe();
    history.undo();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("batches multiple commands into a single compound undo entry", () => {
    const history = new HistoryManager();
    const log: string[] = [];

    history.batch("Group Operation", () => {
      history.execute({
        name: "Op 1",
        execute: () => log.push("1"),
        undo: () => log.push("undo 1"),
      });
      history.execute({
        name: "Op 2",
        execute: () => log.push("2"),
        undo: () => log.push("undo 2"),
      });
    });

    expect(log).toEqual(["1", "2"]);
    expect(history.getState().undoCount).toBe(1);
    expect(history.getState().undoName).toBe("Group Operation");

    log.length = 0;
    history.undo();
    // Sub-commands undone in reverse order
    expect(log).toEqual(["undo 2", "undo 1"]);

    log.length = 0;
    history.redo();
    // Sub-commands re-executed in forward order
    expect(log).toEqual(["1", "2"]);
  });

  it("coalesces rapid events with executeMerged", () => {
    const history = new HistoryManager();
    let sliderValue = 0;

    // Simulate drag start
    history.executeMerged(
      {
        name: "Set Slider 10",
        tag: "slider-drag",
        execute: () => {
          sliderValue = 10;
        },
        undo: () => {
          sliderValue = 0;
        },
      },
      { windowMs: 200 },
    );

    expect(sliderValue).toBe(10);
    expect(history.getState().undoCount).toBe(1);

    // Simulate rapid drag continuation within window
    history.executeMerged(
      {
        name: "Set Slider 20",
        tag: "slider-drag",
        execute: () => {
          sliderValue = 20;
        },
        undo: () => {
          sliderValue = 10;
        },
      },
      { windowMs: 200 },
    );

    expect(sliderValue).toBe(20);
    expect(history.getState().undoCount).toBe(1);
    expect(history.getState().undoName).toBe("Set Slider 20");

    // Undoing should revert all the way back to initial state (0), preserving the first undo closure
    history.undo();
    expect(sliderValue).toBe(0);

    // Redo should apply the final value (20)
    history.redo();
    expect(sliderValue).toBe(20);
  });

  it("creates and handles snapshot commands with createSnapshotCommand", () => {
    const history = new HistoryManager();
    let state = { count: 0, text: "foo" };

    const cmd = HistoryManager.createSnapshotCommand({
      name: "Update State",
      before: state,
      after: { count: 1, text: "bar" },
      apply: (next) => {
        state = next;
      },
    });

    history.execute(cmd);
    expect(state).toEqual({ count: 1, text: "bar" });

    history.undo();
    expect(state).toEqual({ count: 0, text: "foo" });

    history.redo();
    expect(state).toEqual({ count: 1, text: "bar" });
  });

  it("clears all history with clear()", () => {
    const history = new HistoryManager();
    history.execute({
      name: "Test",
      execute: () => {},
      undo: () => {},
    });
    expect(history.getState().canUndo).toBe(true);

    history.clear();
    expect(history.getState().canUndo).toBe(false);
    expect(history.getState().undoCount).toBe(0);
  });
});
