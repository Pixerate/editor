import { Editor, type Content, type EditorOptions, type Extensions } from "@tiptap/core";
import { createRichTextPreset, type RichTextPresetOptions, type TransformAwareScrollOptions } from "@pixerate/editor";

export interface SvelteInitiateEditorOptions extends Partial<EditorOptions> {
  richTextOptions?: RichTextPresetOptions;
  /** Shorthand for `richTextOptions.transformAwareScroll` (on by default; `false` turns it off). */
  transformAwareScroll?: boolean | TransformAwareScrollOptions;
}

/**
 * Initializes a TipTap editor instance preconfigured with rich text extensions.
 */
export const initiateEditor = (
  element?: HTMLElement,
  content?: Content,
  extensions?: Extensions,
  options?: SvelteInitiateEditorOptions,
): Editor => {
  const { richTextOptions, transformAwareScroll, ...editorOptions } = options || {};
  const defaultPreset = createRichTextPreset({
    ...richTextOptions,
    ...(transformAwareScroll !== undefined ? { transformAwareScroll } : {}),
  });

  const editor = new Editor({
    element,
    content,
    extensions: [
      ...defaultPreset,
      ...(extensions ?? []),
    ],
    autofocus: false,
    ...editorOptions,
  });

  return editor;
};

export interface ReactiveEditorState {
  editor: Editor | undefined;
  content: string;
  isEditable: boolean;
}

/**
 * Creates a reactive editor state manager for Svelte 5.
 */
export function createReactiveEditor(
  initialContent: string = "",
  extensions: Extensions = [],
  options: Partial<EditorOptions> = {},
) {
  let editorInstance: Editor | undefined;

  return {
    get current() {
      return editorInstance;
    },
    mount(element: HTMLElement) {
      editorInstance = initiateEditor(element, initialContent, extensions, options);
      return editorInstance;
    },
    destroy() {
      if (editorInstance) {
        editorInstance.destroy();
        editorInstance = undefined;
      }
    },
  };
}
