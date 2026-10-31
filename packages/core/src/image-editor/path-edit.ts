/**
 * Framework-free logic behind the path tools of the React and Svelte image editors (Photoshop's
 * Path Selection, Direct Selection and Pen): hit-testing anchors, handles and segments, dragging
 * them (one undo step per drag, the target updated live while dragging), converting, inserting and
 * deleting anchors, drawing new subpaths with the Pen, and the overlay to draw. They edit what
 * `controller.pathEditTarget()` names: the active path, the active shape layer or the active
 * layer's vector mask. The components only translate DOM events and draw `overlay()`.
 */

import type { ImageEditorController } from './controller';
import type { CropBox, ImagePoint } from './types';
import type { ShapeComponent } from './layers/model';
import type { PathEditTarget } from './paths';
import type { VectorAnchor, VectorSubpath } from '../vector/types';
import { cloneAnchor, convertAnchor, inferAnchorType, insertAnchor, moveAnchorHandle, removeAnchors, subpathSegment, subpathSegmentCount, subpathsToBezier, translateAnchor } from '../vector/geometry';
import { bendSegment, removeAnchorsKeepingShape } from '../vector/pathEdit';
import { pointInBezierPath, segmentNearest } from '../canvas/pathops/bezier';

/** The path tools: whole components (`path-select`), anchors and handles (`direct-select`), and the Pen (`path-pen`). */
export type PathEditTool = 'path-select' | 'direct-select' | 'path-pen';

export const PATH_EDIT_TOOLS: readonly PathEditTool[] = ['path-select', 'direct-select', 'path-pen'];

export function isPathEditTool(tool: string): tool is PathEditTool {
  return (PATH_EDIT_TOOLS as readonly string[]).includes(tool);
}

/** One anchor of a target: component, subpath and anchor index. */
export interface PathAnchorRef {
  component: number;
  subpath: number;
  anchor: number;
}

/** What `RenderOptions.pathEdit` draws, in document pixels. */
export interface PathEditOverlay {
  /** The target's segments: 2 points for a line, 4 for a cubic. */
  curves: ImagePoint[][];
  /** Anchors shown; selected ones are drawn filled. */
  anchors: Array<{ point: ImagePoint; selected: boolean }>;
  /** Direction handles of the selected anchors, with the anchor each belongs to. */
  handles: Array<{ point: ImagePoint; anchor: ImagePoint }>;
  /** A marquee being dragged to select anchors. */
  marquee: CropBox | null;
  /** The Pen's next segment, from the last anchor to the pointer (2 or 4 points). */
  preview: ImagePoint[] | null;
}

export interface PathEditModifiers {
  shift?: boolean;
  alt?: boolean;
}

type Drag =
  | { kind: 'anchors'; start: ImagePoint; base: ShapeComponent[]; moved: boolean }
  | { kind: 'handle'; ref: PathAnchorRef; side: 'in' | 'out'; base: ShapeComponent[]; breakHandles: boolean; moved: boolean }
  | { kind: 'segment'; ref: PathAnchorRef; t: number; base: ShapeComponent[]; moved: boolean }
  | { kind: 'pen'; ref: PathAnchorRef; base: ShapeComponent[] }
  | { kind: 'marquee'; start: ImagePoint; end: ImagePoint; keep: Set<string> };

const key = (r: PathAnchorRef) => `${r.component}:${r.subpath}:${r.anchor}`;
const parseKey = (k: string): PathAnchorRef => {
  const [component, subpath, anchor] = k.split(':').map(Number);
  return { component, subpath, anchor };
};
const pt = (p: { x: number; y: number }): ImagePoint => ({ x: p.x, y: p.y });
const cloneComponents = (cs: readonly ShapeComponent[]): ShapeComponent[] =>
  cs.map((c) => ({ op: c.op, subpaths: c.subpaths.map((sp) => ({ anchors: sp.anchors.map(cloneAnchor), closed: sp.closed })), ...(c.live ? { live: c.live } : {}) }));
const sameTarget = (a: PathEditTarget | null, b: PathEditTarget | null) =>
  !!a && !!b && a.kind === b.kind && (a.kind === 'path' ? a.id === (b as typeof a).id : a.layerId === (b as { layerId: string }).layerId);

/**
 * The path tools' pointer and key handling. Call `setView` with the screen pixels per document
 * pixel so hits are a fixed size on screen; `down` / `move` / `up` take document pixels.
 */
export class PathEditGesture {
  /** Selected anchors, as `component:subpath:anchor` keys. */
  private selected = new Set<string>();
  private target: PathEditTarget | null = null;
  private drag: Drag | null = null;
  /** The Pen's open subpath being drawn. */
  private drawing: { component: number; subpath: number } | null = null;
  private pointer: ImagePoint | null = null;
  private scale = 1;
  error: string | null = null;

  constructor(private readonly controller: ImageEditorController) {}

  /** Screen pixels per document pixel (the viewport projection's scale). */
  setView(scale: number): void {
    if (scale > 0 && Number.isFinite(scale)) this.scale = scale;
  }

  get active(): boolean {
    return this.drag !== null;
  }

  /** The anchors selected now (on the current target). */
  get selection(): PathAnchorRef[] {
    return [...this.selected].map(parseKey);
  }

  /** True while the Pen has an open subpath it adds to. */
  get isDrawing(): boolean {
    return this.drawing !== null;
  }

  private get tolerance(): number {
    return 6 / this.scale;
  }

  /** The target's components, or null (and the selection dropped) when the target changed or is gone. */
  private components(): ShapeComponent[] | null {
    const target = this.controller.pathEditTarget();
    if (!sameTarget(target, this.target)) {
      this.target = target;
      this.selected.clear();
      this.drawing = null;
    }
    if (!target) return null;
    let cs: ShapeComponent[];
    try {
      cs = this.controller.getPathEditComponents(target);
    } catch {
      return null;
    }
    // Undo can take anchors away under the selection or the subpath being drawn.
    for (const k of [...this.selected]) {
      const r = parseKey(k);
      if (!cs[r.component]?.subpaths[r.subpath]?.anchors[r.anchor]) this.selected.delete(k);
    }
    const d = this.drawing;
    if (d && (!cs[d.component]?.subpaths[d.subpath] || cs[d.component].subpaths[d.subpath].closed)) this.drawing = null;
    return cs;
  }

  private anchorAt(cs: readonly ShapeComponent[], p: ImagePoint): PathAnchorRef | null {
    const tol = this.tolerance;
    let best: PathAnchorRef | null = null;
    let bestD = tol;
    cs.forEach((c, ci) =>
      c.subpaths.forEach((sp, si) =>
        sp.anchors.forEach((a, ai) => {
          const d = Math.hypot(a.x - p.x, a.y - p.y);
          if (d <= bestD) {
            bestD = d;
            best = { component: ci, subpath: si, anchor: ai };
          }
        })
      )
    );
    return best;
  }

  /** A handle of a selected anchor near `p`. */
  private handleAt(cs: readonly ShapeComponent[], p: ImagePoint): { ref: PathAnchorRef; side: 'in' | 'out' } | null {
    const tol = this.tolerance;
    for (const r of this.selection) {
      const a = cs[r.component].subpaths[r.subpath].anchors[r.anchor];
      for (const side of ['out', 'in'] as const) {
        const h = a[side];
        if (h && Math.hypot(h.x - p.x, h.y - p.y) <= tol) return { ref: r, side };
      }
    }
    return null;
  }

  /** The segment near `p`: its first anchor (as `anchor`) and the parameter on it. */
  private segmentAt(cs: readonly ShapeComponent[], p: ImagePoint): { ref: PathAnchorRef; t: number } | null {
    let best: { ref: PathAnchorRef; t: number } | null = null;
    let bestD = this.tolerance;
    cs.forEach((c, ci) =>
      c.subpaths.forEach((sp, si) => {
        for (let i = 0; i < subpathSegmentCount(sp); i++) {
          const { t, distance } = segmentNearest(subpathSegment(sp, i), [p.x, p.y]);
          if (distance <= bestD) {
            bestD = distance;
            best = { ref: { component: ci, subpath: si, anchor: i }, t };
          }
        }
      })
    );
    return best;
  }

  /** The component under `p`: on its outline, or inside its fill. */
  private componentAt(cs: readonly ShapeComponent[], p: ImagePoint): number | null {
    const seg = this.segmentAt(cs, p) ?? (this.anchorAt(cs, p) ? { ref: this.anchorAt(cs, p)! } : null);
    if (seg) return seg.ref.component;
    for (let i = cs.length - 1; i >= 0; i--) {
      const closed = cs[i].subpaths.filter((sp) => sp.anchors.length > 2);
      if (closed.length && pointInBezierPath(subpathsToBezier(closed), [p.x, p.y])) return i;
    }
    return null;
  }

  private selectComponent(cs: readonly ShapeComponent[], ci: number): void {
    cs[ci].subpaths.forEach((sp, si) => sp.anchors.forEach((_, ai) => this.selected.add(key({ component: ci, subpath: si, anchor: ai }))));
  }

  private commit(cs: readonly ShapeComponent[], record: boolean): boolean {
    if (!this.target) return false;
    try {
      this.controller.setPathEditComponents(this.target, cs, record);
      return true;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  down(p: ImagePoint, tool: PathEditTool, mods: PathEditModifiers = {}): void {
    this.error = null;
    this.pointer = pt(p);
    const cs = this.components();
    if (tool === 'path-pen') return this.penDown(cs, p, mods);
    if (!cs) {
      this.error = 'There is no path to edit: pick a path in the Paths panel, a shape layer, or a layer with a vector mask (or draw one with the Pen).';
      return;
    }
    if (tool === 'path-select') {
      const ci = this.componentAt(cs, p);
      if (ci === null) {
        this.drag = { kind: 'marquee', start: pt(p), end: pt(p), keep: mods.shift ? new Set(this.selected) : new Set() };
        if (!mods.shift) this.selected.clear();
        return;
      }
      const ref = { component: ci, subpath: 0, anchor: 0 };
      if (!mods.shift && !this.selected.has(key(ref))) this.selected.clear();
      this.selectComponent(cs, ci);
      this.drag = { kind: 'anchors', start: pt(p), base: cloneComponents(cs), moved: false };
      return;
    }
    const handle = this.handleAt(cs, p);
    if (handle) {
      this.drag = { kind: 'handle', ...handle, base: cloneComponents(cs), breakHandles: !!mods.alt, moved: false };
      return;
    }
    const anchor = this.anchorAt(cs, p);
    if (anchor) {
      if (mods.alt) return this.convert(cs, anchor);
      const k = key(anchor);
      if (mods.shift) {
        if (this.selected.has(k)) this.selected.delete(k);
        else this.selected.add(k);
      } else if (!this.selected.has(k)) {
        this.selected.clear();
        this.selected.add(k);
      }
      this.drag = { kind: 'anchors', start: pt(p), base: cloneComponents(cs), moved: false };
      return;
    }
    const seg = this.segmentAt(cs, p);
    if (seg) {
      if (!mods.shift) this.selected.clear();
      this.drag = { kind: 'segment', ...seg, base: cloneComponents(cs), moved: false };
      return;
    }
    this.drag = { kind: 'marquee', start: pt(p), end: pt(p), keep: mods.shift ? new Set(this.selected) : new Set() };
    if (!mods.shift) this.selected.clear();
  }

  /** Alt-click: a corner anchor becomes smooth, a smooth one a corner (one undo step). */
  private convert(cs: ShapeComponent[], r: PathAnchorRef): void {
    const next = cloneComponents(cs);
    const c = next[r.component];
    const sp = c.subpaths[r.subpath];
    const a = sp.anchors[r.anchor];
    const type = inferAnchorType(a) === 'corner' && !a.in && !a.out ? 'smooth' : 'corner';
    c.subpaths[r.subpath] = convertAnchor(sp, r.anchor, type);
    delete c.live;
    this.selected.clear();
    this.selected.add(key(r));
    this.commit(next, true);
  }

  private penDown(cs: ShapeComponent[] | null, p: ImagePoint, mods: PathEditModifiers): void {
    const d = this.drawing;
    if (cs && d) {
      const next = cloneComponents(cs);
      const c = next[d.component];
      const sp = c.subpaths[d.subpath];
      const first = sp.anchors[0];
      delete c.live;
      if (sp.anchors.length > 1 && Math.hypot(first.x - p.x, first.y - p.y) <= this.tolerance) {
        // Clicking the first anchor closes the subpath.
        sp.closed = true;
        this.drawing = null;
        const ref = { component: d.component, subpath: d.subpath, anchor: 0 };
        if (this.commit(next, true)) this.drag = { kind: 'pen', ref, base: next };
        return;
      }
      sp.anchors.push({ x: p.x, y: p.y });
      const ref = { component: d.component, subpath: d.subpath, anchor: sp.anchors.length - 1 };
      this.selected = new Set([key(ref)]);
      if (this.commit(next, true)) this.drag = { kind: 'pen', ref, base: next };
      return;
    }
    if (cs) {
      // Auto Add / Delete: on an anchor deletes it (Alt converts it), on a segment adds one.
      const anchor = this.anchorAt(cs, p);
      if (anchor && mods.alt) return this.convert(cs, anchor);
      if (anchor) {
        const next = cloneComponents(cs);
        const c = next[anchor.component];
        const sp = c.subpaths[anchor.subpath];
        delete c.live;
        c.subpaths[anchor.subpath] = sp.anchors.length > 2 ? removeAnchorsKeepingShape(sp, [anchor.anchor]) : removeAnchors(sp, [anchor.anchor]);
        this.selected.clear();
        this.commit(prune(next), true);
        return;
      }
      const seg = this.segmentAt(cs, p);
      if (seg) {
        const next = cloneComponents(cs);
        const c = next[seg.ref.component];
        const { subpath, index } = insertAnchor(c.subpaths[seg.ref.subpath], seg.ref.anchor, seg.t);
        c.subpaths[seg.ref.subpath] = subpath;
        delete c.live;
        this.selected = new Set([key({ ...seg.ref, anchor: index })]);
        this.commit(next, true);
        return;
      }
    }
    // A new subpath: on the target's top component, or a new Work Path when there is no target.
    const start: VectorSubpath = { anchors: [{ x: p.x, y: p.y }], closed: false };
    if (!this.target || !cs) {
      try {
        const path = this.controller.startWorkPath([{ op: 'combine', subpaths: [start] }]);
        this.target = { kind: 'path', id: path.id };
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        return;
      }
      this.drawing = { component: 0, subpath: 0 };
    } else {
      const next = cloneComponents(cs);
      if (!next.length) next.push({ op: 'combine', subpaths: [] });
      const ci = next.length - 1;
      delete next[ci].live;
      next[ci].subpaths.push(start);
      if (!this.commit(next, true)) return;
      this.drawing = { component: ci, subpath: next[ci].subpaths.length - 1 };
    }
    const ref = { component: this.drawing.component, subpath: this.drawing.subpath, anchor: 0 };
    this.selected = new Set([key(ref)]);
    this.drag = { kind: 'pen', ref, base: cloneComponents(this.controller.getPathEditComponents(this.target!)) };
  }

  move(p: ImagePoint, mods: PathEditModifiers = {}): void {
    this.pointer = pt(p);
    const g = this.drag;
    if (!g) return;
    if (g.kind === 'marquee') {
      g.end = pt(p);
      const box = rect(g.start, g.end);
      const cs = this.target ? this.controller.getPathEditComponents(this.target) : [];
      this.selected = new Set(g.keep);
      cs.forEach((c, ci) =>
        c.subpaths.forEach((sp, si) =>
          sp.anchors.forEach((a, ai) => {
            if (a.x >= box.x && a.x <= box.x + box.width && a.y >= box.y && a.y <= box.y + box.height) this.selected.add(key({ component: ci, subpath: si, anchor: ai }));
          })
        )
      );
      return;
    }
    const next = cloneComponents(g.base);
    if (g.kind === 'anchors') {
      let dx = p.x - g.start.x;
      let dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) < 1 / this.scale) return;
      if (mods.shift) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      for (const r of this.selection) {
        const c = next[r.component];
        c.subpaths[r.subpath].anchors[r.anchor] = translateAnchor(c.subpaths[r.subpath].anchors[r.anchor], dx, dy);
        delete c.live;
      }
    } else if (g.kind === 'handle') {
      const c = next[g.ref.component];
      const a = c.subpaths[g.ref.subpath].anchors[g.ref.anchor];
      const typed: VectorAnchor = { ...a, type: a.type ?? inferAnchorType(a) };
      const moved = moveAnchorHandle(typed, g.side, p, g.breakHandles);
      delete moved.type;
      c.subpaths[g.ref.subpath].anchors[g.ref.anchor] = moved;
      delete c.live;
    } else if (g.kind === 'segment') {
      const c = next[g.ref.component];
      c.subpaths[g.ref.subpath] = bendSegment(c.subpaths[g.ref.subpath], g.ref.anchor, g.t, p);
      delete c.live;
    } else {
      // The Pen's drag pulls out symmetric handles from the anchor just placed.
      const c = next[g.ref.component];
      const a = c.subpaths[g.ref.subpath].anchors[g.ref.anchor];
      if (Math.hypot(p.x - a.x, p.y - a.y) < 1 / this.scale) return;
      a.out = { x: p.x, y: p.y };
      a.in = { x: 2 * a.x - p.x, y: 2 * a.y - p.y };
      delete c.live;
      this.commit(next, false);
      return;
    }
    if (this.commit(next, !g.moved)) g.moved = true;
  }

  /** The pointer moving with no button down (the Pen's preview of its next segment). */
  hover(p: ImagePoint): void {
    this.pointer = pt(p);
  }

  up(): void {
    this.drag = null;
  }

  /** Ends the Pen's subpath (left open). */
  finish(): void {
    this.drawing = null;
    this.drag = null;
  }

  cancel(): void {
    this.drag = null;
    this.drawing = null;
    this.selected.clear();
  }

  /**
   * Keys: Delete / Backspace remove the selected anchors (one undo step), Enter and Escape end the
   * Pen's subpath, Escape also deselects. Returns true when the key was handled.
   */
  key(k: string): boolean {
    if (k === 'Enter' && this.drawing) {
      this.finish();
      return true;
    }
    if (k === 'Escape') {
      if (!this.drawing && !this.selected.size) return false;
      this.drawing = null;
      this.selected.clear();
      return true;
    }
    if ((k === 'Delete' || k === 'Backspace') && this.selected.size && !this.drawing) {
      const cs = this.components();
      if (!cs) return false;
      const next = cloneComponents(cs);
      const bySub = new Map<string, number[]>();
      for (const r of this.selection) {
        const sk = `${r.component}:${r.subpath}`;
        bySub.set(sk, [...(bySub.get(sk) ?? []), r.anchor]);
      }
      for (const [sk, indices] of bySub) {
        const [ci, si] = sk.split(':').map(Number);
        next[ci].subpaths[si] = removeAnchors(next[ci].subpaths[si], indices);
        delete next[ci].live;
      }
      this.selected.clear();
      this.commit(prune(next), true);
      return true;
    }
    return false;
  }

  /** What to draw (`RenderOptions.pathEdit`) for `tool`, or null when there is no target. */
  overlay(tool: PathEditTool): PathEditOverlay | null {
    const cs = this.components();
    if (!cs) return null;
    const curves: ImagePoint[][] = [];
    const anchors: PathEditOverlay['anchors'] = [];
    const handles: PathEditOverlay['handles'] = [];
    const selectedComponents = new Set(this.selection.map((r) => r.component));
    cs.forEach((c, ci) =>
      c.subpaths.forEach((sp, si) => {
        for (let i = 0; i < subpathSegmentCount(sp); i++) curves.push(subpathSegment(sp, i).map(([x, y]) => ({ x, y })));
        sp.anchors.forEach((a, ai) => {
          const selected = this.selected.has(key({ component: ci, subpath: si, anchor: ai }));
          if (tool === 'path-select' && !selectedComponents.has(ci)) return;
          anchors.push({ point: pt(a), selected });
          if (!selected || tool === 'path-select') return;
          for (const side of ['in', 'out'] as const) if (a[side]) handles.push({ point: pt(a[side]!), anchor: pt(a) });
        });
      })
    );
    let preview: ImagePoint[] | null = null;
    const d = this.drawing;
    if (tool === 'path-pen' && d && this.pointer && !this.drag) {
      const sp = cs[d.component]?.subpaths[d.subpath];
      const last = sp?.anchors[sp.anchors.length - 1];
      if (last) preview = last.out ? [pt(last), pt(last.out), this.pointer, this.pointer] : [pt(last), this.pointer];
    }
    const marquee = this.drag?.kind === 'marquee' ? rect(this.drag.start, this.drag.end) : null;
    return { curves, anchors, handles, marquee, preview };
  }
}

function rect(a: ImagePoint, b: ImagePoint): CropBox {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Drops subpaths left with no anchors, then components left empty. */
function prune(cs: ShapeComponent[]): ShapeComponent[] {
  for (const c of cs) c.subpaths = c.subpaths.filter((sp) => sp.anchors.length);
  return cs.filter((c) => c.subpaths.length);
}
