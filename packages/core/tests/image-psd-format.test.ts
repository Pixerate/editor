import { describe, expect, it } from 'vitest';
import { PsdError, PsdReader, PsdWriter, decodeLegacyName, encodeLegacyName } from '../src/image-editor/psd/binary';
import {
  descNumber,
  descriptor,
  parseVersionedDescriptor,
  versionedDescriptorBytes,
  type Descriptor,
} from '../src/image-editor/psd/descriptor';
import { decodePlanes, encodeRle, encodeZip, packbitsBound, packbitsDecodeInto, packbitsEncode } from '../src/image-editor/psd/compression';
import { canonicalBounds, parseAdjustmentBlock, writeAdjustmentBlock } from '../src/image-editor/psd/adjust';
import { defaultAdjustmentParams } from '../src/image-editor/adjustment-layers';
import { deflate } from '../src/raster/zlib';
import { layerName, layerTree, readPsd, writePsd, type PsdFile, type PsdLayerRecord } from '../src/image-editor/psd/file';
import type { AdjustmentKind } from '../src/image-editor/types';

describe('PSD binary reader and writer', () => {
  it('round-trips big-endian values, Pascal and Unicode strings', () => {
    const w = new PsdWriter();
    w.u8(200);
    w.i16(-2);
    w.u32(0xdeadbeef);
    w.i32(-5);
    w.u64(2 ** 40 + 7);
    w.f64(1.25);
    w.pascal(encodeLegacyName('Layer 1'), 4);
    w.unicode('Ünïcødé', true);
    const r = new PsdReader(w.result());
    expect([r.u8(), r.i16(), r.u32(), r.i32(), r.u64(), r.f64()]).toEqual([200, -2, 0xdeadbeef, -5, 2 ** 40 + 7, 1.25]);
    expect(decodeLegacyName(r.pascal(4))).toBe('Layer 1');
    expect(r.unicode()).toBe('Ünïcødé');
    expect(r.remaining).toBe(0);
  });

  it('never reads past the end, and refuses counts that cannot fit', () => {
    const r = new PsdReader(Uint8Array.from([0, 0, 0, 9]));
    expect(() => r.u64()).toThrow(PsdError);
    const s = new PsdReader(Uint8Array.from([0, 0, 0, 200, 1, 2]));
    expect(() => s.unicode()).toThrow(/does not fit/);
    expect(() => new PsdReader(new Uint8Array(3)).sub(4)).toThrow(/Unexpected end/);
  });

  it('legacy names fall back to Latin-1 and are written as ASCII', () => {
    expect(decodeLegacyName(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
    expect(decodeLegacyName(new TextEncoder().encode('café'))).toBe('café');
    expect(Array.from(encodeLegacyName('é1'))).toEqual([63, 49]);
  });
});

describe('PSD descriptors', () => {
  it('round-trips every value type', () => {
    const inner = descriptor('RGBC', [['Rd  ', { type: 'doub', value: 12.5 }]]);
    const d: Descriptor = descriptor('null', [
      ['vibrance', { type: 'long', value: -12 }],
      ['Strt', { type: 'UntF', unit: '#Prc', value: 40 }],
      ['list', { type: 'VlLs', items: [{ type: 'bool', value: true }, { type: 'TEXT', value: 'hi' }] }],
      ['Clr ', { type: 'Objc', value: inner }],
      ['enum', { type: 'enum', typeId: 'BlnM', value: 'Nrml' }],
      ['raw', { type: 'tdta', data: Uint8Array.from([1, 2, 3]) }],
      ['big', { type: 'comp', value: 2 ** 33 + 5 }],
      ['ref', { type: 'obj ', items: [{ type: 'Enmr', class: { name: '', classId: 'Lyr ' }, typeId: 'Ordn', value: 'Trgt' }] }],
      ['ufl', { type: 'UnFl', unit: '#Pxl', values: [1, 2] }],
      ['cls', { type: 'type', class: { name: 'x', classId: 'Clss' } }],
    ]);
    const back = parseVersionedDescriptor(versionedDescriptorBytes(d));
    expect(back).toEqual(d);
    expect(descNumber(back, 'Strt')).toBe(40);
  });

  it('rejects unknown versions and value types with a reason', () => {
    expect(() => parseVersionedDescriptor(Uint8Array.from([0, 0, 0, 3]))).toThrow(/version 3/);
    const bytes = versionedDescriptorBytes(descriptor('null', [['x', { type: 'long', value: 1 }]]));
    bytes.set([0x5a, 0x5a, 0x5a, 0x5a], bytes.length - 8);
    expect(() => parseVersionedDescriptor(bytes)).toThrow(/Unsupported descriptor value type/);
  });
});

describe('PSD compression', () => {
  it('PackBits round-trips runs and literals', () => {
    const src = Uint8Array.from([1, 1, 1, 1, 2, 3, 4, 4, 5, ...new Array(300).fill(9), 7]);
    const out = new Uint8Array(packbitsBound(src.length));
    const n = packbitsEncode(src, out, 0);
    expect(n).toBeLessThan(src.length);
    const back = new Uint8Array(src.length);
    expect(packbitsDecodeInto(out.subarray(0, n), src.length, back, 0)).toBe(src.length);
    expect(Buffer.from(back).equals(Buffer.from(src))).toBe(true);
  });

  it('decodes raw, RLE (PSD and PSB counts), ZIP and ZIP with prediction', () => {
    const width = 5;
    const height = 3;
    const plane = Uint8Array.from({ length: width * height * 2 }, (_, i) => (i * 37) % 256);
    const layout = { planes: 2, width, height, depth: 8, psb: false };
    expect(Array.from(decodePlanes(0, plane, layout))).toEqual(Array.from(plane));
    expect(Array.from(decodePlanes(1, encodeRle(plane, layout), layout))).toEqual(Array.from(plane));
    const psb = { ...layout, psb: true };
    expect(Array.from(decodePlanes(1, encodeRle(plane, psb), psb))).toEqual(Array.from(plane));
    expect(Array.from(decodePlanes(2, encodeZip(plane), layout))).toEqual(Array.from(plane));
    // Prediction: each row stores differences from the previous sample.
    const predicted = plane.slice();
    for (let o = 0; o < predicted.length; o += width) for (let i = width - 1; i > 0; i--) predicted[o + i] = (predicted[o + i] - predicted[o + i - 1]) & 255;
    expect(Array.from(decodePlanes(3, deflate(predicted), layout))).toEqual(Array.from(plane));
  });

  it('16-bit prediction works on whole samples', () => {
    const values = [1000, 1003, 65535, 2];
    const raw = new Uint8Array(8);
    values.forEach((v, i) => raw.set([v >> 8, v & 255], i * 2));
    const pred = new Uint8Array(8);
    values.forEach((v, i) => {
      const d = (v - (i ? values[i - 1] : 0) + 65536) & 0xffff;
      const s = i ? d : v;
      pred.set([s >> 8, s & 255], i * 2);
    });
    expect(Array.from(decodePlanes(3, deflate(pred), { planes: 1, width: 4, height: 1, depth: 16, psb: false }))).toEqual(Array.from(raw));
  });

  it('refuses truncated data with a message', () => {
    const layout = { planes: 1, width: 4, height: 2, depth: 8, psb: false };
    expect(() => decodePlanes(0, new Uint8Array(3), layout)).toThrow(/Raw channel data/);
    expect(() => decodePlanes(1, Uint8Array.from([0, 3, 0, 3, 3, 1]), layout)).toThrow(PsdError);
    expect(() => decodePlanes(2, Uint8Array.from([1, 2, 3, 4, 5, 6]), layout)).toThrow(/ZIP/);
    expect(() => decodePlanes(9, new Uint8Array(8), layout)).toThrow(/compression method 9/);
  });
});

describe('PSD adjustment blocks', () => {
  const kinds: AdjustmentKind[] = ['curves', 'levels', 'hueSaturation', 'vibrance', 'colorBalance', 'blackWhite', 'invert', 'posterize', 'threshold', 'photoFilter'];
  const samples: { [K in AdjustmentKind]?: Partial<ReturnType<typeof defaultAdjustmentParams<K>>> } = {
    curves: { master: [{ input: 0, output: 10 }, { input: 128, output: 150 }, { input: 255, output: 240 }] },
    levels: { red: { inBlack: 10, inWhite: 240, gamma: 1.5, outBlack: 5, outWhite: 250 } },
    hueSaturation: { hue: 30, saturation: -20, lightness: 5 },
    vibrance: { vibrance: 40, saturation: -10 },
    colorBalance: { midtones: [10, -20, 30], preserveLuminosity: false },
    blackWhite: { reds: 55, magentas: 120, tint: '#e1d3b3' },
    posterize: { levels: 6 },
    threshold: { level: 99 },
    photoFilter: { color: '#3366cc', density: 60, preserveLuminosity: false },
  };

  for (const kind of kinds) {
    it(`${kind} writes and reads back`, () => {
      const params = { ...defaultAdjustmentParams(kind), ...(samples[kind] ?? {}) };
      const block = writeAdjustmentBlock(kind, params as never);
      const back = parseAdjustmentBlock(block.key, block.data);
      expect(back?.kind).toBe(kind);
      expect(back?.params).toEqual(params);
    });
  }

  it('reads hue ranges in canonical order and returns null for unknown or unreadable blocks', () => {
    expect(canonicalBounds([315, 345, 15, 45])).toEqual([-45, -15, 15, 45]);
    expect(parseAdjustmentBlock('selc', new Uint8Array(84))).toBeNull();
    expect(parseAdjustmentBlock('levl', new Uint8Array(3))).toBeNull();
  });
});

describe('PSD container', () => {
  function record(name: string, extra: Partial<PsdLayerRecord> = {}): PsdLayerRecord {
    return { rect: { top: 0, left: 0, bottom: 0, right: 0 }, channels: [], blendKey: 'norm', opacity: 255, clipping: 0, flags: 0, legacyName: name, blocks: [], ...extra };
  }
  const section = (kind: number) => {
    const w = new PsdWriter();
    w.u32(kind);
    return w.result();
  };

  it('writes and reads layer records and builds the tree from dividers', () => {
    const file: PsdFile = {
      header: { psb: false, channels: 3, width: 2, height: 2, depth: 8, colorMode: 3 },
      colorModeData: new Uint8Array(0),
      resources: [{ id: 1005, name: '', data: new Uint8Array(16) }],
      layers: [
        record('bottom'),
        record('</Layer group>', { blocks: [{ key: 'lsct', data: section(3) }] }),
        record('inside'),
        record('Group', { blocks: [{ key: 'lsct', data: section(1) }] }),
        record('top'),
      ],
      mergedAlpha: false,
      globalBlocks: [],
      imageCompression: 0,
      imageData: new Uint8Array(12),
    };
    const back = readPsd(writePsd(file, encodeLegacyName));
    expect(back.layers.map(layerName)).toEqual(['bottom', '</Layer group>', 'inside', 'Group', 'top']);
    expect(layerTree(back)).toEqual([{ index: 0 }, { index: 3, children: [{ index: 2 }] }, { index: 4 }]);
    expect(back.resources[0].id).toBe(1005);
  });

  it('rejects files that are not PSDs, with the reason', () => {
    expect(() => readPsd(new TextEncoder().encode('GIF89a not a psd at all....'))).toThrow(/8BPS/);
    const bad = new Uint8Array(26);
    bad.set([0x38, 0x42, 0x50, 0x53, 0, 3]);
    expect(() => readPsd(bad)).toThrow(/version 3/);
  });
});

describe('PSD merged image matte', () => {
  it('mattes transparent colours over white and recovers them', async () => {
    const { matteWhite, unmatteWhite } = await import('../src/image-editor/psd/pixels');
    const px = Uint8ClampedArray.from([255, 0, 0, 204, 10, 20, 30, 255, 0, 0, 0, 0]);
    const matted = matteWhite(px);
    expect(Array.from(matted.subarray(0, 4))).toEqual([255, 51, 51, 204]);
    expect(Array.from(matted.subarray(4, 8))).toEqual([10, 20, 30, 255]);
    unmatteWhite(matted);
    expect(Array.from(matted.subarray(0, 8))).toEqual([255, 0, 0, 204, 10, 20, 30, 255]);
  });
});
