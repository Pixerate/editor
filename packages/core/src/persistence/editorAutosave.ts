import {
  createAutosaveController,
  type AutosaveController,
  type AutosaveControllerOptions,
  type AutosaveRecovery,
} from "./autosave";
import { parseEditorDocument, toEditorDocumentFile, type EditorDocument, type EditorDocumentFile } from "./editorDocument";
import { withEditorAssets } from "./assets";
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
}

export interface EditorAutosave {
  readonly controller: AutosaveController<EditorDocumentFile>;
  readonly revisions: RevisionTracker;
  /** An earlier session's unsaved snapshot of this document, or `null`. */
  checkRecovery(): Promise<AutosaveRecovery<EditorDocumentFile> | null>;
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
  const { dirty, key, ...rest } = options;
  const revisions = createRevisionTracker({ history: doc, dirty });
  const controller = createAutosaveController<EditorDocumentFile>({
    ...rest,
    // Image and paint documents hold asset references: their bytes are saved and read with them.
    storage: doc.assets ? withEditorAssets(rest.storage, doc.assets) : rest.storage,
    key: key ?? doc.kind,
    getSnapshot: () => toEditorDocumentFile(doc),
    deserialize: (text) => parseEditorDocument(text, { kind: doc.kind }),
    revision: revisions.revision,
    savedRevision: revisions.savedRevision,
  });
  const unsubscribe = revisions.subscribe(() => controller.notify());
  return {
    controller,
    revisions,
    checkRecovery: () => controller.checkRecovery(),
    restore(recovery) {
      if (!recovery.snapshot) throw recovery.error ?? new Error("The recovered snapshot could not be read.");
      const report = doc.loadDocument(recovery.snapshot, { history: "reset" });
      controller.ready();
      return report;
    },
    async discard() {
      await controller.discardRecovery();
      controller.ready();
    },
    async markClean() {
      revisions.markSaved();
      await controller.markClean();
    },
    destroy() {
      unsubscribe();
      revisions.destroy();
      controller.destroy();
    },
  };
}
