import { useEditor as useTipTapEditor, UseEditorOptions } from "@tiptap/react";
import {
  createRichTextPreset,
  RichTextPresetOptions,
  type FileImportOptions,
  type RichClipboardOptions,
} from "@pixerate/editor";

export interface UseRichEditorProps extends UseEditorOptions {
  richTextOptions?: RichTextPresetOptions;
  /**
   * Import .md, .html, .txt and .rtf files dropped or pasted into the editor
   * at the drop position (opt-in; same as `richTextOptions.fileImport`).
   */
  fileImport?: FileImportOptions | boolean;
  /**
   * Copy/paste lossless ProseMirror slices between editors via the
   * `application/x.pixerate.document+json` clipboard type (opt-in; same as
   * `richTextOptions.richClipboard`).
   */
  richClipboard?: RichClipboardOptions | boolean;
}

/**
 * Hook to initialize a TipTap rich-text editor instance with pre-configured extensions.
 */
export function useEditor(options: UseRichEditorProps = {}) {
  const {
    richTextOptions,
    fileImport,
    richClipboard,
    extensions = [],
    ...editorOptions
  } = options;

  const preset = createRichTextPreset({
    ...(fileImport !== undefined ? { fileImport } : {}),
    ...(richClipboard !== undefined ? { richClipboard } : {}),
    ...richTextOptions,
  });
  const combinedExtensions = [...preset, ...extensions];

  return useTipTapEditor({
    extensions: combinedExtensions,
    ...editorOptions,
  });
}
