import {
  EditorDocumentLoadError,
  parseEditorDocument,
  toEditorDocumentFile,
  type EditorDocument,
  type EditorDocumentFile,
} from "./editorDocument";
import type { LoadReport } from "./migrate";
import type { StorageAdapter } from "./storage";

/** One saved document as the index lists it (no document read needed). */
export interface SavedEditorDocument {
  /** Storage key of the document, e.g. `"diagram/release-flow"`; pass it to `open`. */
  key: string;
  kind: string;
  name: string;
  formatVersion: number;
  /** ISO time of the last save. */
  savedAt: string;
}

export interface EditorDocumentStoreOptions {
  storage: StorageAdapter;
  /** Prefix of every key this store writes (default `pixerate.documents`). */
  namespace?: string;
  /** Wall clock for `savedAt` (default `Date.now`). */
  now?: () => number;
}

export interface EditorDocumentStore {
  /**
   * Saves the current document under `name` (one document per kind and name:
   * saving the same name again replaces it).
   */
  save(doc: EditorDocument, name: string): Promise<SavedEditorDocument>;
  /** Saved documents, newest first; only one kind's with `kind`. */
  list(kind?: string): Promise<SavedEditorDocument[]>;
  /** The saved file, or `null` when nothing is stored under `key`. */
  read(key: string): Promise<EditorDocumentFile | null>;
  /**
   * Loads a saved document into `doc` (see `EditorDocument.loadDocument`) and
   * returns its entry with the load report. Throws when `key` is unknown.
   */
  open(doc: EditorDocument, key: string, options?: { history?: "reset" | "record" }): Promise<SavedEditorDocument & { report: LoadReport }>;
  /** Deletes a saved document; `false` when there was none. */
  remove(key: string): Promise<boolean>;
}

/** `"Release flow v2"` → `"release-flow-v2"` (the key part of a saved name). */
export function slugifyDocumentName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

/**
 * Named documents on a key/value `StorageAdapter`, for every editor kind:
 * each file under its own key plus one index entry for listing. Operations
 * run one at a time, so concurrent saves do not lose index entries. The index
 * is cached after the first read: use one store per storage namespace.
 */
export function createEditorDocumentStore(options: EditorDocumentStoreOptions): EditorDocumentStore {
  const { storage } = options;
  const ns = options.namespace ?? "pixerate.documents";
  const now = options.now ?? Date.now;
  const indexKey = `${ns}:index`;
  const fileKey = (key: string) => `${ns}:file:${key}`;
  let index: SavedEditorDocument[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };
  const loadIndex = async (): Promise<SavedEditorDocument[]> => {
    if (index) return index;
    const raw = await storage.get(indexKey);
    let items: SavedEditorDocument[] = [];
    if (raw) {
      try {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.items)) {
          items = data.items.filter((item: any) => item && typeof item.key === "string" && typeof item.kind === "string");
        }
      } catch {
        items = [];
      }
    }
    index = items;
    return index;
  };
  const saveIndex = async (items: SavedEditorDocument[]) => {
    await storage.set(indexKey, JSON.stringify({ version: 1, items }));
    index = items;
  };
  const newestFirst = (a: SavedEditorDocument, b: SavedEditorDocument) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0);
  const readFile = async (key: string) => {
    const raw = await storage.get(fileKey(key));
    return raw === null ? null : parseEditorDocument(raw);
  };

  return {
    save: (doc, name) =>
      run(async () => {
        const trimmed = name.trim() || "Untitled";
        const entry: SavedEditorDocument = {
          key: `${doc.kind}/${slugifyDocumentName(trimmed)}`,
          kind: doc.kind,
          name: trimmed,
          formatVersion: doc.formatVersion,
          savedAt: new Date(now()).toISOString(),
        };
        // File first: a crash between the two writes leaves an unlisted file, never a dangling entry.
        await storage.set(fileKey(entry.key), JSON.stringify(toEditorDocumentFile(doc, trimmed)));
        await saveIndex([...(await loadIndex()).filter((item) => item.key !== entry.key), entry]);
        return entry;
      }),
    list: (kind) => run(async () => (await loadIndex()).filter((item) => !kind || item.kind === kind).sort(newestFirst)),
    read: (key) => run(() => readFile(key)),
    open: (doc, key, openOptions = {}) =>
      run(async () => {
        const entry = (await loadIndex()).find((item) => item.key === key);
        const file = entry ? await readFile(key) : null;
        if (!entry || !file) {
          const keys = (await loadIndex()).filter((item) => item.kind === doc.kind).sort(newestFirst).map((item) => item.key);
          throw new EditorDocumentLoadError(
            `There is no saved document "${key}". ${keys.length ? `Saved ${doc.kind} documents: ${keys.join(", ")}.` : `No ${doc.kind} documents are saved yet.`}`,
          );
        }
        const report = doc.loadDocument(file, { history: openOptions.history ?? "reset" });
        return { ...entry, report };
      }),
    remove: (key) =>
      run(async () => {
        const items = await loadIndex();
        if (!items.some((item) => item.key === key)) return false;
        await saveIndex(items.filter((item) => item.key !== key));
        await storage.remove(fileKey(key));
        return true;
      }),
  };
}
