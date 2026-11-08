/**
 * Biopaint (`culture`): living mycelial ink that seeds spores along a brush stroke, grows outward
 * as branching hyphal threads, senses existing paint on the layer (chemotaxis), digests what it
 * crosses and transports the eaten colour downstream along the network, and fuses (anastomosis)
 * when threads meet.
 *
 * All simulation state and math (positions in 1/256 px fixed-point, headings 0..1023 via an
 * integer cosine table, 32-bit integer hashing, 8-bit pixel sensing, and permille parameters) are
 * integer-exact so TypeScript and Swift produce bit-identical pixels and tip states across ticks.
 */

import {
  TILE,
  TiledSurface,
  contentBounds,
  emptySurface,
  finishTile,
  readRegion,
  surfaceFromPixels,
  tileKey,
  translateSurface,
  type RasterRect,
  type Tile,
  type TileKey,
} from '../raster/surface';
import { decodePng, parseDataUrl, pngDataUrl } from '../raster/png';

export const CULTURE_SPECIES = ['mycelium'] as const;
export type CultureSpecies = (typeof CULTURE_SPECIES)[number];

export interface CultureSettings {
  /** Living species ('mycelium'). */
  species: CultureSpecies;
  /** How far a colony spreads on bare canvas (no food), in brush tip diameters (1..100, default 12). */
  reach: number;
  /** How often threads fork (0..1, default 0.4). */
  branching: number;
  /** How much threads meander (0..1, default 0.35). */
  wander: number;
  /** How strongly threads steer towards existing paint (0..1, default 0.5). */
  appetite: number;
  /** How much crossed paint is consumed and faded (0..1, default 0.25; 0 leaves underlying paint outside threads unchanged). */
  digest: number;
  /** Chance a thread joins another thread it meets rather than deflecting/stopping (0..1, default 0.7). */
  fuse: number;
  /** Thread width as a fraction of the brush tip size (0.02..0.5, default 0.08). */
  thickness: number;
  /** Bioluminescence written into the layer's light channel (0..1, default 0). */
  glow: number;
}

export type CultureSettingsInput = Partial<CultureSettings>;

export const DEFAULT_CULTURE: Readonly<CultureSettings> = {
  species: 'mycelium',
  reach: 12,
  branching: 0.4,
  wander: 0.35,
  appetite: 0.5,
  digest: 0.25,
  fuse: 0.7,
  thickness: 0.08,
  glow: 0,
};

/** Hard caps per layer so runaway colonies never stall the editor. */
export const MAX_CULTURE_TIPS = 2000;
export const MAX_CULTURE_SEGMENTS = 200000;
export const MAX_CATCH_UP_TICKS = 5000;
export const CULTURE_TICKS_PER_SECOND = 24;

export type CultureStatus = 'growing' | 'extinct' | 'capped';

/** Fixed-point scale (1 pixel = 256 fixed-point units). */
export const CULTURE_FP = 256;
/** Full circle in angle units (0..1023). */
export const CULTURE_ANGLE_STEPS = 1024;
export const CULTURE_ANGLE_MASK = 1023;

/**
 * One living hyphal tip. All coordinates and parameters are integers so JSON round-tripping and
 * cross-language execution are 100% bit-exact.
 */
export interface CultureTip {
  id: number;
  /** Position in 1/256 px fixed-point (layer coordinates). */
  x: number;
  y: number;
  /** Heading in 0..1023 (0 = +x, 256 = +y, 512 = -x, 768 = -y). */
  angle: number;
  /** Remaining energy (10 units = 1 step on bare canvas). */
  energy: number;
  /** Thread diameter in 1/256 px fixed-point (tapers on fork). */
  widthFp: number;
  /** Carried colour 0..255 RGB. */
  r: number;
  g: number;
  b: number;
  /** Ticks since this tip spawned or last forked. */
  age: number;
  seed: number;
  reachPx: number;
  branchPermille: number;
  wanderPermille: number;
  appetitePermille: number;
  digestPermille: number;
  fusePermille: number;
  glowPermille: number;
}

/**
 * Per-layer culture state (`doc.cultures[layerId]`).
 *
 * `occupancy` is a 1-channel `TiledSurface` where:
 * - `0` = untouched / foreign paint (food when layer alpha > 0)
 * - `1` = seed stroke paint laid on bare canvas (ignored as food and non-blocking so spores exit cleanly)
 * - `2..255` = grown mycelium thread density (treated as real only where layer alpha > 0)
 */
export interface LayerCulture {
  tick: number;
  nextId: number;
  tips: CultureTip[];
  occupancy: TiledSurface;
  segmentsTotal: number;
  status: CultureStatus;
}

export interface CultureRecordedFade {
  x: number;
  y: number;
  radius: number;
  fadePermille: number;
}

export interface CultureRecordedSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  widthFp: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  glowPermille: number;
}

export interface CultureGrowEventData {
  steps: number;
  fades: CultureRecordedFade[];
  segments: CultureRecordedSegment[];
}

export interface LayerCultureSummary {
  layerId: string;
  tick: number;
  tips: number;
  segments: number;
  bounds: RasterRect | null;
  status: CultureStatus;
}

const QUARTER_COS: readonly number[] = [
  256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 256, 255, 255, 255, 255, 255,
  255, 255, 254, 254, 254, 254, 254, 253, 253, 253, 253, 252, 252, 252, 252, 251,
  251, 251, 250, 250, 250, 249, 249, 249, 248, 248, 248, 247, 247, 246, 246, 245,
  245, 245, 244, 244, 243, 243, 242, 242, 241, 241, 240, 239, 239, 238, 238, 237,
  237, 236, 235, 235, 234, 233, 233, 232, 231, 231, 230, 229, 229, 228, 227, 227,
  226, 225, 224, 224, 223, 222, 221, 220, 220, 219, 218, 217, 216, 215, 215, 214,
  213, 212, 211, 210, 209, 208, 207, 207, 206, 205, 204, 203, 202, 201, 200, 199,
  198, 197, 196, 195, 194, 193, 192, 191, 190, 189, 188, 186, 185, 184, 183, 182,
  181, 180, 179, 178, 177, 175, 174, 173, 172, 171, 170, 168, 167, 166, 165, 164,
  162, 161, 160, 159, 157, 156, 155, 154, 152, 151, 150, 149, 147, 146, 145, 144,
  142, 141, 140, 138, 137, 136, 134, 133, 132, 130, 129, 128, 126, 125, 123, 122,
  121, 119, 118, 117, 115, 114, 112, 111, 109, 108, 107, 105, 104, 102, 101, 99,
  98, 97, 95, 94, 92, 91, 89, 88, 86, 85, 83, 82, 80, 79, 77, 76,
  74, 73, 71, 70, 68, 67, 65, 64, 62, 61, 59, 58, 56, 55, 53, 51,
  50, 48, 47, 45, 44, 42, 41, 39, 38, 36, 34, 33, 31, 30, 28, 27,
  25, 24, 22, 20, 19, 17, 16, 14, 13, 11, 9, 8, 6, 5, 3, 2,
  0,
];

/** Integer cosine in -256..256 for angle `a` (0..1023). */
export function cosFp(a: number): number {
  const q = a & CULTURE_ANGLE_MASK;
  if (q <= 256) return QUARTER_COS[q]!;
  if (q <= 512) return -QUARTER_COS[512 - q]!;
  if (q <= 768) return -QUARTER_COS[q - 512]!;
  return QUARTER_COS[1024 - q]!;
}

/** Integer sine in -256..256 for angle `a` (0..1023). */
export function sinFp(a: number): number {
  return cosFp((a - 256) & CULTURE_ANGLE_MASK);
}

/** Deterministic 32-bit unsigned integer avalanche hash. */
export function cultureHash32(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Smooth 8-bit integer value noise (0..255) for paper grain sensing at document pixel `(x, y)`. */
export function paperGrainByte(paperSeed: number, paperDepthPermille: number, x: number, y: number): number {
  if (paperDepthPermille <= 0) return 128;
  const cellX = x >> 3;
  const cellY = y >> 3;
  const fx = (x & 7) * 32; // 0..224
  const fy = (y & 7) * 32;
  const corner = (cx: number, cy: number) =>
    cultureHash32((paperSeed | 0) ^ Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy, 0x85ebca6b)) & 255;
  const c00 = corner(cellX, cellY);
  const c10 = corner(cellX + 1, cellY);
  const c01 = corner(cellX, cellY + 1);
  const c11 = corner(cellX + 1, cellY + 1);
  const top = (c00 * (256 - fx) + c10 * fx) >> 8;
  const bot = (c01 * (256 - fx) + c11 * fx) >> 8;
  const raw = (top * (256 - fy) + bot * fy) >> 8;
  return 128 + (((raw - 128) * paperDepthPermille / 1000) | 0);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Normalizes a brush `culture` facet, filling defaults and clamping ranges. */
export function normalizeCulture(input: unknown, fallback: CultureSettings = DEFAULT_CULTURE): CultureSettings {
  const c = (input && typeof input === 'object' ? input : {}) as Partial<CultureSettings>;
  return {
    species: c.species === 'mycelium' ? 'mycelium' : fallback.species,
    reach: round4(clamp(num(c.reach, fallback.reach), 1, 100)),
    branching: round4(clamp(num(c.branching, fallback.branching), 0, 1)),
    wander: round4(clamp(num(c.wander, fallback.wander), 0, 1)),
    appetite: round4(clamp(num(c.appetite, fallback.appetite), 0, 1)),
    digest: round4(clamp(num(c.digest, fallback.digest), 0, 1)),
    fuse: round4(clamp(num(c.fuse, fallback.fuse), 0, 1)),
    thickness: round4(clamp(num(c.thickness, fallback.thickness), 0.02, 0.5)),
    glow: round4(clamp(num(c.glow, fallback.glow), 0, 1)),
  };
}


// ---------------------------------------------------------------------------
// Fast tile-cached pixel accessors for deterministic integer simulation
// ---------------------------------------------------------------------------

class FastSurface {
  private readonly copies = new Map<TileKey, Uint8ClampedArray>();
  private lastKey: TileKey = -1;
  private lastRead: Uint8ClampedArray | null = null;
  private lastWriteKey: TileKey = -1;
  private lastWrite: Uint8ClampedArray | null = null;

  constructor(readonly base: TiledSurface) {}

  private peekTile(tx: number, ty: number): Uint8ClampedArray | null {
    const key = tileKey(tx, ty);
    if (key === this.lastKey) return this.lastRead;
    const data = this.copies.get(key) ?? this.base.tiles.get(key)?.data ?? null;
    this.lastKey = key;
    this.lastRead = data;
    return data;
  }

  private writeTile(tx: number, ty: number): Uint8ClampedArray {
    const key = tileKey(tx, ty);
    if (key === this.lastWriteKey && this.lastWrite) return this.lastWrite;
    let data = this.copies.get(key);
    if (!data) {
      const src = this.base.tiles.get(key);
      if (src) data = new Uint8ClampedArray(src.data);
      else {
        data = new Uint8ClampedArray(TILE * TILE * this.base.channels);
        if (this.base.defaultValue !== 0) data.fill(this.base.defaultValue);
      }
      this.copies.set(key, data);
    }
    this.lastKey = key;
    this.lastRead = data;
    this.lastWriteKey = key;
    this.lastWrite = data;
    return data;
  }

  readByte(x: number, y: number): number {
    const t = this.peekTile(x >> 8, y >> 8);
    if (!t) return this.base.defaultValue;
    return t[((y & 255) << 8) | (x & 255)]!;
  }

  writeByte(x: number, y: number, v: number): void {
    const t = this.writeTile(x >> 8, y >> 8);
    t[((y & 255) << 8) | (x & 255)] = v;
  }

  readRgba(x: number, y: number): [number, number, number, number] {
    const t = this.peekTile(x >> 8, y >> 8);
    if (!t) {
      const d = this.base.defaultValue;
      return [d, d, d, d];
    }
    const i = (((y & 255) << 8) | (x & 255)) << 2;
    return [t[i]!, t[i + 1]!, t[i + 2]!, t[i + 3]!];
  }

  readAlpha(x: number, y: number): number {
    const t = this.peekTile(x >> 8, y >> 8);
    if (!t) return this.base.defaultValue;
    const i = (((y & 255) << 8) | (x & 255)) << 2;
    return t[i + 3]!;
  }

  blendRgba(x: number, y: number, r: number, g: number, b: number, a: number, lockTransparency: boolean): void {
    if (a <= 0) return;
    const t = this.writeTile(x >> 8, y >> 8);
    const i = (((y & 255) << 8) | (x & 255)) << 2;
    const dstR = t[i]!;
    const dstG = t[i + 1]!;
    const dstB = t[i + 2]!;
    const dstA = t[i + 3]!;
    if (lockTransparency) {
      if (dstA === 0) return;
      t[i] = ((r * a + dstR * (255 - a) + 127) / 255) | 0;
      t[i + 1] = ((g * a + dstG * (255 - a) + 127) / 255) | 0;
      t[i + 2] = ((b * a + dstB * (255 - a) + 127) / 255) | 0;
      return;
    }
    if (dstA === 0) {
      t[i] = r;
      t[i + 1] = g;
      t[i + 2] = b;
      t[i + 3] = a;
      return;
    }
    const invA = 255 - a;
    const outA = a + (((dstA * invA + 127) / 255) | 0);
    if (outA <= 0) return;
    const srcWeight = a * 255;
    const dstWeight = dstA * invA;
    const denom = srcWeight + dstWeight;
    t[i] = ((r * srcWeight + dstR * dstWeight + (denom >> 1)) / denom) | 0;
    t[i + 1] = ((g * srcWeight + dstG * dstWeight + (denom >> 1)) / denom) | 0;
    t[i + 2] = ((b * srcWeight + dstB * dstWeight + (denom >> 1)) / denom) | 0;
    t[i + 3] = outA > 255 ? 255 : outA;
  }

  fadeAlpha(x: number, y: number, fadePermille: number): boolean {
    if (fadePermille <= 0) return false;
    const t = this.peekTile(x >> 8, y >> 8);
    if (!t) return false;
    const i = (((y & 255) << 8) | (x & 255)) << 2;
    const dstA = t[i + 3]!;
    if (dstA === 0) return false;
    const w = this.writeTile(x >> 8, y >> 8);
    const nextA = ((dstA * (1000 - fadePermille)) / 1000) | 0;
    w[i + 3] = nextA;
    if (nextA === 0) {
      w[i] = 0;
      w[i + 1] = 0;
      w[i + 2] = 0;
    }
    return true;
  }

  commit(): TiledSurface {
    if (!this.copies.size) return this.base;
    const tiles = new Map(this.base.tiles);
    const { channels, defaultValue } = this.base;
    for (const [key, data] of this.copies) {
      const tile = finishTile(data, channels, defaultValue);
      if (tile) tiles.set(key, tile);
      else tiles.delete(key);
    }
    return new TiledSurface(channels, tiles, defaultValue);
  }
}

// ---------------------------------------------------------------------------
// LayerCulture lifecycle helpers
// ---------------------------------------------------------------------------

export function emptyLayerCulture(): LayerCulture {
  return {
    tick: 0,
    nextId: 1,
    tips: [],
    occupancy: emptySurface(1, 0),
    segmentsTotal: 0,
    status: 'extinct',
  };
}

export function cloneLayerCulture(c: LayerCulture): LayerCulture {
  return {
    tick: c.tick,
    nextId: c.nextId,
    tips: c.tips.map((t) => ({ ...t })),
    occupancy: c.occupancy,
    segmentsTotal: c.segmentsTotal,
    status: c.status,
  };
}

export function translateLayerCulture(
  c: LayerCulture,
  dx: number,
  dy: number,
  canvasWidth: number,
  canvasHeight: number
): LayerCulture {
  const fdx = Math.round(dx) * CULTURE_FP;
  const fdy = Math.round(dy) * CULTURE_FP;
  const maxX = canvasWidth * CULTURE_FP;
  const maxY = canvasHeight * CULTURE_FP;
  const tips = c.tips
    .map((t) => ({ ...t, x: t.x + fdx, y: t.y + fdy }))
    .filter((t) => t.x >= 0 && t.y >= 0 && t.x < maxX && t.y < maxY);
  const status: CultureStatus =
    c.status === 'capped' ? 'capped' : tips.length > 0 ? 'growing' : 'extinct';
  return {
    tick: c.tick,
    nextId: c.nextId,
    tips,
    occupancy: translateSurface(c.occupancy, dx, dy),
    segmentsTotal: c.segmentsTotal,
    status,
  };
}

export function mergeLayerCultures(bottom: LayerCulture | undefined, top: LayerCulture | undefined): LayerCulture | undefined {
  if (!bottom && !top) return undefined;
  if (!bottom) return top ? cloneLayerCulture(top) : undefined;
  if (!top) return cloneLayerCulture(bottom);
  const occDraft = new FastSurface(bottom.occupancy);
  for (const [key, tile] of top.occupancy.tiles) {
    const tx = (key % (1 << 16)) - (1 << 15);
    const ty = Math.floor(key / (1 << 16)) - (1 << 15);
    const ox = tx * TILE;
    const oy = ty * TILE;
    const d = tile.data;
    for (let y = 0; y < TILE; y++) {
      const row = y * TILE;
      for (let x = 0; x < TILE; x++) {
        const v = d[row + x]!;
        if (v > occDraft.readByte(ox + x, oy + y)) occDraft.writeByte(ox + x, oy + y, v);
      }
    }
  }
  let nextId = Math.max(bottom.nextId, top.nextId);
  const combinedTips: CultureTip[] = [
    ...bottom.tips.map((t) => ({ ...t })),
    ...top.tips.map((t) => ({ ...t, id: nextId++ })),
  ].slice(0, MAX_CULTURE_TIPS);
  const segmentsTotal = Math.min(MAX_CULTURE_SEGMENTS, bottom.segmentsTotal + top.segmentsTotal);
  const capped =
    bottom.status === 'capped' ||
    top.status === 'capped' ||
    combinedTips.length >= MAX_CULTURE_TIPS ||
    segmentsTotal >= MAX_CULTURE_SEGMENTS;
  return {
    tick: Math.max(bottom.tick, top.tick),
    nextId,
    tips: capped ? [] : combinedTips,
    occupancy: occDraft.commit(),
    segmentsTotal,
    status: capped ? 'capped' : combinedTips.length > 0 ? 'growing' : 'extinct',
  };
}

/** Clears occupancy bytes where a non-culture stroke painted so existing tips treat fresh paint as food. */
export function clearOccupancyUnderStroke(
  culture: LayerCulture,
  beforeSurface: TiledSurface,
  afterSurface: TiledSurface
): LayerCulture {
  if (culture.occupancy.tileCount === 0) return culture;
  const occ = new FastSurface(culture.occupancy);
  const before = new FastSurface(beforeSurface);
  for (const [key, tile] of afterSurface.tiles) {
    if (!culture.occupancy.tiles.has(key)) continue;
    const tx = (key % (1 << 16)) - (1 << 15);
    const ty = Math.floor(key / (1 << 16)) - (1 << 15);
    const ox = tx * TILE;
    const oy = ty * TILE;
    const d = tile.data;
    for (let y = 0; y < TILE; y++) {
      const row = (y * TILE) << 2;
      for (let x = 0; x < TILE; x++) {
        const aAfter = d[row + (x << 2) + 3]!;
        if (aAfter === 0) continue;
        const px = ox + x;
        const py = oy + y;
        if (occ.readByte(px, py) >= 2 && aAfter >= before.readAlpha(px, py)) {
          occ.writeByte(px, py, 0);
        }
      }
    }
  }
  return { ...culture, occupancy: occ.commit() };
}


// ---------------------------------------------------------------------------
// Segment & fade rasterization (shared by live simulation and 2x replay)
// ---------------------------------------------------------------------------

function rasterizeFadeDisk(
  layer: FastSurface,
  occ: FastSurface | null,
  stencil: FastSurface | null,
  cx: number,
  cy: number,
  radius: number,
  fadePermille: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): void {
  if (fadePermille <= 0 || radius <= 0) return;
  const r2 = radius * radius;
  const x0 = Math.max(minX, cx - radius);
  const y0 = Math.max(minY, cy - radius);
  const x1 = Math.min(maxX - 1, cx + radius);
  const y1 = Math.min(maxY - 1, cy + radius);
  for (let py = y0; py <= y1; py++) {
    const dy = py - cy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      if (stencil && stencil.readByte(px, py) < 128) continue;
      if (occ && occ.readByte(px, py) !== 0) continue;
      const falloff = ((r2 - d2 + 1) * fadePermille / (r2 + 1)) | 0;
      if (falloff > 0) layer.fadeAlpha(px, py, falloff);
    }
  }
}

function rasterizeSegment(
  layer: FastSurface,
  occ: FastSurface | null,
  light: FastSurface | null,
  stencil: FastSurface | null,
  seg: CultureRecordedSegment,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  lockTransparency: boolean
): void {
  const x0 = seg.x0 >> 8;
  const y0 = seg.y0 >> 8;
  const x1 = seg.x1 >> 8;
  const y1 = seg.y1 >> 8;
  const radiusPx = Math.max(0, (seg.widthFp - 128) >> 8);
  const subAlpha = seg.widthFp < 256 ? Math.max(48, (seg.alpha * seg.widthFp) >> 8) : seg.alpha;
  const glowA = seg.glowPermille > 0 ? Math.min(255, ((subAlpha * seg.glowPermille) / 1000) | 0) : 0;

  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;

  for (;;) {
    if (radiusPx <= 0) {
      if (cx >= minX && cy >= minY && cx < maxX && cy < maxY) {
        if (!stencil || stencil.readByte(cx, cy) >= 128) {
          layer.blendRgba(cx, cy, seg.r, seg.g, seg.b, subAlpha, lockTransparency);
          if (occ && (!lockTransparency || layer.readAlpha(cx, cy) > 0)) {
            occ.writeByte(cx, cy, 200);
          }
          if (light && glowA > 0 && (!lockTransparency || layer.readAlpha(cx, cy) > 0)) {
            const cur = light.readByte(cx, cy);
            if (glowA > cur) light.writeByte(cx, cy, glowA);
          }
        }
      }
    } else {
      const r2 = radiusPx * radiusPx;
      const px0 = Math.max(minX, cx - radiusPx);
      const py0 = Math.max(minY, cy - radiusPx);
      const px1 = Math.min(maxX - 1, cx + radiusPx);
      const py1 = Math.min(maxY - 1, cy + radiusPx);
      for (let py = py0; py <= py1; py++) {
        const ody = py - cy;
        for (let px = px0; px <= px1; px++) {
          const odx = px - cx;
          if (odx * odx + ody * ody > r2) continue;
          if (stencil && stencil.readByte(px, py) < 128) continue;
          layer.blendRgba(px, py, seg.r, seg.g, seg.b, subAlpha, lockTransparency);
          if (occ && (!lockTransparency || layer.readAlpha(px, py) > 0)) {
            occ.writeByte(px, py, 200);
          }
          if (light && glowA > 0 && (!lockTransparency || layer.readAlpha(px, py) > 0)) {
            const cur = light.readByte(px, py);
            if (glowA > cur) light.writeByte(px, py, glowA);
          }
        }
      }
    }
    if (cx === x1 && cy === y1) break;
    const e2 = err << 1;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
}

// ---------------------------------------------------------------------------
// Spore seeding along a committed brush stroke
// ---------------------------------------------------------------------------

export interface SeedCultureInput {
  existing?: LayerCulture;
  points: ReadonlyArray<{ x: number; y: number }>;
  brushSize: number;
  color: readonly [number, number, number];
  culture: CultureSettings;
  strokeSeed: number;
  beforeSurface: TiledSurface;
  afterSurface: TiledSurface;
  canvasWidth: number;
  canvasHeight: number;
  offsetX?: number;
  offsetY?: number;
}

export function seedCultureFromStroke(input: SeedCultureInput): {
  culture: LayerCulture;
  seedsAdded: number;
} {
  const base = input.existing ? cloneLayerCulture(input.existing) : emptyLayerCulture();
  const occ = new FastSurface(base.occupancy);
  const before = new FastSurface(input.beforeSurface);

  // Mark bare-canvas pixels painted by this seed stroke with occupancy = 1 so the colony does not
  // treat its own seed stroke as external food, while pre-existing paint (`beforeAlpha > 0`) stays 0.
  for (const [key, tile] of input.afterSurface.tiles) {
    const tx = (key % (1 << 16)) - (1 << 15);
    const ty = Math.floor(key / (1 << 16)) - (1 << 15);
    const ox = tx * TILE;
    const oy = ty * TILE;
    const d = tile.data;
    for (let y = 0; y < TILE; y++) {
      const row = (y * TILE) << 2;
      for (let x = 0; x < TILE; x++) {
        const aAfter = d[row + (x << 2) + 3]!;
        if (aAfter === 0) continue;
        const px = ox + x;
        const py = oy + y;
        if (before.readAlpha(px, py) === 0 && occ.readByte(px, py) === 0) {
          occ.writeByte(px, py, 1);
        }
      }
    }
  }

  if (base.status === 'capped' || base.tips.length >= MAX_CULTURE_TIPS || input.points.length === 0) {
    return {
      culture: { ...base, occupancy: occ.commit() },
      seedsAdded: 0,
    };
  }

  const sizePx = Math.max(1, Math.round(input.brushSize));
  const spacingFp = Math.max(6, sizePx) * CULTURE_FP;
  const stations: Array<{ xFp: number; yFp: number }> = [];
  const p0 = input.points[0]!;
  stations.push({
    xFp: Math.round(p0.x * CULTURE_FP),
    yFp: Math.round(p0.y * CULTURE_FP),
  });

  let accumFp = 0;
  for (let i = 1; i < input.points.length; i++) {
    const a = input.points[i - 1]!;
    const b = input.points[i]!;
    const ax = Math.round(a.x * CULTURE_FP);
    const ay = Math.round(a.y * CULTURE_FP);
    const bx = Math.round(b.x * CULTURE_FP);
    const by = Math.round(b.y * CULTURE_FP);
    const dx = bx - ax;
    const dy = by - ay;
    const distFp = isqrt(dx * dx + dy * dy);
    if (distFp <= 0) continue;
    let cursor = spacingFp - accumFp;
    while (cursor <= distFp && stations.length < 128) {
      stations.push({
        xFp: ax + (((dx * cursor) / distFp) | 0),
        yFp: ay + (((dy * cursor) / distFp) | 0),
      });
      cursor += spacingFp;
    }
    accumFp = (accumFp + distFp) % spacingFp;
  }

  const c = normalizeCulture(input.culture);
  const reachBasePx = Math.max(8, sizePx);
  const reachPx = Math.max(4, Math.round(c.reach * reachBasePx));
  const initialEnergy = reachPx * 10;
  const widthFp = Math.max(64, Math.round(Math.max(2, input.brushSize) * c.thickness * CULTURE_FP));
  const branchPermille = Math.round(c.branching * 1000);
  const wanderPermille = Math.round(c.wander * 1000);
  const appetitePermille = Math.round(c.appetite * 1000);
  const digestPermille = Math.round(c.digest * 1000);
  const fusePermille = Math.round(c.fuse * 1000);
  const glowPermille = Math.round(c.glow * 1000);
  const r = clamp(Math.round(input.color[0]), 0, 255);
  const g = clamp(Math.round(input.color[1]), 0, 255);
  const b = clamp(Math.round(input.color[2]), 0, 255);

  const sporesPerStation = stations.length <= 2 ? 8 : 6;
  const angleStep = (CULTURE_ANGLE_STEPS / sporesPerStation) | 0;
  const ox = input.offsetX ?? 0;
  const oy = input.offsetY ?? 0;
  const minX = -ox * CULTURE_FP;
  const minY = -oy * CULTURE_FP;
  const maxX = (input.canvasWidth - ox) * CULTURE_FP;
  const maxY = (input.canvasHeight - oy) * CULTURE_FP;

  let nextId = base.nextId;
  let seedsAdded = 0;
  const tips = [...base.tips];

  for (let s = 0; s < stations.length; s++) {
    const st = stations[s]!;
    if (st.xFp < minX || st.yFp < minY || st.xFp >= maxX || st.yFp >= maxY) continue;
    for (let k = 0; k < sporesPerStation; k++) {
      if (tips.length >= MAX_CULTURE_TIPS) break;
      const id = nextId++;
      const tipSeed = cultureHash32(
        (input.strokeSeed | 0) ^ Math.imul(id, 0x9e3779b1) ^ Math.imul(s + 1, 0x85ebca6b)
      );
      const jitter = ((tipSeed & 63) - 32);
      const angle = (k * angleStep + jitter) & CULTURE_ANGLE_MASK;
      tips.push({
        id,
        x: st.xFp,
        y: st.yFp,
        angle,
        energy: initialEnergy,
        widthFp,
        r,
        g,
        b,
        age: 0,
        seed: tipSeed,
        reachPx,
        branchPermille,
        wanderPermille,
        appetitePermille,
        digestPermille,
        fusePermille,
        glowPermille,
      });
      seedsAdded++;
    }
    if (tips.length >= MAX_CULTURE_TIPS) break;
  }

  const capped = tips.length >= MAX_CULTURE_TIPS || base.segmentsTotal >= MAX_CULTURE_SEGMENTS;
  return {
    culture: {
      tick: base.tick,
      nextId,
      tips: capped ? tips.slice(0, MAX_CULTURE_TIPS) : tips,
      occupancy: occ.commit(),
      segmentsTotal: base.segmentsTotal,
      status: capped ? 'capped' : tips.length > 0 ? 'growing' : 'extinct',
    },
    seedsAdded,
  };
}


// ---------------------------------------------------------------------------
// Tick-by-tick integer growth simulation
// ---------------------------------------------------------------------------

export interface StepLayerCultureInput {
  culture: LayerCulture;
  surface: TiledSurface;
  lightSurface?: TiledSurface;
  stencilMask?: TiledSurface | null;
  lockTransparency?: boolean;
  paperSeed: number;
  paperDepthPermille: number;
  canvasWidth: number;
  canvasHeight: number;
  offsetX?: number;
  offsetY?: number;
  steps: number;
}

export interface StepLayerCultureResult {
  culture: LayerCulture;
  surface: TiledSurface;
  lightSurface?: TiledSurface;
  segmentsAdded: number;
  tipsAlive: number;
  status: CultureStatus;
  eventData: CultureGrowEventData;
}

const SENSOR_DISTANCES: readonly number[] = [6, 14, 26, 40, 56, 72];
const SENSOR_WEIGHTS: readonly number[] = [8, 7, 6, 5, 4, 3];
const STEP_FP = 384; // 1.5 px in 1/256 fixed-point

export function stepLayerCulture(input: StepLayerCultureInput): StepLayerCultureResult {
  const steps = Math.max(0, Math.floor(input.steps));
  if (steps === 0 || input.culture.status !== 'growing' || input.culture.tips.length === 0) {
    const status: CultureStatus =
      input.culture.status === 'capped'
        ? 'capped'
        : input.culture.tips.length > 0
          ? 'growing'
          : 'extinct';
    return {
      culture: { ...input.culture, status },
      surface: input.surface,
      lightSurface: input.lightSurface,
      segmentsAdded: 0,
      tipsAlive: input.culture.tips.length,
      status,
      eventData: { steps: 0, fades: [], segments: [] },
    };
  }

  const ox = input.offsetX ?? 0;
  const oy = input.offsetY ?? 0;
  const minX = -ox;
  const minY = -oy;
  const maxX = input.canvasWidth - ox;
  const maxY = input.canvasHeight - oy;
  const lockT = Boolean(input.lockTransparency);
  const paperSeed = input.paperSeed | 0;
  const paperDepth = input.paperDepthPermille | 0;

  const layer = new FastSurface(input.surface);
  const occ = new FastSurface(input.culture.occupancy);
  const stencil = input.stencilMask ? new FastSurface(input.stencilMask) : null;
  let light = input.lightSurface ? new FastSurface(input.lightSurface) : null;

  const recordedFades: CultureRecordedFade[] = [];
  const recordedSegments: CultureRecordedSegment[] = [];

  let tick = input.culture.tick;
  let nextId = input.culture.nextId;
  let segmentsTotal = input.culture.segmentsTotal;
  let segmentsAdded = 0;
  let tips = input.culture.tips.map((t) => ({ ...t }));
  let capped = false;

  const isBarrier = (px: number, py: number): boolean => {
    if (px < minX || py < minY || px >= maxX || py >= maxY) return true;
    if (stencil && stencil.readByte(px, py) < 128) return true;
    if (lockT && layer.readAlpha(px, py) === 0) return true;
    return false;
  };

  const effectiveOcc = (px: number, py: number): number => {
    if (px < minX || py < minY || px >= maxX || py >= maxY) return 255;
    if (layer.readAlpha(px, py) === 0) return 0;
    return occ.readByte(px, py);
  };

  const senseRay = (
    originXFp: number,
    originYFp: number,
    rayAngle: number,
    appetitePermille: number
  ): number => {
    const ca = cosFp(rayAngle);
    const sa = sinFp(rayAngle);
    let score = 0;

    // Short-range barrier, occupancy & paper grain sensing at 3 px and 6 px
    for (let d = 3; d <= 6; d += 3) {
      const sx = (originXFp + ca * d) >> 8;
      const sy = (originYFp + sa * d) >> 8;
      if (isBarrier(sx, sy)) {
        score -= 40000;
      } else {
        const eo = effectiveOcc(sx, sy);
        if (eo >= 2) score -= eo * 14;
        const grain = paperGrainByte(paperSeed, paperDepth, sx, sy) - 128;
        score += grain * 2;
      }
    }

    // Long-range chemotaxis toward foreign paint (occ === 0 && alpha > 0)
    if (appetitePermille > 0) {
      for (let i = 0; i < SENSOR_DISTANCES.length; i++) {
        const d = SENSOR_DISTANCES[i]!;
        const w = SENSOR_WEIGHTS[i]!;
        const sx = (originXFp + ca * d) >> 8;
        const sy = (originYFp + sa * d) >> 8;
        if (sx < minX || sy < minY || sx >= maxX || sy >= maxY) continue;
        if (stencil && stencil.readByte(sx, sy) < 128) break;
        if (occ.readByte(sx, sy) === 0) {
          const fa = layer.readAlpha(sx, sy);
          if (fa > 0) {
            score += (fa * appetitePermille * w) >> 7;
          }
        }
      }
    }
    return score;
  };

  for (let s = 0; s < steps; s++) {
    if (tips.length === 0 || capped) break;
    tick++;
    const nextTips: CultureTip[] = [];

    for (let ti = 0; ti < tips.length; ti++) {
      if (segmentsTotal >= MAX_CULTURE_SEGMENTS) {
        capped = true;
        break;
      }
      const tip = tips[ti]!;
      const x0 = tip.x >> 8;
      const y0 = tip.y >> 8;
      if (x0 < minX || y0 < minY || x0 >= maxX || y0 >= maxY) continue;

      const leftAngle = (tip.angle - 112) & CULTURE_ANGLE_MASK;
      const rightAngle = (tip.angle + 112) & CULTURE_ANGLE_MASK;
      let leftScore = senseRay(tip.x, tip.y, leftAngle, tip.appetitePermille);
      const centerScore = senseRay(tip.x, tip.y, tip.angle, tip.appetitePermille);
      let rightScore = senseRay(tip.x, tip.y, rightAngle, tip.appetitePermille);

      if (tip.appetitePermille > 0) {
        const wideLeft = senseRay(tip.x, tip.y, (tip.angle - 224) & CULTURE_ANGLE_MASK, tip.appetitePermille);
        const wideRight = senseRay(tip.x, tip.y, (tip.angle + 224) & CULTURE_ANGLE_MASK, tip.appetitePermille);
        if (wideLeft > leftScore) leftScore = (leftScore + wideLeft) >> 1;
        if (wideRight > rightScore) rightScore = (rightScore + wideRight) >> 1;
        if (leftScore <= 0 && centerScore <= 0 && rightScore <= 0) {
          const backLeft = senseRay(tip.x, tip.y, (tip.angle - 352) & CULTURE_ANGLE_MASK, tip.appetitePermille);
          const backRight = senseRay(tip.x, tip.y, (tip.angle + 352) & CULTURE_ANGLE_MASK, tip.appetitePermille);
          if (backLeft > leftScore) leftScore = backLeft >> 1;
          if (backRight > rightScore) rightScore = backRight >> 1;
        }
      }

      const h = cultureHash32(
        tip.seed ^ Math.imul(tick, 0x85ebca6b) ^ Math.imul(tip.id, 0xc2b2ae35)
      );

      let steerDelta = 0;
      if (leftScore > centerScore || rightScore > centerScore) {
        if (leftScore > rightScore) {
          const diff = leftScore - centerScore;
          steerDelta = -Math.min(96, 16 + (diff >> 5));
        } else if (rightScore > leftScore) {
          const diff = rightScore - centerScore;
          steerDelta = Math.min(96, 16 + (diff >> 5));
        } else {
          steerDelta = (h & 1) !== 0 ? 24 : -24;
        }
      }

      const maxFoodScore = Math.max(leftScore, centerScore, rightScore);
      const rawWander = (h & 255) - 128;
      let wanderDelta = ((rawWander * tip.wanderPermille) / 1400) | 0;
      if (maxFoodScore > 300 && tip.appetitePermille > 300) {
        wanderDelta >>= 1;
      }

      let nextAngle = (tip.angle + steerDelta + wanderDelta) & CULTURE_ANGLE_MASK;
      let nx = tip.x + ((cosFp(nextAngle) * STEP_FP) >> 8);
      let ny = tip.y + ((sinFp(nextAngle) * STEP_FP) >> 8);
      let x1 = nx >> 8;
      let y1 = ny >> 8;

      if (x1 < minX || y1 < minY || x1 >= maxX || y1 >= maxY) continue;

      if (isBarrier(x1, y1)) {
        // Turn away from stencil mask or locked-transparency boundary
        const alt1 = (tip.angle + (leftScore >= rightScore ? -224 : 224)) & CULTURE_ANGLE_MASK;
        const alt2 = (tip.angle + (leftScore >= rightScore ? 224 : -224)) & CULTURE_ANGLE_MASK;
        const alt3 = (tip.angle + 512) & CULTURE_ANGLE_MASK;
        let found = false;
        for (const cand of [alt1, alt2, alt3]) {
          const cnx = tip.x + ((cosFp(cand) * STEP_FP) >> 8);
          const cny = tip.y + ((sinFp(cand) * STEP_FP) >> 8);
          const cx1 = cnx >> 8;
          const cy1 = cny >> 8;
          if (!isBarrier(cx1, cy1)) {
            nextAngle = cand;
            nx = cnx;
            ny = cny;
            x1 = cx1;
            y1 = cy1;
            found = true;
            break;
          }
        }
        if (!found) continue;
      }

      // Check for anastomosis (meeting an existing thread ahead when not actively foraging toward food)
      const foraging = maxFoodScore > 300 && tip.appetitePermille > 0;
      const ax = (nx + cosFp(nextAngle) * 2) >> 8;
      const ay = (ny + sinFp(nextAngle) * 2) >> 8;
      if (!foraging && tip.age >= 3 && ax >= minX && ay >= minY && ax < maxX && ay < maxY && !isBarrier(ax, ay)) {
        const aheadOcc = effectiveOcc(ax, ay);
        const hereOcc = x1 !== x0 || y1 !== y0 ? effectiveOcc(x1, y1) : 0;
        if (aheadOcc >= 80 || hereOcc >= 160) {
          const fuseRoll = ((h >>> 8) & 0xffff) % 1000;
          if (fuseRoll < tip.fusePermille) {
            const bridgeSeg: CultureRecordedSegment = {
              x0: tip.x,
              y0: tip.y,
              x1: ax << 8,
              y1: ay << 8,
              widthFp: tip.widthFp,
              r: tip.r,
              g: tip.g,
              b: tip.b,
              alpha: 205,
              glowPermille: tip.glowPermille,
            };
            if (tip.glowPermille > 0 && !light) light = new FastSurface(emptySurface(1, 0));
            rasterizeSegment(layer, occ, light, stencil, bridgeSeg, minX, minY, maxX, maxY, lockT);
            recordedSegments.push(bridgeSeg);
            segmentsTotal++;
            segmentsAdded++;
            continue;
          } else {
            // Deflect away from existing mycelium and continue growing
            const deflect = (nextAngle + (leftScore >= rightScore ? -192 : 192)) & CULTURE_ANGLE_MASK;
            const dnx = tip.x + ((cosFp(deflect) * STEP_FP) >> 8);
            const dny = tip.y + ((sinFp(deflect) * STEP_FP) >> 8);
            const dx1 = dnx >> 8;
            const dy1 = dny >> 8;
            if (dx1 >= minX && dy1 >= minY && dx1 < maxX && dy1 < maxY && !isBarrier(dx1, dy1)) {
              nextAngle = deflect;
              nx = dnx;
              ny = dny;
              x1 = dx1;
              y1 = dy1;
            }
          }
        }
      }

      // Feeding on existing foreign paint (`occ === 0 && alpha > 0`)
      let tipR = tip.r;
      let tipG = tip.g;
      let tipB = tip.b;
      let energyGain = 0;
      let onFood = false;

      if (occ.readByte(x1, y1) === 0) {
        const [fr, fg, fb, fa] = layer.readRgba(x1, y1);
        if (fa > 0) {
          onFood = true;
          tipR = ((tipR * 650 + fr * 350 + 500) / 1000) | 0;
          tipG = ((tipG * 650 + fg * 350 + 500) / 1000) | 0;
          tipB = ((tipB * 650 + fb * 350 + 500) / 1000) | 0;
          energyGain = 14 + ((fa * 16) >> 8);
          if (tip.digestPermille > 0) {
            const feedRadius = Math.max(3, ((tip.widthFp + 255) >> 8) + 2);
            const fadePermille = ((tip.digestPermille * 450) / 1000) | 0;
            rasterizeFadeDisk(layer, occ, stencil, x1, y1, feedRadius, fadePermille, minX, minY, maxX, maxY);
            recordedFades.push({
              x: x1,
              y: y1,
              radius: feedRadius,
              fadePermille,
            });
          }
        }
      }

      const segAlpha = onFood && tip.digestPermille > 0 ? 180 : 215;
      const seg: CultureRecordedSegment = {
        x0: tip.x,
        y0: tip.y,
        x1: nx,
        y1: ny,
        widthFp: tip.widthFp,
        r: tipR,
        g: tipG,
        b: tipB,
        alpha: segAlpha,
        glowPermille: tip.glowPermille,
      };
      if (tip.glowPermille > 0 && !light) light = new FastSurface(emptySurface(1, 0));
      rasterizeSegment(layer, occ, light, stencil, seg, minX, minY, maxX, maxY, lockT);
      recordedSegments.push(seg);
      segmentsTotal++;
      segmentsAdded++;

      const maxEnergy = tip.reachPx * 15;
      const moveCost = foraging ? 6 : 10;
      const nextEnergy = Math.min(maxEnergy, tip.energy - moveCost + energyGain);
      if (nextEnergy <= 0) continue;

      const nextAge = tip.age + 1;
      let parentWidthFp = tip.widthFp;
      let parentAngle = nextAngle;

      // Branching (forking into a thinner daughter thread)
      if (tip.branchPermille > 0 && nextAge >= 3 && tip.widthFp >= 64) {
        const branchChance = ((tip.branchPermille * (onFood ? 140 : foraging ? 90 : 55)) / 1000) | 0;
        const branchRoll = ((h >>> 16) & 0xffff) % 1000;
        if (branchRoll < branchChance) {
          const remaining = tips.length - 1 - ti;
          if (nextTips.length + 1 + remaining >= MAX_CULTURE_TIPS) {
            capped = true;
          } else {
            const sign = (h & 1) !== 0 ? 1 : -1;
            const spread = 112 + ((h >>> 24) & 31);
            const childAngle = (nextAngle + sign * spread) & CULTURE_ANGLE_MASK;
            parentAngle = (nextAngle - sign * 48) & CULTURE_ANGLE_MASK;
            const childWidthFp = Math.max(52, ((tip.widthFp * 78) / 100) | 0);
            parentWidthFp = Math.max(52, ((tip.widthFp * 92) / 100) | 0);
            const childId = nextId++;
            nextTips.push({
              id: childId,
              x: nx,
              y: ny,
              angle: childAngle,
              energy: Math.max(10, ((nextEnergy * 80) / 100) | 0),
              widthFp: childWidthFp,
              r: tipR,
              g: tipG,
              b: tipB,
              age: 0,
              seed: cultureHash32(tip.seed ^ Math.imul(childId, 0x9e3779b1)),
              reachPx: tip.reachPx,
              branchPermille: tip.branchPermille,
              wanderPermille: tip.wanderPermille,
              appetitePermille: tip.appetitePermille,
              digestPermille: tip.digestPermille,
              fusePermille: tip.fusePermille,
              glowPermille: tip.glowPermille,
            });
          }
        }
      }

      if (nextTips.length < MAX_CULTURE_TIPS) {
        nextTips.push({
          ...tip,
          x: nx,
          y: ny,
          angle: parentAngle,
          energy: nextEnergy,
          widthFp: parentWidthFp,
          r: tipR,
          g: tipG,
          b: tipB,
          age: nextAge,
        });
      } else {
        capped = true;
      }
    }

    tips = capped ? [] : nextTips;
    if (segmentsTotal >= MAX_CULTURE_SEGMENTS) {
      capped = true;
      tips = [];
    }
  }

  const status: CultureStatus = capped ? 'capped' : tips.length > 0 ? 'growing' : 'extinct';
  return {
    culture: {
      tick,
      nextId,
      tips,
      occupancy: occ.commit(),
      segmentsTotal,
      status,
    },
    surface: layer.commit(),
    lightSurface: light ? light.commit() : input.lightSurface,
    segmentsAdded,
    tipsAlive: tips.length,
    status,
    eventData: {
      steps,
      fades: recordedFades,
      segments: recordedSegments,
    },
  };
}


// ---------------------------------------------------------------------------
// High-resolution replay & summaries
// ---------------------------------------------------------------------------

export function applyCultureGrowReplay(
  surface: TiledSurface,
  lightSurface: TiledSurface | undefined,
  stencilMask: TiledSurface | null | undefined,
  lockTransparency: boolean,
  data: CultureGrowEventData,
  scale: number,
  canvasWidth: number,
  canvasHeight: number
): { surface: TiledSurface; lightSurface?: TiledSurface } {
  const layer = new FastSurface(surface);
  const stencil = stencilMask ? new FastSurface(stencilMask) : null;
  let light = lightSurface ? new FastSurface(lightSurface) : null;

  for (const f of data.fades) {
    rasterizeFadeDisk(
      layer,
      null,
      stencil,
      Math.round(f.x * scale),
      Math.round(f.y * scale),
      Math.max(1, Math.round(f.radius * scale)),
      f.fadePermille,
      0,
      0,
      canvasWidth,
      canvasHeight
    );
  }

  for (const s of data.segments) {
    if (s.glowPermille > 0 && !light) light = new FastSurface(emptySurface(1, 0));
    rasterizeSegment(
      layer,
      null,
      light,
      stencil,
      {
        ...s,
        x0: Math.round(s.x0 * scale),
        y0: Math.round(s.y0 * scale),
        x1: Math.round(s.x1 * scale),
        y1: Math.round(s.y1 * scale),
        widthFp: Math.max(64, Math.round(s.widthFp * scale)),
      },
      0,
      0,
      canvasWidth,
      canvasHeight,
      lockTransparency
    );
  }

  return {
    surface: layer.commit(),
    lightSurface: light ? light.commit() : lightSurface,
  };
}

export function layerCultureSummary(layerId: string, culture: LayerCulture | undefined): LayerCultureSummary {
  if (!culture) {
    return {
      layerId,
      tick: 0,
      tips: 0,
      segments: 0,
      bounds: null,
      status: 'extinct',
    };
  }
  return {
    layerId,
    tick: culture.tick,
    tips: culture.tips.length,
    segments: culture.segmentsTotal,
    bounds: contentBounds(culture.occupancy),
    status: culture.status,
  };
}

export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = n;
  let y = (x + 1) >> 1;
  while (y < x) {
    x = y;
    y = (x + Math.floor(n / x)) >> 1;
  }
  return x;
}


// ---------------------------------------------------------------------------
// Document serialization (`cultures` extension)
// ---------------------------------------------------------------------------

export interface SavedLayerCulture {
  tick: number;
  nextId: number;
  tips: CultureTip[];
  occupancyRect?: RasterRect;
  occupancy?: string;
  segmentsTotal: number;
  status: CultureStatus;
}

export interface SavedCulturesExtension {
  layers?: Record<string, SavedLayerCulture>;
  growWhileClosed?: boolean;
  lastGrownAt?: number;
}

export function cultureToJSON(c: LayerCulture): SavedLayerCulture {
  const b = c.occupancy.bounds;
  return {
    tick: c.tick,
    nextId: c.nextId,
    tips: c.tips.map((t) => ({ ...t })),
    ...(b
      ? {
          occupancyRect: { ...b },
          occupancy: pngDataUrl(b.width, b.height, readRegion(c.occupancy, b), 1),
        }
      : {}),
    segmentsTotal: c.segmentsTotal,
    status: c.status,
  };
}

export function cultureFromJSON(raw: unknown): LayerCulture {
  if (!raw || typeof raw !== 'object') throw new Error('not a saved layer culture');
  const r = raw as Partial<SavedLayerCulture>;
  let occupancy = emptySurface(1, 0);
  if (r.occupancy && typeof r.occupancy === 'string' && r.occupancyRect) {
    const parsed = parseDataUrl(r.occupancy);
    if (!parsed) throw new Error('culture occupancy is not a PNG data URL');
    const decoded = decodePng(parsed.bytes, { keepGray: true });
    const gray =
      decoded.channels === 1
        ? decoded.data
        : Uint8ClampedArray.from({ length: decoded.width * decoded.height }, (_, i) => decoded.data[i * 4]!);
    occupancy = surfaceFromPixels(
      { width: decoded.width, height: decoded.height, data: gray },
      1,
      Math.round(r.occupancyRect.x),
      Math.round(r.occupancyRect.y)
    );
  }
  const tips: CultureTip[] = Array.isArray(r.tips)
    ? r.tips
        .filter((t): t is CultureTip => Boolean(t && typeof t === 'object' && typeof t.id === 'number'))
        .slice(0, MAX_CULTURE_TIPS)
        .map((t) => ({
          id: Math.round(t.id),
          x: Math.round(t.x),
          y: Math.round(t.y),
          angle: t.angle & CULTURE_ANGLE_MASK,
          energy: Math.round(t.energy),
          widthFp: Math.max(32, Math.round(t.widthFp)),
          r: clamp(Math.round(t.r), 0, 255),
          g: clamp(Math.round(t.g), 0, 255),
          b: clamp(Math.round(t.b), 0, 255),
          age: Math.max(0, Math.round(t.age)),
          seed: t.seed >>> 0,
          reachPx: Math.max(1, Math.round(t.reachPx)),
          branchPermille: clamp(Math.round(t.branchPermille), 0, 1000),
          wanderPermille: clamp(Math.round(t.wanderPermille), 0, 1000),
          appetitePermille: clamp(Math.round(t.appetitePermille), 0, 1000),
          digestPermille: clamp(Math.round(t.digestPermille), 0, 1000),
          fusePermille: clamp(Math.round(t.fusePermille), 0, 1000),
          glowPermille: clamp(Math.round(t.glowPermille), 0, 1000),
        }))
    : [];
  const segmentsTotal =
    typeof r.segmentsTotal === 'number' && Number.isFinite(r.segmentsTotal)
      ? Math.max(0, Math.round(r.segmentsTotal))
      : 0;
  const status: CultureStatus =
    r.status === 'capped' || tips.length >= MAX_CULTURE_TIPS || segmentsTotal >= MAX_CULTURE_SEGMENTS
      ? 'capped'
      : tips.length > 0
        ? 'growing'
        : 'extinct';
  return {
    tick: typeof r.tick === 'number' && Number.isFinite(r.tick) ? Math.max(0, Math.round(r.tick)) : 0,
    nextId: typeof r.nextId === 'number' && Number.isFinite(r.nextId) ? Math.max(1, Math.round(r.nextId)) : 1,
    tips,
    occupancy,
    segmentsTotal,
    status,
  };
}

export function culturesExtensionToJSON(state: {
  cultures?: Readonly<Record<string, LayerCulture>>;
  growWhileClosed?: boolean;
  lastGrownAt?: number;
}): SavedCulturesExtension | undefined {
  const layers: Record<string, SavedLayerCulture> = {};
  for (const [id, c] of Object.entries(state.cultures ?? {})) {
    if (c.tips.length > 0 || c.segmentsTotal > 0 || c.occupancy.tileCount > 0 || c.tick > 0) {
      layers[id] = cultureToJSON(c);
    }
  }
  const hasLayers = Object.keys(layers).length > 0;
  const growWhileClosed = state.growWhileClosed === true;
  const lastGrownAt =
    typeof state.lastGrownAt === 'number' && Number.isFinite(state.lastGrownAt)
      ? Math.round(state.lastGrownAt)
      : undefined;
  if (!hasLayers && !growWhileClosed && lastGrownAt === undefined) return undefined;
  return {
    ...(hasLayers ? { layers } : {}),
    ...(growWhileClosed ? { growWhileClosed: true } : {}),
    ...(lastGrownAt !== undefined ? { lastGrownAt } : {}),
  };
}

export function culturesExtensionFromJSON(
  raw: unknown,
  validLayerIds: ReadonlySet<string>,
  problems: string[]
): {
  cultures?: Record<string, LayerCulture>;
  growWhileClosed?: boolean;
  lastGrownAt?: number;
} {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as SavedCulturesExtension;
  const cultures: Record<string, LayerCulture> = {};
  if (r.layers && typeof r.layers === 'object') {
    for (const [id, entry] of Object.entries(r.layers)) {
      if (!validLayerIds.has(id)) continue;
      try {
        cultures[id] = cultureFromJSON(entry);
      } catch (e) {
        problems.push(`Layer "${id}" culture could not be read (${(e as Error).message}); skipped.`);
      }
    }
  }
  return {
    ...(Object.keys(cultures).length > 0 ? { cultures } : {}),
    ...(r.growWhileClosed === true ? { growWhileClosed: true } : {}),
    ...(typeof r.lastGrownAt === 'number' && Number.isFinite(r.lastGrownAt)
      ? { lastGrownAt: Math.round(r.lastGrownAt) }
      : {}),
  };
}
