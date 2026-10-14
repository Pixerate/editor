/**
 * Key/value storage adapters for autosave and crash recovery. Every adapter is
 * async, stores strings, feature-detects its backend (an unavailable backend
 * rejects every call with `StorageUnavailableError` instead of throwing at
 * construction, so SSR and old browsers are safe) and accepts an injectable
 * failure mode for tests.
 */

export type StorageOperation = "get" | "set" | "remove";

/**
 * Injected failure: return `true` (or an `Error`) to make that operation fail.
 * Example: `failure: (op) => op === "set"` simulates a full disk.
 */
export type StorageFailureMode = (
  operation: StorageOperation,
  key: string,
) => boolean | Error | undefined | void;

export interface StorageAdapter {
  /** Short backend name, e.g. `"memory"`, `"localStorage"`, `"indexedDB"`, `"opfs"`. */
  readonly kind: string;
  /** Whether the backend was found. When `false`, every call rejects. */
  readonly available: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface StorageAdapterOptions {
  failure?: StorageFailureMode;
}

export class StorageUnavailableError extends Error {
  constructor(kind: string) {
    super(`${kind} storage is not available in this environment`);
    this.name = "StorageUnavailableError";
  }
}

export class InjectedStorageError extends Error {
  constructor(operation: StorageOperation, key: string) {
    super(`injected ${operation} failure for "${key}"`);
    this.name = "InjectedStorageError";
  }
}

function checkFailure(
  failure: StorageFailureMode | undefined,
  operation: StorageOperation,
  key: string,
): void {
  if (!failure) return;
  const result = failure(operation, key);
  if (result instanceof Error) throw result;
  if (result) throw new InjectedStorageError(operation, key);
}

/** Wraps an adapter so `failure` can make any of its operations fail. */
export function withStorageFailures(
  inner: StorageAdapter,
  failure: StorageFailureMode,
): StorageAdapter {
  return {
    kind: inner.kind,
    get available() {
      return inner.available;
    },
    async get(key) {
      checkFailure(failure, "get", key);
      return inner.get(key);
    },
    async set(key, value) {
      checkFailure(failure, "set", key);
      return inner.set(key, value);
    },
    async remove(key) {
      checkFailure(failure, "remove", key);
      return inner.remove(key);
    },
  };
}

function guarded(
  kind: string,
  isAvailable: () => boolean,
  failure: StorageFailureMode | undefined,
  impl: Omit<StorageAdapter, "kind" | "available">,
): StorageAdapter {
  const check = (operation: StorageOperation, key: string) => {
    if (!isAvailable()) throw new StorageUnavailableError(kind);
    checkFailure(failure, operation, key);
  };
  return {
    kind,
    get available() {
      return isAvailable();
    },
    async get(key) {
      check("get", key);
      return impl.get(key);
    },
    async set(key, value) {
      check("set", key);
      return impl.set(key, value);
    },
    async remove(key) {
      check("remove", key);
      return impl.remove(key);
    },
  };
}

// ---------------------------------------------------------------- memory

export interface MemoryStorage extends StorageAdapter {
  /** The underlying map (inspect it in tests). */
  readonly entries: Map<string, string>;
}

/** In-memory storage (tests, SSR, or a session-only fallback). */
export function createMemoryStorage(
  options: StorageAdapterOptions & { initial?: Record<string, string> } = {},
): MemoryStorage {
  const entries = new Map<string, string>(Object.entries(options.initial ?? {}));
  const adapter = guarded("memory", () => true, options.failure, {
    async get(key) {
      return entries.has(key) ? (entries.get(key) as string) : null;
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async remove(key) {
      entries.delete(key);
    },
  });
  return Object.assign(adapter, { entries });
}

// ---------------------------------------------------------------- localStorage

/** Minimal `Storage` surface used by the localStorage adapter. */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalStorageAdapterOptions extends StorageAdapterOptions {
  /** Storage to use (default `globalThis.localStorage`, e.g. pass `sessionStorage`). */
  storage?: WebStorageLike;
}

function detectLocalStorage(): WebStorageLike | undefined {
  try {
    const storage = (globalThis as { localStorage?: WebStorageLike }).localStorage;
    return storage && typeof storage.getItem === "function" ? storage : undefined;
  } catch {
    // Accessing localStorage throws when site data is blocked.
    return undefined;
  }
}

/** Whether `localStorage` can be used (it throws when site data is blocked). */
export function isLocalStorageAvailable(): boolean {
  return detectLocalStorage() !== undefined;
}

/**
 * `localStorage` adapter; every key is prefixed with `prefix`. Writes are
 * synchronous under the hood, so they complete even inside `pagehide`.
 * A full quota rejects the `set` (`QuotaExceededError`).
 */
export function createLocalStorageAdapter(
  prefix = "",
  options: LocalStorageAdapterOptions = {},
): StorageAdapter {
  const storage = options.storage ?? detectLocalStorage();
  return guarded("localStorage", () => storage !== undefined, options.failure, {
    async get(key) {
      return storage!.getItem(prefix + key);
    },
    async set(key, value) {
      storage!.setItem(prefix + key, value);
    },
    async remove(key) {
      storage!.removeItem(prefix + key);
    },
  });
}

// ---------------------------------------------------------------- IndexedDB

/** Minimal `IDBFactory` surface (the real `indexedDB`, or a fake in tests). */
export interface IdbFactoryLike {
  open(name: string, version?: number): any;
}

export interface IndexedDbAdapterOptions extends StorageAdapterOptions {
  /** Object store name (default `"kv"`). */
  store?: string;
  /** Factory to use (default `globalThis.indexedDB`). */
  indexedDB?: IdbFactoryLike;
}

function detectIndexedDb(): IdbFactoryLike | undefined {
  try {
    const factory = (globalThis as { indexedDB?: IdbFactoryLike }).indexedDB;
    return factory && typeof factory.open === "function" ? factory : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `indexedDB` exists in this environment. */
export function isIndexedDbAvailable(): boolean {
  return detectIndexedDb() !== undefined;
}

const requestToPromise = <T>(request: any): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });

/**
 * IndexedDB adapter: one database `name` with a single key/value object store.
 * A `set` resolves when its transaction completes (not merely when the request
 * succeeds), so a resolved write is durable.
 */
export function createIndexedDbAdapter(
  name = "pixerate-editor",
  options: IndexedDbAdapterOptions = {},
): StorageAdapter {
  const factory = options.indexedDB ?? detectIndexedDb();
  const storeName = options.store ?? "kv";
  let dbPromise: Promise<any> | null = null;

  const open = (): Promise<any> => {
    dbPromise ??= new Promise((resolve, reject) => {
      const request = factory!.open(name, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error("IndexedDB open failed"));
      };
    });
    return dbPromise;
  };

  const write = async (fn: (store: any) => void): Promise<void> => {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      fn(tx.objectStore(storeName));
    });
  };

  return guarded("indexedDB", () => factory !== undefined, options.failure, {
    async get(key) {
      const db = await open();
      const tx = db.transaction(storeName, "readonly");
      const value = await requestToPromise<unknown>(tx.objectStore(storeName).get(key));
      return typeof value === "string" ? value : null;
    },
    set: (key, value) => write((store) => store.put(value, key)),
    remove: (key) => write((store) => store.delete(key)),
  });
}

// ---------------------------------------------------------------- OPFS

/** Minimal `FileSystemDirectoryHandle` surface used by the OPFS adapter. */
export interface OpfsDirectoryLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileLike>;
  removeEntry(name: string): Promise<void>;
}

export interface OpfsFileLike {
  getFile(): Promise<{ text(): Promise<string> }>;
  createWritable?(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  /** Rename in place (Chromium, Safari). Used for temp-file + rename writes. */
  move?(name: string): Promise<void>;
}

export interface OpfsAdapterOptions extends StorageAdapterOptions {
  /** Root directory (default `navigator.storage.getDirectory()`). */
  root?: () => Promise<OpfsDirectoryLike>;
  /** Force the write-then-pointer-swap strategy even when `move` exists. */
  disableRename?: boolean;
}

function detectOpfsRoot(): (() => Promise<OpfsDirectoryLike>) | undefined {
  try {
    const storage = (globalThis as any).navigator?.storage;
    if (storage && typeof storage.getDirectory === "function") {
      return () => storage.getDirectory();
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Whether the Origin Private File System exists (`navigator.storage.getDirectory`). */
export function isOpfsAvailable(): boolean {
  return detectOpfsRoot() !== undefined;
}

const isNotFound = (error: unknown) =>
  !!error && typeof error === "object" && (error as { name?: string }).name === "NotFoundError";

/**
 * Origin Private File System adapter. Values are files in `dir` (created on
 * demand), named after the URI-encoded key.
 *
 * Writes never leave a half-written value behind: where file handles support
 * `move`, the value is written to `<file>.tmp` and renamed over `<file>`;
 * otherwise it alternates between two slots (`<file>.a` / `<file>.b`) and then
 * swaps a pointer file (`<file>.ptr`), so a crash mid-write keeps the previous
 * value. Main-thread writes need `createWritable` (missing in some Safari
 * versions); without it, `set` rejects with `StorageUnavailableError`.
 */
export function createOpfsAdapter(
  dir = "pixerate-editor",
  options: OpfsAdapterOptions = {},
): StorageAdapter {
  const getRoot = options.root ?? detectOpfsRoot();
  let dirPromise: Promise<OpfsDirectoryLike> | null = null;
  const directory = () => {
    dirPromise ??= getRoot!().then((root) => root.getDirectoryHandle(dir, { create: true }));
    dirPromise.catch(() => {
      dirPromise = null;
    });
    return dirPromise;
  };
  const fileName = (key: string) => encodeURIComponent(key) || "_";

  const readFile = async (d: OpfsDirectoryLike, name: string): Promise<string | null> => {
    try {
      const handle = await d.getFileHandle(name);
      return await (await handle.getFile()).text();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const writeFile = async (d: OpfsDirectoryLike, name: string, value: string) => {
    const handle = await d.getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== "function") {
      throw new StorageUnavailableError("opfs (createWritable)");
    }
    const writable = await handle.createWritable();
    await writable.write(value);
    await writable.close();
    return handle;
  };

  const removeFile = async (d: OpfsDirectoryLike, name: string) => {
    try {
      await d.removeEntry(name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  };

  return guarded("opfs", () => getRoot !== undefined, options.failure, {
    async get(key) {
      const d = await directory();
      const base = fileName(key);
      const pointer = await readFile(d, `${base}.ptr`);
      if (pointer === "a" || pointer === "b") return readFile(d, `${base}.${pointer}`);
      return readFile(d, base);
    },
    async set(key, value) {
      const d = await directory();
      const base = fileName(key);
      const pointer = await readFile(d, `${base}.ptr`);
      if (!options.disableRename && pointer === null) {
        const tmp = await writeFile(d, `${base}.tmp`, value);
        if (typeof tmp.move === "function") {
          await tmp.move(base);
          return;
        }
        await removeFile(d, `${base}.tmp`);
      }
      // Write-then-pointer swap: the pointer only moves once the new slot is complete.
      const next = pointer === "a" ? "b" : "a";
      await writeFile(d, `${base}.${next}`, value);
      await writeFile(d, `${base}.ptr`, next);
    },
    async remove(key) {
      const d = await directory();
      const base = fileName(key);
      for (const name of [`${base}.ptr`, base, `${base}.a`, `${base}.b`, `${base}.tmp`]) {
        await removeFile(d, name);
      }
    },
  });
}
