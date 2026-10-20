import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, readDeepRegion, readPixel, surfaceDepth, writeDeepRegion, type PixelLayer } from '../src/image-editor';
import { builtinProfile, parseProfile } from '../src/cms';
import { decodeLayerChannel, readPsd, resource } from '../src/image-editor/psd/file';
import { importPsd } from '../src/image-editor/psd/import';

const W = 6;
const H = 2;

function setup(color = '#3366cc') {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const id = c.addPixelLayer({ name: 'Paint', color });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, id, registry };
}
const text = (res: { content?: unknown[] }) => String((res.content?.[0] as { text?: string })?.text);

describe('CMYK and Lab documents', () => {
  it('CMYK mode writes a CMYK PSD with its profile, and opening it comes back to the same colours', async () => {
    // An in-gamut green (sRGB blue would clip on a press).
    const { c } = setup('#409060');
    expect(c.getColorProfile().mode).toBe('rgb');
    c.setColorMode('cmyk');
    expect(c.getColorProfile()).toMatchObject({ mode: 'cmyk', cmykProfile: { builtin: 'coated-cmyk', intent: 'relative' } });
    // The viewport now proofs through the press (no explicit Proof Setup needed).
    expect(c.getState().proofSetup ?? null).toBeNull();
    const saved = await c.toPsd();
    const file = readPsd(saved.bytes);
    expect(file.header.colorMode).toBe(4);
    expect(parseProfile(resource(file, 1039)!).colorSpace).toBe('cmyk');
    const paint = file.layers.find((l) => l.legacyName === 'Paint')!;
    expect(paint.channels.map((ch) => ch.id).sort()).toEqual([-1, 0, 1, 2, 3]);
    // Green: much cyan and yellow, little magenta (stored inverted: 255 = no ink).
    const cyan = 255 - decodeLayerChannel(file, paint, 0)![0];
    const magenta = 255 - decodeLayerChannel(file, paint, 1)![0];
    expect(cyan).toBeGreaterThan(150);
    expect(magenta).toBeLessThan(60);
    const back = importPsd(saved.bytes);
    expect(back.sourceMode).toMatchObject({ mode: 'cmyk' });
    const px = readPixel((back.layers.find((l) => l.name === 'Paint') as PixelLayer).surface, 1, 1);
    // In gamut: within a few levels of #409060.
    expect(Math.abs(px[0] - 0x40) + Math.abs(px[1] - 0x90) + Math.abs(px[2] - 0x60)).toBeLessThan(6);
    const { c: d } = setup();
    d.loadPsd(saved.bytes);
    expect(d.getColorProfile().mode).toBe('cmyk');
    expect(d.lastLoadProblems.join(' ')).toMatch(/through Pixerate Coated CMYK/);
  }, 60_000);

  it('Lab mode writes a Lab PSD that opens to the same colours', async () => {
    const { c } = setup('#c04020');
    c.setColorMode('lab');
    const saved = await c.toPsd();
    const file = readPsd(saved.bytes);
    expect(file.header.colorMode).toBe(9);
    const paint = file.layers.find((l) => l.legacyName === 'Paint')!;
    const L = decodeLayerChannel(file, paint, 0)![0];
    const a = decodeLayerChannel(file, paint, 1)![0] - 128;
    expect(L).toBeGreaterThan(90);
    expect(a).toBeGreaterThan(30);
    const px = readPixel((importPsd(saved.bytes).layers.find((l) => l.name === 'Paint') as PixelLayer).surface, 1, 1);
    expect(Math.abs(px[0] - 0xc0) + Math.abs(px[1] - 0x40) + Math.abs(px[2] - 0x20)).toBeLessThan(8);
  });

  it('modes undo, save in JSON and refuse the wrong profiles', () => {
    const { c } = setup();
    c.setColorMode('cmyk', { intent: 'perceptual' });
    const json = c.toJSON();
    expect(json).toMatchObject({ colorMode: { mode: 'cmyk', intent: 'perceptual', profile: { builtin: 'coated-cmyk' } } });
    const { c: d } = setup();
    d.loadJSON(json);
    expect(d.getColorProfile()).toMatchObject({ mode: 'cmyk', cmykProfile: { intent: 'perceptual' } });
    c.undo();
    expect(c.getColorProfile().mode).toBe('rgb');
    expect(() => c.setColorMode('cmyk', { profile: 'display-p3' })).toThrow(/needs a CMYK profile/);
    expect(() => c.setColorMode('rgb', { profile: 'srgb' })).toThrow(/no CMYK profile/);
    expect(() => c.setColorMode('hsl' as never)).toThrow(/Unknown colour mode/);
    expect(builtinProfile('coated-cmyk').colorSpace).toBe('cmyk');
  }, 60_000);

  it('set_color_mode through the tools', async () => {
    const { registry } = setup();
    const res = await registry.callTool('set_color_mode', { mode: 'cmyk', profile: 'coated-cmyk', intent: 'relative' });
    expect(res.structuredContent).toMatchObject({ mode: 'cmyk', cmykProfile: { builtin: 'coated-cmyk' } });
    expect((await registry.callTool('get_color_profile', {})).structuredContent).toMatchObject({ profile: { mode: 'cmyk' } });
    expect((await registry.callTool('set_color_mode', { mode: 'rgb' })).structuredContent).toMatchObject({ mode: 'rgb' });
    for (const [args, pattern] of [
      [{ mode: 'lab', profile: 'srgb' }, /CMYK mode only/],
      [{ mode: 'cmyk', profile: 'srgb' }, /needs a CMYK profile/],
      [{ mode: 'grey' }, /Invalid arguments|enum/],
      [{}, /Invalid arguments|required/],
    ] as const) {
      const r = await registry.callTool('set_color_mode', args as never);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(text(r)).toMatch(pattern);
    }
  }, 60_000);
});

describe('16-bit CMYK and Lab files', () => {
  /** A 16-bit document: a smooth green ramp (more levels than 8 bits hold). */
  function deepDoc() {
    const w = 300;
    const fake = { width: w, height: 2, naturalWidth: w, naturalHeight: 2 } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: w, height: 2, data: new Uint8ClampedArray(w * 2 * 4).fill(255) });
    const id = c.addPixelLayer({ name: 'Ramp', color: '#409060' });
    c.setBitDepth(16);
    const data = new Uint16Array(w * 2 * 4);
    for (let y = 0; y < 2; y++) for (let x = 0; x < w; x++) data.set([16000 + x * 7, 36000, 24000, 65535], (y * w + x) * 4);
    const surface = writeDeepRegion((c.getLayer(id) as PixelLayer).surface, { x: 0, y: 0, width: w, height: 2 }, data);
    (c as unknown as { state: { layers: PixelLayer[] } }).state.layers = [{ ...(c.getLayer(id) as PixelLayer), surface }];
    return { c, w, data };
  }

  it('a 16-bit CMYK document saves a 16-bit CMYK PSD and opens back at 16 bits', async () => {
    const { c, w, data } = deepDoc();
    c.setColorMode('cmyk');
    const saved = await c.toPsd();
    expect(saved.warnings.join(' ')).not.toMatch(/8 bits/);
    const file = readPsd(saved.bytes);
    expect(file.header).toMatchObject({ colorMode: 4, depth: 16 });
    const back = importPsd(saved.bytes);
    expect(back.bitDepth).toBe(16);
    const layer = back.layers.find((l) => l.name === 'Ramp') as PixelLayer;
    expect(surfaceDepth(layer.surface)).toBe(16);
    const px = readDeepRegion(layer.surface, { x: 0, y: 0, width: w, height: 1 }, 16);
    // More distinct levels than 8 bits can hold, and close to the original.
    expect(new Set(Array.from({ length: w }, (_, x) => px[x * 4])).size).toBeGreaterThan(200);
    for (const x of [10, 150, 290]) expect(Math.abs(px[x * 4] - data[x * 4])).toBeLessThan(1200);
  }, 60_000);

  it('a 16-bit Lab document saves a 16-bit Lab PSD', async () => {
    const { c, w, data } = deepDoc();
    c.setColorMode('lab');
    const saved = await c.toPsd();
    expect(readPsd(saved.bytes).header).toMatchObject({ colorMode: 9, depth: 16 });
    const layer = importPsd(saved.bytes).layers.find((l) => l.name === 'Ramp') as PixelLayer;
    const px = readDeepRegion(layer.surface, { x: 0, y: 0, width: w, height: 1 }, 16);
    for (const x of [10, 150, 290]) expect(Math.abs(px[x * 4] - data[x * 4])).toBeLessThan(400);
  });
});

