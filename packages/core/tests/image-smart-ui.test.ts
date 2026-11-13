import { describe, expect, it } from 'vitest';
import {
  ImageEditorController,
  SMART_FILTER_MENU,
  replaceSmartObjectContentsFromFile,
  smartFilterControls,
  smartObjectBadge,
  smartObjectPanel,
  type SmartObjectLayer,
} from '../src/image-editor';
import { encodePng } from '../src/raster/png';

const W = 20;
const H = 10;

function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  const id = c.addPixelLayer({ name: 'Logo', color: '#ff0000' });
  c.convertToSmartObject([id]);
  return { c, id };
}
const smart = (c: ImageEditorController, id: string) => c.getLayer(id) as SmartObjectLayer;

describe('smartObjectPanel', () => {
  it('says why there is nothing to show for a layer that is not a smart object', () => {
    const { c } = setup();
    const plain = c.addPixelLayer({ name: 'Plain' });
    const model = smartObjectPanel(c, plain);
    expect(model.available).toBe(false);
    expect(model.reason).toMatch(/Convert to Smart Object/);
    expect(model.filters).toEqual([]);
  });

  it('describes the contents, the filter stack top first, the mask and linked instances', () => {
    const { c, id } = setup();
    c.setActiveLayer(id);
    const blur = c.addSmartFilter(id, { kind: 'blur', radius: 2 });
    const develop = c.addSmartFilter(id, { kind: 'develop', exposure: 20 });
    let model = smartObjectPanel(c);
    expect(model).toMatchObject({ available: true, layerId: id, filtersEnabled: true, mask: null, editable: true });
    expect(model.contents).toMatchObject({ kind: 'raster', width: W, height: H, decoded: true, linkedPath: null, instances: 1 });
    expect(model.filters.map((r) => [r.filter.id, r.label, r.index])).toEqual([
      [develop.id, 'Develop', 1],
      [blur.id, 'Blur (2 px)', 0],
    ]);

    c.setSmartFilterMask(id, 'reveal-all', { linked: false });
    c.setSmartFiltersEnabled(id, false);
    c.copySmartObject(id, true);
    model = smartObjectPanel(c, id);
    expect(model.filtersEnabled).toBe(false);
    expect(model.mask).toEqual({ enabled: true, linked: false });
    expect(model.contents!.instances).toBe(2);
  });

  it('is not editable while the layer is locked', () => {
    const { c, id } = setup();
    c.setLayerProperties(id, { locks: { all: true } });
    expect(smartObjectPanel(c, id).editable).toBe(false);
  });
});

describe('smartObjectBadge', () => {
  it('is null for other layers and counts linked instances', () => {
    const { c, id } = setup();
    const plain = c.addPixelLayer({ name: 'Plain' });
    expect(smartObjectBadge(c.getLayers(), c.getLayer(plain)!)).toBeNull();
    expect(smartObjectBadge(c.getLayers(), c.getLayer(id)!)).toEqual({ label: 'Smart object', instances: 1 });
    c.copySmartObject(id, true);
    expect(smartObjectBadge(c.getLayers(), c.getLayer(id)!)).toEqual({ label: 'Smart object, linked to 1 other', instances: 2 });
    c.copySmartObject(id, true);
    expect(smartObjectBadge(c.getLayers(), c.getLayer(id)!)).toEqual({ label: 'Smart object, linked to 2 others', instances: 3 });
  });
});

describe('smartFilterControls', () => {
  it('lists blending options, then the settings the filter kind has, under keys update_smart_filter takes', () => {
    const { c, id } = setup();
    const blur = c.addSmartFilter(id, { kind: 'blur', radius: 3, opacity: 0.5 });
    const develop = c.addSmartFilter(id, { kind: 'develop', exposure: 20 });
    const blurControls = smartFilterControls(blur);
    expect(blurControls.map((x) => x.key)).toEqual(['blend', 'opacity', 'radius']);
    expect(blurControls[1]).toMatchObject({ type: 'range', value: 0.5, percent: true });
    expect(blurControls[2]).toMatchObject({ type: 'range', value: 3, unit: 'px' });
    const blend = blurControls[0];
    expect(blend.type === 'select' && blend.options.some((o) => o.value === 'pigment')).toBe(false);
    expect(smartFilterControls(develop).map((x) => x.key)).toEqual(['blend', 'opacity', 'exposure', 'contrast', 'brightness', 'saturation', 'temperature', 'tint']);
    // Every key is a change the controller accepts.
    for (const control of smartFilterControls(develop)) {
      if (control.type === 'range') c.updateSmartFilter(id, develop.id, { [control.key]: control.value });
    }
    expect(SMART_FILTER_MENU.map((m) => m.kind)).toEqual(['develop', 'blur']);
  });
});

describe('getLayerThumbnail filterMask', () => {
  it('previews the smart filter mask in grey, and is null without one', () => {
    const { c, id } = setup();
    expect(c.getLayerThumbnail(id, { filterMask: true })).toBeNull();
    expect(c.getLayerThumbnail(id)).not.toBeNull();
    c.addSmartFilter(id, { kind: 'blur', radius: 2 });
    c.setSmartFilterMask(id, 'hide-all');
    const thumb = c.getLayerThumbnail(id, { maxSide: 10, filterMask: true })!;
    expect([thumb.width, thumb.height]).toEqual([10, 5]);
    expect(Array.from(thumb.data.slice(0, 4))).toEqual([0, 0, 0, 255]);
    // Not a smart object: no filter mask to show.
    const plain = c.addPixelLayer({ name: 'Plain' });
    expect(c.getLayerThumbnail(plain, { filterMask: true })).toBeNull();
  });
});

describe('replaceSmartObjectContentsFromFile', () => {
  it('replaces the contents with a picked PNG, named after the file', async () => {
    const { c, id } = setup();
    const png = encodePng(4, 2, new Uint8ClampedArray(4 * 2 * 4).fill(128));
    const file = { name: 'swatch.png', type: 'image/png', arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) } as unknown as Blob & { name: string };
    const result = await replaceSmartObjectContentsFromFile(c, id, file);
    expect(result).toMatchObject({ width: 4, height: 2 });
    expect(smart(c, id).contents).toMatchObject({ name: 'swatch.png', width: 4, height: 2 });
  });
});
