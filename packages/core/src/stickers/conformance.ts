import { providerCollections } from './helpers';
import type { StickerProvider, StickerSummary } from './types';

export interface StickerConformanceIssue {
  /** The sticker it is about, when it is about one. */
  stickerId?: string;
  message: string;
}

export interface StickerConformanceOptions {
  /** Stop walking pages after this many (default 50). */
  maxPages?: number;
  /** Load at most this many stickers in each format (default 3). */
  loads?: number;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function checkSummary(s: StickerSummary, provider: StickerProvider, issues: StickerConformanceIssue[]): void {
  const at = (message: string) => issues.push({ stickerId: s.id, message });
  if (typeof s.id !== 'string' || !s.id) at('id is missing');
  if (!provider.namespaced && s.id.includes(':')) at('id contains ":" (refs are provider:id; only a combined provider lists refs)');
  if (typeof s.name !== 'string' || !s.name) at('name is missing');
  if (typeof s.category !== 'string' || !s.category) at('category is missing');
  if (!(s.width > 0 && s.height > 0)) at(`width and height must be positive, got ${s.width} × ${s.height}`);
  if (!Array.isArray(s.formats) || !s.formats.length || s.formats.some((f) => f !== 'svg' && f !== 'png')) at('formats must list svg and / or png');
  if (s.formats?.includes('svg') && !provider.capabilities.supportsSvg) at('lists svg but capabilities.supportsSvg is false');
  if (s.formats?.includes('png') && !provider.capabilities.supportsRaster) at('lists png but capabilities.supportsRaster is false');
  if (!s.licence || typeof s.licence.name !== 'string' || !s.licence.name) at('licence.name is missing (every sticker says how it may be used)');
  if (typeof s.licence?.commercial !== 'boolean') at('licence.commercial is not a boolean');
  if (typeof s.tintable !== 'boolean') at('tintable is not a boolean');
  if (s.thumbnail !== undefined && !/^(data:|https:)/.test(s.thumbnail)) at('thumbnail must be a data: or https: URL');
  if (s.aiGenerated !== undefined && typeof s.aiGenerated !== 'boolean') at('aiGenerated must be a boolean when present');
  if (s.variants !== undefined) {
    const v = s.variants as unknown;
    if (!Array.isArray(v) || v.some((x) => x !== 'light' && x !== 'dark') || new Set(v).size !== v.length) at('variants must list light and / or dark, each once');
    else if (!v.includes('light')) at('variants must include light (every sticker has its light art)');
  }
  if (s.collection !== undefined && (typeof s.collection !== 'string' || !s.collection)) at('collection must be a non-empty string when present');
  if (s.collection !== undefined && !provider.collections && !provider.listCollections) at(`is in collection "${s.collection}" but the provider has no collections()`);
}

/**
 * Checks a sticker provider against the contract: capabilities, every listed sticker (walking the
 * pages), search and list agreeing, paging limits, describe and load for known and unknown ids,
 * collections, light / dark variants and tinting. Returns the problems found (empty when it conforms).
 */
export async function checkStickerProvider(provider: StickerProvider, options: StickerConformanceOptions = {}): Promise<StickerConformanceIssue[]> {
  const issues: StickerConformanceIssue[] = [];
  const top = (message: string) => issues.push({ message });
  if (typeof provider.id !== 'string' || !provider.id) top('provider has no id');
  else if (provider.id.includes(':')) top('provider id contains ":"');
  if (typeof provider.name !== 'string' || !provider.name) top('provider has no name');
  const caps = provider.capabilities;
  for (const k of ['supportsSearch', 'supportsSvg', 'supportsRaster'] as const) if (typeof caps?.[k] !== 'boolean') top(`capabilities.${k} is not a boolean`);
  if (caps?.maxSize !== undefined && !(caps.maxSize > 0)) top('capabilities.maxSize must be positive');

  const all: StickerSummary[] = [];
  const ids = new Set<string>();
  let after: string | undefined;
  let total = -1;
  for (let n = 0; n < (options.maxPages ?? 50); n++) {
    let page;
    try {
      page = await provider.list({ limit: 10, ...(after ? { after } : {}) });
    } catch (e) {
      top(`list() rejected: ${(e as Error).message}`);
      break;
    }
    if (!Array.isArray(page?.items) || typeof page.total !== 'number') {
      top('list() did not return { items, total }');
      break;
    }
    if (page.items.length > 10) top(`list({ limit: 10 }) returned ${page.items.length} stickers`);
    if (total === -1) total = page.total;
    for (const s of page.items) {
      if (ids.has(s.id)) top(`duplicate id "${s.id}"`);
      ids.add(s.id);
      all.push(s);
      checkSummary(s, provider, issues);
    }
    if (!page.next) break;
    if (!page.items.length) {
      top('list() returned an empty page with a next cursor');
      break;
    }
    after = page.next;
  }
  if (total !== -1 && all.length !== total) top(`list() pages hold ${all.length} stickers but total says ${total}`);
  try {
    const found = await provider.search('', { limit: 1 });
    if (found.total !== total) top(`search("") total ${found.total} differs from list() total ${total}`);
  } catch (e) {
    top(`search("") rejected: ${(e as Error).message}`);
  }
  const first = all[0];
  if (first) {
    const byCategory = await provider.list({ category: first.category, limit: 100 });
    if (byCategory.items.some((s) => s.category !== first.category)) top(`list({ category: "${first.category}" }) returned stickers of other categories`);
    const d = await provider.describe(first.id);
    if (!d) top(`describe("${first.id}") returned nothing for a listed sticker`);
    else if (d.id !== first.id) top(`describe("${first.id}") returned id "${d.id}"`);
    if (d?.colours?.some((c) => !HEX.test(c))) top(`describe("${first.id}").colours must be #rrggbb`);
  }
  if ((await provider.describe('__no_such_sticker__')) !== undefined) top('describe of an unknown id returned a sticker');
  if (provider.collections || provider.listCollections) {
    try {
      const collections = (await providerCollections(provider)) ?? [];
      const known = new Set<string>();
      for (const c of collections) {
        if (typeof c?.id !== 'string' || !c.id || typeof c.name !== 'string' || !c.name || !(Number.isInteger(c.count) && c.count >= 0)) {
          top(`collections() returned ${JSON.stringify(c)}; each needs id, name and a count`);
          continue;
        }
        if (known.has(c.id)) top(`collections() lists "${c.id}" twice`);
        known.add(c.id);
        const page = await provider.list({ collection: c.id, limit: 100 });
        if (page.total !== c.count) top(`collection "${c.id}" says count ${c.count} but list({ collection }) has ${page.total}`);
        if (page.items.some((x) => x.collection !== c.id)) top(`list({ collection: "${c.id}" }) returned stickers of other collections`);
      }
      for (const x of all) if (x.collection !== undefined && !known.has(x.collection)) issues.push({ stickerId: x.id, message: `collection "${x.collection}" is not in collections()` });
    } catch (e) {
      top(`collections() rejected: ${(e as Error).message}`);
    }
  }
  let rejected = false;
  try {
    await provider.load('__no_such_sticker__');
  } catch {
    rejected = true;
  }
  if (!rejected) top('load of an unknown id did not reject');

  for (const s of all.slice(0, options.loads ?? 3)) {
    for (const format of s.formats ?? []) {
      try {
        const asset = await provider.load(s.id, { format, size: 32 });
        if (format === 'svg' && (asset.kind !== 'svg' || !/<svg[\s>]/.test(asset.svg))) issues.push({ stickerId: s.id, message: 'load({ format: "svg" }) did not return SVG' });
        if (format === 'png' && (asset.kind !== 'image' || !/^(data:|https:)/.test(asset.url) || !(asset.width > 0 && asset.height > 0))) issues.push({ stickerId: s.id, message: 'load({ format: "png" }) did not return an image URL with its size' });
      } catch (e) {
        issues.push({ stickerId: s.id, message: `load({ format: "${format}" }) rejected: ${(e as Error).message}` });
      }
    }
  }
  const dark = all.find((s) => s.variants?.includes('dark'));
  if (dark) {
    try {
      await provider.load(dark.id, { format: dark.formats[0], variant: 'dark', size: 32 });
    } catch (e) {
      issues.push({ stickerId: dark.id, message: `load({ variant: "dark" }) rejected for a sticker that lists it: ${(e as Error).message}` });
    }
  }
  const lightOnly = all.find((s) => !s.variants?.includes('dark'));
  if (lightOnly) {
    let refused = false;
    try {
      await provider.load(lightOnly.id, { format: lightOnly.formats[0], variant: 'dark', size: 32 });
    } catch {
      refused = true;
    }
    if (!refused) issues.push({ stickerId: lightOnly.id, message: 'load({ variant: "dark" }) did not reject for a sticker without a dark variant (checkStickerVariant does it)' });
  }
  const tintable = all.find((s) => s.tintable);
  if (tintable) {
    try {
      const a = await provider.load(tintable.id, { format: tintable.formats[0], colour: '#123456', size: 32 });
      if (a.kind === 'svg' && !/#123456/i.test(a.svg)) issues.push({ stickerId: tintable.id, message: 'a tintable sticker loaded with colour #123456 does not use it' });
    } catch (e) {
      issues.push({ stickerId: tintable.id, message: `load with a colour rejected: ${(e as Error).message}` });
    }
  }
  return issues;
}
