// Portions ported from photocraft/crates/paint/src/procedural.rs and rng.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Seeded, deterministic noise for paper grain and brush jitter (photocraft's counter-based
 * randomness and tileable value noise, on 32-bit integer hashes instead of 64-bit ones so it runs
 * fast in JavaScript). Every value is a pure function of its inputs, so a paper or a stroke
 * regenerates identically on every machine.
 */

export { mix32, hash2, rand01 } from '../paint/rand';
import { hash2, mix32, rand01 } from '../paint/rand';

/** Uniform in [-1, 1). */
export function randSigned(seed: number, index: number, stream: number): number {
  return rand01(seed, index, stream) * 2 - 1;
}

/** A seed from a string (FNV-1a, then mixed). */
export function seedFromString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h >>> 0);
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** A periodic lattice of `px × py` random values, sampled with smooth interpolation. */
class Lattice {
  readonly values: Float32Array;
  constructor(readonly px: number, readonly py: number, salt: number) {
    this.values = new Float32Array(px * py);
    for (let j = 0; j < py; j++) for (let i = 0; i < px; i++) this.values[j * px + i] = hash2(i, j, salt);
  }

  /** Value noise at (x, y) in lattice cells; wraps every `px` / `py` cells. */
  at(x: number, y: number): number {
    const { px, py } = this;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = smooth(x - x0);
    const ty = smooth(y - y0);
    const i0 = ((x0 % px) + px) % px;
    const j0 = ((y0 % py) + py) % py;
    const i1 = (i0 + 1) % px;
    const j1 = (j0 + 1) % py;
    const v = this.values;
    const a = v[j0 * px + i0] + (v[j0 * px + i1] - v[j0 * px + i0]) * tx;
    const b = v[j1 * px + i0] + (v[j1 * px + i1] - v[j1 * px + i0]) * tx;
    return a + (b - a) * ty;
  }
}

/**
 * Tileable fractal value noise in 0..1 over a `size`-pixel square: `cellsX × cellsY` lattice cells
 * at the base octave (unequal counts give fibres and streaks), doubling per octave, so the result
 * repeats exactly every `size` pixels.
 */
export class TileableNoise {
  private readonly octaves: Lattice[] = [];

  constructor(readonly size: number, cellsX: number, cellsY: number, octaves: number, salt: number) {
    let cx = Math.max(1, Math.round(cellsX));
    let cy = Math.max(1, Math.round(cellsY));
    for (let o = 0; o < octaves; o++) {
      this.octaves.push(new Lattice(cx, cy, (salt + o * 7919) | 0));
      cx *= 2;
      cy *= 2;
    }
  }

  /** Fractal noise at pixel (x, y). */
  at(x: number, y: number): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    const u = x / this.size;
    const v = y / this.size;
    for (const l of this.octaves) {
      sum += l.at(u * l.px, v * l.py) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return norm > 0 ? sum / norm : 0.5;
  }
}
