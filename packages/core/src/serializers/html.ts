import { sanitizeHtml } from "./markdown";
import { escapeHtml } from "./plain-text";

/**
 * Elements whose content is never document text (scripts, styles, metadata,
 * embedded objects, form controls). They are removed together with their
 * content before sanitizing, so e.g. CSS rules don't show up as paragraphs.
 */
const DROP_WITH_CONTENT_REGEX =
  /<(script|style|template|noscript|iframe|object|embed|head|title|svg|math|textarea|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** An unclosed `<script>` / `<style>` swallows the rest of the document. */
const UNCLOSED_RAW_TEXT_REGEX = /<(script|style)\b[^>]*>[\s\S]*$/i;
const BODY_REGEX = /<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i;
/** Namespaced tags such as Word's `<o:p>`, which the sanitizer cannot parse. */
const NAMESPACED_TAG_REGEX = /<\/?[a-zA-Z][\w-]*:[\w-]+\b[^>]*>/g;

/**
 * Sanitizes a full HTML document or fragment for insertion into the editor,
 * e.g. an imported `.html` file or HTML from another application.
 *
 * - Keeps only the `<body>` content when the input is a full document.
 * - Removes comments, doctype/XML declarations, CDATA, scripts, styles and
 *   other non-text elements together with their content.
 * - Applies the same tag/attribute/URL allowlist as embedded HTML in markdown
 *   (see `sanitizeHtml`), but strips disallowed tags instead of escaping them,
 *   so wrappers such as `<section>` or `<font>` keep their text.
 *
 * It is string-based (no live DOM), so handlers such as `<img onerror>` never run.
 */
export function sanitizeImportedHtml(html: string): string {
  if (!html) return "<p></p>";
  let content = html.replace(/^﻿/, "");
  content = content
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, "")
    .replace(/<![^>]*>/g, "")
    .replace(/<\?[\s\S]*?(?:\?>|$)/g, "");
  const body = BODY_REGEX.exec(content);
  if (body) content = body[1];
  content = content
    .replace(DROP_WITH_CONTENT_REGEX, "")
    .replace(UNCLOSED_RAW_TEXT_REGEX, "")
    .replace(NAMESPACED_TAG_REGEX, "");
  const sanitized = sanitizeHtml(content, { disallowedTags: "strip" }).trim();
  return sanitized || "<p></p>";
}

/**
 * Converts untrusted plain text to TipTap paragraph HTML, always escaping it.
 *
 * Unlike `plainTextToTipTapHtml`, text that already looks like `<p>…</p>` is
 * not passed through as HTML, which matters for imported files.
 */
export function plainTextToParagraphHtml(text: string): string {
  if (!text) return "<p></p>";
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
}
