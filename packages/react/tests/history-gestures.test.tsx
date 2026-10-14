import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  useHistory,
  useHistoryDirty,
  useNavigationGuard,
  HistoryManager,
  type Command,
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
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Event = dom.window.Event;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function counter() {
  const doc = { value: 0, selection: 0 };
  const set = (value: number, name = "Set"): Command => {
    const before = doc.value;
    return {
      name,
      tag: "value",
      execute: () => {
        doc.value = value;
      },
      undo: () => {
        doc.value = before;
      },
    };
  };
  return { doc, set };
}

describe("useHistory gestures, marks and entries", () => {
  it("exposes entries, goTo, gestures and marks reactively", async () => {
    const c = counter();
    let h: ReturnType<typeof useHistory> | null = null;
    let renders = 0;

    function Panel() {
      h = useHistory();
      renders++;
      return (
        <ul>
          {h.entries.map((e) => (
            <li key={e.id} data-current={e.current} data-undone={e.undone}>
              {e.label}
            </li>
          ))}
        </ul>
      );
    }

    await act(async () => root.render(<Panel />));
    expect(container.querySelectorAll("li")).toHaveLength(0);

    await act(async () => {
      h!.beginGesture("drag");
      h!.executeMerged(c.set(1, "Drag"), { key: "x" });
      h!.executeMerged(c.set(2, "Drag"), { key: "y" });
      h!.endGesture();
      h!.execute(c.set(10, "Type"));
    });
    expect(h!.undoCount).toBe(2);
    expect([...container.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Drag",
      "Type",
    ]);

    await act(async () => {
      h!.goTo(-1);
    });
    expect(c.doc.value).toBe(0);
    expect(h!.entries.every((e) => e.undone)).toBe(true);
    expect(container.querySelector("li")!.getAttribute("data-undone")).toBe("true");

    await act(async () => {
      h!.goTo(0);
    });
    expect(c.doc.value).toBe(2);

    const mark = h!.mark();
    await act(async () => {
      h!.executeMerged(c.set(3), { key: "drag" });
      h!.executeMerged(c.set(4), { key: "drag" });
    });
    expect(c.doc.value).toBe(4);
    let reverted = 0;
    await act(async () => {
      reverted = h!.revertTo(mark);
    });
    expect(reverted).toBe(1);
    expect(c.doc.value).toBe(2);
    expect(h!.canRedo).toBe(false);
    expect(renders).toBeGreaterThan(1);
  });
});

describe("useHistoryDirty", () => {
  it("clears dirty when undoing to the saved state and stops the navigation guard", async () => {
    const c = counter();
    const history = new HistoryManager();
    let d: ReturnType<typeof useHistoryDirty<{ value: number; selection: number }>> | null =
      null;

    function Editor() {
      d = useHistoryDirty({
        history,
        getValue: () => ({ ...c.doc }),
        normalize: ({ value }) => value,
      });
      useNavigationGuard({ isDirty: d.isDirty });
      return <span data-testid="dirty">{String(d.isDirty)}</span>;
    }

    const beforeUnloadPrevented = () => {
      const event = new window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    await act(async () => root.render(<Editor />));
    expect(d!.isDirty).toBe(false);
    expect(beforeUnloadPrevented()).toBe(false);

    await act(async () => {
      history.execute(c.set(5));
    });
    expect(d!.isDirty).toBe(true);
    expect(container.textContent).toBe("true");
    expect(beforeUnloadPrevented()).toBe(true);

    await act(async () => {
      history.undo();
    });
    expect(d!.isDirty).toBe(false);
    expect(beforeUnloadPrevented()).toBe(false);

    // Selection-only change stays clean.
    await act(async () => {
      c.doc.selection = 3;
      d!.refresh();
    });
    expect(d!.isDirty).toBe(false);

    // A programmatic load does not mark dirty; a save marks clean.
    await act(async () => {
      d!.suppress(() => history.execute(c.set(7, "Load")));
    });
    expect(d!.isDirty).toBe(false);
    await act(async () => {
      history.execute(c.set(8));
    });
    expect(d!.isDirty).toBe(true);
    await act(async () => {
      d!.markClean();
    });
    expect(d!.isDirty).toBe(false);
    await act(async () => {
      history.undo();
    });
    expect(d!.isDirty).toBe(true);
  });
});
