import type { ComponentProps } from "svelte";

import type EditableTextNodeEditorComponent from "./EditableTextNodeEditor.svelte";
import type BubbleMenuComponent from "./BubbleMenu.svelte";
import type TemplateRendererComponent from "./TemplateRenderer.svelte";

export * from "./editor.svelte.js";
export * from "./navigationGuard.js";
export * from "./createNavigationGuard.svelte.js";
export * from "./history/index.js";

export {
  DirtyTracker,
  createDirtyTracker,
  defaultIsEqual,
  HistoryManager,
  createHistoryManager,
} from "@pixerate/editor";
export type {
  DirtyTrackerOptions,
  Command,
  HistoryState,
  HistoryManagerOptions,
} from "@pixerate/editor";

// Prop types are derived from the components so they cannot drift.
export type EditableTextNodeEditorProps = ComponentProps<
  typeof EditableTextNodeEditorComponent
>;
export type BubbleMenuProps = ComponentProps<typeof BubbleMenuComponent>;
export type TemplateRendererProps = ComponentProps<
  typeof TemplateRendererComponent
>;

export { default as EditableTextNodeEditor } from "./EditableTextNodeEditor.svelte";
export { default as BubbleMenu } from "./BubbleMenu.svelte";
export { default as TemplateRenderer } from "./TemplateRenderer.svelte";

export type {
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
  ImageOptions,
} from "@pixerate/editor";

export * from "./spreadsheet/index.js";
export * from "./image-editor/index.js";
