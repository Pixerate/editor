import { useCallback } from 'react';
import {
  parseEditorDocument,
  toEditorDocumentFile,
  type EditorDocument,
  type EditorDocumentFile,
  type LoadReport,
} from '@pixerate/editor/persistence';
import { useAutosave, type UseAutosaveOptions, type UseAutosaveResult } from './useAutosave';

export interface UseEditorAutosaveOptions
  extends Omit<UseAutosaveOptions<EditorDocumentFile>, 'key' | 'getSnapshot' | 'serialize' | 'deserialize' | 'history'> {
  /** Snapshot key (default the document's `kind`). */
  key?: string;
}

export interface UseEditorAutosaveResult extends Omit<UseAutosaveResult<EditorDocumentFile>, 'restore'> {
  /** Loads the recovered snapshot into the document and starts autosaving. */
  restore: () => LoadReport | undefined;
}

/**
 * `useAutosave` for any editor's `EditorDocument` (e.g. `useMermaidDiagram().editorDocument`):
 * snapshots it as an `EditorDocumentFile` after each change, and `restore` loads a
 * recovered snapshot straight into the editor. Render `<RecoveryPrompt>` with
 * `recovery`, `restore` and `discard`. Pass a stable `doc`.
 */
export function useEditorAutosave(doc: EditorDocument, options: UseEditorAutosaveOptions): UseEditorAutosaveResult {
  const autosave = useAutosave<EditorDocumentFile>({
    ...options,
    key: options.key ?? doc.kind,
    getSnapshot: () => toEditorDocumentFile(doc),
    deserialize: (text) => parseEditorDocument(text, { kind: doc.kind }),
    history: doc,
  });
  const take = autosave.restore;
  const restore = useCallback(() => {
    const snapshot = take();
    return snapshot ? doc.loadDocument(snapshot, { history: 'reset' }) : undefined;
  }, [take, doc]);
  return { ...autosave, restore };
}
