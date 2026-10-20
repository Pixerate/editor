// Portions ported from photocraft/crates/paint/src/rng.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Counter-based seeded randomness on 32-bit integer hashes: every value is a pure function of its
 * inputs, so strokes and papers regenerate identically on every machine. Shared by the paint
 * engine (`/paint`) and the paint editor (which re-exports it from `noise.ts`).
 */

/** A 32-bit finaliser (murmur3's `fmix32`). */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of integer coordinates and a salt to [0, 1). */
export function hash2(x: number, y: number, salt: number): number {
  const h = mix32((Math.imul(x | 0, 0x27d4eb2d) ^ mix32((y | 0) + Math.imul(salt | 0, 0x165667b1))) >>> 0);
  return h / 4294967296;
}

/** Uniform in [0, 1) from a seed, an index and a stream (one stream per random quantity). */
export function rand01(seed: number, index: number, stream: number): number {
  return hash2(index, stream, seed);
}

