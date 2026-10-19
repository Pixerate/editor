import type { ArrowHead, EdgePattern } from "../types.js";
import { parseLink, quoteLabelIfNeeded, unquoteLabel, formatLink } from "./edges.js";
import {
  BRACKET_OPENERS,
  closersFor,
  shapeForBracket,
  canonicalShape,
  resolveShape,
} from "./shapes.js";

/**
 * Statement-level model of a flowchart body. Every line of the source maps
 * to exactly one statement (multi-line `@{ … }` blocks and `;`-joined
 * statements are normalised during tokenisation). Statements remember their
 * raw text and are re-emitted verbatim unless marked `dirty`.
 *
 * @module
 */

export interface NodeRef {
  id: string;
  /** Shape when declared on this occurrence (bracket or data syntax). */
  shape?: string;
  /** How the shape was expressed: classic brackets or `@{ … }`. */
  form?: "bracket" | "data";
  label?: string;
  labelQuoted?: boolean;
  /** Parsed `@{ … }` entries (shape/label removed). Values keep their raw text. */
  data?: Record<string, string>;
  classes: string[];
}

export interface LinkRef {
  id?: string;
  pattern: EdgePattern;
  arrowStart: ArrowHead;
  arrowEnd: ArrowHead;
  length: number;
  label?: string;
  labelStyle?: "inline" | "pipe";
}

export interface Chain {
  /** `groups[i]` are the nodes joined by `&`; `links[i]` connects group i → i+1. */
  groups: NodeRef[][];
  links: LinkRef[];
}

export type FlowStatement =
  | { kind: "raw"; raw: string }
  | { kind: "chain"; raw: string; indent: string; chain: Chain; dirty?: boolean }
  | {
      kind: "subgraph";
      raw: string;
      indent: string;
      id: string;
      title?: string;
      /** `subgraph id [title]` vs `subgraph "title"` */
      titleForm: "bracket" | "bare" | "none";
      dirty?: boolean;
    }
  | { kind: "end"; raw: string; indent: string }
  | { kind: "direction"; raw: string; indent: string; direction: string; dirty?: boolean }
  | {
      kind: "classDef";
      raw: string;
      indent: string;
      names: string[];
      styles: string[];
      dirty?: boolean;
    }
  | {
      kind: "class";
      raw: string;
      indent: string;
      ids: string[];
      className: string;
      dirty?: boolean;
    }
  | { kind: "style"; raw: string; indent: string; id: string; styles: string[]; dirty?: boolean }
  | {
      kind: "linkStyle";
      raw: string;
      indent: string;
      targets: number[] | "default";
      styles: string[];
      dirty?: boolean;
    }
  | { kind: "click"; raw: string; indent: string; id: string; rest: string; dirty?: boolean };

// ---------------------------------------------------------------------------
// Tokenisation helpers
// ---------------------------------------------------------------------------

/**
 * Mermaid's NODE_STRING: letters, digits and a generous set of punctuation,
 * plus `-` when not followed by `>`, `-` or `.`, and `=` when not followed by `=`.
 */
function readId(input: string, pos: number): string {
  let i = pos;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (/[A-Za-z0-9_À-￿!#$%*+?/\\'`]/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "." && next !== "-") {
      i++;
      continue;
    }
    if (
      ch === "-" &&
      next !== ">" &&
      next !== "-" &&
      next !== "." &&
      next !== undefined &&
      !/\s/.test(next)
    ) {
      i++;
      continue;
    }
    if (ch === "=" && next !== "=") {
      i++;
      continue;
    }
    break;
  }
  return input.slice(pos, i);
}

/** Finds the first occurrence of any closer outside double quotes. */
function findCloser(
  input: string,
  pos: number,
  closers: string[],
): { index: number; closer: string } | null {
  let quote: string | null = null;
  for (let i = pos; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"') {
      quote = ch;
      continue;
    }
    for (const closer of closers) {
      if (input.startsWith(closer, i)) return { index: i, closer };
    }
  }
  return null;
}

/** Reads a balanced `{ … }` block starting at `pos` (which must be `{`). */
function readBraceBlock(input: string, pos: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = pos; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Parses the inside of `@{ … }` into key → raw value. */
export function parseShapeData(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on commas/newlines outside quotes.
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "," || ch === "\n") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*([\s\S]*?)\s*$/.exec(part);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function unquoteData(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function formatShapeData(data: Record<string, string>): string {
  const entries = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  return `@{ ${entries.join(", ")} }`;
}

/**
 * Parses one node reference at `pos`. Returns `null` when no id is present.
 */
function readNode(input: string, pos: number): { node: NodeRef; end: number } | null {
  const id = readId(input, pos);
  if (!id) return null;
  let i = pos + id.length;
  const node: NodeRef = { id, classes: [] };

  // Data syntax: id@{ ... }
  if (input[i] === "@" && input[i + 1] === "{") {
    const end = readBraceBlock(input, i + 1);
    if (end !== -1) {
      const inner = input.slice(i + 2, end - 1);
      const data = parseShapeData(inner);
      node.form = "data";
      if (data.shape !== undefined) {
        node.shape = canonicalShape(unquoteData(data.shape));
        delete data.shape;
      }
      if (data.label !== undefined) {
        node.label = unquoteData(data.label);
        node.labelQuoted = /^\s*["']/.test(data.label);
        delete data.label;
      }
      // Mermaid draws a node with `img` as an image and one with `icon` as an
      // icon, whatever its `shape` says.
      if ("img" in data) node.shape = "image";
      else if ("icon" in data && node.shape === undefined) node.shape = "icon";
      node.data = data;
      i = end;
    }
  } else {
    // Bracket syntax
    for (const open of BRACKET_OPENERS) {
      if (!input.startsWith(open, i)) continue;
      const closers = closersFor(open);
      const found = findCloser(input, i + open.length, closers);
      if (!found) break;
      const shapeDef = shapeForBracket(open, found.closer);
      if (!shapeDef) break;
      const rawLabel = input.slice(i + open.length, found.index);
      node.shape = shapeDef.name;
      node.form = "bracket";
      node.label = unquoteLabel(rawLabel);
      node.labelQuoted = rawLabel.trim().startsWith('"');
      i = found.index + found.closer.length;
      break;
    }
  }

  // :::class (repeatable)
  while (input.startsWith(":::", i)) {
    const cls = readId(input, i + 3);
    if (!cls) break;
    node.classes.push(cls);
    i += 3 + cls.length;
  }
  return { node, end: i };
}

function skipWs(input: string, pos: number): number {
  let i = pos;
  while (i < input.length && /\s/.test(input[i]!)) i++;
  return i;
}

/**
 * Parses a chain statement (`A[x] --> B & C -- t --> D:::k`).
 * Returns `null` if the text is not a chain.
 */
export function parseChain(text: string): Chain | null {
  const groups: NodeRef[][] = [];
  const links: LinkRef[] = [];
  let pos = skipWs(text, 0);
  let group: NodeRef[] = [];

  const first = readNode(text, pos);
  if (!first) return null;
  group.push(first.node);
  pos = skipWs(text, first.end);

  while (pos < text.length) {
    if (text[pos] === "&") {
      pos = skipWs(text, pos + 1);
      const n = readNode(text, pos);
      if (!n) return null;
      group.push(n.node);
      pos = skipWs(text, n.end);
      continue;
    }
    const link = parseLink(text.slice(pos));
    if (link) {
      groups.push(group);
      group = [];
      links.push({
        id: link.id,
        pattern: link.pattern,
        arrowStart: link.arrowStart,
        arrowEnd: link.arrowEnd,
        length: link.length,
        label: link.label,
        labelStyle: link.labelStyle,
      });
      pos = skipWs(text, pos + link.consumed);
      const n = readNode(text, pos);
      if (!n) return null;
      group.push(n.node);
      pos = skipWs(text, n.end);
      continue;
    }
    return null; // trailing garbage
  }
  groups.push(group);
  return { groups, links };
}

// ---------------------------------------------------------------------------
// Statement classification
// ---------------------------------------------------------------------------

function splitStyles(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Classifies a single logical statement line. */
export function parseStatement(line: string): FlowStatement {
  const indent = line.match(/^\s*/)![0];
  const text = line.trim();
  if (text === "" || text.startsWith("%%")) return { kind: "raw", raw: line };

  let m: RegExpExecArray | null;

  if (/^end\s*$/i.test(text)) return { kind: "end", raw: line, indent };

  if ((m = /^direction\s+(TB|TD|BT|LR|RL)\s*$/i.exec(text))) {
    return { kind: "direction", raw: line, indent, direction: m[1]!.toUpperCase() };
  }

  if ((m = /^subgraph\s+(.*)$/i.exec(text))) {
    const rest = m[1]!.trim();
    let sm: RegExpExecArray | null;
    if ((sm = /^([^\s["]+)\s*\[(.*)\]\s*$/.exec(rest))) {
      return {
        kind: "subgraph",
        raw: line,
        indent,
        id: sm[1]!,
        title: unquoteLabel(sm[2]!),
        titleForm: "bracket",
      };
    }
    if ((sm = /^"(.*)"\s*$/.exec(rest))) {
      return { kind: "subgraph", raw: line, indent, id: sm[1]!, title: sm[1]!, titleForm: "bare" };
    }
    if (/\s/.test(rest)) {
      // `subgraph My Title` — id is the title text, as Mermaid does.
      return { kind: "subgraph", raw: line, indent, id: rest, title: rest, titleForm: "bare" };
    }
    return { kind: "subgraph", raw: line, indent, id: rest, titleForm: "none" };
  }

  if ((m = /^classDef\s+([^\s]+)\s+(.*)$/.exec(text))) {
    return {
      kind: "classDef",
      raw: line,
      indent,
      names: m[1]!.split(","),
      styles: splitStyles(m[2]!),
    };
  }

  if ((m = /^class\s+([^\s]+)\s+([^\s]+)\s*$/.exec(text))) {
    return { kind: "class", raw: line, indent, ids: m[1]!.split(","), className: m[2]! };
  }

  if ((m = /^style\s+([^\s]+)\s+(.*)$/.exec(text))) {
    return { kind: "style", raw: line, indent, id: m[1]!, styles: splitStyles(m[2]!) };
  }

  if ((m = /^linkStyle\s+(default|[\d,\s]+)\s+(.*)$/.exec(text))) {
    const targets =
      m[1] === "default"
        ? ("default" as const)
        : m[1]!
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => !Number.isNaN(n));
    return { kind: "linkStyle", raw: line, indent, targets, styles: splitStyles(m[2]!) };
  }

  if ((m = /^click\s+([^\s]+)\s+(.*)$/.exec(text))) {
    return { kind: "click", raw: line, indent, id: m[1]!, rest: m[2]! };
  }

  if (/^(accTitle|accDescr)\b/.test(text) || /^title\s/.test(text))
    return { kind: "raw", raw: line };

  const chain = parseChain(text);
  if (chain) return { kind: "chain", raw: line, indent, chain };

  return { kind: "raw", raw: line };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export function formatNode(node: NodeRef): string {
  let out = node.id;
  const shape = node.shape ? resolveShape(node.shape) : undefined;
  const useData =
    node.form === "data" ||
    (node.shape && !shape?.bracket) ||
    (node.data && Object.keys(node.data).length);
  if (
    useData &&
    (node.shape || node.label !== undefined || (node.data && Object.keys(node.data).length))
  ) {
    const data: Record<string, string> = {};
    // Mermaid infers these shapes from `img` / `icon` (and has no `shape: image`).
    const implied =
      (node.shape === "image" && node.data && "img" in node.data) ||
      (node.shape === "icon" && node.data && "icon" in node.data);
    if (node.shape && !implied) data.shape = node.shape;
    if (node.label !== undefined) data.label = JSON.stringify(node.label);
    Object.assign(data, node.data ?? {});
    out += formatShapeData(data);
  } else if (
    shape?.bracket &&
    (node.label !== undefined || node.shape !== "rect" || node.form === "bracket")
  ) {
    const label = node.label ?? node.id;
    const text = node.labelQuoted
      ? `"${label.replace(/"/g, "#quot;")}"`
      : quoteLabelIfNeeded(label);
    out += `${shape.bracket.open}${text}${shape.bracket.close}`;
  } else if (node.label !== undefined && node.label !== node.id) {
    out += `[${quoteLabelIfNeeded(node.label)}]`;
  }
  for (const cls of node.classes) out += `:::${cls}`;
  return out;
}

export function formatChain(chain: Chain): string {
  const parts: string[] = [];
  chain.groups.forEach((group, i) => {
    parts.push(group.map(formatNode).join(" & "));
    const link = chain.links[i];
    if (link) parts.push(formatLink(link));
  });
  return parts.join(" ");
}

export function formatStatement(stmt: FlowStatement): string {
  if (stmt.kind === "raw" || stmt.kind === "end") return stmt.raw;
  if (!stmt.dirty) return stmt.raw;
  switch (stmt.kind) {
    case "chain":
      return stmt.indent + formatChain(stmt.chain);
    case "subgraph": {
      if (stmt.titleForm === "none" || stmt.title === undefined)
        return `${stmt.indent}subgraph ${stmt.id}`;
      if (stmt.titleForm === "bare")
        return `${stmt.indent}subgraph ${stmt.title.includes(" ") || stmt.title !== stmt.id ? `"${stmt.title}"` : stmt.title}`;
      return `${stmt.indent}subgraph ${stmt.id} [${quoteLabelIfNeeded(stmt.title)}]`;
    }
    case "direction":
      return `${stmt.indent}direction ${stmt.direction}`;
    case "classDef":
      return `${stmt.indent}classDef ${stmt.names.join(",")} ${stmt.styles.join(",")}`;
    case "class":
      return `${stmt.indent}class ${stmt.ids.join(",")} ${stmt.className}`;
    case "style":
      return `${stmt.indent}style ${stmt.id} ${stmt.styles.join(",")}`;
    case "linkStyle":
      return `${stmt.indent}linkStyle ${stmt.targets === "default" ? "default" : stmt.targets.join(",")} ${stmt.styles.join(",")}`;
    case "click":
      return `${stmt.indent}click ${stmt.id} ${stmt.rest}`;
  }
}

/**
 * Joins physical lines into logical statements: a line with an unclosed
 * `@{` absorbs following lines until the block closes. Returns the logical
 * statements and, for each, how many physical lines it spans.
 */
export function joinLogicalLines(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let cur = lines[i]!;
    const at = cur.indexOf("@{");
    if (at !== -1 && readBraceBlock(cur, at + 1) === -1) {
      let j = i + 1;
      while (j < lines.length) {
        cur += "\n" + lines[j];
        j++;
        if (readBraceBlock(cur, at + 1) !== -1) break;
      }
      out.push(cur);
      i = j;
      continue;
    }
    out.push(cur);
    i++;
  }
  return out;
}
