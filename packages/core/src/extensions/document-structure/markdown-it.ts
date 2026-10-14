/**
 * markdown-it plugins used by the document-structure extensions' markdown
 * parse hooks (tiptap-markdown). tiptap-markdown calls every extension's
 * `parse.setup` before *each* parse on the same markdown-it instance, so the
 * plugins guard against registering their rules twice.
 */

const installed = new WeakMap<object, Set<string>>();

function once(md: any, name: string): boolean {
  let names = installed.get(md);
  if (!names) {
    names = new Set();
    installed.set(md, names);
  }
  if (names.has(name)) return false;
  names.add(name);
  return true;
}

const escapeAttr = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const TOC_LINE = /^(?:\[\[toc\]\]|\[toc\])\s*$/i;

/**
 * Parses a line containing only `[[toc]]` (or `[TOC]`) into a table of
 * contents placeholder that the `TableOfContents` node parses.
 */
export function tableOfContentsMarkdownIt(md: any): void {
  if (!once(md, "toc")) return;
  md.block.ruler.before(
    "reference",
    "pixerate_toc",
    (state: any, startLine: number, _endLine: number, silent: boolean) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const line = state.src.slice(start, state.eMarks[startLine]);
      if (!TOC_LINE.test(line)) return false;
      if (silent) return true;
      const token = state.push("pixerate_toc", "nav", 0);
      token.block = true;
      token.map = [startLine, startLine + 1];
      state.line = startLine + 1;
      return true;
    },
    { alt: ["paragraph", "reference"] },
  );
  md.renderer.rules.pixerate_toc = () =>
    '<nav data-type="table-of-contents"></nav>\n';
}

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;

/**
 * Minimal footnote syntax: `[^label]` references and `[^label]: text`
 * definitions (continuation paragraphs indented by four spaces). Renders the
 * HTML the `FootnoteReference`, `Footnotes` and `Footnote` nodes parse.
 */
export function footnotesMarkdownIt(md: any): void {
  if (!once(md, "footnotes")) return;

  md.block.ruler.before(
    "reference",
    "pixerate_footnote_def",
    (state: any, startLine: number, endLine: number, silent: boolean) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) return false;
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const match = FOOTNOTE_DEF.exec(
        state.src.slice(start, state.eMarks[startLine]),
      );
      if (!match) return false;
      if (silent) return true;

      const paragraphs: string[][] = [[match[2]]];
      let lastContentLine = startLine;
      let pendingBlank = false;
      for (let line = startLine + 1; line < endLine; line++) {
        const lineStart = state.bMarks[line] + state.tShift[line];
        const lineEnd = state.eMarks[line];
        if (lineStart >= lineEnd) {
          pendingBlank = true;
          continue;
        }
        if (state.sCount[line] - state.blkIndent < 4) break;
        const text = state.src.slice(lineStart, lineEnd);
        if (pendingBlank) paragraphs.push([text]);
        else paragraphs[paragraphs.length - 1].push(text);
        pendingBlank = false;
        lastContentLine = line;
      }

      const open = state.push("pixerate_footnote_open", "li", 1);
      open.meta = { label: match[1] };
      open.block = true;
      open.map = [startLine, lastContentLine + 1];
      for (const paragraph of paragraphs) {
        state.push("paragraph_open", "p", 1).block = true;
        const inline = state.push("inline", "", 0);
        inline.content = paragraph.join("\n").trim();
        inline.map = [startLine, lastContentLine + 1];
        inline.children = [];
        state.push("paragraph_close", "p", -1).block = true;
      }
      state.push("pixerate_footnote_close", "li", -1).block = true;
      state.line = lastContentLine + 1;
      return true;
    },
    { alt: ["paragraph", "reference"] },
  );

  md.inline.ruler.before("link", "pixerate_footnote_ref", (state: any, silent: boolean) => {
    const { src, pos, posMax } = state;
    if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5e /* ^ */) {
      return false;
    }
    let end = pos + 2;
    while (end < posMax && src.charCodeAt(end) !== 0x5d /* ] */) {
      if (/\s/.test(src[end])) return false;
      end++;
    }
    if (end >= posMax || end === pos + 2) return false;
    if (!silent) {
      const token = state.push("pixerate_footnote_ref", "sup", 0);
      token.meta = { label: src.slice(pos + 2, end) };
    }
    state.pos = end + 1;
    return true;
  });

  md.renderer.rules.pixerate_footnote_ref = (tokens: any[], idx: number) => {
    const label = escapeAttr(tokens[idx].meta.label);
    return `<sup data-type="footnote-reference" data-id="${label}">${label}</sup>`;
  };
  md.renderer.rules.pixerate_footnote_open = (tokens: any[], idx: number) => {
    const label = escapeAttr(tokens[idx].meta.label);
    return `<section data-type="footnotes"><ol><li data-type="footnote" data-id="${label}">`;
  };
  md.renderer.rules.pixerate_footnote_close = () => "</li></ol></section>\n";
}

/**
 * Merges the one-per-definition footnote sections produced by
 * `footnotesMarkdownIt` into a single section at the end of the document.
 */
export function mergeFootnoteSections(element: HTMLElement): void {
  const sections = Array.from(
    element.querySelectorAll('section[data-type="footnotes"]'),
  );
  if (!sections.length) return;
  const [first, ...rest] = sections;
  const list = first.querySelector("ol");
  if (!list) return;
  for (const section of rest) {
    section.querySelectorAll('li[data-type="footnote"]').forEach((li) => list.appendChild(li));
    section.remove();
  }
  element.appendChild(first);
}
