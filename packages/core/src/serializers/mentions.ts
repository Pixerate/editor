import { escapeHtml } from "./plain-text";
import type { MentionEntity } from "../extensions/mention";

/**
 * Canonical regex pattern for matching @mentions in plain text or markdown.
 * Supports:
 * - Standard unquoted handles: @username, @user.name, @team_alpha, @sa-1
 * - Quoted handles: @"John Doe", &quot;Jane Doe&quot;
 * Unquoted handles exclude trailing punctuation (e.g. @violet. matches "violet" without the dot).
 */
export const MENTION_REGEX =
  /(?:^|[\s>(*_"';\\/[\]{}~`:]|&quot;|&gt;|&lt;|&amp;)@(?:"([^"]+)"|&quot;([^&]+)&quot;|([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*))/g;

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
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/<pre[\s\S]*?<\/pre>/gi, "")
    .replace(/<code[\s\S]*?<\/code>/gi, "")
    .replace(/`[^`\n]*`/g, "");
}

/**
 * Extracts unique mention handles from a text, markdown, or HTML string,
 * ignoring trailing punctuation, code blocks, URLs, and pre-existing HTML mention attributes.
 */
export function extractMentions(content: string): string[] {
  if (!content || typeof content !== "string") return [];

  // Normalize existing HTML mention nodes (e.g. from TipTap or rich text serializers)
  // so data-mention-suggestion-char="@" does not trigger spurious quoted matches against attributes,
  // and ensure the actual mentioned label or ID is preserved cleanly.
  const normalizedMentionNodes = content.replace(
    /<span\b[^>]*\b(?:data-type=["']mention["']|class=["'][^"']*pixerate-mention-node[^"']*["'])[^>]*>([\s\S]*?)<\/span>/gi,
    (match, inner) => {
      const labelMatch = match.match(/\bdata-label=["']([^"']+)["']/i);
      if (labelMatch) return ` @${labelMatch[1]} `;
      const idMatch = match.match(/\bdata-id=["']([^"']+)["']/i);
      if (idMatch) return ` @${idMatch[1]} `;
      return ` ${inner} `;
    }
  );

  const cleanContent = stripMarkdownCode(normalizedMentionNodes);
  // Strip URLs and markdown link destinations so @package or @handles in URLs are not extracted as mentions
  const withoutUrls = cleanContent
    .replace(/(?:https?|ftp|file|vscode|cursor|mailto):\/\/[^\s<>()]+/gi, "")
    .replace(/\]\([^)]*\)/g, "]");
  // Strip remaining HTML tags so attributes containing '@' or '>' aren't treated as mention triggers
  const textOnly = withoutUrls.replace(/<[^>]+>/g, " ");

  const mentions: string[] = [];
  const seen = new Set<string>();

  const regex = new RegExp(MENTION_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(textOnly)) !== null) {
    const handle = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      mentions.push(handle);
    }
  }

  return mentions;
}

/**
 * Segments a text string into plain text parts and mention tokens.
 * Correctly leaves trailing punctuation (like ".") as part of the following text segment.
 */
export function parseMentionSegments(content: string): MentionSegment[] {
  if (!content) return [];

  const segments: MentionSegment[] = [];
  const regex = new RegExp(MENTION_REGEX.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const fullMatch = match[0];
    const atIndex = fullMatch.indexOf("@");
    const prefix = atIndex > 0 ? fullMatch.slice(0, atIndex) : "";
    const mentionToken = fullMatch.slice(atIndex);
    const handle = match[1] ?? match[2] ?? match[3];
    const matchStart = match.index + prefix.length;

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
      return part.replace(regex, (match, quotedHandle, escapedQuotedHandle, standardHandle) => {
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
        )}"${avatarAttr}${colorAttr}>@${escapeHtml(label)}</span>`;
      });
    })
    .join("");
}
