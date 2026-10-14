import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/core";
import {
  FileImportController,
  summarizeImportStructure,
  type FileImportControllerOptions,
  type FileImportState,
  type ImportStructureSummary,
} from "@pixerate/editor";

export interface UseFileImportResult extends FileImportState {
  /**
   * Structures detected in the last import (headings, lists, tables, columns),
   * or `null` when no adapter reported any (only structure-aware adapters such
   * as PDF do). Turn PDF detection off with
   * `useFileImport(editor, { adapterOptions: { pdf: { structure: false } } })`.
   */
  structureSummary: ImportStructureSummary | null;
  /** Value for `<input type="file" accept={…}>`. */
  accept: string;
  /** Opens the browser file picker and imports the chosen files at the selection. */
  openFilePicker: FileImportController["openFilePicker"];
  /** Imports files (e.g. from your own `<input>` or drop zone) at `at` or the selection. */
  importFiles: FileImportController["importFiles"];
}

/**
 * Imports markdown, HTML, plain-text and RTF files (or anything registered
 * with `registerImportAdapter` for the `document` target) into an editor.
 * Pair it with `useEditor({ fileImport: true })` to also accept dropped files.
 */
export function useFileImport(
  editor: Editor | null | undefined,
  options: FileImportControllerOptions = {},
): UseFileImportResult {
  const editorRef = useRef(editor);
  editorRef.current = editor;

  const controller = useMemo(
    () =>
      new FileImportController(() => {
        const current = editorRef.current;
        return current && !current.isDestroyed ? current : null;
      }, options),
    [],
  );

  useEffect(() => {
    controller.setOptions(options);
  });

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const structureSummary = useMemo(() => summarizeImportStructure(state.lastOutcomes), [state.lastOutcomes]);

  return {
    ...state,
    structureSummary,
    accept: controller.accept,
    openFilePicker: controller.openFilePicker,
    importFiles: controller.importFiles,
  };
}
