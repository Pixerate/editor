import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBrushLibrary, createBrushLibraryToolProvider, decodeBrushSource, importBrushFile, normalizeBrushSpec, readAbr, readBrushPack, resolveBrush, PAINT_PROFILE, CANVAS_PROFILE } from '../src/brushes';
import { readZip } from '../src/brushes/import/zip';
import { keyedArchiveRoot, readBinaryPlist } from '../src/brushes/import/bplist';
import { bytesToBase64 } from '../src/raster/png';
import { ToolRegistry } from '../src/tools';
import { PaintEditorController } from '../src/paint-editor';
import { abrV2, abrV6, brushset, singleBrush, tipMask, zip, bplist } from './helpers/brush-packs';

/**
 * Small packs made for these tests (never third-party packs). They are committed so another
 * implementation can read the same files; `UPDATE_BRUSH_PACK_FIXTURES=1` writes them again.
 */
const DIR = path.join(__dirname, 'fixtures/brush-packs');
const BUILT: Record<string, () => Uint8Array> = {
  'tiny-v2.abr': () => abrV2([{ name: 'Notched', width: 20, height: 16, spacing: 30 }, { name: 'Raw', width: 9, height: 9, spacing: 0, compression: 0 }]),
  'tiny-v6.abr': () => abrV6([{ name: 'Dry stamp', width: 24, height: 24, spacing: 40 }, { name: 'Dot', width: 10, height: 12, spacing: 120 }]),
  'test-set.brushset': brushset,
  'leafy.brush': singleBrush,
};
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(DIR, name)));

describe('fixture packs', () => {
  it.each(Object.keys(BUILT))('%s is the file its builder makes', (name) => {
    if (process.env.UPDATE_BRUSH_PACK_FIXTURES) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(path.join(DIR, name), BUILT[name]());
    }
    expect(existsSync(path.join(DIR, name))).toBe(true);
    expect(Buffer.from(fixture(name)).equals(Buffer.from(BUILT[name]()))).toBe(true);
    expect(fixture(name).length).toBeLessThan(8 * 1024);
  });
});

describe('.abr', () => {
  it('reads version 2 sampled tips (PackBits and raw) and computed tips', () => {
    const f = readAbr(fixture('tiny-v2.abr'));
    expect(f.version).toBe(2);
    expect(f.tips.map((t) => [t.kind, t.name])).toEqual([
      ['sampled', 'Notched'],
      ['sampled', 'Raw'],
      ['computed', undefined],
    ]);
    const [notched, raw, computed] = f.tips;
    expect(notched.kind === 'sampled' && [notched.width, notched.height, notched.spacing]).toEqual([20, 16, 0.3]);
    expect(notched.kind === 'sampled' && Buffer.from(notched.mask).equals(Buffer.from(tipMask(20, 16)))).toBe(true);
    expect(raw.kind === 'sampled' && Buffer.from(raw.mask).equals(Buffer.from(tipMask(9, 9)))).toBe(true);
    expect(computed).toEqual({ kind: 'computed', diameter: 30, roundness: 0.6, angle: 45, hardness: 0.8, spacing: 0.15 });
  });

  it('reads version 6 sampled tips with the names and spacing of their presets, and reports patterns', () => {
    const f = readAbr(fixture('tiny-v6.abr'));
    expect(f.tips.map((t) => t.kind === 'sampled' && [t.name, t.width, t.height, t.spacing])).toEqual([
      ['Dry stamp', 24, 24, 0.4],
      ['Dot', 10, 12, 1.2],
    ]);
    expect(f.tips[0].kind === 'sampled' && Buffer.from(f.tips[0].mask).equals(Buffer.from(tipMask(24, 24)))).toBe(true);
    expect(f.unsupported.join(' ')).toMatch(/Patterns.*not imported/);
  });

  it('refuses what is not a brush file, and survives truncated and corrupted ones', () => {
    expect(() => readAbr(new Uint8Array(0))).toThrow(/empty/);
    expect(() => readAbr(Uint8Array.from([0, 3, 0, 0]))).toThrow(/version 3/);
    const good = fixture('tiny-v2.abr');
    // Cut anywhere: either the tips before the cut are kept (and the rest reported), or the file is refused; never a crash or a hang.
    for (let n = 2; n < good.length; n += 7) {
      try {
        const f = readAbr(good.subarray(0, n));
        expect(f.tips.length + f.unsupported.length).toBeGreaterThan(0);
      } catch (e) {
        expect((e as Error).name).toBe('AbrError');
      }
    }
    // A tip that claims to be enormous is refused, not allocated.
    const huge = abrV2([{ name: 'x', width: 4, height: 4, spacing: 10 }]);
    const view = new DataView(huge.buffer);
    // bounds (long) bottom and right of the first tip: after version, count, type, size, misc, spacing, name (4 + 2×2 bytes), antialias and short bounds.
    const at = 2 + 2 + 2 + 4 + 4 + 2 + 4 + 4 + 1 + 8;
    view.setUint32(at + 8, 60000);
    view.setUint32(at + 12, 60000);
    const f = readAbr(huge);
    expect(f.tips.map((t) => t.kind)).toEqual(['computed']);
    expect(f.unsupported.join(' ')).toMatch(/60000×60000 px; tips over/);
  });
});

describe('Procreate packs', () => {
  it('reads the ZIP and the keyed archive defensively', () => {
    const entries = readZip(fixture('test-set.brushset'));
    expect(entries.map((e) => e.name)).toContain('A1/Shape.png');
    const root = keyedArchiveRoot(readBinaryPlist(entries.find((e) => e.name === 'A1/Brush.archive')!.read()));
    expect(root).toMatchObject({ name: 'Dry ink', plotSpacing: 0.15 });
    expect(() => readZip(new Uint8Array(100))).toThrow(/Not a ZIP/);
    // A directory entry pointing past the end, and a self-referencing plist.
    const bad = zip({ 'a.txt': new Uint8Array(10) });
    new DataView(bad.buffer).setUint32(bad.length - 22 - (46 + "a.txt".length) + 42, 999999, true);
    expect(() => readZip(bad)).toThrow(/no local header/);
    expect(() => readBinaryPlist(new Uint8Array(10))).toThrow(/Not a binary/);
    const loop = bplist([1]);
    loop[9] = 0; // the array's one ref points at itself
    expect(() => readBinaryPlist(loop)).toThrow(/refers to itself/);
  });
});

describe('readBrushPack', () => {
  it('maps a .brushset: shapes as image tips, grain as tip grain, names, spacing and the licence file', () => {
    const pack = readBrushPack(fixture('test-set.brushset'), { fileName: 'Test set.brushset', licence: 'Personal use only.' });
    expect(pack.format).toBe('brushset');
    expect(pack.brushes).toEqual([
      { id: 'test-set-dry-ink', name: 'Dry ink', kind: 'mark', tags: ['imported', 'procreate'], description: 'Imported from Test set.', tip: { shape: 'stamp', size: 40, spacing: 0.15, stamps: ['source:test-set-dry-ink-shape'], grain: { source: 'source:test-set-dry-ink-grain', mode: 'moving' } } },
      { id: 'test-set-soft-round', name: 'Soft round', kind: 'mark', tags: ['imported', 'procreate'], description: 'Imported from Test set.', tip: { shape: 'stamp', size: 40, spacing: 0.05, stamps: ['source:test-set-soft-round-shape'] } },
    ]);
    expect(pack.sources.map((s) => s.id)).toEqual(['test-set-dry-ink-shape', 'test-set-dry-ink-grain', 'test-set-soft-round-shape']);
    expect(pack.licence).toEqual(['Personal use only.', 'LICENSE: Made for the Pixerate tests. CC0: no rights reserved.']);
    expect(pack.sources[0].licence).toMatch(/Personal use only\.[\s\S]*CC0/);
    expect(pack.sources[0].origin).toBe('Test set/A1/Shape.png');
    // White on black: the white marks paint.
    const shape = decodeBrushSource(pack.sources[0]);
    expect(shape.mask[12 * 24 + 12]).toBe(255);
    expect(shape.mask[0]).toBe(0);
    expect(pack.unsupported.join(' ')).toMatch(/not mapped/);
    for (const b of pack.brushes) expect(() => normalizeBrushSpec(b)).not.toThrow();
  });

  it('maps a single .brush and both .abr versions', () => {
    expect(readBrushPack(fixture('leafy.brush'), { fileName: 'leafy.brush' }).brushes.map((b) => [b.id, b.name, b.tip.spacing])).toEqual([['leafy-leafy', 'Leafy', 0.4]]);
    const v2 = readBrushPack(fixture('tiny-v2.abr'), { fileName: 'Tiny.abr', prefix: 'ink' });
    expect(v2.brushes.map((b) => [b.id, b.name, b.tip.shape, b.tip.size])).toEqual([
      ['ink-notched', 'Notched', 'stamp', 20],
      ['ink-raw', 'Raw', 'stamp', 9],
      ['ink-3', 'Tiny 3', 'flat', 30],
    ]);
    // Spacing 0 in the file: the default.
    expect(v2.brushes[1].tip.spacing).toBe(0.25);
    expect(readBrushPack(fixture('tiny-v6.abr'), { fileName: 'tiny-v6.abr' }).brushes.map((b) => b.id)).toEqual(['tiny-v6-dry-stamp', 'tiny-v6-dot']);
  });

  it.each(Object.keys(BUILT))('reads %s with corrupted bytes without crashing or hanging', (name) => {
    const good = fixture(name);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 150; round++) {
      const bad = good.slice();
      for (let k = 0; k < 1 + (round % 6); k++) bad[Math.floor(rand() * bad.length)] = Math.floor(rand() * 256);
      try {
        const pack = readBrushPack(bad, { fileName: name });
        for (const b of pack.brushes) normalizeBrushSpec(b);
      } catch (e) {
        expect((e as Error).name, (e as Error).stack).toBe('BrushPackError');
      }
    }
  });

  it('refuses what it cannot read, saying what to give instead', () => {
    expect(() => readBrushPack(new TextEncoder().encode('hello'), { fileName: 'notes.txt' })).toThrow(/\.abr.*\.brush or \.brushset/);
    expect(() => readBrushPack(zip({ 'x.txt': new Uint8Array(3) }), { fileName: 'x.brushset' })).toThrow(/no Procreate brushes/);
    expect(() => readBrushPack(new Uint8Array(4), { fileName: 'x.brushset' })).toThrow(/can't be read as a Procreate brush pack/);
  });
});

describe('importing into a library', () => {
  it('adds brushes and sources in one import that paints, skipping taken ids', async () => {
    const lib = createBrushLibrary();
    let changes = 0;
    lib.subscribe(() => changes++);
    const file = Object.assign(new Blob([fixture('test-set.brushset')]), { name: 'Test set.brushset' });
    const r = await importBrushFile(lib, file);
    expect(changes).toBe(1);
    expect(r).toMatchObject({ format: 'brushset', brushes: [{ id: 'test-set-dry-ink' }, { id: 'test-set-soft-round' }], sources: ['test-set-dry-ink-shape', 'test-set-dry-ink-grain', 'test-set-soft-round-shape'], skipped: [] });
    expect((await importBrushFile(lib, file)) as { skipped: string[] }).toMatchObject({ skipped: ['test-set-dry-ink', 'test-set-soft-round'] });

    const c = new PaintEditorController({ width: 120, height: 60, paper: 'smooth', brushLibrary: lib });
    await c.whenBrushesLoaded();
    const out = c.paintStroke({ brushId: 'test-set-dry-ink', points: [{ x: 10, y: 30 }, { x: 110, y: 30 }], color: '#000000', seed: 1 });
    expect(out.dabs).toBeGreaterThan(5);
    expect(resolveBrush((await lib.get('test-set-dry-ink'))!.brush).tipGrain?.source).toBe('source:test-set-dry-ink-grain');
  });
});

describe('import_brush_pack', () => {
  const setup = (profile = PAINT_PROFILE) => {
    const library = createBrushLibrary();
    const registry = new ToolRegistry();
    registry.register(createBrushLibraryToolProvider(library, { profile }));
    return { library, call: (args: Record<string, unknown>) => registry.callTool('brushes__import_brush_pack', args) };
  };

  it('imports an .abr and a .brushset, reporting renderable brushes, unsupported settings and the licence', async () => {
    const { call, library } = setup();
    const abr = await call({ file: bytesToBase64(fixture('tiny-v6.abr')), fileName: 'tiny-v6.abr', licence: 'Bought for personal use.' });
    expect(abr.isError).toBeFalsy();
    expect(abr.structuredContent).toMatchObject({ format: 'abr', brushes: [{ id: 'tiny-v6-dry-stamp', name: 'Dry stamp', renderable: true }, { id: 'tiny-v6-dot', renderable: true }], sources: ['tiny-v6-dry-stamp-shape', 'tiny-v6-dot-shape'], licence: ['Bought for personal use.'] });
    expect((abr.structuredContent as { unsupported: string[] }).unsupported.length).toBeGreaterThan(0);
    expect((await library.getSource('tiny-v6-dot-shape'))?.licence).toBe('Bought for personal use.');
    const set = await call({ file: `data:application/octet-stream;base64,${bytesToBase64(fixture('test-set.brushset'))}`, fileName: 'Test set.brushset' });
    expect(set.structuredContent).toMatchObject({ format: 'brushset', brushes: [{ id: 'test-set-dry-ink' }, { id: 'test-set-soft-round' }] });
  });

  it('says a host that cannot paint image tips cannot paint the imported brushes', async () => {
    const { call } = setup(CANVAS_PROFILE);
    const r = await call({ file: bytesToBase64(fixture('tiny-v2.abr')), fileName: 'tiny.abr' });
    expect((r.structuredContent as { brushes: Array<{ id: string; renderable: boolean }> }).brushes.map((b) => [b.id, b.renderable])).toEqual([
      ['tiny-notched', false],
      ['tiny-raw', false],
      ['tiny-3', true],
    ]);
  });

  it('refuses bad input with the reason, importing nothing', async () => {
    const { call, library } = setup();
    const notBase64 = await call({ file: '%%%%', fileName: 'a.abr' });
    expect(notBase64.isError).toBe(true);
    expect(JSON.stringify(notBase64.content)).toMatch(/not base64/);
    const notPack = await call({ file: bytesToBase64(new TextEncoder().encode('hello there')), fileName: 'readme.txt' });
    expect(notPack.isError).toBe(true);
    expect(JSON.stringify(notPack.content)).toMatch(/Nothing was imported/);
    expect((await call({ file: 'AAAA', fileName: 'a.abr', format: 'psd' })).isError).toBe(true);
    expect((await call({ file: 'AAAA' })).isError).toBe(true);
    expect((await library.list({ source: 'user' })).length).toBe(0);
    expect((await library.listSources()).length).toBe(0);
  });
});
