/**
 * The brush library: the built-in presets plus the user's brushes, kept on any `StorageAdapter`
 * (`createMemoryStorage`, `createLocalStorageAdapter`, `createIndexedDbAdapter`,
 * `createOpfsAdapter`) or, without one, in memory. One library shared by every editor makes a
 * brush saved in one show up in all of them.
 *
 * The user's brushes are stored as one `pixerate-brushes` version 2 file under one key. Library
 * files of version 1 (the paint editor's flat brushes) still import: each brush is migrated.
 */

// Type-only: the library works with any adapter from `@pixerate/editor/persistence` without
// bundling the persistence module into this entry.
import type { StorageAdapter } from '../persistence/storage.js';
import type { PaintBrushInput } from '../paint-editor/brushes';
import { BRUSH_ID } from '../paint-editor/brushes';
import { migrateBrushV1 } from './migrate';
import { normalizeBrushSpec } from './normalize';
import { checkBrush, type BrushHostProfile } from './profiles';
import { BRUSH_PRESETS } from './presets';
import type { Brush, BrushKind, BrushMedium, BrushTool } from './types';

/** The JSON file a brush library exports to and imports from. */
export interface BrushLibraryFile {
  format: 'pixerate-brushes';
  version: 2;
  brushes: Brush[];
}

export type BrushLibraryErrorCode = 'unknown_brush' | 'builtin' | 'exists' | 'invalid';

/** A refusal; the message says what to do instead. */
export class BrushLibraryError extends Error {
  constructor(
    readonly code: BrushLibraryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrushLibraryError';
  }
}

export interface BrushLibraryEntry {
  brush: Brush;
  /** A built-in preset: it can be duplicated but not changed or removed. */
  builtin: boolean;
}

export interface BrushFilter {
  kind?: BrushKind;
  medium?: BrushMedium;
  variety?: string;
  tool?: BrushTool;
  /** Has this tag. */
  tag?: string;
  /** Words in the id, name, description, variety or tags (case-insensitive; every word must match). */
  text?: string;
  /** Only built-in presets or only the user's brushes. */
  source?: 'builtin' | 'user';
  /** Only brushes this host can render (`checkBrush` has no errors). */
  profile?: BrushHostProfile;
}

export interface SaveBrushResult {
  /** The brush as stored (normalised). */
  brush: Brush;
  /** What normalising changed. */
  problems: string[];
  /** It replaced a user brush of the same id. */
  replaced: boolean;
}

export interface ImportBrushesResult {
  added: string[];
  replaced: string[];
  skipped: string[];
  problems: string[];
}

export interface BrushLibraryOptions {
  /** Where the user's brushes are kept (default: memory only, gone on reload). */
  storage?: Pick<StorageAdapter, 'get' | 'set'>;
  /** Storage key prefix (default `pixerate.brushes`). */
  namespace?: string;
  /** The built-in presets (default `BRUSH_PRESETS`). */
  presets?: readonly Brush[];
}

export interface BrushLibrary {
  /** Built-in presets first (in library order), then the user's brushes (in the order saved). */
  list(filter?: BrushFilter): Promise<BrushLibraryEntry[]>;
  get(id: string): Promise<BrushLibraryEntry | null>;
  isBuiltin(id: string): boolean;
  /**
   * Stores a user brush (normalised first). Refuses a built-in id and, without `overwrite`, an
   * id already taken.
   */
  save(brush: unknown, options?: { overwrite?: boolean }): Promise<SaveBrushResult>;
  /** Removes a user brush; refuses a built-in one. False when there was no such brush. */
  remove(id: string): Promise<boolean>;
  /** Copies any brush (built-ins included) to a new user brush: `id` default `<id>-copy`, `-copy-2`…; `name` default `<name> copy`. */
  duplicate(id: string, options?: { id?: string; name?: string }): Promise<Brush>;
  /** A library file of the user's brushes, or of the given ids (built-ins included). */
  exportFile(ids?: readonly string[]): Promise<BrushLibraryFile>;
  /** Adds the brushes of a library file (version 1 or 2, or a bare array). Built-in ids are skipped; taken ids too, unless `overwrite`. */
  importFile(raw: unknown, options?: { overwrite?: boolean }): Promise<ImportBrushesResult>;
  /** Called after every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a stored brush is version 1 (the flat `PaintBrush`). */
const isV1 = (item: Record<string, unknown>) => 'engine' in item || 'category' in item || !('kind' in item);

/**
 * Brushes read from a library file: `{ format: 'pixerate-brushes', version: 1 | 2, brushes }` or
 * a bare array. Version 1 brushes are migrated (`migrateBrushV1`); every brush is normalised.
 * Brushes without a valid id or name are skipped, and everything fixed or skipped is reported
 * in `problems`.
 */
export function parseBrushLibrary(raw: unknown, problems: string[] = []): Brush[] {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new BrushLibraryError('invalid', 'Not a brush library: the text is not JSON.');
    }
  }
  const file = isObject(raw) ? raw : null;
  const items = Array.isArray(raw) ? raw : file && Array.isArray(file.brushes) ? file.brushes : null;
  if (!items) throw new BrushLibraryError('invalid', 'Not a brush library: expected {"format":"pixerate-brushes","version":2,"brushes":[...]} or an array of brushes.');
  if (file && file.version !== undefined && file.version !== 1 && file.version !== 2) {
    throw new BrushLibraryError('invalid', `Brush library version ${JSON.stringify(file.version)} is not supported; this library reads versions 1 and 2.`);
  }
  const v1File = file?.version === 1;
  const out: Brush[] = [];
  items.forEach((item, i) => {
    const at = `brushes[${i}]`;
    if (!isObject(item)) return void problems.push(`${at} is not an object; skipped.`);
    if (typeof item.id !== 'string' || !BRUSH_ID.test(item.id)) return void problems.push(`${at} has no valid id (lowercase letters, digits and dashes); skipped.`);
    if (typeof item.name !== 'string' || !item.name.trim()) return void problems.push(`${at} ("${item.id}") has no name; skipped.`);
    const { builtin: _b, ...rest } = item;
    const own: string[] = [];
    try {
      out.push(normalizeBrushSpec(v1File || isV1(rest) ? migrateBrushV1(rest as PaintBrushInput) : rest, own));
    } catch (e) {
      own.push(`${(e as Error).message} Skipped.`);
    }
    problems.push(...own.map((p) => `${at} ("${item.id}"): ${p}`));
  });
  return out;
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function matches(entry: BrushLibraryEntry, f: BrushFilter): boolean {
  const b = entry.brush;
  if (f.source && (f.source === 'builtin') !== entry.builtin) return false;
  if (f.kind && b.kind !== f.kind) return false;
  if (f.medium && b.medium !== f.medium) return false;
  if (f.variety && b.variety !== f.variety) return false;
  if (f.tool && b.tool !== f.tool) return false;
  if (f.tag && !(b.tags ?? []).includes(f.tag)) return false;
  if (f.text) {
    const text = words([b.id, b.name, b.description ?? '', b.variety ?? '', b.medium ?? '', b.tool ?? '', ...(b.tags ?? [])].join(' '));
    if (!words(f.text).every((w) => text.some((t) => t.startsWith(w)))) return false;
  }
  if (f.profile && !checkBrush(b, f.profile).ok) return false;
  return true;
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A brush library over `options.storage` (see the module comment). */
export function createBrushLibrary(options: BrushLibraryOptions = {}): BrushLibrary {
  const presets = (options.presets ?? BRUSH_PRESETS).map(copy);
  const builtinIds = new Set(presets.map((b) => b.id));
  const key = `${options.namespace ?? 'pixerate.brushes'}:user`;
  const listeners = new Set<() => void>();
  let user: Brush[] | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };
  const notify = () => listeners.forEach((listener) => listener());

  const load = async (): Promise<Brush[]> => {
    if (user) return user;
    const raw = options.storage ? await options.storage.get(key) : null;
    let brushes: Brush[] = [];
    if (raw) {
      try {
        brushes = parseBrushLibrary(raw).filter((b) => !builtinIds.has(b.id));
      } catch {
        // An unreadable store starts empty rather than failing every call.
      }
    }
    user = brushes;
    return user;
  };
  const store = async (brushes: Brush[]) => {
    const file: BrushLibraryFile = { format: 'pixerate-brushes', version: 2, brushes };
    if (options.storage) await options.storage.set(key, JSON.stringify(file));
    user = brushes;
  };
  const entries = async (): Promise<BrushLibraryEntry[]> => [...presets.map((brush) => ({ brush, builtin: true })), ...(await load()).map((brush) => ({ brush, builtin: false }))];
  const find = async (id: string): Promise<BrushLibraryEntry> => {
    const entry = (await entries()).find((e) => e.brush.id === id);
    if (!entry) throw new BrushLibraryError('unknown_brush', `No brush "${id}". ${closest(id, (await entries()).map((e) => e.brush.id))}list_brush_presets lists them.`);
    return entry;
  };
  const refuseBuiltin = (id: string, what: string) => {
    if (builtinIds.has(id)) throw new BrushLibraryError('builtin', `"${id}" is a built-in brush and can't be ${what}; duplicate it first (duplicate_brush) and change the copy.`);
  };
  const freeId = async (base: string): Promise<string> => {
    const taken = new Set((await entries()).map((e) => e.brush.id));
    const stem = base.slice(0, 58);
    for (let n = 1; ; n++) {
      const id = n === 1 ? `${stem}-copy` : `${stem}-copy-${n}`;
      if (!taken.has(id)) return id;
    }
  };
  const saveLocked = async (raw: unknown, overwrite: boolean): Promise<SaveBrushResult> => {
    const problems: string[] = [];
    let brush: Brush;
    try {
      brush = normalizeBrushSpec(raw, problems);
    } catch (e) {
      throw new BrushLibraryError('invalid', (e as Error).message);
    }
    refuseBuiltin(brush.id, 'overwritten');
    const brushes = await load();
    const at = brushes.findIndex((b) => b.id === brush.id);
    if (at !== -1 && !overwrite) throw new BrushLibraryError('exists', `A brush "${brush.id}" exists already; pick another id, or update it (update_brush).`);
    await store(at === -1 ? [...brushes, brush] : brushes.map((b, i) => (i === at ? brush : b)));
    return { brush: copy(brush), problems, replaced: at !== -1 };
  };

  return {
    list: (filter = {}) => run(async () => (await entries()).filter((e) => matches(e, filter)).map(copy)),
    get: (id) =>
      run(async () => {
        const entry = (await entries()).find((e) => e.brush.id === id);
        return entry ? copy(entry) : null;
      }),
    isBuiltin: (id) => builtinIds.has(id),
    save: (brush, o = {}) =>
      run(async () => {
        const result = await saveLocked(brush, !!o.overwrite);
        notify();
        return result;
      }),
    remove: (id) =>
      run(async () => {
        refuseBuiltin(id, 'removed');
        const brushes = await load();
        if (!brushes.some((b) => b.id === id)) return false;
        await store(brushes.filter((b) => b.id !== id));
        notify();
        return true;
      }),
    duplicate: (id, o = {}) =>
      run(async () => {
        const { brush } = await find(id);
        const newId = o.id ?? (await freeId(id));
        const { brush: saved } = await saveLocked({ ...copy(brush), id: newId, name: o.name ?? `${brush.name} copy`.slice(0, 80) }, false);
        notify();
        return saved;
      }),
    exportFile: (ids) =>
      run(async () => {
        const brushes = ids ? await Promise.all(ids.map(async (id) => (await find(id)).brush)) : await load();
        return { format: 'pixerate-brushes' as const, version: 2 as const, brushes: brushes.map(copy) };
      }),
    importFile: (raw, o = {}) =>
      run(async () => {
        const problems: string[] = [];
        const incoming = parseBrushLibrary(raw, problems);
        const result: ImportBrushesResult = { added: [], replaced: [], skipped: [], problems };
        let brushes = [...(await load())];
        for (const brush of incoming) {
          if (builtinIds.has(brush.id)) {
            result.skipped.push(brush.id);
            problems.push(`"${brush.id}" is a built-in brush id; skipped (rename it to import it).`);
            continue;
          }
          const at = brushes.findIndex((b) => b.id === brush.id);
          if (at === -1) {
            brushes.push(brush);
            result.added.push(brush.id);
          } else if (o.overwrite) {
            brushes = brushes.map((b, i) => (i === at ? brush : b));
            result.replaced.push(brush.id);
          } else {
            result.skipped.push(brush.id);
            problems.push(`"${brush.id}" exists already; skipped (pass overwrite to replace it).`);
          }
        }
        if (result.added.length || result.replaced.length) {
          await store(brushes);
          notify();
        }
        return result;
      }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** "Closest: a, b. " for an unknown id (shared prefix or substring), or "" when nothing is near. */
export function closest(id: string, ids: readonly string[], max = 3): string {
  const stem = id.toLowerCase();
  const score = (c: string) => {
    let n = 0;
    while (n < Math.min(c.length, stem.length) && c[n] === stem[n]) n++;
    return n + (c.includes(stem) || stem.includes(c) ? 4 : 0) + words(c).filter((w) => words(stem).includes(w)).length * 3;
  };
  const near = ids
    .map((c) => [c, score(c)] as const)
    .filter(([, s]) => s >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([c]) => c);
  return near.length ? `Closest: ${near.join(', ')}. ` : '';
}

/** A synchronous copy of a library's brushes, for hosts whose reads are synchronous (renderers, controllers). */
export interface BrushLibrarySnapshot {
  /** The brushes as last read: built-in presets, then saved brushes (empty until the first read). */
  readonly entries: readonly BrushLibraryEntry[];
  /** The saved brushes as last read. */
  readonly user: readonly Brush[];
  /** Resolves once the library has been read (again, after `refresh`). */
  readonly ready: Promise<void>;
  refresh(): Promise<void>;
  /** Stops following the library. */
  dispose(): void;
}

/**
 * Follows `library`: reads it now and after every change, keeping the result for synchronous
 * reads, and calls `onChange` after each read.
 */
export function snapshotBrushLibrary(library: Pick<BrushLibrary, 'list' | 'subscribe'>, onChange?: () => void): BrushLibrarySnapshot {
  let entries: readonly BrushLibraryEntry[] = [];
  let user: readonly Brush[] = [];
  const refresh = () =>
    library.list().then(
      (list) => {
        entries = list;
        user = list.filter((e) => !e.builtin).map((e) => e.brush);
        onChange?.();
      },
      () => undefined,
    );
  let ready = refresh();
  const unsubscribe = library.subscribe(() => {
    ready = refresh();
  });
  return {
    get entries() {
      return entries;
    },
    get user() {
      return user;
    },
    get ready() {
      return ready;
    },
    refresh: () => (ready = refresh()),
    dispose: unsubscribe,
  };
}
