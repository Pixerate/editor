import { describe, it, expect, afterEach } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { HistoryManager, bindDirtyToHistory } from "@pixerate/editor/history";
import { createMemoryStorage } from "@pixerate/editor/persistence";
import { RecoveryPrompt, createAutosave } from "../src/persistence";

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((fn) => fn());
  cleanup = [];
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDoc() {
  const history = new HistoryManager();
  const doc = { text: "" };
  const binding = bindDirtyToHistory({ history, getValue: () => doc.text });
  const setText = (text: string) => {
    const prev = doc.text;
    history.execute({ name: "type", execute: () => void (doc.text = text), undo: () => void (doc.text = prev) });
  };
  cleanup.push(() => binding.destroy());
  return { history, doc, binding, setText };
}

function autosaveFor(storage: ReturnType<typeof createMemoryStorage>, d: ReturnType<typeof makeDoc>, extra = {}) {
  const autosave = createAutosave({
    storage,
    key: "doc",
    name: "Notes",
    getSnapshot: () => ({ text: d.doc.text }),
    history: d.history,
    dirty: d.binding,
    debounceMs: 5,
    interval: 20,
    ...extra,
  });
  cleanup.push(() => autosave.destroy());
  return autosave;
}

describe("createAutosave", () => {
  it("snapshots edits and retires them after a save", async () => {
    const storage = createMemoryStorage();
    const d = makeDoc();
    const autosave = autosaveFor(storage, d);
    await autosave.checked;
    expect(autosave.pendingRecovery).toBe(false);
    expect(autosave.controller.isReady).toBe(true);

    d.setText("hello");
    await wait(40);
    expect(storage.entries.get("doc")).toBe('{"text":"hello"}');
    expect(autosave.status.status).toBe("saved");

    d.binding.markClean();
    await autosave.markClean();
    expect(JSON.parse(storage.entries.get("doc:meta")!)).toEqual({ dirty: false });
  });

  it("waits for ready() when the document loads later", async () => {
    const storage = createMemoryStorage();
    const d = makeDoc();
    const autosave = autosaveFor(storage, d, { ready: false });
    await autosave.checked;
    d.setText("a");
    await wait(40);
    expect(storage.entries.size).toBe(0);
    expect(autosave.status.status).toBe("dirty");
    autosave.ready();
    await wait(40);
    expect(storage.entries.get("doc")).toBe('{"text":"a"}');
  });

  it("offers, restores and discards an earlier session's snapshot", async () => {
    const initial = { doc: '{"text":"lost"}', "doc:meta": '{"dirty":true,"time":5}' };
    const d = makeDoc();
    const autosave = autosaveFor(createMemoryStorage({ initial }), d);
    await autosave.checked;
    expect(autosave.recovery?.snapshot).toEqual({ text: "lost" });
    expect(autosave.controller.isReady).toBe(false);
    d.setText(autosave.restore()!.text);
    expect(autosave.recovery).toBeNull();
    await wait(40);
    expect(autosave.controller.isReady).toBe(true);
    expect(autosave.status.status).toBe("saved");

    const storage2 = createMemoryStorage({ initial });
    const other = autosaveFor(storage2, makeDoc());
    await other.checked;
    await other.discard();
    expect(storage2.entries.size).toBe(0);
    expect(other.controller.isReady).toBe(true);
  });

  it("flushes on pagehide", async () => {
    const storage = createMemoryStorage();
    const d = makeDoc();
    const autosave = autosaveFor(storage, d);
    await autosave.checked;
    d.setText("x");
    window.dispatchEvent(new Event("pagehide"));
    await wait(0);
    expect(storage.entries.get("doc")).toBe('{"text":"x"}');
  });
});

describe("RecoveryPrompt", () => {
  it("renders the message and calls back", () => {
    const calls: string[] = [];
    const target = document.createElement("div");
    document.body.appendChild(target);
    const component = mount(RecoveryPrompt, {
      target,
      props: {
        recovery: { meta: { dirty: true, time: 0, name: "Notes" } },
        formatTime: () => "noon",
        onRestore: () => calls.push("restore"),
        onDiscard: () => calls.push("discard"),
      },
    });
    cleanup.push(() => {
      unmount(component);
      target.remove();
    });
    flushSync();
    expect(target.textContent).toContain("Restore unsaved changes from noon?");
    expect(target.textContent).toContain("(Notes)");
    (target.querySelector("[data-recovery-restore]") as HTMLButtonElement).click();
    (target.querySelector("[data-recovery-discard]") as HTMLButtonElement).click();
    expect(calls).toEqual(["restore", "discard"]);
  });

  it("renders nothing without a recovery", () => {
    const target = document.createElement("div");
    const component = mount(RecoveryPrompt, {
      target,
      props: { recovery: null, onRestore: () => {}, onDiscard: () => {} },
    });
    cleanup.push(() => unmount(component));
    flushSync();
    expect(target.querySelector("[data-recovery-prompt]")).toBeNull();
  });
});
