import { describe, expect, it } from 'vitest';
import * as nodeZlib from 'node:zlib';
import { deflate, deflateRaw, inflate, inflateRaw, ZlibError } from '../src/image-editor/layers/zlib';
import { base64ToBytes, bytesToBase64, decodePng, encodePng, parseDataUrl, pngDataUrl } from '../src/image-editor/layers/png';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function samples(): Uint8Array[] {
  const r = rng(7);
  const random = new Uint8Array(70000).map(() => Math.floor(r() * 256));
  const runs = new Uint8Array(200000).map((_, i) => (Math.floor(i / 1000) * 37) & 255);
  const text = new TextEncoder().encode('the quick brown fox jumps over the lazy dog '.repeat(3000));
  const mixed = new Uint8Array(150000).map((_, i) => (i % 7 === 0 ? Math.floor(r() * 256) : i & 15));
  return [new Uint8Array(0), new Uint8Array([42]), random, runs, text, mixed];
}

describe('zlib', () => {
  it('round-trips through its own deflate and inflate', () => {
    for (const data of samples()) {
      expect(inflate(deflate(data))).toEqual(data);
      expect(inflateRaw(deflateRaw(data, 0))).toEqual(data);
    }
  });

  it('writes streams Node zlib reads, and reads streams Node zlib writes', () => {
    for (const data of samples()) {
      expect(new Uint8Array(nodeZlib.inflateSync(deflate(data)))).toEqual(data);
      expect(new Uint8Array(nodeZlib.inflateRawSync(deflateRaw(data)))).toEqual(data);
      for (const level of [0, 1, 6, 9]) {
        expect(inflate(new Uint8Array(nodeZlib.deflateSync(data, { level })))).toEqual(data);
      }
    }
  });

  it('compresses repetitive data', () => {
    const runs = samples()[3];
    expect(deflate(runs).length).toBeLessThan(runs.length / 50);
  });

  it('refuses output beyond the limit and damaged streams', () => {
    const big = new Uint8Array(100000);
    expect(() => inflate(deflate(big), { maxOutput: 1000 })).toThrow(ZlibError);
    const z = deflate(samples()[4]);
    z[z.length - 1] ^= 1;
    expect(() => inflate(z)).toThrow(/Adler/);
    expect(() => inflate(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(ZlibError);
  });
});

describe('png', () => {
  it('round-trips RGBA and grey pixels exactly', () => {
    const r = rng(3);
    const w = 37;
    const h = 23;
    const rgba = new Uint8ClampedArray(w * h * 4).map(() => Math.floor(r() * 256));
    const png = encodePng(w, h, rgba, 4);
    const back = decodePng(png);
    expect(back).toMatchObject({ width: w, height: h, channels: 4 });
    expect(back.data).toEqual(rgba);
    const gray = new Uint8ClampedArray(w * h).map((_, i) => (i * 7) & 255);
    const g = decodePng(encodePng(w, h, gray, 1), { keepGray: true });
    expect(g.channels).toBe(1);
    expect(g.data).toEqual(gray);
  });

  it('base64 and data URLs round-trip', () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 31) & 255);
    for (const n of [0, 1, 2, 3, 999, 1000]) {
      const b = bytes.subarray(0, n);
      expect(bytesToBase64(b)).toBe(Buffer.from(b).toString('base64'));
      expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
    }
    const url = pngDataUrl(2, 1, [1, 2, 3, 4, 5, 6, 7, 8]);
    const parsed = parseDataUrl(url)!;
    expect(parsed.mime).toBe('image/png');
    expect(decodePng(parsed.bytes).data).toEqual(new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('rejects non-PNG data', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/Not a PNG/);
  });
});
