/**
 * Compositing for the paint editor, on the shared `RasterCompositor`: the paper is a content layer
 * at the bottom of the stack (its tiles are generated from the paper settings), and view-only
 * layers (the tracing image) sit between it and the paint. No compositor of our own.
 */

import { RasterCompositor, type CompositorLayer, type CompositorProfile, type RasterSources } from '../raster/compositor';
import type { RasterRect } from '../raster/surface';
import type { PaintLayer } from './document';
import { PaperGrain, renderPaper, type PaperSettings } from './paper';

/** The paper as a layer of the compositor (generated, never stored). */
export interface PaperNode extends CompositorLayer {
  type: 'paper';
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: 'normal';
  paper: PaperSettings;
  /** The light, for metallic paper. */
  light?: { azimuth: number; elevation: number };
}

/** An RGBA image under the paint (the tracing image, effect paper), drawn at its opacity and blend. */
export interface ImageNode extends CompositorLayer {
  type: 'image';
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: string;
  /** Canvas-sized RGBA. */
  image: { width: number; height: number; data: Uint8ClampedArray };
  /** Changes when the pixels change. */
  version: number;
}

export type ViewLayer = PaintLayer | PaperNode | ImageNode;

export const PAPER_NODE_ID = '__paper';
export const TRACING_NODE_ID = '__tracing';
export const PAPER_EFFECT_NODE_ID = '__paper_effect';

export function paperKey(p: PaperSettings, light?: { azimuth: number; elevation: number }): string {
  const metal = p.metallic ?? 0;
  return JSON.stringify([p.pattern, p.seed, p.color, p.scale, p.tiling, p.shading, p.dry, p.offset ?? null, metal, metal > 0 && light ? [light.azimuth, light.elevation] : null]);
}

const paperNodes = new WeakMap<PaperSettings, PaperNode>();

/** The paper as a compositor layer (one object per paper settings object and light, so caches hold). */
export function paperNode(paper: PaperSettings, light?: { azimuth: number; elevation: number }): PaperNode {
  let n = paperNodes.get(paper);
  const metal = (paper.metallic ?? 0) > 0;
  if (!n || (metal && (n.light?.azimuth !== light?.azimuth || n.light?.elevation !== light?.elevation))) {
    n = { type: 'paper', id: PAPER_NODE_ID, name: 'Paper', visible: true, opacity: 1, blend: 'normal', paper, ...(metal && light ? { light: { azimuth: light.azimuth, elevation: light.elevation } } : {}) };
    paperNodes.set(paper, n);
  }
  return n;
}

const grainCache = new Map<string, PaperGrain>();
const tileCache = new Map<string, Uint8ClampedArray>();

/** The paper's dry height field, built once per settings. */
export function paperGrain(paper: PaperSettings): PaperGrain {
  const key = JSON.stringify([paper.pattern, paper.seed, paper.scale, paper.tiling, paper.dry, paper.offset ?? null]);
  let g = grainCache.get(key);
  if (!g) {
    g = new PaperGrain(paper, 'dry');
    if (grainCache.size > 16) grainCache.delete(grainCache.keys().next().value as string);
    grainCache.set(key, g);
  }
  return g;
}

function paperTile(paper: PaperSettings, r: RasterRect, light?: { azimuth: number; elevation: number }): Uint8ClampedArray {
  const key = `${paperKey(paper, light)}|${r.x},${r.y},${r.width},${r.height}`;
  let t = tileCache.get(key);
  if (!t) {
    t = renderPaper(paper, r, paperGrain(paper), light);
    if (tileCache.size > 512) tileCache.delete(tileCache.keys().next().value as string);
    tileCache.set(key, t);
  }
  return t;
}

const PROFILE: CompositorProfile<ViewLayer, RasterSources> = {
  contentTile(layer, r) {
    if (layer.type === 'paper') return paperTile((layer as PaperNode).paper, r, (layer as PaperNode).light);
    if (layer.type === 'image') {
      const { image } = layer as ImageNode;
      const out = new Uint8ClampedArray(r.width * r.height * 4);
      const x0 = Math.max(0, r.x);
      const y0 = Math.max(0, r.y);
      const x1 = Math.min(image.width, r.x + r.width);
      const y1 = Math.min(image.height, r.y + r.height);
      if (x1 <= x0 || y1 <= y0) return null;
      for (let y = y0; y < y1; y++) out.set(image.data.subarray((y * image.width + x0) * 4, (y * image.width + x1) * 4), ((y - r.y) * r.width + (x0 - r.x)) * 4);
      return out;
    }
    return null;
  },
  layerKey(layer) {
    if (layer.type === 'paper') return paperKey((layer as PaperNode).paper, (layer as PaperNode).light);
    if (layer.type === 'image') return (layer as ImageNode).version;
    return undefined;
  },
};

/** A compositor for paint editor stacks (paper and view-only images included). */
export function createPaintCompositor(): RasterCompositor<ViewLayer, RasterSources> {
  return new RasterCompositor<ViewLayer, RasterSources>(PROFILE);
}

/**
 * Area-averaged downscale of straight-alpha RGBA (colours weighted by alpha). Sizes at or above
 * the source copy it.
 */
export function downsampleRgba(data: ArrayLike<number>, width: number, height: number, tw: number, th: number): Uint8ClampedArray {
  tw = Math.max(1, Math.round(tw));
  th = Math.max(1, Math.round(th));
  if (tw >= width && th >= height) return Uint8ClampedArray.from(data as ArrayLike<number>);
  const out = new Uint8ClampedArray(tw * th * 4);
  const sx = width / tw;
  const sy = height / th;
  for (let y = 0; y < th; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < tw; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let w = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1) && yy < height; yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1) && xx < width; xx++) {
          const wgt = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
          const i = (yy * width + xx) * 4;
          const al = data[i + 3] * wgt;
          r += data[i] * al;
          g += data[i + 1] * al;
          b += data[i + 2] * al;
          a += al;
          w += wgt;
        }
      }
      const o = (y * tw + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = w > 0 ? a / w : 0;
    }
  }
  return out;
}
