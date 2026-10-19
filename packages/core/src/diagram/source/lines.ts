import type { DiagramFamily, Preamble } from "../types.js";

export interface SplitSource {
  eol: "\n" | "\r\n";
  preamble: Preamble;
  /** Header line without EOL; empty string if none was found. */
  header: string;
  /** 0-based index of the header line in the original line array. */
  headerIndex: number;
  bodyLines: string[];
  trailing: string;
}

/** Matches the first token of a diagram header and maps it to a family. */
const HEADER_PATTERNS: [RegExp, DiagramFamily][] = [
  [/^\s*(flowchart|graph)(?:-elk)?\b/i, "flowchart"],
  [/^\s*stateDiagram(?:-v2)?\b/i, "state"],
  [/^\s*classDiagram(?:-v2)?\b/i, "class"],
  [/^\s*erDiagram\b/i, "er"],
  [/^\s*requirementDiagram\b/i, "requirement"],
  [/^\s*mindmap\b/i, "mindmap"],
  [/^\s*sequenceDiagram\b/i, "sequence"],
  [/^\s*gantt\b/i, "gantt"],
  [/^\s*pie\b/i, "pie"],
  [/^\s*journey\b/i, "journey"],
  [/^\s*timeline\b/i, "timeline"],
  [/^\s*gitGraph\b/i, "gitGraph"],
  [/^\s*C4(Context|Container|Component|Dynamic|Deployment)\b/, "c4"],
  [/^\s*quadrantChart\b/i, "quadrant"],
  [/^\s*sankey(?:-beta)?\b/i, "sankey"],
  [/^\s*xychart(?:-beta)?\b/i, "xychart"],
  [/^\s*block(?:-beta)?\b/i, "block"],
  [/^\s*architecture(?:-beta)?\b/i, "architecture"],
  [/^\s*packet(?:-beta)?\b/i, "packet"],
  [/^\s*kanban\b/i, "kanban"],
  [/^\s*radar(?:-beta)?\b/i, "radar"],
  [/^\s*treemap(?:-beta)?\b/i, "treemap"],
  [/^\s*info\b/i, "info"],
];

/** Detects the diagram family of a header line (or whole source). */
export function detectFamilyFromHeader(header: string): DiagramFamily {
  for (const [re, family] of HEADER_PATTERNS) {
    if (re.test(header)) return family;
  }
  return "unknown";
}

export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("%%") && !t.startsWith("%%{");
}

export function isDirectiveLine(line: string): boolean {
  return /^\s*%%\{.*\}%%\s*$/.test(line);
}

/**
 * Splits a Mermaid source into preamble, header, body and trailing whitespace.
 *
 * The preamble is everything before the header: an optional YAML frontmatter
 * block (which must start on the first line), directives, comments and blank
 * lines. All of it is kept verbatim.
 */
export function splitSource(source: string): SplitSource {
  const eol: "\n" | "\r\n" = source.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = source.split(/\r\n|\n/);

  // Trailing: blank lines at the very end (and whether the source ended with EOL)
  let end = rawLines.length;
  while (end > 0 && rawLines[end - 1]!.trim() === "") end--;
  const trailingLines = rawLines.slice(end);
  // If the source ended with an EOL, split() produced a final "" entry. We
  // reconstruct trailing as the exact suffix after the last non-blank line.
  const trailing = trailingLines.length ? eol + trailingLines.join(eol) : "";
  const lines = rawLines.slice(0, end);

  const preambleLines: string[] = [];
  let i = 0;
  let frontmatter: Record<string, unknown> | undefined;

  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    // Frontmatter block
    preambleLines.push(lines[0]);
    i = 1;
    const fm: string[] = [];
    while (i < lines.length && !/^---\s*$/.test(lines[i]!)) {
      fm.push(lines[i]!);
      preambleLines.push(lines[i]!);
      i++;
    }
    if (i < lines.length) {
      preambleLines.push(lines[i]!);
      i++;
    }
    frontmatter = parseSimpleYaml(fm);
  }

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || isDirectiveLine(line) || isCommentLine(line)) {
      preambleLines.push(line);
      i++;
      continue;
    }
    break;
  }

  const headerIndex = i;
  const header = lines[i] ?? "";
  const bodyLines = lines.slice(i + 1);

  return {
    eol,
    preamble: { lines: preambleLines, frontmatter },
    header,
    headerIndex,
    bodyLines,
    trailing,
  };
}

/**
 * Minimal YAML reader for Mermaid frontmatter. Handles scalar `key: value`
 * pairs, JSON flow values (`key: {"a":1}`) and one level of nested maps —
 * enough for `title`, `displayMode`, `config` and the diagram module's own key. Anything
 * else is kept as the raw string.
 */
export function parseSimpleYaml(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let nested: Record<string, unknown> | null = null;
  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const [, key, valueRaw] = m;
    const value = parseYamlScalar(valueRaw!);
    if (indent === 0) {
      currentKey = key!;
      if (valueRaw!.trim() === "") {
        nested = {};
        out[key!] = nested;
      } else {
        nested = null;
        out[key!] = value;
      }
    } else if (nested && currentKey) {
      nested[key!] = value;
    }
  }
  return out;
}

function parseYamlScalar(v: string): unknown {
  const t = v.trim();
  if (t === "") return "";
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Splits a single line into `;`-separated statements, ignoring separators
 * inside quotes or brackets. Mermaid allows `A --> B; B --> C` on one line.
 */
export function splitStatements(line: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}
