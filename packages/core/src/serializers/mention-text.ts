/**
 * Dependency-free mention text helpers: the `@handle` pattern, the opt-in
 * `@handle:role` suffix used by asset mentions, and offset-based editing of
 * mentions in plain prompt text. Kept apart from `mentions.ts` (which pulls in
 * the HTML serializers) so `@pixerate/editor/generation` can re-export them.
 */

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
 * Which `@handle:role` suffixes are read as a mention role: `true` for any
 * role name, or a list of accepted roles (matched case-insensitively and
 * returned as listed). Off by default, so `@john:` text is unchanged.
 */
export type MentionRoleSyntax = true | readonly string[];

/** Marks a role taken from a mention node's `data-role` while extracting (never in output). */
export const NODE_ROLE_MARK = "\u0001";
const ROLE_SUFFIX_REGEX = /[:\u0001]([A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)(?![A-Za-z0-9])/y;
const PLAIN_HANDLE_REGEX = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;

/**
 * Reads a `:role` suffix at `index`. Returns the role (as listed in `roles`)
 * and the index after it, or `null`. A suffix taken from a mention node
 * (`NODE_ROLE_MARK`) is accepted whatever `roles` says.
 */
export function readRoleSuffix(
  text: string,
  index: number,
  roles: MentionRoleSyntax | undefined,
): { role: string; end: number } | null {
  const first = text.charAt(index);
  if (first !== ":" && first !== NODE_ROLE_MARK) return null;
  if (first === ":" && !roles) return null;
  ROLE_SUFFIX_REGEX.lastIndex = index;
  const match = ROLE_SUFFIX_REGEX.exec(text);
  if (!match) return null;
  let role = match[1];
  if (first === ":" && roles !== true) {
    const lower = role.toLowerCase();
    const listed = (roles as readonly string[]).find((r) => r.toLowerCase() === lower);
    if (listed === undefined) return null;
    role = listed;
  }
  return { role, end: index + match[0].length };
}

/** `@label`, quoted when the label is not a plain handle (and has no `"`). */
export function formatMentionHandle(label: string): string {
  return PLAIN_HANDLE_REGEX.test(label) || label.includes('"') ? `@${label}` : `@"${label}"`;
}

/**
 * Formats a mention as text: `@handle` or `@handle:role` (quoted as
 * `@"Two words":role` when the handle is not a plain handle).
 */
export function formatMentionText(handle: string, role?: string | null): string {
  return role ? `${formatMentionHandle(handle)}:${role}` : formatMentionHandle(handle);
}

/** A mention found in plain text, with offsets into that text. */
export interface TextMention {
  handle: string;
  role?: string;
  /** Offset of the `@`. */
  start: number;
  /** Offset just past the handle (and role, when present). */
  end: number;
  /** Offset just past the handle (where a `:role` suffix starts). */
  handleEnd: number;
}

/**
 * Every mention in plain text (prompt text), in order, with offsets and
 * `@handle:role` roles (`roles` defaults to `true` here). Unlike
 * {@link extractMentions} it does not skip code or URLs and keeps duplicates.
 */
export function findTextMentions(text: string, options: { roles?: MentionRoleSyntax | false } = {}): TextMention[] {
  if (!text || typeof text !== "string") return [];
  const roles = options.roles === false ? undefined : (options.roles ?? true);
  const result: TextMention[] = [];
  const regex = new RegExp(MENTION_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const handle = match[1] ?? match[2] ?? match[3] ?? "";
    const start = match.index + match[0].indexOf("@");
    const handleEnd = regex.lastIndex;
    const suffix = text.charAt(handleEnd) === ":" ? readRoleSuffix(text, handleEnd, roles) : null;
    if (suffix) regex.lastIndex = suffix.end;
    result.push({
      handle,
      ...(suffix ? { role: suffix.role } : {}),
      start,
      end: suffix ? suffix.end : handleEnd,
      handleEnd,
    });
  }
  return result;
}

/**
 * Sets (or with `null` removes) the `:role` of the text mention starting at
 * offset `start` (its `@`). Returns the text unchanged when no mention starts there.
 */
export function setMentionRoleInText(
  text: string,
  start: number,
  role: string | null,
  options: { roles?: MentionRoleSyntax } = {},
): string {
  const mention = findTextMentions(text, { roles: options.roles ?? true }).find((m) => m.start === start);
  if (!mention) return text;
  if (role !== null && !/^[A-Za-z](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(role)) {
    throw new Error(`Invalid mention role "${role}".`);
  }
  const suffix = role ? `:${role}` : "";
  return text.slice(0, mention.handleEnd) + suffix + text.slice(mention.end);
}

