import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectAssetRefs,
  collectEditorAssetGarbage,
  createDocumentToolProvider,
  createEditorAssetRegistry,
  createEditorAutosave,
  createEditorDocumentStore,
  createLocalStorageAdapter,
  createMemoryStorage,
  createOpfsAdapter,
  defineEditorDocument,
  externalizeAssets,
  persistEditorAssets,
  tryCollectEditorAssetGarbage,
  withEditorAssets,
  withStorageFailures,
  type EditorAssetRegistry,
  type StorageAdapter,
} from "../src/persistence";
import { HistoryManager } from "../src/history";
import { ToolRegistry } from "../src/tools";

const text = (result: any) => result.content?.[0]?.text as string;
const bigDataUrl = (seed: number) => `data:image/png;base64,${Array.from({ length: 800 }, (_, i) => "ABCDEFGHIJKLMNOP"[(i * seed) % 16]).join("")}`;
const assetKeys = (storage: { entries: Map<string, string> }) => [...storage.entries.keys()].filter((k) => /^pixerate\.assets:[0-9a-z]+-/.test(k)).sort();
const keyOf = (ref: string) => `pixerate.assets:${ref.slice("pixerate-asset:".length)}`;

/** A tiny editor document whose state is a list of inline images. */
function pictureDoc(assets: EditorAssetRegistry = createEditorAssetRegistry()) {
  let pictures: string[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const doc = defineEditorDocument<{ pictures: string[] }>({
    kind: "picture",
    assets,
    recordsLoads: false,
    get: () => ({ pictures: [...pictures] }),
    load: (document) => {
      pictures = [...(document as { pictures: string[] }).pictures];
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    history: historyStub(),
  });
  return {
    doc,
    assets,
    setPictures(next: string[]) {
      pictures = next;
      emit();
    },
  };
}

function historyStub() {
  const history = new HistoryManager();
  return { undo: () => history.undo(), redo: () => history.redo(), getState: () => history.getState() };
}

function plainDoc(kind: string, extra: { assets?: EditorAssetRegistry; readOnly?: () => string | false } = {}) {
  return defineEditorDocument<{ n: number }>({ kind, ...extra, get: () => ({ n: 1 }), load: () => {}, subscribe: () => () => {}, history: historyStub() });
}

describe("storage key listing", () => {
  it("memory, failure-wrapped and asset-wrapped storage list keys by prefix", async () => {
    const storage = createMemoryStorage({ initial: { "a:1": "x", "a:2": "y", "b:1": "z" } });
    expect((await storage.keys!("a:")).sort()).toEqual(["a:1", "a:2"]);
    expect((await storage.keys!()).sort()).toEqual(["a:1", "a:2", "b:1"]);
    const failing = withStorageFailures(storage, (op) => op === "keys");
    await expect(failing.keys!("a:")).rejects.toThrow(/injected keys failure/);
    expect((await withEditorAssets(storage, createEditorAssetRegistry()).keys!("b:"))).toEqual(["b:1"]);
    // Adapters without listing stay without it.
    const { keys: _keys, ...plain } = storage;
    expect(withStorageFailures(plain as StorageAdapter, () => false).keys).toBeUndefined();
  });

  it("localStorage lists its own prefixed keys, and only when Web Storage can enumerate", async () => {
    const map = new Map<string, string>([["app:a", "1"], ["app:b", "2"], ["other", "3"]]);
    const web = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
    };
    const adapter = createLocalStorageAdapter("app:", { storage: web });
    expect((await adapter.keys!()).sort()).toEqual(["a", "b"]);
    expect(await adapter.keys!("a")).toEqual(["a"]);
    const noEnum = createLocalStorageAdapter("app:", { storage: { getItem: web.getItem, setItem: web.setItem, removeItem: web.removeItem } });
    expect(noEnum.keys).toBeUndefined();
  });

  it("OPFS lists keys, folding pointer slots and skipping unfinished writes", async () => {
    const files = new Map<string, string>();
    const dir: any = {
      getDirectoryHandle: async () => dir,
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (!files.has(name) && !opts?.create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
        if (!files.has(name)) files.set(name, "");
        return {
          getFile: async () => ({ text: async () => files.get(name)! }),
          createWritable: async () => ({ write: async (d: string) => void files.set(name, d), close: async () => {} }),
        };
      },
      removeEntry: async (name: string) => void files.delete(name),
      async *keys() {
        yield* files.keys();
      },
    };
    const opfs = createOpfsAdapter("d", { root: async () => dir, disableRename: true });
    await opfs.set("doc:one", "1");
    await opfs.set("pixerate.assets:a-b", "2");
    files.set(`${encodeURIComponent("half")}.tmp`, "x");
    files.set("plain", "3");
    expect((await opfs.keys!()).sort()).toEqual(["doc:one", "pixerate.assets:a-b", "plain"]);
    expect(await opfs.keys!("pixerate.assets:")).toEqual(["pixerate.assets:a-b"]);
  });
});

describe("collectEditorAssetGarbage", () => {
  it("deletes only assets that no stored value refers to", async () => {
    const storage = createMemoryStorage();
    const registry = createEditorAssetRegistry();
    const wrapped = withEditorAssets(storage, registry);
    const keepDoc = externalizeAssets({ png: bigDataUrl(3) }, registry);
    const dropDoc = externalizeAssets({ png: bigDataUrl(5) }, registry);
    await wrapped.set("docs:keep", JSON.stringify(keepDoc));
    await wrapped.set("docs:drop", JSON.stringify(dropDoc));
    await storage.set("unrelated", "plain text");
    expect(assetKeys(storage)).toHaveLength(2);
    await storage.remove("docs:drop");

    const dry = await collectEditorAssetGarbage(storage, { dryRun: true });
    expect(dry).toMatchObject({ assets: 2, referenced: 1, kept: 0, unreferenced: [dropDoc.png], removed: [], freedChars: 0, dryRun: true });
    expect(dry.unreferencedChars).toBe(bigDataUrl(5).length);
    expect(assetKeys(storage)).toHaveLength(2);

    const report = await collectEditorAssetGarbage(storage);
    expect(report.removed).toEqual([dropDoc.png]);
    expect(report.freedChars).toBe(bigDataUrl(5).length);
    expect(assetKeys(storage)).toEqual([keyOf(keepDoc.png)]);
    expect(storage.entries.get("unrelated")).toBe("plain text");
    // Running again finds nothing.
    expect((await collectEditorAssetGarbage(storage)).removed).toEqual([]);
  });

  it("keeps registries, editor documents, references and documents passed in keep", async () => {
    const storage = createMemoryStorage();
    const a = createEditorAssetRegistry();
    const refs = ["a", "b", "c", "d"].map((_, i) => a.put(bigDataUrl(3 + i * 2)));
    for (const ref of refs) await storage.set(keyOf(ref), a.get(ref)!);
    const onlyFirst = createEditorAssetRegistry();
    onlyFirst.set(refs[0], a.get(refs[0])!);
    const { doc } = pictureDoc(createEditorAssetRegistry());
    doc.assets!.set(refs[1], a.get(refs[1])!);
    const report = await collectEditorAssetGarbage(storage, { keep: [onlyFirst, doc, refs[2]], dryRun: true });
    expect(report.kept).toBe(3);
    expect(report.unreferenced).toEqual([refs[3]]);
    expect((await collectEditorAssetGarbage(storage, { keep: [{ layers: [{ png: refs[3] }] }], dryRun: true })).unreferenced).toHaveLength(3);
    // A registry that cannot list its references cannot be protected: refused before anything is deleted.
    const { refs: _r, ...blind } = onlyFirst;
    await expect(collectEditorAssetGarbage(storage, { keep: [blind] })).rejects.toThrow(/cannot list its references/);
    expect(assetKeys(storage)).toHaveLength(4);
  });

  it("deletes only the given references, refusing stale ones without deleting anything", async () => {
    const storage = createMemoryStorage();
    const registry = createEditorAssetRegistry();
    const refs = [3, 5, 7].map((s) => registry.put(bigDataUrl(s)));
    for (const ref of refs) await storage.set(keyOf(ref), registry.get(ref)!);
    await storage.set("doc", JSON.stringify({ png: refs[2] }));
    await expect(collectEditorAssetGarbage(storage, { only: [refs[0], refs[2]] })).rejects.toThrow(/1 of the given asset is not unreferenced.*Nothing was deleted/);
    expect(assetKeys(storage)).toHaveLength(3);
    const report = await collectEditorAssetGarbage(storage, { only: [refs[0]] });
    expect(report.removed).toEqual([refs[0]]);
    expect(assetKeys(storage)).toHaveLength(2);
  });

  it("refuses storage that cannot list keys, and the best-effort form returns null", async () => {
    const { keys: _keys, ...plain } = createMemoryStorage();
    await expect(collectEditorAssetGarbage(plain as StorageAdapter)).rejects.toThrow(/cannot list its keys.*keys\(prefix\)/);
    expect(await tryCollectEditorAssetGarbage(plain as StorageAdapter)).toBeNull();
    const failing = withStorageFailures(createMemoryStorage(), (op) => op === "keys");
    expect(await tryCollectEditorAssetGarbage(failing)).toBeNull();
  });

  it("reports how far it got when storage fails mid-way", async () => {
    const inner = createMemoryStorage();
    const registry = createEditorAssetRegistry();
    const refs = [3, 5].map((s) => registry.put(bigDataUrl(s)));
    for (const ref of refs) await inner.set(keyOf(ref), registry.get(ref)!);
    let removes = 0;
    const storage = withStorageFailures(inner, (op) => op === "remove" && removes++ === 1);
    await expect(collectEditorAssetGarbage(storage)).rejects.toThrow(/Deleted 1 of 2 unreferenced assets, then storage failed/);
  });

  it.each([
    ["with Web Locks (waits for the write)", true],
    ["without Web Locks (skips leased assets)", false],
  ])("never deletes assets a write in flight is about to refer to, %s", async (_name, locks) => {
    const nav = (globalThis as any).navigator;
    if (locks && !nav?.locks) return; // This runtime has no Web Locks.
    if (!locks) vi.stubGlobal("navigator", {});
    try {
      await inFlightCase(locks);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  async function inFlightCase(locks: boolean) {
    const inner = createMemoryStorage();
    const registry = createEditorAssetRegistry();
    const doc = externalizeAssets({ png: bigDataUrl(9) }, registry);
    // The document write is held until the collection has run.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: StorageAdapter = {
      ...inner,
      kind: inner.kind,
      available: true,
      async set(key, value) {
        if (key === "doc") await gate;
        return inner.set(key, value);
      },
    };
    const writing = withEditorAssets(slow, registry).set("doc", JSON.stringify(doc));
    await vi.waitFor(() => expect(assetKeys(inner)).toHaveLength(1));
    const collecting = collectEditorAssetGarbage(inner);
    if (locks) {
      // The collection waits for the write's lock, then sees the document.
      await new Promise((r) => setTimeout(r, 20));
      release();
      expect(await collecting).toMatchObject({ assets: 1, referenced: 1, removed: [] });
    } else {
      expect(await collecting).toMatchObject({ assets: 1, kept: 1, removed: [] });
      release();
    }
    await writing;
    expect((await collectEditorAssetGarbage(inner)).referenced).toBe(1);
    expect(assetKeys(inner)).toHaveLength(1);
  }

  it("makes sessions write deleted assets again instead of trusting their cache", async () => {
    const storage = createMemoryStorage();
    const registry = createEditorAssetRegistry();
    const doc = externalizeAssets({ png: bigDataUrl(11) }, registry);
    await persistEditorAssets(storage, registry, doc);
    // Nothing refers to it yet, so a collection deletes it ...
    expect((await collectEditorAssetGarbage(storage)).removed).toHaveLength(1);
    expect(assetKeys(storage)).toHaveLength(0);
    // ... and the registry's next save writes it again.
    await withEditorAssets(storage, registry).set("doc", JSON.stringify(doc));
    expect(assetKeys(storage)).toEqual([keyOf(doc.png)]);
    expect(collectAssetRefs(storage.entries.get("doc"))).toEqual([doc.png]);
  });
});

describe("document store", () => {
  it("collects the assets of a removed document but keeps shared ones", async () => {
    const storage = createMemoryStorage();
    const store = createEditorDocumentStore({ storage });
    const shared = bigDataUrl(3);
    const { doc, setPictures } = pictureDoc();
    setPictures([shared, bigDataUrl(5)]);
    await store.save(doc, "First");
    setPictures([shared, bigDataUrl(7)]);
    await store.save(doc, "Second");
    expect(assetKeys(storage)).toHaveLength(3);
    expect(await store.remove("picture/first")).toBe(true);
    expect(assetKeys(storage)).toHaveLength(2);
    const fresh = pictureDoc();
    await store.open(fresh.doc, "picture/second");
    expect(fresh.doc.getDocument()).toEqual(doc.getDocument());
    expect(await store.remove("picture/missing")).toBe(false);
  });

  it("can leave collection off, and collects on demand", async () => {
    const storage = createMemoryStorage();
    const store = createEditorDocumentStore({ storage, collectAssetGarbage: false });
    const { doc, setPictures } = pictureDoc();
    setPictures([bigDataUrl(5)]);
    await store.save(doc, "Only");
    await store.remove("picture/only");
    expect(assetKeys(storage)).toHaveLength(1);
    const report = await store.collectAssetGarbage!();
    expect(report.removed).toHaveLength(1);
    expect(assetKeys(storage)).toHaveLength(0);
    // A storage that cannot list keys has no collection, and remove still works.
    const { keys: _keys, ...plain } = createMemoryStorage();
    const plainStore = createEditorDocumentStore({ storage: plain as StorageAdapter });
    expect(plainStore.collectAssetGarbage).toBeUndefined();
    await plainStore.save(doc, "Only");
    expect(await plainStore.remove("picture/only")).toBe(true);
  });

  it("replacing a saved document leaves the old assets for the next collection", async () => {
    const storage = createMemoryStorage();
    const store = createEditorDocumentStore({ storage });
    const { doc, setPictures } = pictureDoc();
    setPictures([bigDataUrl(5)]);
    await store.save(doc, "Same");
    setPictures([bigDataUrl(7)]);
    await store.save(doc, "Same");
    expect(assetKeys(storage)).toHaveLength(2);
    expect((await store.collectAssetGarbage!({ keep: [] })).removed).toHaveLength(1);
  });
});

describe("editor autosave", () => {
  afterEach(() => vi.useRealTimers());

  it("collects after markClean retires the snapshot, keeping the open document's assets", async () => {
    vi.useFakeTimers();
    const storage = createMemoryStorage();
    const store = createEditorDocumentStore({ storage });
    const { doc, assets, setPictures } = pictureDoc();
    const autosave = createEditorAutosave(doc, { storage, debounceMs: 5, interval: 5 });
    await autosave.checkRecovery();
    autosave.controller.ready();
    // An old picture only the snapshot ever held, then the current one.
    setPictures([bigDataUrl(3)]);
    autosave.controller.notify();
    await vi.advanceTimersByTimeAsync(20);
    await autosave.controller.whenIdle();
    setPictures([bigDataUrl(5)]);
    autosave.controller.notify();
    await vi.advanceTimersByTimeAsync(20);
    await autosave.controller.whenIdle();
    expect(assetKeys(storage)).toHaveLength(2);
    // An orphan nobody holds.
    const orphanRegistry = createEditorAssetRegistry();
    const orphan = orphanRegistry.put(bigDataUrl(13));
    await storage.set(keyOf(orphan), bigDataUrl(13));

    await store.save(doc, "Saved");
    await autosave.markClean();
    expect(storage.entries.has("picture")).toBe(false);
    // The orphan and the old picture (only the retired snapshot used it) are gone; the current one stays.
    expect(assetKeys(storage)).toEqual([keyOf(assets.put(bigDataUrl(5)))]);
    // Undo back to the old picture: the registry still has it, and the next snapshot writes it again.
    setPictures([bigDataUrl(3)]);
    autosave.controller.notify();
    await vi.advanceTimersByTimeAsync(20);
    await autosave.controller.whenIdle();
    expect(assetKeys(storage)).toContain(keyOf(assets.put(bigDataUrl(3))));
    autosave.destroy();
  });

  it("collects after discarding an earlier session's snapshot, and can be turned off", async () => {
    const storage = createMemoryStorage();
    const first = pictureDoc();
    first.setPictures([bigDataUrl(7)]);
    const file = JSON.stringify({ format: "pixerate-editor-document", kind: "picture", formatVersion: 1, document: first.doc.getDocument() });
    await withEditorAssets(storage, first.assets).set("picture", file);
    await storage.set("picture:meta", JSON.stringify({ dirty: true, time: 1 }));
    expect(assetKeys(storage)).toHaveLength(1);

    const off = createEditorAutosave(pictureDoc().doc, { storage, collectAssetGarbage: false });
    expect(await off.checkRecovery()).not.toBeNull();
    await off.discard();
    expect(assetKeys(storage)).toHaveLength(1);
    off.destroy();

    await storage.set("picture", file);
    await storage.set("picture:meta", JSON.stringify({ dirty: true, time: 2 }));
    const on = createEditorAutosave(pictureDoc().doc, { storage });
    // The recovery check reads the snapshot's assets into the registry; discarding still collects them.
    expect(await on.checkRecovery()).not.toBeNull();
    await on.discard();
    expect(assetKeys(storage)).toHaveLength(0);
    on.destroy();
  });
});

describe("document asset tools", () => {
  it("find and delete unreferenced assets through ToolRegistry.callTool", async () => {
    const storage = createMemoryStorage();
    const store = createEditorDocumentStore({ storage, collectAssetGarbage: false });
    const { doc, setPictures } = pictureDoc();
    const registry = new ToolRegistry();
    registry.register(createDocumentToolProvider(doc, { namespace: "", store }));
    setPictures([bigDataUrl(3)]);
    await store.save(doc, "A");
    setPictures([bigDataUrl(5)]);
    await store.save(doc, "B");
    await store.remove("picture/a");
    const other = createEditorAssetRegistry();
    const removedPicture = other.put(bigDataUrl(3));
    // Another session's leftover.
    const orphan = other.put(bigDataUrl(9));
    await storage.set(keyOf(orphan), bigDataUrl(9));
    // The open document now also uses a picture that only an unsaved write has stored.
    setPictures([bigDataUrl(5), bigDataUrl(11)]);
    await storage.set(keyOf(other.put(bigDataUrl(11))), bigDataUrl(11));

    const found: any = await registry.callTool("find_unreferenced_picture_assets", {});
    expect(found.isError, text(found)).toBeFalsy();
    expect(found.structuredContent).toMatchObject({ assets: 4, referenced: 1, kept: 1, unreferenced: 2, more: 0 });
    expect([...found.structuredContent.refs].sort()).toEqual([removedPicture, orphan].sort());
    expect(found.structuredContent.unreferencedChars).toBe(bigDataUrl(3).length + bigDataUrl(9).length);

    const bad: any = await registry.callTool("delete_unreferenced_picture_assets", { refs: ["pixerate-asset:zz-zz"] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/not unreferenced in storage now \(pixerate-asset:zz-zz\).*Nothing was deleted/);
    const invalid: any = await registry.callTool("delete_unreferenced_picture_assets", { refs: ["nope"] });
    expect(invalid.isError).toBe(true);
    const extra: any = await registry.callTool("delete_unreferenced_picture_assets", { all: true });
    expect(extra.isError).toBe(true);
    expect(assetKeys(storage)).toHaveLength(4);

    const deleted: any = await registry.callTool("delete_unreferenced_picture_assets", { refs: [orphan] });
    expect(deleted.isError, text(deleted)).toBeFalsy();
    expect(deleted.structuredContent).toEqual({ removed: 1, freedChars: bigDataUrl(9).length, kept: 1, remaining: 3 });
    const rest: any = await registry.callTool("delete_unreferenced_picture_assets", {});
    expect(rest.structuredContent).toEqual({ removed: 1, freedChars: bigDataUrl(3).length, kept: 1, remaining: 2 });
    const again: any = await registry.callTool("delete_unreferenced_picture_assets", {});
    expect(again.structuredContent).toMatchObject({ removed: 0, remaining: 2 });
  });

  it("are only listed for asset documents on storage that lists keys, and refuse writes when read-only", async () => {
    const names = (provider: any) => provider.tools.map((t: any) => t.name);
    const store = createEditorDocumentStore({ storage: createMemoryStorage() });
    const { keys: _keys, ...plain } = createMemoryStorage();
    const plainStore = createEditorDocumentStore({ storage: plain as StorageAdapter });
    expect(names(createDocumentToolProvider(pictureDoc().doc, { store }))).toContain("delete_unreferenced_picture_assets");
    expect(names(createDocumentToolProvider(pictureDoc().doc, { store: plainStore }))).not.toContain("find_unreferenced_picture_assets");
    expect(names(createDocumentToolProvider(plainDoc("plain"), { store }))).not.toContain("find_unreferenced_plain_assets");

    const locked = plainDoc("locked", { assets: createEditorAssetRegistry(), readOnly: () => "The document is locked." });
    const registry = new ToolRegistry();
    registry.register(createDocumentToolProvider(locked, { namespace: "", store }));
    expect((await registry.callTool("find_unreferenced_locked_assets", {}) as any).isError).toBeFalsy();
    const refused: any = await registry.callTool("delete_unreferenced_locked_assets", {});
    expect(text(refused)).toMatch(/The document is locked\. Read tools still work/);
  });
});
