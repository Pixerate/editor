import {
  createAutosaveController,
  type AutosaveController,
  type AutosaveControllerOptions,
  type AutosaveRecovery,
} from "./autosave";
import { parseEditorDocument, toEditorDocumentFile, type EditorDocument, type EditorDocumentFile } from "./editorDocument";
import { collectRetiredEditorAssets, withEditorAssets, type EditorAssetGarbageOptions } from "./assets";
import type { LoadReport } from "./migrate";
import { createRevisionTracker, type DirtyFlagSource, type RevisionTracker } from "./revisions";

export interface EditorAutosaveOptions
  extends Omit<AutosaveControllerOptions<EditorDocumentFile>, "getSnapshot" | "serialize" | "deserialize" | "revision" | "savedRevision" | "key"> {
  /** Snapshot key (default the document's `kind`). */
  key?: string;
  /**
   * Saved-vs-current flag (e.g. `bindDirtyToHistory`), so undoing back to the
   * saved state needs no snapshot. Without it, every change counts until `markClean()`.
   */
  dirty?: DirtyFlagSource;
  /**
   * Optional monotonic server/host version of the document that is currently loaded.
   * Stored alongside crash-recovery snapshots so `checkRecovery` / `recoverIfNewer`
   * automatically retires stale snapshots from an older server version instead of
   * overwriting newer server state.
   */
  baseVersion?: number | (() => number | undefined);
  /**
   * For documents with `assets`: after `markClean` or `discard` retire a snapshot, delete the
   * stored assets nothing refers to any more (`collectEditorAssetGarbage`, best effort, keeping
   * the assets the document uses now; default `true`). Needs `storage.keys`; `false` turns it off.
   */
  collectAssetGarbage?: boolean | Omit<EditorAssetGarbageOptions, "dryRun" | "only">;
}

export interface EditorAutosave {
  readonly controller: AutosaveController<EditorDocumentFile>;
  readonly revisions: RevisionTracker;
  /** An earlier session's unsaved snapshot of this document, or `null` (stale snapshots older than `baseVersion` are retired automatically). */
  checkRecovery(): Promise<AutosaveRecovery<EditorDocumentFile> | null>;
  /**
   * Checks for an earlier session's unsaved snapshot, restoring it into `doc` if it is valid and
   * at least as new as `baseVersion`, or retiring it and starting autosave cleanly if stale/invalid.
   */
  recoverIfNewer(minimumBaseVersion?: number): Promise<LoadReport | null>;
  /** Loads a recovered snapshot into the document and starts autosaving. */
  restore(recovery: AutosaveRecovery<EditorDocumentFile>): LoadReport;
  /** Deletes the earlier session's snapshot and starts autosaving. */
  discard(): Promise<void>;
  /** Call after an explicit save. */
  markClean(): Promise<void>;
  destroy(): void;
}

/**
 * Crash-recovery autosave for any editor: snapshots `doc` as an
 * `EditorDocumentFile` after each change. Like `createAutosaveController`,
 * nothing is written until the recovery check is settled: call
 * `controller.ready()` when nothing was found, or `restore` / `discard`.
 */
export function createEditorAutosave(doc: EditorDocument, options: EditorAutosaveOptions): EditorAutosave {
  const { dirty, key, baseVersion, collectAssetGarbage, ...rest } = options;
  const resolvedKey = key ?? doc.kind;
  const baseVersionKey = `${resolvedKey}:base-version`;
  const readBaseVersion = (): number | undefined =>
    typeof baseVersion === "function" ? baseVersion() : baseVersion;

  const baseStorage = doc.assets ? withEditorAssets(rest.storage, doc.assets) : rest.storage;
  const storage =
    baseVersion === undefined
      ? baseStorage
      : {
          ...baseStorage,
          async set(k: string, value: string) {
            await baseStorage.set(k, value);
            if (k === resolvedKey) {
              const v = readBaseVersion();
              if (typeof v === "number" && Number.isFinite(v)) {
                await rest.storage.set(baseVersionKey, JSON.stringify({ baseVersion: v }));
              }
            }
          },
          async remove(k: string) {
            await baseStorage.remove(k);
            if (k === resolvedKey) {
              await rest.storage.remove(baseVersionKey);
            }
          },
        };

  const collect = () => collectRetiredEditorAssets(rest.storage, doc, collectAssetGarbage);
  const revisions = createRevisionTracker({ history: doc, dirty });
  const controller = createAutosaveController<EditorDocumentFile>({
    ...rest,
    // Image and paint documents hold asset references: their bytes are saved and read with them.
    storage,
    key: resolvedKey,
    getSnapshot: () => toEditorDocumentFile(doc),
    deserialize: (text) => parseEditorDocument(text, { kind: doc.kind }),
    revision: revisions.revision,
    savedRevision: revisions.savedRevision,
  });
  const unsubscribe = revisions.subscribe(() => controller.notify());

  const isStaleRecovery = async (minimumVersion?: number): Promise<boolean> => {
    const requiredVersion = minimumVersion ?? readBaseVersion();
    if (requiredVersion === undefined) return false;
    try {
      const raw = await rest.storage.get(baseVersionKey);
      if (!raw) return requiredVersion > 0;
      const parsed = JSON.parse(raw) as { baseVersion?: unknown };
      if (typeof parsed?.baseVersion !== "number") return requiredVersion > 0;
      return parsed.baseVersion < requiredVersion;
    } catch {
      return requiredVersion > 0;
    }
  };

  const retireRecovery = async () => {
    await controller.discardRecovery();
    await rest.storage.remove(baseVersionKey);
    controller.ready();
    await collect();
  };

  return {
    controller,
    revisions,
    async checkRecovery() {
      const recovery = await controller.checkRecovery();
      if (!recovery) return null;
      if (await isStaleRecovery()) {
        await retireRecovery();
        return null;
      }
      return recovery;
    },
    async recoverIfNewer(minimumBaseVersion) {
      const recovery = await controller.checkRecovery();
      if (!recovery) {
        controller.ready();
        return null;
      }
      if (!recovery.snapshot || (await isStaleRecovery(minimumBaseVersion))) {
        await retireRecovery();
        return null;
      }
      try {
        const report = doc.loadDocument(recovery.snapshot, { history: "reset" });
        controller.ready();
        return report;
      } catch {
        await retireRecovery();
        return null;
      }
    },
    restore(recovery) {
      if (!recovery.snapshot) throw recovery.error ?? new Error("The recovered snapshot could not be read.");
      const report = doc.loadDocument(recovery.snapshot, { history: "reset" });
      controller.ready();
      return report;
    },
    async discard() {
      await retireRecovery();
    },
    async markClean() {
      revisions.markSaved();
      await controller.markClean();
      if (baseVersion !== undefined) {
        await rest.storage.remove(baseVersionKey);
      }
      await collect();
    },
    destroy() {
      unsubscribe();
      revisions.destroy();
      controller.destroy();
    },
  };
}
