import type { StorageAdapter } from "./storage";

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

/** Asset keys each storage already holds (written in this session). */
const persisted = new WeakMap<StorageAdapter, Set<string>>();

const assetKey = (ref: string, options: EditorAssetStorageOptions) => `${options.prefix ?? "pixerate.assets:"}${ref.slice(EDITOR_ASSET_PREFIX.length)}`;

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
  const written = persisted.get(storage) ?? new Set<string>();
  persisted.set(storage, written);
  for (const ref of collectAssetRefs(document)) {
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
      if (value.includes(EDITOR_ASSET_PREFIX)) await persistEditorAssets(storage, registry, value, options);
      await storage.set(key, value);
    },
    remove: (key) => storage.remove(key),
  };
}
