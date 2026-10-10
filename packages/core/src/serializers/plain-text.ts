/**
 * Escapes characters that have syntactic meaning in HTML text.
 */
export function escapeHtml(text: string): string {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Matches strings that are already TipTap paragraph HTML (start with `<p>` and
 * end with `</p>`), as opposed to plain text that merely mentions a `<p>` tag.
 */
const PARAGRAPH_HTML_REGEX = /^\s*<p[\s>][\s\S]*<\/p>\s*$/i;

/**
 * Converts a plain-text string with newlines into HTML paragraphs suitable
 * for TipTap initial content or setContent, preserving line breaks.
 * Input that is already paragraph HTML (`<p>…</p>`) is passed through as-is.
 */
export function plainTextToTipTapHtml(text: string): string {
  if (!text) return "<p></p>";
  if (PARAGRAPH_HTML_REGEX.test(text)) {
    return text;
  }
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}

/**
 * Block-level elements that start a new line in plain-text output.
 */
const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "TR",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR",
]);

/**
 * Matches a TipTap mention span (including its content). The lookahead keeps
 * a single `[^>]*` scan per tag, avoiding catastrophic backtracking on
 * malformed input.
 */
const MENTION_SPAN_REGEX =
  /<span\b(?=[^>]*\bdata-type=["']mention["'])([^>]*)>[\s\S]*?<\/span>/gi;

function getHtmlAttribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i").exec(
    attrs,
  );
  return match ? (match[1] ?? match[2]) : undefined;
}

/**
 * Parses HTML into an inert fragment. Content of a `<template>` element is not
 * rendered, so `<img onerror>` and similar handlers never run.
 */
function parseHtmlFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

/**
 * Extracts plain text from an HTML string or TipTap HTML, preserving newlines between block tags.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";

  // Normalize mentions so data-label is preserved as @label even if textContent is empty
  const mentionNormalized = html.replace(MENTION_SPAN_REGEX, (match, attrs) => {
    const label =
      getHtmlAttribute(attrs, "data-label") || getHtmlAttribute(attrs, "data-id");
    return label ? `@${label}` : match;
  });

  if (typeof document !== "undefined") {
    const fragment = parseHtmlFragment(mentionNormalized);
    fragment
      .querySelectorAll("br.ProseMirror-trailingBreak")
      .forEach((br) => br.remove());

    // Walk the tree, emitting one line per innermost block so nested blocks
    // (e.g. TipTap's <li><p>…</p></li>) are not repeated.
    const lines: string[] = [];
    let current: string | null = null;
    const flush = () => {
      if (current !== null) {
        lines.push(current);
        current = null;
      }
    };
    const visit = (node: Node) => {
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? "";
        // Skip formatting whitespace between blocks.
        if (current === null && value.trim() === "") return;
        current = (current ?? "") + value;
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = (node as Element).tagName.toUpperCase();
      if (tag === "BR") {
        current = (current ?? "") + "\n";
        return;
      }
      if (!BLOCK_TAGS.has(tag)) {
        node.childNodes.forEach(visit);
        return;
      }
      flush();
      const linesBefore = lines.length;
      node.childNodes.forEach(visit);
      flush();
      // An empty block (e.g. <p></p>) is an empty line.
      if (lines.length === linesBefore && tag !== "HR") {
        lines.push("");
      }
    };
    fragment.childNodes.forEach(visit);
    flush();
    return lines.join("\n");
  }

  // Node.js fallback regex
  const text = mentionNormalized
    .replace(/<br\s*\/?>/gi, "\n")
    // A closing block, plus any closing wrappers right after it, ends one line.
    .replace(
      /<\/(?:p|div|li|pre|blockquote|h[1-6])>(?:\s*<\/(?:li|ul|ol|blockquote|div)>)*/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(text).replace(/\n$/, "");
}

/**
 * Extracts plain text from a TipTap editor instance, preserving newline separators
 * between block nodes and converting mention nodes to @label.
 */
export function getEditorText(editor: any): string {
  if (!editor) return "";
  const html = typeof editor.getHTML === "function" ? editor.getHTML() : "";
  if (html) {
    return htmlToPlainText(html);
  }
  if (typeof editor.getText === "function") {
    try {
      return editor.getText({ blockSeparator: "\n" });
    } catch {
      return editor.getText();
    }
  }
  return "";
}

export interface ExtractedMention {
  id: string;
  label: string;
  type?: string;
  avatarUrl?: string;
  color?: string;
  [key: string]: any;
}

import { extractMentions } from "./mentions";

/**
 * Traverses an editor instance, ProseMirror document, JSONContent, or HTML string
 * and extracts all mention attributes without needing regex.
 */
export function extractMentionsFromDoc(docOrEditor: any): ExtractedMention[] {
  if (!docOrEditor) return [];
  const mentions: ExtractedMention[] = [];

  // TipTap editor or ProseMirror Node with .descendants()
  const doc =
    docOrEditor?.state?.doc ||
    (typeof docOrEditor?.descendants === "function" ? docOrEditor : null);

  if (doc && typeof doc.descendants === "function") {
    doc.descendants((node: any) => {
      if (node.type?.name === "mention" && node.attrs) {
        mentions.push({
          id: node.attrs.id || "",
          label: node.attrs.label || "",
          type: node.attrs.type,
          avatarUrl: node.attrs.avatarUrl,
          color: node.attrs.color,
          ...node.attrs,
        });
      }
    });
    return mentions;
  }

  // JSONContent tree
  if (typeof docOrEditor === "object" && docOrEditor.content) {
    const walk = (nodes: any[]) => {
      for (const node of nodes) {
        if (node.type === "mention" && node.attrs) {
          mentions.push({
            id: node.attrs.id || "",
            label: node.attrs.label || "",
            type: node.attrs.type,
            avatarUrl: node.attrs.avatarUrl,
            color: node.attrs.color,
            ...node.attrs,
          });
        }
        if (Array.isArray(node.content)) {
          walk(node.content);
        }
      }
    };
    walk(docOrEditor.content);
    return mentions;
  }

  // HTML String
  if (typeof docOrEditor === "string") {
    if (typeof document !== "undefined") {
      parseHtmlFragment(docOrEditor).querySelectorAll('span[data-type="mention"]').forEach((el) => {
        mentions.push({
          id: el.getAttribute("data-id") || "",
          label: el.getAttribute("data-label") || "",
          type: el.getAttribute("data-type-name") || undefined,
          avatarUrl: el.getAttribute("data-avatar-url") || undefined,
          color: el.getAttribute("data-color") || undefined,
        });
      });
    } else {
      const spanRegex = /<span([^>]*data-type=["']mention["'][^>]*)>/gi;
      let match;
      while ((match = spanRegex.exec(docOrEditor)) !== null) {
        const attrStr = match[1];
        const getAttr = (name: string) => {
          const m = new RegExp(`${name}=["']([^"']*)["']`, "i").exec(attrStr);
          return m ? m[1] : undefined;
        };
        mentions.push({
          id: getAttr("data-id") || "",
          label: getAttr("data-label") || "",
          type: getAttr("data-type-name") || getAttr("data-entity-type"),
          avatarUrl: getAttr("data-avatar-url"),
          color: getAttr("data-color"),
        });
      }
    }

    // Fallback: If no HTML mention tags were found, extract raw @mentions from text or markdown
    if (mentions.length === 0) {
      const rawHandles = extractMentions(docOrEditor);
      for (const handle of rawHandles) {
        mentions.push({
          id: handle,
          label: handle,
          type: "user",
        });
      }
    }
  }

  return mentions;
}
