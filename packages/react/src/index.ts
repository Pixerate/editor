export * from "./hooks/usePromptEditor";
export * from "./hooks/useEditor";
export { formatCommandsFor, type FormatManifest, type FormatManifestCommand, type CodeLanguageOption, type FormatCommandOptions } from "@pixerate/editor";
export * from "./hooks/useNavigationGuard";
export * from "./hooks/useDismissGuard";
export * from "./hooks/useHistory";
export * from "./hooks/useHistoryDirty";
export * from "./hooks/useHistoryShortcuts";
export * from "./hooks/useFileImport";
export * from "./hooks/useDocxExport";
export * from "./components/ExportDocxButton";
export * from "./hooks/useAgentToolProvider";
export * from "./hooks/useRichTextEditorDocument";
export * from "./playback";
export * from "./hooks/useToolBridge";
export * from "./hooks/useToolRegistryView";
export * from "./components/EditorContent";
export * from "./components/BubbleMenu";
export * from "./components/TemplateRenderer";
export * from "./components/VariableForm";
export * from "./components/MergePreview";
export * from "./hooks/useMergePreview";
export * from "./hooks/useOutline";
export * from "./components/OutlinePanel";
export * from "./hooks/useParagraphStyles";
export * from "./components/StylesGallery";

// Re-export core types for easy consumer access
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
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
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
export type {
  PromptValues,
  PromptDiagnostic,
  VariableFormField,
  MergeDataSource,
  MergeRecord,
  MergeRecordsResult,
  MergeOutput,
} from "@pixerate/editor";

export * from "./spreadsheet";
export * from "./slots";
export * from "./image-editor";
export * from "./review";
export * from "./commands";
export * from "./persistence";
export * from "./generation";
export * from "./find-replace";
export * from "./tables";
export * from "./chart-node";

export * from "./style";
