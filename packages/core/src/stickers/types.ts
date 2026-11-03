/**
 * The sticker provider contract: how an editor finds, describes and loads stickers from a library
 * it knows nothing about (the editor's own stamps, a brand pack, user uploads, a third-party API).
 * Libraries implement it structurally, like `EffectProvider` and `FontProvider`.
 *
 * Ids are the provider's own; a `StickerRef` (`provider:id`) names a sticker across providers
 * (`combineStickerProviders` lists them that way).
 */

export type MaybePromise<T> = T | Promise<T>;

/** How a sticker's art may be used. Every sticker says. */
export interface StickerLicence {
  /** SPDX id when there is one (`MIT`, `CC-BY-4.0`). */
  spdx?: string;
  /** Human-readable name. */
  name: string;
  /** Credit line the licence asks for. */
  attribution?: string;
  url?: string;
  /** May be used commercially. */
  commercial: boolean;
}

export type StickerFormat = 'svg' | 'png';

/** A sticker in a list or search result. */
export interface StickerSummary {
  /** The provider's id (no `:` needed; `combineStickerProviders` prefixes its own). */
  id: string;
  name: string;
  category: string;
  tags?: string[];
  description?: string;
  /** Natural size in px, for layout before the art is loaded. */
  width: number;
  height: number;
  /** A small `data:` or `https:` image. */
  thumbnail?: string;
  /** The formats `load` can return. */
  formats: StickerFormat[];
  licence: StickerLicence;
  /** Flat, single-colour art: `load(id, { colour })` recolours it (the paint editor's spray colours it). */
  tintable: boolean;
}

/** Everything about one sticker. */
export interface StickerDescription extends StickerSummary {
  /** SVG path data of its outline, in its natural box (for die-cut treatments). */
  silhouette?: string;
  /** Dominant colours #rrggbb, for matching and recolouring. */
  colours?: string[];
  variants?: { id: string; name: string }[];
}

/** A sticker's art. */
export type StickerAsset =
  | { kind: 'svg'; svg: string; silhouette?: string }
  /** `url`: a `data:` or `https:` image. */
  | { kind: 'image'; url: string; width: number; height: number };

/** One page of results. Pages stay small; follow `next` (pass it as `after`). */
export interface StickerPage {
  items: StickerSummary[];
  /** How many match in all. */
  total: number;
  next?: string;
}

export interface StickerSearchOptions {
  category?: string;
  /** Every tag must match. */
  tags?: string[];
  /** Page size (providers cap it; 1..100, default 24). */
  limit?: number;
  /** `next` from the previous page. */
  after?: string;
  licence?: { commercial?: boolean };
}

export interface StickerLoadOptions {
  format?: StickerFormat;
  /** Longest side in px for raster art. */
  size?: number;
  /** #rrggbb: recolour a tintable sticker. */
  colour?: string;
}

export interface StickerProviderCapabilities {
  supportsSearch: boolean;
  supportsSvg: boolean;
  supportsRaster: boolean;
  /** The largest raster `size` it loads. */
  maxSize?: number;
}

export interface StickerProvider {
  /** Short and unique among the providers an editor uses: `editor`, `acme-brand`, `uploads`. */
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly capabilities: StickerProviderCapabilities;
  /** Its ids are already refs (`provider:id`): a combination of providers (`combineStickerProviders`). */
  readonly namespaced?: boolean;
  /** The stickers, a page at a time; `category` and `tags` filter. */
  list(options?: StickerSearchOptions): MaybePromise<StickerPage>;
  /** Stickers matching words in their name, tags, category or description; `""` is `list`. */
  search(query: string, options?: StickerSearchOptions): MaybePromise<StickerPage>;
  /** A sticker by id, or `undefined`. */
  describe(id: string): MaybePromise<StickerDescription | undefined>;
  /** The art; rejects with a `StickerError` (`unknown_sticker`, `unsupported_format`) when it can't. */
  load(id: string, options?: StickerLoadOptions): MaybePromise<StickerAsset>;
  /** Categories with counts, when the provider knows them. */
  categories?(): MaybePromise<Array<{ id: string; name: string; count: number }>>;
}

/** `provider:id`, the name of a sticker across providers. A bare editor stamp (`"star"`) means `editor:star`. */
export type StickerRef = string;
