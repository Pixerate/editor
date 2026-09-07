import { Editor, type Content, type EditorOptions, type Extensions } from "@tiptap/core";
import { createRichTextPreset, type RichTextPresetOptions } from "@pixerate/editor";

export interface SvelteInitiateEditorOptions extends Partial<EditorOptions> {
  richTextOptions?: RichTextPresetOptions;
}

/**
 * Initializes a TipTap editor instance, providing complete feature parity with Gleamforge's initiateEditor.
 */
export const initiateEditor = (
  element?: HTMLElement,
  content?: Content,
  extensions?: Extensions,
  options?: SvelteInitiateEditorOptions,
): Editor => {
  const { richTextOptions, ...editorOptions } = options || {};
  const defaultPreset = createRichTextPreset(richTextOptions);

  const editor = new Editor({
    element,
    content,
    extensions: [
      ...defaultPreset,
      ...(extensions ?? []),
    ],
    autofocus: true,
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
