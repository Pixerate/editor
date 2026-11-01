import { describe, expect, it } from 'vitest';
import { ImageEditorController, extractNormalizedLayerItems } from '../src/image-editor';
import { decodePngDataUrl } from '../src/image-editor/layers/serialize';

const W = 96;
const H = 72;
const CX = 48;
const CY = 36;
const R = 14;

/** A red disc on green. */
function photo(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = Math.hypot(x + 0.5 - CX, y + 0.5 - CY) <= R;
      data.set(inside ? [200, 30, 40, 255] : [60, 160, 70, 255], (y * W + x) * 4);
    }
  }
  return data;
}

/** A controller on a photo, its Background read from the document image (as hosts open it). */
function setup() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: W, height: H, data: photo() });
  c.selectEllipse({ x: CX - R, y: CY - R, width: 2 * R, height: 2 * R });
  return c;
}

describe('extractNormalizedLayerItems', () => {
  it("shows Separate Subject's subject through its mask, not as a copy of the photo", async () => {
    const c = setup();
    const bg = c.getLayers()[0].id;
    const r = await c.separateSubject({ layerId: bg, fill: 'none' });
    const items = extractNormalizedLayerItems(c, 'data:image/png;base64,PHOTO');
    const subject = items.find((i) => i.id === r.foregroundLayerId)!;
    // The disc's bounds, not the whole canvas.
    expect(subject.width * W).toBeLessThanOrEqual(2 * R + 1);
    expect(subject.height * H).toBeLessThanOrEqual(2 * R + 1);
    expect(subject.x * W).toBeGreaterThanOrEqual(CX - R - 1);
    expect(subject.imageUrl).not.toBe('data:image/png;base64,PHOTO');
    const png = decodePngDataUrl(subject.imageUrl, 4);
    expect(png.width).toBe(Math.round(subject.width * W));
    // Red in the middle, transparent in the corner the disc leaves out.
    const mid = ((png.height >> 1) * png.width + (png.width >> 1)) * 4;
    expect(Array.from(png.data.slice(mid, mid + 4))).toEqual([200, 30, 40, 255]);
    expect(png.data[3]).toBe(0);
    // The hidden source still reads the document image.
    expect(items.find((i) => i.id === bg)!.imageUrl).toBe('data:image/png;base64,PHOTO');
  });

  it('keeps an unmasked layer as its stored pixels, and reuses a masked image until it changes', async () => {
    const c = setup();
    const id = c.layerViaCopy();
    const copy = extractNormalizedLayerItems(c).find((i) => i.id === id)!;
    expect(copy.imageUrl).toBe(c.getLayerDataURL(id));
    c.addLayerMask(id, 'selection');
    const first = c.getMaskedLayerImage(id);
    expect(c.getMaskedLayerImage(id)).toBe(first);
    c.selectRect({ x: 0, y: 0, width: CX, height: H });
    c.addLayerMask(id, 'selection');
    const second = c.getMaskedLayerImage(id)!;
    expect(second).not.toBe(first);
    expect(second.bounds.x + second.bounds.width).toBeLessThanOrEqual(CX);
  });

  it('gives a layer its mask hides completely no image', () => {
    const c = setup();
    const id = c.layerViaCopy();
    c.addLayerMask(id, 'hide-all');
    expect(c.getMaskedLayerImage(id)).toBeNull();
    expect(c.getMaskedLayerImage('nope')).toBeNull();
  });
});
