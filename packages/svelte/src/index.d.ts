import type { Component } from "svelte";
import type { Editor, Content, Extensions, EditorOptions } from "@tiptap/core";
import type {
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
} from "@pixerate/editor";

export interface SvelteInitiateEditorOptions extends Partial<EditorOptions> {
  richTextOptions?: RichTextPresetOptions;
}

export declare const initiateEditor: (
  element?: HTMLElement,
  content?: Content,
  extensions?: Extensions,
  options?: SvelteInitiateEditorOptions,
) => Editor;

export interface ReactiveEditorState {
  editor: Editor | undefined;
  content: string;
  isEditable: boolean;
}

export declare function createReactiveEditor(
  initialContent?: string,
  extensions?: Extensions,
  options?: Partial<EditorOptions>,
): {
  readonly current: Editor | undefined;
  mount(element: HTMLElement): Editor;
  destroy(): void;
};

export interface EditableTextNodeEditorProps {
  class?: string;
  content?: Content;
  showMenu?: boolean;
  editable?: boolean;
  editor?: Editor;
  extensions?: Extensions;
  onUpdate?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onCreate?: () => void;
  placeholder?: string;
}

export interface BubbleMenuProps {
  editor?: Editor;
  class?: string;
  children?: any;
}

export interface TemplateRendererProps {
  content: string;
  templates?: Template[];
  templateColorMap?: Map<string, ColorGradient>;
  resolve?: boolean;
  class?: string;
  onTemplateClick?: (templateName: string) => void;
  onVariableClick?: (variableName: string) => void;
}

export declare const EditableTextNodeEditor: Component<EditableTextNodeEditorProps>;
export declare const BubbleMenu: Component<BubbleMenuProps>;
export declare const TemplateRenderer: Component<TemplateRendererProps>;

export type {
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
};
