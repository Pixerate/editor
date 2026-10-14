import { describe, expect, it } from "vitest";
import {
  InjectedStorageError,
  StorageUnavailableError,
  createIndexedDbAdapter,
  createLocalStorageAdapter,
  createMemoryStorage,
  createOpfsAdapter,
  isIndexedDbAvailable,
  isOpfsAvailable,
  withStorageFailures,
  type StorageAdapter,
  type WebStorageLike,
} from "../src/persistence";
import { createFakeIndexedDb, createFakeOpfs } from "./helpers/storage-fakes";

function fakeWebStorage(): WebStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

async function roundTrip(adapter: StorageAdapter) {
  expect(adapter.available).toBe(true);
  expect(await adapter.get("doc")).toBeNull();
  await adapter.set("doc", "one");
  expect(await adapter.get("doc")).toBe("one");
  await adapter.set("doc", "two");
  expect(await adapter.get("doc")).toBe("two");
  await adapter.set("other/key", "x");
  expect(await adapter.get("other/key")).toBe("x");
  await adapter.remove("doc");
  expect(await adapter.get("doc")).toBeNull();
  await adapter.remove("missing"); // removing a missing key is fine
  expect(await adapter.get("other/key")).toBe("x");
}

describe("storage adapters", () => {
  it("memory: round trip and injected failures", async () => {
    await roundTrip(createMemoryStorage());
    const failing = createMemoryStorage({ failure: (op) => op === "set" });
    await expect(failing.set("a", "b")).rejects.toBeInstanceOf(InjectedStorageError);
    expect(failing.entries.size).toBe(0);
    const custom = createMemoryStorage({ failure: () => new Error("quota") });
    await expect(custom.get("a")).rejects.toThrow("quota");
  });

  it("withStorageFailures wraps any adapter", async () => {
    let fail = true;
    const inner = createMemoryStorage();
    const wrapped = withStorageFailures(inner, (op, key) => fail && op === "set" && key === "a");
    await expect(wrapped.set("a", "1")).rejects.toThrow(/injected set failure/);
    await wrapped.set("b", "1");
    fail = false;
    await wrapped.set("a", "2");
    expect(inner.entries.get("a")).toBe("2");
  });

  it("localStorage: prefixes keys, injected failures, and quota errors", async () => {
    const storage = fakeWebStorage();
    const adapter = createLocalStorageAdapter("app:", { storage });
    await roundTrip(adapter);
    expect([...storage.map.keys()]).toEqual(["app:other/key"]);

    const failing = createLocalStorageAdapter("x:", { storage, failure: (op) => op === "set" });
    await expect(failing.set("k", "v")).rejects.toBeInstanceOf(InjectedStorageError);

    const full: WebStorageLike = {
      ...fakeWebStorage(),
      setItem: () => {
        throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
      },
    };
    await expect(createLocalStorageAdapter("", { storage: full }).set("k", "v")).rejects.toThrow("full");
  });

  it("localStorage: unavailable without a backend", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get() {
          throw new Error("SecurityError");
        },
      });
      const adapter = createLocalStorageAdapter("p:");
      expect(adapter.available).toBe(false);
      await expect(adapter.get("k")).rejects.toBeInstanceOf(StorageUnavailableError);
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved);
      else delete (globalThis as any).localStorage;
    }
  });

  it("IndexedDB: round trip through a fake factory", async () => {
    const { factory } = createFakeIndexedDb();
    await roundTrip(createIndexedDbAdapter("test-db", { indexedDB: factory }));
    // A second adapter on the same database sees the data.
    const a = createIndexedDbAdapter("shared", { indexedDB: factory });
    await a.set("k", "v");
    expect(await createIndexedDbAdapter("shared", { indexedDB: factory }).get("k")).toBe("v");
  });

  it("IndexedDB: transaction errors and aborts reject the write", async () => {
    const { factory, controls } = createFakeIndexedDb();
    const adapter = createIndexedDbAdapter("db", { indexedDB: factory });
    await adapter.set("k", "old");
    controls.failTransactions = "error";
    await expect(adapter.set("k", "new")).rejects.toThrow("QuotaExceededError");
    controls.failTransactions = "abort";
    await expect(adapter.set("k", "new")).rejects.toThrow(/aborted/);
    controls.failTransactions = false;
    expect(await adapter.get("k")).toBe("old");
  });

  it("IndexedDB: a failed open is retried on the next call", async () => {
    const { factory, controls } = createFakeIndexedDb();
    const adapter = createIndexedDbAdapter("db", { indexedDB: factory });
    controls.failOpen = true;
    await expect(adapter.get("k")).rejects.toThrow("open blocked");
    controls.failOpen = false;
    await adapter.set("k", "v");
    expect(await adapter.get("k")).toBe("v");
  });

  it("IndexedDB: injected failures and feature detection", async () => {
    const { factory } = createFakeIndexedDb();
    const adapter = createIndexedDbAdapter("db", { indexedDB: factory, failure: (op) => op === "remove" });
    await adapter.set("k", "v");
    await expect(adapter.remove("k")).rejects.toBeInstanceOf(InjectedStorageError);
    if (!isIndexedDbAvailable()) {
      const missing = createIndexedDbAdapter("db");
      expect(missing.available).toBe(false);
      await expect(missing.set("k", "v")).rejects.toBeInstanceOf(StorageUnavailableError);
    }
  });

  it("OPFS: temp file + rename where move is supported", async () => {
    const { root, controls } = createFakeOpfs({ withMove: true });
    const adapter = createOpfsAdapter("recovery", { root });
    await roundTrip(adapter);
    await adapter.set("doc", "v1");
    expect(controls.log.slice(-2)).toEqual(["write doc.tmp", "move doc.tmp -> doc"]);
    expect(controls.files.get("recovery/doc")).toBe("v1");
  });

  it("OPFS: a failed temp write keeps the previous value", async () => {
    const { root, controls } = createFakeOpfs({ withMove: true });
    const adapter = createOpfsAdapter("recovery", { root });
    await adapter.set("doc", "good");
    controls.failWrites = true;
    await expect(adapter.set("doc", "bad")).rejects.toThrow("disk full");
    controls.failWrites = false;
    expect(await adapter.get("doc")).toBe("good");
  });

  it("OPFS: write-then-pointer swap without move", async () => {
    const { root, controls } = createFakeOpfs({ withMove: false });
    const adapter = createOpfsAdapter("recovery", { root });
    await roundTrip(adapter);
    await adapter.set("doc", "v1");
    await adapter.set("doc", "v2");
    expect(controls.files.get("recovery/doc.ptr")).toBe("b");
    expect(controls.files.get("recovery/doc.a")).toBe("v1");
    expect(await adapter.get("doc")).toBe("v2");

    // A crash while writing the next slot leaves the pointer on the old one.
    controls.failWrites = true;
    await expect(adapter.set("doc", "v3")).rejects.toThrow();
    controls.failWrites = false;
    expect(await adapter.get("doc")).toBe("v2");
    await adapter.remove("doc");
    expect([...controls.files.keys()].filter((k) => k.startsWith("recovery/doc"))).toEqual([]);
  });

  it("OPFS: disableRename forces the pointer strategy", async () => {
    const { root, controls } = createFakeOpfs({ withMove: true });
    const adapter = createOpfsAdapter("d", { root, disableRename: true });
    await adapter.set("k", "v");
    expect(controls.files.get("d/k.ptr")).toBe("a");
    expect(await adapter.get("k")).toBe("v");
  });

  it("OPFS: rejects writes without createWritable, and is unavailable without a root", async () => {
    const { root } = createFakeOpfs({ withWritable: false });
    const adapter = createOpfsAdapter("d", { root });
    await expect(adapter.set("k", "v")).rejects.toBeInstanceOf(StorageUnavailableError);
    expect(await adapter.get("k")).toBeNull();
    if (!isOpfsAvailable()) {
      const missing = createOpfsAdapter("d");
      expect(missing.available).toBe(false);
      await expect(missing.get("k")).rejects.toBeInstanceOf(StorageUnavailableError);
    }
  });

  it("OPFS: injected failures", async () => {
    const { root } = createFakeOpfs();
    const adapter = createOpfsAdapter("d", { root, failure: (op) => op === "get" });
    await adapter.set("k", "v");
    await expect(adapter.get("k")).rejects.toBeInstanceOf(InjectedStorageError);
  });
});
