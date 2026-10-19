import { describe, expect, it } from 'vitest';
import { ImageEditorController, encodePng, type SmartObjectLayer } from '../src/image-editor';
import { PsdWriter, encodeLegacyName } from '../src/image-editor/psd/binary';
import { readPsd, writePsd, type PsdFile } from '../src/image-editor/psd/file';
import { descriptor, writeVersionedDescriptor, type DescValue, type Descriptor } from '../src/image-editor/psd/descriptor';
import {
  cornersFromQuad,
  encodeLinkedFile,
  parseFilterEffects,
  parseLinkedFiles,
  parsePlaced,
  quadFromCorners,
  warpDescriptor,
  warpFromDescriptor,
  writeFilterEffects,
  filterMaskItem,
  filterMaskFromItem,
} from '../src/image-editor/psd/smart';
import { importPsd } from '../src/image-editor/psd/import';
import { surfaceFromPixels, contentBounds, readRegion } from '../src/raster/surface';

const W = 48;
const H = 32;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set([x * 5, y * 7, 90, 255], (y * W + x) * 4);
  c.setSamplePixels({ width: W, height: H, data });
  return c;
}

function block(c: ImageEditorController, x: number, y: number, name: string) {
  const data = new Uint8ClampedArray(12 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([(i * 3) % 256, 200, (i * 7) % 256, 255], i);
  return c.addPixelLayer({ name, pixels: { width: 12, height: 8, data }, x, y });
}

const composite = (c: ImageEditorController) => Array.from(c.compositePixels().data);
const smart = (c: ImageEditorController, name: string) => c.getLayers().find((l) => l.name === name) as SmartObjectLayer;

function reopen(bytes: Uint8Array) {
  const d = setup();
  const res = d.loadPsd(bytes);
  return { d, res };
}

describe('placement geometry', () => {
  it('maps the contents rectangle through a frame that differs from it, and back', () => {
    const contents = { width: 100, height: 50 };
    const frame = { x: -10, y: -5, width: 120, height: 60 };
    const quad = [10, 20, 130, 30, 125, 95, 5, 80];
    const corners = cornersFromQuad(quad, frame, contents)!;
    const back = quadFromCorners(corners, frame, contents);
    back.forEach((v, i) => expect(v).toBeCloseTo(quad[i], 6));
  });

  it('reads preset and custom warps and writes a single-patch mesh back', () => {
    const contents = { width: 40, height: 20 };
    const preset = descriptor('warp', [
      ['warpStyle', { type: 'enum', typeId: 'warpStyle', value: 'warpArc' }],
      ['warpValue', { type: 'doub', value: 30 }],
      ['warpPerspective', { type: 'doub', value: 0 }],
      ['warpPerspectiveOther', { type: 'doub', value: 0 }],
      ['warpRotate', { type: 'enum', typeId: 'Ornt', value: 'Hrzn' }],
      ['bounds', { type: 'Objc', value: descriptor('classFloatRect', [['Top ', { type: 'doub', value: 0 }], ['Left', { type: 'doub', value: 0 }], ['Btom', { type: 'doub', value: 20 }], ['Rght', { type: 'doub', value: 40 }]]) }],
    ]);
    const read = warpFromDescriptor(preset, contents)!;
    expect(read.mesh!.points).toHaveLength(16);
    expect(read.frame).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    const written = warpDescriptor(read.mesh, contents);
    expect(written.dropped).toBe(false);
    const again = warpFromDescriptor(written.warp, contents)!;
    again.mesh!.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(read.mesh!.points[i].x, 9);
      expect(p.y).toBeCloseTo(read.mesh!.points[i].y, 9);
    });
    expect(warpFromDescriptor(descriptor('warp', [['warpStyle', { type: 'enum', typeId: 'warpStyle', value: 'warpNone' }]]), contents)!.mesh).toBeNull();
    expect(warpFromDescriptor(descriptor('warp', [['warpStyle', { type: 'enum', typeId: 'warpStyle', value: 'warpUnknown' }], ['bounds', preset.items[5][1]]]), contents)).toBeUndefined();
  });
});

describe('linked files and filter effects blocks', () => {
  it('round-trips embedded files and skips damaged items', () => {
    const a = encodeLinkedFile({ uuid: 'id-a', name: 'a.png', bytes: encodePng(1, 1, new Uint8ClampedArray(4)) });
    const b = encodeLinkedFile({ uuid: 'id-b', name: 'b.bin', bytes: Uint8Array.from([1, 2, 3]) });
    const files = parseLinkedFiles(Uint8Array.from([...a, ...b]));
    expect(files.map((f) => [f.kind, f.uuid, f.name, f.fileType])).toEqual([
      ['liFD', 'id-a', 'a.png', 'PNGf'],
      ['liFD', 'id-b', 'b.bin', '    '],
    ]);
    expect(Array.from(files[1].bytes)).toEqual([1, 2, 3]);
    expect(parseLinkedFiles(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 99, 1, 2]))).toEqual([]);
  });

  it('round-trips a filter mask through FEid', () => {
    const plane = new Uint8ClampedArray(6 * 4);
    for (let i = 0; i < plane.length; i++) plane[i] = i * 10;
    const mask = { surface: surfaceFromPixels({ width: 6, height: 4, data: plane }, 1, 3, 2, 255), defaultValue: 255 as const };
    const bytes = writeFilterEffects([filterMaskItem('inst-1', mask)]);
    const fx = parseFilterEffects(bytes);
    expect(fx.items.map((i) => i.id)).toEqual(['inst-1']);
    const back = filterMaskFromItem(fx.items[0])!;
    expect(contentBounds(back.surface)).toEqual(contentBounds(mask.surface));
    expect(Array.from(readRegion(back.surface, { x: 3, y: 2, width: 6, height: 4 }))).toEqual(Array.from(plane));
    expect(() => parseFilterEffects(Uint8Array.from([0, 0, 0, 9]))).toThrow(/version/);
  });
});

describe('PSD export and import of smart objects', () => {
  function document() {
    const c = setup();
    const a = c.convertToSmartObject([block(c, 4, 4, 'Raster')]);
    c.setSmartObjectTransform(a, { rotate: 25, scaleX: 120, scaleY: 90 });
    c.addSmartFilter(a, { kind: 'blur', radius: 2, blend: 'multiply', opacity: 0.7 });
    c.addSmartFilter(a, { kind: 'develop', exposure: 30 });
    c.selectRect({ x: 0, y: 0, width: 20, height: 32 });
    c.setSmartFilterMask(a, 'selection');
    c.deselect();
    const linked = c.copySmartObject(a, true, 'Linked');
    c.offsetLayer(linked, { dx: 18, dy: 6 });
    const nested = c.convertToSmartObject([block(c, 26, 18, 'Inner A'), block(c, 30, 20, 'Inner B')], { name: 'Nested' });
    c.setSmartObjectTransform(nested, { warp: { style: 'flag', bend: 25 } });
    return c;
  }

  it('reopens what it writes: contents, placements, warps, filters, filter mask and linked instances', async () => {
    const c = document();
    const out = await c.toPsd();
    expect(out.warnings.join(' ')).toMatch(/Develop smart filters have no Photoshop filter/);
    const file = readPsd(out.bytes);
    expect(file.globalBlocks.map((b) => b.key)).toEqual(expect.arrayContaining(['lnk2', 'FEid']));
    expect(importPsd(out.bytes, { skipPixels: true }).summary.filter((s) => s.type === 'smart')).toHaveLength(3);
    const { d, res } = reopen(out.bytes);
    expect(res.summary.filter((s) => s.type === 'smart').map((s) => s.name)).toEqual(['Raster', 'Linked', 'Nested']);
    const a0 = smart(c, 'Raster');
    const a1 = smart(d, 'Raster');
    a1.placement.corners.forEach((p, i) => {
      expect(p.x).toBeCloseTo(a0.placement.corners[i].x, 6);
      expect(p.y).toBeCloseTo(a0.placement.corners[i].y, 6);
    });
    expect(a1.contents).toBe(smart(d, 'Linked').contents);
    expect(a1.contents.kind).toBe('raster');
    expect(a1.smartFilters!.filters.map((f) => [f.kind, f.blend, f.opacity])).toEqual([['blur', 'multiply', 0.7]]);
    const canvas = { x: 0, y: 0, width: W, height: H };
    expect(Array.from(readRegion(a1.smartFilters!.mask!.surface, canvas))).toEqual(Array.from(readRegion(a0.smartFilters!.mask!.surface, canvas)));
    const n1 = smart(d, 'Nested');
    expect(n1.contents.kind).toBe('document');
    expect(n1.contents.document!.layers.map((l) => l.name)).toEqual(['Inner A', 'Inner B']);
    expect(n1.placement.warp!.points).toHaveLength(16);
    smart(c, 'Nested').placement.warp!.points.forEach((p, i) => {
      expect(n1.placement.warp!.points[i].x).toBeCloseTo(p.x, 5);
      expect(n1.placement.warp!.points[i].y).toBeCloseTo(p.y, 5);
    });
    // The layers' pixels are what we rendered, so the documents look the same.
    expect(composite(d)).toEqual(composite(c));
    // And they stay editable: a transform re-renders from the embedded contents.
    d.setSmartObjectTransform(n1.id, { scaleX: 50, scaleY: 50 });
    expect(smart(d, 'Nested').placement.corners).not.toEqual(n1.placement.corners);
  });

  it('writes an unchanged smart object back byte for byte', async () => {
    const c = document();
    const first = await c.toPsd();
    const { d } = reopen(first.bytes);
    const second = await d.toPsd();
    const blocks = (bytes: Uint8Array) => readPsd(bytes).layers.flatMap((l) => l.blocks.filter((b) => b.key === 'SoLd').map((b) => Array.from(b.data)));
    expect(blocks(second.bytes)).toEqual(blocks(first.bytes));
    expect(readPsd(second.bytes).globalBlocks.find((b) => b.key === 'lnk2')!.data.length).toBe(readPsd(first.bytes).globalBlocks.find((b) => b.key === 'lnk2')!.data.length);
  });

  it('writes placed blocks again when the placement changes', async () => {
    const c = document();
    const { d } = reopen((await c.toPsd()).bytes);
    const id = smart(d, 'Raster').id;
    d.setSmartObjectTransform(id, { rotate: -10 });
    const bytes = (await d.toPsd()).bytes;
    const rec = readPsd(bytes).layers.find((l) => l.blocks.some((b) => b.key === 'SoLd') && l.legacyName === 'Raster')!;
    const p = parsePlaced('SoLd', rec.blocks.find((b) => b.key === 'SoLd')!.data)!;
    expect(p.placed).toBe(smart(d, 'Raster').psd!.placed);
    const { d: e } = reopen(bytes);
    expect(e.getSmartObject(smart(e, 'Raster').id).placement.rotate).toBeCloseTo(-10, 5);
  });
});

describe('Photoshop-written smart objects', () => {
  const t = (v: string): DescValue => ({ type: 'TEXT', value: v });
  const quad = (q: number[]): DescValue => ({ type: 'VlLs', items: q.map((value) => ({ type: 'doub', value }) as DescValue) });

  function soLd(d: Descriptor): Uint8Array {
    const w = new PsdWriter();
    w.ascii('soLD');
    w.u32(4);
    writeVersionedDescriptor(w, d);
    return w.result();
  }

  /** Our PSD with one smart layer whose blocks are replaced by `sold` and the given linked items. */
  async function photoshopLike(sold: Descriptor, linked: Uint8Array, fe?: Uint8Array): Promise<Uint8Array> {
    const c = setup();
    c.convertToSmartObject([block(c, 8, 8, 'Placed')]);
    const file: PsdFile = readPsd((await c.toPsd()).bytes);
    const rec = file.layers.find((l) => l.legacyName === 'Placed')!;
    rec.blocks = rec.blocks.filter((b) => b.key !== 'SoLd' && b.key !== 'PlLd');
    rec.blocks.push({ key: 'SoLd', data: soLd(sold) });
    file.globalBlocks = file.globalBlocks.filter((b) => b.key !== 'lnk2' && b.key !== 'FEid');
    file.globalBlocks.push({ key: 'lnk2', data: linked });
    if (fe) file.globalBlocks.push({ key: 'FEid', data: fe });
    return writePsd(file, encodeLegacyName);
  }

  const filterItem = (name: string, fltr: Descriptor, id: number): DescValue => ({
    type: 'Objc',
    value: descriptor('filterFX', [
      ['Nm  ', t(name)],
      ['blendOptions', { type: 'Objc', value: descriptor('blendOptions', [['Opct', { type: 'UntF', unit: '#Prc', value: 50 }], ['Md  ', { type: 'enum', typeId: 'BlnM', value: 'Scrn' }]]) }],
      ['enab', { type: 'bool', value: true }],
      ['Fltr', { type: 'Objc', value: fltr }],
      ['filterID', { type: 'long', value: id }],
    ]),
  });

  it('reads a perspective placement, unknown filters, a box blur and a filter mask', async () => {
    const png = encodePng(10, 10, new Uint8ClampedArray(400).fill(255));
    const sold = descriptor('null', [
      ['Idnt', t('aaaaaaaa-0000-0000-0000-000000000001')],
      ['placed', t('bbbbbbbb-0000-0000-0000-000000000002')],
      ['Trnf', quad([2, 2, 30, 4, 28, 26, 4, 22])],
      ['nonAffineTransform', quad([2, 2, 30, 4, 28, 26, 4, 22])],
      ['Sz  ', { type: 'Objc', value: descriptor('Pnt ', [['Wdth', { type: 'doub', value: 10 }], ['Hght', { type: 'doub', value: 10 }]]) }],
      [
        'filterFX',
        {
          type: 'Objc',
          value: descriptor('filterFXStyle', [
            ['enab', { type: 'bool', value: true }],
            ['filterMaskEnable', { type: 'bool', value: false }],
            ['filterMaskLinked', { type: 'bool', value: true }],
            [
              'filterFXList',
              {
                type: 'VlLs',
                items: [filterItem('Gaussian Blur...', descriptor('GsnB', [['Rds ', { type: 'UntF', unit: '#Pxl', value: 3 }]]), 0x47736e42), filterItem('Box Blur...', descriptor('boxblur', [['Rds ', { type: 'UntF', unit: '#Pxl', value: 4 }]]), 840)],
              },
            ],
          ]),
        },
      ],
    ]);
    const plane = new Uint8ClampedArray(8 * 8).fill(0);
    const fe = writeFilterEffects([filterMaskItem('bbbbbbbb-0000-0000-0000-000000000002', { surface: surfaceFromPixels({ width: 8, height: 8, data: plane }, 1, 4, 4, 255), defaultValue: 255 })]);
    const bytes = await photoshopLike(sold, encodeLinkedFile({ uuid: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'white.png', bytes: png }), fe);
    const res = importPsd(bytes);
    const layer = res.layers.find((l) => l.name === 'Placed') as SmartObjectLayer;
    expect(layer.type).toBe('smart');
    expect(layer.contents).toMatchObject({ kind: 'raster', width: 10, height: 10, name: 'white.png', file: { type: 'png' } });
    [2, 2, 30, 4, 28, 26, 4, 22].forEach((v, i) => expect(i % 2 ? layer.placement.corners[i >> 1].y : layer.placement.corners[i >> 1].x).toBeCloseTo(v, 9));
    const f = layer.smartFilters!;
    expect(f.filters.map((x) => [x.kind, x.blend, x.opacity])).toEqual([
      ['psd', 'screen', 0.5],
      ['blur', 'screen', 0.5],
    ]);
    expect(f.filters[0]).toMatchObject({ name: 'Gaussian Blur...' });
    expect(f.mask).toMatchObject({ enabled: false });
    expect(res.warnings.join(' ')).toMatch(/Gaussian Blur smart filter is kept but not drawn/);
    // Hidden and re-blended, the kept filter is written back with its settings.
    const c = setup();
    c.loadPsd(bytes);
    const opened = c.getLayers().find((l) => l.name === 'Placed') as SmartObjectLayer;
    c.updateSmartFilter(opened.id, opened.smartFilters!.filters[0].id, { enabled: false, blend: 'multiply' });
    const again = importPsd((await c.toPsd()).bytes).layers.find((l) => l.name === 'Placed') as SmartObjectLayer;
    expect(again.smartFilters!.filters[0]).toMatchObject({ kind: 'psd', name: 'Gaussian Blur...', enabled: false, blend: 'multiply' });
  });

  it('brings linked (external) contents in as their stored pixels, with a warning', async () => {
    const w = new PsdWriter();
    w.ascii('liFE');
    w.u32(7);
    const id = new TextEncoder().encode('cccccccc-0000-0000-0000-000000000003');
    w.u8(id.length);
    w.bytes(id);
    w.unicode('photo.tif', true);
    w.ascii('TIFF');
    w.ascii('8BIM');
    w.u64(0);
    w.u8(0);
    writeVersionedDescriptor(w, descriptor('ExternalFileLink', [['fullPath', t('/Users/me/photo.tif')]]));
    const item = w.result();
    const outer = new PsdWriter();
    outer.u64(item.length);
    outer.bytes(item);
    outer.zeros((4 - (outer.length % 4)) % 4);
    const sold = descriptor('null', [
      ['Idnt', t('cccccccc-0000-0000-0000-000000000003')],
      ['placed', t('dddd')],
      ['Trnf', quad([8, 8, 20, 8, 20, 16, 8, 16])],
      ['Sz  ', { type: 'Objc', value: descriptor('Pnt ', [['Wdth', { type: 'doub', value: 300 }], ['Hght', { type: 'doub', value: 200 }]]) }],
    ]);
    const res = importPsd(await photoshopLike(sold, outer.result()));
    const layer = res.layers.find((l) => l.name === 'Placed') as SmartObjectLayer;
    expect(layer.contents).toMatchObject({ kind: 'raster', width: 12, height: 8, linked: { path: '/Users/me/photo.tif' } });
    expect(layer.placement.corners[0]).toEqual({ x: 8, y: 8 });
    expect(res.warnings.join(' ')).toMatch(/Linked smart objects came in as their embedded preview/);
  });

  it('keeps JPEG contents undecoded outside a browser and refuses to re-render them', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3]);
    const sold = descriptor('null', [
      ['Idnt', t('eeee')],
      ['placed', t('ffff')],
      ['Trnf', quad([8, 8, 20, 8, 20, 16, 8, 16])],
      ['Sz  ', { type: 'Objc', value: descriptor('Pnt ', [['Wdth', { type: 'doub', value: 12 }], ['Hght', { type: 'doub', value: 8 }]]) }],
    ]);
    const bytes = await photoshopLike(sold, encodeLinkedFile({ uuid: 'eeee', name: 'shot.jpg', bytes: jpeg }));
    const c = setup();
    const res = c.loadPsd(bytes);
    expect(res.warnings.join(' ')).toMatch(/JPG format are decoded only in a browser/);
    const layer = c.getLayers().find((l) => l.name === 'Placed') as SmartObjectLayer;
    expect(c.getSmartObject(layer.id).contents).toMatchObject({ decoded: false, fileType: 'jpg' });
    expect(() => c.setSmartObjectTransform(layer.id, { rotate: 5 })).toThrow(/could not be decoded here/);
    expect(c.exportSmartObjectContents(layer.id)).toMatchObject({ name: 'shot.jpg', mimeType: 'image/jpeg' });
    const out = readPsd((await c.toPsd()).bytes);
    const files = parseLinkedFiles(out.globalBlocks.find((b) => b.key === 'lnk2')!.data);
    expect(Array.from(files[0].bytes)).toEqual(Array.from(jpeg));
  });
});
