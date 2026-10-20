// Portions ported from photocraft/crates/paint/src/procedural.rs and rng.rs (MIT OR Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.

/**
 * Seeded, deterministic noise for paper grain and brush jitter (photocraft's counter-based
 * randomness and tileable value noise, on 32-bit integer hashes instead of 64-bit ones so it runs
 * fast in JavaScript). Every value is a pure function of its inputs, so a paper or a stroke
 * regenerates identically on every machine.
 */

export { mix32, hash2, rand01, randSigned, seedFromString, TileableNoise } from '../paint/rand';
