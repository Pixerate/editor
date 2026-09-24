import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createHistory,
  createHistoryShortcuts,
} from "../src/history";
import { HistoryManager } from "@pixerate/editor";

describe("Svelte createHistory", () => {
  it("provides reactive getters and methods", () => {
    const history = createHistory();
    let val = 0;

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undoName).toBe("");

    history.execute({
      name: "Increment",
      execute: () => {
        val += 1;
      },
      undo: () => {
        val -= 1;
      },
    });

    expect(val).toBe(1);
    expect(history.canUndo).toBe(true);
    expect(history.undoName).toBe("Increment");
    expect(history.undoCount).toBe(1);

    history.undo();
    expect(val).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(history.redoName).toBe("Increment");

    history.redo();
    expect(val).toBe(1);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
  });

  it("conforms to the Svelte store contract with subscribe()", () => {
    const history = createHistory();
    const states: any[] = [];

    const unsubscribe = history.subscribe((state) => {
      states.push(state);
    });

    expect(states.length).toBe(1);
    expect(states[0].canUndo).toBe(false);

    history.execute({
      name: "Store Action",
      execute: () => {},
      undo: () => {},
    });

    expect(states.length).toBe(2);
    expect(states[1].canUndo).toBe(true);
    expect(states[1].undoName).toBe("Store Action");

    unsubscribe();
  });

  it("handles batch transactions", () => {
    const history = createHistory();
    const ops: string[] = [];

    history.batch("Combined Op", () => {
      history.execute({
        name: "Op 1",
        execute: () => ops.push("1"),
        undo: () => ops.push("-1"),
      });
      history.execute({
        name: "Op 2",
        execute: () => ops.push("2"),
        undo: () => ops.push("-2"),
      });
    });

    expect(ops).toEqual(["1", "2"]);
    expect(history.undoCount).toBe(1);
    expect(history.undoName).toBe("Combined Op");

    history.undo();
    expect(ops).toEqual(["1", "2", "-2", "-1"]);
  });
});

describe("Svelte createHistoryShortcuts", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="input" type="text" />
      <div id="editable" contenteditable="true">Editable</div>
      <div id="plain">Plain</div>
    `;
  });

  it("triggers undo and redo on keyboard shortcuts", () => {
    const manager = new HistoryManager();
    let count = 0;

    manager.execute({
      name: "Count++",
      execute: () => {
        count += 1;
      },
      undo: () => {
        count -= 1;
      },
    });

    const shortcuts = createHistoryShortcuts(manager);
    expect(count).toBe(1);

    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

    // Mod+Z on body -> Undo
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        bubbles: true,
        cancelable: true,
        metaKey: isMac,
        ctrlKey: !isMac,
      }),
    );
    expect(count).toBe(0);

    // Mod+Shift+Z -> Redo
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        metaKey: isMac,
        ctrlKey: !isMac,
      }),
    );
    expect(count).toBe(1);

    shortcuts.destroy();
  });

  it("respects editable element focus guard", () => {
    const manager = new HistoryManager();
    let count = 0;

    manager.execute({
      name: "Count++",
      execute: () => {
        count += 1;
      },
      undo: () => {
        count -= 1;
      },
    });

    const shortcuts = createHistoryShortcuts(manager);
    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

    const undoEvent = () =>
      new KeyboardEvent("keydown", {
        key: "z",
        bubbles: true,
        cancelable: true,
        metaKey: isMac,
        ctrlKey: !isMac,
      });

    // Event originating from input
    const input = document.getElementById("input") as HTMLInputElement;
    input.dispatchEvent(undoEvent());
    expect(count).toBe(1); // Not undone!

    // Event originating from contenteditable
    const editable = document.getElementById("editable") as HTMLDivElement;
    editable.dispatchEvent(undoEvent());
    expect(count).toBe(1); // Not undone!

    // Event originating from non-editable plain div
    const plain = document.getElementById("plain") as HTMLDivElement;
    plain.dispatchEvent(undoEvent());
    expect(count).toBe(0); // Undone!

    shortcuts.destroy();
  });
});
