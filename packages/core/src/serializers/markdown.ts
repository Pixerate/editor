import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { escapeHtml, getEditorText, type PlainTextOptions } from "./plain-text";
import { resolveTrackedChanges } from "../extensions/track-changes";

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

/**
 * Tags allowed through from raw HTML embedded in markdown (e.g. mention spans
 * and file links that tiptap-markdown serializes as HTML). Anything else is
 * rendered as escaped text. `input` is limited to checkboxes, which
 * markdown-it-task-lists emits as raw HTML.
 */
const ALLOWED_HTML_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "code", "col", "colgroup", "del", "details", "div", "em",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "ins", "kbd", "li", "mark",
  "ol", "p", "pre", "s", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

const ALLOWED_HTML_ATTRS = new Set([
  "alt", "align", "checked", "class", "colspan", "colwidth", "disabled", "height", "href",
  "rel", "rowspan", "src", "start", "target", "title", "type", "width",
]);

const HTML_TAG_REGEX =
  /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const HTML_ATTR_REGEX =
  /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function sanitizeTag(
  tagText: string,
  isClosing: string,
  rawTagName: string,
  rawAttrs: string,
  stripDisallowed: boolean,
): string {
  const tagName = rawTagName.toLowerCase();
  const reject = () => (stripDisallowed ? "" : escapeHtml(tagText));
  if (!ALLOWED_HTML_TAGS.has(tagName)) return reject();
  if (isClosing) return `</${tagName}>`;
  if (tagName === "input" && !/\stype\s*=\s*["']?checkbox["']?[\s>/]/i.test(tagText)) {
    return reject();
  }

  let attrs = "";
  let attrMatch: RegExpExecArray | null;
  HTML_ATTR_REGEX.lastIndex = 0;
  while ((attrMatch = HTML_ATTR_REGEX.exec(rawAttrs)) !== null) {
    const name = attrMatch[1].toLowerCase();
    if (!ALLOWED_HTML_ATTRS.has(name) && !/^data-[a-z0-9_.-]+$/.test(name)) {
      continue;
    }
    const rawValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
    if (rawValue === undefined) {
      attrs += ` ${name}`;
      continue;
    }
    const value = md.utils.unescapeAll(rawValue);
    if (
      (name === "href" || name === "src") &&
      // Browsers ignore control characters and whitespace inside schemes.
      !md.validateLink(value.replace(/[\u0000-\u0020\u007f]/g, ""))
    ) {
      continue;
    }
    attrs += ` ${name}="${escapeHtml(value)}"`;
  }
  return `<${tagName}${attrs}>`;
}

export interface SanitizeHtmlOptions {
  /**
   * What to do with tags outside the allowlist: `escape` (default) renders
   * them as literal text, `strip` removes the tag but keeps its text content.
   */
  disallowedTags?: "escape" | "strip";
}

/**
 * Sanitizes raw HTML with the same allowlist the markdown renderer applies to
 * embedded HTML: event handlers, `style` and unsafe URL schemes are dropped,
 * and disallowed tags are escaped (or removed with `disallowedTags: "strip"`).
 * It is string-based, so it works without a DOM and never runs handlers.
 */
export function sanitizeHtml(html: string, options: SanitizeHtmlOptions = {}): string {
  return sanitizeEmbeddedHtml(html, options.disallowedTags === "strip");
}

function sanitizeEmbeddedHtml(html: string, stripDisallowed = false): string {
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  HTML_TAG_REGEX.lastIndex = 0;
  while ((match = HTML_TAG_REGEX.exec(html)) !== null) {
    result += html.slice(lastIndex, match.index).replace(/</g, "&lt;");
    result += sanitizeTag(match[0], match[1], match[2], match[3], stripDisallowed);
    lastIndex = match.index + match[0].length;
  }
  return result + html.slice(lastIndex).replace(/</g, "&lt;");
}

const defaultHtmlInline = md.renderer.rules.html_inline;
const defaultHtmlBlock = md.renderer.rules.html_block;
md.renderer.rules.html_inline = (tokens, idx, options, env, self) =>
  env?.allowUnsafeHtml
    ? defaultHtmlInline!(tokens, idx, options, env, self)
    : sanitizeEmbeddedHtml(tokens[idx].content);
md.renderer.rules.html_block = (tokens, idx, options, env, self) =>
  env?.allowUnsafeHtml
    ? defaultHtmlBlock!(tokens, idx, options, env, self)
    : sanitizeEmbeddedHtml(tokens[idx].content);

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
      const labelContent = codeMatch
        ? `<code>${escapeHtml(codeMatch[1])}</code>`
        : escapeHtml(trimmed);
      return `<a href="${escapeHtml(href)}" data-file-link="true" title="Click to copy file path">${labelContent}</a>`;
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
  /**
   * Render raw HTML embedded in the markdown without sanitizing it. By default,
   * embedded HTML is restricted to an allowlist of tags and attributes (event
   * handlers, `style` and unsafe URL schemes are removed). Only enable this for
   * fully trusted input.
   */
  allowUnsafeHtml?: boolean;
}

/**
 * Converts a markdown string into HTML suitable for TipTap initial content or setContent.
 * Raw HTML embedded in the markdown is sanitized unless `allowUnsafeHtml` is set.
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
  return md.render(content, { allowUnsafeHtml: options?.allowUnsafeHtml });
}

/**
 * Extracts clean markdown from a TipTap editor instance.
 * If the editor has the Markdown extension configured, it uses editor.storage.markdown.getMarkdown().
 * Otherwise, it falls back to getEditorText(editor).
 * Tracked changes are exported as accepted unless `options.trackedChanges`
 * says otherwise (`"all"` renders deletions as `~~strikethrough~~`).
 */
export function getEditorMarkdown(editor: any, options: PlainTextOptions = {}): string {
  if (!editor) return "";
  const markdown = editor.storage?.markdown;
  if (typeof markdown?.getMarkdown === "function") {
    const doc = editor.state?.doc;
    if (doc && typeof markdown.serializer?.serialize === "function") {
      const resolved = resolveTrackedChanges(doc, options.trackedChanges ?? "accepted");
      if (resolved !== doc) return markdown.serializer.serialize(resolved);
    }
    return markdown.getMarkdown();
  }
  return getEditorText(editor, options);
}
