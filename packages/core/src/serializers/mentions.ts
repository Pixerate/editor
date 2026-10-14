import { escapeHtml } from "./plain-text";
import {
  MENTION_REGEX,
  NODE_ROLE_MARK,
  formatMentionHandle,
  readRoleSuffix,
  type MentionRoleSyntax,
} from "./mention-text";

export {
  MENTION_REGEX,
  findTextMentions,
  formatMentionText,
  setMentionRoleInText,
  type MentionRoleSyntax,
  type TextMention,
} from "./mention-text";
import { findTagSpans, replaceDelimited, stripTags } from "./html-scan";
import type { MentionEntity } from "../extensions/mention";


/**
 * Split regex identifying markdown code blocks, inline code, URLs, and existing HTML tags.
 * Used by preprocessMarkdownMentions to ensure non-mention regions remain completely untouched.
 */
export const MARKDOWN_MENTION_SPLIT_REGEX =
  /(```[\s\S]*?```|~~~[\s\S]*?~~~|<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>|`[^`\n]+`|<span\b[^>]*\b(?:data-type=["']mention["']|class=["'][^"']*pixerate-mention-node[^"']*["']|data-mention=["'][^"']*["'])[^>]*>[\s\S]*?<\/span>|<[^>]+>|\]\([^)]+\)|(?:https?|file|vscode|cursor|mailto):\/\/[^\s<)]+)/gi;

export interface MentionSegment {
  type: "text" | "mention";
  value: string;
  handle?: string;
  /** Role written after the handle (`@fox:style`), when role syntax is enabled. */
  role?: string;
}


/** A mention with its role (asset mentions: `@fox:style`, or `data-role` on a mention node). */
export interface MentionDetail {
  handle: string;
  role?: string;
}

export interface ExtractMentionsOptions {
  /** Return `{ handle, role }` objects instead of handles. */
  details?: boolean;
  /** Read `@handle:role` suffixes in text (see {@link MentionRoleSyntax}). Mention nodes' `data-role` is always read in `details` mode. */
  roles?: MentionRoleSyntax;
}

export interface PreprocessMarkdownMentionsOptions {
  /**
   * Known pool of mentionable entities (users, agents, teams, etc.).
   */
  mentionables?: MentionEntity[];
  /**
   * Default entity type assigned when a handle does not match any entry in mentionables.
   * Defaults to 'user'.
   */
  defaultType?: string;
  /**
   * Custom resolver callback to derive entity metadata for unmatched handles.
   */
  resolveMention?: (handle: string) => Partial<MentionEntity> | null | undefined;
  /**
   * Read `@handle:role` and emit the role as `data-role` (the `:role` text is
   * consumed). Off by default. See {@link MentionRoleSyntax}.
   */
  roles?: MentionRoleSyntax;
}

/**
 * Strips code blocks and inline code from markdown or HTML content:
 * - Fenced code blocks: ```...``` and ~~~...~~~
 * - Inline backtick code: `...`
 * - HTML code/pre tags: <pre>...</pre>, <code>...</code>
 * Used to avoid false-positive mention parsing and keyword analysis within code snippets, terminal logs, or stack traces.
 */
export function stripMarkdownCode(content: string): string {
  if (!content || typeof content !== "string") return "";
  // Linear scans instead of lazy `[\s\S]*?` regexes, which rescan to the end of the
  // input from every unclosed opener (see html-scan.ts).
  let text = replaceDelimited(content, /```/g, "```");
  text = replaceDelimited(text, /~~~/g, "~~~");
  text = replaceDelimited(text, /<pre/gi, "</pre>", undefined, true);
  text = replaceDelimited(text, /<code/gi, "</code>", undefined, true);
  return text.replace(/`[^`\n]*`/g, "");
}

/** True for the attributes of a mention node: `data-type="mention"` or the `pixerate-mention-node` class. */
function isMentionNodeAttributes(attrs: string): boolean {
  if (/\bdata-type=["']mention["']/i.test(attrs)) return true;
  const classAttr = /\bclass=(["'])/i.exec(attrs);
  if (!classAttr) return false;
  const valueStart = classAttr.index + classAttr[0].length;
  const valueEnd = attrs.indexOf(classAttr[1], valueStart);
  return valueEnd !== -1 && attrs.slice(valueStart, valueEnd).includes("pixerate-mention-node");
}

/**
 * Extracts unique mention handles from a text, markdown, or HTML string,
 * ignoring trailing punctuation, code blocks, URLs, and pre-existing HTML mention attributes.
 *
 * With `{ details: true }` it returns `{ handle, role }` objects, unique per
 * handle and role: roles come from mention nodes' `data-role` and, when
 * `roles` is set, from `@handle:role` text. Without options the result is
 * unchanged.
 */
export function extractMentions(content: string, options?: ExtractMentionsOptions & { details?: false }): string[];
export function extractMentions(content: string, options: ExtractMentionsOptions & { details: true }): MentionDetail[];
export function extractMentions(content: string, options?: ExtractMentionsOptions): string[] | MentionDetail[];
export function extractMentions(content: string, options: ExtractMentionsOptions = {}): string[] | MentionDetail[] {
  if (!content || typeof content !== "string") return [];
  const details = options.details === true;

  // Normalize existing HTML mention nodes (e.g. from TipTap or rich text serializers)
  // so data-mention-suggestion-char="@" does not trigger spurious quoted matches against attributes,
  // and ensure the actual mentioned label or ID is preserved cleanly.
  // A linear scan: the equivalent regex (`<span\b[^>]*\b(?:…)[^>]*>`) backtracks
  // cubically on malformed input without a `>` (see html-scan.ts).
  let normalizedMentionNodes = "";
  let last = 0;
  for (const span of findTagSpans(content, "span", isMentionNodeAttributes, true)) {
    const labelMatch = /\bdata-label=["']([^"']+)["']/i.exec(span.attrs);
    const idMatch = labelMatch ? null : /\bdata-id=["']([^"']+)["']/i.exec(span.attrs);
    const inner = content.slice(span.openEnd, span.end - "</span>".length);
    let replacement = labelMatch ? ` @${labelMatch[1]} ` : idMatch ? ` @${idMatch[1]} ` : ` ${inner} `;
    if (details && (labelMatch || idMatch)) {
      const roleMatch = /\bdata-role=["']([^"']+)["']/i.exec(span.attrs);
      const role = roleMatch && /^[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(roleMatch[1]) ? roleMatch[1] : null;
      const label = (labelMatch ?? idMatch)![1];
      replacement = ` ${formatMentionHandle(label)}${role ? NODE_ROLE_MARK + role : ""} `;
    }
    normalizedMentionNodes += content.slice(last, span.start) + replacement;
    last = span.end;
  }
  normalizedMentionNodes += content.slice(last);

  const cleanContent = stripMarkdownCode(normalizedMentionNodes);
  // Strip URLs and markdown link destinations so @package or @handles in URLs are not extracted as mentions
  const withoutUrls = cleanContent
    .replace(/(?:https?|ftp|file|vscode|cursor|mailto):\/\/[^\s<>()]+/gi, "");
  // Markdown link destinations: `](…)` → `]` (linear; `/\]\([^)]*\)/g` is quadratic
  // when many `](` have no `)`).
  const withoutLinks = replaceDelimited(withoutUrls, /\]\(/g, ")", () => "]");
  // Strip remaining HTML tags so attributes containing '@' or '>' aren't treated as mention triggers
  const textOnly = stripTags(withoutLinks, " ");

  const mentions: string[] = [];
  const detailed: MentionDetail[] = [];
  const seen = new Set<string>();

  const regex = new RegExp(MENTION_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(textOnly)) !== null) {
    const handle = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (details) {
      const suffix = readRoleSuffix(textOnly, regex.lastIndex, options.roles);
      if (suffix) regex.lastIndex = suffix.end;
      const key = `${handle}\u0000${suffix?.role ?? ""}`;
      if (handle && !seen.has(key)) {
        seen.add(key);
        detailed.push(suffix ? { handle, role: suffix.role } : { handle });
      }
      continue;
    }
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      mentions.push(handle);
    }
  }

  return details ? detailed : mentions;
}

/**
 * Segments a text string into plain text parts and mention tokens.
 * Correctly leaves trailing punctuation (like ".") as part of the following text segment.
 */
export function parseMentionSegments(
  content: string,
  options: { roles?: MentionRoleSyntax } = {},
): MentionSegment[] {
  if (!content) return [];

  const segments: MentionSegment[] = [];
  const regex = new RegExp(MENTION_REGEX.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const fullMatch = match[0];
    const atIndex = fullMatch.indexOf("@");
    const prefix = atIndex > 0 ? fullMatch.slice(0, atIndex) : "";
    let mentionToken = fullMatch.slice(atIndex);
    const handle = match[1] ?? match[2] ?? match[3];
    const matchStart = match.index + prefix.length;
    const suffix =
      options.roles && content.charAt(regex.lastIndex) === ":"
        ? readRoleSuffix(content, regex.lastIndex, options.roles)
        : null;
    if (suffix) {
      mentionToken = content.slice(matchStart, suffix.end);
      regex.lastIndex = suffix.end;
    }

    if (matchStart > lastIndex) {
      segments.push({
        type: "text",
        value: content.slice(lastIndex, matchStart),
      });
    }

    segments.push({
      type: "mention",
      value: mentionToken,
      handle,
      ...(suffix ? { role: suffix.role } : {}),
    });

    lastIndex = matchStart + mentionToken.length;
  }

  if (lastIndex < content.length) {
    segments.push({
      type: "text",
      value: content.slice(lastIndex),
    });
  }

  return segments;
}

/**
 * Preprocesses markdown text by turning raw @mention handles into TipTap-compatible
 * mention HTML spans (<span class="pixerate-mention-node" data-type="mention" ...>),
 * ensuring code blocks, inline code, existing mention nodes, and URLs remain immune.
 */
export function preprocessMarkdownMentions(
  content: string,
  optionsOrMentionables: MentionEntity[] | PreprocessMarkdownMentionsOptions = []
): string {
  if (!content || typeof content !== "string") return "";

  const options: PreprocessMarkdownMentionsOptions = Array.isArray(optionsOrMentionables)
    ? { mentionables: optionsOrMentionables }
    : optionsOrMentionables;

  const allMentionables = options.mentionables || [];
  const defaultType = options.defaultType || "user";
  const resolveMention = options.resolveMention;

  const parts = content.split(MARKDOWN_MENTION_SPLIT_REGEX);

  return parts
    .map((part) => {
      if (!part) return "";

      // Preserve code fences, code tags, inline backticks, existing mention spans,
      // HTML tags, markdown link targets, and raw URLs untouched.
      if (
        part.startsWith("```") ||
        part.startsWith("~~~") ||
        part.startsWith("`") ||
        part.startsWith("](") ||
        /^(?:https?|file|vscode|cursor|mailto):\/\//i.test(part) ||
        /^<pre[\s>]/i.test(part) ||
        /^<code[\s>]/i.test(part) ||
        /^<[^>]+>$/i.test(part) ||
        /^<span\b[^>]*\b(?:data-type=["']mention["']|class=["'][^"']*pixerate-mention-node[^"']*["']|data-mention=["'][^"']*["'])/i.test(
          part
        )
      ) {
        return part;
      }

      const regex = new RegExp(MENTION_REGEX.source, "g");
      const render = (
        match: string,
        quotedHandle: string | undefined,
        escapedQuotedHandle: string | undefined,
        standardHandle: string | undefined,
        role?: string,
      ): string => {
        const atIndex = match.indexOf("@");
        const prefix = atIndex > 0 ? match.slice(0, atIndex) : "";
        const rawHandle = (quotedHandle || escapedQuotedHandle || standardHandle || "").trim();
        if (!rawHandle) return match;

        const lowerHandle = rawHandle.toLowerCase();
        const entity = allMentionables.find((e) => {
          if (e.label?.toLowerCase() === lowerHandle) return true;
          if (e.handle?.toLowerCase() === lowerHandle) return true;
          if (e.name?.toLowerCase() === lowerHandle) return true;
          if (e.id?.toLowerCase() === lowerHandle) return true;
          if (e.type === "agent" && `agent${(e.handle || e.label || "").toLowerCase()}` === lowerHandle) return true;
          if (
            e.aliases?.some(
              (a: string) =>
                a.toLowerCase() === lowerHandle ||
                (e.type === "agent" && `agent${a.toLowerCase()}` === lowerHandle)
            )
          ) {
            return true;
          }
          return false;
        });

        let id = entity?.id;
        let label = entity?.label || entity?.handle || rawHandle;
        let type = entity?.type;
        let avatarUrl = entity?.avatarUrl;
        let color = entity?.color || entity?.hexColor;

        if (!entity) {
          const customResolved = resolveMention?.(rawHandle);
          if (customResolved) {
            id = customResolved.id ?? id;
            label = customResolved.label ?? customResolved.handle ?? label;
            type = customResolved.type ?? type;
            avatarUrl = customResolved.avatarUrl ?? avatarUrl;
            color = customResolved.color ?? customResolved.hexColor ?? color;
          } else {
            const stripped = lowerHandle.replace(/^agent[\s\-_]*/i, "");
            if (
              ["supervisor", "coordinator", "planner", "validator", "executor"].includes(stripped)
            ) {
              type = "agent";
              id = stripped;
              label = stripped;
            } else if (lowerHandle === "agents") {
              type = "team";
              id = "agents";
              label = "agents";
            } else {
              type = defaultType;
              id = rawHandle;
              label = rawHandle;
            }
          }
        }

        const avatarAttr = avatarUrl ? ` data-avatar-url="${escapeHtml(avatarUrl)}"` : "";
        const colorAttr = color ? ` data-color="${escapeHtml(color)}"` : "";

        return `${prefix}<span class="pixerate-mention-node" data-type="mention" data-id="${escapeHtml(
          id || label
        )}" data-label="${escapeHtml(label)}" data-mention-suggestion-char="@" data-type-name="${escapeHtml(
          type || defaultType
        )}"${avatarAttr}${colorAttr}${role ? ` data-role="${escapeHtml(role)}"` : ""}>@${escapeHtml(label)}</span>`;
      };
      if (!options.roles) {
        return part.replace(regex, (match, quotedHandle, escapedQuotedHandle, standardHandle) =>
          render(match, quotedHandle, escapedQuotedHandle, standardHandle),
        );
      }
      // Role syntax: consume a `:role` suffix after each mention.
      let out = "";
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(part)) !== null) {
        const suffix = readRoleSuffix(part, regex.lastIndex, options.roles);
        const rendered = render(match[0], match[1], match[2], match[3], suffix?.role);
        if (suffix && rendered !== match[0]) regex.lastIndex = suffix.end;
        out += part.slice(last, match.index) + rendered;
        last = regex.lastIndex;
      }
      return out + part.slice(last);
    })
    .join("");
}
