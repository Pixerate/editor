import type { DiagramFamily } from "../types.js";
import { detectFamilyFromHeader, splitSource } from "./lines.js";

/** A Mermaid diagram found in some text by {@link findMermaidSources}. */
export interface FoundMermaid {
  /** The diagram's Mermaid text, without any surrounding code fence. */
  source: string;
  /** Its family (never `"unknown"`). */
  family: DiagramFamily;
  /** The frontmatter `title`, else the Markdown heading above its code fence. */
  title?: string;
}

/** Fence info strings that mark a Mermaid block. */
const MERMAID_INFO = /^(mermaid|mmd)\b/i;

/**
 * Finds the Mermaid diagrams in a piece of text: a `.mmd` file, a Markdown
 * document with ```` ```mermaid ```` blocks (GitHub, Notion and most AI
 * chats write them like this), or a diagram pasted with or without its fence.
 *
 * Fenced blocks are used when there are any: those marked `mermaid` / `mmd`,
 * and unmarked ones whose first line is a Mermaid header. Otherwise the whole
 * text is one diagram if it starts with one. Unmarked text must spell the
 * keyword as Mermaid does (`timeline`, not `Timeline`). Text that holds no
 * diagram of a known family returns `[]`.
 */
export function findMermaidSources(text: string): FoundMermaid[] {
  const clean = text.replace(/^\uFEFF/, "");
  const blocks = fencedBlocks(clean);
  if (blocks.length) {
    const found: FoundMermaid[] = [];
    for (const block of blocks) {
      if (block.info && !MERMAID_INFO.test(block.info)) continue;
      const item = asDiagram(block.body, block.heading, !block.info);
      if (item) found.push(item);
    }
    if (found.length) return found;
  }
  const whole = asDiagram(clean.trim(), undefined, true);
  return whole ? [whole] : [];
}

/**
 * `strict` (unmarked text) also wants the keyword's own case, as Mermaid
 * writes it, so prose such as "Timeline of events" is not taken for a diagram.
 */
function asDiagram(source: string, heading?: string, strict = false): FoundMermaid | undefined {
  if (!source.trim()) return undefined;
  const split = splitSource(source);
  const family = detectFamilyFromHeader(split.header);
  if (family === "unknown") return undefined;
  if (strict && !/^\s*([a-z]|C4)/.test(split.header)) return undefined;
  const fmTitle = split.preamble.frontmatter?.title;
  const title = typeof fmTitle === "string" && fmTitle.trim() ? fmTitle.trim() : heading;
  return { source: source.trimEnd() + "\n", family, ...(title ? { title } : {}) };
}

interface FencedBlock {
  info: string;
  body: string;
  /** The last Markdown heading before the fence. */
  heading?: string;
}

/** CommonMark-style fenced code blocks (``` or ~~~, three or more, indented up to three spaces). */
function fencedBlocks(text: string): FencedBlock[] {
  const lines = text.split(/\r\n|\n/);
  const blocks: FencedBlock[] = [];
  let heading: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    // Patterns kept free of overlapping runs, so long lines cannot make them backtrack.
    const open = /^ {0,3}(`{3,}(?!`)|~{3,}(?!~))([^`]*)$/.exec(lines[i]!);
    if (!open) {
      const h = headingText(lines[i]!);
      if (h) heading = h;
      continue;
    }
    const fence = open[1]!;
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}$`);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j]!.trimEnd())) body.push(lines[j++]!);
    blocks.push({ info: open[2]!.trim(), body: body.join("\n"), heading });
    i = j;
  }
  return blocks;
}

/** The text of an ATX heading (`## Title ##`), without its markers. */
function headingText(line: string): string | undefined {
  const m = /^ {0,3}#{1,6}([ \t].*)$/.exec(line);
  if (!m) return undefined;
  let text = m[1]!.trim();
  // A closing run of `#` counts only after a space (or when it is all there is).
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  if (end === 0 || text[end - 1] === " " || text[end - 1] === "\t") text = text.slice(0, end).trim();
  return text || undefined;
}
