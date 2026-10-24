import {
  parseEditorDocument,
  toEditorDocumentFile,
  type EditorDocument,
  type EditorDocumentFile,
  type LoadReport,
} from "@pixerate/editor/persistence";
import { createAutosave, type CreateAutosaveOptions, type SvelteAutosave } from "./autosave.svelte.js";

export interface CreateEditorAutosaveOptions
  extends Omit<CreateAutosaveOptions<EditorDocumentFile>, "key" | "getSnapshot" | "serialize" | "deserialize" | "history"> {
  /** Snapshot key (default the document's `kind`). */
  key?: string;
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
export function createEditorAutosave(doc: EditorDocument, options: CreateEditorAutosaveOptions): SvelteEditorAutosave {
  const autosave = createAutosave<EditorDocumentFile>({
    ...options,
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
    discard: () => autosave.discard(),
    ready: () => autosave.ready(),
    flushNow: () => autosave.flushNow(),
    markClean: () => autosave.markClean(),
    notifyChange: () => autosave.notifyChange(),
    checked: autosave.checked,
    controller: autosave.controller,
    destroy: () => autosave.destroy(),
  };
}
