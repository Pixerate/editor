import { useEditor as useTipTapEditor, UseEditorOptions } from "@tiptap/react";
import { createRichTextPreset, RichTextPresetOptions } from "@pixerate/editor";

export interface UseRichEditorProps extends UseEditorOptions {
  richTextOptions?: RichTextPresetOptions;
}

/**
 * Hook to initialize a TipTap rich-text editor instance with pre-configured extensions.
 */
export function useEditor(options: UseRichEditorProps = {}) {
  const { richTextOptions, extensions = [], ...editorOptions } = options;

  const preset = createRichTextPreset(richTextOptions);
  const combinedExtensions = [...preset, ...extensions];

  return useTipTapEditor({
    extensions: combinedExtensions,
    ...editorOptions,
  });
}
