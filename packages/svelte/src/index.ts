import type { Component } from "svelte";
import type { Editor, Content, Extensions } from "@tiptap/core";
import type { Template, ColorGradient } from "@pixerate/editor";

import EditableTextNodeEditorComponent from "./EditableTextNodeEditor.svelte";
import BubbleMenuComponent from "./BubbleMenu.svelte";
import TemplateRendererComponent from "./TemplateRenderer.svelte";

export * from "./editor.svelte";

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

export const EditableTextNodeEditor = EditableTextNodeEditorComponent as unknown as Component<EditableTextNodeEditorProps>;
export const BubbleMenu = BubbleMenuComponent as unknown as Component<BubbleMenuProps>;
export const TemplateRenderer = TemplateRendererComponent as unknown as Component<TemplateRendererProps>;

export type {
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
} from "@pixerate/editor";

export * from "./spreadsheet";
