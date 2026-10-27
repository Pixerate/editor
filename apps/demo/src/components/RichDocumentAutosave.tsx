import React from "react";
import type { Editor } from "@tiptap/core";
import { createRichTextEditorDocument } from "@pixerate/editor";
import { EditorDocumentAutosave, useDemoEditorDocument } from "./EditorDocumentAutosave";

/**
 * Crash-recovery autosave and the document tools for the Rich Document tab: edits are
 * snapshotted to IndexedDB; reloading with unsaved changes offers to restore them.
 */
export const RichDocumentAutosave: React.FC<{ editor: Editor }> = ({ editor }) => {
  const doc = useDemoEditorDocument(editor, createRichTextEditorDocument, { namespace: "doc", skill: "pixerate-rich-text" });
  return <EditorDocumentAutosave doc={doc} name="Rich Document" />;
};
