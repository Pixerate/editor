import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM } from "jsdom";
import { createHistory, createHistoryDirty } from "../src/history";
import { createNavigationGuard } from "../src";
import type { Command } from "@pixerate/editor/history";

beforeAll(() => {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    { url: "https://example.com/editor" },
  );
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Event = dom.window.Event;
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

describe("Svelte createHistory gestures, marks and entries", () => {
  it("exposes entries, goTo, gestures and marks", () => {
    const c = counter();
    const h = createHistory();

    h.beginGesture("drag");
    h.executeMerged(c.set(1, "Drag"), { key: "x" });
    h.executeMerged(c.set(2, "Drag"), { key: "y" });
    h.endGesture();
    h.execute(c.set(10, "Type"));
    expect(h.undoCount).toBe(2);
    expect(h.entries.map((e) => [e.label, e.current])).toEqual([
      ["Drag", false],
      ["Type", true],
    ]);

    expect(h.goTo(-1)).toBe(2);
    expect(c.doc.value).toBe(0);
    expect(h.entries.every((e) => e.undone)).toBe(true);
    h.goTo(0);
    expect(c.doc.value).toBe(2);

    const mark = h.mark();
    h.executeMerged(c.set(3), { key: "drag" });
    h.executeMerged(c.set(4), { key: "drag" });
    expect(h.undoCount).toBe(2);
    expect(h.revertTo(mark)).toBe(1);
    expect(c.doc.value).toBe(2);
    expect(h.canRedo).toBe(false);
  });
});

describe("Svelte createHistoryDirty", () => {
  it("clears dirty after undo-to-saved and stops the navigation guard", () => {
    const c = counter();
    const h = createHistory();
    const dirty = createHistoryDirty({
      history: h.manager,
      getValue: () => ({ ...c.doc }),
      normalize: ({ value }) => value,
    });
    const guard = createNavigationGuard({ isDirty: () => dirty.isDirty });
    const prevented = () => {
      const event = new window.Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(dirty.isDirty).toBe(false);
    h.execute(c.set(5));
    expect(dirty.isDirty).toBe(true);
    expect(prevented()).toBe(true);
    expect(guard.intercept("/elsewhere")).toBe(true);
    guard.cancelLeave();

    h.undo();
    expect(dirty.isDirty).toBe(false);
    expect(prevented()).toBe(false);
    expect(guard.intercept("/elsewhere")).toBe(false);

    c.doc.selection = 4;
    expect(dirty.refresh()).toBe(false);

    dirty.suppress(() => {
      dirty.suppress(() => h.execute(c.set(7, "Load")));
      h.execute(c.set(8, "Load more"));
    });
    expect(dirty.isDirty).toBe(false);

    h.execute(c.set(9));
    expect(dirty.isDirty).toBe(true);
    dirty.markClean();
    expect(dirty.isDirty).toBe(false);

    dirty.destroy();
    guard.destroy();
  });
});
