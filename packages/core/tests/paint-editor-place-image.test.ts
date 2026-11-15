import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { encodePng, bytesToBase64 } from '../src/raster/png';
import { readPixel } from '../src/raster/surface';
import { PaintEditorController, createPaintEditorToolProvider, resampleImage } from '../src/paint-editor';

/** A 2 × 2 PNG: red, green / blue, white. */
const quadPng = () => bytesToBase64(encodePng(2, 2, new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])));

const pixel = (c: PaintEditorController, id: string, x: number, y: number) => Array.from(readPixel(c.layerSurface(id)!, x, y));

describe('placeImage', () => {
  it('fits the image inside the canvas on a new active layer above the active one, one undo step', () => {
    const c = new PaintEditorController({ width: 120, height: 80, paper: 'smooth' });
    const below = c.getState().document.activeLayerId!;
    const before = c.listLayers().length;
    const layer = c.placeImage({ png: quadPng(), name: 'Photo' });
    expect(layer).toMatchObject({ name: 'Photo', active: true, bounds: { x: 20, y: 0, width: 80, height: 80 } });
    expect(c.listLayers().map((l) => l.id).slice(0, 2)).toEqual([layer.id, below]);
    expect(pixel(c, layer.id, 25, 5)).toEqual([255, 0, 0, 255]);
    expect(pixel(c, layer.id, 95, 75)).toEqual([255, 255, 255, 255]);
    expect(pixel(c, layer.id, 5, 5)[3]).toBe(0);
    expect(c.getState().undoLabel).toBe('Place image');
    c.undo();
    expect(c.listLayers()).toHaveLength(before);
  });

  it('cover fills the canvas and crops the overflow', () => {
    const c = new PaintEditorController({ width: 120, height: 80, paper: 'smooth' });
    expect(c.placeImage({ png: quadPng(), fit: 'cover' }).bounds).toEqual({ x: 0, y: 0, width: 120, height: 80 });
  });

  it('says what is wrong with bad input', () => {
    const c = new PaintEditorController({ width: 120, height: 80, paper: 'smooth' });
    expect(() => c.placeImage({ png: 'nope' })).toThrow(/could not be decoded|not a data URL/);
    expect(() => c.placeImage({ png: quadPng(), fit: 'stretch' as 'cover' })).toThrow('fit "stretch" is not one of contain, cover.');
    expect(() => c.placeImage({ png: quadPng(), aboveId: 'missing' })).toThrow('Unknown layer "missing". Call list_layers for the ids.');
  });

  it('resamples on premultiplied colour, so clear pixels do not darken edges', () => {
    const out = resampleImage({ width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]) }, 8, 1);
    for (let x = 0; x < 8; x++) if (out.data[x * 4 + 3] > 0) expect(Array.from(out.data.subarray(x * 4, x * 4 + 3))).toEqual([255, 0, 0]);
    // Shrinking averages a box of samples.
    const half = resampleImage({ width: 4, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]) }, 1, 1);
    expect(half.data[0]).toBeGreaterThan(100);
    expect(half.data[0]).toBeLessThan(155);
  });
});

describe('place_image tool', () => {
  it('places an image and reports errors', async () => {
    const c = new PaintEditorController({ width: 120, height: 80, paper: 'smooth' });
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c));
    const res = await r.callTool('place_image', { png: quadPng(), fit: 'contain' });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ type: 'pixel', bounds: { x: 20, y: 0, width: 80, height: 80 } });
    expect((await r.callTool('place_image', { png: quadPng(), fit: 'stretch' })).isError).toBe(true);
    expect((await r.callTool('place_image', {})).isError).toBe(true);
  });
});
