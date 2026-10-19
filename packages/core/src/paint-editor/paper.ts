/**
 * Paper: a generated grain height map (0 = valley, 1 = peak) that tiles across the canvas, a paper
 * colour, grain depth, and the three properties wet media will read later (absorption,
 * permeability, roughness). Dry media catch the peaks: a light stroke only marks the high grain, a
 * firm one fills the valleys too. Everything is generated from a pattern and a seed, so a paper is
 * a few numbers in the document, never a bitmap, and no third-party texture is bundled.
 */

import { hash2, TileableNoise } from './noise';

/** Grain generators. Each is our own procedural pattern (no scanned textures). */
export type GrainPattern =
  | 'smooth'
  | 'cold-pressed'
  | 'hot-pressed'
  | 'rough'
  | 'vellum'
  | 'laid'
  | 'ingres'
  | 'sanded'
  | 'canvas'
  | 'linen'
  | 'gesso';

export const GRAIN_PATTERNS: readonly GrainPattern[] = ['smooth', 'cold-pressed', 'hot-pressed', 'rough', 'vellum', 'laid', 'ingres', 'sanded', 'canvas', 'linen', 'gesso'];

/** Paper families, as a library groups them. */
export type PaperFamily = 'watercolor' | 'drawing' | 'pastel' | 'canvas' | 'panel' | 'smooth';

export const PAPER_FAMILIES: readonly PaperFamily[] = ['watercolor', 'drawing', 'pastel', 'canvas', 'panel', 'smooth'];

/** How a height map is tuned for one kind of media. */
export interface GrainTuning {
  /** Height contrast around the middle, 0..3 (default 1). */
  contrast: number;
  /** Swap peaks and valleys (default false). */
  invert: boolean;
}

export type PaperTiling = 'repeat' | 'mirror';

export interface PaperSettings {
  /** The library preset this paper started from (`custom` when it matches none). */
  preset: string;
  name: string;
  family: PaperFamily;
  pattern: GrainPattern;
  /** Grain seed: another seed gives another sheet of the same paper. */
  seed: number;
  /** Paper colour #rrggbb. */
  color: string;
  /** Grain scale: 1 is the pattern's natural size, 2 twice as coarse (0.25..8). */
  scale: number;
  /** How the grain tile repeats: `repeat` or `mirror` (alternate tiles flipped, so seams vanish). */
  tiling: PaperTiling;
  /** Grain depth 0..1: how much grain-responsive dry media skip the valleys (0: none). */
  depth: number;
  /** How much the grain shades the paper colour on screen and in exports, 0..1. */
  shading: number;
  /** The height map as dry media read it. */
  dry: GrainTuning;
  /** The height map as wet media will read it (stored now; wet media is a later phase). */
  wet: GrainTuning;
  /** Wet media: how fast the paper takes up water, 0..1. */
  absorption: number;
  /** Wet media: how far water spreads inside the paper, 0..1. */
  permeability: number;
  /** Wet media: how much the grain catches pigment, 0..1. */
  roughness: number;
}

/** Side of the generated grain tile in pixels (at scale 1). */
export const GRAIN_TILE = 256;

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const clampNum = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const HEX = /^#[0-9a-f]{6}$/i;

type PaperPreset = PaperSettings;

const tuning = (contrast = 1, invert = false): GrainTuning => ({ contrast, invert });

function preset(
  id: string,
  name: string,
  family: PaperFamily,
  pattern: GrainPattern,
  color: string,
  o: { depth: number; absorption: number; permeability: number; roughness: number; scale?: number; seed?: number; shading?: number; contrast?: number }
): PaperPreset {
  return {
    preset: id,
    name,
    family,
    pattern,
    seed: o.seed ?? 1,
    color,
    scale: o.scale ?? 1,
    tiling: 'mirror',
    depth: o.depth,
    shading: o.shading ?? 0.5,
    dry: tuning(o.contrast ?? 1),
    wet: tuning(1),
    absorption: o.absorption,
    permeability: o.permeability,
    roughness: o.roughness,
  };
}

/** The built-in paper library: generated papers in families. */
export const PAPER_LIBRARY: readonly PaperPreset[] = [
  preset('cold-pressed', 'Cold pressed watercolour', 'watercolor', 'cold-pressed', '#f7f3ea', { depth: 0.5, absorption: 0.7, permeability: 0.5, roughness: 0.6 }),
  preset('hot-pressed', 'Hot pressed watercolour', 'watercolor', 'hot-pressed', '#f8f6ef', { depth: 0.25, absorption: 0.55, permeability: 0.4, roughness: 0.25 }),
  preset('rough-watercolor', 'Rough watercolour', 'watercolor', 'rough', '#f5f0e4', { depth: 0.75, absorption: 0.8, permeability: 0.6, roughness: 0.85 }),
  preset('cartridge', 'Cartridge', 'drawing', 'vellum', '#fbfaf6', { depth: 0.3, absorption: 0.4, permeability: 0.3, roughness: 0.35 }),
  preset('laid', 'Laid paper', 'drawing', 'laid', '#f3ecdc', { depth: 0.45, absorption: 0.45, permeability: 0.35, roughness: 0.45 }),
  preset('ingres', 'Charcoal paper', 'drawing', 'ingres', '#ede6d6', { depth: 0.6, absorption: 0.4, permeability: 0.3, roughness: 0.65 }),
  preset('sanded-pastel', 'Sanded pastel paper', 'pastel', 'sanded', '#d8cfc0', { depth: 0.7, absorption: 0.3, permeability: 0.2, roughness: 0.9, shading: 0.35 }),
  preset('pastel-card', 'Grey pastel card', 'pastel', 'sanded', '#9c978e', { depth: 0.55, absorption: 0.3, permeability: 0.2, roughness: 0.75, scale: 1.5, shading: 0.3 }),
  preset('cotton-canvas', 'Cotton canvas', 'canvas', 'canvas', '#efe9dc', { depth: 0.55, absorption: 0.35, permeability: 0.25, roughness: 0.6 }),
  preset('fine-linen', 'Fine linen', 'canvas', 'linen', '#e9e2d2', { depth: 0.45, absorption: 0.3, permeability: 0.25, roughness: 0.5 }),
  preset('gesso', 'Gesso panel', 'panel', 'gesso', '#f6f4ef', { depth: 0.35, absorption: 0.2, permeability: 0.15, roughness: 0.4 }),
  preset('smooth', 'Smooth bristol', 'smooth', 'smooth', '#ffffff', { depth: 0, absorption: 0.3, permeability: 0.2, roughness: 0.05, shading: 0 }),
];

export const DEFAULT_PAPER: Readonly<PaperSettings> = PAPER_LIBRARY[0];

/** A paper from the library by id, or `undefined`. */
export function paperPreset(id: string): PaperSettings | undefined {
  const p = PAPER_LIBRARY.find((x) => x.preset === id);
  return p ? clonePaper(p) : undefined;
}

export function clonePaper(p: PaperSettings): PaperSettings {
  return { ...p, dry: { ...p.dry }, wet: { ...p.wet } };
}

function readTuning(raw: unknown, d: GrainTuning): GrainTuning {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { contrast: clampNum(r.contrast, 0, 3, d.contrast), invert: typeof r.invert === 'boolean' ? r.invert : d.invert };
}

/**
 * A paper with every field in range. Missing fields come from `base` (default: the library preset
 * named by `raw.preset`, else cold pressed).
 */
export function normalizePaper(raw: Partial<PaperSettings> | Record<string, unknown> = {}, base?: PaperSettings): PaperSettings {
  const r = raw as Record<string, unknown>;
  const b = base ?? (typeof r.preset === 'string' ? paperPreset(r.preset) : undefined) ?? clonePaper(DEFAULT_PAPER);
  return {
    preset: typeof r.preset === 'string' && r.preset ? r.preset : b.preset,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : b.name,
    family: PAPER_FAMILIES.includes(r.family as PaperFamily) ? (r.family as PaperFamily) : b.family,
    pattern: GRAIN_PATTERNS.includes(r.pattern as GrainPattern) ? (r.pattern as GrainPattern) : b.pattern,
    seed: typeof r.seed === 'number' && Number.isFinite(r.seed) ? Math.round(Math.abs(r.seed)) % 2147483647 : b.seed,
    color: typeof r.color === 'string' && HEX.test(r.color) ? r.color.toLowerCase() : b.color,
    scale: clampNum(r.scale, 0.25, 8, b.scale),
    tiling: r.tiling === 'repeat' || r.tiling === 'mirror' ? r.tiling : b.tiling,
    depth: unit(r.depth, b.depth),
    shading: unit(r.shading, b.shading),
    dry: readTuning(r.dry, b.dry),
    wet: readTuning(r.wet, b.wet),
    absorption: unit(r.absorption, b.absorption),
    permeability: unit(r.permeability, b.permeability),
    roughness: unit(r.roughness, b.roughness),
  };
}

// ---------------------------------------------------------------------------
// Height maps
// ---------------------------------------------------------------------------

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** One pattern's raw height (0..1) at pixel (x, y) of a `n`-pixel tile. */
function patternHeights(pattern: GrainPattern, n: number, seed: number): Float32Array {
  const out = new Float32Array(n * n);
  const salt = Math.imul(seed | 0, 0x9e3779b1) + 17;
  if (pattern === 'smooth') return out.fill(1);
  const noise = (cx: number, cy: number, oct: number, s = 0) => new TileableNoise(n, cx, cy, oct, salt + s);
  const k = n / GRAIN_TILE;
  switch (pattern) {
    case 'cold-pressed': {
      const base = noise(20 * k, 20 * k, 4);
      const fine = noise(64 * k, 64 * k, 2, 3);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) out[y * n + x] = clamp01((base.at(x, y) - 0.5) * 1.8 + 0.5 + (fine.at(x, y) - 0.5) * 0.5 + (hash2(x, y, salt) - 0.5) * 0.12);
      break;
    }
    case 'hot-pressed': {
      const base = noise(40 * k, 40 * k, 3);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = clamp01((base.at(x, y) - 0.5) * 1.1 + 0.6 + (hash2(x, y, salt) - 0.5) * 0.08);
      break;
    }
    case 'rough': {
      const base = noise(10 * k, 10 * k, 5);
      const blot = noise(28 * k, 28 * k, 2, 5);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) out[y * n + x] = clamp01((base.at(x, y) - 0.5) * 2.4 + 0.5 + (blot.at(x, y) - 0.5) * 0.7 + (hash2(x, y, salt) - 0.5) * 0.15);
      break;
    }
    case 'vellum': {
      const base = noise(40 * k, 40 * k, 3);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = clamp01((base.at(x, y) - 0.5) * 1.6 + 0.55 + (hash2(x, y, salt) - 0.5) * 0.2);
      break;
    }
    case 'laid': {
      // Fine laid lines across, chain lines down every eighth of the tile, a little pulp noise.
      const pulp = noise(32 * k, 32 * k, 3);
      const chain = n / 8;
      for (let y = 0; y < n; y++) {
        const laid = 0.5 + 0.5 * Math.cos((2 * Math.PI * y) / 4);
        for (let x = 0; x < n; x++) {
          const c = Math.abs(((x + 0.5) % chain) - chain / 2) / (chain / 2);
          const chainLine = c > 0.94 ? -0.35 : 0;
          out[y * n + x] = clamp01(0.3 + 0.5 * laid + chainLine + (pulp.at(x, y) - 0.5) * 0.6);
        }
      }
      break;
    }
    case 'ingres': {
      // Long vertical fibres with grit.
      const fibres = noise(64 * k, 12 * k, 3);
      const base = noise(16 * k, 16 * k, 3, 7);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const g = hash2(x, y, salt ^ 0x55);
          out[y * n + x] = clamp01((fibres.at(x, y) - 0.5) * 1.5 + (base.at(x, y) - 0.5) * 0.7 + 0.55 + (g < 0.1 ? -0.3 : 0));
        }
      break;
    }
    case 'sanded': {
      // Fine grit: high-frequency noise and sharp single-pixel pits.
      const grit = noise(96 * k, 96 * k, 2);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const h = hash2(x, y, salt);
          out[y * n + x] = clamp01((grit.at(x, y) - 0.5) * 2.4 + 0.5 + (h - 0.5) * 0.7);
        }
      break;
    }
    case 'canvas':
    case 'linen': {
      // Over / under weave; linen has finer, irregular threads.
      const period = (pattern === 'canvas' ? 8 : 5) * k;
      // An even thread count keeps the over / under alternation seamless across the tile edge.
      const threads = Math.max(2, 2 * Math.round(n / period / 2));
      const p = n / threads;
      const slub = noise(threads, threads, 2, 11);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const fx = (x + 0.5) / p;
          const fy = (y + 0.5) / p;
          const cx = Math.floor(fx);
          const cy = Math.floor(fy);
          const warp = Math.sin(Math.PI * (fx - cx));
          const weft = Math.sin(Math.PI * (fy - cy));
          const top = (cx + cy) % 2 === 0 ? warp : weft;
          const irregular = pattern === 'linen' ? (slub.at(x, y) - 0.5) * 0.5 : 0;
          out[y * n + x] = clamp01(0.2 + 0.7 * top + irregular + (hash2(x, y, salt) - 0.5) * 0.15);
        }
      break;
    }
    case 'gesso': {
      // Brushed gesso: soft horizontal streaks over a fine tooth.
      const streaks = noise(2 * k, 28 * k, 3);
      const tooth = noise(64 * k, 64 * k, 2, 13);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) out[y * n + x] = clamp01((streaks.at(x, y) - 0.5) * 1.8 + (tooth.at(x, y) - 0.5) * 0.9 + 0.55);
      break;
    }
  }
  return out;
}

const rawCache = new Map<string, Float32Array>();

/** The raw height map of a pattern (`GRAIN_TILE` square, 0..1), generated once per pattern and seed. */
export function grainHeights(pattern: GrainPattern, seed: number, size = GRAIN_TILE): Float32Array {
  const key = `${pattern}:${seed}:${size}`;
  let h = rawCache.get(key);
  if (!h) {
    h = patternHeights(pattern, size, seed);
    if (rawCache.size > 32) rawCache.delete(rawCache.keys().next().value as string);
    rawCache.set(key, h);
  }
  return h;
}

/**
 * A paper's height field over the canvas (document pixels), tuned for one kind of media. Read it
 * with `at(x, y)`: bilinear, tiled by `paper.tiling`, at `paper.scale`.
 */
export class PaperGrain {
  readonly size = GRAIN_TILE;
  private readonly heights: Float32Array;
  private readonly scale: number;
  private readonly mirror: boolean;
  readonly flat: boolean;

  constructor(paper: PaperSettings, media: 'dry' | 'wet' = 'dry') {
    const raw = grainHeights(paper.pattern, paper.seed);
    const t = paper[media];
    this.flat = paper.pattern === 'smooth';
    if (t.contrast === 1 && !t.invert) this.heights = raw;
    else {
      const out = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const v = clamp01((raw[i] - 0.5) * t.contrast + 0.5);
        out[i] = t.invert ? 1 - v : v;
      }
      this.heights = out;
    }
    this.scale = paper.scale;
    this.mirror = paper.tiling === 'mirror';
  }

  /** Tile cell index for a coordinate in grain pixels (mirrored on odd tiles when mirroring). */
  private wrap(v: number): number {
    const n = this.size;
    if (!this.mirror) return ((v % n) + n) % n;
    const p = ((v % (2 * n)) + 2 * n) % (2 * n);
    return p < n ? p : 2 * n - 1 - p;
  }

  /** Height 0..1 at document position (x, y). */
  at(x: number, y: number): number {
    const u = x / this.scale - 0.5;
    const v = y / this.scale - 0.5;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    const n = this.size;
    const h = this.heights;
    const a = this.wrap(x0);
    const b = this.wrap(x0 + 1);
    const c = this.wrap(y0) * n;
    const d = this.wrap(y0 + 1) * n;
    const top = h[c + a] + (h[c + b] - h[c + a]) * fx;
    const bot = h[d + a] + (h[d + b] - h[d + a]) * fx;
    return top + (bot - top) * fy;
  }
}

/**
 * How much of a dry dab lands at grain height `h` (0..1): the media catches the peaks first, and
 * pressure pushes it into the valleys. `depth` is the paper's grain depth times the brush's grain
 * response; at 0 everything lands (1).
 */
export function grainCatch(h: number, depth: number, pressure: number): number {
  if (depth <= 0) return 1;
  const t = depth * (0.75 - 0.65 * Math.min(1, Math.max(0, pressure)));
  const u = clamp01((h - t + 0.18) / 0.36);
  return 1 - depth + depth * u * u * (3 - 2 * u);
}

/** `#rrggbb` → [r, g, b] 0..255. */
export function hexToRgb8(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * The paper as opaque RGBA over `rect` (document pixels): its colour, darkened in the valleys by
 * `shading`.
 */
export function renderPaper(paper: PaperSettings, rect: { x: number; y: number; width: number; height: number }, grain = new PaperGrain(paper)): Uint8ClampedArray {
  const [r, g, b] = hexToRgb8(paper.color);
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  const shade = grain.flat ? 0 : paper.shading * 0.16;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const i = (y * rect.width + x) * 4;
      const k = shade ? 1 - shade * (1 - grain.at(rect.x + x + 0.5, rect.y + y + 0.5)) : 1;
      out[i] = r * k;
      out[i + 1] = g * k;
      out[i + 2] = b * k;
      out[i + 3] = 255;
    }
  }
  return out;
}
