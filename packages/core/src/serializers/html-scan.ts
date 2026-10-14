/**
 * Linear-time scanners for the HTML-ish strings the serializers handle.
 *
 * Regexes like `/<span\b[^>]*…[^>]*>/`, `/<[^>]+>/g` or `/<pre[\s\S]*?<\/pre>/g` are
 * quadratic (or worse) on malformed input: every opener without its closer
 * rescans to the end of the string. These helpers find each closer once and
 * reuse it, so untrusted input can't stall the main thread (see GOTCHAS).
 */

export interface TagSpan {
  /** Index of the opening `<tag`. */
  start: number;
  /** Index just past the opening tag's `>`. */
  openEnd: number;
  /** Index just past the close tag (or `openEnd` when the close tag isn't required). */
  end: number;
  /** Attribute text between `<span` and `>`. */
  attrs: string;
}

/**
 * Finds `<tag …attrs…>…</tag>` elements whose attributes match `attrTest`, in
 * one linear pass. A regex such as `/<span\b(?=[^>]*…)([^>]*)>[\s\S]*?<\/span>/g`
 * rescans to the end of the input from every `<span` when a `>` or `</span>` is
 * missing, which is quadratic on malformed input. Here the next `>` and the next
 * close tag are found once and reused until the scan passes them, and the scan
 * stops as soon as either no longer exists further on. The first close tag after
 * the opening tag ends the element (no nesting), as with a lazy regex.
 */
export function findTagSpans(
  html: string,
  tag: string,
  attrTest: RegExp | ((attrs: string) => boolean),
  requireClose: boolean,
): TagSpan[] {
  const matches = typeof attrTest === "function" ? attrTest : (attrs: string) => attrTest.test(attrs);
  const spans: TagSpan[] = [];
  const openTag = new RegExp(`<${tag}\\b`, "gi");
  const closeTag = new RegExp(`</${tag}>`, "gi");
  const closeLength = tag.length + 3;
  let nextGt = -1;
  let nextClose = -1;
  let from = 0;
  for (;;) {
    openTag.lastIndex = from;
    const open = openTag.exec(html);
    if (!open) break;
    const start = open.index;
    const attrsStart = start + open[0].length;
    if (nextGt < attrsStart) {
      nextGt = html.indexOf(">", attrsStart);
      if (nextGt === -1) break;
    }
    const attrs = html.slice(attrsStart, nextGt);
    const openEnd = nextGt + 1;
    if (!matches(attrs)) {
      from = attrsStart;
      continue;
    }
    if (!requireClose) {
      spans.push({ start, openEnd, end: openEnd, attrs });
      from = openEnd;
      continue;
    }
    if (nextClose < openEnd) {
      closeTag.lastIndex = openEnd;
      const close = closeTag.exec(html);
      if (!close) break;
      nextClose = close.index;
    }
    const end = nextClose + closeLength;
    spans.push({ start, openEnd, end, attrs });
    from = end;
  }
  return spans;
}

/** Replaces each matching element (opening tag through close tag) using `replace`. */
export function replaceTagSpans(
  html: string,
  tag: string,
  attrTest: RegExp | ((attrs: string) => boolean),
  replace: (match: string, attrs: string) => string,
): string {
  const spans = findTagSpans(html, tag, attrTest, true);
  if (spans.length === 0) return html;
  let out = "";
  let last = 0;
  for (const span of spans) {
    out += html.slice(last, span.start) + replace(html.slice(span.start, span.end), span.attrs);
    last = span.end;
  }
  return out + html.slice(last);
}

/**
 * Replaces `<…>` tags in one pass. Same result as `.replace(/<[^>]+>/g, replacement)`,
 * which is quadratic when many `<` have no closing `>`: each one rescans to the
 * end. Once no `>` is left, the rest of the input is plain text.
 */
export function stripTags(html: string, replacement = ""): string {
  let out = "";
  let from = 0;
  for (;;) {
    const lt = html.indexOf("<", from);
    if (lt === -1) break;
    const gt = html.indexOf(">", lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      // "<>" is not a tag (the regex needs at least one character).
      out += html.slice(from, gt + 1);
    } else {
      out += html.slice(from, lt) + replacement;
    }
    from = gt + 1;
  }
  return out + html.slice(from);
}

/**
 * Removes (or replaces) regions that start with a match of `open` and end at the
 * next `close`, in one pass. Equivalent to `.replace(/<open>[\s\S]*?<close>/g, …)`
 * but linear: such a lazy regex rescans to the end of the input from every
 * unclosed opener. The next close position is cached until the scan passes it,
 * and scanning stops once no close is left. `open` must have the `g` flag.
 */
export function replaceDelimited(
  text: string,
  open: RegExp,
  close: string,
  replace: (match: string) => string = () => "",
  caseInsensitiveClose = false,
): string {
  const haystack = caseInsensitiveClose ? asciiLower(text) : text;
  const needle = caseInsensitiveClose ? close.toLowerCase() : close;
  let out = "";
  let last = 0;
  let from = 0;
  let nextClose = -1;
  for (;;) {
    open.lastIndex = from;
    const opened = open.exec(text);
    if (!opened) break;
    const afterOpen = opened.index + Math.max(opened[0].length, 1);
    if (nextClose < afterOpen) {
      nextClose = haystack.indexOf(needle, afterOpen);
      if (nextClose === -1) break;
    }
    const end = nextClose + close.length;
    out += text.slice(last, opened.index) + replace(text.slice(opened.index, end));
    last = from = end;
  }
  return out + text.slice(last);
}

/** Lower-cases ASCII letters only, so indices match the original string. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}
