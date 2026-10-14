/**
 * Minimal in-memory fakes of IndexedDB and the Origin Private File System, just
 * enough for the persistence adapters. Callbacks fire asynchronously, as in browsers.
 */

const later = (fn: () => void) => queueMicrotask(fn);

export interface FakeIdbControls {
  /** Make the next transactions fail (`"error"`) or abort. */
  failTransactions: false | "error" | "abort";
  failOpen: boolean;
  data: Map<string, Map<string, unknown>>;
}

export function createFakeIndexedDb(): { factory: { open(name: string, version?: number): any }; controls: FakeIdbControls } {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  const controls: FakeIdbControls = { failTransactions: false, failOpen: false, data: new Map() };

  const request = (run: () => unknown, tx?: any) => {
    const req: any = { onsuccess: null, onerror: null, result: undefined, error: null };
    later(() => {
      try {
        req.result = run();
        req.onsuccess?.();
      } catch (error) {
        req.error = error;
        req.onerror?.();
      }
      tx?.done();
    });
    return req;
  };

  const factory = {
    open(name: string) {
      const req: any = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined };
      later(() => {
        if (controls.failOpen) {
          req.error = new Error("open blocked");
          req.onerror?.();
          return;
        }
        let stores = databases.get(name);
        const isNew = !stores;
        if (!stores) {
          stores = new Map();
          databases.set(name, stores);
        }
        const db = {
          objectStoreNames: { contains: (s: string) => stores!.has(s) },
          createObjectStore: (s: string) => {
            stores!.set(s, new Map());
            controls.data = stores!.get(s)!;
          },
          transaction(storeName: string) {
            const store = stores!.get(storeName);
            if (!store) throw new Error(`no store ${storeName}`);
            controls.data = store;
            const tx: any = { oncomplete: null, onerror: null, onabort: null, error: null, pending: 0 };
            const failMode = controls.failTransactions;
            tx.done = () => {
              tx.pending--;
              if (tx.pending > 0) return;
              later(() => {
                if (failMode === "error") {
                  tx.error = new Error("QuotaExceededError");
                  tx.onerror?.();
                } else if (failMode === "abort") {
                  tx.onabort?.();
                } else {
                  tx.oncomplete?.();
                }
              });
            };
            tx.objectStore = () => ({
              get: (key: string) => {
                tx.pending++;
                return request(() => store.get(key), tx);
              },
              put: (value: unknown, key: string) => {
                tx.pending++;
                return request(() => {
                  if (!failMode) store.set(key, value);
                }, tx);
              },
              delete: (key: string) => {
                tx.pending++;
                return request(() => {
                  if (!failMode) store.delete(key);
                }, tx);
              },
            });
            return tx;
          },
        };
        req.result = db;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory, controls };
}

class NotFoundError extends Error {
  name = "NotFoundError";
}

export interface FakeOpfsControls {
  files: Map<string, string>;
  /** Fail `close()` of writables (simulates a crash mid-write: nothing is committed). */
  failWrites: boolean;
  /** Log of operations. */
  log: string[];
}

/**
 * Fake OPFS root. `withMove` decides whether file handles support `move`
 * (rename) and `withWritable` whether they support `createWritable`.
 */
export function createFakeOpfs(options: { withMove?: boolean; withWritable?: boolean } = {}) {
  const { withMove = true, withWritable = true } = options;
  const controls: FakeOpfsControls = { files: new Map(), failWrites: false, log: [] };

  const dirHandle = (path: string): any => ({
    async getDirectoryHandle(name: string) {
      return dirHandle(`${path}${name}/`);
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const full = path + name;
      if (!controls.files.has(full)) {
        if (!opts?.create) throw new NotFoundError(full);
        controls.files.set(full, "");
      }
      const handle: any = {
        async getFile() {
          const text = controls.files.get(full);
          if (text === undefined) throw new NotFoundError(full);
          return { text: async () => text };
        },
      };
      if (withWritable) {
        handle.createWritable = async () => {
          let buffer = "";
          return {
            async write(data: string) {
              buffer += data;
            },
            async close() {
              if (controls.failWrites) throw new Error("disk full");
              controls.files.set(full, buffer);
              controls.log.push(`write ${name}`);
            },
          };
        };
      }
      if (withMove) {
        handle.move = async (target: string) => {
          const text = controls.files.get(full);
          controls.files.delete(full);
          controls.files.set(path + target, text ?? "");
          controls.log.push(`move ${name} -> ${target}`);
        };
      }
      return handle;
    },
    async removeEntry(name: string) {
      const full = path + name;
      if (!controls.files.has(full)) throw new NotFoundError(full);
      controls.files.delete(full);
    },
  });

  return { root: async () => dirHandle(""), controls };
}
