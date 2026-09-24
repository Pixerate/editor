import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  useHistory,
  useHistoryShortcuts,
  HistoryManager,
} from "../src";

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    { url: "https://example.com/editor" },
  );
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

describe("useHistory and useHistoryShortcuts", () => {
  it("provides reactive state and methods", async () => {
    let historyHookResult: ReturnType<typeof useHistory> | null = null;
    let stateValue = "initial";

    function TestComponent() {
      const h = useHistory();
      historyHookResult = h;
      return (
        <div>
          <span data-testid="can-undo">{h.canUndo ? "true" : "false"}</span>
          <span data-testid="undo-name">{h.undoName}</span>
        </div>
      );
    }

    await act(async () => {
      root.render(<TestComponent />);
    });

    expect(historyHookResult!.canUndo).toBe(false);

    await act(async () => {
      historyHookResult!.execute({
        name: "Change State",
        execute: () => {
          stateValue = "modified";
        },
        undo: () => {
          stateValue = "initial";
        },
      });
    });

    expect(stateValue).toBe("modified");
    expect(historyHookResult!.canUndo).toBe(true);
    expect(historyHookResult!.undoName).toBe("Change State");

    await act(async () => {
      historyHookResult!.undo();
    });

    expect(stateValue).toBe("initial");
    expect(historyHookResult!.canUndo).toBe(false);
    expect(historyHookResult!.canRedo).toBe(true);
    expect(historyHookResult!.redoName).toBe("Change State");
  });

  it("handles keyboard shortcuts and respects editable element focus guards", async () => {
    const manager = new HistoryManager();
    let count = 0;

    manager.execute({
      name: "Increment",
      execute: () => {
        count += 1;
      },
      undo: () => {
        count -= 1;
      },
    });

    function ShortcutComponent() {
      useHistoryShortcuts(manager);
      return (
        <div>
          <input id="test-input" type="text" />
          <div id="test-editable" contentEditable="true">
            Editable text
          </div>
        </div>
      );
    }

    await act(async () => {
      root.render(<ShortcutComponent />);
    });

    expect(count).toBe(1);

    // 1. Trigger Mod+Z with body active -> Should undo
    const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const undoEvent = new KeyboardEvent("keydown", {
      key: "z",
      bubbles: true,
      cancelable: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    });

    window.dispatchEvent(undoEvent);
    expect(count).toBe(0);
    expect(manager.getState().canRedo).toBe(true);

    // 2. Trigger Mod+Shift+Z -> Should redo
    const redoEvent = new KeyboardEvent("keydown", {
      key: "z",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    });

    window.dispatchEvent(redoEvent);
    expect(count).toBe(1);

    // 3. Dispatch Mod+Z originating from an input element -> Guard should prevent undo!
    const input = document.getElementById("test-input") as HTMLInputElement;
    const inputUndoEvent = new KeyboardEvent("keydown", {
      key: "z",
      bubbles: true,
      cancelable: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    });
    input.dispatchEvent(inputUndoEvent);
    // Count should still be 1 because target was an input!
    expect(count).toBe(1);

    // 4. Dispatch Mod+Z originating from a contentEditable div -> Guard should prevent undo!
    const editable = document.getElementById("test-editable") as HTMLDivElement;
    const editableUndoEvent = new KeyboardEvent("keydown", {
      key: "z",
      bubbles: true,
      cancelable: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    });
    editable.dispatchEvent(editableUndoEvent);
    // Count should still be 1!
    expect(count).toBe(1);
  });
});
