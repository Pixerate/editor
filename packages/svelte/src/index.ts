import type { ComponentProps } from "svelte";

import type EditableTextNodeEditorComponent from "./EditableTextNodeEditor.svelte";
import type BubbleMenuComponent from "./BubbleMenu.svelte";
import type TemplateRendererComponent from "./TemplateRenderer.svelte";
import type VariableFormComponent from "./VariableForm.svelte";
import type OutlinePanelComponent from "./OutlinePanel.svelte";
import type MergePreviewComponent from "./MergePreview.svelte";
import type StylesGalleryComponent from "./StylesGallery.svelte";

export * from "./editor.svelte.js";
export * from "./navigationGuard.js";
export * from "./createNavigationGuard.svelte.js";
export * from "./history/index.js";
export * from "./fileImport.svelte.js";
export * from "./agentTools.svelte.js";
export * from "./outline.svelte.js";
export * from "./merge.svelte.js";

export {
  DirtyTracker,
  createDirtyTracker,
  defaultIsEqual,
  HistoryManager,
  createHistoryManager,
  bindDirtyToHistory,
  withoutDirty,
} from "@pixerate/editor";
export type {
  DirtyTrackerOptions,
  Command,
  HistoryState,
  HistoryManagerOptions,
  HistoryEntry,
  HistoryMark,
  MergedExecutionOptions,
  HistoryDirtyBinding,
  BindDirtyToHistoryOptions,
} from "@pixerate/editor";

// Prop types are derived from the components so they cannot drift.
export type EditableTextNodeEditorProps = ComponentProps<
  typeof EditableTextNodeEditorComponent
>;
export type BubbleMenuProps = ComponentProps<typeof BubbleMenuComponent>;
export type TemplateRendererProps = ComponentProps<
  typeof TemplateRendererComponent
>;
export type VariableFormProps = ComponentProps<typeof VariableFormComponent>;

export { default as EditableTextNodeEditor } from "./EditableTextNodeEditor.svelte";
export { default as BubbleMenu } from "./BubbleMenu.svelte";
export { default as TemplateRenderer } from "./TemplateRenderer.svelte";
export { default as VariableForm } from "./VariableForm.svelte";
export type MergePreviewProps = ComponentProps<typeof MergePreviewComponent>;
export { default as MergePreview } from "./MergePreview.svelte";
export type OutlinePanelProps = ComponentProps<typeof OutlinePanelComponent>;
export { default as OutlinePanel } from "./OutlinePanel.svelte";
export * from "./paragraphStyles.svelte.js";
export type StylesGalleryProps = ComponentProps<typeof StylesGalleryComponent>;
export { default as StylesGallery } from "./StylesGallery.svelte";

export type {
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
  ImageOptions,
} from "@pixerate/editor";
export type {
  PromptValues,
  PromptDiagnostic,
  VariableFormField,
  MergeDataSource,
  MergeRecord,
  MergeRecordsResult,
  MergeOutput,
} from "@pixerate/editor";

export * from "./spreadsheet/index.js";
export * from "./image-editor/index.js";
export * from "./review/index.js";
export * from "./commands/index.js";
export * from "./persistence/index.js";
export * from "./generation/index.js";
export * from "./find-replace/index.js";
