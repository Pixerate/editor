import {
  TEMPLATE_REGEX,
  VARIABLE_REGEX,
  INSTRUCTION_REGEX,
  Token,
  PromptDiagnostic,
} from "./tokens";
import { matchConditionalTags, parseVariableBody } from "./variables";

type RawMatch = Token & { type: "template" | "variable" | "instruction" | "conditional" };

export interface TokenizeResult {
  tokens: Token[];
  /** Unbalanced conditional tags, which were emitted as text. */
  diagnostics: PromptDiagnostic[];
}

/**
 * Parses any prompt string into an array of typed tokens in linear order.
 * Plain text between tokens is preserved as `{ type: 'text' }`.
 *
 * Conditional section tags (`{?name}`, `{!name}`, `{/name}`) are only emitted
 * as `conditional` tokens when balanced; unbalanced tags become text. Use
 * `tokenizePromptWithDiagnostics` to find out which tags were rejected.
 */
export function tokenizePrompt(text: string): Token[] {
  return tokenizePromptWithDiagnostics(text).tokens;
}

/**
 * Returns the diagnostics `tokenizePrompt` would report for `text`.
 */
export function getPromptDiagnostics(text: string): PromptDiagnostic[] {
  return tokenizePromptWithDiagnostics(text).diagnostics;
}

/**
 * Like `tokenizePrompt`, but also reports unbalanced conditional tags.
 */
export function tokenizePromptWithDiagnostics(text: string): TokenizeResult {
  if (!text) {
    return { tokens: [], diagnostics: [] };
  }

  const rawMatches: RawMatch[] = [];

  // Match {{template}}
  const tmplRegex = new RegExp(TEMPLATE_REGEX.source, TEMPLATE_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = tmplRegex.exec(text)) !== null) {
    rawMatches.push({
      type: "template",
      raw: match[0],
      value: match[1].trim(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // Match {variable}
  const varRegex = new RegExp(VARIABLE_REGEX.source, VARIABLE_REGEX.flags);
  while ((match = varRegex.exec(text)) !== null) {
    // Avoid double matching if overlapping with template
    const start = match.index;
    const end = start + match[0].length;
    const overlaps = rawMatches.some(
      (m) => !(end <= m.start || start >= m.end),
    );
    if (!overlaps) {
      const parsed = parseVariableBody(match[1]);
      if (parsed.kind === "conditional") {
        rawMatches.push({
          type: "conditional",
          raw: match[0],
          value: parsed.name,
          start,
          end,
          conditional: parsed.conditional,
        });
      } else {
        const token: RawMatch = {
          type: "variable",
          raw: match[0],
          value: parsed.name,
          start,
          end,
        };
        if (parsed.defaultValue !== undefined) {
          token.defaultValue = parsed.defaultValue;
        }
        if (parsed.description !== undefined) {
          token.description = parsed.description;
        }
        rawMatches.push(token);
      }
    }
  }

  // Match __instruction__
  const instRegex = new RegExp(
    INSTRUCTION_REGEX.source,
    INSTRUCTION_REGEX.flags,
  );
  while ((match = instRegex.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const overlaps = rawMatches.some(
      (m) => !(end <= m.start || start >= m.end),
    );
    if (!overlaps) {
      rawMatches.push({
        type: "instruction",
        raw: match[0],
        value: match[1].trim(),
        start,
        end,
      });
    }
  }

  // Sort matches by start index
  rawMatches.sort((a, b) => a.start - b.start);

  // Pair conditional tags; unbalanced ones are demoted to text below.
  const diagnostics: PromptDiagnostic[] = [];
  const literal = new Set<RawMatch>();
  const conditionals = rawMatches.filter(
    (m): m is RawMatch & Required<Pick<Token, "conditional">> =>
      m.type === "conditional",
  );
  matchConditionalTags(
    conditionals.map((m) => ({ conditional: m.conditional, name: m.value })),
  ).forEach((result, i) => {
    if (!result.error) return;
    const tag = conditionals[i];
    literal.add(tag);
    diagnostics.push({
      code: result.error,
      message:
        result.error === "unclosed-section"
          ? `Section "${tag.raw}" is never closed with "{/${tag.value}}"`
          : `"${tag.raw}" does not close any open section`,
      name: tag.value,
      start: tag.start,
      end: tag.end,
    });
  });

  const tokens: Token[] = [];
  let currentIdx = 0;

  const pushText = (start: number, end: number) => {
    const previous = tokens[tokens.length - 1];
    if (previous?.type === "text" && previous.end === start) {
      // Merge with text produced by a demoted conditional tag.
      previous.raw = previous.value = text.slice(previous.start, end);
      previous.end = end;
      return;
    }
    const textChunk = text.slice(start, end);
    tokens.push({
      type: "text",
      raw: textChunk,
      value: textChunk,
      start,
      end,
    });
  };

  for (const m of rawMatches) {
    if (m.start > currentIdx) {
      pushText(currentIdx, m.start);
    }
    if (literal.has(m)) {
      pushText(m.start, m.end);
    } else {
      tokens.push({ ...m });
    }
    currentIdx = m.end;
  }

  if (currentIdx < text.length) {
    pushText(currentIdx, text.length);
  }

  return { tokens, diagnostics };
}
