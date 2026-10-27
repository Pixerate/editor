import { useCallback, useMemo, useRef } from 'react';
import {
  collectRetiredEditorAssets,
  parseEditorDocument,
  toEditorDocumentFile,
  withEditorAssets,
  type EditorAssetGarbageOptions,
  type EditorDocument,
  type EditorDocumentFile,
  type LoadReport,
} from '@pixerate/editor/persistence';
import { useAutosave, type UseAutosaveOptions, type UseAutosaveResult } from './useAutosave';

export interface UseEditorAutosaveOptions
  extends Omit<UseAutosaveOptions<EditorDocumentFile>, 'key' | 'getSnapshot' | 'serialize' | 'deserialize' | 'history'> {
  /** Snapshot key (default the document's `kind`). */
  key?: string;
  /**
   * For documents with `assets`: after `markClean` or `discard` retire a snapshot, delete the
   * stored assets nothing refers to any more (`collectEditorAssetGarbage`, best effort, keeping
   * the assets the document uses now; default `true`). Needs `storage.keys`; `false` turns it off.
   */
  collectAssetGarbage?: boolean | Omit<EditorAssetGarbageOptions, 'dryRun' | 'only'>;
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
export function useEditorAutosave(doc: EditorDocument, { collectAssetGarbage, ...options }: UseEditorAutosaveOptions): UseEditorAutosaveResult {
  // Image and paint documents hold asset references: their bytes are saved and read with them.
  const storage = useMemo(
    () => (doc.assets ? withEditorAssets(options.storage, doc.assets) : options.storage),
    [options.storage, doc.assets],
  );
  const autosave = useAutosave<EditorDocumentFile>({
    ...options,
    storage,
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
  const { markClean: clean, discard: drop } = autosave;
  const rawStorage = options.storage;
  const gcRef = useRef(collectAssetGarbage);
  gcRef.current = collectAssetGarbage;
  // Retiring a snapshot can leave assets nothing refers to any more.
  const markClean = useCallback(async () => {
    await clean();
    await collectRetiredEditorAssets(rawStorage, doc, gcRef.current);
  }, [clean, rawStorage, doc]);
  const discard = useCallback(async () => {
    await drop();
    await collectRetiredEditorAssets(rawStorage, doc, gcRef.current);
  }, [drop, rawStorage, doc]);
  return { ...autosave, restore, markClean, discard };
}
