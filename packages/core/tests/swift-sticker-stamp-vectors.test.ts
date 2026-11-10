import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeStickerProvider } from '../src/stickers';
import { renderStickerStamp, renderStickerStampFrom, type StickerArt } from '../src/paint-editor';
import { syntheticArt } from './helpers/sticker-art';

/**
 * Sticker stamp vectors (#738): `renderStickerStamp` of the fake sticker provider's art (static and
 * animated, tintable and not, a dark variant), of synthetic art (non-square, upscaled, animated) and
 * of an editor stamp. `StickerStampTests` in `packages/swift/Tests/PixeratePaintTests` reads this
 * fixture and must reproduce every byte. Run with UPDATE_SWIFT_VECTORS=1 to rewrite it after an
 * intended change.
 */
const FILE = join(__dirname, 'fixtures/swift-sticker-stamp-vectors.json');

interface Case {
  name: string;
  /** A fake-provider (or editor) ref, loaded through `renderStickerStampFrom`. */
  ref?: string;
  dark?: boolean;
  /** Or synthetic art: `syntheticArt(width, height, frames, tintable)`. */
  synthetic?: { width: number; height: number; frames: number; tintable: boolean };
  colour: string;
  size: number;
  frame?: number;
  rotation?: number;
}

const CASES: Case[] = [
  { name: 'tintable static', ref: 'fake:weather-sun', colour: '#3366cc', size: 32 },
  { name: 'tintable static, turned', ref: 'fake:badge-sale', colour: '#ABCDEF', size: 29, rotation: 30 },
  { name: 'own pixels', ref: 'fake:fruit-apple', colour: '#00ff00', size: 32, rotation: -15 },
  { name: 'own pixels, dark variant', ref: 'fake:fruit-pear', dark: true, colour: '#00ff00', size: 24 },
  { name: 'animated frame 1', ref: 'fake:weather-wind', colour: '#14b8a6', size: 30, frame: 1 },
  { name: 'animated frame 6 wraps to 2', ref: 'fake:weather-wind', colour: '#14b8a6', size: 30, frame: 6, rotation: 45 },
  { name: 'animated frame -1 is the last', ref: 'fake:weather-wind', colour: '#e11d48', size: 30, frame: -1 },
  { name: 'editor stamp', ref: 'editor:star', colour: '#e11d48', size: 28, rotation: 15 },
  { name: 'synthetic upscaled, own pixels', synthetic: { width: 12, height: 8, frames: 3, tintable: false }, colour: '#000000', size: 37, frame: -2, rotation: -20 },
  { name: 'synthetic tintable, invalid colour draws black', synthetic: { width: 12, height: 8, frames: 1, tintable: true }, colour: 'red', size: 20, rotation: 90 },
  { name: 'size 1', synthetic: { width: 12, height: 8, frames: 1, tintable: false }, colour: '#000000', size: 1 },
  { name: 'size 0 is empty', ref: 'fake:weather-sun', colour: '#3366cc', size: 0 },
];

async function vectors() {
  const fake = createFakeStickerProvider();
  const out = [];
  for (const c of CASES) {
    const opts = { colour: c.colour, size: c.size, frame: c.frame, rotation: c.rotation };
    let stamp;
    if (c.synthetic) {
      const art: StickerArt = syntheticArt(c.synthetic.width, c.synthetic.height, c.synthetic.frames, c.synthetic.tintable);
      stamp = renderStickerStamp(art, opts);
    } else {
      stamp = await renderStickerStampFrom(fake, c.ref!, { ...opts, dark: c.dark });
    }
    out.push({ ...c, width: stamp.width, height: stamp.height, data: Buffer.from(stamp.data).toString('base64') });
  }
  return out;
}

describe('Swift sticker stamp vectors', () => {
  it('match the committed fixture (the Swift tests read it)', async () => {
    const now = JSON.stringify({ cases: await vectors() }) + '\n';
    if (process.env.UPDATE_SWIFT_VECTORS) writeFileSync(FILE, now);
    expect(readFileSync(FILE, 'utf8')).toBe(now);
  });
});
