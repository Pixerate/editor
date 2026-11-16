import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools';
import { encodePng, bytesToBase64 } from '../src/raster/png';
import { readPixel } from '../src/raster/surface';
import { PaintEditorController, createPaintEditorToolProvider } from '../src/paint-editor';

/** A 2 × 2 PNG: red, green / blue, white. */
const quadPng = () => bytesToBase64(encodePng(2, 2, new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])));
const px = (c: PaintEditorController, id: string, x: number, y: number) => Array.from(readPixel(c.layerSurface(id)!, x, y));

function placed() {
  const c = new PaintEditorController({ width: 120, height: 80, paper: 'smooth' });
  const layer = c.placeImage({ png: quadPng() }); // 80 × 80 at (20, 0): red top-left, white bottom-right
  return { c, id: layer.id };
}

describe('transformLayer', () => {
  it('moves a layer, one undo step', () => {
    const { c, id } = placed();
    const moved = c.transformLayer({ translateX: 10, translateY: -5 });
    expect(moved.bounds).toEqual({ x: 30, y: -5, width: 80, height: 80 });
    expect(px(c, id, 35, 5)).toEqual([255, 0, 0, 255]);
    expect(c.getState().undoLabel).toBe('Transform layer');
    c.undo();
    expect(c.listLayers().find((l) => l.id === id)!.bounds).toEqual({ x: 20, y: 0, width: 80, height: 80 });
  });

  it('scales about the centre and rotates', () => {
    const { c, id } = placed();
    expect(c.transformLayer({ scaleX: 0.5, scaleY: 0.5 }).bounds).toEqual({ x: 40, y: 20, width: 40, height: 40 });
    // A quarter turn clockwise about the centre: the red top-left quarter moves to the top-right.
    c.undo();
    c.transformLayer({ rotation: 90 });
    expect(px(c, id, 95, 5)).toEqual([255, 0, 0, 255]);
    expect(px(c, id, 25, 5)).toEqual([0, 0, 255, 255]);
    // A flip mirrors it: the red quarter goes to the right.
    c.undo();
    c.transformLayer({ scaleX: -1 });
    expect(px(c, id, 95, 5)).toEqual([255, 0, 0, 255]);
  });

  it('says what is wrong', () => {
    const { c } = placed();
    expect(() => c.transformLayer({ scaleX: 0 })).toThrow('scaleX 0 is out of range; use 0.01..64 (negative flips).');
    const empty = c.addLayer();
    expect(() => c.transformLayer({ layerId: empty.id })).toThrow(/is empty; there is nothing to transform/);
    const strokes = c.addLayer({ type: 'strokes' });
    expect(() => c.transformLayer({ layerId: strokes.id })).toThrow(/is a stroke layer/);
  });
});

describe('transform_layer tool', () => {
  it('transforms through the registry and rejects bad arguments', async () => {
    const { c } = placed();
    const r = new ToolRegistry();
    r.register(createPaintEditorToolProvider(c));
    const res = await r.callTool('transform_layer', { translateX: 10 });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ bounds: { x: 30, y: 0, width: 80, height: 80 } });
    expect((await r.callTool('transform_layer', { scaleX: 0 })).isError).toBe(true);
    expect((await r.callTool('transform_layer', { spin: 1 })).isError).toBe(true);
  });
});
