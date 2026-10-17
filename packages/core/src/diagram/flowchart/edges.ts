import type { ArrowHead, EdgePattern } from "../types.js";

/**
 * Flowchart link syntax.
 *
 * Grammar (informal):
 *
 *     link      := [edgeId '@'] (plainLink | textLink) [ '|' label '|' ]
 *     plainLink := [head] body [head]
 *     textLink  := [head] open ws label ws close [head]
 *     body      := '--'+ | '=='+ | '-' '.'+ '-' | '~~~'+
 *     head      := '>' | 'x' | 'o' | '<' (start only)
 *
 * @module
 */

export interface ParsedLink {
  /** User-defined edge id (`A e1@--> B`). */
  id?: string;
  pattern: EdgePattern;
  arrowStart: ArrowHead;
  arrowEnd: ArrowHead;
  length: number;
  label?: string;
  /** How the label was written, so regeneration keeps the author's style. */
  labelStyle?: "inline" | "pipe";
  /** Characters consumed from the input. */
  consumed: number;
  raw: string;
}

const START_HEADS: Record<string, ArrowHead> = {
  "<": "arrow_point",
  x: "arrow_cross",
  o: "arrow_circle",
};
const END_HEADS: Record<string, ArrowHead> = {
  ">": "arrow_point",
  x: "arrow_cross",
  o: "arrow_circle",
};

const EDGE_ID = /^([A-Za-z0-9_À-￿-]+)@(?=[<xo]?[-=~.])/;
// Head + body + head. Dotted body is `-` dots `-`.
const PLAIN = /^([<xo](?=[-=~]))?(-{2,}|={2,}|-\.+-|~{3,})([>xo])?/;
// Text link opener: `--`, `-.` or `==` followed by whitespace then label.
const TEXT_OPEN = /^([<xo](?=[-=]))?(--|-\.|==)(?=\s)/;
// Text link closer, searched after the label.
const TEXT_CLOSE = /\s+(-{2,}|\.+-|={2,})([>xo])?(?=$|\s|\||[A-Za-z0-9_À-￿([{>"`&])/;

function patternOf(body: string): EdgePattern {
  if (body.startsWith("~")) return "invisible";
  if (body.startsWith("=")) return "thick";
  if (body.includes(".")) return "dotted";
  return "solid";
}

function lengthOf(body: string, hasEndHead: boolean): number {
  if (body.startsWith("~")) return Math.max(1, body.length - 2);
  if (body.includes(".")) return Math.max(1, (body.match(/\./g) ?? []).length);
  // solid / thick
  return Math.max(1, body.length - (hasEndHead ? 1 : 2));
}

/** Length of a text-link closer (`-->` is 1, `--->` is 2, `.->` is 1, `..->` 2). */
function closerLength(closer: string, hasEndHead: boolean): number {
  if (closer.includes(".")) return Math.max(1, (closer.match(/\./g) ?? []).length);
  return Math.max(1, closer.length - (hasEndHead ? 1 : 2));
}

/**
 * Attempts to parse a link at the start of `input`. Returns `null` when the
 * input does not begin with a link.
 */
export function parseLink(input: string): ParsedLink | null {
  let pos = 0;
  let id: string | undefined;
  const idm = EDGE_ID.exec(input);
  if (idm) {
    id = idm[1]!;
    pos += idm[0].length;
  }
  const rest = input.slice(pos);

  // Text link first: `-- label -->`
  const tm = TEXT_OPEN.exec(rest);
  if (tm) {
    const afterOpen = rest.slice(tm[0].length);
    const cm = TEXT_CLOSE.exec(afterOpen);
    if (cm && cm.index > 0) {
      const label = afterOpen.slice(0, cm.index).trim();
      // Label must not start with a link char (that would be a plain link).
      if (label && !/^[-=.>|]/.test(label)) {
        const closer = cm[1]!;
        const endHead = cm[2];
        const consumed = pos + tm[0].length + cm.index + cm[0].length;
        const body = tm[2]!;
        const result: ParsedLink = {
          id,
          pattern: patternOf(body === "-." ? "-.-" : body),
          arrowStart: tm[1] ? START_HEADS[tm[1]]! : "none",
          arrowEnd: endHead ? END_HEADS[endHead]! : "none",
          length: closerLength(closer, !!endHead),
          label: unquoteLabel(label),
          labelStyle: "inline",
          consumed,
          raw: input.slice(0, consumed),
        };
        return withPipeLabel(input, result);
      }
    }
  }

  const pm = PLAIN.exec(rest);
  if (!pm) return null;
  const body = pm[2]!;
  const endHead = pm[3];
  const consumed = pos + pm[0].length;
  const result: ParsedLink = {
    id,
    pattern: patternOf(body),
    arrowStart: pm[1] ? START_HEADS[pm[1]]! : "none",
    arrowEnd: endHead ? END_HEADS[endHead]! : "none",
    length: lengthOf(body, !!endHead),
    consumed,
    raw: input.slice(0, consumed),
  };
  return withPipeLabel(input, result);
}

/** Consumes an optional `|label|` after the link token. */
function withPipeLabel(input: string, link: ParsedLink): ParsedLink {
  const after = input.slice(link.consumed);
  // A quoted label may contain `|` (Mermaid accepts it, and `quoteLabelIfNeeded`
  // writes it), so try the quoted form before stopping at the first pipe.
  const m = /^\s*\|(\s*"[^"]*"\s*)\|/.exec(after) ?? /^\s*\|([^|]*)\|/.exec(after);
  if (!m) return link;
  const consumed = link.consumed + m[0].length;
  return {
    ...link,
    label: unquoteLabel(m[1]!.trim()),
    labelStyle: link.label ? link.labelStyle : "pipe",
    consumed,
    raw: input.slice(0, consumed),
  };
}

export function unquoteLabel(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/** Characters that force a label to be quoted in Mermaid. */
const NEEDS_QUOTE = /[[\]{}()|<>"#;&%]|^\s|\s$|^-|^=|^\./;

export function quoteLabelIfNeeded(label: string): string {
  if (label === "") return '""';
  if (label.startsWith("`") && label.endsWith("`")) return `"${label}"`;
  if (NEEDS_QUOTE.test(label)) {
    return `"${label.replace(/"/g, "#quot;")}"`;
  }
  return label;
}

const START_CHAR: Partial<Record<ArrowHead, string>> = {
  arrow_point: "<",
  arrow_cross: "x",
  arrow_circle: "o",
};
const END_CHAR: Partial<Record<ArrowHead, string>> = {
  arrow_point: ">",
  arrow_cross: "x",
  arrow_circle: "o",
};

export interface LinkSpec {
  id?: string;
  pattern: EdgePattern;
  arrowStart: ArrowHead;
  arrowEnd: ArrowHead;
  length: number;
  label?: string;
  labelStyle?: "inline" | "pipe";
}

/** Serialises a link back to Mermaid syntax. */
export function formatLink(spec: LinkSpec): string {
  const start = START_CHAR[spec.arrowStart] ?? "";
  const end = END_CHAR[spec.arrowEnd] ?? "";
  const len = Math.max(1, spec.length);
  const label = spec.label?.trim();

  const body = (closing: boolean): string => {
    switch (spec.pattern) {
      case "invisible":
        return "~".repeat(len + 2);
      case "thick":
        return "=".repeat(end ? len + 1 : len + 2);
      case "dotted":
        return closing ? `${".".repeat(len)}-` : `-${".".repeat(len)}-`;
      default:
        return "-".repeat(end ? len + 1 : len + 2);
    }
  };

  const prefix = spec.id ? `${spec.id}@` : "";

  if (label && spec.labelStyle === "inline" && spec.pattern !== "invisible") {
    const open = spec.pattern === "thick" ? "==" : spec.pattern === "dotted" ? "-." : "--";
    return `${prefix}${start}${open} ${quoteLabelIfNeeded(label)} ${body(true)}${end}`;
  }
  const token = `${prefix}${start}${body(false)}${end}`;
  if (label) return `${token}|${quoteLabelIfNeeded(label)}|`;
  return token;
}
