/**
 * Brush thumbnails: a test stroke (an S-curve with pressure swelling and fading, at a steady
 * speed) painted with the brush on the paper. Brushes that only move paint (blender, smudge) are
 * shown dragged across two bands of colour. Pure TypeScript, so thumbnails render in Node too.
 */

import { BRUSH_PREVIEW_DARK_PAPER, brushPreviewsOnDark } from '../brushes/preview';
import { EMPTY_MIXER_LOAD } from '../paint/mixer';
import { emptySurface, fillRect, type TiledSurface } from '../raster/surface';
import { normalizePaintBrush, type PaintBrush } from './brushes';
import type { PenPoint } from './engine';
import { IDENTITY_COPY } from './engine';
import { hexToRgb8, type PaperSettings } from './paper';
import { createPaintCompositor, paperGrain, paperNode, type ViewLayer } from './render';
import { brushLoadForStroke, PaintStrokeSession } from './stroke';
import { WetWorld } from '../paint/wet/world';
import { pigmentOf } from '../paint/wet/film';
import { WetStrokeDriver, wetPaperInput } from './wet';
import { DEFAULT_LIGHTING, emptyThickChannels, FilmBuffer, LitCache, type ThickChannels } from './thick';
import { computeSpill, emptyLight, LightCache } from './light';
import { computeUvSpill, emptyFluor, UvCache } from './heat';
import { ScraperStrokeDriver } from './scraper';
import type { StickerArtLookup } from './sticker-art';

/** One small wet world reused for wet brush thumbnails (by size). */
let thumbWorld: WetWorld | null = null;

/** A wet brush's test stroke: laid on a wet layer (over a wet band of colour for the tools that move paint), shown as painted, before any time passes. */
function paintWetTestStroke(brush: PaintBrush, paper: PaperSettings, color: string, width: number, height: number): TiledSurface {
  if (!thumbWorld || thumbWorld.width !== width || thumbWorld.height !== height) {
    thumbWorld?.destroy();
    thumbWorld = new WetWorld(width, height, wetPaperInput(paper), { kernel: 'typescript', threads: 0 });
  } else thumbWorld.setPaper(wetPaperInput(paper));
  const w = thumbWorld;
  if (w.hasLane('thumb')) w.removeLane('thumb');
  w.ensureLane('thumb');
  const [r, g, b] = hexToRgb8(color);
  if (brush.wet.tool !== 'paint' && brush.wet.tool !== 'water') {
    // Wet paint to work in: the colour over ochre, as for the dry brushes that move paint.
    const half = Math.ceil(height / 2);
    w.paint('thumb', { x: 0, y: 0, width, height: half }, null, 0.4, Array.from(pigmentOf([r / 255, g / 255, b / 255], 0), (v) => v * 0.05));
    w.paint('thumb', { x: 0, y: half, width, height: height - half }, null, 0.4, Array.from(pigmentOf([232 / 255, 196 / 255, 64 / 255], 0), (v) => v * 0.05));
  }
  const film = brush.iridescence && brush.wet.tool === 'paint' ? new FilmBuffer(emptySurface(4, 0)) : null;
  const driver = new WetStrokeDriver({
    world: w,
    laneId: 'thumb',
    brush,
    color: [r / 255, g / 255, b / 255],
    load: brushLoadForStroke(brush, EMPTY_MIXER_LOAD, [r / 255, g / 255, b / 255]),
    grain: paperGrain(paper),
    paperDepth: paper.depth,
    paperColor: hexToRgb8(paper.color),
    seed: 7,
    copies: [IDENTITY_COPY],
    film,
  });
  driver.push(thumbnailStroke(width, height));
  driver.finish();
  // Blowing only shows once the water has moved.
  if (brush.wet.tool === 'blow') w.stepSync(4);
  const surf = w.display('thumb').surface;
  return film ? new LitCache().lit(surf, { ...emptyThickChannels(), film: film.surface() }, DEFAULT_LIGHTING) : surf;
}

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
function paintTestStroke(surface: TiledSurface, brush: PaintBrush, paper: PaperSettings, color: string, width: number, height: number, stampArt?: StickerArtLookup): { surface: TiledSurface; light: TiledSurface | null; fluor: TiledSurface | null } {
  const [r, g, b] = hexToRgb8(color);
  let result = surface;
  let thick: ThickChannels | null = null;
  let light: TiledSurface | null = null;
  let fluor: TiledSurface | null = null;
  const session = new PaintStrokeSession(
    {
      update: () => {},
      commit: (sess, s) => {
        result = s ?? result;
        thick = sess.thickChannels();
        light = sess.lightChannel();
        fluor = sess.fluorChannel();
      },
    },
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
      thick: brush.engine === 'impasto' || brush.iridescence ? { channels: emptyThickChannels() } : undefined,
      sticker: brush.engine === 'sticker' ? { nextId: 1 } : undefined,
      scraper:
        brush.engine === 'scraper'
          ? {
              driver: new ScraperStrokeDriver(
                { brush, seed: 7, copies: [IDENTITY_COPY], selection: null },
                [{ type: 'pixel', id: 'thumbnail', name: 'thumbnail', visible: true, opacity: 1, blend: 'normal', surface, offset: { x: 0, y: 0 } }],
                undefined
              ),
            }
          : undefined,
      light: brush.light.amount > 0 && brush.engine !== 'wet' && brush.engine !== 'sticker' && brush.engine !== 'antimatter' ? { surface: emptyLight() } : null,
      fluor: brush.fluorescence.amount > 0 && brush.engine !== 'wet' && brush.engine !== 'sticker' && brush.engine !== 'antimatter' ? { surface: emptyFluor() } : null,
      antimatter:
        brush.engine === 'antimatter'
          ? {
              targets: [
                {
                  id: 'thumbnail',
                  editable: true,
                  lockTransparency: false,
                  opacity: 1,
                  offset: { x: 0, y: 0 },
                  base: surface,
                  baseLight: brush.light.amount > 0 ? emptyLight() : null,
                },
              ],
            }
          : null,
      stampArt,
    }
  );
  session.push(thumbnailStroke(width, height));
  session.end();
  // Thick paint is shown lit, light paint glowing, and fluorescent paint under UV, as on the canvas.
  const lit = thick ? new LitCache().lit(result, thick, DEFAULT_LIGHTING) : result;
  const glowed = light || thick ? new LightCache().glow(lit, light ?? undefined, thick ?? undefined) : lit;
  const uvLit = fluor ? new UvCache().render(glowed, fluor, { on: true, strength: 1, ambient: 0.15 }) : glowed;
  return { surface: uvLit, light, fluor };
}

/**
 * A sample stroke with `brush` on `paper`. `stampArt` draws stamp tips of stickers and image
 * sources, and image tip grain (without it they paint round, and without the grain).
 */
export function renderBrushThumbnail(brush: PaintBrush, options: { paper: PaperSettings; width?: number; height?: number; color: string; stampArt?: StickerArtLookup }): BrushThumbnail {
  const width = Math.max(16, Math.min(512, Math.round(options.width ?? 160)));
  const height = Math.max(16, Math.min(512, Math.round(options.height ?? 48)));
  // Fit the tip in the thumbnail: big brushes are drawn smaller.
  const maxSize = height * 0.42;
  const b = brush.tip.size > maxSize ? normalizePaintBrush({ tip: { ...brush.tip, size: maxSize } }, brush) : brush;
  const rgba = [...hexToRgb8(options.color), 255];
  let surface: TiledSurface = emptySurface(4);
  if (b.engine === 'eraser' || b.engine === 'scraper') {
    // Something to erase: a band of the colour.
    surface = fillRect(surface, { x: 0, y: 0, width, height }, rgba);
  } else if (b.engine === 'wet') {
    // the wet layer draws its own band
  } else if (b.engine === 'blender' || b.engine === 'smudge' || b.engine === 'antimatter' || (b.engine === 'mixer' && !b.loadsColor) || b.behavior.pickup > 0) {
    // Something to move: two bands, the colour over ochre.
    const half = Math.ceil(height / 2);
    surface = fillRect(surface, { x: 0, y: 0, width, height: half }, rgba);
    surface = fillRect(surface, { x: 0, y: half, width, height: height - half }, [232, 196, 64, 255]);
  }
  let light: TiledSurface | null = null;
  let fluor: TiledSurface | null = null;
  if (b.engine === 'wet') surface = paintWetTestStroke(b, options.paper, options.color, width, height);
  else ({ surface, light, fluor } = paintTestStroke(surface, b, options.paper, options.color, width, height, options.stampArt));
  const layer: ViewLayer = { type: 'pixel', id: 'thumbnail', name: 'thumbnail', visible: true, opacity: 1, blend: 'normal', surface, offset: { x: 0, y: 0 } };
  // Light paint and UV-fluorescent paint read on dark paper, with their spill; a multiply light brush (a highlighter) is a tint on paper.
  const paper = (light || fluor) && brushPreviewsOnDark(b) ? { ...options.paper, color: BRUSH_PREVIEW_DARK_PAPER } : options.paper;
  const spill = light ? computeSpill(surface, light, { radius: Math.max(4, height / 6), strength: 1 }) : fluor ? computeUvSpill(fluor, 1) : null;
  const layers: ViewLayer[] = [paperNode(paper), layer];
  if (spill) layers.push({ type: 'pixel', id: 'thumbnail-light', name: 'light', visible: true, opacity: 1, blend: 'linear-dodge', surface: spill, offset: { x: 0, y: 0 } } as ViewLayer);
  const data = createPaintCompositor().composite(layers, { x: 0, y: 0, width, height }, { width, height });
  return { width, height, data };
}
