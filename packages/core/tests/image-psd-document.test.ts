import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import {
  ImageEditorController,
  base64ToBytes,
  createImageEditorToolProvider,
  readPixel,
  type AdjustmentLayerNode,
  type GroupLayer,
  type PixelLayer,
} from '../src/image-editor';
import { PsdWriter, encodeLegacyName } from '../src/image-editor/psd/binary';
import { encodeRle } from '../src/image-editor/psd/compression';
import { layerName, readPsd, writePsd, type PsdLayerRecord } from '../src/image-editor/psd/file';
import { importPsd } from '../src/image-editor/psd/import';
import { writeAdjustmentBlock } from '../src/image-editor/psd/adjust';

const W = 40;
const H = 20;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 100, 50, 255], i);
  c.setSamplePixels({ width: W, height: H, data });
  return c;
}

const all = (c: ImageEditorController) => Buffer.from(c.compositePixels().data);

/** A layered document with a group, a mask, an adjustment layer, clipping, fill and a lock. */
function layered() {
  const c = setup();
  const a = c.addPixelLayer({ name: 'Blue strip' });
  c.selectRect({ x: 2, y: 2, width: 12, height: 10 });
  c.fillPixels({ color: '#2040ff' });
  c.deselect();
  c.setLayerProperties(a, { opacity: 0.8, blend: 'multiply', fillOpacity: 0.5 });
  const b = c.addPixelLayer({ name: 'Green', color: '#10c020' });
  c.setLayerProperties(b, { clipped: true, locks: { position: true } });
  c.selectRect({ x: 0, y: 0, width: 20, height: H });
  c.addLayerMask(b, 'selection');
  c.deselect();
  const g = c.groupLayers([a, b], 'Stuff');
  const adj = c.addAdjustmentLayer({ kind: 'levels', params: { master: { inBlack: 20, inWhite: 230, gamma: 1.2, outBlack: 0, outWhite: 255 } } } as never);
  return { c, ids: { a, b, g, adj } };
}

describe('PSD export and import through the controller', () => {
  it('round-trips layers, groups, masks, adjustments, blend, opacity, fill, clipping and locks', async () => {
    const { c } = layered();
    const before = all(c);
    const { bytes, warnings, psb } = await c.toPsd();
    expect(psb).toBe(false);
    expect(warnings).toEqual([]);

    const d = new ImageEditorController({});
    const opened = d.loadPsd(bytes);
    expect(opened.warnings).toEqual([]);
    expect([opened.width, opened.height]).toEqual([W, H]);
    const names = d.getLayers().map((l) => l.name);
    expect(names).toEqual(['Background', 'Stuff', 'Levels']);
    const group = d.getLayers()[1] as GroupLayer;
    expect(group.type).toBe('group');
    const [strip, green] = group.children as PixelLayer[];
    expect({ name: strip.name, blend: strip.blend, fill: strip.fillOpacity }).toEqual({ name: "Blue strip", blend: "multiply", fill: 0.5 });
    expect(strip.opacity).toBeCloseTo(0.8, 2);
    expect(green).toMatchObject({ name: 'Green', clipped: true, locks: { position: true } });
    expect(readPixel(green.mask!.surface, 5, 5)).toEqual([255]);
    expect(readPixel(green.mask!.surface, 30, 5)).toEqual([0]);
    const levels = d.getLayers()[2] as AdjustmentLayerNode<'levels'>;
    expect(levels.params.master).toEqual({ inBlack: 20, inWhite: 230, gamma: 1.2, outBlack: 0, outWhite: 255 });

    // Same pixels: opacity bytes round to 1/255, so allow a level of difference.
    const after = all(d);
    let maxDiff = 0;
    for (let i = 0; i < before.length; i++) maxDiff = Math.max(maxDiff, Math.abs(before[i] - after[i]));
    expect(maxDiff).toBeLessThanOrEqual(1);

    // Opening is one undo step and the document now has no source image.
    expect(d.getState().sourceUrl).toBeNull();
    expect(d.isMultiLayer).toBe(true);
  });

  it('writes a merged image that matches the composite', async () => {
    const { c } = layered();
    const { bytes } = await c.toPsd();
    const file = readPsd(bytes);
    const merged = importPsd(writePsd({ ...file, layers: [] }, encodeLegacyName)).layers[0] as PixelLayer;
    const px = c.compositePixels({ x: 5, y: 5, width: 1, height: 1 }).data;
    expect(readPixel(merged.surface, 5, 5)).toEqual(Array.from(px));
  });

  it('bakes filters and parametric masks, with warnings', async () => {
    const c = setup();
    const id = c.addPixelLayer({ color: '#808080' });
    c.addLayerFilter(id, { kind: 'develop', exposure: 40 });
    const before = all(c);
    const { bytes, warnings } = await c.toPsd();
    expect(warnings.join(' ')).toMatch(/filters .* were baked/);
    const d = new ImageEditorController({});
    d.loadPsd(bytes);
    expect((d.getLayers()[1] as PixelLayer).filters).toBeUndefined();
    expect(all(d).equals(before)).toBe(true);
  });

  it('reports document settings it cannot write', async () => {
    const c = setup();
    c.setCrop({ x: 0, y: 0, width: 10, height: 10 });
    c.addAnnotation({ type: 'rect', x: 1, y: 1, width: 5, height: 5, strokeColor: '#000', strokeWidth: 1 });
    const { warnings } = await c.toPsd();
    expect(warnings.join(' ')).toMatch(/crop is not applied/);
    expect(warnings.join(' ')).toMatch(/Shape layers were written as pixel layers/);
  });

  it('undo restores the document that was open before', async () => {
    const { c } = layered();
    const { bytes } = await c.toPsd();
    const d = setup();
    const before = all(d);
    d.loadPsd(bytes);
    expect(d.getLayers()).toHaveLength(3);
    d.undo();
    expect(d.getLayers()).toHaveLength(1);
    expect(all(d).equals(before)).toBe(true);
  });
});

/** A minimal PSD of one full-canvas layer in `mode` at `depth` from planar channel data. */
function singleLayerPsd(opts: {
  mode: number;
  depth: number;
  channels: Array<[number, Uint8Array]>;
  width: number;
  height: number;
  colorModeData?: Uint8Array;
  blocks?: PsdLayerRecord['blocks'];
  blendKey?: string;
}): Uint8Array {
  const { width, height, depth } = opts;
  const rec: PsdLayerRecord = {
    rect: { top: 0, left: 0, bottom: height, right: width },
    channels: opts.channels.map(([id, plane]) => ({ id, compression: 1, data: encodeRle(plane, { planes: 1, width, height, depth, psb: false }) })),
    blendKey: opts.blendKey ?? 'norm',
    opacity: 255,
    clipping: 0,
    flags: 0,
    legacyName: 'Layer',
    blocks: opts.blocks ?? [],
  };
  const colorPlanes = opts.channels.filter(([id]) => id >= 0);
  const channels = colorPlanes.length || 3;
  const merged = new Uint8Array(colorPlanes.length ? colorPlanes.reduce((n, [, p]) => n + p.length, 0) : 3 * width * height * (depth / 8));
  let o = 0;
  for (const [, p] of colorPlanes) {
    merged.set(p, o);
    o += p.length;
  }
  return writePsd(
    {
      header: { psb: false, channels, width, height, depth, colorMode: opts.mode },
      colorModeData: opts.colorModeData ?? new Uint8Array(0),
      resources: [],
      layers: [rec],
      mergedAlpha: false,
      globalBlocks: [],
      imageCompression: 0,
      imageData: merged,
    },
    encodeLegacyName
  );
}

describe('PSD import of other formats', () => {
  const fill = (n: number, v: number) => new Uint8Array(n).fill(v);
  const first = (bytes: Uint8Array) => readPixel((importPsd(bytes).layers[0] as PixelLayer).surface, 0, 0);

  it('reads grayscale, CMYK, Lab, indexed, 16-bit and 32-bit layers as 8-bit RGB with a warning', () => {
    const n = 4;
    const gray = importPsd(singleLayerPsd({ mode: 1, depth: 8, width: 2, height: 2, channels: [[0, fill(n, 128)], [-1, fill(n, 255)]] }));
    expect(readPixel((gray.layers[0] as PixelLayer).surface, 0, 0)).toEqual([128, 128, 128, 255]);
    expect(gray.warnings.join(' ')).toMatch(/8-bit grayscale; it was converted to 8-bit RGB/);

    // CMYK stores 255 for no ink: no cyan, magenta, yellow or black is white.
    expect(first(singleLayerPsd({ mode: 4, depth: 8, width: 2, height: 2, channels: [[0, fill(n, 0)], [1, fill(n, 255)], [2, fill(n, 255)], [3, fill(n, 255)]] }))).toEqual([0, 255, 255, 255]);

    // Lab white.
    expect(first(singleLayerPsd({ mode: 9, depth: 8, width: 2, height: 2, channels: [[0, fill(n, 255)], [1, fill(n, 128)], [2, fill(n, 128)]] }))).toEqual([255, 255, 255, 255]);

    const palette = new Uint8Array(768);
    palette[3] = 10;
    palette[256 + 3] = 20;
    palette[512 + 3] = 30;
    expect(first(singleLayerPsd({ mode: 2, depth: 8, width: 2, height: 2, colorModeData: palette, channels: [[0, fill(n, 3)]] }))).toEqual([10, 20, 30, 255]);

    const sixteen = (v: number) => {
      const p = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) p.set([v >> 8, v & 255], i * 2);
      return p;
    };
    expect(first(singleLayerPsd({ mode: 3, depth: 16, width: 2, height: 2, channels: [[0, sixteen(65535)], [1, sixteen(32896)], [2, sixteen(0)]] }))).toEqual([255, 128, 0, 255]);

    const float = (v: number) => {
      const p = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) new DataView(p.buffer).setFloat32(i * 4, v, false);
      return p;
    };
    // 32-bit is linear light: 0.214 linear ≈ 128 encoded.
    const px = first(singleLayerPsd({ mode: 3, depth: 32, width: 2, height: 2, channels: [[0, float(1)], [1, float(0.2140)], [2, float(0)], [-1, float(1)]] }));
    expect(px[0]).toBe(255);
    expect(Math.abs(px[1] - 128)).toBeLessThanOrEqual(1);
  });

  it('warns about what it approximates or leaves out, naming the layers', () => {
    const n = 4;
    const rgb: Array<[number, Uint8Array]> = [[0, fill(n, 1)], [1, fill(n, 2)], [2, fill(n, 3)]];
    const text = importPsd(singleLayerPsd({ mode: 3, depth: 8, width: 2, height: 2, channels: rgb, blocks: [{ key: 'TySh', data: new Uint8Array(4) }, { key: 'lfx2', data: new Uint8Array(4) }], blendKey: 'diss' }));
    const all = text.warnings.join(' ');
    expect(all).toMatch(/Type layers came in as pixel layers \(their stored pixels\) \(layer "Layer"\)/);
    expect(all).toMatch(/Layer effects could not be read; they are kept for export but not drawn/);
    expect(all).toMatch(/Dissolve is not supported and became Normal/);
    expect(text.summary[0]).toMatchObject({ status: 'approximated', psdKind: 'type', type: 'pixel' });
    expect((text.layers[0] as PixelLayer).blend).toBe('normal');

    const selc = importPsd(singleLayerPsd({ mode: 3, depth: 8, width: 2, height: 2, channels: [], blocks: [{ key: 'selc', data: new Uint8Array(84) }] }));
    // Nothing imported: the merged image opens as the Background instead of an empty document.
    expect(selc.layers.map((l) => l.name)).toEqual(['Background']);
    expect(selc.warnings.join(' ')).toMatch(/Selective Color adjustment layers are not supported and were left out/);
    expect(selc.warnings.join(' ')).toMatch(/merged image was opened as the Background/);
    expect(selc.summary[0].status).toBe('dropped');
  });

  it('reads unicode names, hidden layers and adjustment layers written by other tools', () => {
    const luni = new PsdWriter();
    luni.unicode('Ébauche ✏️');
    const block = writeAdjustmentBlock('invert', {} as never);
    const bytes = singleLayerPsd({ mode: 3, depth: 8, width: 2, height: 2, channels: [], blocks: [{ key: 'luni', data: luni.result() }, { key: block.key, data: block.data }] });
    const file = readPsd(bytes);
    expect(layerName(file.layers[0])).toBe('Ébauche ✏️');
    const res = importPsd(bytes);
    expect(res.layers[0]).toMatchObject({ type: 'adjustment', kind: 'invert', name: 'Ébauche ✏️' });
  });

  it('flat files open as one Background layer from the merged image', () => {
    const w = new PsdWriter();
    w.ascii('8BPS');
    w.u16(1);
    w.zeros(6);
    w.u16(3);
    w.u32(1);
    w.u32(2);
    w.u16(8);
    w.u16(3);
    w.u32(0);
    w.u32(0);
    w.u32(0);
    w.u16(0);
    w.bytes([10, 11, 20, 21, 30, 31]);
    const res = importPsd(w.result());
    expect(res.layers).toHaveLength(1);
    expect(readPixel((res.layers[0] as PixelLayer).surface, 1, 0)).toEqual([11, 21, 31, 255]);
  });
});

describe('PSD agent tools', () => {
  it('export_psd → inspect_psd → import_psd closes the loop', async () => {
    const { c } = layered();
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(c));
    const exported = await registry.callTool('export_psd', {});
    expect(exported.isError).toBeFalsy();
    const out = exported.structuredContent as { data: string; size: number; psb: boolean; warnings: string[] };
    expect(out.size).toBe(base64ToBytes(out.data).length);
    expect(out.psb).toBe(false);

    const inspected = await registry.callTool('inspect_psd', { data: out.data });
    const info = inspected.structuredContent as { width: number; depth: number; colorMode: string; layers: Array<{ name: string; status: string; type: string }> };
    expect([info.width, info.depth, info.colorMode]).toEqual([W, 8, 'rgb']);
    expect(info.layers.map((l) => [l.name, l.type, l.status])).toEqual([
      ['Background', 'pixel', 'mapped'],
      ['Stuff', 'group', 'mapped'],
      ['Blue strip', 'pixel', 'mapped'],
      ['Green', 'pixel', 'mapped'],
      ['Levels', 'adjustment', 'mapped'],
    ]);
    // Inspecting changes nothing.
    expect(c.getLayers()).toHaveLength(3);

    const d = new ImageEditorController({});
    const r2 = new ToolRegistry();
    r2.register(createImageEditorToolProvider(d));
    const opened = await r2.callTool('import_psd', { data: `data:image/vnd.adobe.photoshop;base64,${out.data}` });
    expect(opened.isError).toBeFalsy();
    const res = opened.structuredContent as { layerIds: string[]; layers: Array<{ id: string; name: string }>; warnings: string[] };
    expect(res.layers.map((l) => l.name)).toEqual(['Background', 'Stuff', 'Levels']);
    expect(res.layerIds).toHaveLength(5);
    expect(res.layerIds).toContain(res.layers[1].id);
  });

  it('refuses data that is not a PSD, saying why', async () => {
    const registry = new ToolRegistry();
    registry.register(createImageEditorToolProvider(setup()));
    const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((x) => x.text ?? '').join(' ');
    const notBase64 = await registry.callTool('import_psd', { data: 'not base64 at all!' });
    expect(notBase64.isError).toBe(true);
    expect(text(notBase64)).toMatch(/not base64/);
    const notPsd = await registry.callTool('inspect_psd', { data: Buffer.from('GIF89a this is not a PSD file at all').toString('base64') });
    expect(notPsd.isError).toBe(true);
    expect(text(notPsd)).toMatch(/8BPS/);
    expect((await registry.callTool('import_psd', {})).isError).toBe(true);
    expect((await registry.callTool('export_psd', { extra: 1 })).isError).toBe(true);
  });
});
