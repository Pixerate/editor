import { describe, it, expect, vi } from "vitest";
import {
  HistoryManager,
  DirtyTracker,
  bindDirtyToHistory,
  withoutDirty,
} from "../src/history";
import * as root from "../src";

interface Doc {
  title: string;
  body: string;
  selection: { from: number; to: number };
  zoom: number;
}

const project = ({ selection, zoom, ...rest }: Doc) => rest;

function setup() {
  let doc: Doc = {
    title: "Untitled",
    body: "",
    selection: { from: 0, to: 0 },
    zoom: 1,
  };
  const history = new HistoryManager();
  const edit = (patch: Partial<Doc>, name = "Edit") => {
    const before = doc;
    const after = { ...doc, ...patch };
    history.execute({
      name,
      execute: () => {
        doc = after;
      },
      undo: () => {
        doc = before;
      },
    });
  };
  const binding = bindDirtyToHistory({
    history,
    getValue: () => doc,
    normalize: project,
  });
  return {
    history,
    edit,
    binding,
    get doc() {
      return doc;
    },
    set doc(next: Doc) {
      doc = next;
    },
  };
}

describe("dirty tracking bound to history", () => {
  it("is re-exported from the root entry", () => {
    expect(root.bindDirtyToHistory).toBe(bindDirtyToHistory);
    expect(root.DirtyTracker).toBe(DirtyTracker);
  });

  it("clears dirty after undoing back to the saved state", () => {
    const s = setup();
    expect(s.binding.dirty).toBe(false);
    s.edit({ title: "A" });
    expect(s.binding.dirty).toBe(true);
    s.history.undo();
    expect(s.binding.dirty).toBe(false);
    s.history.redo();
    expect(s.binding.dirty).toBe(true);

    s.binding.markClean(); // saved at "A"
    expect(s.binding.dirty).toBe(false);
    s.history.undo();
    expect(s.binding.dirty).toBe(true);
    s.history.redo();
    expect(s.binding.dirty).toBe(false);
  });

  it("keeps selection-only and zoom-only changes clean", () => {
    const s = setup();
    s.doc = { ...s.doc, selection: { from: 2, to: 5 }, zoom: 2 };
    expect(s.binding.refresh()).toBe(false);
    s.edit({ selection: { from: 1, to: 1 } }, "Select");
    expect(s.binding.dirty).toBe(false);
    s.edit({ body: "x" });
    expect(s.binding.dirty).toBe(true);
  });

  it("notifies subscribers only when the dirty flag flips", () => {
    const s = setup();
    const listener = vi.fn();
    s.binding.subscribe(listener);
    expect(listener).toHaveBeenLastCalledWith(false);
    listener.mockClear();
    s.edit({ title: "A" });
    s.edit({ title: "B" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);
    s.history.undo();
    s.history.undo();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it("does not mark programmatic loads dirty (suppression is re-entrant)", () => {
    const s = setup();
    s.binding.suppress(() => {
      s.edit({ title: "Loaded" });
      expect(s.binding.tracker.suppressed).toBe(true);
      s.binding.suppress(() => {
        s.edit({ body: "nested" });
      });
      // Still suppressed after the inner call returns.
      expect(s.binding.tracker.suppressed).toBe(true);
      s.edit({ body: "restored" });
    });
    expect(s.binding.tracker.suppressed).toBe(false);
    expect(s.binding.dirty).toBe(false);
    s.edit({ body: "typed" });
    expect(s.binding.dirty).toBe(true);
  });

  it("rebaselines after a load that bypasses the history", () => {
    const s = setup();
    s.binding.suppress(() => {
      s.doc = { ...s.doc, title: "From disk" };
    });
    s.history.clear();
    expect(s.binding.dirty).toBe(false);
  });

  it("keeps suppression until an async load settles", async () => {
    const s = setup();
    let finish!: () => void;
    const done = s.binding.suppress(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(s.binding.tracker.suppressed).toBe(true);
    s.edit({ title: "Streaming" });
    finish();
    await done;
    expect(s.binding.tracker.suppressed).toBe(false);
    expect(s.binding.dirty).toBe(false);
  });

  it("releases suppression when the callback throws", () => {
    const tracker = new DirtyTracker(1);
    expect(() =>
      withoutDirty(tracker, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(tracker.suppressed).toBe(false);
    expect(tracker.update(2)).toBe(true);
  });

  it("stops following the history after destroy", () => {
    const s = setup();
    s.binding.destroy();
    s.edit({ title: "A" });
    expect(s.binding.dirty).toBe(false);
  });
});

describe("DirtyTracker revision cache and normalize", () => {
  it("reuses the result for the same revision until the baseline changes", () => {
    const isEqual = vi.fn((a: number, b: number) => a === b);
    const tracker = new DirtyTracker(1, { isEqual });
    expect(tracker.isDirty(2, 7)).toBe(true);
    expect(tracker.isDirty(2, 7)).toBe(true);
    expect(isEqual).toHaveBeenCalledTimes(1);
    tracker.setBaseline(2);
    expect(tracker.isDirty(2, 7)).toBe(false);
    expect(isEqual).toHaveBeenCalledTimes(2);
    expect(tracker.isDirty(3)).toBe(true); // no revision: always compares
    expect(isEqual).toHaveBeenCalledTimes(3);
  });

  it("compares normalized values and normalizes the baseline once", () => {
    const normalize = vi.fn((v: { a: number; sel: number }) => v.a);
    const tracker = new DirtyTracker({ a: 1, sel: 0 }, { normalize });
    expect(tracker.isDirty({ a: 1, sel: 9 })).toBe(false);
    expect(tracker.isDirty({ a: 2, sel: 0 })).toBe(true);
    // baseline once + one per compared value
    expect(normalize).toHaveBeenCalledTimes(3);
  });

  it("keeps the stateless API unchanged", () => {
    const tracker = new DirtyTracker({ x: 1 });
    expect(tracker.isDirty({ x: 1 })).toBe(false);
    expect(tracker.isDirty({ x: 2 })).toBe(true);
    tracker.reset({ x: 2 });
    expect(tracker.getBaseline()).toEqual({ x: 2 });
    expect(tracker.isDirty({ x: 2 })).toBe(false);
    expect(tracker.dirty).toBe(false);
  });

  it("markClean without an argument uses the last updated value", () => {
    const tracker = new DirtyTracker("a");
    tracker.update("b");
    expect(tracker.dirty).toBe(true);
    tracker.markClean();
    expect(tracker.dirty).toBe(false);
    expect(tracker.getBaseline()).toBe("b");
  });
});
