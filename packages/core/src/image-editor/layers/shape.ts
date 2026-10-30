// Portions ported from photocraft/crates/doc/src/vector.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Shape layers: vector components with a fill and a stroke, rendered without a canvas into the
 * layer's `surface` (document space) by every change, so the compositor, effects, masks, clipping,
 * thumbnails and export see them like pixel layers while the vectors stay exact.
 *
 * Geometry comes from the vector editor (anchors with absolute handles and live corners, shape
 * factories) and the curve path operations (booleans, stroke outlines). Following Photoshop, each
 * component's subpaths are filled together with the layer's fill rule, and the components are
 * folded in order with their operation (the first one always combines). The stroke follows the
 * outline of the combined area, centred, inside or outside it.
 */

import type { Annotation, CropBox } from '../types';
import type { BlendMode } from '../blend';
import { isBlendMode } from '../blend';
import {
  emptySurface,
  finishTile,
  tileKey,
  tilesInRect,
  TiledSurface,
  TILE,
  type PixelSurface,
  type Tile,
  type TileKey,
} from '../../raster/surface';
import { effectFillColors, type EffectContext } from '../../raster/effects/render';
import { builtinPattern, PatternTile, type EffectPattern } from '../../raster/effects/patterns';
import {
  DEFAULT_GLOBAL_LIGHT,
  MAX_EFFECT_REACH,
  parseEffectColor,
  validateEffectGradient,
  LayerEffectError,
  type EffectGradient,
} from '../../raster/effects/model';
import { IDENTITY_MATRIX, applyMatrix, isIdentityMatrix, multiplyMatrices, rotateMatrix, translateMatrix } from '../../geom/affine';
import type { AffineMatrix } from '../../geom/types';
import { bezierPathBounds, type BezierPath } from '../../canvas/pathops/bezier';
import { pathBoolean, type PathBooleanOperation } from '../../canvas/pathops/boolean';
import { outlineStroke, strokeOutlineRings, type OutlineStrokeOptions } from '../../canvas/pathops/stroke';
import { ellipseSubpath, polygonSubpath, rectSubpath, starSubpath, subpathsToBezier, bezierToSubpaths } from '../../vector/geometry';
import { expandVectorCorners, setAnchorCorner } from '../../vector/corners';
import type { VectorAnchor, VectorSubpath, Vec2 } from '../../vector/types';
import { combineCoverage, flatBounds, flattenPath, rasterizeCoverage, rasterizeCoverageSampled, type FlatPath } from './vector-raster';
import { parseCssColor } from './css-color';
import { LayerOperationError, requireLayer, requireUnlocked } from './ops';
import {
  mapLayer,
  newLayerId,
  SHAPE_OPERATIONS,
  LIVE_SHAPE_KINDS,
  type ImageLayer,
  type LiveShape,
  type PixelLayer,
  type ShapeArrowhead,
  type ShapeComponent,
  type ShapeFillRule,
  type ShapeLayer,
  type ShapeOperation,
  type ShapePaint,
  type ShapeStroke,
} from './model';

/** How far beyond the canvas a shape is rendered (effects can reach this far into the canvas). */
export const SHAPE_RENDER_MARGIN = MAX_EFFECT_REACH;

/** Photoshop's default miter limit (effectively always mitered). */
export const DEFAULT_MITER_LIMIT = 100;

/** What rendering needs besides the layer. */
export interface ShapeEnv {
  /** Canvas size: the render covers it grown by `SHAPE_RENDER_MARGIN`. */
  width: number;
  height: number;
  /** A document pattern by id (built-in patterns are found without it). */
  pattern?(id: string): EffectPattern | null;
}

const fail = (message: string): never => {
  throw new LayerOperationError(message);
};

// ---------------------------------------------------------------------------
// Live shapes → subpaths
// ---------------------------------------------------------------------------

const orientation = (anchors: readonly Vec2[]) => {
  let a = 0;
  for (let i = 0; i < anchors.length; i++) {
    const p = anchors[i];
    const q = anchors[(i + 1) % anchors.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
};

/** A closed polygon, wound clockwise on screen (so the parts of a line shape add up under nonzero). */
function polygon(points: Vec2[]): VectorSubpath {
  const anchors = orientation(points) < 0 ? [...points].reverse() : points;
  return { closed: true, anchors: anchors.map((p) => ({ x: p.x, y: p.y })) };
}

/** An arrowhead with its tip at `tip`, pointing along unit `dir`, as a polygon. */
function arrowheadPolygon(head: ShapeArrowhead, tip: Vec2, dir: Vec2): VectorSubpath | null {
  const len = Math.max(0, head.length);
  const hw = Math.max(0, head.width) / 2;
  if (!(len > 0) || !(hw > 0)) return null;
  const n = { x: -dir.y, y: dir.x };
  const base = { x: tip.x - dir.x * len, y: tip.y - dir.y * len };
  const c = Math.max(-0.5, Math.min(0.5, head.concavity ?? 0));
  const pts = [tip, { x: base.x + n.x * hw, y: base.y + n.y * hw }];
  if (c) pts.push({ x: base.x + dir.x * len * c, y: base.y + dir.y * len * c });
  pts.push({ x: base.x - n.x * hw, y: base.y - n.y * hw });
  return polygon(pts);
}

function mapAnchor(a: VectorAnchor, f: (p: Vec2) => Vec2): VectorAnchor {
  const p = f(a);
  const out: VectorAnchor = { x: p.x, y: p.y };
  if (a.in) out.in = f(a.in);
  if (a.out) out.out = f(a.out);
  if (a.type) out.type = a.type;
  if (a.corner) out.corner = { ...a.corner };
  return out;
}

/** Subpaths with every anchor and handle mapped by `f` (live corners are cut first, then mapped). */
export function mapSubpaths(subpaths: readonly VectorSubpath[], f: (p: Vec2) => Vec2): VectorSubpath[] {
  return expandVectorCorners(subpaths).map((sp) => ({ closed: sp.closed, anchors: sp.anchors.map((a) => mapAnchor(a, f)) }));
}

/** The subpaths a live shape describes, in document pixels. */
export function liveShapeSubpaths(live: LiveShape): VectorSubpath[] {
  let out: VectorSubpath[];
  switch (live.kind) {
    case 'rect': {
      const x = Math.min(live.x, live.x + live.width);
      const y = Math.min(live.y, live.y + live.height);
      const sp = rectSubpath({ x, y, width: Math.abs(live.width), height: Math.abs(live.height) });
      const r = live.radii ?? [0, 0, 0, 0];
      out = [{ closed: true, anchors: sp.anchors.map((a, i) => (r[i] > 0 ? setAnchorCorner(a, r[i]) : a)) }];
      break;
    }
    case 'ellipse':
      out = [ellipseSubpath(normBox(live))];
      break;
    case 'polygon':
      out = [polygonSubpath(normBox(live), live.sides)];
      break;
    case 'star':
      out = [starSubpath(normBox(live), live.points, Math.max(0, Math.min(1, live.innerRatio)))];
      break;
    case 'line': {
      const a = { x: live.x1, y: live.y1 };
      const b = { x: live.x2, y: live.y2 };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      out = [];
      if (len > 0) {
        const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        const hw = Math.max(0, live.weight) / 2;
        if (hw > 0) {
          const n = { x: -d.y * hw, y: d.x * hw };
          out.push(polygon([{ x: a.x + n.x, y: a.y + n.y }, { x: b.x + n.x, y: b.y + n.y }, { x: b.x - n.x, y: b.y - n.y }, { x: a.x - n.x, y: a.y - n.y }]));
        }
        const end = live.endArrow ? arrowheadPolygon(live.endArrow, b, d) : null;
        const start = live.startArrow ? arrowheadPolygon(live.startArrow, a, { x: -d.x, y: -d.y }) : null;
        if (start) out.push(start);
        if (end) out.push(end);
      }
      break;
    }
  }
  const m = live.transform;
  return m && !isIdentityMatrix(m) ? mapSubpaths(out, (p) => applyMatrix(m, p)) : out;
}

function normBox(b: { x: number; y: number; width: number; height: number }): CropBox {
  return { x: Math.min(b.x, b.x + b.width), y: Math.min(b.y, b.y + b.height), width: Math.abs(b.width), height: Math.abs(b.height) };
}

/** A component drawn as a live shape. */
export function liveComponent(live: LiveShape, op: ShapeOperation = 'combine'): ShapeComponent {
  return { op, subpaths: liveShapeSubpaths(live), live };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const pathCache = new WeakMap<object, BezierPath>();

/** A component as Bézier commands (live corners cut). */
export function componentPath(c: ShapeComponent): BezierPath {
  let p = pathCache.get(c.subpaths);
  if (!p) {
    p = subpathsToBezier(c.subpaths);
    pathCache.set(c.subpaths, p);
  }
  return p;
}

const BOOLEAN_OF: Record<ShapeOperation, PathBooleanOperation> = { combine: 'union', subtract: 'difference', intersect: 'intersection', exclude: 'xor' };

const outlineCache = new WeakMap<object, Map<string, BezierPath>>();

/**
 * The outline of the combined area (every component folded in with its operation) as one clean
 * path. A single component comes back as its own path (open subpaths stay open, for stroking).
 */
export function shapeOutline(components: readonly ShapeComponent[], fillRule: ShapeFillRule = 'nonzero'): BezierPath {
  if (components.length === 1) return componentPath(components[0]);
  let byRule = outlineCache.get(components);
  if (!byRule) {
    byRule = new Map();
    outlineCache.set(components, byRule);
  }
  const hit = byRule.get(fillRule);
  if (hit) return hit;
  let acc: BezierPath = [];
  components.forEach((c, i) => {
    const operand = { path: componentPath(c), fillRule };
    if (i === 0) acc = pathBoolean('union', [operand]).path;
    else acc = pathBoolean(BOOLEAN_OF[c.op], [{ path: acc, fillRule: 'nonzero' }, operand]).path;
  });
  byRule.set(fillRule, acc);
  return acc;
}

/** Bounds of the shape's geometry (the combined components, not the stroke), or `null`. */
export function shapeGeometryBounds(layer: Pick<ShapeLayer, 'components'>): { x: number; y: number; width: number; height: number } | null {
  let b: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const c of layer.components) {
    const cb = bezierPathBounds(componentPath(c));
    if (!cb) continue;
    b = b ? { minX: Math.min(b.minX, cb.minX), minY: Math.min(b.minY, cb.minY), maxX: Math.max(b.maxX, cb.maxX), maxY: Math.max(b.maxY, cb.maxY) } : cb;
  }
  return b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX, height: b.maxY - b.minY } : null;
}

/** Whether every subpath of the stroked outline is closed (inside / outside strokes need that). */
function closedOutline(path: BezierPath): boolean {
  let open = false;
  let inSub = false;
  for (const c of path) {
    if (c.type === 'M') {
      if (inSub) open = true;
      inSub = true;
    } else if (c.type === 'Z') inSub = false;
  }
  return !open && !inSub;
}

/** The area the stroke paints, as rings filled with nonzero (`double`: twice the width, for aligned strokes). */
function strokeArea(path: BezierPath, stroke: ShapeStroke, double: boolean): BezierPath {
  const w = stroke.width * (double ? 2 : 1);
  if (!(w > 0) || !path.length) return [];
  const dashes = stroke.dashes?.length && stroke.dashes.some((d) => d > 0) ? stroke.dashes.map((d) => d * stroke.width) : undefined;
  const options: OutlineStrokeOptions = {
    width: w,
    cap: stroke.cap ?? 'butt',
    join: stroke.join ?? 'miter',
    miterLimit: stroke.miterLimit ?? DEFAULT_MITER_LIMIT,
    ...(dashes ? { dash: dashes, dashOffset: (stroke.dashOffset ?? 0) * stroke.width } : {}),
  };
  // The raw outline overlaps itself; the sampled rasterizer fills it with nonzero. Its inner offset
  // can turn inside out where a curve is tighter than half the width, so curves get a clean outline
  // when that is cheap enough.
  const curved = path.some((c) => c.type === 'C' || c.type === 'Q');
  if (curved && path.length <= CLEAN_OUTLINE_LIMIT) {
    try {
      return outlineStroke(path, options);
    } catch {
      // The raw rings below.
    }
  }
  return strokeOutlineRings(path, options);
}

/** Commands above which a curved stroke is filled from its raw rings (clean outlines get slow). */
const CLEAN_OUTLINE_LIMIT = 64;

interface ShapeGeometry {
  fills: Array<{ op: ShapeOperation; flat: FlatPath }>;
  stroke: FlatPath | null;
  align: 'inside' | 'center' | 'outside';
  /** Bounds of everything drawn (integer pixels), or `null`. */
  bounds: CropBox | null;
  /** The frame aligned gradients use and the pattern anchor (the geometry's bounds). */
  frame: CropBox;
}

const geometryCache = new WeakMap<object, ShapeGeometry>();

/** Flattened fill and stroke geometry of a shape (memoised per layer object). */
function shapeGeometry(layer: ShapeLayer): ShapeGeometry {
  const hit = geometryCache.get(layer);
  if (hit) return hit;
  const fills = layer.components.map((c) => ({ op: c.op, flat: flattenPath(componentPath(c)) }));
  let stroke: FlatPath | null = null;
  let align: ShapeGeometry['align'] = 'center';
  const s = layer.stroke;
  if (s && s.width > 0 && layer.components.length) {
    let outline: BezierPath;
    try {
      outline = shapeOutline(layer.components, layer.fillRule);
    } catch {
      outline = layer.components.flatMap((c) => componentPath(c));
    }
    align = s.align && s.align !== 'center' && closedOutline(outline) ? s.align : 'center';
    stroke = flattenPath(strokeArea(outline, s, align !== 'center'));
  }
  let bounds: CropBox | null = null;
  const add = (b: CropBox | null) => {
    if (!b) return;
    if (!bounds) bounds = { ...b };
    else {
      const x0 = Math.min(bounds.x, b.x);
      const y0 = Math.min(bounds.y, b.y);
      bounds = { x: x0, y: y0, width: Math.max(bounds.x + bounds.width, b.x + b.width) - x0, height: Math.max(bounds.y + bounds.height, b.y + b.height) - y0 };
    }
  };
  if (layer.fill && layer.inverted) add({ x: -1e7, y: -1e7, width: 2e7, height: 2e7 });
  else if (layer.fill) for (const f of fills) add(flatBounds(f.flat));
  if (stroke) add(flatBounds(stroke));
  const g = shapeGeometryBounds(layer) ?? { x: 0, y: 0, width: 0, height: 0 };
  const frame = { x: Math.floor(g.x), y: Math.floor(g.y), width: Math.max(1, Math.ceil(g.x + g.width) - Math.floor(g.x)), height: Math.max(1, Math.ceil(g.y + g.height) - Math.floor(g.y)) };
  const geo: ShapeGeometry = { fills, stroke, align, bounds, frame };
  geometryCache.set(layer, geo);
  return geo;
}

/** Coverage of the combined fill area over `rect` (nothing but the geometry: paints are ignored). */
function fillCoverage(geo: ShapeGeometry, rect: CropBox, rule: ShapeFillRule, inverted = false): Float32Array | null {
  const n = rect.width * rect.height;
  if (inverted) {
    const area = fillCoverage(geo, rect, rule);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 1 - (area ? area[i] : 0);
    return out;
  }
  let acc: Float32Array | null = null;
  geo.fills.forEach((f, i) => {
    // One contour fills exactly; several may overlap each other (a line's bar and arrowhead).
    const cov = f.flat.length > 1 ? rasterizeCoverageSampled(f.flat, rect, rule) : rasterizeCoverage(f.flat, rect, rule);
    acc = i === 0 ? cov : combineCoverage(acc, cov, f.op, n);
  });
  return acc;
}

/**
 * Coverage (0..1) of `components` over `rect`, filled with `rule` and combined by their ops;
 * `inverted` covers the outside instead. Used for vector masks.
 */
export function componentsCoverage(components: readonly ShapeComponent[], rect: CropBox, rule: ShapeFillRule = 'nonzero', inverted = false): Float32Array {
  const geo = { fills: components.map((c) => ({ op: c.op, flat: flattenPath(componentPath(c)) })) } as ShapeGeometry;
  return fillCoverage(geo, rect, rule, inverted) ?? new Float32Array(rect.width * rect.height);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function paintContext(env: ShapeEnv): EffectContext {
  const tiles = new Map<string, PatternTile | null>();
  return {
    light: DEFAULT_GLOBAL_LIGHT,
    pattern: (id) => {
      if (tiles.has(id)) return tiles.get(id)!;
      const p = env.pattern?.(id) ?? builtinPattern(id);
      const t = p && p.width > 0 && p.height > 0 && p.data.length >= p.width * p.height * 4 ? new PatternTile(p) : null;
      tiles.set(id, t);
      return t;
    },
  };
}

/** Where a shape renders: the canvas grown by the margin. */
export function shapeRenderClip(env: Pick<ShapeEnv, 'width' | 'height'>): CropBox {
  const m = SHAPE_RENDER_MARGIN;
  return { x: -m, y: -m, width: env.width + 2 * m, height: env.height + 2 * m };
}

function intersect(a: CropBox, b: CropBox): CropBox | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/**
 * Straight RGBA bytes of the shape over `rect`: the fill (its coverage × paint), then the stroke
 * over it (centred, or clipped to the inside or outside of the fill area). `null` when empty.
 */
export function renderShapeRect(layer: ShapeLayer, rect: CropBox, env: ShapeEnv, ctx: EffectContext = paintContext(env)): Uint8ClampedArray | null {
  const geo = shapeGeometry(layer);
  if (!geo.bounds || !intersect(geo.bounds, rect)) return null;
  const n = rect.width * rect.height;
  const rule = layer.fillRule ?? 'nonzero';
  const needArea = Boolean(layer.fill) || (geo.stroke !== null && geo.align !== 'center');
  const area = needArea ? fillCoverage(geo, rect, rule, Boolean(layer.inverted && layer.fill)) : null;
  // Stroke outlines overlap themselves at joins and crossings.
  let sCov = geo.stroke ? rasterizeCoverageSampled(geo.stroke, rect, 'nonzero') : null;
  if (sCov && geo.align === 'inside') sCov = area ? combineCoverage(sCov, area, 'intersect', n) : null;
  else if (sCov && geo.align === 'outside' && area) sCov = combineCoverage(sCov, area, 'subtract', n);
  const fCov = layer.fill ? area : null;
  if (!fCov && !sCov) return null;
  const canvas = { x: 0, y: 0, width: env.width, height: env.height };
  const anchor = { x: geo.frame.x, y: geo.frame.y };
  const fc = fCov ? effectFillColors(layer.fill!, rect, geo.frame, canvas, anchor, ctx) : null;
  const fo = layer.fill?.opacity ?? 1;
  const sc = sCov ? effectFillColors(layer.stroke!.paint, rect, geo.frame, canvas, anchor, ctx) : null;
  const so = layer.stroke?.paint.opacity ?? 1;
  const out = new Uint8ClampedArray(n * 4);
  let any = false;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    if (fCov && fCov[i] > 0) {
      a = fCov[i] * fo * fc![k + 3];
      r = fc![k];
      g = fc![k + 1];
      b = fc![k + 2];
    }
    if (sCov && sCov[i] > 0) {
      const sa = Math.min(1, sCov[i]) * so * sc![k + 3];
      const ao = sa + a * (1 - sa);
      if (ao > 0) {
        r = (sc![k] * sa + r * a * (1 - sa)) / ao;
        g = (sc![k + 1] * sa + g * a * (1 - sa)) / ao;
        b = (sc![k + 2] * sa + b * a * (1 - sa)) / ao;
      }
      a = ao;
    }
    if (a <= 0) continue;
    const ab = Math.round(Math.min(1, a) * 255);
    if (!ab) continue;
    out[k] = Math.round(r * 255);
    out[k + 1] = Math.round(g * 255);
    out[k + 2] = Math.round(b * 255);
    out[k + 3] = ab;
    any = true;
  }
  return any ? out : null;
}

/**
 * Renders a shape layer into a document-space surface (offset 0), tile by tile, over the canvas
 * grown by `SHAPE_RENDER_MARGIN` (or only `clip`, for previews).
 */
export function renderShape(layer: ShapeLayer, env: ShapeEnv, options: { clip?: CropBox } = {}): PixelSurface {
  const geo = shapeGeometry(layer);
  if (!geo.bounds) return emptySurface(4);
  let region = intersect(geo.bounds, shapeRenderClip(env));
  if (region && options.clip) region = intersect(region, options.clip);
  if (!region) return emptySurface(4);
  const ctx = paintContext(env);
  const tiles = new Map<TileKey, Tile>();
  for (const { tx, ty } of tilesInRect(region)) {
    const rect = { x: tx * TILE, y: ty * TILE, width: TILE, height: TILE };
    const px = renderShapeRect(layer, rect, env, ctx);
    if (!px) continue;
    const tile = finishTile(px, 4, 0);
    if (tile) tiles.set(tileKey(tx, ty), tile);
  }
  return new TiledSurface(4, tiles, 0);
}

/** The layer with its `surface` rendered again from its components. */
export function rerenderShape(layer: ShapeLayer, env: ShapeEnv): ShapeLayer {
  return { ...layer, surface: renderShape(layer, env) };
}

// ---------------------------------------------------------------------------
// Validation (agents, JSON and the controller all go through here)
// ---------------------------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function requireNum(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (!isNum(v)) fail(`${path} must be a finite number.`);
  if ((v as number) < min || (v as number) > max) fail(`${path} must be between ${min} and ${max}, got ${v}.`);
  return v as number;
}

/**
 * A paint from loose input: a CSS colour string (`#rrggbb`, `#rrggbbaa`, `rgb()`, a name; its
 * alpha becomes the opacity), `{ type: 'color', color, opacity? }`, `{ type: 'gradient',
 * gradient, opacity? }` or `{ type: 'pattern', patternId, scale?, angle?, link?, phase?, opacity? }`.
 */
export function normalizeShapePaint(v: unknown, path = 'paint'): ShapePaint {
  if (typeof v === 'string') {
    const c = parseCssColor(v);
    if (!c) return fail(`${path}: "${v}" is not a colour; use #rrggbb (or #rrggbbaa, rgb(), a CSS colour name).`);
    return c.alpha < 1 ? { type: 'color', color: c.hex, opacity: c.alpha } : { type: 'color', color: c.hex };
  }
  if (!v || typeof v !== 'object') return fail(`${path} must be a colour string or an object with type color, gradient or pattern.`);
  const o = v as Record<string, unknown>;
  const opacity = o.opacity === undefined ? undefined : requireNum(o.opacity, `${path}.opacity`, 0, 1);
  const withOpacity = <P extends ShapePaint>(p: P): P => (opacity !== undefined && opacity !== 1 ? { ...p, opacity } : p);
  if (o.type === 'color') {
    const c = parseCssColor(o.color);
    if (!c) return fail(`${path}.color must be a colour such as #rrggbb.`);
    const op = (opacity ?? 1) * c.alpha;
    return op !== 1 ? { type: 'color', color: c.hex, opacity: op } : { type: 'color', color: c.hex };
  }
  if (o.type === 'gradient') {
    const g = o.gradient as Partial<EffectGradient> | undefined;
    if (!g || typeof g !== 'object') return fail(`${path}.gradient is required: { stops: [{ position, color }], style, angle, … }.`);
    const gradient: EffectGradient = {
      stops: Array.isArray(g.stops) ? g.stops.map((s) => ({ position: s.position, color: parseCssColor(s.color)?.hex ?? s.color })) : [],
      ...(g.opacityStops ? { opacityStops: g.opacityStops } : {}),
      style: g.style ?? 'linear',
      angle: g.angle ?? 90,
      scale: g.scale ?? 1,
      reverse: g.reverse ?? false,
      align: g.align ?? true,
      offset: g.offset ?? { x: 0, y: 0 },
    };
    try {
      validateEffectGradient(gradient, `${path}.gradient`);
    } catch (e) {
      if (e instanceof LayerEffectError) fail(e.message);
      throw e;
    }
    if (gradient.stops.length < 1) fail(`${path}.gradient.stops needs at least one { position, color }.`);
    return withOpacity({ type: 'gradient', gradient });
  }
  if (o.type === 'pattern') {
    if (typeof o.patternId !== 'string' || !o.patternId) fail(`${path}.patternId is required (a document or built-in pattern id).`);
    const p: ShapePaint = { type: 'pattern', patternId: o.patternId as string, scale: o.scale === undefined ? 1 : requireNum(o.scale, `${path}.scale`, 0.01, 10) };
    if (typeof o.name === 'string') p.name = o.name;
    if (o.angle !== undefined) p.angle = requireNum(o.angle, `${path}.angle`, -360, 360);
    if (o.link !== undefined) p.link = Boolean(o.link);
    if (o.phase !== undefined) {
      const ph = o.phase as { x?: unknown; y?: unknown };
      p.phase = { x: requireNum(ph?.x, `${path}.phase.x`), y: requireNum(ph?.y, `${path}.phase.y`) };
    }
    return withOpacity(p);
  }
  return fail(`${path}.type must be color, gradient or pattern, got ${JSON.stringify(o.type)}.`);
}

/** A stroke from loose input (`width` and `paint` required; the rest default as Photoshop). */
export function normalizeShapeStroke(v: unknown, path = 'stroke', base?: ShapeStroke | null): ShapeStroke {
  if (!v || typeof v !== 'object') return fail(`${path} must be an object { width, paint, align?, cap?, join?, miterLimit?, dashes?, dashOffset? } or null.`);
  const o = v as Record<string, unknown>;
  const width = o.width === undefined && base ? base.width : requireNum(o.width, `${path}.width`, 0, 10000);
  const paint = o.paint === undefined && base ? base.paint : o.paint === undefined && o.color !== undefined ? normalizeShapePaint(o.color, `${path}.color`) : normalizeShapePaint(o.paint, `${path}.paint`);
  const out: ShapeStroke = { width, paint };
  const pick = <K extends 'align' | 'cap' | 'join'>(k: K, allowed: readonly string[]) => {
    const value = o[k] === undefined ? base?.[k] : o[k];
    if (value === undefined) return;
    if (!allowed.includes(value as string)) fail(`${path}.${k} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}.`);
    if (value !== (k === 'align' ? 'center' : k === 'cap' ? 'butt' : 'miter')) (out as unknown as Record<string, unknown>)[k] = value;
  };
  pick('align', ['inside', 'center', 'outside']);
  pick('cap', ['butt', 'round', 'square']);
  pick('join', ['miter', 'round', 'bevel']);
  const miter = o.miterLimit === undefined ? base?.miterLimit : requireNum(o.miterLimit, `${path}.miterLimit`, 1, 500);
  if (miter !== undefined && miter !== DEFAULT_MITER_LIMIT) out.miterLimit = miter;
  const dashes = o.dashes === undefined ? base?.dashes : o.dashes;
  if (dashes !== undefined && dashes !== null) {
    if (!Array.isArray(dashes) || dashes.length > 32 || !dashes.every((d) => isNum(d) && d >= 0 && d <= 10000)) fail(`${path}.dashes must be at most 32 lengths 0..10000 (multiples of the width).`);
    if ((dashes as number[]).length) {
      if ((dashes as number[]).reduce((s, d) => s + d, 0) < 0.01) fail(`${path}.dashes must add up to at least 0.01 widths.`);
      out.dashes = [...(dashes as number[])];
    }
  }
  const offset = o.dashOffset === undefined ? base?.dashOffset : requireNum(o.dashOffset, `${path}.dashOffset`, -1e6, 1e6);
  if (offset) out.dashOffset = offset;
  return out;
}

function box(o: Record<string, unknown>, path: string): { x: number; y: number; width: number; height: number } {
  return {
    x: requireNum(o.x, `${path}.x`),
    y: requireNum(o.y, `${path}.y`),
    width: requireNum(o.width, `${path}.width`, -1e6, 1e6),
    height: requireNum(o.height, `${path}.height`, -1e6, 1e6),
  };
}

function arrowhead(v: unknown, path: string): ShapeArrowhead | null {
  if (v === null || v === undefined || v === false) return null;
  if (typeof v !== 'object') return fail(`${path} must be { width, length, concavity? } in pixels, or null.`);
  const o = v as Record<string, unknown>;
  const head: ShapeArrowhead = { width: requireNum(o.width, `${path}.width`, 0, 1e5), length: requireNum(o.length, `${path}.length`, 0, 1e5) };
  if (o.concavity !== undefined && o.concavity !== 0) head.concavity = requireNum(o.concavity, `${path}.concavity`, -0.5, 0.5);
  return head;
}

function matrixArg(v: unknown, path: string): AffineMatrix | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length !== 6 || !v.every(isNum)) fail(`${path} must be six numbers [a, b, c, d, e, f].`);
  const m = v as unknown as AffineMatrix;
  if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) fail(`${path} is singular.`);
  return isIdentityMatrix(m) ? undefined : ([...m] as unknown as AffineMatrix);
}

/** A live shape from loose input (`kind` plus its fields), validated. */
export function normalizeLiveShape(v: unknown, path = 'shape'): LiveShape {
  if (!v || typeof v !== 'object') return fail(`${path} must be an object with kind ${LIVE_SHAPE_KINDS.join(', ')}.`);
  const o = v as Record<string, unknown>;
  const transform = matrixArg(o.transform, `${path}.transform`);
  const t = transform ? { transform } : {};
  switch (o.kind) {
    case 'rect': {
      const b = box(o, path);
      let radii: [number, number, number, number] | undefined;
      if (o.radii !== undefined || o.radius !== undefined) {
        const r = o.radii ?? o.radius;
        const list = typeof r === 'number' ? [r, r, r, r] : r;
        if (!Array.isArray(list) || list.length !== 4 || !list.every((x) => isNum(x) && x >= 0)) fail(`${path}.radii must be four radii ≥ 0 [top-left, top-right, bottom-right, bottom-left] (or radius, one number).`);
        if ((list as number[]).some((x) => x > 0)) radii = [...(list as number[])] as [number, number, number, number];
      }
      return { kind: 'rect', ...b, ...(radii ? { radii } : {}), ...t };
    }
    case 'ellipse':
      return { kind: 'ellipse', ...box(o, path), ...t };
    case 'polygon':
      return { kind: 'polygon', ...box(o, path), sides: Math.round(requireNum(o.sides ?? 6, `${path}.sides`, 3, 100)), ...t };
    case 'star':
      return {
        kind: 'star',
        ...box(o, path),
        points: Math.round(requireNum(o.points ?? 5, `${path}.points`, 3, 100)),
        innerRatio: requireNum(o.innerRatio ?? 0.5, `${path}.innerRatio`, 0.01, 1),
        ...t,
      };
    case 'line': {
      const line: LiveShape = {
        kind: 'line',
        x1: requireNum(o.x1, `${path}.x1`),
        y1: requireNum(o.y1, `${path}.y1`),
        x2: requireNum(o.x2, `${path}.x2`),
        y2: requireNum(o.y2, `${path}.y2`),
        weight: requireNum(o.weight ?? 1, `${path}.weight`, 0, 1e5),
        ...t,
      };
      const s = arrowhead(o.startArrow, `${path}.startArrow`);
      const e = arrowhead(o.endArrow, `${path}.endArrow`);
      if (s) line.startArrow = s;
      if (e) line.endArrow = e;
      if (line.x1 === line.x2 && line.y1 === line.y2) fail(`${path}: the line's two ends are the same point.`);
      return line;
    }
    default:
      return fail(`${path}.kind must be one of ${LIVE_SHAPE_KINDS.join(', ')}, got ${JSON.stringify(o.kind)}.`);
  }
}

function point(v: unknown, path: string): Vec2 {
  const p = v as { x?: unknown; y?: unknown } | null;
  if (!p || typeof p !== 'object') return fail(`${path} must be { x, y } in document pixels.`);
  return { x: requireNum(p.x, `${path}.x`), y: requireNum(p.y, `${path}.y`) };
}

/** Subpaths from loose input: `[{ anchors: [{ x, y, in?, out? }], closed }]` or SVG path data. */
export function normalizeSubpaths(v: unknown, path = 'subpaths'): VectorSubpath[] {
  if (typeof v === 'string') {
    let subs: VectorSubpath[];
    try {
      subs = bezierToSubpaths(v);
    } catch {
      return fail(`${path}: could not read the SVG path data.`);
    }
    if (!subs.length || !subs.every((s) => s.anchors.every((a) => isNum(a.x) && isNum(a.y)))) fail(`${path}: the SVG path data holds no drawable subpath.`);
    return subs;
  }
  if (!Array.isArray(v) || !v.length) return fail(`${path} must be a non-empty array of { anchors: [{ x, y, in?, out? }], closed } (or SVG path data).`);
  return v.map((s, i) => {
    const sp = s as { anchors?: unknown; closed?: unknown };
    if (!sp || !Array.isArray(sp.anchors) || sp.anchors.length < 1) fail(`${path}[${i}].anchors must be a non-empty array.`);
    const anchors = (sp.anchors as unknown[]).map((a, j) => {
      const at = `${path}[${i}].anchors[${j}]`;
      const p = point(a, at);
      const ao = a as Record<string, unknown>;
      const out: VectorAnchor = { x: p.x, y: p.y };
      if (ao.in) out.in = point(ao.in, `${at}.in`);
      if (ao.out) out.out = point(ao.out, `${at}.out`);
      if (ao.corner !== undefined && ao.corner !== null) {
        const c = ao.corner as { radius?: unknown };
        const r = requireNum(typeof c === 'number' ? c : c.radius, `${at}.corner.radius`, 0, 1e5);
        if (r > 0) out.corner = { radius: r };
      }
      return out;
    });
    return { anchors, closed: sp.closed !== false };
  });
}

export function requireOperation(v: unknown, path = 'op'): ShapeOperation {
  if (v === undefined) return 'combine';
  if (!SHAPE_OPERATIONS.includes(v as ShapeOperation)) fail(`${path} must be one of ${SHAPE_OPERATIONS.join(', ')}, got ${JSON.stringify(v)}.`);
  return v as ShapeOperation;
}

// ---------------------------------------------------------------------------
// Operations on the layer stack (pure; the controller adds history)
// ---------------------------------------------------------------------------

/** The shape layer with `id`, or an error saying what it is instead. */
export function requireShapeLayer(layers: readonly ImageLayer[], id: string): ShapeLayer {
  const layer = requireLayer(layers, id).layer;
  if (layer.type !== 'shape') fail(`Layer "${layer.name || id}" is a ${layer.type} layer, not a shape layer; list_layers shows each layer's type.`);
  return layer as ShapeLayer;
}

export interface ShapeLayerData {
  name?: string;
  components: ShapeComponent[];
  fill?: ShapePaint | null;
  stroke?: ShapeStroke | null;
  fillRule?: ShapeFillRule;
  inverted?: boolean;
  visible?: boolean;
  opacity?: number;
  blend?: BlendMode;
}

/** A new shape layer, rendered. */
export function createShapeLayer(init: ShapeLayerData, env: ShapeEnv, id = newLayerId()): ShapeLayer {
  if (!init.components.length) fail('A shape needs at least one component.');
  const layer: ShapeLayer = {
    type: 'shape',
    id,
    name: init.name ?? defaultShapeName(init.components[0]),
    visible: init.visible ?? true,
    opacity: init.opacity ?? 1,
    blend: init.blend ?? 'normal',
    components: init.components,
    fill: init.fill === undefined ? null : init.fill,
    stroke: init.stroke ?? null,
    surface: emptySurface(4),
    offset: { x: 0, y: 0 },
  };
  if (init.fillRule && init.fillRule !== 'nonzero') layer.fillRule = init.fillRule;
  if (init.inverted) layer.inverted = true;
  return rerenderShape(layer, env);
}

/** The default name of a shape layer (Photoshop names them by tool). */
export function defaultShapeName(c: ShapeComponent | undefined): string {
  switch (c?.live?.kind) {
    case 'rect':
      return 'Rectangle';
    case 'ellipse':
      return 'Ellipse';
    case 'polygon':
      return 'Polygon';
    case 'star':
      return 'Star';
    case 'line':
      return 'Line';
    default:
      return 'Shape';
  }
}

/** Replaces a shape layer's data (dropping the migrated annotation) and renders it again. */
export function updateShapeLayer(layers: readonly ImageLayer[], id: string, change: (layer: ShapeLayer) => Partial<ShapeLayer>, env: ShapeEnv, action = 'edit it'): { layers: ImageLayer[]; layer: ShapeLayer } {
  const current = requireShapeLayer(layers, id);
  requireUnlocked(current, 'pixels', action);
  const patch = change(current);
  const next: ShapeLayer = { ...current, ...patch };
  if (!('annotation' in patch)) delete next.annotation;
  if (!next.components.length) fail('A shape needs at least one component; delete the layer instead.');
  const rendered = rerenderShape(next, env);
  return { layers: mapLayer(layers, id, () => rendered), layer: rendered };
}

/** Moves every component of a shape by `f` (a document-space point map); `affine` keeps live shapes live. */
export function transformShapeComponents(components: readonly ShapeComponent[], f: (p: Vec2) => Vec2, affine?: AffineMatrix): ShapeComponent[] {
  return components.map((c) => {
    if (affine && c.live) {
      const live = { ...c.live, transform: multiplyMatrices(c.live.transform ?? IDENTITY_MATRIX, affine) } as LiveShape;
      if (isIdentityMatrix(live.transform!)) delete live.transform;
      return { op: c.op, subpaths: liveShapeSubpaths(live), live };
    }
    return { op: c.op, subpaths: mapSubpaths(c.subpaths, f) };
  });
}

/** A shape moved by (dx, dy), rendered again. */
export function offsetShape(layer: ShapeLayer, dx: number, dy: number, env: ShapeEnv): ShapeLayer {
  const m = translateMatrix(dx, dy);
  const next: ShapeLayer = { ...layer, components: transformShapeComponents(layer.components, (p) => ({ x: p.x + dx, y: p.y + dy }), m) };
  delete next.annotation;
  return rerenderShape(next, env);
}

/** Merge Shape Components: the combined area as one `combine` component (live shapes become paths). */
export function mergeShapeComponents(components: readonly ShapeComponent[], fillRule: ShapeFillRule = 'nonzero'): ShapeComponent[] {
  if (components.length < 2) return [...components];
  const path = shapeOutline(components, fillRule);
  const subpaths = bezierToSubpaths(path);
  if (!subpaths.length) fail('The components combine to nothing (the operations remove every area), so there is nothing to merge into.');
  return [{ op: 'combine', subpaths }];
}

/** A shape layer as a pixel layer with what it shows now (same id, name, mask, effects, blend). */
export function shapeAsPixelLayer(layer: ShapeLayer): PixelLayer {
  const { components: _c, fillRule: _r, inverted: _i, fill: _f, stroke: _s, annotation: _a, psd: _p, type: _t, ...rest } = layer;
  return { ...rest, type: 'pixel', surface: layer.surface, offset: { x: 0, y: 0 } };
}

// ---------------------------------------------------------------------------
// Annotations → shapes (migration) and back (compatibility view)
// ---------------------------------------------------------------------------

/** A paint from an annotation colour at `opacity`, or `undefined` when the colour can't be read. */
function annotationPaint(color: string | undefined, opacity: number): ShapePaint | undefined {
  const c = parseCssColor(color);
  if (!c || !parseEffectColor(c.hex)) return undefined;
  const a = c.alpha * opacity;
  return a !== 1 ? { type: 'color', color: c.hex, opacity: a } : { type: 'color', color: c.hex };
}

/**
 * The shape an annotation draws (pen, rectangle, ellipse, line, arrow), exactly as the canvas drew
 * it, or `null` for annotations that are not shapes (text, image) or use a colour we can't read.
 */
export function shapeFromAnnotation(a: Annotation): Pick<ShapeLayer, 'components' | 'fill' | 'stroke'> | null {
  const opacity = a.opacity ?? 1;
  // A canvas ignores a line width of 0 or less and keeps its default of 1.
  const lineWidth = 'strokeWidth' in a && a.strokeWidth > 0 ? a.strokeWidth : 1;
  const rotation = a.rotation ? rotateMatrix(a.rotation, { x: a.x, y: a.y }) : undefined;
  const t = rotation ? { transform: rotation } : {};
  const live = (l: LiveShape) => liveComponent(l);
  switch (a.type) {
    case 'rect': {
      const stroke = annotationPaint(a.strokeColor, opacity);
      if (!stroke) return null;
      const fill = a.fillColor ? annotationPaint(a.fillColor, opacity) : null;
      if (fill === undefined) return null;
      return {
        components: [live({ kind: 'rect', x: a.x, y: a.y, width: a.width, height: a.height, ...t })],
        fill,
        stroke: a.strokeWidth > 0 ? { width: a.strokeWidth, paint: stroke } : null,
      };
    }
    case 'circle': {
      const stroke = annotationPaint(a.strokeColor, opacity);
      if (!stroke) return null;
      const fill = a.fillColor ? annotationPaint(a.fillColor, opacity) : null;
      if (fill === undefined) return null;
      const rx = Math.abs(a.radiusX);
      const ry = Math.abs(a.radiusY);
      return {
        components: [live({ kind: 'ellipse', x: a.x - rx, y: a.y - ry, width: 2 * rx, height: 2 * ry, ...t })],
        fill,
        stroke: a.strokeWidth > 0 ? { width: a.strokeWidth, paint: stroke } : null,
      };
    }
    case 'line':
    case 'arrow': {
      const paint = annotationPaint(a.strokeColor, opacity);
      if (!paint) return null;
      const line: LiveShape = { kind: 'line', x1: a.x, y1: a.y, x2: a.endX, y2: a.endY, weight: lineWidth, ...t };
      if (a.type === 'arrow') {
        // The old arrowhead: two sides `max(12, 3w)` long at ±30° from the line, filled.
        const side = Math.max(12, a.strokeWidth * 3);
        line.endArrow = { width: side, length: side * Math.cos(Math.PI / 6) };
      }
      if (line.x1 === line.x2 && line.y1 === line.y2) return { components: [{ op: 'combine', subpaths: [] }], fill: paint, stroke: null };
      return { components: [live(line)], fill: paint, stroke: null };
    }
    case 'pen': {
      const paint = annotationPaint(a.strokeColor, opacity);
      if (!paint) return null;
      const pts = rotation ? a.points.map((p) => applyMatrix(rotation, p)) : a.points;
      const subpaths: VectorSubpath[] = pts.length > 1 ? [{ closed: false, anchors: pts.map((p) => ({ x: p.x, y: p.y })) }] : [];
      return {
        components: [{ op: 'combine', subpaths }],
        fill: null,
        stroke: { width: lineWidth, paint, cap: 'round', join: 'round' },
      };
    }
    default:
      return null;
  }
}

/** The blend a migrated layer draws with: the annotation's own unless the layer set one. */
export function annotationBlend(a: Annotation, layerBlend: string): BlendMode {
  if (layerBlend !== 'normal') return layerBlend as BlendMode;
  return a.blend && isBlendMode(a.blend) ? a.blend : 'normal';
}

/** The annotation a migrated shape layer still is (its blend read from the layer). */
export function annotationOfShape(layer: ShapeLayer): Annotation | null {
  const a = layer.annotation;
  if (!a) return null;
  const blend = layer.blend as BlendMode;
  if ((a.blend ?? 'normal') === blend) return a;
  const out = { ...a } as Annotation;
  if (blend === 'normal') delete out.blend;
  else out.blend = blend;
  return out;
}
