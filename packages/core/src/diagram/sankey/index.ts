import { splitSource } from "../source/lines.js";

/**
 * Reading Mermaid `sankey-beta` / `sankey` diagrams into data, for hosts that
 * draw them with their own components (`familyViews`). Sankey diagrams stay
 * render-only: the text is kept verbatim and not edited through `EditOp`s.
 *
 * The grammar follows Mermaid's: after the header, one CSV record per line,
 * `source,target,value`. Fields may be double-quoted, which allows commas and
 * line breaks inside them and `""` for a quote. Fields are trimmed and the
 * value is read with `parseFloat`. Blank lines and `%%` comment lines are
 * skipped. Unlike Mermaid, characters outside ASCII are accepted.
 *
 * @module
 */

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface SankeyData {
  /** Node names in order of first appearance (a link's source, then its target). */
  nodes: string[];
  links: SankeyLink[];
}

/** What went wrong reading a diagram, with its 1-based line in the source. */
export interface DiagramDataError {
  error: string;
  line?: number;
}

export type SankeyParse = { data: SankeyData } | DiagramDataError;

/**
 * Reads a sankey diagram's links. `source` is the whole Mermaid text (with
 * frontmatter and header), e.g. a passthrough document's `doc.source`.
 * Returns an error for text Mermaid would reject (a record without exactly
 * three fields, an unterminated quote, no records) or that has no usable
 * number as its value.
 */
export function parseSankey(source: string): SankeyParse {
  const split = splitSource(source);
  if (!/^\s*sankey(?:-beta)?\b/i.test(split.header)) {
    return { error: "Not a sankey diagram: the first line should be `sankey-beta`." };
  }
  const firstLine = split.headerIndex + 2;
  // Comment lines go first, as Mermaid strips them before parsing.
  const kept: { text: string; line: number }[] = [];
  split.bodyLines.forEach((text, i) => {
    if (/^\s*%%/.test(text)) return;
    kept.push({ text: text.trim(), line: firstLine + i });
  });

  const records = readRecords(kept);
  if ("error" in records) return records;

  const nodes: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      nodes.push(name);
    }
  };
  const links: SankeyLink[] = [];
  for (const { fields, line } of records) {
    if (fields.length !== 3) {
      return {
        error: `Expected three fields (source,target,value), found ${fields.length}.`,
        line,
      };
    }
    const [source, target, raw] = fields as [string, string, string];
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) {
      return { error: `"${raw}" is not a number.`, line };
    }
    add(source);
    add(target);
    links.push({ source, target, value });
  }
  if (!links.length) return { error: "No links: add lines like `A,B,10`." };
  return { data: { nodes, links } };
}

interface CsvRecord {
  fields: string[];
  line: number;
}

/** Splits CSV records; a quoted field may run over several lines. */
function readRecords(lines: { text: string; line: number }[]): CsvRecord[] | DiagramDataError {
  const records: CsvRecord[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = lines[i]!;
    if (start.text === "") {
      i++;
      continue;
    }
    const fields: string[] = [];
    let text = start.text;
    let pos = 0;
    let field = "";
    let quoted = false;
    for (;;) {
      if (quoted) {
        const close = text.indexOf('"', pos);
        if (close < 0) {
          // The quoted field carries on over the next line.
          field += text.slice(pos);
          i++;
          if (i >= lines.length)
            return { error: "A quoted field is never closed.", line: start.line };
          field += "\n";
          text = lines[i]!.text;
          pos = 0;
          continue;
        }
        field += text.slice(pos, close);
        if (text[close + 1] === '"') {
          field += '"';
          pos = close + 2;
          continue;
        }
        quoted = false;
        pos = close + 1;
        // Only spaces may sit between a closing quote and the next comma.
        const rest = /^[ \t]*/.exec(text.slice(pos))![0].length;
        pos += rest;
        if (pos < text.length && text[pos] !== ",") {
          return { error: "Unexpected text after a quoted field.", line: lines[i]!.line };
        }
        continue;
      }
      if (pos >= text.length) {
        fields.push(field.trim());
        break;
      }
      const ch = text[pos]!;
      if (ch === ",") {
        fields.push(field.trim());
        field = "";
        pos++;
      } else if (ch === '"' && field.trim() === "") {
        quoted = true;
        field = "";
        pos++;
      } else if (ch === '"') {
        return { error: "A quote inside an unquoted field.", line: lines[i]!.line };
      } else {
        field += ch;
        pos++;
      }
    }
    records.push({ fields, line: start.line });
    i++;
  }
  return records;
}
