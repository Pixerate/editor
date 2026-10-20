// High bit depth benchmark: memory and speed of 8-, 16- and 32-bit layers. The memory ratios are
// checked on every run (on a small image); the timing table only prints with DEEP_BENCH=1:
//
//   DEEP_BENCH=1 pnpm vitest run packages/core/tests/raster-deep.bench.test.ts
//
// DEEP_BENCH_W / DEEP_BENCH_H set the size (default 4000 × 3000).
import { describe, expect, it } from 'vitest';
import {
  convertSurfaceDepth,
  deepBytes,
  readDeepRegion,
  readRegion,
  surfaceBytes,
  surfaceFromDeepPixels,
  surfaceFromPixels,
  to16From8,
  to32From16,
} from '../src/raster';
import { exportPsd } from '../src/image-editor/psd/export';
import { importPsd } from '../src/image-editor/psd/import';
import type { PixelLayer } from '../src/image-editor';

function photo(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  let s = 7;
  for (let i = 0; i < data.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const p = i >> 2;
    data[i] = ((p % w) * 255) / w + (s & 15);
    data[i + 1] = (Math.floor(p / w) * 255) / h + ((s >> 4) & 15);
    data[i + 2] = (s >> 8) & 255;
    data[i + 3] = 255;
  }
  return data;
}

/** 16-bit samples with a sub-8-bit ripple, so no tile collapses to 8 bits. */
function deep16(px: Uint8ClampedArray): Uint16Array {
  const out = to16From8(px);
  for (let i = 0; i < out.length; i += 4) out[i] = Math.min(65535, out[i] + (i & 63));
  return out;
}

const time = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('high bit depth cost', () => {
  it('a 16-bit layer holds 3× and a 32-bit layer 5× the bytes of an 8-bit one (8-bit rendering included)', () => {
    const w = 512;
    const h = 512;
    const px = photo(w, h);
    const s8 = surfaceFromPixels({ width: w, height: h, data: px }, 4);
    const s16 = surfaceFromDeepPixels({ width: w, height: h, data: deep16(px) }, 4);
    const s32 = convertSurfaceDepth(s16, 32);
    const b8 = surfaceBytes(s8);
    expect(surfaceBytes(s16) + deepBytes(s16)).toBe(3 * b8);
    expect(surfaceBytes(s32) + deepBytes(s32)).toBe(5 * b8);
    // The 8-bit path reads the same kind of tiles at the same speed: only `data`.
    expect(readRegion(s16, { x: 0, y: 0, width: w, height: h }).length).toBe(w * h * 4);
  });

  it.runIf(process.env.DEEP_BENCH === '1')('prints the timing table', () => {
    const w = Number(process.env.DEEP_BENCH_W ?? 4000);
    const h = Number(process.env.DEEP_BENCH_H ?? 3000);
    const rect = { x: 0, y: 0, width: w, height: h };
    const px = photo(w, h);
    const d16 = deep16(px);
    const rows: Array<[string, string]> = [];
    let s8!: ReturnType<typeof surfaceFromPixels>;
    let s16!: ReturnType<typeof surfaceFromPixels>;
    let s32!: ReturnType<typeof surfaceFromPixels>;
    rows.push(['build 8-bit surface', `${time(() => (s8 = surfaceFromPixels({ width: w, height: h, data: px }, 4))).toFixed(0)} ms`]);
    rows.push(['build 16-bit surface', `${time(() => (s16 = surfaceFromDeepPixels({ width: w, height: h, data: d16 }, 4))).toFixed(0)} ms`]);
    rows.push(['convert 16 → 32', `${time(() => (s32 = convertSurfaceDepth(s16, 32))).toFixed(0)} ms`]);
    rows.push(['convert 32 → 16', `${time(() => convertSurfaceDepth(s32, 16)).toFixed(0)} ms`]);
    rows.push(['convert 16 → 8', `${time(() => convertSurfaceDepth(s16, 8)).toFixed(0)} ms`]);
    rows.push(['read 8-bit region (any layer)', `${time(() => readRegion(s16, rect)).toFixed(0)} ms`]);
    rows.push(['read 16-bit region', `${time(() => readDeepRegion(s16, rect, 16)).toFixed(0)} ms`]);
    rows.push(['read 32-bit region of a 16-bit layer', `${time(() => readDeepRegion(s16, rect, 32)).toFixed(0)} ms`]);
    rows.push(['16 → 32 samples (buffer)', `${time(() => to32From16(d16, 4)).toFixed(0)} ms`]);
    const layer: PixelLayer = { type: 'pixel', id: 'a', name: 'a', visible: true, opacity: 1, blend: 'normal', surface: s16, offset: { x: 0, y: 0 } };
    let bytes!: Uint8Array;
    rows.push(['export 16-bit PSD', `${time(() => (bytes = exportPsd({ width: w, height: h, layers: [layer], merged: px, depth: 16 }).bytes)).toFixed(0)} ms`]);
    rows.push(['import 16-bit PSD', `${time(() => importPsd(bytes)).toFixed(0)} ms`]);
    const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;
    rows.push(['memory 8-bit', mb(surfaceBytes(s8))]);
    rows.push(['memory 16-bit (+ 8-bit rendering)', mb(surfaceBytes(s16) + deepBytes(s16))]);
    rows.push(['memory 32-bit (+ 8-bit rendering)', mb(surfaceBytes(s32) + deepBytes(s32))]);
    rows.push(['16-bit PSD size', mb(bytes.length)]);
    console.log(`\nHigh bit depth, ${w} × ${h}\n${rows.map(([k, v]) => `${k.padEnd(40)} ${v}`).join('\n')}`);
  }, 600_000);
});
