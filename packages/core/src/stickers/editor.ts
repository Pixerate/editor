/**
 * `editorStickers()`: the editor's own stamps as a sticker provider (id `editor`), the default in
 * every `StickersSlot`, so stickers work with no setup. Each stamp is MIT-licensed and tintable.
 * Its SVG is the stamp's outline, contoured from the coverage function the paint editor draws, so
 * the vector art and the painted stamp have the same shape; its PNG is drawn from the function.
 */

import { pngDataUrl } from '../raster/png';
import { StickerError } from './errors';
import { EDITOR_STICKERS_ID, stickerPage } from './helpers';
import { STAMP_KINDS, stampCoverage, type StampKind } from './stamps';
import type { StickerAsset, StickerDescription, StickerLoadOptions, StickerProvider, StickerSummary } from './types';

/** The natural box of an editor sticker (px). */
const BOX = 100;
/** Contour grid cells per side. */
const GRID = 128;
/** Seed for the shapes with random parts (splat, confetti): the one the sticker set shows. */
const SHAPE_SEED = 7;
const LICENCE = { spdx: 'MIT', name: 'MIT', commercial: true } as const;

const META: Record<StampKind, { name: string; category: string; tags: string[]; colour: string; description: string }> = {
  dot: { name: 'Dot', category: 'shapes', tags: ['circle', 'round', 'spot'], colour: '#2563eb', description: 'A round dot.' },
  star: { name: 'Star', category: 'shapes', tags: ['five-pointed', 'favourite', 'rating'], colour: '#f59e0b', description: 'A five-pointed star, one point up.' },
  heart: { name: 'Heart', category: 'shapes', tags: ['love', 'like'], colour: '#e11d48', description: 'A heart.' },
  leaf: { name: 'Leaf', category: 'nature', tags: ['plant', 'green'], colour: '#16a34a', description: 'A pointed leaf with a midrib.' },
  flower: { name: 'Flower', category: 'nature', tags: ['petals', 'blossom'], colour: '#db2777', description: 'A five-petal flower.' },
  confetti: { name: 'Confetti', category: 'party', tags: ['celebration', 'rectangle'], colour: '#7c3aed', description: 'A small strip of confetti.' },
  splat: { name: 'Splat', category: 'party', tags: ['paint', 'splash', 'blob'], colour: '#0891b2', description: 'A paint splat with drops.' },
  sparkle: { name: 'Sparkle', category: 'party', tags: ['twinkle', 'shine', 'glint'], colour: '#eab308', description: 'A four-pointed twinkle.' },
  ring: { name: 'Ring', category: 'shapes', tags: ['circle', 'outline', 'hoop'], colour: '#0f766e', description: 'A ring.' },
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The stamp's outline as SVG path data in a `BOX` px square (marching squares on the 0.5 level, simplified). */
export function stampOutline(kind: StampKind): string {
  const n = GRID;
  const f = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) f[j * (n + 1) + i] = stampCoverage(kind, (i / n) * 2 - 1, (j / n) * 2 - 1, SHAPE_SEED) - 0.5;
  const at = (i: number, j: number) => f[j * (n + 1) + i];
  // Edges are named by the grid edge they cross, so segments meet exactly; a point per edge.
  const points = new Map<string, [number, number]>();
  const point = (key: string, i0: number, j0: number, i1: number, j1: number): string => {
    if (!points.has(key)) {
      const a = at(i0, j0);
      const b = at(i1, j1);
      const t = a / (a - b);
      points.set(key, [((i0 + (i1 - i0) * t) / n) * BOX, ((j0 + (j1 - j0) * t) / n) * BOX]);
    }
    return key;
  };
  const next = new Map<string, string>();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const tl = at(i, j) > 0 ? 1 : 0;
      const tr = at(i + 1, j) > 0 ? 1 : 0;
      const br = at(i + 1, j + 1) > 0 ? 1 : 0;
      const bl = at(i, j + 1) > 0 ? 1 : 0;
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;
      const top = () => point(`h${i},${j}`, i, j, i + 1, j);
      const right = () => point(`v${i + 1},${j}`, i + 1, j, i + 1, j + 1);
      const bottom = () => point(`h${i},${j + 1}`, i, j + 1, i + 1, j + 1);
      const left = () => point(`v${i},${j}`, i, j, i, j + 1);
      // Segments go with the inside on their left (y down: clockwise loops outside, anticlockwise holes).
      const seg = (a: string, b: string) => next.set(a, b);
      const centre = at(i, j) + at(i + 1, j) + at(i + 1, j + 1) + at(i, j + 1) > 0;
      switch (code) {
        case 1: seg(left(), bottom()); break;
        case 2: seg(bottom(), right()); break;
        case 3: seg(left(), right()); break;
        case 4: seg(right(), top()); break;
        case 5: if (centre) { seg(left(), top()); seg(right(), bottom()); } else { seg(left(), bottom()); seg(right(), top()); } break;
        case 6: seg(bottom(), top()); break;
        case 7: seg(left(), top()); break;
        case 8: seg(top(), left()); break;
        case 9: seg(top(), bottom()); break;
        case 10: if (centre) { seg(top(), right()); seg(bottom(), left()); } else { seg(top(), left()); seg(bottom(), right()); } break;
        case 11: seg(top(), right()); break;
        case 12: seg(right(), left()); break;
        case 13: seg(right(), bottom()); break;
        case 14: seg(bottom(), left()); break;
      }
    }
  }
  const loops: Array<Array<[number, number]>> = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Array<[number, number]> = [];
    let k: string | undefined = start;
    while (k !== undefined && !seen.has(k)) {
      seen.add(k);
      loop.push(points.get(k)!);
      k = next.get(k);
    }
    if (loop.length >= 3) loops.push(simplify(loop, 0.12));
  }
  const fmt = (v: number) => String(Math.round(v * 100) / 100);
  return loops.map((l) => 'M' + l.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L') + 'Z').join('');
}

/** Ramer–Douglas–Peucker on a closed loop. */
function simplify(loop: Array<[number, number]>, eps: number): Array<[number, number]> {
  if (loop.length < 8) return loop;
  const keep = new Uint8Array(loop.length);
  const rdp = (a: number, b: number) => {
    const [ax, ay] = loop[a];
    const [bx, by] = loop[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let worst = -1;
    let far = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - loop[i][1]) - (ax - loop[i][0]) * (by - ay)) / len;
      if (d > far) {
        far = d;
        worst = i;
      }
    }
    if (worst !== -1 && far > eps) {
      keep[worst] = 1;
      rdp(a, worst);
      rdp(worst, b);
    }
  };
  const mid = Math.floor(loop.length / 2);
  keep[0] = keep[mid] = 1;
  rdp(0, mid);
  rdp(mid, loop.length - 1);
  keep[loop.length - 1] = 1;
  return loop.filter((_, i) => keep[i]);
}

/** The stamp drawn flat in `colour` as RGBA, `size` px square (supersampled). */
export function stampPixels(kind: StampKind, size: number, colour: string): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const n = parseInt(colour.slice(1), 16);
  const ss = size <= 128 ? 3 : 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) c += stampCoverage(kind, ((x + (sx + 0.5) / ss) / size) * 2 - 1, ((y + (sy + 0.5) / ss) / size) * 2 - 1, SHAPE_SEED);
      const a = Math.round((c / (ss * ss)) * 255);
      if (!a) continue;
      const i = (y * size + x) * 4;
      out[i] = (n >> 16) & 255;
      out[i + 1] = (n >> 8) & 255;
      out[i + 2] = n & 255;
      out[i + 3] = a;
    }
  }
  return out;
}

/** The editor's own stamps as a `StickerProvider` (id `editor`): tintable, MIT, SVG and PNG. */
export function editorStickers(): StickerProvider {
  const outlines = new Map<StampKind, string>();
  const thumbs = new Map<StampKind, string>();
  const outline = (k: StampKind) => outlines.get(k) ?? (outlines.set(k, stampOutline(k)), outlines.get(k)!);
  const summary = (k: StampKind): StickerSummary => {
    const m = META[k];
    if (!thumbs.has(k)) thumbs.set(k, pngDataUrl(48, 48, stampPixels(k, 48, m.colour)));
    return { id: k, name: m.name, category: m.category, tags: m.tags, description: m.description, width: BOX, height: BOX, thumbnail: thumbs.get(k), formats: ['svg', 'png'], licence: { ...LICENCE }, tintable: true };
  };
  const kind = (id: string): StampKind => {
    if (!STAMP_KINDS.includes(id as StampKind)) throw new StickerError('unknown_sticker', `The editor has no sticker "${id}"; its stickers are ${STAMP_KINDS.join(', ')}.`);
    return id as StampKind;
  };
  return {
    id: EDITOR_STICKERS_ID,
    name: 'Editor stickers',
    version: '1',
    capabilities: { supportsSearch: true, supportsSvg: true, supportsRaster: true, maxSize: 1024 },
    list: (options) => stickerPage(STAMP_KINDS.map(summary), options),
    search: (query, options) => stickerPage(STAMP_KINDS.map(summary), options, query),
    describe(id): StickerDescription | undefined {
      if (!STAMP_KINDS.includes(id as StampKind)) return undefined;
      const k = id as StampKind;
      return { ...summary(k), silhouette: outline(k), colours: [META[k].colour] };
    },
    categories: () => [...new Set(STAMP_KINDS.map((k) => META[k].category))].map((c) => ({ id: c, name: c[0].toUpperCase() + c.slice(1), count: STAMP_KINDS.filter((k) => META[k].category === c).length })),
    load(id, options: StickerLoadOptions = {}): StickerAsset {
      const k = kind(id);
      const colour = options.colour ?? META[k].colour;
      if (!HEX.test(colour)) throw new StickerError('invalid_argument', `colour ${JSON.stringify(colour)} must be #rrggbb.`);
      if (options.format === 'png') {
        const size = options.size ?? 256;
        if (!(Number.isInteger(size) && size >= 8 && size <= 1024)) throw new StickerError('invalid_argument', `size must be a whole number of px from 8 to 1024, got ${size}.`);
        return { kind: 'image', url: pngDataUrl(size, size, stampPixels(k, size, colour.toLowerCase())), width: size, height: size };
      }
      if (options.format !== undefined && options.format !== 'svg') throw new StickerError('unsupported_format', `format must be svg or png, got ${JSON.stringify(options.format)}.`);
      const d = outline(k);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${BOX}" height="${BOX}"><path fill="${colour.toLowerCase()}" fill-rule="evenodd" d="${d}"/></svg>`;
      return { kind: 'svg', svg, silhouette: d };
    },
  };
}
