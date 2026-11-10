import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { defineEditorDocument, type EditorDocument } from "@pixerate/editor/persistence";
import { HistoryManager } from "@pixerate/editor/history";
import { useEditorSync, type UseEditorSyncResult } from "../src/persistence";

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "https://example.com/editor" });
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

function listDoc() {
  const history = new HistoryManager();
  let items: string[] = ["a"];
  const listeners = new Set<() => void>();
  const set = (next: string[]) => {
    items = next;
    listeners.forEach((l) => l());
  };
  const doc = defineEditorDocument<{ items: string[] }>({
    kind: "list",
    get: () => ({ items: [...items] }),
    load: (document) => set([...(document as any).items]),
    history,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const edit = (next: string[]) => {
    const before = items;
    history.execute({ name: "Edit", execute: () => set(next), undo: () => set(before) });
  };
  return { doc, edit };
}

type Saved = { items: string[]; version: number };

function Harness(props: { doc: EditorDocument<{ items: string[] }>; saved: Saved[]; onResult: (r: UseEditorSyncResult<{ items: string[] }>) => void }) {
  const sync = useEditorSync(props.doc, {
    initialVersion: 4,
    debounceMs: 5,
    save: async ({ document, version }) => {
      props.saved.push({ items: document.items, version });
      return { version };
    },
  });
  props.onResult(sync);
  return <span data-status>{sync.status.status}</span>;
}

describe("useEditorSync", () => {
  it("saves edits with the next version, re-renders on status, and survives StrictMode remounts", async () => {
    const { doc, edit } = listDoc();
    const saved: Saved[] = [];
    let result!: UseEditorSyncResult<{ items: string[] }>;
    await act(async () => {
      root.render(
        <StrictMode>
          <Harness doc={doc} saved={saved} onResult={(r) => (result = r)} />
        </StrictMode>,
      );
    });
    expect(result.controller).not.toBeNull();

    await act(async () => {
      edit(["a", "b"]);
    });
    expect(result.dirty).toBe(true);
    await act(async () => {
      await result.flush();
    });
    expect(saved).toEqual([{ items: ["a", "b"], version: 5 }]);
    expect(result.dirty).toBe(false);
    expect(result.savedVersion).toBe(5);
    expect(container.querySelector("[data-status]")?.textContent).toBe("saved");

    // A remote change is applied without being saved back.
    await act(async () => {
      result.applyRemote(() => doc.loadDocument({ items: ["remote"] }, { history: "reset" }), 9);
    });
    expect(result.version).toBe(9);
    expect(result.dirty).toBe(false);
    expect(saved).toHaveLength(1);
  });

  it("flushes pending edits on unmount", async () => {
    const { doc, edit } = listDoc();
    const saved: Saved[] = [];
    await act(async () => {
      root.render(<Harness doc={doc} saved={saved} onResult={() => {}} />);
    });
    edit(["a", "z"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {});
    expect(saved).toEqual([{ items: ["a", "z"], version: 5 }]);
  });
});
