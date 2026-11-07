/**
 * Evolutionary strokes: breed and mutate stroke variants (`RecordedStroke` genomes).
 *
 * - **Geometry mutation**: reuses `StrokeVariation` / `varyStroke` for whole-stroke affine drift
 *   (move, scale, rotate, pressure scale) plus seeded, smoothed point jitter along the path.
 * - **Colour drift**: perceptual drift in OKLCH lightness, chroma and hue, gamut-mapped to sRGB.
 * - **Brush facet drift**: drifts numeric brush facets within their schema ranges (`BRUSH_JSON_SCHEMA`)
 *   and resolves back to an engine `PaintBrush`.
 * - **Seed reroll**: deterministic reroll of the stroke's dab/particle/bristle seed.
 * - **Crossover**: resamples two parent stroke paths to a common point count, blends their points
 *   and colours in OKLab/OKLCH, and mixes their brush facets.
 */

import { migrateBrushV1 } from '../brushes/migrate';
import { normalizeBrushSpec } from '../brushes/normalize';
import { resolveBrush } from '../brushes/resolve';
import type { Brush } from '../brushes/types';
import { oklabToOklch, oklabToRgb, oklchToOklab, rgbToOklab } from '../color/convert.js';
import { mix32, rand01, randSigned } from '../paint/rand';
import { bytesToBase64, encodePng } from '../raster/png';
import type { RasterRect } from '../raster/surface';
import type { PaintBrush } from './brushes';
import { parseHexColor } from './color';
import type { PaintProposal } from './collaboration';
import type { PaintEditorController, PixelImage } from './controller';
import { withStrokePath } from './effect-paint';
import type { PenPoint } from './engine';
import { liveStrokeRefusal } from './live-strokes';
import { contactSheet } from './replay';
import { strokeBounds, strokeToJSON, variationAffine, varyStroke, type RecordedStroke, type StrokeVariation } from './strokes';

export type RecordedStrokeJSON = ReturnType<typeof strokeToJSON>;

/** How strongly each part of a stroke genome mutates (`0..1`; `0` keeps that part unchanged). */
export interface StrokeMutationRates {
  /** Path variation and smoothed point jitter, 0..1 (default 0.35). */
  geometry?: number;
  /** Colour drift in OKLCH lightness, chroma and hue, 0..1 (default 0.35). */
  color?: number;
  /** Brush facet drift within schema bounds, 0..1 (default 0.35). */
  brush?: number;
  /** Seed reroll rate, 0..1 (default 0.5; 0 keeps the stroke seed). */
  seed?: number;
}

export type EvolutionMutationRates = StrokeMutationRates;

export interface ResolvedMutationRates {
  geometry: number;
  color: number;
  brush: number;
  seed: number;
}

export const DEFAULT_MUTATION_RATES: ResolvedMutationRates = {
  geometry: 0.35,
  color: 0.35,
  brush: 0.35,
  seed: 0.5,
};

/** Validates and fills defaults for mutation rates (`0..1`). */
export function normalizeMutationRates(rates?: StrokeMutationRates): ResolvedMutationRates {
  const out: ResolvedMutationRates = { ...DEFAULT_MUTATION_RATES };
  if (!rates) return out;
  for (const key of ['geometry', 'color', 'brush', 'seed'] as const) {
    const v = rates[key];
    if (v !== undefined) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`mutation.${key} ${JSON.stringify(v)} is out of range; use 0..1.`);
      }
      out[key] = v;
    }
  }
  return out;
}

/** Rounds `v` to `1 / scale` (using integer division so JS and Swift round identically). */
function roundScale(v: number, scale: number): number {
  const r = Math.round(v * scale) / scale;
  return Object.is(r, -0) ? 0 : r;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Numeric brush facet descriptor with its schema range and drift span. */
export interface EvolutionBrushFacet {
  /** Dot-path in the facet `Brush`. */
  facet: string;
  /** Dot-path in the resolved `PaintBrush`. */
  engine: string;
  /** Engines that read this facet. */
  engines: readonly PaintBrush['engine'][];
  /** Minimum schema value. */
  min: number;
  /** Maximum schema value. */
  max: number;
  /** Maximum drift at `mutation.brush = 1` (relative fraction when `relative` is true, else additive). */
  span: number;
  /** Inverse of rounding step (`1`, `10`, `100`). */
  scale: number;
  /** True when `span` scales the current value multiplicatively. */
  relative?: boolean;
  /** Optional `tip.shape` filter. */
  shapes?: readonly string[];
  /** Optional `marks.kind` filter. */
  marks?: readonly string[];
}

const LIVE_ENGINES: readonly PaintBrush['engine'][] = ['dab', 'mixer', 'particle', 'bristle'];

/** Ordered table of numeric brush facets drifted and crossed over within their schema ranges. */
export const EVOLUTION_BRUSH_FACETS: readonly EvolutionBrushFacet[] = [
  { facet: 'tip.size', engine: 'tip.size', engines: LIVE_ENGINES, min: 1, max: 512, span: 0.35, scale: 10, relative: true },
  { facet: 'tip.hardness', engine: 'tip.hardness', engines: LIVE_ENGINES, min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'tip.spacing', engine: 'tip.spacing', engines: LIVE_ENGINES, min: 0.02, max: 2, span: 0.3, scale: 100, relative: true },
  { facet: 'tip.roundness', engine: 'tip.roundness', engines: LIVE_ENGINES, min: 0.05, max: 1, span: 0.25, scale: 100 },
  { facet: 'tip.opacity', engine: 'tip.opacity', engines: LIVE_ENGINES, min: 0.1, max: 1, span: 0.2, scale: 100 },
  { facet: 'tip.flow', engine: 'tip.flow', engines: LIVE_ENGINES, min: 0.1, max: 1, span: 0.2, scale: 100 },
  { facet: 'dynamics.sizeJitter', engine: 'dynamics.sizeJitter', engines: LIVE_ENGINES, min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'dynamics.angleJitter', engine: 'dynamics.angleJitter', engines: LIVE_ENGINES, min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'dynamics.opacityJitter', engine: 'dynamics.opacityJitter', engines: LIVE_ENGINES, min: 0, max: 1, span: 0.2, scale: 100 },
  { facet: 'dynamics.scatter', engine: 'dynamics.scatter', engines: LIVE_ENGINES, min: 0, max: 2, span: 0.3, scale: 100 },
  { facet: 'behaviour.grain', engine: 'grain', engines: LIVE_ENGINES, min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'tip.bristle.count', engine: 'bristle.count', engines: ['bristle'], shapes: ['bristle'], min: 3, max: 128, span: 16, scale: 1 },
  { facet: 'tip.bristle.stiffness', engine: 'bristle.stiffness', engines: ['bristle'], shapes: ['bristle'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'tip.bristle.splay', engine: 'bristle.splay', engines: ['bristle'], shapes: ['bristle'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'tip.bristle.load', engine: 'bristle.load', engines: ['bristle'], shapes: ['bristle'], min: 0.1, max: 1, span: 0.25, scale: 100 },
  { facet: 'tip.bristle.jitter', engine: 'bristle.jitter', engines: ['bristle'], shapes: ['bristle'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'marks.count', engine: 'particle.count', engines: ['particle'], marks: ['particles'], min: 1, max: 64, span: 8, scale: 1 },
  { facet: 'marks.size', engine: 'particle.size', engines: ['particle'], marks: ['particles'], min: 0.01, max: 1, span: 0.2, scale: 100 },
  { facet: 'marks.spread', engine: 'particle.spread', engines: ['particle'], marks: ['particles'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'marks.stiffness', engine: 'particle.stiffness', engines: ['particle'], marks: ['particles'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'marks.damping', engine: 'particle.damping', engines: ['particle'], marks: ['particles'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'marks.speed', engine: 'particle.speed', engines: ['particle'], marks: ['particles'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'marks.waveAmplitude', engine: 'particle.waveAmplitude', engines: ['particle'], marks: ['particles'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'marks.density', engine: 'spray.density', engines: ['dab'], marks: ['scatter'], min: 0.05, max: 1, span: 0.25, scale: 100 },
  { facet: 'marks.size', engine: 'spray.size', engines: ['dab'], marks: ['scatter'], min: 0.02, max: 1, span: 0.2, scale: 100 },
  { facet: 'behaviour.exchange.mix', engine: 'mixer.mix', engines: ['mixer'], min: 0, max: 1, span: 0.25, scale: 100 },
  { facet: 'behaviour.exchange.reservoir.load', engine: 'mixer.load', engines: ['mixer'], min: 0.05, max: 1, span: 0.25, scale: 100 },
];

function getEngineNumber(brush: PaintBrush, path: string): number {
  let cur: unknown = brush;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return 0;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' ? cur : 0;
}

function setFacetPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    const child = node[k];
    const next = child && typeof child === 'object' ? { ...(child as Record<string, unknown>) } : {};
    node[k] = next;
    node = next;
  }
  node[keys[keys.length - 1]!] = value;
}

/**
 * Seeded, smoothed point jitter along a stroke path: combines two harmonic waves with a 3-point
 * smoothed random displacement so mutated paths stay fluid rather than jagged.
 */
export function jitterStrokePoints(points: readonly PenPoint[], amount: number, seed: number): PenPoint[] {
  const n = points.length;
  if (!(amount > 0) || n === 0) return points.map((p) => ({ ...p }));
  const bounds = strokeBounds(points);
  const span = Math.max(12, Math.hypot(bounds.width, bounds.height));
  const amp = amount * Math.min(48, Math.max(3, span * 0.12));
  const p1x = rand01(seed, 0, 101) * Math.PI * 2;
  const p1y = rand01(seed, 1, 101) * Math.PI * 2;
  const p2x = rand01(seed, 2, 101) * Math.PI * 2;
  const p2y = rand01(seed, 3, 101) * Math.PI * 2;
  const smoothNoise = (i: number, stream: number): number => {
    const prev = Math.max(0, i - 1);
    const next = Math.min(n - 1, i + 1);
    return (randSigned(seed, prev, stream) + 2 * randSigned(seed, i, stream) + randSigned(seed, next, stream)) * 0.25;
  };
  return points.map((p, i) => {
    const u = n > 1 ? i / (n - 1) : 0;
    const dx = amp * (0.55 * Math.sin(u * Math.PI * 2 + p1x) + 0.25 * Math.sin(u * Math.PI * 4 + p2x) + 0.2 * smoothNoise(i, 102));
    const dy = amp * (0.55 * Math.cos(u * Math.PI * 2 + p1y) + 0.25 * Math.cos(u * Math.PI * 4 + p2y) + 0.2 * smoothNoise(i, 103));
    const dp = amount * 0.18 * (0.6 * Math.sin(u * Math.PI * 2 + p1x) + 0.4 * smoothNoise(i, 104));
    const pressure = roundScale(clamp((p.pressure ?? 0.7) + dp, 0.05, 1), 1000);
    return {
      ...p,
      x: roundScale(p.x + dx, 100),
      y: roundScale(p.y + dy, 100),
      pressure,
    };
  });
}

/** Whole-stroke `StrokeVariation` derived from a seed and geometry mutation rate (`0..1`). */
export function seededStrokeVariation(amount: number, seed: number, index = 0): StrokeVariation {
  if (!(amount > 0)) return { dx: 0, dy: 0, scale: 1, rotate: 0, pressureScale: 1 };
  const base = index * 8;
  return {
    dx: roundScale(randSigned(seed, base + 0, 110) * amount * 18, 100),
    dy: roundScale(randSigned(seed, base + 1, 110) * amount * 18, 100),
    scale: roundScale(1 + randSigned(seed, base + 2, 110) * amount * 0.22, 1000),
    rotate: roundScale(randSigned(seed, base + 3, 110) * amount * 24, 100),
    pressureScale: roundScale(1 + randSigned(seed, base + 4, 110) * amount * 0.2, 1000),
  };
}

/** Gamut-maps an OKLCH colour into `#rrggbb` by bisecting chroma when needed. */
function oklchToHexGamut(l: number, c: number, h: number): string {
  const at = (ch: number) => oklabToRgb(oklchToOklab({ l, c: ch, h, alpha: 1 }));
  const inGamut = (o: { r: number; g: number; b: number }) => [o.r, o.g, o.b].every((v) => v >= -1e-4 && v <= 1 + 1e-4);
  let out = at(c);
  if (!inGamut(out)) {
    let lo = 0;
    let hi = c;
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    out = at(lo);
  }
  return '#' + [out.r, out.g, out.b].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * Drifts a `#rrggbb` colour in OKLCH lightness (±0.22), chroma (±0.10) and hue (±90°) scaled by
 * `amount` (`0..1`), reducing chroma when needed to stay inside the sRGB gamut.
 */
export function driftColorOklch(hex: string, amount: number, seed: number, index = 0): string {
  const [r, g, b] = parseHexColor(hex);
  const norm = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  if (!(amount > 0)) return norm;
  const lch = oklabToOklch(rgbToOklab({ r: r / 255, g: g / 255, b: b / 255, a: 1 }));
  const l = clamp(lch.l + randSigned(seed, index, 201) * amount * 0.22, 0.02, 0.98);
  const c = clamp(lch.c + randSigned(seed, index, 202) * amount * 0.1, 0, 0.37);
  const h = lch.h + randSigned(seed, index, 203) * amount * 90;
  return oklchToHexGamut(l, c, h);
}

/** Mixes two `#rrggbb` colours perceptually in OKLab/OKLCH at weight `t` (`0..1`). */
export function mixColorOklch(hexA: string, hexB: string, t: number): string {
  const [ra, ga, ba] = parseHexColor(hexA);
  const [rb, gb, bb] = parseHexColor(hexB);
  const u = clamp(t, 0, 1);
  const labA = rgbToOklab({ r: ra / 255, g: ga / 255, b: ba / 255, a: 1 });
  const labB = rgbToOklab({ r: rb / 255, g: gb / 255, b: bb / 255, a: 1 });
  const lch = oklabToOklch({
    l: labA.l + (labB.l - labA.l) * u,
    a: labA.a + (labB.a - labA.a) * u,
    b: labA.b + (labB.b - labA.b) * u,
    alpha: 1,
  });
  return oklchToHexGamut(clamp(lch.l, 0, 1), Math.max(0, lch.c), lch.h);
}

/**
 * Drifts a brush's numeric facets within their schema ranges (`EVOLUTION_BRUSH_FACETS`), keeping
 * the brush compatible with live strokes (`liveStrokeRefusal`).
 */
export function driftBrushFacets(brush: PaintBrush, amount: number, seed: number, index = 0): PaintBrush {
  if (!(amount > 0)) return brush;
  const facetSpec = migrateBrushV1(brush) as unknown as Record<string, unknown>;
  const base = resolveBrush(facetSpec as unknown as Brush);
  const shape = ((facetSpec.tip as Record<string, unknown> | undefined)?.shape as string | undefined) ?? 'round';
  const marksKind = ((facetSpec.marks as Record<string, unknown> | undefined)?.kind as string | undefined) ?? 'continuous';
  for (let fi = 0; fi < EVOLUTION_BRUSH_FACETS.length; fi++) {
    const f = EVOLUTION_BRUSH_FACETS[fi]!;
    if (!f.engines.includes(base.engine)) continue;
    if (f.shapes && !f.shapes.includes(shape)) continue;
    if (f.marks && !f.marks.includes(marksKind)) continue;
    const gate = rand01(seed, index * 32 + fi, 301);
    if (fi > 0 && gate >= 0.35 + 0.65 * amount) continue;
    const cur = getEngineNumber(base, f.engine);
    const r = randSigned(seed, index * 32 + fi, 302);
    const raw = f.relative ? cur * (1 + r * amount * f.span) : cur + r * amount * f.span;
    const next = roundScale(clamp(raw, f.min, f.max), f.scale);
    if (next !== roundScale(cur, f.scale)) {
      setFacetPath(facetSpec, f.facet, next);
    }
  }
  const resolved = resolveBrush(normalizeBrushSpec(facetSpec));
  return { ...resolved, builtin: undefined };
}

/** Rerolls a stroke seed deterministically when `amount > 0`; keeps `strokeSeed` when `amount <= 0`. */
export function rerollStrokeSeed(strokeSeed: number, amount: number, seed: number, index = 0): number {
  if (!(amount > 0)) return strokeSeed;
  const salt = mix32(((seed | 0) + Math.imul(index, 7919) + Math.round(amount * 1000)) >>> 0);
  const mixed = mix32(((strokeSeed | 0) ^ salt) >>> 0) & 0x7fffffff;
  return mixed === 0 ? 1 : mixed;
}

/** Resamples a stroke's points by arc length to `count` evenly spaced samples. */
export function resampleStrokePoints(points: readonly PenPoint[], count: number): PenPoint[] {
  const m = points.length;
  if (m === 0) return [];
  const n = Math.max(1, Math.round(count));
  if (m === 1 || n === 1) {
    return Array.from({ length: n }, () => ({
      ...points[0]!,
      x: roundScale(points[0]!.x, 100),
      y: roundScale(points[0]!.y, 100),
      ...(points[0]!.pressure !== undefined ? { pressure: roundScale(points[0]!.pressure, 1000) } : {}),
    }));
  }
  const cum = new Array<number>(m);
  cum[0] = 0;
  for (let i = 1; i < m; i++) {
    cum[i] = cum[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  const total = cum[m - 1]!;
  const out: PenPoint[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1);
    let idx = 0;
    let t = 0;
    if (total <= 1e-6) {
      const pos = u * (m - 1);
      idx = Math.min(m - 2, Math.floor(pos));
      t = pos - idx;
    } else {
      const target = u * total;
      while (seg < m - 2 && cum[seg + 1]! < target) seg++;
      idx = seg;
      const segLen = cum[idx + 1]! - cum[idx]!;
      t = segLen > 1e-9 ? clamp((target - cum[idx]!) / segLen, 0, 1) : 0;
    }
    const a = points[idx]!;
    const b = points[idx + 1]!;
    const pa = a.pressure ?? 0.7;
    const pb = b.pressure ?? 0.7;
    const pt: PenPoint = {
      x: roundScale(a.x + (b.x - a.x) * t, 100),
      y: roundScale(a.y + (b.y - a.y) * t, 100),
      pressure: roundScale(pa + (pb - pa) * t, 1000),
    };
    if (a.tiltX !== undefined || b.tiltX !== undefined) {
      pt.tiltX = roundScale((a.tiltX ?? 0) + ((b.tiltX ?? 0) - (a.tiltX ?? 0)) * t, 10);
    }
    if (a.tiltY !== undefined || b.tiltY !== undefined) {
      pt.tiltY = roundScale((a.tiltY ?? 0) + ((b.tiltY ?? 0) - (a.tiltY ?? 0)) * t, 10);
    }
    out.push(pt);
  }
  return out;
}

/** Mixes two brushes by blending their applicable numeric facets onto a dominant parent's skeleton. */
export function crossoverBrushes(brushA: PaintBrush, brushB: PaintBrush, seed: number, index = 0): PaintBrush {
  const fa = migrateBrushV1(brushA);
  const fb = migrateBrushV1(brushB);
  const pickB = rand01(seed, index, 400) >= 0.5;
  const domFacet = JSON.parse(JSON.stringify(pickB ? fb : fa)) as Record<string, unknown>;
  const ra = resolveBrush(fa);
  const rb = resolveBrush(fb);
  const rDom = pickB ? rb : ra;
  const shape = ((domFacet.tip as Record<string, unknown> | undefined)?.shape as string | undefined) ?? 'round';
  const marksKind = ((domFacet.marks as Record<string, unknown> | undefined)?.kind as string | undefined) ?? 'continuous';
  for (let fi = 0; fi < EVOLUTION_BRUSH_FACETS.length; fi++) {
    const f = EVOLUTION_BRUSH_FACETS[fi]!;
    if (!f.engines.includes(rDom.engine)) continue;
    if (f.shapes && !f.shapes.includes(shape)) continue;
    if (f.marks && !f.marks.includes(marksKind)) continue;
    const va = getEngineNumber(ra, f.engine);
    const vb = getEngineNumber(rb, f.engine);
    const vDom = roundScale(getEngineNumber(rDom, f.engine), f.scale);
    const w = 0.2 + 0.6 * rand01(seed, index * 32 + fi, 401);
    const mixed = roundScale(clamp(va + (vb - va) * w, f.min, f.max), f.scale);
    if (mixed !== vDom) {
      setFacetPath(domFacet, f.facet, mixed);
    }
  }
  const resolved = resolveBrush(normalizeBrushSpec(domFacet));
  return { ...resolved, builtin: undefined };
}

/**
 * Crosses two parent strokes over: resamples their points to a common count, blends positions and
 * pressures, mixes their colours in OKLab/OKLCH, mixes their brush facets and combines their seeds.
 */
export function crossoverStrokes(a: RecordedStroke, b: RecordedStroke, seed: number, index = 0): RecordedStroke {
  const count = a.points.length <= 1 && b.points.length <= 1 ? 1 : Math.max(2, Math.round((a.points.length + b.points.length) / 2));
  const pa = resampleStrokePoints(a.points, count);
  const pb = resampleStrokePoints(b.points, count);
  const w = 0.25 + 0.5 * rand01(seed, index, 410);
  const points: PenPoint[] = pa.map((p, i) => {
    const q = pb[i]!;
    const pt: PenPoint = {
      x: roundScale(p.x + (q.x - p.x) * w, 100),
      y: roundScale(p.y + (q.y - p.y) * w, 100),
      pressure: roundScale((p.pressure ?? 0.7) + ((q.pressure ?? 0.7) - (p.pressure ?? 0.7)) * w, 1000),
    };
    if (p.tiltX !== undefined || q.tiltX !== undefined) {
      pt.tiltX = roundScale((p.tiltX ?? 0) + ((q.tiltX ?? 0) - (p.tiltX ?? 0)) * w, 10);
    }
    if (p.tiltY !== undefined || q.tiltY !== undefined) {
      pt.tiltY = roundScale((p.tiltY ?? 0) + ((q.tiltY ?? 0) - (p.tiltY ?? 0)) * w, 10);
    }
    return pt;
  });
  const color = mixColorOklch(a.color, b.color, w);
  const brush = crossoverBrushes(a.brush, b.brush, seed, index);
  const childSeed = (mix32(((a.seed | 0) ^ mix32(((b.seed | 0) + (seed | 0) + index) >>> 0)) >>> 0) & 0x7fffffff) || 1;
  const dom = w >= 0.5 ? b : a;
  let paint = dom.paint;
  if (paint?.type === 'effect' && paint.map?.by === 'path') {
    paint = withStrokePath(paint, points);
  }
  let load = dom.load;
  if (load?.reservoir) {
    const [r, g, bl] = parseHexColor(color);
    load = { ...load, reservoir: [r / 255, g / 255, bl / 255] };
  }
  return {
    id: a.id,
    layerId: a.layerId,
    brush,
    color,
    points,
    seed: childSeed,
    ...(dom.copies ? { copies: dom.copies } : {}),
    ...(load ? { load } : {}),
    ...(dom.stencils ? { stencils: dom.stencils } : {}),
    ...(paint ? { paint } : {}),
  };
}

/**
 * Mutates one stroke genome with `rates` (`geometry`, `color`, `brush`, `seed`). When `origin` and
 * `variation` are given (for multi-stroke motifs), whole-stroke affine drift uses them so strokes
 * in the same genome move and turn together while each stroke's path jitters on its own.
 */
export function mutateStroke(
  stroke: RecordedStroke,
  rates: strokeMutationInput,
  seed: number,
  index = 0,
  group?: { origin: { x: number; y: number }; variation: StrokeVariation }
): RecordedStroke {
  const r = normalizeMutationRates(rates);
  let out: RecordedStroke = {
    ...stroke,
    points: stroke.points.map((p) => ({ ...p })),
  };
  const baseSize = stroke.brush.tip.size;
  if (r.geometry > 0) {
    const b = strokeBounds(out.points);
    const origin = group?.origin ?? { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const v = group?.variation ?? seededStrokeVariation(r.geometry, seed, index);
    const m = variationAffine(v, origin);
    out = varyStroke(out, m, { scale: v.scale, pressureScale: v.pressureScale });
    // Keep tip.size separate from geometry when brush mutation is 0, or round it cleanly.
    if (r.brush === 0) {
      out = { ...out, brush: { ...out.brush, tip: { ...out.brush.tip, size: baseSize } } };
    } else {
      out = { ...out, brush: { ...out.brush, tip: { ...out.brush.tip, size: roundScale(out.brush.tip.size, 10) } } };
    }
    const jittered = jitterStrokePoints(out.points, r.geometry, ((seed | 0) + Math.imul(index, 997)) | 0);
    out = {
      ...out,
      points: jittered,
      ...(out.paint?.type === 'effect' && out.paint.map?.by === 'path' ? { paint: withStrokePath(out.paint, jittered) } : {}),
    };
  }
  if (r.color > 0) {
    const nextColor = driftColorOklch(out.color, r.color, seed, index);
    if (out.paint?.type === 'gradient') {
      const stops = out.paint.stops.map((st, si) => ({
        ...st,
        color: driftColorOklch(st.color, r.color, seed, index * 16 + si + 1),
      }));
      out = { ...out, color: stops[0]?.color ?? nextColor, paint: { ...out.paint, stops } };
    } else {
      out = { ...out, color: nextColor };
    }
    if (out.load?.reservoir && out.color !== stroke.color) {
      const [cr, cg, cb] = parseHexColor(out.color);
      out = { ...out, load: { ...out.load, reservoir: [cr / 255, cg / 255, cb / 255] } };
    }
  }
  if (r.brush > 0) {
    out = { ...out, brush: driftBrushFacets(out.brush, r.brush, seed, index) };
  }
  if (r.seed > 0) {
    out = { ...out, seed: rerollStrokeSeed(out.seed, r.seed, seed, index) };
  }
  return out;
}

type strokeMutationInput = StrokeMutationRates | undefined;

export interface StrokeEvolutionChanges {
  geometry: boolean;
  colors: Array<{ from: string; to: string }>;
  facets: Record<string, { from: number; to: number }>;
  seedChanged: boolean;
  crossover: boolean;
}

/** Summarises what changed between a parent stroke genome and a bred child genome. */
export function describeGenomeDiff(
  parents: readonly RecordedStroke[],
  children: readonly RecordedStroke[],
  options: { crossover?: boolean } = {}
): { diff: string; changes: StrokeEvolutionChanges } {
  const crossover = Boolean(options.crossover);
  let geometry = false;
  const colors: Array<{ from: string; to: string }> = [];
  const facets: Record<string, { from: number; to: number }> = {};
  let seedChanged = false;

  for (let i = 0; i < children.length; i++) {
    const p = parents[i % parents.length]!;
    const c = children[i]!;
    if (
      p.points.length !== c.points.length ||
      c.points.some((pt, k) => pt.x !== p.points[k]?.x || pt.y !== p.points[k]?.y || (pt.pressure ?? 0.7) !== (p.points[k]?.pressure ?? 0.7))
    ) {
      geometry = true;
    }
    if (p.color.toLowerCase() !== c.color.toLowerCase()) {
      const entry = { from: p.color.toLowerCase(), to: c.color.toLowerCase() };
      if (!colors.some((x) => x.from === entry.from && x.to === entry.to)) colors.push(entry);
    }
    const fp = migrateBrushV1(p.brush) as unknown as Record<string, unknown>;
    const fc = migrateBrushV1(c.brush) as unknown as Record<string, unknown>;
    const rp = resolveBrush(fp as unknown as Brush);
    const rc = resolveBrush(fc as unknown as Brush);
    const shape = ((fc.tip as Record<string, unknown> | undefined)?.shape as string | undefined) ?? 'round';
    const marksKind = ((fc.marks as Record<string, unknown> | undefined)?.kind as string | undefined) ?? 'continuous';
    for (const f of EVOLUTION_BRUSH_FACETS) {
      if (!f.engines.includes(rc.engine)) continue;
      if (f.shapes && !f.shapes.includes(shape)) continue;
      if (f.marks && !f.marks.includes(marksKind)) continue;
      const vp = roundScale(getEngineNumber(rp, f.engine), f.scale);
      const vc = roundScale(getEngineNumber(rc, f.engine), f.scale);
      if (vp !== vc && facets[f.facet] === undefined) {
        facets[f.facet] = { from: vp, to: vc };
      }
    }
    if (p.seed !== c.seed) seedChanged = true;
  }

  const parts: string[] = [];
  if (crossover) parts.push('crossover');
  if (geometry) parts.push('geometry');
  for (const col of colors.slice(0, 2)) parts.push(`color ${col.from} → ${col.to}`);
  const facetEntries = Object.entries(facets);
  for (const [k, v] of facetEntries.slice(0, 3)) parts.push(`${k} ${v.from} → ${v.to}`);
  if (facetEntries.length > 3) parts.push(`+${facetEntries.length - 3} facets`);
  if (seedChanged) parts.push('seed');

  return {
    diff: parts.length > 0 ? parts.join(', ') : 'unchanged',
    changes: { geometry, colors, facets, seedChanged, crossover },
  };
}

/** Mutates a multi-stroke genome at `variantSeed`. */
export function mutateGenome(strokes: readonly RecordedStroke[], rates: StrokeMutationRates | undefined, variantSeed: number): RecordedStroke[] {
  const r = normalizeMutationRates(rates);
  const b = strokeBounds(strokes.flatMap((s) => s.points));
  const origin = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const variation = seededStrokeVariation(r.geometry, variantSeed, 0);
  return strokes.map((s, k) => mutateStroke(s, r, variantSeed, k, { origin, variation }));
}

/** Crosses two stroke genomes over and mutates the offspring at `variantSeed`. */
export function crossoverGenomes(
  genomeA: readonly RecordedStroke[],
  genomeB: readonly RecordedStroke[],
  rates: StrokeMutationRates | undefined,
  variantSeed: number
): RecordedStroke[] {
  const len = Math.max(genomeA.length, genomeB.length);
  const crossed: RecordedStroke[] = [];
  for (let k = 0; k < len; k++) {
    const a = genomeA[k % genomeA.length]!;
    const b = genomeB[k % genomeB.length]!;
    crossed.push(crossoverStrokes(a, b, variantSeed, k));
  }
  return mutateGenome(crossed, rates, (variantSeed + 3571) | 0);
}

/** Checks that every stroke in a genome can be bred and previewed (refuses brushes `liveStrokeRefusal` rejects). */
export function checkEvolutionStrokes(strokes: readonly RecordedStroke[]): void {
  for (const s of strokes) {
    const refusal = liveStrokeRefusal(s.brush);
    if (refusal) throw new Error(refusal);
  }
}

export interface BredProposalSummary {
  proposalId: string;
  title: string;
  seed: number;
  bounds: RasterRect | null;
  diff: string;
  changes: StrokeEvolutionChanges;
}

export interface BreedStrokesResult {
  proposalIds: string[];
  proposals: BredProposalSummary[];
}

export interface ProposalGenomeResult {
  proposalId: string;
  title: string;
  bounds: RasterRect | null;
  strokes: RecordedStrokeJSON[];
}

/** Extracts the stroke genome of a pending `PaintProposal`, or returns `[]` when it has none. */
export function proposalGenomeStrokes(
  first: PaintEditorController | PaintProposal,
  second?: PaintProposal
): RecordedStroke[] {
  const proposal = second ?? (first as PaintProposal);
  const controller = second ? (first as PaintEditorController) : undefined;
  const out: RecordedStroke[] = [];
  for (const op of proposal.ops) {
    if (op.kind === 'strokes') {
      for (const s of op.strokes) {
        const brush = 'engine' in s.brush ? s.brush : resolveBrush(normalizeBrushSpec(s.brush));
        out.push({ ...s, brush });
      }
    } else if (op.kind === 'stroke' && controller) {
      const baseBrush = (op.brushId ? controller.getBrush(op.brushId) : undefined) ?? controller.getState().brush;
      const brush: PaintBrush = {
        ...baseBrush,
        tip: {
          ...baseBrush.tip,
          ...(op.size !== undefined ? { size: op.size } : {}),
        },
      };
      out.push({
        id: proposal.id,
        layerId: controller.document.activeLayerId ?? 'layer-1',
        brush,
        color: (op.color ?? controller.getState().color).toLowerCase(),
        points: op.points.map((p) => ({ ...p })),
        seed: 1,
      });
    } else if (op.kind === 'echo' && controller) {
      const byId = new Map(controller.getStrokes().map((s) => [s.id, s]));
      const picked = op.strokeIds.map((id) => byId.get(id)).filter((s): s is RecordedStroke => Boolean(s));
      if (picked.length > 0) {
        const b = strokeBounds(picked.flatMap((s) => s.points));
        const origin = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        const step = variationAffine(op, origin);
        for (const s of picked) out.push(varyStroke(s, step, op));
      }
    }
  }
  return out;
}

/**
 * Renders a contact sheet (`replay.ts:contactSheet`) of pending proposals' ghosts composited over
 * the current canvas, for grid export.
 */
export function renderProposalContactSheet(
  controller: PaintEditorController,
  proposals: readonly PaintProposal[],
  options: { columns?: number; cell?: number; paper?: boolean } = {}
): PixelImage {
  const base = controller.compositePixels({ paper: options.paper ?? true });
  const frames: PixelImage[] = proposals.map((p) => {
    const data = new Uint8ClampedArray(base.data);
    if (p.bounds && p.ghost.length === p.bounds.width * p.bounds.height * 4) {
      const { x: bx, y: by, width: bw, height: bh } = p.bounds;
      for (let y = 0; y < bh; y++) {
        const dy = by + y;
        if (dy < 0 || dy >= base.height) continue;
        for (let x = 0; x < bw; x++) {
          const dx = bx + x;
          if (dx < 0 || dx >= base.width) continue;
          const si = (y * bw + x) * 4;
          const sa = p.ghost[si + 3]! / 255;
          if (sa <= 0) continue;
          const di = (dy * base.width + dx) * 4;
          const da = data[di + 3]! / 255;
          const outA = sa + da * (1 - sa);
          if (outA > 0) {
            data[di] = Math.round((p.ghost[si]! * sa + data[di]! * da * (1 - sa)) / outA);
            data[di + 1] = Math.round((p.ghost[si + 1]! * sa + data[di + 1]! * da * (1 - sa)) / outA);
            data[di + 2] = Math.round((p.ghost[si + 2]! * sa + data[di + 2]! * da * (1 - sa)) / outA);
            data[di + 3] = Math.round(outA * 255);
          }
        }
      }
    }
    return { width: base.width, height: base.height, data };
  });
  const cols = Math.max(1, options.columns ?? Math.min(4, Math.max(2, proposals.length)));
  return contactSheet(frames.length > 0 ? frames : [base], cols, options.cell ?? 200);
}

/** Encodes `renderProposalContactSheet` as a PNG byte array and base64 string. */
export function exportProposalContactSheetPng(
  controller: PaintEditorController,
  proposals: readonly PaintProposal[],
  options: { columns?: number; cell?: number; paper?: boolean } = {}
): { width: number; height: number; bytes: Uint8Array; base64: string } {
  const sheet = renderProposalContactSheet(controller, proposals, options);
  const bytes = encodePng(sheet.width, sheet.height, sheet.data);
  return { width: sheet.width, height: sheet.height, bytes, base64: bytesToBase64(bytes) };
}

export { strokeToJSON };
