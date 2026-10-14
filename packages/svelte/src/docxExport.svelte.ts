import type { Editor } from "@tiptap/core";
import {
  DocxExportController,
  type DocxExportControllerOptions,
  type DocxExportReport,
  type DocxExportState,
} from "@pixerate/editor/export";

/**
 * "Export to Word": downloads the editor's document as a `.docx` with its
 * comments (from the `Comments` store), tracked changes and paragraph styles,
 * with reactive `isExporting` / `error` / `lastReport` state (`lastReport`
 * lists anything the export had to leave out).
 *
 * `getEditor` is read on every export, so pass `() => editor` for a
 * `bind:editor` value.
 */
export function createDocxExport(
  getEditor: () => Editor | null | undefined,
  options: DocxExportControllerOptions = {},
) {
  const controller = new DocxExportController(() => {
    const editor = getEditor();
    return editor && !editor.isDestroyed ? editor : null;
  }, options);
  let state = $state<DocxExportState>(controller.getState());
  controller.subscribe((next) => {
    state = next;
  });

  return {
    get isExporting() {
      return state.isExporting;
    },
    get error() {
      return state.error;
    },
    get lastReport(): DocxExportReport | null {
      return state.lastReport;
    },
    /** Exports and downloads the `.docx`; resolves with the report (or `null`). */
    download: (fileName?: string) => controller.download(fileName),
    /** Builds the `.docx` without downloading it. */
    exportBlob: () => controller.exportBlob(),
    setOptions: (next: DocxExportControllerOptions) => controller.setOptions(next),
  };
}

export type DocxExportHandle = ReturnType<typeof createDocxExport>;
