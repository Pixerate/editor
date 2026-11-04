/**
 * `createFakeStickerProvider()`: a small, deterministic sticker library for tests and demos (id
 * `fake`). Flat badges are tintable; two-colour tiles are not, and have a dark variant (a pale top
 * half); one sticker is for non-commercial use only; the weather set is AI-generated. Stickers are
 * in collections (`outdoors`, `kitchen`, `shop`) but the sketch, which is in none. Art is a
 * generated SVG and a PNG drawn to the same design, so it works in Node.
 */

import { pngDataUrl } from '../raster/png';
import { StickerError } from './errors';
import { checkStickerVariant, stickerCollections, stickerPage } from './helpers';
import type { StickerAsset, StickerDescription, StickerLoadOptions, StickerProvider, StickerSummary, StickerVariant } from './types';

export interface FakeStickerProviderOptions {
  /** Provider id (default `fake`). */
  id?: string;
  /** Delay every `load` by this many ms (to test loading states). */
  loadDelayMs?: number;
  /** Ids whose `load` rejects (to test failures). */
  failIds?: readonly string[];
}

interface FakeSticker {
  id: string;
  name: string;
  category: string;
  tags: string[];
  /** badge: a flat disc with a notch (tintable); tile: a two-colour square (not tintable). */
  shape: 'badge' | 'tile';
  colours: [string, string];
  commercial: boolean;
  collection?: string;
  aiGenerated?: boolean;
}

const CATALOGUE: FakeSticker[] = [
  ...['sun', 'moon', 'cloud', 'rain', 'snow', 'wind'].map((w, i) => ({ id: `weather-${w}`, name: w[0].toUpperCase() + w.slice(1), category: 'weather', tags: ['weather', w], shape: 'badge' as const, colours: [['#f59e0b', '#64748b', '#94a3b8', '#2563eb', '#e0f2fe', '#14b8a6'][i], '#ffffff'] as [string, string], commercial: true, collection: 'outdoors', aiGenerated: true })),
  ...['apple', 'pear', 'cherry', 'lemon', 'grape'].map((f, i) => ({ id: `fruit-${f}`, name: f[0].toUpperCase() + f.slice(1), category: 'food', tags: ['fruit', f], shape: 'tile' as const, colours: [['#dc2626', '#84cc16', '#be123c', '#facc15', '#7c3aed'][i], '#166534'] as [string, string], commercial: true, collection: 'kitchen' })),
  ...['new', 'sale', 'hot', 'free'].map((b, i) => ({ id: `badge-${b}`, name: `${b[0].toUpperCase() + b.slice(1)} badge`, category: 'badges', tags: ['badge', 'label', b], shape: 'badge' as const, colours: [['#16a34a', '#dc2626', '#ea580c', '#0891b2'][i], '#ffffff'] as [string, string], commercial: true, collection: 'shop' })),
  { id: 'art-sketch', name: 'Sketch', category: 'art', tags: ['drawing', 'non-commercial'], shape: 'tile', colours: ['#1f2937', '#fde68a'], commercial: false },
];

const COLLECTIONS: Record<string, { name: string; description: string }> = {
  outdoors: { name: 'Outdoors', description: 'Weather, AI-generated.' },
  kitchen: { name: 'Kitchen', description: 'Fruit tiles with dark variants.' },
  shop: { name: 'Shop', description: 'Tintable sale badges.' },
};
/** The top half of a tile drawn for a dark background. */
const DARK_TOP = '#f8fafc';

const W = 120;
const H = 120;

function summaryOf(s: FakeSticker): StickerSummary {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    tags: s.tags,
    description: s.shape === 'badge' ? 'A flat badge (tintable).' : 'A two-colour tile.',
    width: W,
    height: H,
    formats: ['svg', 'png'],
    licence: s.commercial ? { spdx: 'CC0-1.0', name: 'CC0 1.0', commercial: true } : { spdx: 'CC-BY-NC-4.0', name: 'CC BY-NC 4.0', attribution: 'Fake Artist', commercial: false },
    tintable: s.shape === 'badge',
    ...(s.shape === 'tile' ? { variants: ['light', 'dark'] as StickerVariant[] } : {}),
    ...(s.collection ? { collection: s.collection } : {}),
    ...(s.aiGenerated ? { aiGenerated: true } : {}),
  };
}

/** The tile's two colours for a variant: the dark one has a pale top half. */
const tileColours = (s: FakeSticker, variant: StickerVariant): [string, string] => (variant === 'dark' ? [s.colours[0], DARK_TOP] : s.colours);

/** Badge: a disc with a square notch out of its middle. Tile: a rounded square, top half in the second colour. */
function svgOf(s: FakeSticker, fill: string, variant: StickerVariant): string {
  if (s.shape === 'badge') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><path fill="${fill}" fill-rule="evenodd" d="M60 6A54 54 0 1 1 59.9 6ZM45 45H75V75H45Z"/></svg>`;
  }
  const [bottom, top] = tileColours(s, variant);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect x="10" y="10" width="100" height="100" fill="${bottom}"/><rect x="10" y="10" width="100" height="50" fill="${top}"/></svg>`;
}

function pixelsOf(s: FakeSticker, size: number, fill: string, variant: StickerVariant): Uint8ClampedArray {
  const [bottom, top] = tileColours(s, variant);
  const out = new Uint8ClampedArray(size * size * 4);
  const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * W;
      const v = ((y + 0.5) / size) * H;
      let rgb: number[] | null = null;
      if (s.shape === 'badge') {
        const inDisc = Math.hypot(u - 60, v - 60) <= 54;
        const inNotch = u >= 45 && u <= 75 && v >= 45 && v <= 75;
        if (inDisc && !inNotch) rgb = hex(fill);
      } else if (u >= 10 && u <= 110 && v >= 10 && v <= 110) rgb = hex(v < 60 ? top : bottom);
      if (!rgb) continue;
      const i = (y * size + x) * 4;
      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = 255;
    }
  }
  return out;
}

/** A deterministic sticker library for tests and demos. */
export function createFakeStickerProvider(options: FakeStickerProviderOptions = {}): StickerProvider {
  const summaries = CATALOGUE.map(summaryOf);
  const find = (id: string) => CATALOGUE.find((s) => s.id === id);
  return {
    id: options.id ?? 'fake',
    name: 'Fake stickers',
    version: '1',
    capabilities: { supportsSearch: true, supportsSvg: true, supportsRaster: true, maxSize: 512 },
    list: (o) => stickerPage(summaries, o),
    search: (q, o) => stickerPage(summaries, o, q),
    describe(id): StickerDescription | undefined {
      const s = find(id);
      if (!s) return undefined;
      return { ...summaryOf(s), silhouette: s.shape === 'badge' ? 'M60 6A54 54 0 1 1 59.9 6Z' : 'M10 10H110V110H10Z', colours: s.shape === 'badge' ? [s.colours[0]] : [...s.colours] };
    },
    collections: () => stickerCollections(summaries, COLLECTIONS),
    listCollections: () => stickerCollections(summaries, COLLECTIONS),
    categories: () => [...new Set(CATALOGUE.map((s) => s.category))].map((c) => ({ id: c, name: c, count: CATALOGUE.filter((s) => s.category === c).length })),
    async load(id, o: StickerLoadOptions = {}): Promise<StickerAsset> {
      if (options.loadDelayMs) await new Promise((r) => setTimeout(r, options.loadDelayMs));
      const s = find(id);
      if (!s) throw new StickerError('unknown_sticker', `No fake sticker "${id}".`);
      if (options.failIds?.includes(id)) throw new StickerError('load_failed', `The fake sticker "${id}" failed to load (failIds).`);
      const variant = checkStickerVariant(summaryOf(s), o.variant);
      const fill = s.shape === 'badge' && o.colour ? o.colour.toLowerCase() : s.colours[0];
      if (o.format === 'png') {
        const size = o.size ?? 128;
        if (!(Number.isInteger(size) && size >= 8 && size <= 512)) throw new StickerError('invalid_argument', `size must be 8..512 px, got ${size}.`);
        return { kind: 'image', url: pngDataUrl(size, size, pixelsOf(s, size, fill, variant)), width: size, height: size };
      }
      return { kind: 'svg', svg: svgOf(s, fill, variant) };
    },
  };
}
