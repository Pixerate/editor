import { useEffect, useMemo } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { createRichTextEditorDocument } from "@pixerate/editor";
import type { EditorDocument } from "@pixerate/editor/persistence";

/**
 * The save / load / undo contract for a TipTap editor (kind `rich_text`; see
 * `createRichTextEditorDocument`), for `useEditorAutosave` or `createDocumentToolProvider`.
 * `null` until the editor exists (e.g. the first render of `useEditor`).
 */
export function useRichTextEditorDocument(editor: Editor | null | undefined): EditorDocument<JSONContent> | null {
  const doc = useMemo(() => (editor ? createRichTextEditorDocument(editor) : null), [editor]);
  // Subscribing again reconnects it, so a StrictMode remount keeps working.
  useEffect(() => () => doc?.destroy(), [doc]);
  return doc;
}
