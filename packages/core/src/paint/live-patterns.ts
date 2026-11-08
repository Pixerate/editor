/**
 * Live patterns: Gray-Scott reaction-diffusion fields `(U, V)` that grow inside wet paint and
 * freeze where the paint dries.
 *
 * Each wet layer with live patterns active holds a sparse set of half-resolution (`128 × 128`)
 * pattern tiles paired with the `256 × 256` tiles of `WetWorld`, outside the wet-media LBM kernel.
 * Every wet simulation step runs Gray-Scott substeps gated by the wet layer's water (`P_RHO` +
 * `P_SW > DRY_EPS`): where water remains, `U` and `V` react and diffuse into Turing spots,
 * stripes, coral dendrites, mazes or worms; where the paint has dried, the reaction and diffusion
 * rates drop to zero so the pattern freezes in place.
 */

import { TILE, TiledSurface, finishTile, tileCoord, tileKey, type RasterRect, type Tile } from '../raster/surface';

/** Side length of one half-resolution pattern tile (`WET_TILE / 2`). */
export const PATTERN_TILE = 128;
/** Cells per pattern tile (`128 × 128`). */
export const PATTERN_CELLS = PATTERN_TILE * PATTERN_TILE;
/** Gray-Scott substeps run for each wet simulation step. */
export const PATTERN_SUBSTEPS = 4;
/** Threshold of `V` above which a cell counts as pattern-bearing in stats and relief. */
export const PATTERN_V_EPS = 0.02;

/** Named Gray-Scott Pearson pattern presets. */
export const LIVE_PATTERN_KINDS = ['spots', 'stripes', 'coral', 'maze', 'worms'] as const;
export type LivePatternKind = (typeof LIVE_PATTERN_KINDS)[number];

export interface LivePatternPresetInfo {
  readonly kind: LivePatternKind;
  readonly label: string;
  readonly description: string;
  readonly feed: number;
  readonly kill: number;
}

/** Built-in Pearson (1993) feed / kill parameter presets. */
export const LIVE_PATTERN_PRESETS: Readonly<Record<LivePatternKind, LivePatternPresetInfo>> = {
  spots: {
    kind: 'spots',
    label: 'Spots',
    description: 'Dividing Turing spots (mitosis).',
    feed: 0.035,
    kill: 0.065,
  },
  stripes: {
    kind: 'stripes',
    label: 'Stripes',
    description: 'Labyrinthine Turing stripes.',
    feed: 0.042,
    kill: 0.06,
  },
  coral: {
    kind: 'coral',
    label: 'Coral',
    description: 'Branching coral dendrites.',
    feed: 0.0545,
    kill: 0.062,
  },
  maze: {
    kind: 'maze',
    label: 'Maze',
    description: 'Winding interconnected maze channels.',
    feed: 0.029,
    kill: 0.057,
  },
  worms: {
    kind: 'worms',
    label: 'Worms',
    description: 'Wiggling vermicular tracks.',
    feed: 0.058,
    kill: 0.065,
  },
};

/** Resolved live-pattern parameters for a brush or wet layer. */
export interface LivePatternsSettings {
  /** Named Gray-Scott preset (`spots`, `stripes`, `coral`, `maze`, `worms`). */
  pattern: LivePatternKind;
  /** Gray-Scott feed rate F (0.01..0.1). */
  feed: number;
  /** Gray-Scott kill rate k (0.03..0.08). */
  kill: number;
  /** Pattern feature scale (0.5..4, default 1). Scales the diffusion rates. */
  scale: number;
  /** Visual contrast of the V concentration field (0..2, default 1). */
  contrast: number;
  /** Optional hex colour (`#rrggbb`) that V blends the wet paint towards; `null` modulates pigment contrast. */
  secondColor: string | null;
  /** Impasto relief written to the layer's thick height map as patterns grow (0..1, default 0). */
  relief: number;
}

export type LivePatternsInput = Partial<LivePatternsSettings>;

export const DEFAULT_LIVE_PATTERNS: Readonly<LivePatternsSettings> = {
  pattern: 'spots',
  feed: LIVE_PATTERN_PRESETS.spots.feed,
  kill: LIVE_PATTERN_PRESETS.spots.kill,
  scale: 1,
  contrast: 1,
  secondColor: null,
  relief: 0,
};

export function isLivePatternKind(v: unknown): v is LivePatternKind {
  return typeof v === 'string' && (LIVE_PATTERN_KINDS as readonly string[]).includes(v);
}

/** Normalizes a hex colour string (`#rgb` or `#rrggbb`) to lowercase `#rrggbb`, or `null`. */
export function normalizePatternHexColor(v: unknown, fallback: string | null = null): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') return fallback;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return fallback;
}

/** Parses a `#rrggbb` colour to `[r, g, b]` bytes, or `null`. */
export function parsePatternHexColor(hex: string | null): [number, number, number] | null {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Clamps and fills a `LivePatternsSettings` object from partial input. */
export function normalizeLivePatterns(
  raw: LivePatternsInput | null | undefined = {},
  base: LivePatternsSettings = DEFAULT_LIVE_PATTERNS
): LivePatternsSettings {
  const src = raw ?? {};
  const hasExplicitPattern = isLivePatternKind(src.pattern);
  const pattern: LivePatternKind = hasExplicitPattern ? src.pattern! : base.pattern;
  const preset = LIVE_PATTERN_PRESETS[pattern];
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  const defaultFeed = hasExplicitPattern ? preset.feed : base.feed;
  const defaultKill = hasExplicitPattern ? preset.kill : base.kill;
  return {
    pattern,
    feed: round4(num(src.feed, defaultFeed, 0.01, 0.1)),
    kill: round4(num(src.kill, defaultKill, 0.03, 0.08)),
    scale: round4(num(src.scale, base.scale, 0.5, 4)),
    contrast: round4(num(src.contrast, base.contrast, 0, 2)),
    secondColor: src.secondColor === undefined ? base.secondColor : normalizePatternHexColor(src.secondColor, base.secondColor),
    relief: round4(num(src.relief, base.relief, 0, 1)),
  };
}

/** Deterministic 32-bit integer hash in `[0, 1)` shared between TypeScript and Swift. */
export function patternNoise(gx: number, gy: number, seed: number): number {
  let h = (Math.imul(gx | 0, 374761393) + Math.imul(gy | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Summary statistics for one wet layer's Gray-Scott field. */
export interface LivePatternStats {
  /** Whether live patterns are enabled on this layer. */
  enabled: boolean;
  /** Current Gray-Scott reaction-diffusion settings for this layer. */
  settings: LivePatternsSettings;
  /** Half-resolution (`128 × 128`) tiles currently holding pattern state. */
  activeTiles: number;
  /** Pattern cells (`2 × 2` px each) where `V >= PATTERN_V_EPS`. */
  patternCells: number;
  /** Pattern cells where `V >= PATTERN_V_EPS` that are still wet (actively growing). */
  wetPatternCells: number;
  /** Mean `V` concentration across active pattern cells (0..1). */
  meanV: number;
  /** Peak `V` concentration across the layer (0..1). */
  maxV: number;
  /** Document pixel bounding box of active pattern cells, or `null` when none. */
  bounds: RasterRect | null;
}

export interface LivePatternTileState {
  readonly u: Float64Array;
  readonly v: Float64Array;
  readonly bakedV: Float64Array;
}

export interface LivePatternFieldSnapshot {
  readonly settings: LivePatternsSettings;
  readonly enabled: boolean;
  readonly tiles: ReadonlyMap<number, LivePatternTileState>;
  readonly bytes: number;
}

/** Callback returning whether a half-res pattern cell `(tx, ty, lx, ly)` still holds water. */
export type WetCellPredicate = (tx: number, ty: number, lx: number, ly: number) => boolean;

/**
 * Per-wet-layer Gray-Scott reaction-diffusion field `(U, V)` stored in `128 × 128` tiles.
 */
export class LivePatternField {
  width: number;
  height: number;
  tilesX: number;
  tilesY: number;
  settings: LivePatternsSettings = { ...DEFAULT_LIVE_PATTERNS };
  enabled = false;
  readonly tiles = new Map<number, { u: Float64Array; v: Float64Array; bakedV: Float64Array }>();

  constructor(width: number, height: number, settings?: LivePatternsInput) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.tilesX = Math.ceil(this.width / TILE);
    this.tilesY = Math.ceil(this.height / TILE);
    if (settings) {
      this.settings = normalizeLivePatterns(settings, this.settings);
      this.enabled = true;
    }
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.tilesX = Math.ceil(this.width / TILE);
    this.tilesY = Math.ceil(this.height / TILE);
  }

  configure(settings: LivePatternsInput): LivePatternsSettings {
    this.settings = normalizeLivePatterns(settings, this.settings);
    this.enabled = true;
    return { ...this.settings };
  }

  clear(): void {
    this.enabled = false;
    this.tiles.clear();
  }

  private ensureTile(tx: number, ty: number): { u: Float64Array; v: Float64Array; bakedV: Float64Array } | null {
    if (tx < 0 || ty < 0 || tx >= this.tilesX || ty >= this.tilesY) return null;
    const key = tileKey(tx, ty);
    let tile = this.tiles.get(key);
    if (!tile) {
      const u = new Float64Array(PATTERN_CELLS);
      u.fill(1);
      const v = new Float64Array(PATTERN_CELLS);
      const bakedV = new Float64Array(PATTERN_CELLS);
      tile = { u, v, bakedV };
      this.tiles.set(key, tile);
    }
    return tile;
  }

  /**
   * Seeds Gray-Scott reagent `V` inside a circle at document coordinates `(cx, cy)` with document
   * `radius` (pixels). Returns the number of half-resolution cells seeded.
   */
  seedDisc(cx: number, cy: number, radius: number, seed = 1, strength = 1): number {
    this.enabled = true;
    const s = Math.min(1, Math.max(0.05, strength));
    const rDoc = Math.max(2, radius);
    const px = cx * 0.5;
    const py = cy * 0.5;
    const pr = Math.max(1, rDoc * 0.5);
    const maxGx = Math.ceil(this.width * 0.5);
    const maxGy = Math.ceil(this.height * 0.5);
    const gx0 = Math.max(0, Math.floor(px - pr));
    const gy0 = Math.max(0, Math.floor(py - pr));
    const gx1 = Math.min(maxGx - 1, Math.ceil(px + pr));
    const gy1 = Math.min(maxGy - 1, Math.ceil(py + pr));
    const r2 = pr * pr;
    let seeded = 0;

    for (let gy = gy0; gy <= gy1; gy++) {
      const dy = gy + 0.5 - py;
      for (let gx = gx0; gx <= gx1; gx++) {
        const dx = gx + 0.5 - px;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const tx = Math.floor(gx / PATTERN_TILE);
        const ty = Math.floor(gy / PATTERN_TILE);
        const tile = this.ensureTile(tx, ty);
        if (!tile) continue;
        const lx = gx - tx * PATTERN_TILE;
        const ly = gy - ty * PATTERN_TILE;
        const idx = ly * PATTERN_TILE + lx;
        // Nucleate spatial clusters and center seeds surrounded by fresh U=1 substrate so patterns grow outward.
        const coarse = patternNoise(gx >> 1, gy >> 1, seed);
        const fine = patternNoise(gx, gy, seed + 101);
        const nearCenter = d2 <= Math.max(2.5, r2 * 0.08);
        if (nearCenter || (d2 <= r2 * 0.65 && coarse > 0.72)) {
          const falloff = 1 - (d2 / r2) * 0.2;
          const targetV = (0.45 + 0.12 * fine) * s * falloff;
          if (targetV > tile.v[idx]) {
            tile.v[idx] = targetV;
            tile.u[idx] = Math.min(tile.u[idx], 0.5);
          }
          tile.bakedV[idx] = 0;
          seeded++;
        } else if (tile.v[idx] === 0 && tile.u[idx] === 1) {
          // Slight substrate perturbation around nucleation sites.
          tile.u[idx] = 0.99 - 0.02 * fine * s;
          tile.bakedV[idx] = 0;
        }
      }
    }
    return seeded;
  }

  /**
   * Advances the Gray-Scott reaction-diffusion field for `wetSteps` wet simulation steps.
   * Only cells where `isWetCell(tx, ty, lx, ly)` is true update; dry cells have zero rate and freeze.
   * Returns whether any cell updated.
   */
  step(wetSteps: number, isWetCell: WetCellPredicate, canWakeTile?: (tx: number, ty: number) => boolean): boolean {
    if (!this.enabled || this.tiles.size === 0 || wetSteps <= 0) return false;
    const totalSubsteps = Math.max(1, Math.floor(wetSteps)) * PATTERN_SUBSTEPS;
    const F = this.settings.feed;
    const k = this.settings.kill;
    const fk = F + k;
    const scaleClamped = Math.min(2.2, Math.max(0.4, this.settings.scale));
    const Du = 0.16 * scaleClamped;
    const Dv = 0.08 * scaleClamped;

    // Wake neighboring pattern tiles if active reagent reaches within 2 cells of a tile edge.
    for (const [key, tile] of [...this.tiles.entries()]) {
      const { tx, ty } = tileCoord(key);
      let top = false;
      let bottom = false;
      let left = false;
      let right = false;
      for (let i = 0; i < PATTERN_TILE; i++) {
        if (tile.v[i] > PATTERN_V_EPS || tile.v[PATTERN_TILE + i] > PATTERN_V_EPS) top = true;
        if (tile.v[(PATTERN_TILE - 1) * PATTERN_TILE + i] > PATTERN_V_EPS || tile.v[(PATTERN_TILE - 2) * PATTERN_TILE + i] > PATTERN_V_EPS) bottom = true;
        if (tile.v[i * PATTERN_TILE] > PATTERN_V_EPS || tile.v[i * PATTERN_TILE + 1] > PATTERN_V_EPS) left = true;
        if (tile.v[i * PATTERN_TILE + PATTERN_TILE - 1] > PATTERN_V_EPS || tile.v[i * PATTERN_TILE + PATTERN_TILE - 2] > PATTERN_V_EPS) right = true;
      }
      const wake = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= this.tilesX || ny >= this.tilesY) return;
        if (canWakeTile && !canWakeTile(nx, ny)) return;
        this.ensureTile(nx, ny);
      };
      if (top) wake(tx, ty - 1);
      if (bottom) wake(tx, ty + 1);
      if (left) wake(tx - 1, ty);
      if (right) wake(tx + 1, ty);
    }

    // Build wet masks and scratch buffers per active pattern tile.
    const entries: Array<{
      key: number;
      tx: number;
      ty: number;
      u: Float64Array;
      v: Float64Array;
      nextU: Float64Array;
      nextV: Float64Array;
      wet: Uint8Array;
      hasWet: boolean;
    }> = [];

    let anyWet = false;
    for (const [key, tile] of this.tiles.entries()) {
      const { tx, ty } = tileCoord(key);
      const wet = new Uint8Array(PATTERN_CELLS);
      let hasWet = false;
      const tileW = Math.min(PATTERN_TILE, Math.ceil(this.width * 0.5) - tx * PATTERN_TILE);
      const tileH = Math.min(PATTERN_TILE, Math.ceil(this.height * 0.5) - ty * PATTERN_TILE);
      for (let ly = 0; ly < tileH; ly++) {
        for (let lx = 0; lx < tileW; lx++) {
          if (isWetCell(tx, ty, lx, ly)) {
            wet[ly * PATTERN_TILE + lx] = 1;
            hasWet = true;
            anyWet = true;
          }
        }
      }
      entries.push({
        key,
        tx,
        ty,
        u: tile.u,
        v: tile.v,
        nextU: new Float64Array(tile.u),
        nextV: new Float64Array(tile.v),
        wet,
        hasWet,
      });
    }

    if (!anyWet) return false;

    const byKey = new Map<number, (typeof entries)[number]>();
    for (const e of entries) byKey.set(e.key, e);

    const sampleUV = (
      entry: (typeof entries)[number],
      lx: number,
      ly: number,
      out: Float64Array
    ): void => {
      if (lx >= 0 && lx < PATTERN_TILE && ly >= 0 && ly < PATTERN_TILE) {
        const idx = ly * PATTERN_TILE + lx;
        out[0] = entry.u[idx];
        out[1] = entry.v[idx];
        return;
      }
      let ntx = entry.tx;
      let nty = entry.ty;
      let nlx = lx;
      let nly = ly;
      if (nlx < 0) {
        ntx -= 1;
        nlx += PATTERN_TILE;
      } else if (nlx >= PATTERN_TILE) {
        ntx += 1;
        nlx -= PATTERN_TILE;
      }
      if (nly < 0) {
        nty -= 1;
        nly += PATTERN_TILE;
      } else if (nly >= PATTERN_TILE) {
        nty += 1;
        nly -= PATTERN_TILE;
      }
      const nb = byKey.get(tileKey(ntx, nty));
      if (!nb) {
        // Neumann zero-flux boundary at canvas or unseeded edge.
        const cx = Math.min(PATTERN_TILE - 1, Math.max(0, lx));
        const cy = Math.min(PATTERN_TILE - 1, Math.max(0, ly));
        const idx = cy * PATTERN_TILE + cx;
        out[0] = entry.u[idx];
        out[1] = entry.v[idx];
        return;
      }
      const idx = nly * PATTERN_TILE + nlx;
      out[0] = nb.u[idx];
      out[1] = nb.v[idx];
    };

    const nbScratch = new Float64Array(2);

    for (let s = 0; s < totalSubsteps; s++) {
      for (const e of entries) {
        if (!e.hasWet) continue;
        const { u, v, nextU, nextV, wet } = e;
        for (let ly = 0; ly < PATTERN_TILE; ly++) {
          const row = ly * PATTERN_TILE;
          const interiorY = ly > 0 && ly < PATTERN_TILE - 1;
          for (let lx = 0; lx < PATTERN_TILE; lx++) {
            const idx = row + lx;
            if (!wet[idx]) {
              nextU[idx] = u[idx];
              nextV[idx] = v[idx];
              continue;
            }
            const uc = u[idx];
            const vc = v[idx];
            let lapU = -uc;
            let lapV = -vc;
            if (interiorY && lx > 0 && lx < PATTERN_TILE - 1) {
              // Fast path for interior cells (9-point isotropic Laplacian: 0.2 orthogonal, 0.05 diagonal).
              const n = idx - PATTERN_TILE;
              const so = idx + PATTERN_TILE;
              lapU +=
                0.2 * (u[idx - 1] + u[idx + 1] + u[n] + u[so]) +
                0.05 * (u[n - 1] + u[n + 1] + u[so - 1] + u[so + 1]);
              lapV +=
                0.2 * (v[idx - 1] + v[idx + 1] + v[n] + v[so]) +
                0.05 * (v[n - 1] + v[n + 1] + v[so - 1] + v[so + 1]);
            } else {
              sampleUV(e, lx - 1, ly, nbScratch);
              lapU += 0.2 * nbScratch[0];
              lapV += 0.2 * nbScratch[1];
              sampleUV(e, lx + 1, ly, nbScratch);
              lapU += 0.2 * nbScratch[0];
              lapV += 0.2 * nbScratch[1];
              sampleUV(e, lx, ly - 1, nbScratch);
              lapU += 0.2 * nbScratch[0];
              lapV += 0.2 * nbScratch[1];
              sampleUV(e, lx, ly + 1, nbScratch);
              lapU += 0.2 * nbScratch[0];
              lapV += 0.2 * nbScratch[1];
              sampleUV(e, lx - 1, ly - 1, nbScratch);
              lapU += 0.05 * nbScratch[0];
              lapV += 0.05 * nbScratch[1];
              sampleUV(e, lx + 1, ly - 1, nbScratch);
              lapU += 0.05 * nbScratch[0];
              lapV += 0.05 * nbScratch[1];
              sampleUV(e, lx - 1, ly + 1, nbScratch);
              lapU += 0.05 * nbScratch[0];
              lapV += 0.05 * nbScratch[1];
              sampleUV(e, lx + 1, ly + 1, nbScratch);
              lapU += 0.05 * nbScratch[0];
              lapV += 0.05 * nbScratch[1];
            }
            const uvv = uc * vc * vc;
            const nu = uc + Du * lapU - uvv + F * (1 - uc);
            const nv = vc + Dv * lapV + uvv - fk * vc;
            nextU[idx] = nu < 0 ? 0 : nu > 1 ? 1 : nu;
            nextV[idx] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
          }
        }
      }
      for (const e of entries) {
        if (!e.hasWet) continue;
        e.u.set(e.nextU);
        e.v.set(e.nextV);
      }
    }
    return true;
  }

  /**
   * Bilinearly samples unbaked `V` (`max(0, v - bakedV)`) at document-tile pixel `(x, y)` in `0..255`.
   */
  private sampleUnbakedV(tile: { v: Float64Array; bakedV: Float64Array }, x: number, y: number): number {
    const fx = Math.min(PATTERN_TILE - 1, Math.max(0, (x + 0.5) * 0.5 - 0.5));
    const fy = Math.min(PATTERN_TILE - 1, Math.max(0, (y + 0.5) * 0.5 - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(PATTERN_TILE - 1, x0 + 1);
    const y1 = Math.min(PATTERN_TILE - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (ix: number, iy: number) => {
      const idx = iy * PATTERN_TILE + ix;
      const val = tile.v[idx] - tile.bakedV[idx];
      return val > 0 ? val : 0;
    };
    const v00 = at(x0, y0);
    const v10 = at(x1, y0);
    const v01 = at(x0, y1);
    const v11 = at(x1, y1);
    const top = v00 + (v10 - v00) * tx;
    const bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * ty;
  }

  /**
   * Blends the pattern's `V` concentration into a shaded `256 × 256` RGBA wet tile `out`.
   * Returns whether any pixel in `out` was modified.
   */
  shadeTile(tx: number, ty: number, out: Uint8ClampedArray, w: number, h: number): boolean {
    if (!this.enabled || this.settings.contrast <= 0) return false;
    const tile = this.tiles.get(tileKey(tx, ty));
    if (!tile) return false;
    const second = parsePatternHexColor(this.settings.secondColor);
    const contrast = this.settings.contrast;
    let changed = false;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * TILE + x) * 4;
        const a = out[i + 3];
        if (a === 0) continue;
        const vVal = this.sampleUnbakedV(tile, x, y);
        if (vVal <= 1e-4) continue;
        const t = Math.min(1, vVal * 2.2 * contrast);
        if (t <= 1e-3) continue;
        if (second) {
          out[i] = Math.round(out[i] + (second[0] - out[i]) * t);
          out[i + 1] = Math.round(out[i + 1] + (second[1] - out[i + 1]) * t);
          out[i + 2] = Math.round(out[i + 2] + (second[2] - out[i + 2]) * t);
          out[i + 3] = Math.min(255, Math.round(a + (255 - a) * t * 0.35));
        } else {
          const lum = (out[i] * 77 + out[i + 1] * 150 + out[i + 2] * 29) >> 8;
          if (lum < 48) {
            out[i] = Math.round(out[i] + (220 - out[i]) * 0.4 * t);
            out[i + 1] = Math.round(out[i + 1] + (220 - out[i + 1]) * 0.4 * t);
            out[i + 2] = Math.round(out[i + 2] + (220 - out[i + 2]) * 0.4 * t);
          } else {
            const scale = 1 - 0.45 * t;
            out[i] = Math.round(out[i] * scale);
            out[i + 1] = Math.round(out[i + 1] * scale);
            out[i + 2] = Math.round(out[i + 2] * scale);
          }
          out[i + 3] = Math.min(255, Math.round(a + (255 - a) * t * 0.28));
        }
        changed = true;
      }
    }
    return changed;
  }

  /** Marks a tile's current `V` values as baked into the layer's base surface so they are not baked twice. */
  markBaked(tx: number, ty: number): void {
    const tile = this.tiles.get(tileKey(tx, ty));
    if (tile) tile.bakedV.set(tile.v);
  }

  /**
   * When `settings.relief > 0`, writes pattern `V` ridges into a 1-channel thick height surface.
   * Returns the updated height `TiledSurface`, or `currentHeight` when `relief <= 0` or nothing changed.
   */
  applyReliefHeight(currentHeight: TiledSurface): TiledSurface {
    const relief = this.settings.relief;
    if (!this.enabled || relief <= 0 || this.tiles.size === 0) return currentHeight;
    let nextTiles: Map<number, Tile> | null = null;
    for (const [key, pTile] of this.tiles.entries()) {
      const { tx, ty } = tileCoord(key);
      const w = Math.min(TILE, this.width - tx * TILE);
      const h = Math.min(TILE, this.height - ty * TILE);
      if (w <= 0 || h <= 0) continue;
      // Check if tile has any significant V first.
      let maxTileV = 0;
      for (let i = 0; i < PATTERN_CELLS; i++) {
        if (pTile.v[i] > maxTileV) maxTileV = pTile.v[i];
      }
      if (maxTileV < PATTERN_V_EPS) continue;
      const existing = currentHeight.tiles.get(key);
      const buf = existing
        ? existing.data.length
          ? new Uint8ClampedArray(existing.data)
          : new Uint8ClampedArray(TILE * TILE).fill(existing.uniform ?? 0)
        : new Uint8ClampedArray(TILE * TILE);
      let tileChanged = false;
      for (let y = 0; y < h; y++) {
        const ly = y >> 1;
        const row = ly * PATTERN_TILE;
        for (let x = 0; x < w; x++) {
          const vVal = pTile.v[row + (x >> 1)];
          if (vVal < PATTERN_V_EPS) continue;
          const ridge = Math.min(255, Math.round(Math.min(1, vVal * 2.2) * relief * 255));
          const p = y * TILE + x;
          if (ridge > buf[p]) {
            buf[p] = ridge;
            tileChanged = true;
          }
        }
      }
      if (tileChanged) {
        if (!nextTiles) nextTiles = new Map(currentHeight.tiles);
        const finished = finishTile(buf, 1, 0);
        if (finished) nextTiles.set(key, finished);
        else nextTiles.delete(key);
      }
    }
    return nextTiles ? new TiledSurface(1, nextTiles, 0) : currentHeight;
  }

  /** Computes summary statistics of the layer's live pattern field. */
  stats(isWetCell?: WetCellPredicate): LivePatternStats {
    if (!this.enabled || this.tiles.size === 0) {
      return {
        enabled: this.enabled,
        settings: { ...this.settings },
        activeTiles: 0,
        patternCells: 0,
        wetPatternCells: 0,
        meanV: 0,
        maxV: 0,
        bounds: null,
      };
    }
    let activeTiles = 0;
    let patternCells = 0;
    let wetPatternCells = 0;
    let sumV = 0;
    let maxV = 0;
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;

    for (const [key, tile] of this.tiles.entries()) {
      const { tx, ty } = tileCoord(key);
      const tileW = Math.min(PATTERN_TILE, Math.ceil(this.width * 0.5) - tx * PATTERN_TILE);
      const tileH = Math.min(PATTERN_TILE, Math.ceil(this.height * 0.5) - ty * PATTERN_TILE);
      let tileHasCells = false;
      for (let ly = 0; ly < tileH; ly++) {
        const row = ly * PATTERN_TILE;
        for (let lx = 0; lx < tileW; lx++) {
          const val = tile.v[row + lx];
          if (val > maxV) maxV = val;
          if (val >= PATTERN_V_EPS) {
            tileHasCells = true;
            patternCells++;
            sumV += val;
            if (isWetCell && isWetCell(tx, ty, lx, ly)) wetPatternCells++;
            const gx0 = (tx * PATTERN_TILE + lx) * 2;
            const gy0 = (ty * PATTERN_TILE + ly) * 2;
            const gx1 = Math.min(this.width, gx0 + 2);
            const gy1 = Math.min(this.height, gy0 + 2);
            if (gx0 < bx0) bx0 = gx0;
            if (gy0 < by0) by0 = gy0;
            if (gx1 > bx1) bx1 = gx1;
            if (gy1 > by1) by1 = gy1;
          }
        }
      }
      if (tileHasCells) activeTiles++;
    }

    return {
      enabled: this.enabled,
      settings: { ...this.settings },
      activeTiles,
      patternCells,
      wetPatternCells,
      meanV: patternCells > 0 ? round4(sumV / patternCells) : 0,
      maxV: round4(maxV),
      bounds: patternCells > 0 ? { x: bx0, y: by0, width: bx1 - bx0, height: by1 - by0 } : null,
    };
  }

  snapshot(): LivePatternFieldSnapshot {
    const tiles = new Map<number, LivePatternTileState>();
    let bytes = 0;
    for (const [key, t] of this.tiles.entries()) {
      const u = new Float64Array(t.u);
      const v = new Float64Array(t.v);
      const bakedV = new Float64Array(t.bakedV);
      tiles.set(key, { u, v, bakedV });
      bytes += u.byteLength + v.byteLength + bakedV.byteLength;
    }
    return {
      settings: { ...this.settings },
      enabled: this.enabled,
      tiles,
      bytes,
    };
  }

  restore(snap: LivePatternFieldSnapshot): void {
    this.settings = { ...snap.settings };
    this.enabled = snap.enabled;
    this.tiles.clear();
    for (const [key, t] of snap.tiles.entries()) {
      this.tiles.set(key, {
        u: new Float64Array(t.u),
        v: new Float64Array(t.v),
        bakedV: new Float64Array(t.bakedV),
      });
    }
  }
}

/** Shifts a `LivePatternFieldSnapshot` by `(tx0, ty0)` whole wet tiles for a resized canvas `to`. */
export function moveLivePatternSnapshot(
  snap: LivePatternFieldSnapshot,
  to: { width: number; height: number },
  tx0: number,
  ty0: number
): LivePatternFieldSnapshot {
  const maxTilesX = Math.ceil(to.width / TILE);
  const maxTilesY = Math.ceil(to.height / TILE);
  const tiles = new Map<number, LivePatternTileState>();
  let bytes = 0;
  for (const [key, t] of snap.tiles.entries()) {
    const { tx, ty } = tileCoord(key);
    const ntx = tx + tx0;
    const nty = ty + ty0;
    if (ntx < 0 || nty < 0 || ntx >= maxTilesX || nty >= maxTilesY) continue;
    tiles.set(tileKey(ntx, nty), t);
    bytes += t.u.byteLength + t.v.byteLength + t.bakedV.byteLength;
  }
  return {
    settings: { ...snap.settings },
    enabled: snap.enabled,
    tiles,
    bytes,
  };
}
