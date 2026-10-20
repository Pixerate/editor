// Portions ported from photocraft/crates/paint/src/procedural.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Paper grain: generated height maps (0 = valley, 1 = peak) that tile across a surface, and how
 * much of a dry dab the grain catches. Shared by the paint editor's papers and standalone
 * brushstrokes (`renderBrushstroke` with `character`). Everything is generated from a pattern and a
 * seed, so no texture is bundled.
 */

import { hash2, TileableNoise } from './rand';

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

/** How a height map is tuned for one kind of media. */
export interface GrainTuning {
  /** Height contrast around the middle, 0..3 (default 1). */
  contrast: number;
  /** Swap peaks and valleys (default false). */
  invert: boolean;
}

export type PaperTiling = 'repeat' | 'mirror';

/** What a `PaperGrain` reads from a paper (the paint editor's `PaperSettings` has it all). */
export interface PaperGrainSettings {
  pattern: GrainPattern;
  /** Grain seed: another seed gives another sheet of the same paper. */
  seed: number;
  /** Grain scale: 1 is the pattern's natural size, 2 twice as coarse. */
  scale: number;
  tiling: PaperTiling;
  dry: GrainTuning;
  wet: GrainTuning;
}

/** Side of the generated grain tile in pixels (at scale 1). */
export const GRAIN_TILE = 256;

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

  constructor(paper: PaperGrainSettings, media: 'dry' | 'wet' = 'dry') {
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


/**
 * How much of a finished standalone stroke stays at grain height `h` (0..1): `renderBrushstroke`
 * applies it once to the whole stroke's coverage. Unlike `grainCatch` (applied dab by dab while a
 * painter goes over the paper, and filling the valleys at full pressure), it keeps texture at full
 * pressure, which is all a mouse reports: the valleys lose up to `depth × (1.4 − 0.6 × pressure)`
 * of the paint, the peaks keep it all.
 */
export function strokeGrainCatch(h: number, depth: number, pressure: number): number {
  if (depth <= 0) return 1;
  const p = Math.min(1, Math.max(0, pressure));
  const amount = Math.min(1, depth * (1.4 - 0.6 * p));
  const u = clamp01((h - 0.2 - 0.25 * (1 - p)) / 0.5);
  return 1 - amount + amount * u * u * (3 - 2 * u);
}
