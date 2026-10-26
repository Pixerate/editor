import { createEditorAssetRegistry, type EditorAssetRegistry } from '../persistence/assets';
import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument';
import type { PaintEditorController } from './controller';
import type { SerializedPaintDocument } from './serialize';

export interface PaintEditorDocumentOptions {
  /** Where layer, thick-paint, mixing-pad and guide images are kept (default: a registry of its own). */
  assets?: EditorAssetRegistry;
  /** Include the recorded strokes (default `true`), so the painting can be replayed and repainted at a higher resolution. */
  strokes?: boolean;
}

/**
 * The save / load / undo contract for a `PaintEditorController` (kind `paint`, document: the
 * saved painting from `toJSON()` with every image as an asset reference kept in `assets`). Wet
 * paint is saved dry. Opening a document clears the history (`recordsLoads: false`), and the
 * document is read-only while a stroke or a wet-paint step is in progress.
 */
export function createPaintEditorDocument(
  controller: PaintEditorController,
  options: PaintEditorDocumentOptions = {}
): EditorDocument<SerializedPaintDocument> {
  return defineEditorDocument<SerializedPaintDocument>({
    kind: 'paint',
    recordsLoads: false,
    assets: options.assets ?? createEditorAssetRegistry(),
    get: () => controller.toJSON({ strokes: options.strokes ?? true }),
    load: (document) => {
      const problems = controller.loadJSON(document);
      return { problems: problems.map((message) => ({ section: 'painting', message })) };
    },
    subscribe: (listener) => {
      let revision = controller.documentRevision;
      return controller.subscribe(() => {
        if (controller.documentRevision === revision) return;
        revision = controller.documentRevision;
        listener();
      });
    },
    history: {
      undo: () => controller.undo() !== null,
      redo: () => controller.redo() !== null,
      getState: () => {
        const s = controller.getState();
        return { canUndo: s.canUndo, canRedo: s.canRedo, ...(s.undoLabel ? { undoName: s.undoLabel } : {}), ...(s.redoLabel ? { redoName: s.redoLabel } : {}) };
      }
    },
    readOnly: () => controller.busyReason() ?? false
  });
}
