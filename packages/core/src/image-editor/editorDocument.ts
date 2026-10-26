import { createEditorAssetRegistry, type EditorAssetRegistry } from '../persistence/assets';
import { defineEditorDocument, type EditorDocument } from '../persistence/editorDocument';
import type { ImageEditorController } from './controller';
import { loadImageEditorDocument } from './document';
import type { SerializedImageEditorState } from './types';

export interface ImageEditorDocumentOptions {
  /** Where layer pixels are kept (default: a registry of its own). Share one between editors to share assets. */
  assets?: EditorAssetRegistry;
}

/**
 * The save / load / undo contract for an `ImageEditorController` (kind `image`, document: the
 * saved state from `toJSON()`, with layer pixels, masks and other images as asset references kept
 * in `assets`). The source image (`sourceUrl`) stays the host's, as in `toJSON()`. Agent loads are
 * one undo step; opening (`history: "reset"`) clears the history. A document from a newer build is
 * refused rather than opened read-only.
 */
export function createImageEditorDocument(
  controller: ImageEditorController,
  options: ImageEditorDocumentOptions = {}
): EditorDocument<SerializedImageEditorState> {
  return defineEditorDocument<SerializedImageEditorState>({
    kind: 'image',
    assets: options.assets ?? createEditorAssetRegistry(),
    get: () => controller.toJSON(),
    load: (document, { history }) => {
      const { state, report } = loadImageEditorDocument(document);
      if (report.readOnly) throw new Error(`Cannot open the image document: ${report.readOnly.message}.`);
      controller.loadJSON(state);
      if (history === 'reset') controller.clearHistory();
      return { problems: [...report.problems, ...controller.lastLoadProblems.map((message) => ({ section: 'layers', message }))] };
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
      undo: () => controller.undo(),
      redo: () => controller.redo(),
      getState: () => ({ canUndo: controller.canUndo, canRedo: controller.canRedo })
    }
  });
}
