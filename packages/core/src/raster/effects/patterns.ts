// Portions ported from photocraft-main/crates/compose/src/pattern.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Pattern paint for pattern overlays, pattern strokes and bevel textures: a tile repeated over
 * the plane from an origin (the layer's top-left when linked, else the canvas origin, plus the
 * phase), scaled and rotated about it. Samples are bilinear and wrap around, on premultiplied
 * colour, so whole-pixel placements at 100 % reproduce the tile exactly.
 *
 * Patterns come from the document (PSD pattern resources) or from the built-in set below, so a
 * pattern effect always has something to paint even in a document without patterns.
 */

/** A pattern tile: straight-alpha RGBA. */
export interface EffectPattern {
  id: string;
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A pattern converted once for sampling (premultiplied 0..1). */
export class PatternTile {
  readonly w: number;
  readonly h: number;
  private readonly px: Float32Array;

  constructor(p: Pick<EffectPattern, 'width' | 'height' | 'data'>) {
    this.w = Math.max(1, p.width | 0);
    this.h = Math.max(1, p.height | 0);
    const n = this.w * this.h;
    this.px = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = (p.data[i * 4 + 3] ?? 0) / 255;
      this.px[i * 4] = ((p.data[i * 4] ?? 0) / 255) * a;
      this.px[i * 4 + 1] = ((p.data[i * 4 + 1] ?? 0) / 255) * a;
      this.px[i * 4 + 2] = ((p.data[i * 4 + 2] ?? 0) / 255) * a;
      this.px[i * 4 + 3] = a;
    }
  }

  /** Bilinear wrapping sample at tile coordinates (pixel centres at `i + 0.5`), straight alpha into `out`. */
  sample(u: number, v: number, out: Float32Array | number[]): void {
    u -= 0.5;
    v -= 0.5;
    const x0 = Math.floor(u);
    const y0 = Math.floor(v);
    const fx = u - x0;
    const fy = v - y0;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let dy = 0; dy < 2; dy++) {
      const wy = dy ? fy : 1 - fy;
      if (wy === 0) continue;
      const yi = (((y0 + dy) % this.h) + this.h) % this.h;
      for (let dx = 0; dx < 2; dx++) {
        const wx = dx ? fx : 1 - fx;
        if (wx === 0) continue;
        const xi = (((x0 + dx) % this.w) + this.w) % this.w;
        const k = wx * wy;
        const i = (yi * this.w + xi) * 4;
        r += this.px[i] * k;
        g += this.px[i + 1] * k;
        b += this.px[i + 2] * k;
        a += this.px[i + 3] * k;
      }
    }
    if (a <= 0) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return;
    }
    out[0] = r / a;
    out[1] = g / a;
    out[2] = b / a;
    out[3] = Math.min(1, a);
  }
}

/** Where a pattern sits: maps a document point to tile coordinates. */
export class PatternPlacement {
  private readonly ox: number;
  private readonly oy: number;
  private readonly c: number;
  private readonly s: number;
  private readonly inv: number;

  /** `anchor`: the layer's top-left (used when `link`); `phase` in px; `scale` a fraction; `angle` degrees counter-clockwise. */
  constructor(anchor: { x: number; y: number }, link: boolean, phase: { x: number; y: number }, scale: number, angle: number) {
    const bx = link ? anchor.x : 0;
    const by = link ? anchor.y : 0;
    this.ox = bx + phase.x;
    this.oy = by + phase.y;
    this.inv = Number.isFinite(scale) && scale > 1e-3 ? 1 / scale : 1;
    const a = ((Number.isFinite(angle) ? angle : 0) * Math.PI) / 180;
    this.c = Math.cos(a);
    this.s = Math.sin(a);
  }

  /** Tile coordinates of the document point `(x, y)` into `out[0..1]`. */
  map(x: number, y: number, out: number[]): void {
    const dx = x - this.ox;
    const dy = y - this.oy;
    // Undo a counter-clockwise rotation (y points down).
    out[0] = (dx * this.c - dy * this.s) * this.inv;
    out[1] = (dx * this.s + dy * this.c) * this.inv;
  }
}

// ---------------------------------------------------------------------------
// Built-in patterns
// ---------------------------------------------------------------------------

type Painter = (x: number, y: number) => [number, number, number, number];

const BUILTINS: Record<string, { name: string; size: number; paint: Painter }> = {
  checker: { name: 'Checker', size: 16, paint: (x, y) => ((x < 8) !== (y < 8) ? [204, 204, 204, 255] : [255, 255, 255, 255]) },
  stripes: { name: 'Diagonal Stripes', size: 16, paint: (x, y) => ((x + y) % 16 < 8 ? [40, 40, 40, 255] : [235, 235, 235, 255]) },
  dots: {
    name: 'Dots',
    size: 12,
    paint: (x, y) => {
      const d = Math.hypot(x + 0.5 - 6, y + 0.5 - 6);
      const a = Math.max(0, Math.min(1, 3.5 - d));
      return [Math.round(255 - a * 215), Math.round(255 - a * 215), Math.round(255 - a * 215), 255];
    },
  },
  grid: { name: 'Grid', size: 16, paint: (x, y) => (x === 0 || y === 0 ? [90, 90, 90, 255] : [250, 250, 250, 255]) },
  noise: {
    name: 'Noise',
    size: 64,
    paint: (x, y) => {
      const v = Math.round(hashNoise(x, y) * 255);
      return [v, v, v, 255];
    },
  },
};

/** Ids of the built-in patterns (`checker`, `stripes`, `dots`, `grid`, `noise`). */
export function builtinPatternIds(): string[] {
  return Object.keys(BUILTINS);
}

const builtinCache = new Map<string, EffectPattern>();

/** A built-in pattern by id, or `null`. */
export function builtinPattern(id: string): EffectPattern | null {
  const def = BUILTINS[id];
  if (!def) return null;
  let p = builtinCache.get(id);
  if (!p) {
    const data = new Uint8ClampedArray(def.size * def.size * 4);
    for (let y = 0; y < def.size; y++) {
      for (let x = 0; x < def.size; x++) data.set(def.paint(x, y), (y * def.size + x) * 4);
    }
    p = { id, name: def.name, width: def.size, height: def.size, data };
    builtinCache.set(id, p);
  }
  return p;
}

/**
 * Deterministic per-pixel value in 0..1 hashed from document coordinates, so effect noise is
 * stable across renders and tiles (photocraft's `hash_noise`).
 */
export function hashNoise(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ 0x9e3779b9;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h & 0xffff) / 65536;
}
