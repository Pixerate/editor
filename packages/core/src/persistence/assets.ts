import type { StorageAdapter } from "./storage";
import { leaseAssetRefs, watchAssetLeases, withAssetLock } from "./assetWrites";

/** Prefix of an asset reference in a document (`pixerate-asset:<length>-<hash>`). */
export const EDITOR_ASSET_PREFIX = "pixerate-asset:";

const REF = /pixerate-asset:[0-9a-z]+-[0-9a-z]+(?:~[0-9]+)?/g;
const BASE64 = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * Inline binary data kept out of an editor document: PNG data URLs and long base64 strings
 * (layer pixels, masks, thick-paint channels, patterns…) are replaced by short, content-addressed
 * references, and the bytes live here. `put` and `get` are synchronous, so an `EditorDocument`
 * can stay synchronous; `persistEditorAssets` / `preloadEditorAssets` move the bytes to and from
 * storage around a save or an open.
 */
export interface EditorAssetRegistry {
  /** Stores `data` (once per content) and returns its reference. */
  put(data: string): string;
  /** The data for `ref`, or `undefined` when it is not loaded. */
  get(ref: string): string | undefined;
  has(ref: string): boolean;
  /** Puts data read back from storage under its reference. */
  set(ref: string, data: string): void;
  readonly size: number;
  /**
   * Every reference the registry holds. Optional for custom registries, but
   * `collectEditorAssetGarbage({ keep })` needs it to protect a registry's assets.
   */
  refs?(): string[];
}

/** Whether a string is inline binary data worth keeping out of the document. */
export function isInlineAsset(value: string): boolean {
  if (value.startsWith("data:")) return value.length >= 512;
  return value.length >= 4096 && BASE64.test(value);
}

/** cyrb53: a fast, well-mixed 53-bit string hash (content addressing, not security). */
function hash53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function createEditorAssetRegistry(): EditorAssetRegistry {
  const byRef = new Map<string, string>();
  const byData = new Map<string, string>();
  return {
    put(data) {
      const known = byData.get(data);
      if (known) return known;
      const base = `${EDITOR_ASSET_PREFIX}${data.length.toString(36)}-${hash53(data).toString(36)}`;
      let ref = base;
      // Two different contents with the same hash get numbered references.
      for (let n = 1; byRef.has(ref) && byRef.get(ref) !== data; n++) ref = `${base}~${n}`;
      byRef.set(ref, data);
      byData.set(data, ref);
      return ref;
    },
    get: (ref) => byRef.get(ref),
    has: (ref) => byRef.has(ref),
    set(ref, data) {
      byRef.set(ref, data);
      byData.set(data, ref);
    },
    get size() {
      return byRef.size;
    },
    refs: () => [...byRef.keys()],
  };
}

/** A deep copy of `value` with every inline asset string replaced by its reference. */
export function externalizeAssets<T>(value: T, registry: EditorAssetRegistry): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return isInlineAsset(v) ? registry.put(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Every asset reference in a document (or its JSON text). */
export function collectAssetRefs(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return [...new Set(text.match(REF) ?? [])];
}

/**
 * A deep copy of `value` with every asset reference replaced by its data. Throws an error naming the references that are not loaded (and changes nothing).
 */
export function internalizeAssets<T>(value: T, registry: EditorAssetRegistry): T {
  const missing = collectAssetRefs(value).filter((ref) => !registry.has(ref));
  if (missing.length) {
    throw new Error(
      `The document refers to ${missing.length} asset${missing.length === 1 ? "" : "s"} that ${missing.length === 1 ? "is" : "are"} not loaded (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}). Pass a document from get_*_document in this session, or open it from storage so its assets are read first.`,
    );
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.startsWith(EDITOR_ASSET_PREFIX) && registry.has(v) ? registry.get(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

export interface EditorAssetStorageOptions {
  /** Key prefix of stored assets (default `pixerate.assets:`); one shared pool, as assets are content-addressed. */
  prefix?: string;
}

/**
 * Asset keys each storage already holds (written in this session), valid while the storage's
 * collection marker is `marker`: a garbage collection changes the marker, so every session
 * (and every tab) writes its assets again instead of trusting a cache of deleted keys.
 */
const persisted = new WeakMap<StorageAdapter, { marker: string | null | undefined; keys: Set<string> }>();

const assetPrefix = (options: EditorAssetStorageOptions) => options.prefix ?? "pixerate.assets:";
const assetKey = (ref: string, options: EditorAssetStorageOptions) => `${assetPrefix(options)}${ref.slice(EDITOR_ASSET_PREFIX.length)}`;
/** Changed by every collection that deletes something; never matches an asset key. */
const markerKey = (options: EditorAssetStorageOptions) => `${assetPrefix(options)}#collected`;
const ASSET_ID = /^[0-9a-z]+-[0-9a-z]+(?:~[0-9]+)?$/;

/**
 * Writes the assets `document` (or its JSON text) refers to into `storage`, skipping those
 * this storage already has. Call before writing the document, so it never points at missing data.
 */
export async function persistEditorAssets(
  storage: StorageAdapter,
  registry: EditorAssetRegistry,
  document: unknown,
  options: EditorAssetStorageOptions = {},
): Promise<void> {
  const refs = collectAssetRefs(document);
  if (!refs.length) return;
  const cache = persisted.get(storage) ?? { marker: undefined, keys: new Set<string>() };
  persisted.set(storage, cache);
  // `undefined` (unreadable) never matches, so the cache is dropped and assets are written again.
  const marker = await storage.get(markerKey(options)).catch(() => undefined);
  if (marker === undefined || marker !== cache.marker) {
    cache.keys.clear();
    cache.marker = marker;
  }
  const written = cache.keys;
  for (const ref of refs) {
    const key = assetKey(ref, options);
    if (written.has(key)) continue;
    const data = registry.get(ref);
    if (data === undefined) continue;
    await storage.set(key, data);
    written.add(key);
  }
}
/**
 * Reads the assets `document` (or its JSON text) refers to from `storage` into the registry.
 * Returns the references that could not be found.
 */
export async function preloadEditorAssets(
  storage: StorageAdapter,
  registry: EditorAssetRegistry,
  document: unknown,
  options: EditorAssetStorageOptions = {},
): Promise<string[]> {
  const missing: string[] = [];
  for (const ref of collectAssetRefs(document)) {
    if (registry.has(ref)) continue;
    const data = await storage.get(assetKey(ref, options));
    if (data === null) missing.push(ref);
    else registry.set(ref, data);
  }
  return missing;
}

/**
 * `storage` with assets handled: every `set` first writes the assets the value refers to, and
 * every `get` reads them into the registry before returning. Wrap the storage an autosave or a
 * document store uses for an editor whose document has `assets`.
 */
export function withEditorAssets(storage: StorageAdapter, registry: EditorAssetRegistry, options: EditorAssetStorageOptions = {}): StorageAdapter {
  return {
    kind: storage.kind,
    get available() {
      return storage.available;
    },
    async get(key) {
      const value = await storage.get(key);
      if (value !== null && value.includes(EDITOR_ASSET_PREFIX)) await preloadEditorAssets(storage, registry, value, options);
      return value;
    },
    async set(key, value) {
      if (!value.includes(EDITOR_ASSET_PREFIX)) return storage.set(key, value);
      await writeWithAssets(storage, registry, value, options, () => storage.set(key, value));
    },
    remove: (key) => storage.remove(key),
    ...(storage.keys ? { keys: (prefix?: string) => storage.keys!(prefix) } : {}),
  };
}

/**
 * Persists the assets `document` refers to, then runs `write` (which stores the document), with
 * the references protected from a concurrent `collectEditorAssetGarbage` throughout.
 */
async function writeWithAssets(
  storage: StorageAdapter,
  registry: EditorAssetRegistry | undefined,
  document: string,
  options: EditorAssetStorageOptions,
  write: () => Promise<void>,
): Promise<void> {
  const release = leaseAssetRefs(collectAssetRefs(document));
  try {
    await withAssetLock(assetPrefix(options), "shared", async () => {
      if (registry) await persistEditorAssets(storage, registry, document, options);
      await write();
    });
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- garbage collection

export interface EditorAssetGarbageOptions extends EditorAssetStorageOptions {
  /**
   * More assets to keep although no stored value refers to them: asset registries (e.g. an open
   * editor's `doc.assets`), editor documents with `assets`, asset references, or documents /
   * JSON text whose references to keep.
   */
  keep?: ReadonlyArray<unknown>;
  /** Report what would be deleted without deleting anything (default `false`). */
  dryRun?: boolean;
  /**
   * Delete only these references (e.g. from a dry run). Every one must still be unreferenced,
   * or nothing is deleted and the call throws naming them.
   */
  only?: ReadonlyArray<string>;
}

export interface EditorAssetGarbageReport {
  /** Assets found in storage. */
  assets: number;
  /** Stored values read for references (documents, the index, autosave snapshots, anything else). */
  scannedKeys: number;
  /** Assets a stored value refers to. */
  referenced: number;
  /** Unreferenced assets kept because of `keep` or a write in flight. */
  kept: number;
  /** References of the assets nothing refers to (limited by `only`); deleted unless `dryRun`. */
  unreferenced: string[];
  /** Characters of data the unreferenced assets hold. */
  unreferencedChars: number;
  /** References deleted (empty on a dry run). */
  removed: string[];
  /** Characters of data deleted. */
  freedChars: number;
  dryRun: boolean;
}

const isRegistry = (value: unknown): value is EditorAssetRegistry =>
  !!value && typeof value === "object" && ["put", "get", "has", "set"].every((k) => typeof (value as Record<string, unknown>)[k] === "function");

/** Data length encoded in a reference (`pixerate-asset:<length>-<hash>`). */
const refChars = (ref: string) => parseInt(ref.slice(EDITOR_ASSET_PREFIX.length).split("-")[0], 36) || 0;

function keptRefs(keep: ReadonlyArray<unknown>): Set<string> {
  const out = new Set<string>();
  const addRegistry = (registry: EditorAssetRegistry) => {
    if (typeof registry.refs !== "function") {
      throw new Error("A registry passed in keep cannot list its references (it has no refs()). Use createEditorAssetRegistry, or pass the documents to keep instead.");
    }
    for (const ref of registry.refs()) out.add(ref);
  };
  for (const item of keep) {
    if (isRegistry(item)) addRegistry(item);
    else if (item && typeof item === "object" && isRegistry((item as { assets?: unknown }).assets)) addRegistry((item as { assets: EditorAssetRegistry }).assets);
    else for (const ref of collectAssetRefs(item)) out.add(ref);
  }
  return out;
}

/**
 * Deletes the stored assets that nothing refers to. Every other value in `storage` (named
 * documents, the document index, autosave snapshots, anything else) is read and its
 * `pixerate-asset:` references are kept, so pass the whole storage the editors write to (a
 * `withEditorAssets` wrapper works too, but reads assets into its registry). Assets in `keep`,
 * and assets a write in flight in this realm is about to refer to, are never deleted; where the
 * Web Locks API exists, writes in other tabs are waited for too. Needs `storage.keys` (every
 * built-in adapter has it) and throws without it.
 *
 * Run it after removing documents, after an autosave snapshot was retired (`markClean`), or on
 * demand. Deleting an asset that an open editor's registry still holds is safe: the collection
 * invalidates every session's "already written" cache, so its next save writes the asset again.
 */
export async function collectEditorAssetGarbage(storage: StorageAdapter, options: EditorAssetGarbageOptions = {}): Promise<EditorAssetGarbageReport> {
  if (typeof storage.keys !== "function") {
    throw new Error(
      `This ${storage.kind} storage cannot list its keys, so unreferenced assets cannot be found. Give the adapter a keys(prefix) method (every built-in adapter has one).`,
    );
  }
  const listKeys = storage.keys.bind(storage);
  const prefix = assetPrefix(options);
  const keep = keptRefs(options.keep ?? []);
  const dryRun = options.dryRun === true;
  return withAssetLock(prefix, "exclusive", async () => {
    const watch = watchAssetLeases();
    try {
      const assetKeys = (await listKeys(prefix)).filter((key) => ASSET_ID.test(key.slice(prefix.length)));
      const others = (await listKeys("")).filter((key) => !key.startsWith(prefix));
      const live = new Set<string>();
      for (const key of others) {
        const value = await storage.get(key);
        if (value !== null && value.includes(EDITOR_ASSET_PREFIX)) for (const ref of collectAssetRefs(value)) live.add(ref);
      }
      const toRef = (key: string) => `${EDITOR_ASSET_PREFIX}${key.slice(prefix.length)}`;
      let referenced = 0;
      let kept = 0;
      const candidates: string[] = [];
      for (const key of assetKeys) {
        const ref = toRef(key);
        if (live.has(ref)) referenced++;
        else if (keep.has(ref) || watch.touched.has(ref)) kept++;
        else candidates.push(ref);
      }
      let unreferenced = candidates;
      if (options.only) {
        const wanted = new Set(options.only);
        const stale = [...wanted].filter((ref) => !candidates.includes(ref));
        if (stale.length) {
          throw new Error(
            `${stale.length} of the given asset${stale.length === 1 ? " is" : "s are"} not unreferenced in storage now (${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}): unknown, already deleted, referenced or in use. Nothing was deleted; find the unreferenced assets again.`,
          );
        }
        unreferenced = candidates.filter((ref) => wanted.has(ref));
      }
      const report: EditorAssetGarbageReport = {
        assets: assetKeys.length,
        scannedKeys: others.length,
        referenced,
        kept,
        unreferenced,
        unreferencedChars: unreferenced.reduce((n, ref) => n + refChars(ref), 0),
        removed: [],
        freedChars: 0,
        dryRun,
      };
      if (dryRun || !unreferenced.length) return report;
      // Change the marker first: every session's "already written" cache is now stale.
      await storage.set(markerKey(options), `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
      for (const ref of unreferenced) {
        // A write that started meanwhile is about to refer to it.
        if (watch.touched.has(ref)) {
          report.kept++;
          continue;
        }
        try {
          await storage.remove(assetKey(ref, options));
        } catch (error) {
          throw new Error(
            `Deleted ${report.removed.length} of ${unreferenced.length} unreferenced assets, then storage failed: ${error instanceof Error ? error.message : String(error)}. The rest are still stored and nothing refers to the deleted ones; run the collection again.`,
          );
        }
        report.removed.push(ref);
        report.freedChars += refChars(ref);
      }
      return report;
    } finally {
      watch.stop();
    }
  });
}

/**
 * `collectEditorAssetGarbage` for automatic, best-effort runs: resolves `null` instead of
 * throwing when the storage cannot list keys or the collection fails.
 */
export async function tryCollectEditorAssetGarbage(storage: StorageAdapter, options: EditorAssetGarbageOptions = {}): Promise<EditorAssetGarbageReport | null> {
  if (typeof storage.keys !== "function") return null;
  try {
    return await collectEditorAssetGarbage(storage, options);
  } catch {
    return null;
  }
}

/**
 * The collection an editor autosave runs after retiring a snapshot (`markClean`, `discard`):
 * best effort, keeping the assets `doc` uses now, and only for documents with `assets`.
 * `setting` is the autosave's `collectAssetGarbage` option (default on). Pass the unwrapped storage.
 *
 * Not the whole registry: a recovery check reads the old snapshot's assets into it, so keeping
 * it would keep exactly what `discard` throws away. Assets only the registry (e.g. undo) still
 * holds are written again by the next save.
 */
export async function collectRetiredEditorAssets(
  storage: StorageAdapter,
  doc: { assets?: EditorAssetRegistry; getDocument(): unknown },
  setting: boolean | Omit<EditorAssetGarbageOptions, "dryRun" | "only"> = true,
): Promise<EditorAssetGarbageReport | null> {
  if (!doc.assets || setting === false) return null;
  const extra = setting === true ? {} : setting;
  let current: unknown;
  try {
    current = doc.getDocument();
  } catch {
    return null;
  }
  return tryCollectEditorAssetGarbage(storage, { ...extra, keep: [current, ...(extra.keep ?? [])] });
}
