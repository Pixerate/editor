import type { Editor } from "@tiptap/core";
import {
  FileImportController,
  summarizeImportStructure,
  type FileImportControllerOptions,
  type FileImportState,
  type ImportStructureSummary,
} from "@pixerate/editor";

/**
 * Imports markdown, HTML, plain-text and RTF files (or anything registered
 * with `registerImportAdapter` for the `document` target) into an editor,
 * with reactive `isImporting` / `error` state. Pair it with
 * `<EditableTextNodeEditor fileImport />` to also accept dropped files.
 *
 * `getEditor` is read on every import, so pass `() => editor` for a
 * `bind:editor` value.
 */
export function createFileImport(
  getEditor: () => Editor | null | undefined,
  options: FileImportControllerOptions = {},
) {
  const controller = new FileImportController(() => {
    const editor = getEditor();
    return editor && !editor.isDestroyed ? editor : null;
  }, options);
  let state = $state<FileImportState>(controller.getState());
  let summary: ImportStructureSummary | null = $derived(summarizeImportStructure(state.lastOutcomes));
  controller.subscribe((next) => {
    state = next;
  });

  return {
    get isImporting() {
      return state.isImporting;
    },
    get error() {
      return state.error;
    },
    get lastOutcomes() {
      return state.lastOutcomes;
    },
    /**
     * Structures detected in the last import (headings, lists, tables,
     * columns), or `null` when no adapter reported any (only structure-aware
     * adapters such as PDF do). Turn PDF detection off with
     * `setOptions({ adapterOptions: { pdf: { structure: false } } })`.
     */
    get structureSummary(): ImportStructureSummary | null {
      return summary;
    },
    /** Value for `<input type="file" accept={…}>`. */
    get accept() {
      return controller.accept;
    },
    /** Opens the browser file picker and imports the chosen files at the selection. */
    openFilePicker: controller.openFilePicker,
    /** Imports files (e.g. from your own `<input>` or drop zone) at `at` or the selection. */
    importFiles: controller.importFiles,
    setOptions: (next: FileImportControllerOptions) => controller.setOptions(next),
  };
}

export type FileImportHandle = ReturnType<typeof createFileImport>;
