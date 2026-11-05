/**
 * Brush sources the paint engine can draw with: the brush library's and the open painting's, by
 * id. Strokes read them synchronously, as they read sticker art (`StickerArtLookup`): a stamp tip
 * `source:<id>` and an image tip grain both take the source's mask as alpha. Each mask is decoded
 * the first time it is drawn.
 */

import { brushSourceIdOf, decodeBrushSource, isBrushSourceRef, type BrushSource } from '../brushes/sources';
import type { StickerArt, StickerArtLookup } from './sticker-art';

export class BrushSourceArtCache {
  private readonly sources = new Map<string, BrushSource>();
  private readonly art = new Map<string, StickerArt | null>();

  /** Adds or replaces sources (a replaced image is decoded again). */
  set(sources: Iterable<BrushSource>): void {
    for (const s of sources) {
      const was = this.sources.get(s.id);
      if (was && was.image === s.image) continue;
      this.sources.set(s.id, s);
      this.art.delete(s.id);
    }
  }

  /** The source of an id, if known. */
  source(id: string): BrushSource | undefined {
    return this.sources.get(id);
  }

  /** Every known source. */
  all(): BrushSource[] {
    return [...this.sources.values()];
  }

  /** The art of a `source:<id>` ref (alpha = the mask), or `undefined` when the source is unknown or its image can't be read. */
  get: StickerArtLookup = (ref) => {
    const id = brushSourceIdOf(ref);
    if (id === null) return undefined;
    if (this.art.has(id)) return this.art.get(id) ?? undefined;
    const source = this.sources.get(id);
    if (!source) return undefined;
    let art: StickerArt | null = null;
    try {
      const { width, height, mask } = decodeBrushSource(source);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < mask.length; i++) {
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = 255;
        data[i * 4 + 3] = mask[i];
      }
      art = { width, height, data, tintable: true };
    } catch {
      art = null;
    }
    this.art.set(id, art);
    return art ?? undefined;
  };

  /** A lookup that reads sources from here and every other ref from `stickers`. */
  with(stickers: StickerArtLookup): StickerArtLookup {
    return (ref, variant) => (isBrushSourceRef(ref) ? this.get(ref) : stickers(ref, variant));
  }
}

/** The ids of the sources an engine brush draws with: its stamp tip, its tip grain and its particle stamps. */
export function engineBrushSourceIds(brush: { stamp: string | null; tipGrain?: { source: string }; particle?: { dotTextures: readonly string[] } }): string[] {
  const refs = [brush.stamp, brush.tipGrain?.source, ...(brush.particle?.dotTextures ?? [])];
  return [...new Set(refs.filter((r): r is string => !!r && isBrushSourceRef(r)).map((r) => brushSourceIdOf(r)!))];
}
