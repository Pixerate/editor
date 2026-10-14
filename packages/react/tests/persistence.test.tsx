import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { HistoryManager, bindDirtyToHistory } from "@pixerate/editor";
import { createMemoryStorage, type MemoryStorage } from "@pixerate/editor/persistence";
import { RecoveryPrompt, useAutosave, type UseAutosaveResult } from "../src/persistence";

let container: HTMLDivElement;
let root: any;
let dom: JSDOM;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: "https://example.com/editor" });
  globalThis.document = dom.window.document as any;
  globalThis.window = dom.window as any;
  (globalThis as any).Node = dom.window.Node;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDoc() {
  const history = new HistoryManager();
  const doc = { text: "" };
  const binding = bindDirtyToHistory({ history, getValue: () => doc.text });
  const setText = (text: string) => {
    const prev = doc.text;
    history.execute({ name: "type", execute: () => void (doc.text = text), undo: () => void (doc.text = prev) });
  };
  return { history, doc, binding, setText };
}

function Harness(props: {
  storage: MemoryStorage;
  doc: ReturnType<typeof makeDoc>;
  onResult: (r: UseAutosaveResult<{ text: string }>) => void;
}) {
  const { doc } = props;
  const autosave = useAutosave({
    storage: props.storage,
    key: "doc",
    name: "Notes",
    getSnapshot: () => ({ text: doc.doc.text }),
    history: doc.history,
    dirty: doc.binding,
    debounceMs: 5,
    interval: 20,
  });
  props.onResult(autosave);
  return (
    <div>
      <span data-status>{autosave.status.status}</span>
      <RecoveryPrompt
        recovery={autosave.recovery}
        formatTime={() => "12:00"}
        onRestore={() => {
          const snapshot = autosave.restore();
          if (snapshot) doc.setText(snapshot.text);
        }}
        onDiscard={() => void autosave.discard()}
      />
    </div>
  );
}

describe("useAutosave and RecoveryPrompt", () => {
  it("snapshots edits after the debounce and retires them after a save", async () => {
    const storage = createMemoryStorage();
    const doc = makeDoc();
    let result!: UseAutosaveResult<{ text: string }>;
    await act(async () => {
      root.render(<Harness storage={storage} doc={doc} onResult={(r) => (result = r)} />);
    });
    expect(container.querySelector("[data-recovery-prompt]")).toBeNull();
    expect(result.pendingRecovery).toBe(false);

    await act(async () => {
      doc.setText("hello");
      await wait(40);
    });
    expect(storage.entries.get("doc")).toBe('{"text":"hello"}');
    expect(JSON.parse(storage.entries.get("doc:meta")!)).toMatchObject({ dirty: true, name: "Notes" });
    expect(container.querySelector("[data-status]")!.textContent).toBe("saved");

    await act(async () => {
      doc.binding.markClean();
      await result.markClean();
    });
    expect(JSON.parse(storage.entries.get("doc:meta")!)).toEqual({ dirty: false });
    expect(storage.entries.has("doc")).toBe(false);
  });

  it("offers an earlier session's snapshot and restores it", async () => {
    const storage = createMemoryStorage({
      initial: { doc: '{"text":"lost work"}', "doc:meta": '{"dirty":true,"time":5,"name":"Notes"}' },
    });
    const doc = makeDoc();
    let result!: UseAutosaveResult<{ text: string }>;
    await act(async () => {
      root.render(<Harness storage={storage} doc={doc} onResult={(r) => (result = r)} />);
    });
    await act(async () => wait(30));
    const prompt = container.querySelector("[data-recovery-prompt]")!;
    expect(prompt.textContent).toContain("Restore unsaved changes from 12:00?");
    expect(result.pendingRecovery).toBe(true);
    // Gated: nothing is written while the user decides.
    expect(result.controller!.isReady).toBe(false);

    await act(async () => {
      (container.querySelector("[data-recovery-restore]") as HTMLButtonElement).click();
    });
    expect(doc.doc.text).toBe("lost work");
    expect(container.querySelector("[data-recovery-prompt]")).toBeNull();
    expect(doc.binding.dirty).toBe(true);
    await act(async () => wait(40));
    expect(result.controller!.isReady).toBe(true);
    expect(JSON.parse(storage.entries.get("doc:meta")!)).toMatchObject({ dirty: true, revision: expect.any(Number) });
  });

  it("discards an earlier session's snapshot", async () => {
    const storage = createMemoryStorage({
      initial: { doc: '{"text":"old"}', "doc:meta": '{"dirty":true,"time":5}' },
    });
    const doc = makeDoc();
    await act(async () => {
      root.render(<Harness storage={storage} doc={doc} onResult={() => {}} />);
    });
    await act(async () => wait(10));
    await act(async () => {
      (container.querySelector("[data-recovery-discard]") as HTMLButtonElement).click();
      await wait(10);
    });
    expect(storage.entries.size).toBe(0);
    expect(container.querySelector("[data-recovery-prompt]")).toBeNull();
    expect(doc.doc.text).toBe("");
  });

  it("flushes pending changes on pagehide", async () => {
    const storage = createMemoryStorage();
    const doc = makeDoc();
    await act(async () => {
      root.render(<Harness storage={storage} doc={doc} onResult={() => {}} />);
    });
    await act(async () => {
      doc.setText("a");
      window.dispatchEvent(new dom.window.Event("pagehide"));
      await wait(0);
    });
    expect(storage.entries.get("doc")).toBe('{"text":"a"}');
  });
});
