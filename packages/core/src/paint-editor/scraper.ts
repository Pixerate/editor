/**
 * Scraper brush engine (`marks.kind: 'scraper'`, preset `paint-scraper`): cuts down through the
 * paint stack layer by layer. Each dab removes alpha and thick height from the topmost visible
 * pixel layer and carries any depth left over into the layer below, stopping at locked layers or
 * the paper.
 */

import { dabRect, rasterizeDab } from '../paint/brush';
import { findLayer, isLayerLocked, mapLayer } from '../raster/layers';
import {
  TILE,
  TiledSurface,
  finishTile,
  tileKeyIn,
  type RasterRect,
  type Tile,
  type TileKey,
} from '../raster/surface';
import type { PaintBrush } from './brushes';
import type { PaintDocumentState, PaintLayer, PaintPixelLayer } from './document';
import { IDENTITY_COPY, PenDabWalker, PenSmoother, type PenDab, type PenPoint, type StrokeCopy } from './engine';
import { emptyThickChannels, hasThickChannels, type ThickChannels } from './thick';

export interface ScraperSelectionMask {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface ScraperStrokeInit {
  brush: PaintBrush;
  seed: number;
  copies: readonly StrokeCopy[];
  selection: ScraperSelectionMask | null;
  inputFilter?: (p: PenPoint) => PenPoint;
}

interface LayerScratch {
  layer: PaintPixelLayer;
  colorTiles: Map<TileKey, Uint8ClampedArray>;
  heightTiles: Map<TileKey, Uint8ClampedArray>;
  baseThick: ThickChannels;
  touched: boolean;
}

function expandTile(t: Tile, channels: 1 | 4): Uint8ClampedArray {
  if (t.data.length === TILE * TILE * channels) return t.data;
  const out = new Uint8ClampedArray(TILE * TILE * channels);
  const u = t.uniform ?? 0;
  if (channels === 1) out.fill(u & 255);
  else {
    const bytes = [(u >>> 24) & 255, (u >>> 16) & 255, (u >>> 8) & 255, u & 255];
    for (let i = 0; i < out.length; i += 4) out.set(bytes, i);
  }
  return out;
}

function unionRects(a: RasterRect | null, b: RasterRect): RasterRect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Collects the top-to-bottom stack of visible pixel layers that a scraper stroke can cut through,
 * stopping as soon as it meets a locked layer (or stroke / sticker layer) or the paper.
 */
export function collectScrapeableLayers(doc: PaintDocumentState): {
  layers: PaintPixelLayer[];
  stoppedAtLocked: PaintLayer | null;
} {
  const result: PaintPixelLayer[] = [];
  let stoppedAtLocked: PaintLayer | null = null;

  const isLocked = (l: PaintLayer): boolean =>
    isLayerLocked(l, 'all') ||
    isLayerLocked(l, 'pixels') ||
    isLayerLocked(l, 'transparency');

  const walk = (list: readonly PaintLayer[]): boolean => {
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      if (!l.visible) continue;
      if (isLocked(l)) {
        stoppedAtLocked = l;
        return false;
      }
      if (l.type === 'group') {
        if (!walk(l.children)) return false;
      } else if (l.type === 'pixel') {
        if (doc.liveStrokes?.[l.id] || (doc.stickers?.[l.id]?.length ?? 0) > 0) {
          stoppedAtLocked = l;
          return false;
        }
        result.push(l);
      }
    }
    return true;
  };

  walk(doc.layers);
  return { layers: result, stoppedAtLocked };
}

/**
 * The pixel layers a recorded scraper stroke cut through (`RecordedStroke.scrapeLayerIds`, top to
 * bottom), as they are in `doc`. Replays use these instead of `collectScrapeableLayers`, so a
 * replay that shows and unlocks every layer cuts only what the live stroke cut. Ids that are gone
 * or no longer plain pixel layers are skipped.
 */
export function scrapeLayersByIds(doc: PaintDocumentState, ids: readonly string[]): PaintPixelLayer[] {
  const out: PaintPixelLayer[] = [];
  for (const id of ids) {
    const l = findLayer(doc.layers, id)?.layer;
    if (!l || l.type !== 'pixel' || doc.liveStrokes?.[l.id] || (doc.stickers?.[l.id]?.length ?? 0) > 0) continue;
    out.push(l);
  }
  return out;
}

/** Driver that scrapes through `doc`'s visible unlocked pixel layers from top to bottom. */
export class ScraperStrokeDriver {
  dabCount = 0;
  private readonly smoother: PenSmoother;
  private readonly walkers: PenDabWalker[];
  private readonly copies: readonly StrokeCopy[];
  private readonly stack: LayerScratch[];
  private lastRaw: PenPoint | null = null;
  private lastFed: PenPoint | null = null;
  bounds: RasterRect | null = null;
  /** The layers this stroke cuts through, top to bottom (recorded with the stroke). */
  readonly layerIds: readonly string[];

  constructor(
    readonly init: ScraperStrokeInit,
    scrapeLayers: readonly PaintPixelLayer[],
    thickMap?: PaintDocumentState['thick']
  ) {
    const b = init.brush;
    this.smoother = new PenSmoother(b.tip.smoothing, b.pressureSmoothing);
    this.copies = init.copies.length ? init.copies : [IDENTITY_COPY];
    this.walkers = this.copies.map(
      (c, k) => new PenDabWalker(b, (init.seed + k * 7919) | 0, c.linear)
    );
    this.layerIds = scrapeLayers.map((l) => l.id);
    this.stack = scrapeLayers.map((layer) => ({
      layer,
      colorTiles: new Map(),
      heightTiles: new Map(),
      baseThick: thickMap?.[layer.id] ?? emptyThickChannels(),
      touched: false,
    }));
  }

  push(points: readonly PenPoint[]): RasterRect[] {
    const rects: RasterRect[] = [];
    for (const rawIn of points) {
      const raw = this.init.inputFilter ? this.init.inputFilter(rawIn) : rawIn;
      this.lastRaw = raw;
      const p = this.smoother.push(raw);
      this.lastFed = p;
      for (let k = 0; k < this.copies.length; k++) {
        const dabs: PenDab[] = [];
        this.walkers[k].push(this.copies[k].map(p), dabs);
        this.applyDabs(dabs, rects);
      }
    }
    return rects;
  }

  finish(): RasterRect[] {
    const rects: RasterRect[] = [];
    for (let k = 0; k < this.copies.length; k++) {
      const dabs: PenDab[] = [];
      if (this.lastRaw && this.lastFed && (this.lastRaw.x !== this.lastFed.x || this.lastRaw.y !== this.lastFed.y)) {
        this.walkers[k].push(this.copies[k].map({ ...this.lastRaw, pressure: this.lastFed.pressure }), dabs);
      }
      this.walkers[k].finish(dabs);
      this.applyDabs(dabs, rects);
    }
    return rects;
  }

  private applyDabs(dabs: readonly PenDab[], rects: RasterRect[]): void {
    const hardness = Math.max(this.init.brush.tip.hardness, this.init.brush.scraper.sharpness);
    for (const d of dabs) {
      const rect = dabRect(d, hardness);
      if (rect.width <= 0 || rect.height <= 0) continue;
      this.dab(d, rect, hardness);
      rects.push(rect);
      this.bounds = unionRects(this.bounds, rect);
      this.dabCount++;
    }
  }

  private getColorTile(entry: LayerScratch, key: TileKey, write: boolean): Uint8ClampedArray | null {
    const existing = entry.colorTiles.get(key);
    if (existing) return existing;
    const base = entry.layer.surface.tiles.get(key);
    if (!base) return null;
    const expanded = expandTile(base, 4);
    if (!write) return expanded;
    const copy = new Uint8ClampedArray(expanded);
    entry.colorTiles.set(key, copy);
    entry.touched = true;
    return copy;
  }

  private getHeightTile(entry: LayerScratch, key: TileKey, write: boolean): Uint8ClampedArray | null {
    const existing = entry.heightTiles.get(key);
    if (existing) return existing;
    const base = entry.baseThick.height.tiles.get(key);
    if (!base) return null;
    const expanded = expandTile(base, 1);
    if (!write) return expanded;
    const copy = new Uint8ClampedArray(expanded);
    entry.heightTiles.set(key, copy);
    entry.touched = true;
    return copy;
  }

  private dab(d: PenDab, rect: RasterRect, hardness: number): void {
    if (this.stack.length === 0) return;
    const b = this.init.brush;
    const depth = b.scraper.depth;
    const sharpness = b.scraper.sharpness;
    const dabOpacity = Math.min(1, d.alpha * d.opacity * b.tip.opacity);
    if (depth <= 0 || dabOpacity <= 0) return;

    const n = rect.width * rect.height;
    const tip = new Float32Array(n);
    rasterizeDab({ ...d, alpha: 1 }, hardness, rect, tip);
    const sel = this.init.selection;
    const edge = Math.max(0.08, 1 - 0.88 * sharpness);

    let p = 0;
    for (let yy = 0; yy < rect.height; yy++) {
      const wy = rect.y + yy;
      for (let xx = 0; xx < rect.width; xx++, p++) {
        let cov = tip[p];
        if (cov <= 0) continue;
        const wx = rect.x + xx;
        if (sel) {
          const m = wx >= 0 && wy >= 0 && wx < sel.width && wy < sel.height ? sel.data[wy * sel.width + wx] / 255 : 0;
          cov *= m;
          if (cov <= 0) continue;
        }
        const shaped = Math.min(1, cov / edge);
        let rem = shaped * dabOpacity * depth;
        if (rem <= 1e-6) continue;

        for (let k = 0; k < this.stack.length && rem > 1e-6; k++) {
          const entry = this.stack[k];
          const lx = wx - entry.layer.offset.x;
          const ly = wy - entry.layer.offset.y;
          // Past the surface range there is no tile to scrape (NO_TILE_KEY finds none).
          const key = tileKeyIn(Math.floor(lx / TILE), Math.floor(ly / TILE));
          const cRead = this.getColorTile(entry, key, false);
          const hRead = this.getHeightTile(entry, key, false);
          if (!cRead && !hRead) continue;
          const pi = (ly & 255) * TILE + (lx & 255);
          const a0 = cRead ? cRead[pi * 4 + 3] / 255 : 0;
          const h0 = hRead ? hRead[pi] / 255 : 0;
          if (a0 <= 0 && h0 <= 0) continue;

          const present = Math.max(a0, h0);
          const take = Math.min(present, rem);
          rem -= take;
          const keep = present > 0 ? Math.max(0, (present - take) / present) : 0;

          if (a0 > 0) {
            const cWrite = this.getColorTile(entry, key, true)!;
            const idx = pi * 4;
            const a1 = Math.round(a0 * 255 * keep);
            cWrite[idx + 3] = a1;
            if (a1 === 0) {
              cWrite[idx] = 0;
              cWrite[idx + 1] = 0;
              cWrite[idx + 2] = 0;
            }
          }
          if (h0 > 0) {
            const hWrite = this.getHeightTile(entry, key, true)!;
            hWrite[pi] = Math.round(h0 * 255 * keep);
          }
        }
      }
    }
  }

  get hasChanges(): boolean {
    return this.stack.some((e) => e.touched);
  }

  /** Live surfaces of all touched layers during an active stroke. */
  liveSurfaces(): Map<string, TiledSurface> {
    const out = new Map<string, TiledSurface>();
    for (const entry of this.stack) {
      if (!entry.touched || entry.colorTiles.size === 0) continue;
      const tiles = new Map<TileKey, Tile>(entry.layer.surface.tiles);
      for (const [k, data] of entry.colorTiles) {
        tiles.set(k, { data: new Uint8ClampedArray(data), uniform: null });
      }
      out.set(entry.layer.id, new TiledSurface(4, tiles, 0));
    }
    return out;
  }

  /** Builds the updated document state after the scraper stroke. */
  commitToDocument(baseDoc: PaintDocumentState): {
    doc: PaintDocumentState;
    bounds: RasterRect | null;
    scrapedLayerIds: string[];
  } {
    let layers = baseDoc.layers;
    const nextThick: Record<string, ThickChannels> = { ...(baseDoc.thick ?? {}) };
    const scrapedLayerIds: string[] = [];

    for (const entry of this.stack) {
      if (!entry.touched) continue;
      scrapedLayerIds.push(entry.layer.id);
      if (entry.colorTiles.size > 0) {
        const tiles = new Map<TileKey, Tile>(entry.layer.surface.tiles);
        for (const [k, data] of entry.colorTiles) {
          const finished = finishTile(data, 4, 0);
          if (finished) tiles.set(k, finished);
          else tiles.delete(k);
        }
        const surface = new TiledSurface(4, tiles, 0);
        layers = mapLayer(layers, entry.layer.id, (l) => ({ ...(l as PaintPixelLayer), surface }));
      }
      if (entry.heightTiles.size > 0) {
        const hTiles = new Map<TileKey, Tile>(entry.baseThick.height.tiles);
        for (const [k, data] of entry.heightTiles) {
          const finished = finishTile(data, 1, 0);
          if (finished) hTiles.set(k, finished);
          else hTiles.delete(k);
        }
        const ch: ThickChannels = {
          height: new TiledSurface(1, hTiles, 0),
          material: entry.baseThick.material,
          film: entry.baseThick.film,
        };
        if (hasThickChannels(ch)) nextThick[entry.layer.id] = ch;
        else delete nextThick[entry.layer.id];
      }
    }

    if (scrapedLayerIds.length === 0) {
      return { doc: baseDoc, bounds: this.bounds, scrapedLayerIds };
    }
    return {
      doc: {
        ...baseDoc,
        layers,
        thick: Object.keys(nextThick).length ? nextThick : undefined,
      },
      bounds: this.bounds,
      scrapedLayerIds,
    };
  }
}
