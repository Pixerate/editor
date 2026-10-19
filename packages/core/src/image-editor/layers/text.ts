// Portions ported from photocraft/crates/doc/src/text.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Type layers: styled runs of text laid out as point or paragraph text and drawn into the layer's
 * `surface` by a text shaper.
 *
 * Layout (paragraphs, line breaking, alignment, tracking, leading, indents, spacing) is ours and
 * runs anywhere. What needs fonts goes through a `TextShaper`: font availability and fallback,
 * metrics, advance widths and drawing, either as glyph outlines (pure; rendered by the shape
 * rasterizer, and what Convert to Shape needs) or onto a 2D canvas (the browser's own text). The
 * editor uses a Canvas 2D shaper in browsers; hosts can plug in another (an OpenType outline
 * shaper, or one for a server). Without a shaper, type layers keep the pixels they were saved with
 * and refuse edits that would need drawing them again.
 */

import type { Annotation, CropBox, TextAnnotation } from '../types';
import { emptySurface, finishTile, surfaceFromPixels, tileKey, tilesInRect, TiledSurface, TILE, type PixelSurface, type Tile, type TileKey } from '../../raster/surface';
import { MAX_EFFECT_REACH } from '../../raster/effects/model';
import { IDENTITY_MATRIX, applyMatrix, invertMatrix, isIdentityMatrix, multiplyMatrices, rotateMatrix } from '../../geom/affine';
import type { AffineMatrix } from '../../geom/types';
import { transformBezierPath, type BezierPath } from '../../canvas/pathops/bezier';
import { flattenPath, rasterizeCoverageSampled, type FlatPath } from './vector-raster';
import { parseCssColor } from './css-color';
import { LayerOperationError, requireLayer, requireUnlocked } from './ops';
import {
  mapLayer,
  newLayerId,
  TEXT_ALIGNS,
  type ImageLayer,
  type ParagraphRun,
  type ParagraphStyle,
  type PixelLayer,
  type TextAlign,
  type TextRun,
  type TextStyle,
  type TypeLayer,
} from './model';

const fail = (message: string): never => {
  throw new LayerOperationError(message);
};

// ---------------------------------------------------------------------------
// Shapers
// ---------------------------------------------------------------------------

/** A font as a shaper is asked for it (sizes in pixels). */
export interface TextFont {
  family: string;
  weight: number;
  italic: boolean;
  size: number;
  postScriptName?: string;
}

/**
 * What layout and rendering need from fonts. Implement `outline` (glyph outlines, pure) or `draw`
 * (onto a 2D canvas), or both.
 */
export interface TextShaper {
  /** Identifies the shaper (part of the render cache key). */
  readonly id: string;
  /** The family that draws `font`: the family itself when available, else a fallback (`available: false`). */
  resolve(font: TextFont): { family: string; available: boolean };
  /** Ascent and descent (both positive, pixels) of the resolved font at `font.size`. */
  metrics(font: TextFont): { ascent: number; descent: number };
  /**
   * Caret positions of `text` set in `font`: `text.length + 1` x offsets in pixels from the start
   * (kerning included, tracking not).
   */
  measure(text: string, font: TextFont): ArrayLike<number>;
  /** Glyph outlines of `text` with its start on the baseline at (`x`, `y`), pixels, y down. */
  outline?(text: string, font: TextFont, x: number, y: number): BezierPath;
  /** Draws `text` with its start on the baseline at (`x`, `y`) in the context's current transform, fill style and alpha. */
  draw?(ctx: CanvasRenderingContext2D, text: string, font: TextFont, x: number, y: number): void;
  /** Families this shaper can draw (for font pickers and agents), when it can tell. */
  families?(): string[];
}

/** What rendering a type layer needs besides the layer. */
export interface TextEnv {
  width: number;
  height: number;
  /** `null`: no shaper here; type layers keep their stored pixels. */
  shaper: TextShaper | null;
  /** A 2D canvas for shapers that `draw` (the editor's renderer provides one). */
  createCanvas?(width: number, height: number): HTMLCanvasElement | OffscreenCanvas;
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
  bounds: CropBox;
  /** Families replaced by a fallback. */
  missingFonts: string[];
}

export function fontOf(style: TextStyle): TextFont {
  const f: TextFont = { family: style.fontFamily, weight: style.fontWeight, italic: Boolean(style.italic), size: style.fontSize };
  if (style.postScriptName) f.postScriptName = style.postScriptName;
  return f;
}

const isBreakAfter = (c: string) => c === ' ' || c === '\t' || c === '-' || c === '‐' || c === '​';
const isSpace = (c: string) => c === ' ' || c === '\t';
const isWide = (code: number) => (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef);

interface ParaChar {
  index: number;
  ch: string;
  advance: number;
  style: TextStyle;
}

const layoutCache = new WeakMap<object, Map<string, TextLayout>>();

/** Lays out a type layer with `shaper` (memoised per layer object and shaper). */
export function layoutText(layer: Pick<TypeLayer, 'text' | 'runs' | 'paragraphs' | 'frame'>, shaper: TextShaper): TextLayout {
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

function computeLayout(layer: Pick<TypeLayer, 'text' | 'runs' | 'paragraphs' | 'frame'>, shaper: TextShaper): TextLayout {
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
  let bounds: CropBox;
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
// Rendering
// ---------------------------------------------------------------------------

/** How far beyond the canvas type renders (as shapes). */
export const TEXT_RENDER_MARGIN = MAX_EFFECT_REACH;

/** Text space → document of a layer. */
export function textMatrix(layer: Pick<TypeLayer, 'transform'>): AffineMatrix {
  return layer.transform ?? IDENTITY_MATRIX;
}

function rectCorners(r: CropBox): Array<{ x: number; y: number }> {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
}

/** Integer document bounds of a text-space rect under `m`. */
function docRect(r: CropBox, m: AffineMatrix): CropBox {
  const pts = rectCorners(r).map((p) => applyMatrix(m, p));
  const x0 = Math.floor(Math.min(...pts.map((p) => p.x)));
  const y0 = Math.floor(Math.min(...pts.map((p) => p.y)));
  const x1 = Math.ceil(Math.max(...pts.map((p) => p.x)));
  const y1 = Math.ceil(Math.max(...pts.map((p) => p.y)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function intersect(a: CropBox, b: CropBox): CropBox | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** Text-space bounds of everything drawn (glyph overhang and decorations allowed for). */
function inkBounds(layout: TextLayout): CropBox | null {
  let b: CropBox | null = null;
  for (const l of layout.lines) {
    for (const f of l.fragments) {
      const pad = f.style.fontSize * 0.5;
      const w = f.carets[f.carets.length - 1];
      const r = { x: f.x - pad, y: f.y - l.ascent - pad, width: w + 2 * pad, height: l.ascent + l.descent + 2 * pad };
      if (!b) b = r;
      else {
        const x0 = Math.min(b.x, r.x);
        const y0 = Math.min(b.y, r.y);
        b = { x: x0, y: y0, width: Math.max(b.x + b.width, r.x + r.width) - x0, height: Math.max(b.y + b.height, r.y + r.height) - y0 };
      }
    }
  }
  return b;
}

/** Underline and strike-through bars of a fragment, text space, as rectangles. */
function decorations(f: LaidFragment, l: LaidLine): CropBox[] {
  const out: CropBox[] = [];
  const t = Math.max(1, f.style.fontSize / 15);
  const w = f.carets[f.carets.length - 1];
  if (f.style.underline) out.push({ x: f.x, y: f.y + Math.max(t, l.descent * 0.35), width: w, height: t });
  if (f.style.strikethrough) out.push({ x: f.x, y: f.y - l.ascent * 0.3 - t / 2, width: w, height: t });
  return out;
}

const rectPath = (r: CropBox): BezierPath => [
  { type: 'M', x: r.x, y: r.y },
  { type: 'L', x: r.x + r.width, y: r.y },
  { type: 'L', x: r.x + r.width, y: r.y + r.height },
  { type: 'L', x: r.x, y: r.y + r.height },
  { type: 'Z' },
];

/** The text of a fragment as outlines (one placement per character when spaced), text space. */
function fragmentOutline(shaper: TextShaper, text: string, f: LaidFragment): BezierPath {
  const s = text.slice(f.start, f.end);
  if (!f.spaced) return shaper.outline!(s, f.font, f.x, f.y);
  const out: BezierPath = [];
  for (let k = 0; k < s.length; k++) {
    if (isSpace(s[k])) continue;
    out.push(...shaper.outline!(s[k], f.font, f.x + f.carets[k], f.y));
  }
  return out;
}

/** Glyph outlines of a laid-out layer in document space, one path per fragment (needs an outline shaper). */
export function textOutlines(layer: TypeLayer, shaper: TextShaper): Array<{ fragment: LaidFragment; path: BezierPath }> {
  if (!shaper.outline) fail(`The text shaper "${shaper.id}" cannot give glyph outlines; plug in an outline shaper (createOutlineTextShaper) to convert text to shapes.`);
  const layout = layoutText(layer, shaper);
  const m = textMatrix(layer);
  const out: Array<{ fragment: LaidFragment; path: BezierPath }> = [];
  for (const l of layout.lines) {
    for (const f of l.fragments) {
      let path = fragmentOutline(shaper, layer.text, f);
      for (const r of decorations(f, l)) path = [...path, ...rectPath(r)];
      out.push({ fragment: f, path: isIdentityMatrix(m) ? path : transformBezierPath(path, m) });
    }
  }
  return out;
}

const rgbOf = (hex: string): [number, number, number] => {
  const c = parseCssColor(hex);
  const h = (c?.hex ?? '#000000').slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

/** Renders with an outline shaper: each fragment's outlines filled with its colour, in order. */
function renderOutlines(layer: TypeLayer, shaper: TextShaper, region: CropBox): PixelSurface {
  const parts = textOutlines(layer, shaper).map(({ fragment, path }) => ({ style: fragment.style, flat: flattenPath(path) as FlatPath }));
  const tiles = new Map<TileKey, Tile>();
  for (const { tx, ty } of tilesInRect(region)) {
    const rect = { x: tx * TILE, y: ty * TILE, width: TILE, height: TILE };
    const n = TILE * TILE;
    const acc = new Float32Array(n * 4);
    let any = false;
    for (const p of parts) {
      const cov = rasterizeCoverageSampled(p.flat, rect, 'nonzero');
      if (!cov) continue;
      const [r, g, b] = rgbOf(p.style.color);
      const op = p.style.opacity ?? 1;
      for (let i = 0; i < n; i++) {
        const sa = layer.antiAlias === false ? (cov[i] >= 0.5 ? op : 0) : cov[i] * op;
        if (!(sa > 0)) continue;
        const k = i * 4;
        const da = acc[k + 3];
        const ao = sa + da * (1 - sa);
        acc[k] = (r * sa + acc[k] * da * (1 - sa)) / ao;
        acc[k + 1] = (g * sa + acc[k + 1] * da * (1 - sa)) / ao;
        acc[k + 2] = (b * sa + acc[k + 2] * da * (1 - sa)) / ao;
        acc[k + 3] = ao;
        any = true;
      }
    }
    if (!any) continue;
    const px = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n * 4; i += 4) {
      const a = Math.round(acc[i + 3] * 255);
      if (!a) continue;
      px[i] = Math.round(acc[i]);
      px[i + 1] = Math.round(acc[i + 1]);
      px[i + 2] = Math.round(acc[i + 2]);
      px[i + 3] = a;
    }
    const tile = finishTile(px, 4, 0);
    if (tile) tiles.set(tileKey(tx, ty), tile);
  }
  return new TiledSurface(4, tiles, 0);
}

/** Renders with a drawing shaper on a canvas over `region`, read back into a surface. */
function renderOnCanvas(layer: TypeLayer, shaper: TextShaper, region: CropBox, env: TextEnv): PixelSurface | null {
  if (!env.createCanvas) return null;
  const canvas = env.createCanvas(region.width, region.height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!ctx || typeof ctx.getImageData !== 'function') return null;
  const layout = layoutText(layer, shaper);
  const m = textMatrix(layer);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, region.width, region.height);
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4] - region.x, m[5] - region.y);
  for (const l of layout.lines) {
    for (const f of l.fragments) {
      const [r, g, b] = rgbOf(f.style.color);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.globalAlpha = f.style.opacity ?? 1;
      const s = layer.text.slice(f.start, f.end);
      if (!f.spaced) shaper.draw!(ctx, s, f.font, f.x, f.y);
      else for (let k = 0; k < s.length; k++) if (!isSpace(s[k])) shaper.draw!(ctx, s[k], f.font, f.x + f.carets[k], f.y);
      for (const d of decorations(f, l)) ctx.fillRect(d.x, d.y, d.width, d.height);
    }
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const data = ctx.getImageData(0, 0, region.width, region.height).data;
  return surfaceFromPixels({ width: region.width, height: region.height, data: new Uint8ClampedArray(data) }, 4, region.x, region.y);
}

/**
 * Renders a type layer into a document-space surface with the env's shaper, or returns `null`
 * when nothing here can draw it (no shaper, or a drawing shaper without a canvas).
 */
export function renderText(layer: TypeLayer, env: TextEnv): { surface: PixelSurface; missingFonts: string[] } | null {
  const shaper = env.shaper;
  if (!shaper || (!shaper.outline && !shaper.draw)) return null;
  const layout = layoutText(layer, shaper);
  const ink = inkBounds(layout);
  const clip = { x: -TEXT_RENDER_MARGIN, y: -TEXT_RENDER_MARGIN, width: env.width + 2 * TEXT_RENDER_MARGIN, height: env.height + 2 * TEXT_RENDER_MARGIN };
  const region = ink ? intersect(docRect(ink, textMatrix(layer)), clip) : null;
  if (!region) return { surface: emptySurface(4), missingFonts: layout.missingFonts };
  if (shaper.outline) return { surface: renderOutlines(layer, shaper, region), missingFonts: layout.missingFonts };
  const surface = renderOnCanvas(layer, shaper, region, env);
  return surface ? { surface, missingFonts: layout.missingFonts } : null;
}

/** The layer drawn again (`rendering` and `missingFonts` updated); refuses when nothing can draw it. */
export function rerenderText(layer: TypeLayer, env: TextEnv): TypeLayer {
  const r = renderText(layer, env);
  if (!r) return fail('Type layers need a text shaper to draw them, and none is set here (no 2D canvas). Pass textShaper in the editor options (for example createOutlineTextShaper with your fonts), or edit in a browser.');
  const next: TypeLayer = { ...layer, surface: r.surface };
  delete next.rendering;
  if (r.missingFonts.length) next.missingFonts = r.missingFonts;
  else delete next.missingFonts;
  return next;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function num(v: unknown, path: string, min: number, max: number): number {
  if (!isNum(v) || v < min || v > max) fail(`${path} must be a number from ${min} to ${max}, got ${JSON.stringify(v)}.`);
  return v as number;
}

/** Fields of `TextStyle` an edit can set (`null` clears an optional one). */
export const TEXT_STYLE_FIELDS = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'color', 'opacity', 'tracking', 'leading', 'baselineShift', 'underline', 'strikethrough'] as const;

/** `base` with the given style fields changed, validated (`null` clears leading, tracking, …). */
export function patchTextStyle(base: TextStyle, patch: Record<string, unknown>, path = 'style'): TextStyle {
  const out: TextStyle = { ...base };
  const o = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    switch (k) {
      case 'fontFamily':
        if (typeof v !== 'string' || !v.trim()) fail(`${path}.fontFamily must be a font family name.`);
        out.fontFamily = (v as string).trim();
        if (out.postScriptName) delete out.postScriptName;
        break;
      case 'fontWeight': {
        const w = v === 'normal' ? 400 : v === 'bold' ? 700 : v;
        out.fontWeight = Math.round(num(w, `${path}.fontWeight`, 1, 1000));
        if (out.postScriptName) delete out.postScriptName;
        break;
      }
      case 'italic':
      case 'underline':
      case 'strikethrough':
        if (typeof v !== 'boolean' && v !== null) fail(`${path}.${k} must be true or false.`);
        if (v) o[k] = true;
        else delete o[k];
        if (k === 'italic' && out.postScriptName) delete out.postScriptName;
        break;
      case 'fontSize':
        out.fontSize = num(v, `${path}.fontSize`, 0.5, 5000);
        break;
      case 'color': {
        const c = parseCssColor(v);
        if (!c) fail(`${path}.color must be a colour such as #rrggbb.`);
        out.color = c!.hex;
        if (c!.alpha < 1) out.opacity = c!.alpha;
        break;
      }
      case 'opacity':
      case 'tracking':
      case 'leading':
      case 'baselineShift': {
        if (v === null) {
          delete o[k];
          break;
        }
        const [min, max] = k === 'opacity' ? [0, 1] : k === 'tracking' ? [-1000, 10000] : k === 'leading' ? [0, 10000] : [-5000, 5000];
        const value = num(v, `${path}.${k}`, min, max);
        if ((k === 'opacity' && value === 1) || ((k === 'tracking' || k === 'baselineShift') && value === 0)) delete o[k];
        else o[k] = value;
        break;
      }
      default:
        fail(`${path}.${k} is not a character style field; use ${TEXT_STYLE_FIELDS.join(', ')}.`);
    }
  }
  return out;
}

export const PARAGRAPH_STYLE_FIELDS = ['align', 'autoLeading', 'firstLineIndent', 'startIndent', 'endIndent', 'spaceBefore', 'spaceAfter'] as const;

/** `base` with the given paragraph fields changed, validated. */
export function patchParagraphStyle(base: ParagraphStyle, patch: Record<string, unknown>, path = 'paragraph'): ParagraphStyle {
  const out: ParagraphStyle = { ...base };
  const o = out as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'align') {
      if (!TEXT_ALIGNS.includes(v as TextAlign)) fail(`${path}.align must be one of ${TEXT_ALIGNS.join(', ')}.`);
      if (v === 'left') delete out.align;
      else out.align = v as TextAlign;
    } else if ((PARAGRAPH_STYLE_FIELDS as readonly string[]).includes(k)) {
      if (v === null) {
        delete o[k];
        continue;
      }
      const value = k === 'autoLeading' ? num(v, `${path}.${k}`, 0.1, 10) : num(v, `${path}.${k}`, -10000, 10000);
      if ((k === 'autoLeading' && value === DEFAULT_AUTO_LEADING) || (k !== 'autoLeading' && value === 0)) delete o[k];
      else o[k] = value;
    } else fail(`${path}.${k} is not a paragraph style field; use ${PARAGRAPH_STYLE_FIELDS.join(', ')}.`);
  }
  return out;
}

/** A range of the text from loose input: [start, end) in UTF-16 code units, defaults the whole text. */
export function textRange(text: string, start: unknown, end: unknown): [number, number] {
  const s = start === undefined ? 0 : start;
  const e = end === undefined ? text.length : end;
  if (!Number.isInteger(s) || !Number.isInteger(e) || (s as number) < 0 || (e as number) > text.length || (s as number) > (e as number)) {
    fail(`start and end must be whole numbers with 0 ≤ start ≤ end ≤ ${text.length} (the text's length in UTF-16 code units), got ${String(start)} and ${String(end)}.`);
  }
  return [s as number, e as number];
}

// ---------------------------------------------------------------------------
// Operations (pure; the controller adds history)
// ---------------------------------------------------------------------------

/** The type layer with `id`, or an error saying what it is instead. */
export function requireTypeLayer(layers: readonly ImageLayer[], id: string): TypeLayer {
  const layer = requireLayer(layers, id).layer;
  if (layer.type !== 'type') fail(`Layer "${layer.name || id}" is a ${layer.type} layer, not a type layer; list_layers shows each layer's type.`);
  return layer as TypeLayer;
}

/** Normalises text: line breaks as `\n`. */
export function normalizeText(text: unknown, path = 'text'): string {
  if (typeof text !== 'string') return fail(`${path} must be a string.`);
  return text.replace(/\r\n?/g, '\n');
}

/** The name Photoshop gives a type layer: its text, cut short. */
export function typeLayerName(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.trim().slice(0, 32) || 'Text';
}

export interface TypeLayerData {
  text: string;
  runs: TextRun[];
  paragraphs?: ParagraphRun[];
  frame: TypeLayer['frame'];
  transform?: AffineMatrix;
  name?: string;
}

/**
 * A new type layer, laid out and drawn. Without anything to draw it, refused, or with `lenient`
 * kept undrawn (`rendering: 'stored'`, no pixels) until a shaper draws it.
 */
export function createTypeLayer(init: TypeLayerData, env: TextEnv, id = newLayerId(), lenient = false): TypeLayer {
  const text = normalizeText(init.text);
  const layer: TypeLayer = {
    type: 'type',
    id,
    name: init.name ?? typeLayerName(text),
    visible: true,
    opacity: 1,
    blend: 'normal',
    text,
    runs: fitRuns(init.runs, text.length, DEFAULT_TEXT_STYLE),
    paragraphs: fitParagraphRuns(init.paragraphs ?? [{ length: text.length, style: {} }], text),
    frame: init.frame,
    surface: emptySurface(4),
    offset: { x: 0, y: 0 },
  };
  if (!layer.runs.length) layer.runs = [{ length: 0, style: init.runs[0]?.style ?? DEFAULT_TEXT_STYLE }];
  if (init.transform && !isIdentityMatrix(init.transform)) layer.transform = init.transform;
  if (lenient && !renderText(layer, env)) return { ...layer, rendering: 'stored' };
  return rerenderText(layer, env);
}

/** Changes a type layer (dropping its migrated annotation and stored pixels) and draws it again. */
export function updateTypeLayer(layers: readonly ImageLayer[], id: string, change: (layer: TypeLayer) => Partial<TypeLayer>, env: TextEnv, action = 'edit it'): { layers: ImageLayer[]; layer: TypeLayer } {
  const current = requireTypeLayer(layers, id);
  requireUnlocked(current, 'pixels', action);
  const patch = change(current);
  const next: TypeLayer = { ...current, ...patch };
  if (!('annotation' in patch)) delete next.annotation;
  if ('text' in patch || 'runs' in patch) next.runs = fitRuns(next.runs, next.text.length, current.runs[0]?.style ?? DEFAULT_TEXT_STYLE);
  if (!next.runs.length) next.runs = [{ length: 0, style: styleAt(current.runs, 0, DEFAULT_TEXT_STYLE) }];
  if ('text' in patch || 'paragraphs' in patch) next.paragraphs = fitParagraphRuns(next.paragraphs, next.text);
  const rendered = rerenderText(next, env);
  return { layers: mapLayer(layers, id, () => rendered), layer: rendered };
}

/** A type layer's text with [start, end) replaced by `insert`; new text takes the style at `start`. */
export function replaceTextRange(layer: TypeLayer, start: number, end: number, insert: string): Pick<TypeLayer, 'text' | 'runs' | 'paragraphs'> {
  const text = layer.text.slice(0, start) + insert + layer.text.slice(end);
  const style = styleAt(layer.runs, start > 0 && start === layer.text.length ? start - 1 : start, DEFAULT_TEXT_STYLE);
  const runs = spliceRuns(layer.runs, start, end, insert.length, style);
  const pstyle = styleAt(layer.paragraphs, start, {} as ParagraphStyle);
  const paragraphs = spliceRuns(layer.paragraphs, start, end, insert.length, pstyle) as ParagraphRun[];
  return { text, runs: runs as TextRun[], paragraphs: fitParagraphRuns(paragraphs, text) };
}

/** A type layer moved by an affine `m` (document space). */
export function transformTypeLayer(layer: TypeLayer, m: AffineMatrix): TypeLayer {
  const t = multiplyMatrices(textMatrix(layer), m);
  const next: TypeLayer = { ...layer };
  if (isIdentityMatrix(t)) delete next.transform;
  else next.transform = t;
  delete next.annotation;
  return next;
}

/** Text-space frame of a type layer (the box, or the laid-out lines) for Free Transform. */
export function typeFrame(layer: TypeLayer, shaper: TextShaper | null): CropBox {
  if (layer.frame.kind === 'box') return { x: 0, y: 0, width: layer.frame.width, height: layer.frame.height };
  if (!shaper) return fail('Type layers need a text shaper to be measured; none is set here.');
  const b = layoutText(layer, shaper).bounds;
  return { x: b.x, y: b.y, width: Math.max(b.width, 1), height: Math.max(b.height, 1) };
}

/** A type layer as a pixel layer with what it shows now (same id, name, mask, effects, blend). */
export function typeAsPixelLayer(layer: TypeLayer): PixelLayer {
  const { text: _t, runs: _r, paragraphs: _p, frame: _f, transform: _m, antiAlias: _a, rendering: _g, missingFonts: _mf, annotation: _an, psd: _psd, type: _ty, ...rest } = layer;
  return { ...rest, type: 'pixel', surface: layer.surface, offset: { x: 0, y: 0 } };
}

/** Document point → text space of a layer. */
export function toTextSpace(layer: Pick<TypeLayer, 'transform'>, p: { x: number; y: number }): { x: number; y: number } {
  return applyMatrix(invertMatrix(textMatrix(layer)), p);
}

// ---------------------------------------------------------------------------
// Text annotations → type layers (migration) and back
// ---------------------------------------------------------------------------

/** The type layer data a text annotation draws, or `null` when its colour can't be read. */
export function typeFromAnnotation(a: Annotation): TypeLayerData | null {
  if (a.type !== 'text') return null;
  const t = a as TextAnnotation;
  const c = parseCssColor(t.color);
  if (!c) return null;
  const weight = t.fontWeight === undefined || t.fontWeight === 'normal' ? 400 : t.fontWeight === 'bold' ? 700 : Number(t.fontWeight);
  if (!Number.isFinite(weight)) return null;
  const style: TextStyle = { fontFamily: t.fontFamily || 'sans-serif', fontWeight: weight, fontSize: t.fontSize, color: c.hex };
  const op = c.alpha * (t.opacity ?? 1);
  if (op !== 1) style.opacity = op;
  // The canvas drew the text unbroken on one line from its top-left (textBaseline top).
  const text = t.text.replace(/\r?\n|\r/g, ' ');
  const translate: AffineMatrix = [1, 0, 0, 1, t.x, t.y];
  const transform = t.rotation ? multiplyMatrices(translate, rotateMatrix(t.rotation, { x: t.x, y: t.y })) : translate;
  return { text, runs: [{ length: text.length, style }], frame: { kind: 'point', origin: 'top' }, transform };
}

/** The annotation a migrated type layer still is (its blend read from the layer). */
export function annotationOfType(layer: TypeLayer): Annotation | null {
  const a = layer.annotation;
  if (!a) return null;
  if ((a.blend ?? 'normal') === layer.blend) return a;
  const out = { ...a } as Annotation;
  if (layer.blend === 'normal') delete out.blend;
  else out.blend = layer.blend as Annotation['blend'];
  return out;
}
