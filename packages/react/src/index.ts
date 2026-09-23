export * from "./hooks/usePromptEditor";
export * from "./hooks/useEditor";
export * from "./hooks/useNavigationGuard";
export * from "./hooks/useDismissGuard";
export * from "./components/EditorContent";
export * from "./components/BubbleMenu";
export * from "./components/TemplateRenderer";

// Re-export core types for easy consumer access
export {
  DirtyTracker,
  createDirtyTracker,
  defaultIsEqual,
} from "@pixerate/editor";
export type {
  Template,
  TemplateVersion,
  Token,
  TokenType,
  ColorGradient,
  RichTextPresetOptions,
  DirtyTrackerOptions,
} from "@pixerate/editor";

export * from "./spreadsheet";
