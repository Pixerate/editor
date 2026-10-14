import { describe, it, expect, vi, afterEach } from "vitest";
import { HistoryManager, type Command } from "../src/history";
import { SpreadsheetController } from "../src/spreadsheet";

/** A tiny mixer document: absolute "set" commands, like a fader or knob. */
function mixer() {
  const doc = { volume: 0, pan: 0, mute: false };
  const set = <K extends keyof typeof doc>(
    key: K,
    value: (typeof doc)[K],
    name = `Set ${key}`,
  ): Command => {
    const before = doc[key];
    return {
      name,
      tag: key,
      execute: () => {
        doc[key] = value;
      },
      undo: () => {
        doc[key] = before;
      },
    };
  };
  return { doc, set };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HistoryManager gesture merge keys", () => {
  it("makes dragging a parameter one undo step, however slow", () => {
    vi.useFakeTimers();
    const h = new HistoryManager();
    const m = mixer();
    for (const db of [-1, -2, -3, -4]) {
      h.executeMerged(m.set("volume", db), { key: "fader" });
      vi.advanceTimersByTime(1000); // far beyond the 300 ms time window
    }
    h.endGesture();
    expect(h.getState().undoCount).toBe(1);
    expect(m.doc.volume).toBe(-4);
    h.undo();
    expect(m.doc.volume).toBe(0);
    h.redo();
    expect(m.doc.volume).toBe(-4);
  });

  it("folds several parameters under one key into one step", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.executeMerged(m.set("volume", -1), { key: "strip" });
    h.executeMerged(m.set("pan", 0.5), { key: "strip" });
    h.executeMerged(m.set("volume", -2), { key: "strip" });
    expect(h.getState().undoCount).toBe(1);
    h.undo();
    expect(m.doc).toEqual({ volume: 0, pan: 0, mute: false });
    h.redo();
    expect(m.doc).toEqual({ volume: -2, pan: 0.5, mute: false });
  });

  it("only a recorded change ends a gesture", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.executeMerged(m.set("volume", -1), { key: "fader" });
    // Non-recording work between gesture frames: reads, marks, empty batches,
    // commands replayed while history is applying.
    h.getEntries();
    h.mark();
    h.batch("nothing", () => {});
    h.executeMerged(m.set("volume", -2), { key: "fader" });
    expect(h.getState().undoCount).toBe(1);

    h.execute(m.set("mute", true));
    h.executeMerged(m.set("volume", -3), { key: "fader" });
    expect(h.getState().undoCount).toBe(3);
  });

  it("undo and redo end a gesture", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.execute(m.set("mute", true));
    h.executeMerged(m.set("volume", -1), { key: "fader" });
    h.undo();
    h.redo();
    h.executeMerged(m.set("volume", -2), { key: "fader" });
    expect(h.getState().undoCount).toBe(3);
  });

  it("a different key starts a new step", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.executeMerged(m.set("volume", -1), { key: "fader" });
    h.executeMerged(m.set("pan", 1), { key: "pan" });
    expect(h.getState().undoCount).toBe(2);
  });

  it("a held gesture joins every merged execute into one step", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.beginGesture("pass");
    expect(h.getGestureKey()).toBe("pass");
    for (const db of [-1, -2, -3]) {
      h.executeMerged(m.set("volume", db), { key: "fader" });
      h.executeMerged(m.set("pan", db / 4), { key: "pan" });
      h.executeMerged(m.set("volume", db - 0.5)); // no key: still joins
    }
    expect(h.getState().undoCount).toBe(1);
    h.endGesture();
    expect(h.getGestureKey()).toBeNull();
    h.executeMerged(m.set("volume", -6), { key: "fader" });
    expect(h.getState().undoCount).toBe(2);
    h.undo();
    h.undo();
    expect(m.doc).toEqual({ volume: 0, pan: 0, mute: false });
  });

  it("keeps the time-window behaviour for tag-only merges", () => {
    vi.useFakeTimers();
    const h = new HistoryManager();
    const m = mixer();
    h.executeMerged(m.set("volume", -1));
    vi.advanceTimersByTime(100);
    h.executeMerged(m.set("volume", -2));
    expect(h.getState().undoCount).toBe(1);
    vi.advanceTimersByTime(1000);
    h.executeMerged(m.set("volume", -3));
    expect(h.getState().undoCount).toBe(2);
  });

  it("merged executes inside a batch are recorded by the batch", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.batch("Both", () => {
      h.executeMerged(m.set("volume", -1), { key: "fader" });
      h.executeMerged(m.set("volume", -2), { key: "fader" });
    });
    expect(h.getState().undoCount).toBe(1);
    h.undo();
    expect(m.doc.volume).toBe(0);
  });
});

describe("HistoryManager undo marks", () => {
  it("reverts every step after the mark without leaving redo", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.execute(m.set("mute", true));
    const mark = h.mark();
    h.executeMerged(m.set("volume", -1), { key: "fader" });
    h.executeMerged(m.set("volume", -2), { key: "fader" });
    h.execute(m.set("pan", 1));
    expect(h.revertTo(mark)).toBe(2);
    expect(m.doc).toEqual({ volume: 0, pan: 0, mute: true });
    expect(h.getState().undoCount).toBe(1);
    expect(h.getState().canRedo).toBe(false);
    expect(h.getGestureKey()).toBeNull();
  });

  it("drops undone steps made after the mark from redo", () => {
    const h = new HistoryManager();
    const m = mixer();
    const mark = h.mark();
    h.execute(m.set("volume", -1));
    h.execute(m.set("volume", -2));
    h.undo();
    expect(h.revertTo(mark)).toBe(1);
    expect(m.doc.volume).toBe(0);
    expect(h.getState()).toMatchObject({ undoCount: 0, redoCount: 0 });
  });

  it("returns 0 for a mark with nothing after it", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.execute(m.set("volume", -1));
    const listener = vi.fn();
    h.subscribe(listener);
    listener.mockClear();
    expect(h.revertTo(h.mark())).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(m.doc.volume).toBe(-1);
  });

  it("does nothing for a mark that has left the history", () => {
    const h = new HistoryManager({ maxDepth: 2 });
    const m = mixer();
    h.execute(m.set("volume", -1));
    const lost = h.mark();
    h.undo(); // the marked step is now on the redo stack
    expect(h.isMarkValid(lost)).toBe(false);
    expect(h.revertTo(lost)).toBe(0);

    h.redo();
    const dropped = h.mark();
    h.execute(m.set("volume", -2));
    h.execute(m.set("volume", -3)); // pushes the marked step out (maxDepth 2)
    expect(h.revertTo(dropped)).toBe(0);
    expect(m.doc.volume).toBe(-3);

    const empty = new HistoryManager({ maxDepth: 1 });
    const start = empty.mark();
    empty.execute(m.set("pan", 1));
    empty.execute(m.set("pan", 2)); // the first step (just after the start) was dropped
    expect(empty.revertTo(start)).toBe(0);

    const cleared = new HistoryManager();
    cleared.execute(m.set("mute", true));
    const beforeClear = cleared.mark();
    cleared.clear();
    expect(cleared.revertTo(beforeClear)).toBe(0);
  });

  it("reverts to an empty-history mark", () => {
    const h = new HistoryManager();
    const m = mixer();
    const start = h.mark();
    h.execute(m.set("volume", -1));
    h.execute(m.set("pan", 1));
    expect(h.revertTo(start)).toBe(2);
    expect(m.doc).toEqual({ volume: 0, pan: 0, mute: false });
    expect(h.getState().canUndo).toBe(false);
  });
});

describe("HistoryManager memory budget and entries", () => {
  it("drops the oldest steps beyond maxBytes but keeps one", () => {
    const h = new HistoryManager({ maxBytes: 300 });
    const m = mixer();
    for (let i = 0; i < 6; i++) {
      h.execute({ ...m.set("volume", -i, `paint ${i}`), byteSize: 100 });
    }
    expect(h.getState().undoCount).toBe(3);
    expect(h.getByteSize()).toBe(300);
    expect(h.getEntries()[0].label).toBe("paint 3");

    const tiny = new HistoryManager({ maxBytes: 1 });
    tiny.execute({ ...m.set("pan", 1), byteSize: 1000 });
    tiny.execute({ ...m.set("pan", 2), byteSize: 1000 });
    expect(tiny.getState().undoCount).toBe(1);
    expect(tiny.undo()).toBe(true);
    expect(m.doc.pan).toBe(1);
  });

  it("uses the sizeOf hook and counts redo steps", () => {
    const sizeOf = vi.fn((c: Command) => (c.name === "big" ? 500 : 10));
    const h = new HistoryManager({ maxBytes: 520, sizeOf });
    const m = mixer();
    h.execute({ ...m.set("volume", -1), name: "small" });
    h.execute({ ...m.set("volume", -2), name: "big" });
    expect(h.getByteSize()).toBe(510);
    h.undo(); // big moves to redo, still counted
    h.execute({ ...m.set("pan", 1), name: "small" }); // clears redo
    expect(h.getByteSize()).toBe(20);
    expect(sizeOf).toHaveBeenCalled();
  });

  it("re-measures a gesture step as it grows", () => {
    const h = new HistoryManager({ maxBytes: 250 });
    const m = mixer();
    h.execute({ ...m.set("mute", true), byteSize: 100 });
    h.executeMerged({ ...m.set("volume", -1), byteSize: 100 }, { key: "g" });
    h.executeMerged({ ...m.set("pan", 1), byteSize: 100 }, { key: "g" });
    // The gesture step is now 200 bytes; the older step no longer fits.
    expect(h.getState().undoCount).toBe(1);
    expect(h.getByteSize()).toBe(200);
  });

  it("lists entries and jumps with goTo", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.execute(m.set("volume", -1, "A"));
    h.execute(m.set("volume", -2, "B"));
    h.execute(m.set("volume", -3, "C"));
    h.undo();
    const entries = h.getEntries();
    expect(entries.map((e) => [e.label, e.index, e.current, e.undone])).toEqual([
      ["A", 0, false, false],
      ["B", 1, true, false],
      ["C", 2, false, true],
    ]);
    expect(h.getEntries()).toBe(entries); // cached until a change
    expect(new Set(entries.map((e) => e.id)).size).toBe(3);

    expect(h.goTo(0)).toBe(1);
    expect(m.doc.volume).toBe(-1);
    expect(h.goTo(2)).toBe(2);
    expect(m.doc.volume).toBe(-3);
    expect(h.goTo(-1)).toBe(3);
    expect(m.doc.volume).toBe(0);
    expect(h.getEntries().every((e) => e.undone)).toBe(true);
    expect(h.goTo(-1)).toBe(0);
    expect(h.goTo(99)).toBe(3);
    expect(m.doc.volume).toBe(-3);
  });

  it("keeps the entry id stable while a gesture merges into it", () => {
    const h = new HistoryManager();
    const m = mixer();
    h.executeMerged(m.set("volume", -1), { key: "g" });
    const id = h.getEntries()[0].id;
    h.executeMerged(m.set("volume", -2), { key: "g" });
    expect(h.getEntries()[0].id).toBe(id);
  });

  it("bumps the revision on every change", () => {
    const h = new HistoryManager();
    const m = mixer();
    const r0 = h.getRevision();
    h.execute(m.set("volume", -1));
    const r1 = h.getRevision();
    h.undo();
    expect(r1).toBeGreaterThan(r0);
    expect(h.getRevision()).toBeGreaterThan(r1);
  });
});

describe("SpreadsheetController history byte cap", () => {
  it("drops the oldest snapshots beyond maxHistoryBytes", () => {
    const sheet = new SpreadsheetController({ maxHistoryBytes: 1 });
    const rows = sheet.document.rows;
    const cols = sheet.document.columns;
    sheet.setCellValue(rows[0].id, cols[0].id, "1");
    sheet.setCellValue(rows[1].id, cols[0].id, "2");
    sheet.setCellValue(rows[2].id, cols[0].id, "3");
    expect(sheet.getHistoryDepth().undo).toBe(1);
    sheet.undo();
    expect(sheet.getCell(rows[2].id, cols[0].id).raw).toBe("");
    expect(sheet.getCell(rows[1].id, cols[0].id).raw).toBe("2");
  });

  it("keeps the default 50-step cap for small documents", () => {
    const sheet = new SpreadsheetController();
    const rows = sheet.document.rows;
    const col = sheet.document.columns[0].id;
    for (let i = 0; i < 60; i++) sheet.setCellValue(rows[i % 10].id, col, String(i));
    expect(sheet.getHistoryDepth().undo).toBe(50);
    expect(sheet.getHistoryByteSize()).toBeGreaterThan(0);
  });
});
