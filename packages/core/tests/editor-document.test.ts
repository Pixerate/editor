import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_DOCUMENT_FORMAT,
  EditorDocumentLoadError,
  createDocumentToolProvider,
  createEditorAutosave,
  createEditorDocumentStore,
  createEditorRemoteSync,
  EditorRemoteConflictError,
  createMemoryStorage,
  defineEditorDocument,
  parseEditorDocument,
  serializeEditorDocument,
  slugifyDocumentName,
  toEditorDocumentFile,
  type EditorDocument,
} from "../src/persistence";
import { HistoryManager } from "../src/history";
import { createHistoryCommands } from "../src/commands";
import { ToolRegistry } from "../src/tools";
import { DiagramController, createDiagramEditorDocument } from "../src/diagram";

/** A tiny editor: a list of strings with snapshot undo. */
function setup(options: { readOnly?: () => string | false; formatVersion?: number; migrations?: Record<number, (d: unknown) => unknown> } = {}) {
  const history = new HistoryManager();
  let items: string[] = ["a"];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const set = (next: string[]) => {
    items = next;
    emit();
  };
  const edit = (next: string[], name = "Edit") => {
    const before = items;
    history.execute({ name, execute: () => set(next), undo: () => set(before) });
  };
  const doc = defineEditorDocument<{ items: string[] }>({
    kind: "list",
    formatVersion: options.formatVersion,
    migrations: options.migrations,
    get: () => ({ items: [...items] }),
    load: (document, { history: mode }) => {
      const next = (document as any).items;
      if (!Array.isArray(next) || !next.every((x) => typeof x === "string")) throw new Error("A list document is { items: string[] }.");
      if (mode === "reset") {
        history.clear();
        set([...next]);
      } else edit([...next], "Load list");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    history: { undo: () => history.undo(), redo: () => history.redo(), getState: () => history.getState() },
    readOnly: options.readOnly,
  });
  return { doc, history, edit, items: () => items };
}

function registryFor(doc: EditorDocument, options: Parameters<typeof createDocumentToolProvider>[1] = {}) {
  const registry = new ToolRegistry();
  registry.register(createDocumentToolProvider(doc, { namespace: "", ...options }));
  return registry;
}

const text = (result: any) => result.content?.[0]?.text as string;

describe("defineEditorDocument", () => {
  it("counts a revision per document change and round-trips its own snapshot", () => {
    const { doc, edit, history } = setup();
    expect(doc.revision()).toBe(0);
    edit(["a", "b"]);
    expect(doc.revision()).toBe(1);
    history.undo();
    expect(doc.revision()).toBe(2);
    const before = doc.getDocument();
    doc.loadDocument(doc.getDocument());
    expect(doc.getDocument()).toEqual(before);
  });

  it("reconnects after destroy, counting the gap as a change", () => {
    const { doc, edit } = setup();
    const seen: number[] = [];
    doc.subscribe(() => seen.push(doc.revision()));
    doc.destroy();
    edit(["b"]);
    expect(seen).toEqual([]);
    expect(doc.revision()).toBe(1);
    edit(["c"]);
    expect(seen).toEqual([2]);
  });

  it("rejects bad kinds", () => {
    expect(() => defineEditorDocument({ kind: "Bad Kind" } as any)).toThrow(/must match/);
  });

  it("refuses an invalid document without changing anything", () => {
    const { doc, items } = setup();
    expect(() => doc.loadDocument({ items: [1] })).toThrow(EditorDocumentLoadError);
    expect(() => doc.loadDocument(null)).toThrow(/No list document/);
    expect(items()).toEqual(["a"]);
  });

  it("opens files, refusing other editors' files and newer versions", () => {
    const { doc, items } = setup();
    doc.loadDocument({ format: EDITOR_DOCUMENT_FORMAT, kind: "list", formatVersion: 1, document: { items: ["x"] } });
    expect(items()).toEqual(["x"]);
    expect(() => doc.loadDocument({ format: EDITOR_DOCUMENT_FORMAT, kind: "chart", formatVersion: 1, document: {} })).toThrow(
      "This is a chart document; it cannot be opened in the list editor.",
    );
    const newer = (() => {
      try {
        doc.loadDocument({ format: EDITOR_DOCUMENT_FORMAT, kind: "list", formatVersion: 3, document: { items: [] } });
      } catch (error) {
        return error as EditorDocumentLoadError;
      }
    })();
    expect(newer?.message).toMatch(/newer than the supported 1/);
    expect(newer?.report?.readOnly?.kind).toBe("newerVersion");
    expect(items()).toEqual(["x"]);
  });

  it("migrates older files step by step", () => {
    const { doc, items } = setup({ formatVersion: 2, migrations: { 1: (d: any) => ({ items: d.names }) } });
    const report = doc.loadDocument({ format: EDITOR_DOCUMENT_FORMAT, kind: "list", formatVersion: 1, document: { names: ["old"] } });
    expect(items()).toEqual(["old"]);
    expect(report.migratedFrom).toBe(1);
  });

  it("works with createHistoryCommands", () => {
    const { doc, edit, items } = setup();
    edit(["a", "b"]);
    const [undo] = createHistoryCommands(doc.history);
    undo.run!({} as any);
    expect(items()).toEqual(["a"]);
  });
});

describe("serializeEditorDocument / parseEditorDocument", () => {
  it("round-trips and says what is wrong with bad files", () => {
    const { doc } = setup();
    const file = parseEditorDocument(serializeEditorDocument(doc, { name: "Groceries" }), { kind: "list" });
    expect(file).toEqual({ format: EDITOR_DOCUMENT_FORMAT, kind: "list", formatVersion: 1, name: "Groceries", document: { items: ["a"] } });
    expect(() => parseEditorDocument("{")).toThrow(/not valid JSON/);
    expect(() => parseEditorDocument('{"items":[]}')).toThrow(/not a saved editor document/);
    expect(() => parseEditorDocument(serializeEditorDocument(doc), { kind: "chart" })).toThrow("The file is a list document, not a chart document.");
  });

  it("strips prototype keys", () => {
    const file = parseEditorDocument(`{"format":"${EDITOR_DOCUMENT_FORMAT}","kind":"list","formatVersion":1,"document":{"__proto__":{"x":1},"items":[]}}`);
    expect(Object.keys(file.document as object)).toEqual(["items"]);
  });
});

describe("createEditorDocumentStore", () => {
  it("saves, lists newest first, opens and removes", async () => {
    let t = Date.parse("2026-10-23T10:00:00Z");
    const store = createEditorDocumentStore({ storage: createMemoryStorage(), now: () => (t += 1000) });
    const { doc, edit, items } = setup();
    const first = await store.save(doc, "Groceries list");
    expect(first).toMatchObject({ key: "list/groceries-list", kind: "list", name: "Groceries list", formatVersion: 1 });
    edit(["b"]);
    await store.save(doc, "Work");
    edit(["c"]);
    await store.save(doc, "Groceries list");
    expect((await store.list("list")).map((d) => d.name)).toEqual(["Groceries list", "Work"]);
    expect(await store.list("chart")).toEqual([]);
    const opened = await store.open(doc, "list/work");
    expect(items()).toEqual(["b"]);
    expect(opened.report.readOnly).toBeNull();
    await expect(store.open(doc, "list/nope")).rejects.toThrow('There is no saved document "list/nope". Saved list documents: list/groceries-list, list/work.');
    expect(await store.remove("list/work")).toBe(true);
    expect(await store.remove("list/work")).toBe(false);
    expect(await store.read("list/work")).toBeNull();
  });

  it("slugifies names", () => {
    expect(slugifyDocumentName("  Release Flow — v2! ")).toBe("release-flow-v2");
    expect(slugifyDocumentName("***")).toBe("untitled");
  });
});

describe("createEditorAutosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("snapshots after changes and restores a recovered snapshot into the document", async () => {
    const storage = createMemoryStorage();
    const first = setup();
    const autosave = createEditorAutosave(first.doc, { storage, debounceMs: 10 });
    expect(await autosave.checkRecovery()).toBeNull();
    autosave.controller.ready();
    first.edit(["a", "b"]);
    await vi.advanceTimersByTimeAsync(20);
    await autosave.controller.whenIdle();
    expect(JSON.parse((await storage.get("list"))!)).toEqual(toEditorDocumentFile(first.doc));
    autosave.destroy();

    const second = setup();
    const again = createEditorAutosave(second.doc, { storage });
    const recovery = await again.checkRecovery();
    expect(recovery?.snapshot?.document).toEqual({ items: ["a", "b"] });
    again.restore(recovery!);
    expect(second.items()).toEqual(["a", "b"]);
    expect(second.history.getState().canUndo).toBe(false);
    again.destroy();
  });

  it("retires stale recovery snapshots when baseVersion has advanced on the server", async () => {
    const storage = createMemoryStorage();
    const first = setup();
    const autosave = createEditorAutosave(first.doc, { storage, debounceMs: 10, baseVersion: 3 });
    autosave.controller.ready();
    first.edit(["a", "stale"]);
    await vi.advanceTimersByTimeAsync(20);
    await autosave.controller.whenIdle();
    autosave.destroy();

    // Server moved ahead to version 5 in another tab/session.
    const second = setup();
    const newerServer = createEditorAutosave(second.doc, { storage, baseVersion: 5 });
    expect(await newerServer.recoverIfNewer()).toBeNull();
    expect(second.items()).toEqual(["a"]);
    expect(await storage.get("list")).toBeNull();
    newerServer.destroy();
  });
});

describe("createEditorRemoteSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("debounces local edits, serializes in-flight saves, advances monotonic version, and flushes on demand", async () => {
    const { doc, edit } = setup();
    const storage = createMemoryStorage();
    const autosave = createEditorAutosave(doc, { storage, debounceMs: 10, baseVersion: () => sync.savedVersion() });
    autosave.controller.ready();

    const localChanges: Array<{ items: string[]; version: number }> = [];
    const savedCalls: Array<{ items: string[]; version: number }> = [];
    let resolveInFlight: ((res: { version: number }) => void) | null = null;

    const sync = createEditorRemoteSync(doc, {
      initialVersion: 2,
      debounceMs: 50,
      autosave,
      onLocalChange: ({ document, version }) => {
        localChanges.push({ items: document.items, version });
      },
      save: ({ document, version }) => {
        savedCalls.push({ items: document.items, version });
        if ( resolveInFlight === null && savedCalls.length === 1 ) {
          return new Promise<{ version: number }>((resolve) => {
            resolveInFlight = resolve;
          });
        }
        return Promise.resolve({ version });
      },
    });

    // Local edit 1: onLocalChange fires immediately, save waits for debounce.
    edit(["a", "b"]);
    expect(localChanges).toEqual([{ items: ["a", "b"], version: 3 }]);
    expect(sync.dirty()).toBe(true);
    expect(sync.status().status).toBe("pending");
    expect(savedCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);
    expect(savedCalls).toEqual([{ items: ["a", "b"], version: 3 }]);
    expect(sync.status().status).toBe("saving");

    // Local edit 2 arrives while save 1 is in flight: coalesced without overlapping save calls.
    edit(["a", "b", "c"]);
    expect(localChanges).toHaveLength(2);
    expect(savedCalls).toHaveLength(1);

    // Server reports version 10 (e.g., collaborator saved versions 4..9).
    resolveInFlight!({ version: 10 });
    await vi.advanceTimersByTimeAsync(50);
    await sync.whenIdle();

    // Follow-up save uses monotonic version 11 (> 10), never wedging.
    expect(savedCalls).toEqual([
      { items: ["a", "b"], version: 3 },
      { items: ["a", "b", "c"], version: 11 },
    ]);
    expect(sync.dirty()).toBe(false);
    expect(sync.savedVersion()).toBe(11);
    expect(sync.status().status).toBe("saved");

    // applyRemote updates the document and baseline without echoing a local change or save.
    sync.applyRemote(() => {
      doc.loadDocument({ items: ["remote"] }, { history: "reset" });
    }, 15);
    expect(localChanges).toHaveLength(2);
    expect(sync.dirty()).toBe(false);
    expect(sync.version()).toBe(15);

    // flush() immediately saves pending edits without waiting for the debounce timer.
    edit(["remote", "local-before-exit"]);
    expect(sync.dirty()).toBe(true);
    await sync.flush();
    expect(savedCalls.at(-1)).toEqual({ items: ["remote", "local-before-exit"], version: 16 });
    expect(sync.dirty()).toBe(false);

    sync.destroy();
    autosave.destroy();
  });

  it("hands save the diff of every edit since the last save, and onLocalChange only the latest edit", async () => {
    const { doc, edit } = setup();
    const localDiffs: string[][] = [];
    const savedDiffs: string[][] = [];
    const sync = createEditorRemoteSync<{ items: string[] }, string[]>(doc, {
      debounceMs: 50,
      diff: (current, baseline) => current.items.filter((item) => !baseline.items.includes(item)),
      isEmptyDiff: (diff, current, baseline) => diff.length === 0 && current.items.length === baseline.items.length,
      onLocalChange: ({ diff }) => localDiffs.push(diff!),
      save: async ({ diff, version }) => {
        savedDiffs.push(diff!);
        return { version };
      },
    });

    edit(["a", "b"]);
    edit(["a", "b", "c"]);
    await sync.flush();
    expect(localDiffs).toEqual([["b"], ["c"]]);
    expect(savedDiffs).toEqual([["b", "c"]]);

    edit(["a", "b", "c", "d"]);
    await sync.flush();
    expect(savedDiffs.at(-1)).toEqual(["d"]);
    sync.destroy();
  });

  it("recovers when save throws synchronously instead of wedging later saves", async () => {
    const { doc, edit } = setup();
    let calls = 0;
    const sync = createEditorRemoteSync(doc, {
      debounceMs: 0,
      onError: () => {},
      save: ({ version }) => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return Promise.resolve({ version });
      },
    });

    edit(["b"]);
    await sync.whenIdle();
    expect(sync.status().status).toBe("error");
    expect(sync.dirty()).toBe(true);

    expect(await sync.flush()).toBe(true);
    expect(calls).toBe(2);
    expect(sync.dirty()).toBe(false);
    sync.destroy();
  });

  it("still saves edits a flush picked up after destroy()", async () => {
    const { doc, edit } = setup();
    const saved: string[][] = [];
    let release!: () => void;
    const sync = createEditorRemoteSync(doc, {
      debounceMs: 0,
      save: ({ document, version }) => {
        saved.push(document.items);
        if (saved.length === 1) return new Promise((resolve) => (release = () => resolve({ version })));
        return Promise.resolve({ version });
      },
    });

    edit(["b"]);
    edit(["b", "c"]);
    const flushed = sync.flush();
    sync.destroy();
    release();
    expect(await flushed).toBe(true);
    expect(saved).toEqual([["b"], ["b", "c"]]);
    expect(sync.dirty()).toBe(false);
  });

  it("passes baseVersion for compare-and-set writes and merges on a conflict before saving again", async () => {
    const { doc, edit } = setup();
    // The "server": a collaborator already saved ["a", "server"] as version 3.
    let server = { items: ["a", "server"], version: 3 };
    const calls: Array<{ baseVersion: number; version: number; items: string[] }> = [];
    const localChanges: string[][] = [];
    const sync = createEditorRemoteSync(doc, {
      initialVersion: 1,
      debounceMs: 0,
      onLocalChange: ({ document }) => localChanges.push(document.items),
      save: async ({ document, version, baseVersion }) => {
        calls.push({ baseVersion, version, items: document.items });
        if (server.version !== baseVersion) return { conflict: true, version: server.version };
        server = { items: document.items, version };
        return { version };
      },
      onConflict: async ({ document, base, apply }) => {
        const mine = document.items.filter((item) => !base.items.includes(item));
        const merged = [...server.items, ...mine.filter((item) => !server.items.includes(item))];
        apply(() => doc.loadDocument({ items: merged }, { history: "reset" }));
        return { serverVersion: server.version, serverDocument: { items: [...server.items] } };
      },
    });

    edit(["a", "mine"]);
    await sync.whenIdle();
    expect(calls).toEqual([
      { baseVersion: 1, version: 2, items: ["a", "mine"] },
      { baseVersion: 3, version: 4, items: ["a", "server", "mine"] },
    ]);
    expect(server).toEqual({ items: ["a", "server", "mine"], version: 4 });
    expect(doc.getDocument().items).toEqual(["a", "server", "mine"]);
    // Loading the merge was not broadcast as a local edit.
    expect(localChanges).toEqual([["a", "mine"]]);
    expect(sync.dirty()).toBe(false);
    expect(sync.savedVersion()).toBe(4);
    sync.destroy();
  });

  it("reports a conflict without onConflict, and gives up after maxConflictRetries", async () => {
    const { doc, edit } = setup();
    const errors: unknown[] = [];
    const sync = createEditorRemoteSync(doc, {
      debounceMs: 0,
      onError: (error) => errors.push(error),
      save: async () => ({ conflict: true, version: 7 }),
    });
    edit(["b"]);
    await sync.whenIdle();
    expect(errors[0]).toBeInstanceOf(EditorRemoteConflictError);
    expect((errors[0] as EditorRemoteConflictError).serverVersion).toBe(7);
    expect(sync.dirty()).toBe(true);
    expect(sync.status().status).toBe("error");
    sync.destroy();

    let resolved = 0;
    const stubborn = createEditorRemoteSync(doc, {
      debounceMs: 0,
      maxConflictRetries: 2,
      onError: (error) => errors.push(error),
      save: async () => ({ conflict: true }),
      onConflict: () => {
        resolved++;
        return { serverVersion: 9 };
      },
    });
    edit(["b", "c"]);
    await stubborn.whenIdle();
    expect(resolved).toBe(2);
    expect(errors.at(-1)).toBeInstanceOf(EditorRemoteConflictError);
    stubborn.destroy();
  });

  it("does not report a failed save when only autosave.markClean fails", async () => {
    const { doc, edit } = setup();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    const sync = createEditorRemoteSync(doc, {
      debounceMs: 0,
      onError,
      autosave: { markClean: () => Promise.reject(new Error("storage full")) },
      save: async ({ version }) => ({ version }),
    });

    edit(["b"]);
    expect(await sync.flush()).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(sync.status().status).toBe("saved");
    errorSpy.mockRestore();
    sync.destroy();
  });
});

describe("createDocumentToolProvider", () => {
  it("gets and loads the document as one undo step, refusing bad input without a change", async () => {
    const { doc, items } = setup();
    const registry = registryFor(doc);
    const got: any = await registry.callTool("get_list_document", {});
    expect(got.structuredContent).toEqual({ kind: "list", formatVersion: 1, revision: 0, document: { items: ["a"] } });

    const loaded: any = await registry.callTool("load_list_document", { document: { items: ["x", "y"] } });
    expect(loaded.isError).toBeFalsy();
    expect(loaded.structuredContent).toEqual({ revision: 1, undoable: true });
    expect(items()).toEqual(["x", "y"]);

    const bad: any = await registry.callTool("load_list_document", { document: { items: 3 } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch("A list document is { items: string[] }.");
    expect(items()).toEqual(["x", "y"]);

    const missing: any = await registry.callTool("load_list_document", {});
    expect(missing.isError).toBe(true);

    const undone: any = await registry.callTool("undo_list", {});
    expect(undone.structuredContent).toMatchObject({ undone: "Load list", canUndo: false, canRedo: true, redoName: "Load list" });
    expect(items()).toEqual(["a"]);
    const redone: any = await registry.callTool("redo_list", {});
    expect(redone.structuredContent).toMatchObject({ redone: "Load list", canUndo: true });
  });

  it("fails usefully on an empty history and a read-only document", async () => {
    let reason: string | false = false;
    const { doc } = setup({ readOnly: () => reason });
    const registry = registryFor(doc);
    expect(text(await registry.callTool("undo_list", {}))).toMatch("Nothing to undo.");
    expect(text(await registry.callTool("redo_list", {}))).toMatch("Nothing to redo.");
    reason = "The list is locked.";
    const refused: any = await registry.callTool("load_list_document", { document: { items: [] } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch("The list is locked. Read tools still work; write tools are refused.");
    expect((await registry.callTool("get_list_document", {}) as any).isError).toBeFalsy();
  });

  it("refuses documents over maxChars", async () => {
    const { doc } = setup();
    const result: any = await registryFor(doc, { maxChars: 5 }).callTool("get_list_document", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/over the 5 limit/);
  });

  it("can leave undo / redo to the editor's own tools", () => {
    const { doc } = setup();
    const names = (createDocumentToolProvider(doc, { history: false }).tools as any[]).map((t) => t.name);
    expect(names).toEqual(["get_list_document", "load_list_document"]);
  });

  it("saves, lists and opens saved documents with a store", async () => {
    const { doc, edit, items } = setup();
    const store = createEditorDocumentStore({ storage: createMemoryStorage() });
    const registry = registryFor(doc, { store, name: () => "Shopping" });
    const saved: any = await registry.callTool("save_list_document", {});
    expect(saved.structuredContent).toMatchObject({ key: "list/shopping", name: "Shopping", revision: 0 });
    edit(["z"]);
    await registry.callTool("save_list_document", { name: "Other" });
    const listed: any = await registry.callTool("list_saved_list_documents", {});
    expect(listed.structuredContent.documents.map((d: any) => d.key).sort()).toEqual(["list/other", "list/shopping"]);
    const opened: any = await registry.callTool("open_saved_list_document", { key: "list/shopping" });
    expect(opened.structuredContent).toMatchObject({ key: "list/shopping", name: "Shopping", undoable: true });
    expect(items()).toEqual(["a"]);
    const unknown: any = await registry.callTool("open_saved_list_document", { key: "list/x" });
    expect(text(unknown)).toMatch('There is no saved document "list/x".');
    const extra: any = await registry.callTool("save_list_document", { name: "x", folder: "y" });
    expect(extra.isError).toBe(true);
  });
});

describe("createDiagramEditorDocument", () => {
  const source = "flowchart TD\n  A --> B\n";

  it("round-trips the Mermaid source and ignores selection changes", () => {
    const controller = new DiagramController({ source });
    const doc = createDiagramEditorDocument(controller);
    expect(doc.getDocument()).toEqual({ source });
    controller.select(["A"]);
    expect(doc.revision()).toBe(0);
    doc.loadDocument(doc.getDocument());
    expect(controller.getSource()).toBe(source);
    doc.destroy();
  });

  it("records agent loads as one undo step and resets history on open", async () => {
    const controller = new DiagramController({ source });
    const doc = createDiagramEditorDocument(controller);
    const registry = registryFor(doc, { history: false });
    const loaded: any = await registry.callTool("load_diagram_document", { document: { source: "flowchart LR\n  X --> Y\n" } });
    expect(loaded.structuredContent).toMatchObject({ undoable: true, revision: 1 });
    expect(controller.getState().document.graph.nodes.map((n) => n.id)).toEqual(["X", "Y"]);
    controller.undo();
    expect(controller.getSource()).toBe(source);
    doc.loadDocument({ source: "flowchart LR\n  Q\n" });
    expect(controller.getState().canUndo).toBe(false);
    expect(text(await registry.callTool("load_diagram_document", { document: { text: "x" } }))).toMatch("A diagram document is { source: string }");
  });

  it("refuses recorded loads when read-only", async () => {
    const controller = new DiagramController({ source, readOnly: true });
    const registry = registryFor(createDiagramEditorDocument(controller), { history: false });
    const result: any = await registry.callTool("load_diagram_document", { document: { source: "flowchart LR\n  Q\n" } });
    expect(text(result)).toMatch("The diagram is read-only.");
    expect(controller.getSource()).toBe(source);
  });
});
