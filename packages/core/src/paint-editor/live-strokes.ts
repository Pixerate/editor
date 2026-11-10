/**
 * Live stroke layers: a paint layer whose pixels are always drawn from its recorded strokes, so a
 * stroke's brush, colour, paint, seed and points can be changed after it is painted
 * (`PaintEditorController.updateStroke` and the rest). The document keeps the strokes
 * (`liveStrokes`), and the layer's surface is a cache of them drawn bottom first.
 *
 * Only brushes whose result depends on the stroke itself can be redrawn exactly: dab, particle and
 * bristle brushes, and the Mixer Brush, none of them picking up paint. Wet paint needs the
 * simulation's history, thick paint has relief channels, stickers are their own objects, and
 * smudges, blenders, pick-up brushes and erasers read the paint under them.
 */

import type { PaintBrush, PaintBrushEngine } from './brushes';
import { applyAffine, type RecordedStroke } from './strokes';

/** The engines a live stroke layer takes. */
export const LIVE_STROKE_ENGINES: readonly PaintBrushEngine[] = ['dab', 'particle', 'bristle', 'mixer'];

/** Why a brush can't paint on a live stroke layer, or `null` when it can. */
export function liveStrokeRefusal(brush: PaintBrush): string | null {
  switch (brush.engine) {
    case 'wet':
      return `The ${brush.name} brush paints wet media, which a stroke layer can't redraw (the paint depends on the simulation's history); paint it on a pixel layer (add_layer).`;
    case 'impasto':
      return `The ${brush.name} brush paints thick paint with relief, which a stroke layer doesn't keep; paint it on a pixel layer (add_layer).`;
    case 'sticker':
      return `The ${brush.name} brush sprays stickers, which are their own objects; spray them on an empty pixel layer (add_layer).`;
    case 'eraser':
      return `Erasers don't paint on a stroke layer; delete strokes instead (remove_strokes), or rasterize the layer first (rasterize_stroke_layer).`;
    case 'scraper':
      return `The ${brush.name} brush scrapes through painted pixel layers, which a stroke layer can't redraw; rasterize the layer first (rasterize_stroke_layer) or scrape on a pixel layer.`;
    case 'blender':
    case 'smudge':
    case 'vortex':
      return `The ${brush.name} brush moves the paint under it, so it can't be redrawn on its own; rasterize the layer first (rasterize_stroke_layer) or blend on a pixel layer.`;
    case 'antimatter':
      return `The ${brush.name} brush detonates existing paint across visible layers, so it can't be redrawn on a stroke layer; paint it on a pixel layer (add_layer) or rasterize the layer first (rasterize_stroke_layer).`;
  }
  if (brush.mutation) return `The ${brush.name} brush paints mutation strokes (which fade once an agent reads them), so it goes on a pixel layer (add_layer).`;
  if (brush.light.amount > 0) return `The ${brush.name} brush lays light, which a stroke layer doesn't redraw yet; paint light on a pixel layer (add_layer), or set light.amount to 0 (set_brush).`;
  if (brush.fluorescence.amount > 0) return `The ${brush.name} brush lays UV-fluorescent ink, which a stroke layer doesn't redraw yet; paint it on a pixel layer (add_layer), or set fluorescence.amount to 0 (set_brush).`;
  if (brush.thermochromic.hotColor !== null) return `The ${brush.name} brush lays thermochromic ink, which a stroke layer doesn't redraw yet; paint it on a pixel layer (add_layer), or remove thermochromic (set_brush).`;
  if (brush.ferro.amount > 0) return `The ${brush.name} brush lays ferrofluid, which a stroke layer doesn't redraw; paint ferrofluid on a pixel layer (add_layer), or set ferro.amount to 0 (set_brush).`;
  if (brush.behavior.pickup > 0) return `The ${brush.name} brush picks up the paint under it (pickup ${brush.behavior.pickup}), so it can't be redrawn on its own; set behavior.pickup to 0 (set_brush) or paint on a pixel layer.`;
  return null;
}

/** A stroke's extent in document pixels: its points and symmetry copies, padded by the brush. */
export function liveStrokeBounds(stroke: RecordedStroke): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of [null, ...(stroke.copies ?? [])]) {
    for (const p of stroke.points) {
      const q = m ? applyAffine(m, p.x, p.y) : p;
      if (q.x < x0) x0 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.x > x1) x1 = q.x;
      if (q.y > y1) y1 = q.y;
    }
  }
  // Particles and bristles reach past the tip (waving particles further); give them room.
  const particle = stroke.brush.engine === 'particle' ? stroke.brush.particle : null;
  const wave = particle ? Math.max(particle.waveAmplitude ?? 0, particle.kind === 'fuzzy' ? 0.12 : 0) : 0;
  const pad = stroke.brush.tip.size * (particle ? 2 + wave : 1) + 2;
  return { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), width: Math.ceil(x1 - x0 + 2 * pad), height: Math.ceil(y1 - y0 + 2 * pad) };
}
