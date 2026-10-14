/**
 * Destinations whose content is metadata or binary data rather than document
 * text. A group starting with one of these control words (or with `\*`) is
 * skipped entirely.
 */
const SKIPPED_DESTINATIONS = new Set([
  "author", "bkmkend", "bkmkstart", "colortbl", "comment", "datastore",
  "doccomm", "falt", "fldinst", "filetbl", "fonttbl", "footer", "footerf",
  "footerl", "footerr", "footnote", "generator", "header", "headerf",
  "headerl", "headerr", "info", "keywords", "latentstyles", "listoverridetable",
  "listtable", "nonshppict", "object", "operator", "pict", "private", "revtbl",
  "rsidtbl", "shppict", "stylesheet", "subject", "themedata", "title",
  "xmlnstbl", "colorschememapping",
]);

/** Control words that map to a literal character. */
const CONTROL_WORD_TEXT: Record<string, string> = {
  par: "\n",
  sect: "\n",
  page: "\n",
  line: "\n",
  row: "\n",
  cell: "\t",
  tab: "\t",
  emdash: "—",
  endash: "–",
  emspace: " ",
  enspace: " ",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
};

/** Windows-1252 code points in 0x80–0x9F that differ from Latin-1. */
const CP1252: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
};

const CONTROL_WORD_REGEX = /\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/y;

/**
 * Best-effort plain-text extraction from an RTF document.
 *
 * Handles paragraphs/line breaks/tabs, escaped braces and backslashes,
 * `\'hh` hex escapes (decoded as Windows-1252), `\uN` Unicode escapes with
 * their `\ucN` fallback characters, common typographic control words, and
 * skips metadata destinations (font/colour tables, `\info`, pictures, field
 * instructions, `\*` destinations). Formatting (bold, lists, tables) is not
 * preserved. Input that does not start with `{\rtf` is returned unchanged.
 */
export function rtfToPlainText(rtf: string): string {
  if (!rtf) return "";
  if (!/^\s*\{\\rtf/.test(rtf)) return rtf;

  let out = "";
  const stack: Array<{ skip: boolean; uc: number }> = [];
  let skip = false;
  // Number of fallback characters that follow a \uN escape.
  let uc = 1;
  let pendingFallback = 0;
  // True right after `{`, so a destination control word can mark the group.
  let groupStart = false;

  const emit = (text: string) => {
    if (skip) return;
    if (pendingFallback > 0) {
      pendingFallback--;
      return;
    }
    out += text;
  };

  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === "{") {
      stack.push({ skip, uc });
      groupStart = true;
      i++;
      continue;
    }
    if (ch === "}") {
      const prev = stack.pop();
      if (prev) {
        skip = prev.skip;
        uc = prev.uc;
      }
      pendingFallback = 0;
      groupStart = false;
      i++;
      continue;
    }
    const atGroupStart = groupStart;
    groupStart = false;

    if (ch === "\\") {
      const next = rtf[i + 1];
      if (next === "\\" || next === "{" || next === "}") {
        emit(next);
        i += 2;
        continue;
      }
      if (next === "*") {
        // `{\*\dest …}`: an ignorable destination this reader doesn't know.
        skip = true;
        i += 2;
        continue;
      }
      if (next === "'") {
        const code = parseInt(rtf.slice(i + 2, i + 4), 16);
        if (!Number.isNaN(code)) emit(CP1252[code] ?? String.fromCharCode(code));
        i += 4;
        continue;
      }
      if (next === "~") {
        emit(" ");
        i += 2;
        continue;
      }
      if (next === "_") {
        emit("‑");
        i += 2;
        continue;
      }
      if (next === "\n" || next === "\r") {
        emit("\n");
        i += 2;
        continue;
      }
      CONTROL_WORD_REGEX.lastIndex = i;
      const match = CONTROL_WORD_REGEX.exec(rtf);
      if (!match) {
        // Other control symbols (`\-`, `\|`, `\:`) produce no text.
        i += 2;
        continue;
      }
      i = CONTROL_WORD_REGEX.lastIndex;
      const word = match[1];
      const param = match[2] !== undefined ? parseInt(match[2], 10) : undefined;
      if (atGroupStart && SKIPPED_DESTINATIONS.has(word)) {
        skip = true;
      } else if (word === "u" && param !== undefined) {
        emit(String.fromCharCode(param < 0 ? param + 65536 : param));
        if (!skip) pendingFallback = uc;
      } else if (word === "uc" && param !== undefined) {
        uc = param;
      } else if (word === "bin" && param !== undefined) {
        // Raw binary data: skip it.
        i += param;
      } else if (CONTROL_WORD_TEXT[word] !== undefined) {
        emit(CONTROL_WORD_TEXT[word]);
      }
      continue;
    }
    // Raw newlines are formatting in RTF; only control words break lines.
    if (ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    emit(ch);
    i++;
  }

  return out.replace(/\n+$/, "");
}
