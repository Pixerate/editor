// Portions ported from photocraft/crates/doc/src/text.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Text layout shared by the image editor's type layers and the vector editor's text nodes: styled
 * runs, paragraphs, line breaking (at spaces and after break characters, and between wide CJK
 * characters), alignment and justification, tracking, leading, indents, spacing, baseline shift,
 * horizontal and vertical writing, caret positions and hit testing. Everything that needs a font goes through a `TextShaper`, so
 * the same measurements give the same lines in every host.
 */

import type { BezierPath } from '../canvas/pathops/bezier';
import type { ParagraphRun, ParagraphStyle, TextAlign, TextFont, TextOrientation, TextRect, TextShaper, TextStyle, TextVerticalMetrics } from './types';

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
  /**
   * Default `horizontal`. `vertical`: lines are columns running down, stacked right to left. Point
   * text then starts at (0, 0) at the top of the first column's centre line (`origin: 'top'`: its
   * right edge); a box's columns start at its right edge and wrap at its height.
   */
  orientation?: TextOrientation;
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
//
// Lines are laid out in line space: x runs along a line, y across the lines, which stack
// downwards. For horizontal text line space is text space. For vertical text a layout's `matrix`
// turns line space 90° clockwise into text space, so lines become columns running down and
// stacking right to left; its glyphs, caret segments, selection quads, decorations, outlines and
// `bounds` are given in text space.

/** A point in text space (or line space, where said). */
export interface TextPoint {
  x: number;
  y: number;
}

/** An affine matrix `[a, b, c, d, e, f]`: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
export type TextMatrix = readonly [number, number, number, number, number, number];

/** One laid-out character. */
export interface LaidChar {
  /** Index in the text (UTF-16 code unit). */
  index: number;
  /** Line-space x of its start and its advance (tracking and justification included). */
  x: number;
  advance: number;
}

/**
 * A character of vertical text as drawn, text space: its origin on its own baseline, its turn
 * (`90`: turned sideways, clockwise; `0`: upright), its advance along its baseline and its box
 * above and below the baseline.
 */
export interface LaidGlyph {
  index: number;
  /** Code units (2 for a surrogate pair). */
  length: number;
  x: number;
  y: number;
  angle: 0 | 90;
  advance: number;
  ascent: number;
  descent: number;
  /** Drawn with the font's vertical alternate (`vert`). */
  vert: boolean;
}

/** A run of characters on one line in one style. */
export interface LaidFragment {
  start: number;
  end: number;
  style: TextStyle;
  font: TextFont;
  /** The family the shaper draws it with. */
  family: string;
  /** Line space. */
  x: number;
  /** Baseline in line space (baseline shift applied); for upright vertical text, the column's centre line. */
  y: number;
  /** Per-character x positions relative to `x` (`end − start + 1` entries). */
  carets: number[];
  /** Whether characters are placed one by one (tracking or justification). */
  spaced: boolean;
  /** Vertical text only: whether the fragment's characters stand upright (else they are turned sideways). */
  upright?: boolean;
  /** Vertical text only: each character as drawn, text space (low surrogates join their pair). */
  glyphs?: LaidGlyph[];
}

export interface LaidLine {
  start: number;
  /** End of the line's characters (line break and trailing spaces excluded from `width`). */
  end: number;
  /** Line space; for vertical text the column's centre line. */
  baseline: number;
  ascent: number;
  descent: number;
  x: number;
  width: number;
  chars: LaidChar[];
  fragments: LaidFragment[];
  /** Vertical text only: line space → text space (the layout's `matrix`). */
  matrix?: TextMatrix;
}

/** A laid-out type layer. */
export interface TextLayout {
  lines: LaidLine[];
  /** Bounds of the lines (ascent to descent), text space; the box for paragraph text. */
  bounds: TextRect;
  /** Families replaced by a fallback. */
  missingFonts: string[];
  orientation: TextOrientation;
  /** Vertical text only: line space → text space. */
  matrix?: TextMatrix;
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
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

const TR = new Set([0x2025, 0x2026, 0x3008, 0x3009, 0x300a, 0x300b, 0x300c, 0x300d, 0x300e, 0x300f, 0x3010, 0x3011, 0x3014, 0x3015, 0x3016, 0x3017, 0x3018, 0x3019, 0x301a, 0x301b, 0x301c, 0x3030, 0x30a0, 0x30fc, 0xff08, 0xff09, 0xff0d, 0xff1a, 0xff1b, 0xff1d, 0xff3b, 0xff3d, 0xff3f, 0xff5b, 0xff5c, 0xff5d, 0xff5e]);
const TU = new Set([0x3001, 0x3002, 0xff0c, 0xff0e, 0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063, 0x3083, 0x3085, 0x3087, 0x308e, 0x3095, 0x3096, 0x30a1, 0x30a3, 0x30a5, 0x30a7, 0x30a9, 0x30c3, 0x30e3, 0x30e5, 0x30e7, 0x30ee, 0x30f5, 0x30f6]);
/** Punctuation that sits in the lower left of its cell horizontally and the upper right vertically. */
const CORNER = new Set([0x3001, 0x3002, 0xff0c, 0xff0e]);

/**
 * How a code point is set in vertical text, after Unicode's Vertical_Orientation (UAX #50),
 * simplified to CJK: `U` upright (ideographs, kana, Hangul, full-width forms, emoji), `R` turned
 * sideways (Latin and other horizontal scripts, spaces), `Tu` upright in a vertical form when the
 * font has one (、。 and small kana), `Tr` a vertical form when the font has one, else turned
 * sideways (brackets, dashes, the long vowel mark, wave dash).
 */
export function verticalOrientationOf(cp: number): 'U' | 'R' | 'Tu' | 'Tr' {
  if (TR.has(cp)) return 'Tr';
  if (TU.has(cp) || (cp >= 0x31f0 && cp <= 0x31ff)) return 'Tu';
  if (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe7) ||
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  )
    return 'U';
  return 'R';
}

/** How an upright character of vertical text sits in its cell (pixels). */
interface Upright {
  /** Horizontal advance: the glyph is centred on the column. */
  width: number;
  /** Top of the cell to the glyph's baseline. */
  originY: number;
  vert: boolean;
  /** Text-space nudge (corner punctuation without a vertical form). */
  dx: number;
  dy: number;
}

interface ParaChar {
  index: number;
  ch: string;
  advance: number;
  style: TextStyle;
  /** Vertical text: set upright. */
  up?: Upright;
  /** The low half of a surrogate pair. */
  low?: boolean;
}

const applyMatrix = (m: TextMatrix | undefined, x: number, y: number): TextPoint => (m ? { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] } : { x, y });

function invertMatrix(m: TextMatrix): TextMatrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** A rectangle mapped through `m` (a quarter turn keeps it a rectangle); `r` itself without `m`. */
export function transformTextRect(m: TextMatrix | undefined, r: TextRect): TextRect {
  if (!m) return r;
  const pts = [applyMatrix(m, r.x, r.y), applyMatrix(m, r.x + r.width, r.y), applyMatrix(m, r.x + r.width, r.y + r.height), applyMatrix(m, r.x, r.y + r.height)];
  const x0 = Math.min(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y));
  return { x: x0, y: y0, width: Math.max(...pts.map((p) => p.x)) - x0, height: Math.max(...pts.map((p) => p.y)) - y0 };
}

/** A line-space point of `layout` in text space (the same point for horizontal text). */
export function lineToTextSpace(layout: Pick<TextLayout, 'matrix'>, p: TextPoint): TextPoint {
  return applyMatrix(layout.matrix, p.x, p.y);
}

/** A text-space point of `layout` in line space (the same point for horizontal text). */
export function textToLineSpace(layout: Pick<TextLayout, 'matrix'>, p: TextPoint): TextPoint {
  return layout.matrix ? applyMatrix(invertMatrix(layout.matrix), p.x, p.y) : { x: p.x, y: p.y };
}

/** A line's box (its advance by ascent to descent) in text space. */
export function textLineRect(l: LaidLine): TextRect {
  return transformTextRect(l.matrix, { x: l.x, y: l.baseline - l.ascent, width: l.width, height: l.ascent + l.descent });
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
  const vertical = layer.orientation === 'vertical';
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
  const verticalOf = (ch: string, style: TextStyle): TextVerticalMetrics => {
    const font = resolvedFont(style);
    if (shaper.vertical) return shaper.vertical(ch, font);
    const m = shaper.metrics(font);
    return { advance: m.ascent + m.descent, originY: m.ascent, alternate: false };
  };
  const box = frame.kind === 'box' ? frame : null;
  // Vertical text runs down the box's height, its columns filling the width from the right.
  const inlineSize = box ? (vertical ? box.height : box.width) : 0;
  const matrix: TextMatrix | undefined = vertical ? [0, 1, -1, 0, box ? box.width : 0, 0] : undefined;
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
      for (let k = 0; k < seg.length; k++) {
        const index = i + k;
        const advance = (carets[k + 1] ?? 0) - (carets[k] ?? 0);
        if (!vertical) {
          chars.push({ index, ch: seg[k], advance: advance + track, style });
          continue;
        }
        const code = seg.charCodeAt(k);
        if (isLow(code) && index > 0 && isHigh(text.charCodeAt(index - 1))) {
          // The low half of a pair goes with its high half.
          const prev = chars[chars.length - 1];
          if (prev?.up) {
            chars.push({ index, ch: seg[k], advance: 0, style, up: prev.up, low: true });
          } else chars.push({ index, ch: seg[k], advance, style, low: true });
          continue;
        }
        const cp = text.codePointAt(index) ?? code;
        const kind = verticalOrientationOf(cp);
        let upright = kind === 'U' || kind === 'Tu' || (kind === 'R' && Boolean(style.upright) && !isSpace(seg[k]) && seg[k] !== '\n');
        let vm: TextVerticalMetrics | null = null;
        const char = cp > 0xffff ? text.slice(index, index + 2) : seg[k];
        if (upright || kind === 'Tr') {
          vm = verticalOf(char, style);
          if (kind === 'Tr') upright = vm.alternate;
        }
        if (!upright || !vm) {
          chars.push({ index, ch: seg[k], advance: advance + track, style });
          continue;
        }
        const corner = kind === 'Tu' && !vm.alternate && CORNER.has(cp) ? style.fontSize * 0.55 : 0;
        // Measured alone: horizontal kerning does not apply to characters one under the other.
        const alone = shaper.measure(char, resolvedFont(style));
        chars.push({ index, ch: seg[k], advance: vm.advance + track, style, up: { width: alone[alone.length - 1] ?? advance, originY: vm.originY, vert: vm.alternate, dx: corner, dy: -corner } });
      }
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
        const avail = inlineSize - startIndent - endIndent - (breaks.length === 0 ? firstIndent : 0);
        let w = 0;
        let e = s;
        let lastBreak = -1;
        while (e < chars.length) {
          const c = chars[e];
          if (!isSpace(c.ch) && w + c.advance > avail && e > s && !c.low) break;
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
      // Metrics: the tallest font on the line (a vertical column: the widest em); an empty line uses the style where it starts.
      const styles = lineChars.length ? [...new Set(lineChars.map((c) => c.style))] : [styleAt(runs, Math.min(para.start, Math.max(0, text.length - 1)), DEFAULT_TEXT_STYLE)];
      let ascent = 0;
      let descent = 0;
      let leading = 0;
      for (const st of styles) {
        if (vertical) {
          ascent = Math.max(ascent, st.fontSize / 2);
          descent = ascent;
        } else {
          const m = shaper.metrics(resolvedFont(st));
          ascent = Math.max(ascent, m.ascent);
          descent = Math.max(descent, m.descent);
        }
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
        const avail = inlineSize - startIndent - endIndent - (li === 0 ? firstIndent : 0);
        if (spaces > 0 && avail > width) extraPerSpace = (avail - width) / spaces;
      }
      let x0: number;
      const fullWidth = width + extraPerSpace * lineChars.slice(0, visibleEnd).filter((c) => isSpace(c.ch)).length;
      if (box) {
        const avail = inlineSize - startIndent - endIndent - (li === 0 ? firstIndent : 0);
        x0 = indent + (align === 'center' ? (avail - fullWidth) / 2 : align === 'right' ? avail - fullWidth : 0);
      } else x0 = indent + (align === 'center' ? -fullWidth / 2 : align === 'right' ? -fullWidth : 0);
      const laid: LaidChar[] = [];
      let x = x0;
      for (const c of lineChars) {
        const adv = c.advance + (isSpace(c.ch) ? extraPerSpace : 0);
        laid.push({ index: c.index, x, advance: adv });
        x += adv;
      }
      // Fragments: same style (and, vertically, the same upright or sideways setting), consecutive.
      const fragments: LaidFragment[] = [];
      let k = 0;
      while (k < lineChars.length) {
        const st = lineChars[k].style;
        const up = Boolean(lineChars[k].up);
        let m = k + 1;
        while (m < lineChars.length && lineChars[m].style === st && Boolean(lineChars[m].up) === up) m++;
        const font = resolvedFont(st);
        const fx = laid[k].x;
        const carets = [0];
        for (let q = k; q < m; q++) carets.push(laid[q].x + laid[q].advance - fx);
        const shift = st.baselineShift ?? 0;
        let fy = y - shift;
        if (vertical && !up) {
          // Sideways text: its em box centred on the column.
          const hm = shaper.metrics(font);
          fy = y + (hm.ascent - hm.descent) / 2 - shift;
        }
        const fragment: LaidFragment = {
          start: lineChars[k].index,
          end: lineChars[m - 1].index + 1,
          style: st,
          font,
          family: font.family,
          x: fx,
          y: fy,
          carets,
          spaced: Boolean(st.tracking) || extraPerSpace > 0 || up,
        };
        if (vertical) {
          const glyphs: LaidGlyph[] = [];
          for (let q = k; q < m; q++) {
            const c = lineChars[q];
            const lc = laid[q];
            if (c.low && q > k) {
              const g = glyphs[glyphs.length - 1];
              g.length = 2;
              if (!up) g.advance += lc.advance;
              continue;
            }
            const p = applyMatrix(matrix, lc.x, fy);
            if (c.up) {
              const u = c.up;
              glyphs.push({ index: c.index, length: 1, x: p.x - u.width / 2 + u.dx, y: p.y + u.originY + u.dy, angle: 0, advance: u.width, ascent: u.originY + u.dy, descent: lc.advance - u.originY - u.dy, vert: u.vert });
            } else glyphs.push({ index: c.index, length: 1, x: p.x, y: p.y, angle: 90, advance: lc.advance, ascent: fy - (y - ascent), descent: y + descent - fy, vert: false });
          }
          fragment.upright = up;
          fragment.glyphs = glyphs;
        }
        fragments.push(fragment);
        k = m;
      }
      const lineStart = lineChars.length ? lineChars[0].index : para.start;
      const line: LaidLine = { start: lineStart, end: lineChars.length ? lineChars[lineChars.length - 1].index + 1 : para.start, baseline: y, ascent, descent, x: x0, width, chars: laid, fragments };
      if (matrix) line.matrix = matrix;
      lines.push(line);
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
    bounds = transformTextRect(matrix, { x: x0, y: top, width: Math.max(0, x1 - x0), height: Math.max(0, bottom - top) });
  }
  const out: TextLayout = { lines, bounds, missingFonts: [...missing], orientation: vertical ? 'vertical' : 'horizontal' };
  if (matrix) out.matrix = matrix;
  return out;
}

/** The text index nearest a text-space point (for clicks): the line under it, then the closest caret. */
export function textIndexAt(layout: TextLayout, point: TextPoint): number {
  if (!layout.lines.length) return 0;
  const p = textToLineSpace(layout, point);
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

/**
 * The caret at text index `index`: in line space its x and the line's top and bottom, and in text
 * space the segment it draws (`from` the line's top or, vertically, its right edge, `to` the other
 * side).
 */
export function caretAt(layout: TextLayout, index: number): { x: number; top: number; bottom: number; line: number; from: TextPoint; to: TextPoint } {
  const lines = layout.lines;
  const caret = (x: number, l: LaidLine, line: number) => {
    const top = l.baseline - l.ascent;
    const bottom = l.baseline + l.descent;
    return { x, top, bottom, line, from: applyMatrix(l.matrix, x, top), to: applyMatrix(l.matrix, x, bottom) };
  };
  if (!lines.length) return { x: 0, top: 0, bottom: 0, line: 0, from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    const next = lines[li + 1];
    if (next && index >= next.start && (next.chars.length || index > l.end || next.start > l.end)) continue;
    const c = l.chars.find((ch) => ch.index === index);
    const prev = l.chars.find((ch) => ch.index === index - 1);
    return caret(c ? c.x : prev ? prev.x + prev.advance : l.x, l, li);
  }
  const l = lines[lines.length - 1];
  return caret(l.x + l.width, l, lines.length - 1);
}

/** Quads (text space, four corners each) covering the characters of [start, end), one per line. */
export function textSelectionQuads(layout: TextLayout, start: number, end: number): TextPoint[][] {
  const out: TextPoint[][] = [];
  if (end <= start) return out;
  for (const l of layout.lines) {
    const chars = l.chars.filter((c) => c.index >= start && c.index < end);
    if (!chars.length) continue;
    const x0 = chars[0].x;
    const x1 = chars[chars.length - 1].x + chars[chars.length - 1].advance;
    const top = l.baseline - l.ascent;
    const bottom = l.baseline + l.descent;
    out.push([applyMatrix(l.matrix, x0, top), applyMatrix(l.matrix, x1, top), applyMatrix(l.matrix, x1, bottom), applyMatrix(l.matrix, x0, bottom)]);
  }
  return out;
}

/** What an arrow key does to a text caret: along the line (`previous` / `next` character) or across lines. */
export type TextCaretStep = 'previous' | 'next' | 'line-before' | 'line-after';

/**
 * The caret step of an arrow key. Horizontal text: ← → move along the line, ↑ ↓ between lines.
 * Vertical text: ↑ ↓ move along the column, → to the column before (on the right), ← to the next.
 */
export function textArrowStep(orientation: TextOrientation | undefined, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): TextCaretStep {
  if (orientation === 'vertical') return key === 'ArrowUp' ? 'previous' : key === 'ArrowDown' ? 'next' : key === 'ArrowRight' ? 'line-before' : 'line-after';
  return key === 'ArrowLeft' ? 'previous' : key === 'ArrowRight' ? 'next' : key === 'ArrowUp' ? 'line-before' : 'line-after';
}

/**
 * The index on the line before (`dir` −1) or after (+1) the caret at `index`, at the same place
 * along the line; the start or end of the text (`length`) past the first or last line.
 */
export function textLineMove(layout: TextLayout, index: number, dir: -1 | 1, length: number): number {
  if (!layout.lines.length) return dir < 0 ? 0 : length;
  const c = caretAt(layout, index);
  const target = layout.lines[c.line + dir];
  if (!target) return dir < 0 ? 0 : length;
  const hit = target.chars.find((ch) => c.x < ch.x + ch.advance / 2);
  const last = target.chars[target.chars.length - 1];
  return hit ? hit.index : last ? last.index + 1 : target.start;
}

// ---------------------------------------------------------------------------
// Outlines
// ---------------------------------------------------------------------------

/** Underline and strike-through bars of a fragment, text space, as rectangles. Vertical text underlines on the right. */
export function textDecorations(f: LaidFragment, l: LaidLine): TextRect[] {
  const out: TextRect[] = [];
  const t = Math.max(1, f.style.fontSize / 15);
  const w = f.carets[f.carets.length - 1];
  if (l.matrix) {
    const centre = l.baseline - (f.style.baselineShift ?? 0);
    if (f.style.underline) out.push(transformTextRect(l.matrix, { x: f.x, y: centre - l.ascent, width: w, height: t }));
    if (f.style.strikethrough) out.push(transformTextRect(l.matrix, { x: f.x, y: centre - t / 2, width: w, height: t }));
    return out;
  }
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

/** A path turned 90° clockwise about the origin, then moved to (`x`, `y`). */
function turnPath(path: BezierPath, x: number, y: number): BezierPath {
  return path.map((c) => {
    if (c.type === 'Z') return c;
    if (c.type === 'M' || c.type === 'L') return { type: c.type, x: x - c.y, y: y + c.x };
    if (c.type === 'Q') return { type: 'Q', x1: x - c.y1, y1: y + c.x1, x: x - c.y, y: y + c.x };
    return { type: 'C', x1: x - c.y1, y1: y + c.x1, x2: x - c.y2, y2: y + c.x2, x: x - c.y, y: y + c.x };
  });
}

/** The text of a fragment as outlines (one placement per character when spaced or vertical), text space. */
export function textFragmentOutline(shaper: TextShaper, text: string, f: LaidFragment): BezierPath {
  if (f.glyphs) {
    const out: BezierPath = [];
    for (const g of f.glyphs) {
      const ch = text.slice(g.index, g.index + g.length);
      if (isSpace(ch)) continue;
      const opts = g.vert ? { vertical: true } : undefined;
      out.push(...(g.angle ? turnPath(shaper.outline!(ch, f.font, 0, 0, opts), g.x, g.y) : shaper.outline!(ch, f.font, g.x, g.y, opts)));
    }
    return out;
  }
  const s = text.slice(f.start, f.end);
  if (!f.spaced) return shaper.outline!(s, f.font, f.x, f.y);
  const out: BezierPath = [];
  for (let k = 0; k < s.length; k++) {
    if (isSpace(s[k])) continue;
    out.push(...shaper.outline!(s[k], f.font, f.x + f.carets[k], f.y));
  }
  return out;
}

/**
 * Draws a fragment's text with a drawing shaper in the context's current transform (text space),
 * fill style and alpha: each glyph of vertical text turned or upright, spaced text a character at
 * a time. Decorations are not drawn (see `textDecorations`).
 */
export function drawTextFragment(ctx: CanvasRenderingContext2D, shaper: TextShaper, text: string, f: LaidFragment): void {
  if (f.glyphs) {
    for (const g of f.glyphs) {
      const ch = text.slice(g.index, g.index + g.length);
      if (isSpace(ch)) continue;
      const opts = g.vert ? { vertical: true } : undefined;
      if (!g.angle) {
        shaper.draw!(ctx, ch, f.font, g.x, g.y, opts);
        continue;
      }
      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.rotate(Math.PI / 2);
      shaper.draw!(ctx, ch, f.font, 0, 0, opts);
      ctx.restore();
    }
    return;
  }
  const s = text.slice(f.start, f.end);
  if (!f.spaced) shaper.draw!(ctx, s, f.font, f.x, f.y);
  else for (let k = 0; k < s.length; k++) if (!isSpace(s[k])) shaper.draw!(ctx, s[k], f.font, f.x + f.carets[k], f.y);
}
