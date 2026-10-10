// Canvas (`@pixerate/editor/canvas`), agent (`@pixerate/editor/agent`) and
// image editor (`@pixerate/editor/image-editor`) are subpath-only so the root
// entry does not pull in dagre or the Canvas 2D renderer.
export * from "./grammar";
export * from "./extensions";
export * from "./serializers";
export * from "./controller";
export * from "./spreadsheet";
export * from "./dirty";
export * from "./history";
export * from "./slots";

// Re-export common tiptap types for convenience
export type { Editor, Content, Extensions, EditorOptions } from "@tiptap/core";
