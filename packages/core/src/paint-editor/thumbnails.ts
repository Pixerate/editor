/**
 * Brush thumbnails: a test stroke (an S-curve with pressure swelling and fading, at a steady
 * speed) painted with the brush on the paper. Brushes that only move paint (blender, smudge) are
 * shown dragged across two bands of colour. Pure TypeScript, so thumbnails render in Node too.
 */

import { EMPTY_MIXER_LOAD } from '../paint/mixer';
import { emptySurface, fillRect, type TiledSurface } from '../raster/surface';
import { normalizePaintBrush, type PaintBrush } from './brushes';
import type { PenPoint } from './engine';
import { IDENTITY_COPY } from './engine';
import { hexToRgb8, type PaperSettings } from './paper';
import { createPaintCompositor, paperGrain, paperNode, type ViewLayer } from './render';
import { brushLoadForStroke, PaintStrokeSession } from './stroke';

export interface BrushThumbnail {
  width: number;
  height: number;
  /** RGBA, opaque (the paper is under the stroke). */
  data: Uint8ClampedArray;
}

/** The test stroke's samples for a `width × height` thumbnail. */
export function thumbnailStroke(width: number, height: number): PenPoint[] {
  const pts: PenPoint[] = [];
  const n = 64;
  const mx = width * 0.1;
  const my = height * 0.5;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const pressure = t < 0.5 ? 0.15 + 1.7 * t : 1 - 1.4 * (t - 0.5);
    pts.push({ x: mx + (width - 2 * mx) * t, y: my - Math.sin(t * Math.PI * 2) * height * 0.22, pressure, t: i * 12 });
  }
  return pts;
}

/** Paints the test stroke with `brush` onto `surface`; returns the new pixels. */
function paintTestStroke(surface: TiledSurface, brush: PaintBrush, paper: PaperSettings, color: string, width: number, height: number): TiledSurface {
  const [r, g, b] = hexToRgb8(color);
  let result = surface;
  const session = new PaintStrokeSession(
    { update: () => {}, commit: (_s, s) => (result = s ?? result) },
    {
      layerId: 'thumbnail',
      surface,
      offset: { x: 0, y: 0 },
      lockTransparency: false,
      brush,
      color: [r, g, b, 255],
      background: [...hexToRgb8(paper.color), 255],
      grain: paperGrain(paper),
      paperDepth: paper.depth,
      seed: 7,
      colorHex: color,
      affineCopies: [],
      copies: [IDENTITY_COPY],
      mixerLoad: brushLoadForStroke(brush, EMPTY_MIXER_LOAD, [r / 255, g / 255, b / 255]),
    }
  );
  session.push(thumbnailStroke(width, height));
  session.end();
  return result;
}

export function renderBrushThumbnail(brush: PaintBrush, options: { paper: PaperSettings; width?: number; height?: number; color: string }): BrushThumbnail {
  const width = Math.max(16, Math.min(512, Math.round(options.width ?? 160)));
  const height = Math.max(16, Math.min(512, Math.round(options.height ?? 48)));
  // Fit the tip in the thumbnail: big brushes are drawn smaller.
  const maxSize = height * 0.42;
  const b = brush.tip.size > maxSize ? normalizePaintBrush({ tip: { ...brush.tip, size: maxSize } }, brush) : brush;
  const rgba = [...hexToRgb8(options.color), 255];
  let surface: TiledSurface = emptySurface(4);
  if (b.engine === 'eraser') {
    // Something to erase: a band of the colour.
    surface = fillRect(surface, { x: 0, y: 0, width, height }, rgba);
  } else if (b.engine === 'blender' || b.engine === 'smudge' || (b.engine === 'mixer' && !b.loadsColor) || b.behavior.pickup > 0) {
    // Something to move: two bands, the colour over ochre.
    const half = Math.ceil(height / 2);
    surface = fillRect(surface, { x: 0, y: 0, width, height: half }, rgba);
    surface = fillRect(surface, { x: 0, y: half, width, height: height - half }, [232, 196, 64, 255]);
  }
  surface = paintTestStroke(surface, b, options.paper, options.color, width, height);
  const layer: ViewLayer = { type: 'pixel', id: 'thumbnail', name: 'thumbnail', visible: true, opacity: 1, blend: 'normal', surface, offset: { x: 0, y: 0 } };
  const data = createPaintCompositor().composite([paperNode(options.paper), layer], { x: 0, y: 0, width, height }, { width, height });
  return { width, height, data };
}
