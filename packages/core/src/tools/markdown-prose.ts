/**
 * Where the prose is in Markdown source (#892), for the text mechanics checks: the text blocks
 * (paragraphs, headings and the rest) with the containers they sit in, and the ranges of plain
 * text inside them. Code, math, HTML, front matter, tables, link destinations, images,
 * autolinks and syntax markers are not prose.
 *
 * This is a light reader for what the checks need, not a full CommonMark parser: it reads
 * blocks line by line and finds the inline constructs that aren't prose. The Swift port builds
 * the same map from PixerateMarkdown's `MarkdownDocument`, which has exact ranges; the shared
 * contracts compare what the checks do, not the maps. Offsets are UTF-16 code units, as
 * JavaScript strings and `NSString` count them.
 */

/** The kind of a text block. */
export type MarkdownProseBlockKind =
  | "paragraph"
  | "heading"
  | "code"
  | "html"
  | "table"
  | "frontMatter"
  | "thematicBreak"
  | "linkDefinition";

/** A container a block sits in. */
export type MarkdownProseContainer =
  "listItem" | "quote" | "alert" | "footnote";

export interface MarkdownProseBlock {
  kind: MarkdownProseBlockKind;
  /** The block's source range, markers included. */
  from: number;
  to: number;
  /** Where the block's first text starts (after `# `, `- `, `> ` and the like), or -1. */
  firstText: number;
  /** The containers it sits in, outermost first. */
  within: MarkdownProseContainer[];
}

export interface MarkdownProseMap {
  blocks: MarkdownProseBlock[];
  /** Ranges of plain text, in order. */
  prose: { from: number; to: number }[];
}

interface Line {
  from: number;
  /** End of the line's text (the newline's offset, or the end of the source). */
  to: number;
  text: string;
}

const splitLines = (source: string): Line[] => {
  const lines: Line[] = [];
  let from = 0;
  for (;;) {
    const nl = source.indexOf("\n", from);
    const to = nl < 0 ? source.length : nl;
    lines.push({ from, to, text: source.slice(from, to) });
    if (nl < 0) return lines;
    from = nl + 1;
  }
};

const FENCE = /^ {0,3}(`{3,}|~{3,}|\$\$)/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const HTML_BLOCK = /^ {0,3}<(?:!--|\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;
const LINK_DEF = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;
const FOOTNOTE_DEF = /^ {0,3}\[\^[^\]\s]+\]:[ \t]?/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TASK = /^\[[ xX]\][ \t]+/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ALERT = /^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;
const TABLE_DELIMITER =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** A line with its container markers taken off, and the containers they open or continue. */
interface Stripped {
  /** Offset of the content after the markers. */
  contentFrom: number;
  content: string;
  within: MarkdownProseContainer[];
  /** A list item or footnote marker on this line starts a new item. */
  startsItem: boolean;
  /** The line is an alert's `[!NOTE]` marker. */
  alertMarker: boolean;
}

/**
 * Reads where the prose is in `source`. Front matter is only recognised at the very start. GFM
 * tables, alerts (`> [!NOTE]`), footnotes, task lists, inline math (`$…$`) and display math
 * (`$$`) are understood.
 */
export function markdownProseMap(source: string): MarkdownProseMap {
  const lines = splitLines(source);
  const blocks: MarkdownProseBlock[] = [];
  const prose: { from: number; to: number }[] = [];
  let i = 0;

  // Front matter
  if (lines.length > 1 && /^(---|\+\+\+)[ \t]*$/.test(lines[0].text)) {
    const close =
      lines[0].text.trim() === "---"
        ? /^(---|\.\.\.)[ \t]*$/
        : /^\+\+\+[ \t]*$/;
    for (let j = 1; j < lines.length; j++) {
      if (close.test(lines[j].text)) {
        blocks.push({
          kind: "frontMatter",
          from: 0,
          to: lines[j].to,
          firstText: -1,
          within: [],
        });
        i = j + 1;
        break;
      }
    }
  }

  /** The containers of the current list item or quote, carried by indented continuation lines. */
  let openItem: { indent: number; within: MarkdownProseContainer[] } | null =
    null;
  let openAlert = false;

  const strip = (line: Line): Stripped => {
    let content = line.text;
    let offset = line.from;
    const within: MarkdownProseContainer[] = [];
    let startsItem = false;
    let alertMarker = false;
    // Continuation of an open list item: its indent, then its containers
    if (openItem && content.trim()) {
      const indent = /^[ \t]*/.exec(content)![0].length;
      if (
        indent >= openItem.indent &&
        !LIST_ITEM.test(
          content
            .slice(Math.min(indent, openItem.indent))
            .replace(/^ {4,}/, ""),
        )
      ) {
        within.push(...openItem.within);
        content = content.slice(openItem.indent);
        offset += openItem.indent;
      } else if (indent < openItem.indent) {
        openItem = null;
      }
    }
    for (;;) {
      const quote = QUOTE.exec(content);
      if (quote) {
        const rest = content.slice(quote[0].length);
        if (ALERT.test(rest)) {
          openAlert = true;
          alertMarker = true;
        }
        within.push(openAlert ? "alert" : "quote");
        content = rest;
        offset += quote[0].length;
        continue;
      }
      const footnote = FOOTNOTE_DEF.exec(content);
      if (footnote) {
        within.push("footnote");
        content = content.slice(footnote[0].length);
        offset += footnote[0].length;
        startsItem = true;
        openItem = { indent: 4, within: [...within] };
        continue;
      }
      const item = LIST_ITEM.exec(content);
      if (item && !THEMATIC.test(content)) {
        within.push("listItem");
        const marker = item[0].length;
        content = content.slice(marker);
        offset += marker;
        const task = TASK.exec(content);
        if (task) {
          content = content.slice(task[0].length);
          offset += task[0].length;
        }
        startsItem = true;
        openItem = { indent: offset - line.from, within: [...within] };
        continue;
      }
      break;
    }
    return { contentFrom: offset, content, within, startsItem, alertMarker };
  };

  const sameWithin = (
    a: MarkdownProseContainer[],
    b: MarkdownProseContainer[],
  ) => a.length === b.length && a.every((c, k) => c === b[k]);

  while (i < lines.length) {
    const line = lines[i];
    if (!line.text.trim()) {
      // A blank line ends paragraphs and alerts; list items continue past it when indented
      if (!/^ {0,3}>/.test(line.text)) openAlert = false;
      i++;
      continue;
    }
    const s = strip(line);
    if (!s.within.includes("quote") && !s.within.includes("alert"))
      openAlert = false;
    if (s.alertMarker || !s.content.trim()) {
      i++;
      continue;
    }
    const content = s.content;

    // Fenced code and display math
    const fence = FENCE.exec(content);
    if (fence) {
      const mark = fence[1];
      const closing =
        mark === "$$"
          ? /^\s*\$\$\s*$/
          : new RegExp(
              `^\\s*${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`,
            );
      let j = i + 1;
      // `$$ … $$` on one line
      const oneLine =
        mark === "$$" &&
        content.trim().length > 2 &&
        content.trim().endsWith("$$");
      if (!oneLine) {
        while (j < lines.length && !closing.test(strip(lines[j]).content)) j++;
      } else {
        j = i;
      }
      const end = Math.min(j, lines.length - 1);
      blocks.push({
        kind: "code",
        from: line.from,
        to: lines[end].to,
        firstText: -1,
        within: s.within,
      });
      i = end + 1;
      continue;
    }
    // Indented code (four spaces, outside a list item)
    if (
      /^( {4}|\t)/.test(content) &&
      !s.within.includes("listItem") &&
      !s.within.includes("footnote")
    ) {
      let j = i;
      while (
        j + 1 < lines.length &&
        (/^( {4}|\t)/.test(lines[j + 1].text) || !lines[j + 1].text.trim())
      )
        j++;
      while (j > i && !lines[j].text.trim()) j--;
      blocks.push({
        kind: "code",
        from: line.from,
        to: lines[j].to,
        firstText: -1,
        within: s.within,
      });
      i = j + 1;
      continue;
    }
    if (THEMATIC.test(content)) {
      blocks.push({
        kind: "thematicBreak",
        from: line.from,
        to: line.to,
        firstText: -1,
        within: s.within,
      });
      i++;
      continue;
    }
    if (HTML_BLOCK.test(content)) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].text.trim()) j++;
      blocks.push({
        kind: "html",
        from: line.from,
        to: lines[j].to,
        firstText: -1,
        within: s.within,
      });
      i = j + 1;
      continue;
    }
    if (LINK_DEF.test(content)) {
      blocks.push({
        kind: "linkDefinition",
        from: line.from,
        to: line.to,
        firstText: -1,
        within: s.within,
      });
      i++;
      continue;
    }
    const atx = ATX.exec(content);
    if (atx) {
      const textFrom = s.contentFrom + atx[0].length;
      // A closing run of #s isn't text
      let text = content.slice(atx[0].length);
      const closing = /(?:^|[ \t]+)#+[ \t]*$/.exec(text);
      if (closing) text = text.slice(0, closing.index);
      text = text.replace(/[ \t]+$/, "");
      blocks.push({
        kind: "heading",
        from: line.from,
        to: line.to,
        firstText: text ? textFrom : -1,
        within: s.within,
      });
      if (text) inlineProse(source, textFrom, textFrom + text.length, prose);
      i++;
      continue;
    }
    // A table: a row of cells, then a delimiter row
    if (
      content.includes("|") &&
      i + 1 < lines.length &&
      TABLE_DELIMITER.test(strip({ ...lines[i + 1] }).content) &&
      strip(lines[i + 1]).content.includes("-")
    ) {
      let j = i + 1;
      while (
        j + 1 < lines.length &&
        lines[j + 1].text.trim() &&
        strip(lines[j + 1]).content.includes("|")
      )
        j++;
      blocks.push({
        kind: "table",
        from: line.from,
        to: lines[j].to,
        firstText: -1,
        within: s.within,
      });
      i = j + 1;
      continue;
    }
    // A paragraph: this line and the ones that continue it
    const parts: { from: number; to: number }[] = [
      { from: s.contentFrom, to: line.to },
    ];
    const within = s.within;
    let j = i;
    let heading = false;
    while (j + 1 < lines.length) {
      const next = lines[j + 1];
      if (!next.text.trim()) break;
      const savedItem: typeof openItem = openItem;
      const savedAlert: boolean = openAlert;
      const n = strip(next);
      const c = n.content;
      if (SETEXT.test(c) && sameWithin(n.within, within) && !n.startsItem) {
        heading = true;
        j++;
        break;
      }
      const interrupts =
        n.startsItem ||
        FENCE.test(c) ||
        ATX.test(c) ||
        THEMATIC.test(c) ||
        HTML_BLOCK.test(c) ||
        n.alertMarker ||
        !c.trim();
      if (
        interrupts ||
        (!sameWithin(n.within, within) && n.within.length > 0)
      ) {
        openItem = savedItem;
        openAlert = savedAlert;
        break;
      }
      parts.push({ from: n.contentFrom, to: next.to });
      j++;
    }
    const firstText = s.contentFrom + /^[ \t]*/.exec(content)![0].length;
    blocks.push({
      kind: heading ? "heading" : "paragraph",
      from: line.from,
      to: lines[j].to,
      firstText,
      within,
    });
    for (const part of parts) inlineProse(source, part.from, part.to, prose);
    i = j + 1;
  }
  return { blocks, prose };
}

/**
 * Adds the prose ranges of the inline text in `from..to` of `source`: everything but code spans,
 * inline math, inline HTML, autolinks, images, link destinations and reference labels, and
 * footnote references.
 */
function inlineProse(
  source: string,
  from: number,
  to: number,
  out: { from: number; to: number }[],
): void {
  const skip: { from: number; to: number }[] = [];
  const text = source.slice(from, to);
  let k = 0;
  while (k < text.length) {
    const c = text[k];
    if (c === "\\") {
      k += 2;
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (text[k + run] === "`") run++;
      const close = text.indexOf("`".repeat(run), k + run);
      if (close >= 0 && text[close + run] !== "`") {
        skip.push({ from: k, to: close + run });
        k = close + run;
        continue;
      }
      k += run;
      continue;
    }
    if (
      c === "$" &&
      text[k + 1] !== "$" &&
      text[k + 1] !== " " &&
      text[k + 1] !== undefined
    ) {
      let close = k + 1;
      while (
        close < text.length &&
        !(
          text[close] === "$" &&
          text[close - 1] !== " " &&
          text[close - 1] !== "\\"
        )
      )
        close++;
      if (close < text.length && !/\d/.test(text[close + 1] ?? "")) {
        skip.push({ from: k, to: close + 1 });
        k = close + 1;
        continue;
      }
    }
    if (c === "<") {
      const tag =
        /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+|\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?|!--[\s\S]*?--)>/.exec(
          text.slice(k),
        );
      if (tag) {
        skip.push({ from: k, to: k + tag[0].length });
        k += tag[0].length;
        continue;
      }
    }
    if (c === "!" && text[k + 1] === "[") {
      const image = /^!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])?/.exec(text.slice(k));
      if (image) {
        skip.push({ from: k, to: k + image[0].length });
        k += image[0].length;
        continue;
      }
    }
    if (c === "[") {
      const footnote = /^\[\^[^\]\s]+\]/.exec(text.slice(k));
      if (footnote) {
        skip.push({ from: k, to: k + footnote[0].length });
        k += footnote[0].length;
        continue;
      }
    }
    if (c === "]") {
      const dest = /^\](\([^)]*\)|\[[^\]]*\])/.exec(text.slice(k));
      if (dest) {
        skip.push({ from: k + 1, to: k + dest[0].length });
        k += dest[0].length;
        continue;
      }
    }
    k++;
  }
  let at = 0;
  for (const s of skip) {
    if (s.from > at) out.push({ from: from + at, to: from + s.from });
    at = Math.max(at, s.to);
  }
  if (at < text.length) out.push({ from: from + at, to });
}
