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

import {
  caretAt,
  DEFAULT_AUTO_LEADING,
  DEFAULT_TEXT_STYLE,
  fitParagraphRuns,
  fitRuns,
  fontOf,
  isTextSpace,
  layoutText,
  paragraphRanges,
  restyleRange,
  spliceRuns,
  styleAt,
  textDecorations,
  textFragmentOutline,
  textIndexAt,
  textRectPath,
  type LaidChar,
  type LaidFragment,
  type LaidLine,
  type TextLayout,
} from '../../text/layout';
import type { TextFont, TextShaper } from '../../text/types';

// The layout and shaper model moved to `src/text` so the vector editor shares them; these
// re-exports keep the image editor's API as it was.
export { caretAt, DEFAULT_AUTO_LEADING, DEFAULT_TEXT_STYLE, fitParagraphRuns, fitRuns, fontOf, layoutText, paragraphRanges, restyleRange, spliceRuns, styleAt, textIndexAt };
export type { LaidChar, LaidFragment, LaidLine, TextFont, TextLayout, TextShaper };

const fail = (message: string): never => {
  throw new LayerOperationError(message);
};

// ---------------------------------------------------------------------------
// Shapers
// ---------------------------------------------------------------------------

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

/** Glyph outlines of a laid-out layer in document space, one path per fragment (needs an outline shaper). */
export function textOutlines(layer: TypeLayer, shaper: TextShaper): Array<{ fragment: LaidFragment; path: BezierPath }> {
  if (!shaper.outline) fail(`The text shaper "${shaper.id}" cannot give glyph outlines; plug in an outline shaper (createOutlineTextShaper) to convert text to shapes.`);
  const layout = layoutText(layer, shaper);
  const m = textMatrix(layer);
  const out: Array<{ fragment: LaidFragment; path: BezierPath }> = [];
  for (const l of layout.lines) {
    for (const f of l.fragments) {
      let path = textFragmentOutline(shaper, layer.text, f);
      for (const r of textDecorations(f, l)) path = [...path, ...textRectPath(r)];
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
      else for (let k = 0; k < s.length; k++) if (!isTextSpace(s[k])) shaper.draw!(ctx, s[k], f.font, f.x + f.carets[k], f.y);
      for (const d of textDecorations(f, l)) ctx.fillRect(d.x, d.y, d.width, d.height);
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
export const TEXT_STYLE_FIELDS = ['fontFamily', 'fontWeight', 'italic', 'fontSize', 'color', 'opacity', 'tracking', 'leading', 'baselineShift', 'underline', 'strikethrough', 'postScriptName'] as const;

/** `base` with the given style fields changed, validated (`null` clears leading, tracking, …). */
export function patchTextStyle(base: TextStyle, patch: Record<string, unknown>, path = 'style'): TextStyle {
  const out: TextStyle = { ...base };
  const o = out as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    switch (k) {
      case 'postScriptName':
        if (typeof v !== 'string' && v !== null) fail(`${path}.postScriptName must be a PostScript font name.`);
        if (v) out.postScriptName = (v as string).trim();
        else delete out.postScriptName;
        break;
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
