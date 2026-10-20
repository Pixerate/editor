import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { ImageEditorController, createImageEditorToolProvider, displayTransform, documentProfile, readPixel, type PixelLayer } from '../src/image-editor';
import { builtinProfile, encodeProfile, parseProfile } from '../src/cms';
import { readPsd, resource } from '../src/image-editor/psd/file';

const W = 8;
const H = 4;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const id = c.addPixelLayer({ name: 'Red', color: '#e01010' });
  const registry = new ToolRegistry();
  registry.register(createImageEditorToolProvider(c));
  return { c, id, registry };
}
const px = (c: ImageEditorController, id: string) => readPixel((c.getLayer(id) as PixelLayer).surface, 1, 1);
const text = (res: { content?: unknown[] }) => String((res.content?.[0] as { text?: string })?.text);

describe('document colour profile', () => {
  it('assigning keeps the numbers; converting keeps the colours; both undo', () => {
    const { c, id } = setup();
    expect(c.getColorProfile()).toMatchObject({ builtin: 'srgb', srgb: true, colorSpace: 'rgb' });
    c.assignProfile('display-p3');
    expect(c.getColorProfile()).toMatchObject({ builtin: 'display-p3', srgb: false, name: 'Display P3' });
    expect(px(c, id)).toEqual([0xe0, 0x10, 0x10, 255]);
    c.undo();
    expect(c.getColorProfile().builtin).toBe('srgb');
    const res = c.convertToProfile('display-p3', { intent: 'relative' });
    expect(res.convertedLayerIds).toContain(id);
    const p3 = px(c, id);
    // The same red is less saturated as P3 numbers.
    expect(p3[0]).toBeLessThan(0xe0);
    expect(p3[1]).toBeGreaterThan(0x10);
    // …and converting back gives the original within a level.
    c.convertToProfile('srgb');
    const back = px(c, id);
    for (let k = 0; k < 3; k++) expect(Math.abs(back[k] - [0xe0, 0x10, 0x10][k])).toBeLessThanOrEqual(1);
    c.undo();
    c.undo();
    expect(px(c, id)).toEqual([0xe0, 0x10, 0x10, 255]);
    expect(c.getColorProfile().builtin).toBe('srgb');
  });

  it('refuses non-RGB working spaces and unknown names', () => {
    const { c } = setup();
    expect(() => c.assignProfile('coated-cmyk')).toThrow(/needs an RGB profile/);
    expect(() => c.convertToProfile('lab-d50')).toThrow(/needs an RGB profile/);
    expect(() => c.assignProfile('wide gamut thing')).toThrow(/Unknown colour profile/);
  }, 60_000);

  it('PSD embeds the profile and opening it assigns it; JSON keeps it', async () => {
    const { c } = setup();
    c.assignProfile('adobe-rgb-compat');
    const { bytes } = await c.toPsd();
    const icc = resource(readPsd(bytes), 1039)!;
    expect(parseProfile(icc).description).toMatch(/Adobe RGB/);
    const { c: d } = setup();
    d.loadPsd(bytes);
    expect(d.getColorProfile().name).toMatch(/Adobe RGB/);
    const json = c.toJSON();
    expect(json).toMatchObject({ colorProfile: { builtin: 'adobe-rgb-compat' } });
    const { c: e } = setup();
    e.loadJSON(json);
    expect(e.getColorProfile().builtin).toBe('adobe-rgb-compat');
    // An sRGB document embeds sRGB, and opens as sRGB.
    const { c: f } = setup();
    const plain = await f.toPsd();
    expect(parseProfile(resource(readPsd(plain.bytes), 1039)!).description).toBe('sRGB IEC61966-2.1');
    // Embedded ICC bytes that are not built in survive a JSON round trip.
    const { c: g } = setup();
    const custom = { ...builtinProfile('display-p3'), description: 'My Display' };
    g.assignProfile(encodeProfile(custom));
    const { c: h } = setup();
    h.loadJSON(g.toJSON());
    expect(h.getColorProfile()).toMatchObject({ name: 'My Display', builtin: null });
  });

  it('the display transform converts non-sRGB documents and soft-proofs with a gamut warning', () => {
    expect(displayTransform(undefined, null)).toBeNull();
    const p3 = displayTransform(documentProfile('display-p3'), null)!;
    const red = Uint8ClampedArray.from([255, 0, 0, 255]);
    p3(red);
    // P3 red is outside sRGB: clipped to sRGB red.
    expect(red[0]).toBe(255);
    const mid = Uint8ClampedArray.from([200, 100, 50, 255]);
    p3(mid);
    expect(mid[0]).toBeGreaterThan(200);
    const proof = displayTransform(undefined, { profile: documentProfile('coated-cmyk'), intent: 'relative', bpc: true, simulatePaper: false, gamutWarning: true })!;
    const blue = Uint8ClampedArray.from([0, 0, 255, 255, 128, 128, 128, 255]);
    proof(blue);
    expect([...blue.subarray(0, 3)]).toEqual([128, 128, 128]);
    expect(Math.abs(blue[4] - 128)).toBeLessThan(12);
  }, 60_000);
});

describe('colour management agent tools', () => {
  it('read, assign, convert, proof and convert colours', async () => {
    const { c, id, registry } = setup();
    const got = await registry.callTool('get_color_profile', {});
    expect(got.structuredContent).toMatchObject({ profile: { builtin: 'srgb' }, proof: null });
    expect((got.structuredContent as { builtins: unknown[] }).builtins.length).toBeGreaterThan(5);
    expect((await registry.callTool('assign_profile', { profile: 'Display P3' })).structuredContent).toMatchObject({ builtin: 'display-p3' });
    const conv = await registry.callTool('convert_to_profile', { profile: 'srgb', intent: 'perceptual', bpc: false });
    expect(conv.structuredContent).toMatchObject({ profile: { builtin: 'srgb' }, convertedLayerIds: expect.arrayContaining([id, 'background']) });
    const proof = await registry.callTool('set_proof_setup', { profile: 'coated-cmyk', gamutWarning: true });
    expect(proof.structuredContent).toMatchObject({ builtin: 'coated-cmyk', intent: 'relative', gamutWarning: true });
    expect(c.getState().proofSetup).toBeTruthy();
    expect((await registry.callTool('set_proof_setup', { off: true })).isError).toBeFalsy();
    expect(c.getState().proofSetup).toBeNull();
    const cmyk = await registry.callTool('convert_colors', { colors: ['#ffffff', '#000000'], to: 'coated-cmyk' });
    const out = (cmyk.structuredContent as { colors: Array<{ values: number[]; lab: number[] }> }).colors;
    expect(out[0].values).toHaveLength(4);
    expect(Math.max(...out[0].values)).toBeLessThan(0.02);
    expect(out[1].values[3]).toBeGreaterThan(0.6);
    expect(out[0].lab[0]).toBeCloseTo(100, 0);
    const toP3 = await registry.callTool('convert_colors', { colors: ['#ff0000'], to: 'display-p3' });
    expect((toP3.structuredContent as { colors: Array<{ hex: string }> }).colors[0].hex).toMatch(/^#[0-9a-f]{6}$/);
    for (const [name, args, pattern] of [
      ['assign_profile', { profile: 'coated-cmyk' }, /needs an RGB profile/],
      ['assign_profile', {}, /Invalid arguments|required/],
      ['convert_to_profile', { profile: 'srgb', intent: 'vivid' }, /Invalid arguments|enum/],
      ['set_proof_setup', {}, /Pass the profile/],
      ['set_proof_setup', { off: true, profile: 'srgb' }, /not both/],
      ['convert_colors', { colors: ['red'], to: 'srgb' }, /Invalid colour "red"/],
      ['assign_profile', { profile: 'icc:AAAA' }, /truncated|ICC/],
    ] as const) {
      const res = await registry.callTool(name, args as never);
      expect(res.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(text(res)).toMatch(pattern);
    }
  }, 60_000);
});
