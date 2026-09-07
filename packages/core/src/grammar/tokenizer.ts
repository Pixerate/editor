import {
  TEMPLATE_REGEX,
  VARIABLE_REGEX,
  INSTRUCTION_REGEX,
  Token,
} from "./tokens";

interface RawMatch {
  type: "template" | "variable" | "instruction";
  raw: string;
  value: string;
  start: number;
  end: number;
}

/**
 * Parses any prompt string into an array of typed tokens in linear order.
 * Plain text between tokens is preserved as `{ type: 'text' }`.
 */
export function tokenizePrompt(text: string): Token[] {
  if (!text) {
    return [];
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
      rawMatches.push({
        type: "variable",
        raw: match[0],
        value: match[1].trim(),
        start,
        end,
      });
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

  const tokens: Token[] = [];
  let currentIdx = 0;

  for (const m of rawMatches) {
    if (m.start > currentIdx) {
      const textChunk = text.slice(currentIdx, m.start);
      tokens.push({
        type: "text",
        raw: textChunk,
        value: textChunk,
        start: currentIdx,
        end: m.start,
      });
    }
    tokens.push({
      type: m.type,
      raw: m.raw,
      value: m.value,
      start: m.start,
      end: m.end,
    });
    currentIdx = m.end;
  }

  if (currentIdx < text.length) {
    const textChunk = text.slice(currentIdx);
    tokens.push({
      type: "text",
      raw: textChunk,
      value: textChunk,
      start: currentIdx,
      end: text.length,
    });
  }

  return tokens;
}
