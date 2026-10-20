/**
 * `@pixerate/editor/cms`: ICC colour management in TypeScript (a port of photocraft's
 * `crates/cms`). Parses ICC v2 / v4 profiles (matrix/TRC, grey TRC, `mft1` / `mft2` / `mAB ` /
 * `mBA ` LUTs incl. CMYK ↔ Lab), writes ICC v4.3, converts between profiles with all four
 * rendering intents and black point compensation, builds soft-proofing chains and gamut checks,
 * ships built-in sRGB, Display P3, Adobe RGB-compatible, ProPhoto-compatible, linear sRGB,
 * Rec. 2020, grey, Lab and a synthetic coated CMYK profile, and reads and writes embedded
 * profiles in PNG, JPEG and PSD. No DOM, no framework, no wasm: it runs in Node and in Workers,
 * synchronously.
 */

export * from './math';
export * from './curve';
export * from './clut';
export * from './pipeline';
export * from './profile';
export * from './write';
export * from './transform';
export * from './synth';
export * from './builtin';
export * from './embed';
