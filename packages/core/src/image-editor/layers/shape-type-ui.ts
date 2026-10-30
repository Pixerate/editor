/**
 * Framework-free logic behind the shape and type tools of the React and Svelte image editors:
 * tool options, a drag that draws a live shape (one undo step, the layer updated live while
 * dragging), and on-canvas text editing (caret, selection, typing, keys, styling the selection,
 * the overlay to draw). The components only translate DOM events and draw `overlay()`.
 */

import type { ImageEditorController, TypeLayerInfo } from '../controller';
import type { ImagePoint } from '../types';
import { applyMatrix } from '../../geom/affine';
import { DEFAULT_TEXT_STYLE, caretAt, styleAt, textMatrix, typeLayerName, type TextLayout } from './text';
import { textArrowStep, textLineMove, textSelectionQuads } from '../../text/layout';
import { findLayer, type LiveShapeKind, type ParagraphStyle, type TextAlign, type TextOrientation, type TextStyle, type TypeLayer } from './model';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** What the shape tool draws next (and what its options bar edits on a selected shape). */
export interface ShapeToolOptions {
  kind: LiveShapeKind;
  /** `#rrggbb`, or `null` for no fill. */
  fill: string | null;
  /** `#rrggbb`, or `null` for no stroke. */
  stroke: string | null;
  strokeWidth: number;
  /** Rectangles: corner radius in pixels. */
  radius: number;
  /** Polygons: sides. */
  sides: number;
  /** Stars: points and inner radius ratio. */
  points: number;
  innerRatio: number;
  /** Lines: thickness in pixels and whether to add an arrowhead at the end. */
  weight: number;
  arrow: boolean;
}

export const DEFAULT_SHAPE_TOOL_OPTIONS: ShapeToolOptions = {
  kind: 'rect',
  fill: '#4f46e5',
  stroke: null,
  strokeWidth: 2,
  radius: 0,
  sides: 6,
  points: 5,
  innerRatio: 0.5,
  weight: 4,
  arrow: false,
};

export const SHAPE_KIND_LABELS: Record<LiveShapeKind, string> = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', line: 'Line' };

/** What the type tool sets new text in (and what its options bar edits on the selection). */
export interface TypeToolOptions {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  align: TextAlign;
  /** Horizontal Type or Vertical Type tool (missing = horizontal): what new text is set as. */
  orientation?: TextOrientation;
}

export const DEFAULT_TYPE_TOOL_OPTIONS: TypeToolOptions = { fontFamily: 'sans-serif', fontSize: 32, fontWeight: 400, italic: false, color: '#111827', align: 'left' };

/** A live shape for a drag from `a` to `b` (Shift: square / circle / 45° line; Alt: from the centre). */
export function liveShapeForDrag(o: ShapeToolOptions, a: ImagePoint, b: ImagePoint, mods: { shift?: boolean; alt?: boolean } = {}): Record<string, unknown> | null {
  if (o.kind === 'line') {
    let x2 = b.x;
    let y2 = b.y;
    if (mods.shift) {
      const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      x2 = a.x + Math.cos(ang) * len;
      y2 = a.y + Math.sin(ang) * len;
    }
    if (Math.hypot(x2 - a.x, y2 - a.y) < 1) return null;
    const head = o.arrow ? { endArrow: { width: o.weight * 4, length: o.weight * 4 } } : {};
    return { kind: 'line', x1: a.x, y1: a.y, x2, y2, weight: o.weight, ...head };
  }
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (mods.shift) {
    const s = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * s;
    h = Math.sign(h || 1) * s;
  }
  let x = a.x;
  let y = a.y;
  if (mods.alt) {
    x = a.x - w;
    y = a.y - h;
    w *= 2;
    h *= 2;
  }
  const box = { x: Math.min(x, x + w), y: Math.min(y, y + h), width: Math.abs(w), height: Math.abs(h) };
  if (box.width < 1 || box.height < 1) return null;
  switch (o.kind) {
    case 'rect':
      return { kind: 'rect', ...box, ...(o.radius > 0 ? { radius: o.radius } : {}) };
    case 'ellipse':
      return { kind: 'ellipse', ...box };
    case 'polygon':
      return { kind: 'polygon', ...box, sides: o.sides };
    case 'star':
      return { kind: 'star', ...box, points: o.points, innerRatio: o.innerRatio };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shape drawing
// ---------------------------------------------------------------------------

/**
 * A drag that draws a live shape: the layer is added on the first real move (one undo step) and
 * its component updated live (no history) until the pointer is released.
 */
export class ShapeDrawGesture {
  private start: ImagePoint | null = null;
  private layerId: string | null = null;
  error: string | null = null;

  constructor(
    private readonly controller: ImageEditorController,
    private readonly options: () => ShapeToolOptions
  ) {}

  get active(): boolean {
    return this.start !== null;
  }

  /** The shape layer drawn by the last drag (until the next one starts). */
  get drawnLayerId(): string | null {
    return this.layerId;
  }

  down(p: ImagePoint): void {
    this.error = null;
    this.start = { x: p.x, y: p.y };
    this.layerId = null;
  }

  move(p: ImagePoint, mods: { shift?: boolean; alt?: boolean } = {}): void {
    if (!this.start) return;
    const o = this.options();
    const shape = liveShapeForDrag(o, this.start, p, mods);
    if (!shape) return;
    try {
      if (!this.layerId) {
        const isLine = o.kind === 'line';
        this.layerId = this.controller.addShapeLayer({
          shape,
          fill: isLine ? (o.stroke ?? o.fill ?? '#000000') : o.fill,
          stroke: !isLine && o.stroke ? { width: o.strokeWidth, paint: o.stroke } : null,
        });
      } else this.controller.setShapeComponent(this.layerId, 0, { shape }, false);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.start = null;
    }
  }

  up(): string | null {
    this.start = null;
    return this.layerId;
  }

  cancel(): void {
    this.start = null;
  }
}

/** Applies options-bar changes to a shape layer (fill, stroke, width, and the live shape's own fields). */
export function applyShapeOptions(controller: ImageEditorController, layerId: string, change: Partial<ShapeToolOptions>): void {
  const info = controller.getShapeLayer(layerId);
  const style: Parameters<ImageEditorController['setShapeStyle']>[1] = {};
  if ('fill' in change) style.fill = change.fill ?? null;
  if ('stroke' in change || 'strokeWidth' in change) {
    const color = 'stroke' in change ? change.stroke : (info.stroke?.paint.type === 'color' ? info.stroke.paint.color : null);
    style.stroke = color ? { width: change.strokeWidth ?? info.stroke?.width ?? 2, paint: color } : null;
  }
  if (Object.keys(style).length) controller.setShapeStyle(layerId, style);
  const live = info.components[0]?.live;
  if (!live) return;
  const shape: Record<string, unknown> = {};
  if (live.kind === 'rect' && change.radius !== undefined) shape.radius = change.radius;
  if (live.kind === 'polygon' && change.sides !== undefined) shape.sides = change.sides;
  if (live.kind === 'star' && change.points !== undefined) shape.points = change.points;
  if (live.kind === 'star' && change.innerRatio !== undefined) shape.innerRatio = change.innerRatio;
  if (live.kind === 'line' && change.weight !== undefined) shape.weight = change.weight;
  if (live.kind === 'line' && change.arrow !== undefined) shape.endArrow = change.arrow ? { width: (live.weight || 1) * 4, length: (live.weight || 1) * 4 } : null;
  if (Object.keys(shape).length) controller.setShapeComponent(layerId, 0, { shape });
}

// ---------------------------------------------------------------------------
// Text editing
// ---------------------------------------------------------------------------

/** The keys a text session understands, as DOM `KeyboardEvent`s report them. */
export interface TextKey {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * Editing one type layer on the canvas: a caret and a selection (`anchor`..`focus`, UTF-16 code
 * units), typing, deleting, moving, clicking and styling the selection. The first change of a
 * session records one undo step; the rest join it.
 */
export class TextEditSession {
  anchor: number;
  focus: number;
  private changed = false;
  private readonly listeners = new Set<() => void>();
  error: string | null = null;

  constructor(
    private readonly controller: ImageEditorController,
    readonly layerId: string,
    index?: number
  ) {
    const n = this.text.length;
    this.anchor = this.focus = Math.max(0, Math.min(n, index ?? n));
  }

  private get layer(): TypeLayer {
    const l = findLayer(this.controller.getLayers(), this.layerId)?.layer;
    if (!l || l.type !== 'type') throw new Error('The type layer being edited is gone.');
    return l;
  }

  get text(): string {
    return this.layer.text;
  }

  get start(): number {
    return Math.min(this.anchor, this.focus);
  }

  get end(): number {
    return Math.max(this.anchor, this.focus);
  }

  /** Whether the layer still exists (it can be deleted or undone away while editing). */
  get alive(): boolean {
    return findLayer(this.controller.getLayers(), this.layerId)?.layer.type === 'type';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private layout(): TextLayout | null {
    return this.controller.getTextLayout(this.layerId);
  }

  private run<T>(fn: (commit: boolean) => T): T | undefined {
    this.error = null;
    try {
      const out = fn(!this.changed);
      this.changed = true;
      return out;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return undefined;
    } finally {
      this.emit();
    }
  }

  /** Replaces the selection with `text` (typing and pasting). */
  insert(text: string): void {
    if (!text) return;
    const s = this.start;
    const e = this.end;
    const done = this.run((commit) => this.controller.setText(this.layerId, text, { start: s, end: e }, commit));
    if (done) this.anchor = this.focus = s + text.replace(/\r\n?/g, '\n').length;
  }

  /** Backspace: the selection, else the character before the caret. */
  deleteBackward(): void {
    if (this.start === this.end && this.start === 0) return;
    const s = this.start === this.end ? Math.max(0, this.start - this.surrogate(this.start - 1, -1)) : this.start;
    const e = this.end;
    if (this.run((commit) => this.controller.setText(this.layerId, '', { start: s, end: e }, commit))) this.anchor = this.focus = s;
  }

  /** Delete: the selection, else the character after the caret. */
  deleteForward(): void {
    const n = this.text.length;
    if (this.start === this.end && this.end >= n) return;
    const s = this.start;
    const e = this.start === this.end ? Math.min(n, this.end + this.surrogate(this.end, 1)) : this.end;
    if (this.run((commit) => this.controller.setText(this.layerId, '', { start: s, end: e }, commit))) this.anchor = this.focus = s;
  }

  /** 2 when the code unit at `i` is half of a surrogate pair (moving `dir`), else 1. */
  private surrogate(i: number, dir: 1 | -1): number {
    const t = this.text;
    const c = t.charCodeAt(i);
    if (dir < 0 && c >= 0xdc00 && c <= 0xdfff && i > 0) return 2;
    if (dir > 0 && c >= 0xd800 && c <= 0xdbff && i + 1 < t.length) return 2;
    return 1;
  }

  /**
   * Moves the caret (Shift extends the selection): `left` / `right` along the line, `up` / `down`
   * between lines, `home` / `end` of the line, `start` / `finish` of the text. Arrow keys of vertical
   * text map onto these through `textArrowStep` in `handleKey`.
   */
  move(to: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'start' | 'finish', extend = false): void {
    const n = this.text.length;
    let f = this.focus;
    const collapsedJump = !extend && this.start !== this.end;
    if (to === 'left') f = collapsedJump ? this.start : Math.max(0, f - this.surrogate(f - 1, -1));
    else if (to === 'right') f = collapsedJump ? this.end : Math.min(n, f + this.surrogate(f, 1));
    else if (to === 'start') f = 0;
    else if (to === 'finish') f = n;
    else {
      const layout = this.layout();
      if (layout && layout.lines.length) {
        const c = caretAt(layout, f);
        const line = layout.lines[c.line];
        if (to === 'home') f = line.start;
        else if (to === 'end') {
          const last = line.chars[line.chars.length - 1];
          f = last ? Math.min(n, last.index + 1) : line.start;
          if (last && this.text[last.index] === ' ' && c.line < layout.lines.length - 1) f = last.index;
        } else f = textLineMove(layout, f, to === 'up' ? -1 : 1, n);
      }
    }
    this.focus = f;
    if (!extend) this.anchor = f;
    this.emit();
  }

  selectAll(): void {
    this.anchor = 0;
    this.focus = this.text.length;
    this.emit();
  }

  /** Places the caret at a document point (Shift-click extends). */
  pointAt(p: ImagePoint, extend = false): void {
    this.focus = this.controller.textIndexAt(this.layerId, p);
    if (!extend) this.anchor = this.focus;
    this.emit();
  }

  /** Handles a key; returns `true` when it was the session's (the caller then prevents the default). */
  handleKey(e: TextKey): boolean {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'a') {
      this.selectAll();
      return true;
    }
    switch (e.key) {
      case 'Backspace':
        this.deleteBackward();
        return true;
      case 'Delete':
        this.deleteForward();
        return true;
      case 'Enter':
        this.insert('\n');
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        // Vertical text: ↑ ↓ run along the column, ← → between columns.
        const step = textArrowStep(this.layer.orientation, e.key);
        if (step === 'previous') this.move(mod ? 'home' : 'left', e.shiftKey);
        else if (step === 'next') this.move(mod ? 'end' : 'right', e.shiftKey);
        else if (step === 'line-before') this.move(mod ? 'start' : 'up', e.shiftKey);
        else this.move(mod ? 'finish' : 'down', e.shiftKey);
        return true;
      }
      case 'Home':
        this.move('home', e.shiftKey);
        return true;
      case 'End':
        this.move('end', e.shiftKey);
        return true;
      case 'Tab':
        this.insert('\t');
        return true;
    }
    if (!mod && !e.altKey && e.key.length >= 1 && [...e.key].length === 1) {
      this.insert(e.key);
      return true;
    }
    return false;
  }

  /** Sets character style fields on the selection, or on the whole text when nothing is selected. */
  setStyle(style: Partial<TextStyle>): void {
    const s = this.start;
    const e = this.end;
    const range = s === e ? {} : { start: s, end: e };
    this.run((commit) => this.controller.setTextStyle(this.layerId, style as Partial<TextStyle> & Record<string, unknown>, range, commit));
  }

  /** Sets paragraph fields on the paragraphs the selection touches. */
  setParagraph(style: ParagraphStyle): void {
    const s = this.start;
    const e = this.end;
    this.run((commit) => this.controller.setParagraphStyle(this.layerId, style as ParagraphStyle & Record<string, unknown>, { start: s, end: e }, commit));
  }

  /** The style at the caret (or the selection's start), for the options bar. */
  styleHere(): TextStyle {
    const layer = this.layer;
    const at = this.start > 0 && this.start === this.end ? this.start - 1 : this.start;
    return styleAt(layer.runs, at, DEFAULT_TEXT_STYLE);
  }

  info(): TypeLayerInfo {
    return this.controller.getTextLayer(this.layerId);
  }

  /** The caret, the selection and the frame in natural pixels, for `RenderOptions.textEdit`. */
  overlay(): { caret: [ImagePoint, ImagePoint] | null; selection: ImagePoint[][]; frame: ImagePoint[] | null } {
    const layer = this.layer;
    const layout = this.layout();
    const m = textMatrix(layer);
    const at = (x: number, y: number) => applyMatrix(m, { x, y });
    let frame: ImagePoint[] | null = null;
    if (layer.frame.kind === 'box') frame = [at(0, 0), at(layer.frame.width, 0), at(layer.frame.width, layer.frame.height), at(0, layer.frame.height)];
    else if (layout) {
      const b = layout.bounds;
      frame = [at(b.x, b.y), at(b.x + b.width, b.y), at(b.x + b.width, b.y + b.height), at(b.x, b.y + b.height)];
    }
    if (!layout) return { caret: null, selection: [], frame };
    const selection = textSelectionQuads(layout, this.start, this.end).map((q) => q.map((p) => at(p.x, p.y)));
    const c = caretAt(layout, this.focus);
    return { caret: [at(c.from.x, c.from.y), at(c.to.x, c.to.y)], selection, frame };
  }

  /** Ends editing: an empty layer made for this session is deleted (as Photoshop does). Returns whether the layer remains. */
  close(): boolean {
    if (!this.alive) return false;
    if (!this.text.trim().length) {
      try {
        this.controller.removeLayer(this.layerId);
      } catch {
        // A locked or already removed layer stays as it is.
      }
      return false;
    }
    // New text is named after what was typed, as in Photoshop.
    if (this.layer.name === 'Text' && this.changed) {
      try {
        this.controller.setLayerProperties(this.layerId, { name: typeLayerName(this.text) }, false);
      } catch {
        // Keep the name.
      }
    }
    return true;
  }
}

/** Where a click lands on type layers: the topmost visible type layer whose laid-out text or box contains `p`, or `null`. */
export function typeLayerAt(controller: ImageEditorController, p: ImagePoint, slop = 4): string | null {
  const layers = [...flattenTypeLayers(controller.getLayers())].reverse();
  for (const l of layers) {
    if (!l.visible) continue;
    const inv = invert(textMatrix(l));
    const q = applyMatrix(inv, p);
    let b: { x: number; y: number; width: number; height: number } | null = null;
    if (l.frame.kind === 'box') b = { x: 0, y: 0, width: l.frame.width, height: l.frame.height };
    else {
      const layout = controller.getTextLayout(l.id);
      if (layout) b = layout.bounds;
    }
    if (b && q.x >= b.x - slop && q.x <= b.x + b.width + slop && q.y >= b.y - slop && q.y <= b.y + b.height + slop) return l.id;
  }
  return null;
}

function flattenTypeLayers(layers: ReturnType<ImageEditorController['getLayers']>): TypeLayer[] {
  const out: TypeLayer[] = [];
  const walk = (list: typeof layers) => {
    for (const l of list) {
      if (l.type === 'type') out.push(l);
      else if (l.type === 'group') walk(l.children);
    }
  };
  walk(layers);
  return out;
}

function invert(m: readonly number[]): [number, number, number, number, number, number] {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * The type tool: a click on type edits it at the clicked character; a click elsewhere adds point
 * text there (a drag adds paragraph text in the dragged box). Holds the open `TextEditSession`.
 */
export class TypeToolGesture {
  session: TextEditSession | null = null;
  private dragStart: ImagePoint | null = null;
  error: string | null = null;

  constructor(
    private readonly controller: ImageEditorController,
    private readonly options: () => TypeToolOptions
  ) {}

  down(p: ImagePoint, mods: { shift?: boolean } = {}): void {
    this.error = null;
    const hit = typeLayerAt(this.controller, p);
    if (this.session && this.session.alive && hit === this.session.layerId) {
      this.session.pointAt(p, mods.shift);
      this.dragStart = null;
      return;
    }
    this.finish();
    if (hit) {
      this.controller.setActiveLayer(hit);
      this.session = new TextEditSession(this.controller, hit, this.controller.textIndexAt(hit, p));
      this.dragStart = null;
      return;
    }
    this.dragStart = { x: p.x, y: p.y };
  }

  /** Releases a click or drag that did not land on type: adds a new text layer (point text, or a box for a drag). */
  up(p: ImagePoint): TextEditSession | null {
    const start = this.dragStart;
    this.dragStart = null;
    if (!start) return this.session;
    const o = this.options();
    const w = Math.abs(p.x - start.x);
    const h = Math.abs(p.y - start.y);
    try {
      const box = w >= 8 && h >= 8 ? { width: w, height: h } : undefined;
      const id = this.controller.addTextLayer({
        text: '',
        x: box ? Math.min(start.x, p.x) : start.x,
        y: box ? Math.min(start.y, p.y) : start.y,
        ...(box ? { box } : {}),
        style: { fontFamily: o.fontFamily, fontSize: o.fontSize, fontWeight: o.fontWeight, italic: o.italic, color: o.color },
        paragraph: o.align !== 'left' ? { align: o.align } : {},
        ...(o.orientation === 'vertical' ? { orientation: 'vertical' as const } : {}),
        name: 'Text',
      });
      this.session = new TextEditSession(this.controller, id, 0);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    return this.session;
  }

  /** Ends the open session (an empty new layer is removed). */
  finish(): void {
    const s = this.session;
    this.session = null;
    s?.close();
  }
}
