import {
  collectRetiredEditorAssets,
  parseEditorDocument,
  toEditorDocumentFile,
  withEditorAssets,
  type EditorAssetGarbageOptions,
  type EditorDocument,
  type EditorDocumentFile,
  type LoadReport,
} from "@pixerate/editor/persistence";
import { createAutosave, type CreateAutosaveOptions, type SvelteAutosave } from "./autosave.svelte.js";

export interface CreateEditorAutosaveOptions
  extends Omit<CreateAutosaveOptions<EditorDocumentFile>, "key" | "getSnapshot" | "serialize" | "deserialize" | "history"> {
  /** Snapshot key (default the document's `kind`). */
  key?: string;
  /**
   * For documents with `assets`: after `markClean` or `discard` retire a snapshot, delete the
   * stored assets nothing refers to any more (`collectEditorAssetGarbage`, best effort, keeping
   * the assets the document uses now; default `true`). Needs `storage.keys`; `false` turns it off.
   */
  collectAssetGarbage?: boolean | Omit<EditorAssetGarbageOptions, "dryRun" | "only">;
}

export interface SvelteEditorAutosave extends Omit<SvelteAutosave<EditorDocumentFile>, "restore"> {
  /** Loads the recovered snapshot into the document and starts autosaving. */
  restore(): LoadReport | undefined;
}

/**
 * `createAutosave` for any editor's `EditorDocument` (e.g.
 * `createMermaidDiagram(...).editorDocument`): snapshots it as an
 * `EditorDocumentFile` after each change, and `restore` loads a recovered
 * snapshot straight into the editor. Status and recovery stay reactive.
 */
export function createEditorAutosave(doc: EditorDocument, { collectAssetGarbage, ...options }: CreateEditorAutosaveOptions): SvelteEditorAutosave {
  // Retiring a snapshot can leave assets nothing refers to any more.
  const collect = () => collectRetiredEditorAssets(options.storage, doc, collectAssetGarbage);
  const autosave = createAutosave<EditorDocumentFile>({
    ...options,
    // Image and paint documents hold asset references: their bytes are saved and read with them.
    storage: doc.assets ? withEditorAssets(options.storage, doc.assets) : options.storage,
    key: options.key ?? doc.kind,
    getSnapshot: () => toEditorDocumentFile(doc),
    deserialize: (text) => parseEditorDocument(text, { kind: doc.kind }),
    history: doc,
  });
  return {
    get status() {
      return autosave.status;
    },
    get recovery() {
      return autosave.recovery;
    },
    get pendingRecovery() {
      return autosave.pendingRecovery;
    },
    restore() {
      const snapshot = autosave.restore();
      return snapshot ? doc.loadDocument(snapshot, { history: "reset" }) : undefined;
    },
    async discard() {
      await autosave.discard();
      await collect();
    },
    ready: () => autosave.ready(),
    flushNow: () => autosave.flushNow(),
    async markClean() {
      await autosave.markClean();
      await collect();
    },
    notifyChange: () => autosave.notifyChange(),
    checked: autosave.checked,
    controller: autosave.controller,
    destroy: () => autosave.destroy(),
  };
}
