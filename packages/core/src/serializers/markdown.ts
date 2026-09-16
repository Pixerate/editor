import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { getEditorText } from "./plain-text";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
}).use(taskLists);

/**
 * Converts a markdown string into HTML suitable for TipTap initial content or setContent.
 */
export function markdownToTipTapHtml(markdown: string): string {
  if (!markdown) return "<p></p>";
  return md.render(markdown);
}

/**
 * Extracts clean markdown from a TipTap editor instance.
 * If the editor has the Markdown extension configured, it uses editor.storage.markdown.getMarkdown().
 * Otherwise, it falls back to getEditorText(editor).
 */
export function getEditorMarkdown(editor: any): string {
  if (!editor) return "";
  if (typeof editor.storage?.markdown?.getMarkdown === "function") {
    return editor.storage.markdown.getMarkdown();
  }
  return getEditorText(editor);
}
