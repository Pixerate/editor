/**
 * Free Transform's view model, shared by the React and Svelte editors: the overlay (outline,
 * eight handles, the reference point), what a pointer is over, Photoshop's drags and modifiers,
 * the options bar's readout and fields, and the keyboard (Enter commits, Esc cancels, arrows
 * nudge). It drives a `FreeTransformSession`; the bindings forward pointer and key events and draw
 * `overlay()` through the renderer's `freeTransform` option.
 *
 * Drags (as Photoshop CC, where a corner scales proportionally by default):
 * - corner: scale from the opposite corner (Alt: from the reference point); Shift toggles
 *   proportional; side: scale one axis;
 * - Mod (Ctrl / Cmd) + corner: distort that corner; Mod + side: skew along the side (Alt: about
 *   the centre); Mod + Alt + Shift + corner: perspective;
 * - outside the box: rotate about the reference point (Shift: 15° steps); inside: move (Shift:
 *   along one axis); the reference point: move it;
 * - the mode switch (rotate, skew, distort, perspective) makes every handle do that;
 * - Warp: drag a mesh anchor or handle (the grid stays smooth across its lines), or anywhere
 *   inside to pull the surface; presets and the grid size come from the options bar. The warp is
 *   applied in the frame's own space before the corner map, so both can be used together.
 */

import type { ImageEditorController } from '../controller';
import type { FreeTransformInit, FreeTransformSession, FreeTransformResult } from '../free-transform';
import {
  cornersFromMatrix,
  describeTransform,
  matrixFromParams,
  type FreeTransformMode,
  type Quad,
  type TransformAnchor,
  type TransformReadout,
} from '../transform';
import { applyHomography, invertHomography, rectToQuad, type Homography } from '../../geom/homography';
import {
  WARP_STYLES,
  WARP_STYLE_LABELS,
  dragWarpMeshPoint,
  identityWarpMesh,
  pullWarpMesh,
  resizeWarpMesh,
  warpMeshEditPoints,
  warpMeshGridCurves,
  warpMeshParamAt,
  warpPresetMesh,
  type WarpPreset,
} from '../../geom/warp';
import type { WarpMesh, WarpStyle } from '../../geom/types';
import type { Vec2 } from '../../geom/types';
import type { Interpolation } from '../../raster/transform';
import type { CropBox, ImagePoint } from '../types';
import { flattenLayers } from './model';
import type { ShortcutEvent } from './paint-ui';

/** What a pointer is over (`mesh:<index>`: a warp mesh control point). */
export type TransformHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'reference' | 'inside' | 'outside' | `mesh:${number}`;

const CORNERS = ['nw', 'ne', 'se', 'sw'] as const;
const SIDES = ['n', 'e', 's', 'w'] as const;
const CORNER_INDEX: Record<string, number> = { nw: 0, ne: 1, se: 2, sw: 3 };
const SIDE_CORNERS: Record<string, [number, number]> = { n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0] };
/** Box fractions of each handle. */
const HANDLE_FRACTION: Record<string, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
const ANCHOR_FRACTION: Record<TransformAnchor, [number, number]> = {
  'top-left': [0, 0],
  top: [0.5, 0],
  'top-right': [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  'bottom-left': [0, 1],
  bottom: [0.5, 1],
  'bottom-right': [1, 1],
};

export interface TransformModifiers {
  shiftKey?: boolean;
  altKey?: boolean;
  /** Ctrl or Cmd. */
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** The modes of the options bar's switch (Warp comes with its own mesh UI). */
export const FREE_TRANSFORM_MODE_OPTIONS: readonly { id: FreeTransformMode; label: string; title: string }[] = [
  { id: 'scale', label: 'Free', title: 'Free Transform: corners scale, outside rotates, Ctrl/Cmd distorts' },
  { id: 'rotate', label: 'Rotate', title: 'Every handle rotates about the reference point' },
  { id: 'skew', label: 'Skew', title: 'Sides slide along themselves' },
  { id: 'distort', label: 'Distort', title: 'Each corner moves freely' },
  { id: 'perspective', label: 'Perspective', title: 'A corner and its partner move symmetrically' },
  { id: 'warp', label: 'Warp', title: 'Bend through a mesh: drag its points or pull inside; presets in the bar' },
];

/** The Warp style menu: Custom (the mesh as dragged) and Photoshop's fifteen presets. */
export const WARP_STYLE_OPTIONS: readonly { id: WarpStyle | 'custom'; label: string }[] = [
  { id: 'custom', label: 'Custom' },
  ...WARP_STYLES.map((id) => ({ id, label: WARP_STYLE_LABELS[id] })),
];

/** The Warp grid menu: patches across and down. */
export const WARP_GRID_OPTIONS: readonly { id: string; label: string; columns: number; rows: number }[] = [
  { id: '1x1', label: 'Default', columns: 1, rows: 1 },
  { id: '3x3', label: '3 × 3', columns: 3, rows: 3 },
  { id: '5x5', label: '5 × 5', columns: 5, rows: 5 },
];

/** Warp preset settings as the options bar shows them (percent). */
export interface WarpBar {
  style: WarpStyle | 'custom';
  bend: number;
  horizontal: number;
  vertical: number;
  orientation: 'horizontal' | 'vertical';
  columns: number;
  rows: number;
}

/** The options bar's numeric fields (Photoshop's X, Y, W, H, angle and skews). */
export const FREE_TRANSFORM_FIELDS = [
  { id: 'x', label: 'X', unit: 'px', title: 'Reference point X (document pixels)' },
  { id: 'y', label: 'Y', unit: 'px', title: 'Reference point Y (document pixels)' },
  { id: 'scaleX', label: 'W', unit: '%', title: 'Width in percent of the original' },
  { id: 'scaleY', label: 'H', unit: '%', title: 'Height in percent of the original' },
  { id: 'rotate', label: '∠', unit: '°', title: 'Rotation in degrees, clockwise' },
  { id: 'skewX', label: 'H skew', unit: '°', title: 'Horizontal skew in degrees' },
  { id: 'skewY', label: 'V skew', unit: '°', title: 'Vertical skew in degrees' },
] as const;

export type FreeTransformField = (typeof FREE_TRANSFORM_FIELDS)[number]['id'];

/** What the options bar shows. */
export interface FreeTransformBar extends Record<FreeTransformField, number> {
  /** False after Distort or Perspective: the numbers no longer describe the shape. */
  affine: boolean;
}

export interface TransformOverlay {
  /** The transformed frame, corner to corner (document pixels). */
  outline: ImagePoint[];
  /** The eight handles (none in Warp mode). */
  handles: Array<{ id: 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'; x: number; y: number }>;
  reference: ImagePoint;
  /** In Warp mode: the mesh's grid lines as cubics, its anchors, and its handles with the anchor each belongs to. */
  warp?: { curves: ImagePoint[][]; anchors: ImagePoint[]; handles: Array<{ point: ImagePoint; anchor: ImagePoint }> };
}

const CURSOR: Record<TransformHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  reference: 'move',
  inside: 'move',
  outside: 'alias',
};
const meshIndex = (h: TransformHandle | null) => (h && h.startsWith('mesh:') ? Number(h.slice(5)) : -1);

const mod = (m: TransformModifiers) => Boolean(m.ctrlKey || m.metaKey);
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

function rotateAbout(p: Vec2, c: Vec2, rad: number): Vec2 {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const d = sub(p, c);
  return { x: c.x + d.x * cos - d.y * sin, y: c.y + d.x * sin + d.y * cos };
}

function insideQuad(q: readonly Vec2[], p: Vec2): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-12) continue;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Even-odd point-in-polygon (the warped mesh's border). */
function insidePolygon(poly: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export interface FreeTransformToolOptions {
  /** Defers preview resampling to the next frame (pass `requestAnimationFrame`; default: at once). */
  schedule?: (run: () => void) => void;
  /** Called whenever the overlay, readout or error changes. */
  onChange?: () => void;
}

/**
 * A Free Transform frame for a box with no transform open (a host's selected-layer frame): the
 * outline, the eight handles (none with `handles = false`, e.g. for a layer locked in place) and
 * the centre as the reference point. Same shape and handle order as `FreeTransformTool.overlay`.
 */
export function boxFrameOverlay(box: CropBox, handles = true): TransformOverlay {
  const { x, y, width: w, height: h } = box;
  const at = { nw: [x, y], ne: [x + w, y], se: [x + w, y + h], sw: [x, y + h], n: [x + w / 2, y], e: [x + w, y + h / 2], s: [x + w / 2, y + h], w: [x, y + h / 2] } as const;
  return {
    outline: CORNERS.map((id) => ({ x: at[id][0], y: at[id][1] })),
    handles: handles ? [...CORNERS, ...SIDES].map((id) => ({ id, x: at[id][0], y: at[id][1] })) : [],
    reference: { x: x + w / 2, y: y + h / 2 },
  };
}

/**
 * What a document point is over on a frame from `boxFrameOverlay`: a handle (within `tolerance`),
 * `inside`, `outside` within `band` of the outline (where a drag rotates), or `null` beyond that.
 */
export function boxFrameHit(overlay: TransformOverlay, p: ImagePoint, tolerance: number, band: number): TransformHandle | null {
  let best: TransformHandle | null = null;
  let bestD = tolerance;
  for (const h of overlay.handles) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (d <= bestD) {
      best = h.id;
      bestD = d;
    }
  }
  if (best) return best;
  if (insideQuad(overlay.outline, p)) return 'inside';
  const o = overlay.outline;
  for (let i = 0; i < o.length; i++) {
    const a = o[i];
    const b = o[(i + 1) % o.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= band) return 'outside';
  }
  return null;
}

/**
 * The interactive Free Transform (see the module comment). `begin` opens a session on the
 * controller; pointer and key methods drive it; `commit` / `cancel` close it.
 */
export class FreeTransformTool {
  private sessionRef: FreeTransformSession | null = null;
  private modeValue: FreeTransformMode = 'scale';
  /** The reference point in the untransformed frame's space (follows the transform). */
  private refBox: Vec2 = { x: 0, y: 0 };
  private corners: Quad | null = null;
  private drag: { handle: TransformHandle; start: Vec2; corners: Quad; refBox: Vec2; ref: Vec2; mesh: WarpMesh | null; st: { s: number; t: number } | null } | null = null;
  /** The warp mesh in the frame's own space (null: no warp). */
  private mesh: WarpMesh | null = null;
  private warpSettings: WarpBar = { style: 'custom', bend: 50, horizontal: 0, vertical: 0, orientation: 'horizontal', columns: 1, rows: 1 };
  private pending = false;
  private viewScale = 1;
  private viewClip: { x: number; y: number; width: number; height: number } | undefined;
  /** Values typed into the options bar since the last drag (V skew is not recovered from the shape). */
  private typed: Partial<Record<FreeTransformField, number>> = {};
  /** Width and height scale together when typed (the chain icon). */
  proportional = true;
  error: string | null = null;
  lastResult: FreeTransformResult | null = null;

  constructor(
    private readonly controller: ImageEditorController,
    private readonly options: FreeTransformToolOptions = {}
  ) {}

  get active(): boolean {
    return Boolean(this.sessionRef?.isOpen);
  }

  get session(): FreeTransformSession | null {
    return this.active ? this.sessionRef : null;
  }

  get mode(): FreeTransformMode {
    return this.modeValue;
  }

  get interpolation(): Interpolation {
    return this.sessionRef?.interpolation ?? 'bicubic';
  }

  /** Whether the open transform has changed anything yet (a commit would add an undo step). */
  get modified(): boolean {
    const s = this.session;
    if (!s || !this.corners) return false;
    if (this.mesh && this.mesh !== (s.startGeometry.warp ?? null)) return true;
    const start = s.startGeometry.corners;
    return this.corners.some((p, i) => p.x !== start[i].x || p.y !== start[i].y);
  }

  private readonly listeners = new Set<() => void>();

  /** Calls `listener` whenever the overlay, readout, mode or error changes. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.options.onChange?.();
    for (const l of this.listeners) l();
  }

  /** Opens a Free Transform (default: the selected pixels of the active layer, or the whole layer). Returns an error message or `null`. */
  begin(init: FreeTransformInit = {}): string | null {
    if (this.active) return null;
    try {
      if (!init.layerId && init.content !== 'selection-outline' && !this.controller.getState().activeLayerId) {
        // Photoshop always has a target layer: use the topmost visible pixel layer.
        const top = [...flattenLayers(this.controller.getState().layers)].reverse().find((l) => l.type === 'pixel' && l.visible);
        if (top) this.controller.setActiveLayer(top.id);
      }
      const s = this.controller.beginFreeTransform(init);
      this.sessionRef = s;
      this.corners = s.geometry.corners;
      this.refBox = { x: s.box.x + s.box.width / 2, y: s.box.y + s.box.height / 2 };
      this.modeValue = 'scale';
      // A smart object's warp is part of its placement: keep editing it.
      this.mesh = s.geometry.warp ?? null;
      this.warpSettings = { style: 'custom', bend: 50, horizontal: 0, vertical: 0, orientation: 'horizontal', columns: 1, rows: 1 };
      this.typed = {};
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.changed();
    return this.error;
  }

  setMode(mode: FreeTransformMode): void {
    this.modeValue = mode;
    const s = this.session;
    if (mode === 'warp' && s && !this.mesh) this.mesh = identityWarpMesh(s.box, this.warpSettings.columns, this.warpSettings.rows);
    this.changed();
  }

  /** The Warp options bar's settings. */
  warpBar(): WarpBar {
    return { ...this.warpSettings };
  }

  /** The warp mesh (frame space), or null. */
  get warp(): WarpMesh | null {
    return this.mesh;
  }

  /**
   * Applies Warp options: a preset `style` with `bend` / `horizontal` / `vertical` (percent) and
   * `orientation` replaces the mesh; `custom` keeps it; the grid size re-splits it (exactly when it
   * can). Switches to Warp mode.
   */
  setWarp(changes: Partial<WarpBar>): void {
    const s = this.session;
    if (!s) return;
    this.modeValue = 'warp';
    const next = { ...this.warpSettings, ...changes };
    this.warpSettings = next;
    let mesh = this.mesh ?? identityWarpMesh(s.box, next.columns, next.rows);
    if (next.style !== 'custom' && ('style' in changes || 'bend' in changes || 'horizontal' in changes || 'vertical' in changes || 'orientation' in changes)) {
      const preset: WarpPreset = { style: next.style, bend: next.bend, horizontal: next.horizontal, vertical: next.vertical, orientation: next.orientation };
      mesh = warpPresetMesh(preset, s.box) ?? identityWarpMesh(s.box);
      mesh = resizeWarpMesh(mesh, next.columns, next.rows);
    }
    if ('columns' in changes || 'rows' in changes) mesh = resizeWarpMesh(mesh, next.columns, next.rows);
    this.mesh = mesh;
    this.changed();
    this.preview();
  }

  /** Sets the reference point to an anchor of the frame (the options bar's locator). */
  setReference(anchor: TransformAnchor): void {
    const s = this.session;
    if (!s) return;
    const [fx, fy] = ANCHOR_FRACTION[anchor];
    this.refBox = { x: s.box.x + fx * s.box.width, y: s.box.y + fy * s.box.height };
    this.changed();
  }

  setInterpolation(interpolation: Interpolation): void {
    const s = this.session;
    if (!s) return;
    this.run(() => s.update({ interpolation }, false));
  }

  /** Screen pixels per document pixel and the visible document area, for previews. */
  setView(scale: number, clip?: { x: number; y: number; width: number; height: number }): void {
    this.viewScale = scale > 0 ? scale : 1;
    this.viewClip = clip;
  }

  private homography() {
    const s = this.session;
    return s && this.corners ? rectToQuad(s.box, this.corners) : null;
  }

  /** The reference point in document pixels. */
  referencePoint(): Vec2 | null {
    const h = this.homography();
    return h ? applyHomography(h, this.refBox) : null;
  }

  /** The outline, handles and reference point to draw, or `null` when no transform is open. */
  overlay(): TransformOverlay | null {
    const s = this.session;
    const h = this.homography();
    if (!s || !h || !this.corners) return null;
    const handles = [...CORNERS, ...SIDES].map((id) => {
      const [fx, fy] = HANDLE_FRACTION[id];
      const p = applyHomography(h, { x: s.box.x + fx * s.box.width, y: s.box.y + fy * s.box.height }) ?? { x: 0, y: 0 };
      return { id, x: p.x, y: p.y };
    });
    const out: TransformOverlay = { outline: this.corners.map((p) => ({ x: p.x, y: p.y })), handles, reference: this.referencePoint() ?? { x: 0, y: 0 } };
    if (this.modeValue === 'warp' && this.mesh) {
      // Control points through the corner map: exact for affine corners, close for perspective.
      const m = this.mesh;
      const at = (p: Vec2) => applyHomography(h, p) ?? p;
      const pts = m.points.map(at);
      const edit = warpMeshEditPoints(m);
      out.handles = [];
      out.outline = warpMeshGridCurves({ ...m, points: pts }).length ? this.meshOutline(pts, m) : out.outline;
      out.warp = {
        curves: warpMeshGridCurves({ ...m, points: pts }),
        anchors: edit.anchors.map((i) => pts[i]),
        handles: edit.handles.map((e) => ({ point: pts[e.index], anchor: pts[e.anchor] })),
      };
    }
    return out;
  }

  /** The mesh's border anchors, clockwise (for the inside test). */
  private meshOutline(pts: Vec2[], m: WarpMesh): Vec2[] {
    const nx = 3 * (m.us.length - 1) + 1;
    const ny = 3 * (m.vs.length - 1) + 1;
    const ring: Vec2[] = [];
    for (let i = 0; i < nx; i++) ring.push(pts[i]);
    for (let j = 1; j < ny; j++) ring.push(pts[j * nx + nx - 1]);
    for (let i = nx - 2; i >= 0; i--) ring.push(pts[(ny - 1) * nx + i]);
    for (let j = ny - 2; j > 0; j--) ring.push(pts[j * nx]);
    return ring;
  }

  /** What a document point is over (`tolerance` in document pixels: a few screen pixels / scale). */
  hit(p: ImagePoint, tolerance: number): TransformHandle | null {
    const o = this.overlay();
    if (!o) return null;
    if (this.modeValue === 'warp' && this.mesh) {
      const h = this.homography()!;
      const edit = warpMeshEditPoints(this.mesh);
      let best = -1;
      let bestD = tolerance;
      for (const i of [...edit.anchors, ...edit.handles.map((e) => e.index)]) {
        const q = applyHomography(h, this.mesh.points[i]);
        if (!q) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d <= bestD) {
          best = i;
          bestD = d;
        }
      }
      if (best >= 0) return `mesh:${best}`;
      return insidePolygon(o.outline, p) ? 'inside' : 'outside';
    }
    // The nearest of the handles and the reference point within the tolerance (a small frame on
    // screen puts several within reach); handles win ties.
    let best: TransformHandle | null = null;
    let bestD = tolerance;
    for (const h of o.handles) {
      const d = Math.hypot(h.x - p.x, h.y - p.y);
      if (d <= bestD) {
        best = h.id;
        bestD = d;
      }
    }
    if (Math.hypot(o.reference.x - p.x, o.reference.y - p.y) < bestD) best = 'reference';
    if (best) return best;
    return insideQuad(o.outline, p) ? 'inside' : 'outside';
  }

  /** The CSS cursor for a handle. */
  cursor(handle: TransformHandle | null): string {
    if (!handle) return 'default';
    if (meshIndex(handle) >= 0) return 'pointer';
    if (this.modeValue === 'warp') return handle === 'inside' ? 'grab' : 'default';
    if (this.modeValue === 'rotate' && handle !== 'inside' && handle !== 'reference') return CURSOR.outside;
    return CURSOR[handle];
  }

  /** Starts a drag on what `p` is over. */
  down(p: ImagePoint, tolerance: number): TransformHandle | null {
    if (!this.session || !this.corners) return null;
    const handle = this.hit(p, tolerance);
    if (!handle) return null;
    let st: { s: number; t: number } | null = null;
    if (this.modeValue === 'warp' && this.mesh && handle === 'inside') {
      const q = this.toFrame(p, this.corners);
      if (q) {
        const r = warpMeshParamAt(this.mesh, q);
        st = { s: r.s, t: r.t };
      }
    }
    this.drag = { handle, start: { x: p.x, y: p.y }, corners: this.corners, refBox: { ...this.refBox }, ref: this.referencePoint() ?? p, mesh: this.mesh, st };
    return handle;
  }

  /** A document point in the frame's own space under `corners`. */
  private toFrame(p: Vec2, corners: Quad): Vec2 | null {
    const s = this.session;
    const h: Homography | null = s ? rectToQuad(s.box, corners) : null;
    const inv = h && invertHomography(h);
    return inv ? applyHomography(inv, p) : null;
  }

  /** Continues the drag to `p` with the modifiers held now. */
  move(p: ImagePoint, m: TransformModifiers = {}): void {
    const d = this.drag;
    const s = this.session;
    if (!d || !s) return;
    if (d.handle === 'reference') {
      const h = rectToQuad(s.box, d.corners);
      const inv = h && invertHomography(h);
      const q = inv && applyHomography(inv, p);
      if (q) this.refBox = q;
      this.changed();
      return;
    }
    if (this.modeValue === 'warp' && d.mesh) {
      // Warp: mesh points and pulls in the frame's own space; outside the mesh does nothing.
      const a = this.toFrame(d.start, d.corners);
      const b = this.toFrame(p, d.corners);
      if (!a || !b) return;
      const delta = { x: b.x - a.x, y: b.y - a.y };
      const i = meshIndex(d.handle);
      if (i >= 0) this.mesh = dragWarpMeshPoint(d.mesh, i, delta);
      else if (d.handle === 'inside' && d.st) this.mesh = pullWarpMesh(d.mesh, d.st.s, d.st.t, delta);
      else return;
      this.warpSettings = { ...this.warpSettings, style: 'custom' };
      this.changed();
      this.preview();
      return;
    }
    const corners = this.dragCorners(d, p, m);
    if (corners) this.setCorners(corners);
  }

  /** Ends the drag (the transform stays open). */
  up(): void {
    this.drag = null;
  }

  private dragCorners(d: NonNullable<FreeTransformTool['drag']>, p: Vec2, m: TransformModifiers): Quad | null {
    const s = this.session!;
    const c0 = d.corners;
    let delta = sub(p, d.start);
    const map = (f: (q: Vec2, i: number) => Vec2) => c0.map(f) as unknown as Quad;
    const handle = d.handle;
    const isCorner = handle in CORNER_INDEX;
    const isSide = handle in SIDE_CORNERS;
    const rotating = handle === 'outside' || (this.modeValue === 'rotate' && (isCorner || isSide));
    if (handle === 'inside') {
      if (m.shiftKey) delta = Math.abs(delta.x) >= Math.abs(delta.y) ? { x: delta.x, y: 0 } : { x: 0, y: delta.y };
      return map((q) => add(q, delta));
    }
    if (rotating) {
      const r = d.ref;
      let a = Math.atan2(p.y - r.y, p.x - r.x) - Math.atan2(d.start.y - r.y, d.start.x - r.x);
      if (m.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      return map((q) => rotateAbout(q, r, a));
    }
    const perspective = this.modeValue === 'perspective' || (mod(m) && m.altKey && m.shiftKey);
    const distort = this.modeValue === 'distort' || (mod(m) && !perspective);
    const skew = this.modeValue === 'skew' || (mod(m) && isSide);
    if (isSide && (skew || perspective)) {
      // Slide the side along its own direction (Alt: the opposite side the other way).
      const [i, j] = SIDE_CORNERS[handle];
      const dir = sub(c0[j], c0[i]);
      const len = Math.hypot(dir.x, dir.y) || 1;
      const t = (delta.x * dir.x + delta.y * dir.y) / len;
      const v = { x: (dir.x / len) * t, y: (dir.y / len) * t };
      const [oi, oj] = SIDE_CORNERS[{ n: 's', s: 'n', e: 'w', w: 'e' }[handle as 'n']];
      return map((q, k) => (k === i || k === j ? add(q, v) : m.altKey && (k === oi || k === oj) ? sub(q, v) : q));
    }
    if (isCorner && perspective) {
      const k = CORNER_INDEX[handle];
      if (Math.abs(delta.x) >= Math.abs(delta.y)) {
        const partner = [1, 0, 3, 2][k];
        return map((q, i) => (i === k ? { x: q.x + delta.x, y: q.y } : i === partner ? { x: q.x - delta.x, y: q.y } : q));
      }
      const partner = [3, 2, 1, 0][k];
      return map((q, i) => (i === k ? { x: q.x, y: q.y + delta.y } : i === partner ? { x: q.x, y: q.y - delta.y } : q));
    }
    if (distort || (isCorner && this.modeValue === 'skew')) {
      if (isCorner) return map((q, i) => (i === CORNER_INDEX[handle] ? add(q, delta) : q));
      const [i, j] = SIDE_CORNERS[handle];
      return map((q, k) => (k === i || k === j ? add(q, delta) : q));
    }
    // Scale in the frame's own space, so a rotated or distorted frame scales along its sides.
    const h = rectToQuad(s.box, c0);
    const inv = h && invertHomography(h);
    if (!h || !inv) return null;
    const q = applyHomography(inv, p);
    const q0 = applyHomography(inv, d.start);
    if (!q || !q0) return null;
    const b = s.box;
    const [fx, fy] = HANDLE_FRACTION[handle];
    const grab = { x: b.x + fx * b.width, y: b.y + fy * b.height };
    const anchor = m.altKey ? d.refBox : { x: b.x + (1 - fx) * b.width, y: b.y + (1 - fy) * b.height };
    const target = add(grab, sub(q, q0));
    const ax = grab.x - anchor.x;
    const ay = grab.y - anchor.y;
    let sx = isCorner || handle === 'e' || handle === 'w' ? (Math.abs(ax) > 1e-9 ? (target.x - anchor.x) / ax : 1) : 1;
    let sy = isCorner || handle === 'n' || handle === 's' ? (Math.abs(ay) > 1e-9 ? (target.y - anchor.y) / ay : 1) : 1;
    // Corners scale proportionally by default; Shift frees them.
    if (isCorner && !m.shiftKey) {
      const k = Math.abs(sx) >= Math.abs(sy) ? sx : sy;
      sx = k;
      sy = k;
    }
    const scaled = [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height },
    ].map((c) => applyHomography(h, { x: anchor.x + (c.x - anchor.x) * sx, y: anchor.y + (c.y - anchor.y) * sy }));
    return scaled.every(Boolean) ? (scaled as unknown as Quad) : null;
  }

  /** Sets new corners and refreshes the preview (scheduled). Invalid shapes keep the last good one. */
  setCorners(corners: Quad): void {
    const s = this.session;
    if (!s) return;
    const h = rectToQuad(s.box, corners);
    if (!h) return;
    this.corners = corners;
    this.typed = {};
    this.changed();
    this.preview();
  }

  private preview(): void {
    if (this.pending) return;
    this.pending = true;
    const run = () => {
      this.pending = false;
      const s = this.session;
      if (!s || !this.corners) return;
      this.run(() => s.update({ corners: this.corners!, warp: this.mesh }, { scale: this.viewScale, clip: this.viewClip }));
    };
    if (this.options.schedule) this.options.schedule(run);
    else run();
  }

  private run(fn: () => void): void {
    try {
      fn();
      this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      if (this.sessionRef && !this.sessionRef.isOpen) this.sessionRef = null;
    }
    this.changed();
  }

  /** The options bar's numbers for the current shape. */
  bar(): FreeTransformBar | null {
    const s = this.session;
    if (!s || !this.corners) return null;
    const read: TransformReadout = describeTransform({ box: s.box, corners: this.corners }, this.refBox);
    return {
      affine: read.affine,
      x: this.typed.x ?? read.x,
      y: this.typed.y ?? read.y,
      scaleX: this.typed.scaleX ?? read.scaleX,
      scaleY: this.typed.scaleY ?? read.scaleY,
      rotate: this.typed.rotate ?? read.rotate,
      skewX: this.typed.skewX ?? read.skewX,
      skewY: this.typed.skewY ?? 0,
    };
  }

  /** Applies a typed options-bar value (W and H together while `proportional`). */
  setField(field: FreeTransformField, value: number): void {
    const s = this.session;
    const cur = this.bar();
    if (!s || !cur || !Number.isFinite(value)) return;
    const next = { ...cur, [field]: value };
    if (this.proportional && field === 'scaleX') next.scaleY = cur.scaleY === 0 ? value : (value / cur.scaleX) * cur.scaleY;
    if (this.proportional && field === 'scaleY') next.scaleX = cur.scaleX === 0 ? value : (value / cur.scaleY) * cur.scaleX;
    if (!next.scaleX || !next.scaleY) {
      this.error = 'Width and height must not be 0 %.';
      this.changed();
      return;
    }
    const m = matrixFromParams(s.box, {
      scaleX: next.scaleX,
      scaleY: next.scaleY,
      rotate: next.rotate,
      skewX: next.skewX,
      skewY: next.skewY,
      reference: this.refBox,
      dx: next.x - this.refBox.x,
      dy: next.y - this.refBox.y,
    });
    this.setCorners(cornersFromMatrix(s.box, m));
    this.typed = { scaleX: next.scaleX, scaleY: next.scaleY, rotate: next.rotate, skewX: next.skewX, skewY: next.skewY, x: next.x, y: next.y };
    this.changed();
  }

  /** Finishes with full-quality resampling (one undo step). */
  commit(): FreeTransformResult | null {
    const s = this.session;
    if (!s) return null;
    let res: FreeTransformResult | null = null;
    this.pending = false;
    this.run(() => {
      if (this.corners) s.update({ corners: this.corners, warp: this.mesh }, false);
      res = s.commit();
    });
    this.lastResult = res;
    this.sessionRef = null;
    this.corners = null;
    this.mesh = null;
    this.drag = null;
    this.changed();
    return res;
  }

  /** Abandons the transform and restores everything. */
  cancel(): void {
    this.sessionRef?.cancel();
    this.sessionRef = null;
    this.corners = null;
    this.mesh = null;
    this.drag = null;
    this.pending = false;
    this.error = null;
    this.changed();
  }

  /**
   * Keyboard: Enter commits, Escape cancels, arrows nudge by 1 px (Shift: 10). Ctrl/Cmd+T opens a
   * Free Transform when none is open. Returns true when the key was used (prevent its default).
   */
  key(e: ShortcutEvent): boolean {
    const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
    const typing = Boolean(t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'));
    if (!this.active) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 't' && !typing) {
        this.begin();
        return true;
      }
      return false;
    }
    if (e.key === 'Enter') {
      this.commit();
      return true;
    }
    if (e.key === 'Escape') {
      this.cancel();
      return true;
    }
    if (typing) return false;
    const step = e.shiftKey ? 10 : 1;
    const nudge: Record<string, Vec2> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    const v = nudge[e.key];
    if (v && this.corners) {
      this.setCorners(this.corners.map((q) => add(q, v)) as unknown as Quad);
      return true;
    }
    return false;
  }
}
