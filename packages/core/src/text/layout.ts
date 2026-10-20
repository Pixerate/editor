// Portions ported from photocraft/crates/doc/src/text.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Text layout shared by the image editor's type layers and the vector editor's text nodes: styled
 * runs, paragraphs, line breaking (at spaces and after break characters, and between wide CJK
 * characters), alignment and justification, tracking, leading, indents, spacing, baseline shift,
 * caret positions and hit testing. Everything that needs a font goes through a `TextShaper`, so
 * the same measurements give the same lines in every host.
 */

import type { BezierPath } from '../canvas/pathops/bezier';
import type { ParagraphRun, ParagraphStyle, TextAlign, TextFont, TextRect, TextShaper, TextStyle } from './types';

/** What layout needs: the text, its character and paragraph runs and its frame. */
export interface TextBlock {
  text: string;
  runs: ReadonlyArray<{ length: number; style: TextStyle }>;
  paragraphs: readonly ParagraphRun[];
  /**
   * `point`: lines grow from the origin, one per paragraph; the first baseline is at y = 0, or one
   * ascent down with `origin: 'top'`. `box`: lines wrap inside `width` and the first baseline is one
   * ascent below the top (`height` bounds the layout's box; lines past it still lay out).
   */
  frame: { kind: 'point'; origin?: 'baseline' | 'top' } | { kind: 'box'; width: number; height: number };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const DEFAULT_TEXT_STYLE: TextStyle = { fontFamily: 'sans-serif', fontWeight: 400, fontSize: 24, color: '#000000' };
export const DEFAULT_AUTO_LEADING = 1.2;

const sameStyle = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);

/** Merges neighbouring runs with equal styles and drops empty ones. */
function compact<R extends { length: number; style: object }>(runs: R[]): R[] {
  const out: R[] = [];
  for (const r of runs) {
    if (r.length <= 0) continue;
    const last = out[out.length - 1];
    if (last && sameStyle(last.style, r.style)) out[out.length - 1] = { ...last, length: last.length + r.length };
    else out.push({ ...r });
  }
  return out;
}

/** Runs fitted to a text of `length` (the last run stretches or is cut), never empty while there is text. */
export function fitRuns<R extends { length: number; style: object }>(runs: readonly R[], length: number, fallback: R['style']): R[] {
  const out: R[] = [];
  let left = length;
  for (const r of runs) {
    if (left <= 0) break;
    const n = Math.min(Math.max(0, Math.floor(r.length)), left);
    if (n > 0) out.push({ ...r, length: n });
    left -= n;
  }
  if (left > 0) {
    if (out.length) out[out.length - 1] = { ...out[out.length - 1], length: out[out.length - 1].length + left };
    else out.push({ length: left, style: runs[runs.length - 1]?.style ?? fallback } as R);
  }
  return compact(out);
}

/** The style of the run holding code unit `index` (the last run past the end). */
export function styleAt<S extends object>(runs: ReadonlyArray<{ length: number; style: S }>, index: number, fallback: S): S {
  let at = 0;
  for (const r of runs) {
    if (index < at + r.length) return r.style;
    at += r.length;
  }
  return runs[runs.length - 1]?.style ?? fallback;
}

/** Runs with `patch(style)` applied over [start, end). */
export function restyleRange<S extends object>(runs: ReadonlyArray<{ length: number; style: S }>, start: number, end: number, patch: (s: S) => S): Array<{ length: number; style: S }> {
  const out: Array<{ length: number; style: S }> = [];
  let at = 0;
  for (const r of runs) {
    const a = at;
    const b = at + r.length;
    at = b;
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi <= lo) {
      out.push({ ...r });
      continue;
    }
    if (lo > a) out.push({ length: lo - a, style: r.style });
    out.push({ length: hi - lo, style: patch(r.style) });
    if (b > hi) out.push({ length: b - hi, style: r.style });
  }
  return compact(out);
}

/** Runs after replacing [start, end) of the text with `inserted` code units styled `style`. */
export function spliceRuns<S extends object>(runs: ReadonlyArray<{ length: number; style: S }>, start: number, end: number, inserted: number, style: S): Array<{ length: number; style: S }> {
  const out: Array<{ length: number; style: S }> = [];
  let at = 0;
  let placed = false;
  for (const r of runs) {
    const a = at;
    const b = at + r.length;
    at = b;
    if (b <= start) {
      out.push({ ...r });
      continue;
    }
    if (a < start) out.push({ length: start - a, style: r.style });
    if (!placed) {
      out.push({ length: inserted, style });
      placed = true;
    }
    if (b > end) out.push({ length: b - Math.max(end, a), style: r.style });
  }
  if (!placed) out.push({ length: inserted, style });
  return compact(out);
}

/** Paragraph ranges [start, end) of the text, the line break included in the paragraph it ends. */
export function paragraphRanges(text: string): Array<{ start: number; end: number; content: number }> {
  const out: Array<{ start: number; end: number; content: number }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      out.push({ start, end: i + 1, content: i });
      start = i + 1;
    }
  }
  out.push({ start, end: text.length, content: text.length });
  return out;
}

/** Paragraph runs snapped to whole paragraphs: each paragraph takes the style at its start. */
export function fitParagraphRuns(runs: readonly ParagraphRun[], text: string): ParagraphRun[] {
  const fallback: ParagraphStyle = runs[0]?.style ?? {};
  const out = compact(paragraphRanges(text).map((p) => ({ length: p.end - p.start, style: styleAt(runs, p.start, fallback) })));
  return out.length ? out : [{ length: 0, style: fallback }];
}


// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** One laid-out character. */
export interface LaidChar {
  /** Index in the text (UTF-16 code unit). */
  index: number;
  /** Text-space x of its start and its advance (tracking and justification included). */
  x: number;
  advance: number;
}

/** A run of characters on one line in one style. */
export interface LaidFragment {
  start: number;
  end: number;
  style: TextStyle;
  font: TextFont;
  /** The family the shaper draws it with. */
  family: string;
  x: number;
  /** Baseline in text space (baseline shift applied). */
  y: number;
  /** Per-character x positions relative to `x` (`end − start + 1` entries). */
  carets: number[];
  /** Whether characters are placed one by one (tracking or justification). */
  spaced: boolean;
}

export interface LaidLine {
  start: number;
  /** End of the line's characters (line break and trailing spaces excluded from `width`). */
  end: number;
  baseline: number;
  ascent: number;
  descent: number;
  x: number;
  width: number;
  chars: LaidChar[];
  fragments: LaidFragment[];
}

/** A laid-out type layer in text space. */
export interface TextLayout {
  lines: LaidLine[];
  /** Bounds of the lines (ascent to descent), text space; the box for paragraph text. */
  bounds: TextRect;
  /** Families replaced by a fallback. */
  missingFonts: string[];
}

export function fontOf(style: TextStyle): TextFont {
  const f: TextFont = { family: style.fontFamily, weight: style.fontWeight, italic: Boolean(style.italic), size: style.fontSize };
  if (style.postScriptName) f.postScriptName = style.postScriptName;
  return f;
}

const isBreakAfter = (c: string) => c === ' ' || c === '\t' || c === '-' || c === '‐' || c === '​';
/** Whether a character is a space or tab (spaces hang at line ends and stretch when justifying). */
export const isTextSpace = (c: string) => c === ' ' || c === '\t';
const isSpace = isTextSpace;
const isWide = (code: number) => (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef);

interface ParaChar {
  index: number;
  ch: string;
  advance: number;
  style: TextStyle;
}

const layoutCache = new WeakMap<object, Map<string, TextLayout>>();

/** Lays out a type layer with `shaper` (memoised per layer object and shaper). */
export function layoutText(layer: TextBlock, shaper: TextShaper): TextLayout {
  let byShaper = layoutCache.get(layer);
  const hit = byShaper?.get(shaper.id);
  if (hit) return hit;
  const out = computeLayout(layer, shaper);
  if (!byShaper) {
    byShaper = new Map();
    layoutCache.set(layer, byShaper);
  }
  byShaper.set(shaper.id, out);
  return out;
}

function computeLayout(layer: TextBlock, shaper: TextShaper): TextLayout {
  const { text, frame } = layer;
  const runs = fitRuns(layer.runs, text.length, DEFAULT_TEXT_STYLE);
  const missing = new Set<string>();
  const resolved = new Map<string, string>();
  const familyOf = (font: TextFont) => {
    const key = `${font.family}|${font.weight}|${font.italic}|${font.postScriptName ?? ''}`;
    let fam = resolved.get(key);
    if (fam === undefined) {
      const r = shaper.resolve(font);
      fam = r.family;
      if (!r.available) missing.add(font.family);
      resolved.set(key, fam);
    }
    return fam;
  };
  const resolvedFont = (style: TextStyle): TextFont => ({ ...fontOf(style), family: familyOf(fontOf(style)) });
  const box = frame.kind === 'box' ? frame : null;
  const lines: LaidLine[] = [];
  let y = 0;
  let first = true;
  const paragraphs = paragraphRanges(text);
  paragraphs.forEach((para, pi) => {
    const pstyle = styleAt(layer.paragraphs, para.start, {} as ParagraphStyle);
    const autoLeading = pstyle.autoLeading ?? DEFAULT_AUTO_LEADING;
    if (pi > 0) y += pstyle.spaceBefore ?? 0;
    // Advances of the paragraph's characters, measured per style segment.
    const chars: ParaChar[] = [];
    let i = para.start;
    while (i < para.content) {
      const style = styleAt(runs, i, DEFAULT_TEXT_STYLE);
      let j = i + 1;
      while (j < para.content && styleAt(runs, j, DEFAULT_TEXT_STYLE) === style) j++;
      const seg = text.slice(i, j);
      const carets = shaper.measure(seg, resolvedFont(style));
      const track = ((style.tracking ?? 0) / 1000) * style.fontSize;
      for (let k = 0; k < seg.length; k++) chars.push({ index: i + k, ch: seg[k], advance: (carets[k + 1] ?? 0) - (carets[k] ?? 0) + track, style });
      i = j;
    }
    const startIndent = pstyle.startIndent ?? 0;
    const endIndent = pstyle.endIndent ?? 0;
    const firstIndent = pstyle.firstLineIndent ?? 0;
    // Break into lines.
    const breaks: Array<[number, number]> = [];
    if (!box || !chars.length) breaks.push([0, chars.length]);
    else {
      let s = 0;
      while (s < chars.length) {
        const avail = box.width - startIndent - endIndent - (breaks.length === 0 ? firstIndent : 0);
        let w = 0;
        let e = s;
        let lastBreak = -1;
        while (e < chars.length) {
          const c = chars[e];
          if (!isSpace(c.ch) && w + c.advance > avail && e > s) break;
          w += c.advance;
          if (isBreakAfter(c.ch) || isWide(c.ch.charCodeAt(0)) || (e + 1 < chars.length && isWide(chars[e + 1].ch.charCodeAt(0)))) lastBreak = e + 1;
          e++;
        }
        if (e < chars.length && lastBreak > s) e = lastBreak;
        // Spaces at a break hang past the edge.
        while (e < chars.length && isSpace(chars[e].ch)) e++;
        breaks.push([s, e]);
        s = e;
      }
    }
    const align: TextAlign = pstyle.align ?? 'left';
    breaks.forEach(([s, e], li) => {
      const lineChars = chars.slice(s, e);
      let visibleEnd = lineChars.length;
      while (visibleEnd > 0 && isSpace(lineChars[visibleEnd - 1].ch)) visibleEnd--;
      // Metrics: the tallest font on the line; an empty line uses the style where it starts.
      const styles = lineChars.length ? [...new Set(lineChars.map((c) => c.style))] : [styleAt(runs, Math.min(para.start, Math.max(0, text.length - 1)), DEFAULT_TEXT_STYLE)];
      let ascent = 0;
      let descent = 0;
      let leading = 0;
      for (const st of styles) {
        const m = shaper.metrics(resolvedFont(st));
        ascent = Math.max(ascent, m.ascent);
        descent = Math.max(descent, m.descent);
        leading = Math.max(leading, st.leading ?? autoLeading * st.fontSize);
      }
      if (first) {
        y = frame.kind === 'box' || (frame.kind === 'point' && frame.origin === 'top') ? ascent : 0;
        first = false;
      } else y += leading;
      const indent = startIndent + (li === 0 ? firstIndent : 0);
      let width = 0;
      for (let k = 0; k < visibleEnd; k++) width += lineChars[k].advance;
      const lastLine = li === breaks.length - 1;
      let extraPerSpace = 0;
      if (box && align === 'justify' && !lastLine) {
        const spaces = lineChars.slice(0, visibleEnd).filter((c) => isSpace(c.ch)).length;
        const avail = box.width - startIndent - endIndent - (li === 0 ? firstIndent : 0);
        if (spaces > 0 && avail > width) extraPerSpace = (avail - width) / spaces;
      }
      let x0: number;
      const fullWidth = width + extraPerSpace * lineChars.slice(0, visibleEnd).filter((c) => isSpace(c.ch)).length;
      if (box) {
        const avail = box.width - startIndent - endIndent - (li === 0 ? firstIndent : 0);
        x0 = indent + (align === 'center' ? (avail - fullWidth) / 2 : align === 'right' ? avail - fullWidth : 0);
      } else x0 = indent + (align === 'center' ? -fullWidth / 2 : align === 'right' ? -fullWidth : 0);
      const laid: LaidChar[] = [];
      let x = x0;
      for (const c of lineChars) {
        const adv = c.advance + (isSpace(c.ch) ? extraPerSpace : 0);
        laid.push({ index: c.index, x, advance: adv });
        x += adv;
      }
      // Fragments: same style, consecutive.
      const fragments: LaidFragment[] = [];
      let k = 0;
      while (k < lineChars.length) {
        const st = lineChars[k].style;
        let m = k + 1;
        while (m < lineChars.length && lineChars[m].style === st) m++;
        const font = resolvedFont(st);
        const fx = laid[k].x;
        const carets = [0];
        for (let q = k; q < m; q++) carets.push(laid[q].x + laid[q].advance - fx);
        fragments.push({
          start: lineChars[k].index,
          end: lineChars[m - 1].index + 1,
          style: st,
          font,
          family: font.family,
          x: fx,
          y: y - (st.baselineShift ?? 0),
          carets,
          spaced: Boolean(st.tracking) || extraPerSpace > 0,
        });
        k = m;
      }
      const lineStart = lineChars.length ? lineChars[0].index : para.start;
      lines.push({ start: lineStart, end: lineChars.length ? lineChars[lineChars.length - 1].index + 1 : para.start, baseline: y, ascent, descent, x: x0, width, chars: laid, fragments });
    });
    y += pstyle.spaceAfter ?? 0;
  });
  let bounds: TextRect;
  if (box) bounds = { x: 0, y: 0, width: box.width, height: box.height };
  else {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const l of lines) {
      x0 = Math.min(x0, l.x);
      x1 = Math.max(x1, l.x + l.width);
    }
    if (!Number.isFinite(x0)) x0 = x1 = 0;
    const top = lines.length ? lines[0].baseline - lines[0].ascent : 0;
    const last = lines[lines.length - 1];
    const bottom = last ? last.baseline + last.descent : 0;
    bounds = { x: x0, y: top, width: Math.max(0, x1 - x0), height: Math.max(0, bottom - top) };
  }
  return { lines, bounds, missingFonts: [...missing] };
}

/** The text index nearest a text-space point (for clicks): the line under it, then the closest caret. */
export function textIndexAt(layout: TextLayout, p: { x: number; y: number }): number {
  if (!layout.lines.length) return 0;
  let line = layout.lines[layout.lines.length - 1];
  for (const l of layout.lines) {
    if (p.y <= l.baseline + l.descent) {
      line = l;
      break;
    }
  }
  if (!line.chars.length) return line.start;
  for (const c of line.chars) if (p.x < c.x + c.advance / 2) return c.index;
  const lastChar = line.chars[line.chars.length - 1];
  return lastChar.index + 1;
}

/** The caret at text index `index`: its x and the line's top and bottom, text space. */
export function caretAt(layout: TextLayout, index: number): { x: number; top: number; bottom: number; line: number } {
  const lines = layout.lines;
  if (!lines.length) return { x: 0, top: 0, bottom: 0, line: 0 };
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    const next = lines[li + 1];
    if (next && index >= next.start && (next.chars.length || index > l.end || next.start > l.end)) continue;
    const c = l.chars.find((ch) => ch.index === index);
    const prev = l.chars.find((ch) => ch.index === index - 1);
    const x = c ? c.x : prev ? prev.x + prev.advance : l.x;
    return { x, top: l.baseline - l.ascent, bottom: l.baseline + l.descent, line: li };
  }
  const l = lines[lines.length - 1];
  return { x: l.x + l.width, top: l.baseline - l.ascent, bottom: l.baseline + l.descent, line: lines.length - 1 };
}

// ---------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------

/** Underline and strike-through bars of a fragment, text space, as rectangles. */
export function textDecorations(f: LaidFragment, l: LaidLine): TextRect[] {
  const out: TextRect[] = [];
  const t = Math.max(1, f.style.fontSize / 15);
  const w = f.carets[f.carets.length - 1];
  if (f.style.underline) out.push({ x: f.x, y: f.y + Math.max(t, l.descent * 0.35), width: w, height: t });
  if (f.style.strikethrough) out.push({ x: f.x, y: f.y - l.ascent * 0.3 - t / 2, width: w, height: t });
  return out;
}

export const textRectPath = (r: TextRect): BezierPath => [
  { type: 'M', x: r.x, y: r.y },
  { type: 'L', x: r.x + r.width, y: r.y },
  { type: 'L', x: r.x + r.width, y: r.y + r.height },
  { type: 'L', x: r.x, y: r.y + r.height },
  { type: 'Z' },
];

/** The text of a fragment as outlines (one placement per character when spaced), text space. */
export function textFragmentOutline(shaper: TextShaper, text: string, f: LaidFragment): BezierPath {
  const s = text.slice(f.start, f.end);
  if (!f.spaced) return shaper.outline!(s, f.font, f.x, f.y);
  const out: BezierPath = [];
  for (let k = 0; k < s.length; k++) {
    if (isSpace(s[k])) continue;
    out.push(...shaper.outline!(s[k], f.font, f.x + f.carets[k], f.y));
  }
  return out;
}

