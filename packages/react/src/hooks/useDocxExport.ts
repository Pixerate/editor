import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import {
  DocxExportController,
  type DocxExportControllerOptions,
  type DocxExportReport,
  type DocxExportState,
} from "@pixerate/editor/export";

export interface UseDocxExportResult extends DocxExportState {
  /** Exports the editor (with its comments, tracked changes and styles) and downloads the `.docx`. */
  download: (fileName?: string) => Promise<DocxExportReport | null>;
  /** Builds the `.docx` without downloading it. */
  exportBlob: DocxExportController["exportBlob"];
}

/**
 * "Export to Word": downloads the editor's document as a `.docx` with its
 * comments (from the `Comments` store), tracked changes and paragraph styles.
 * `lastReport` lists anything the export had to leave out.
 */
export function useDocxExport(
  editor: Editor | null | undefined,
  options: DocxExportControllerOptions = {},
): UseDocxExportResult {
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const controller = useMemo(
    () =>
      new DocxExportController(() => {
        const current = editorRef.current;
        return current && !current.isDestroyed ? current : null;
      }, options),
    [],
  );

  useEffect(() => {
    controller.setOptions(options);
  });

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  return {
    ...state,
    download: (fileName?: string) => controller.download(fileName),
    exportBlob: () => controller.exportBlob(),
  };
}
