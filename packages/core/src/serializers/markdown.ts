import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { getEditorText } from "./plain-text";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
}).use(taskLists);

const defaultValidateLink = md.validateLink;
md.validateLink = (url: string) => {
  if (
    url.startsWith("file://") ||
    url.startsWith("vscode://") ||
    url.startsWith("cursor://")
  ) {
    return true;
  }
  return defaultValidateLink.call(md, url);
};

import {
  preprocessMarkdownMentions,
  type PreprocessMarkdownMentionsOptions,
} from "./mentions";
import type { MentionEntity } from "../extensions/mention";

/**
 * Preprocesses file-protocol and editor-protocol links in markdown content:
 * converts [label](file://...), vscode://, and cursor:// links into anchor tags
 * annotated with data-file-link="true", preserving code backticks in labels.
 */
export function preprocessMarkdownFileLinks(content: string): string {
  if (!content) return "";
  return content.replace(
    /\[([^\]]+)\]\(((?:file|vscode|cursor):\/\/[^)]+)\)/g,
    (_match, rawLabel, href) => {
      const trimmed = rawLabel.trim();
      const codeMatch = trimmed.match(/^`([^`]+)`$/);
      const labelContent = codeMatch ? `<code>${codeMatch[1]}</code>` : trimmed;
      return `<a href="${href}" data-file-link="true" title="Click to copy file path">${labelContent}</a>`;
    }
  );
}

export interface MarkdownToHtmlOptions {
  /**
   * Preprocess file, vscode, and cursor links into clickable data-file-link tags.
   */
  preprocessFileLinks?: boolean;
  /**
   * Whether to preprocess @mentions into TipTap mention node HTML spans.
   */
  preprocessMentions?: boolean;
  /**
   * Pool of mentionables to pass to preprocessMarkdownMentions.
   */
  mentionables?: MentionEntity[];
  /**
   * Full options for preprocessMarkdownMentions.
   */
  preprocessOptions?: PreprocessMarkdownMentionsOptions;
}

/**
 * Converts a markdown string into HTML suitable for TipTap initial content or setContent.
 */
export function markdownToTipTapHtml(
  markdown: string,
  options?: MarkdownToHtmlOptions
): string {
  if (!markdown) return "<p></p>";
  let content = markdown;
  if (options?.preprocessFileLinks) {
    content = preprocessMarkdownFileLinks(content);
  }
  if (
    options?.preprocessMentions ||
    options?.mentionables ||
    options?.preprocessOptions
  ) {
    const mentionOpts = options.preprocessOptions || {
      mentionables: options.mentionables,
    };
    content = preprocessMarkdownMentions(content, mentionOpts);
  }
  return md.render(content);
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
