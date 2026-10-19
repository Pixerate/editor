import { describe, expect, it } from 'vitest';
import { ImageEditorController, PaintGesture, handlePaintShortcut, pointerPressure, readPixel, type PixelLayer } from '../src/image-editor';

function setup() {
  const fake = { width: 60, height: 30, naturalWidth: 60, naturalHeight: 30 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 60, height: 30, data: new Uint8ClampedArray(60 * 30 * 4).fill(255) });
  return c;
}

describe('paint tool view model', () => {
  it('handles Photoshop shortcuts and ignores typing', () => {
    const c = setup();
    const key = (k: string, extra: object = {}) => handlePaintShortcut(c, { key: k, ...extra });
    expect(key('b')).toBe(true);
    expect(c.getState().activeTool).toBe('brush');
    key(']');
    expect(c.getState().paint.brush.size).toBe(25);
    key('[');
    expect(c.getState().paint.brush.size).toBe(20);
    key('[', { shiftKey: true });
    expect(c.getState().paint.brush.hardness).toBe(0.75);
    key('5');
    expect(c.getState().paint.brush.opacity).toBe(0.5);
    key('0');
    expect(c.getState().paint.brush.opacity).toBe(1);
    c.setPaintOptions({ foreground: '#ff0000', background: '#00ff00' });
    key('x');
    expect(c.getState().paint).toMatchObject({ foreground: '#00ff00', background: '#ff0000' });
    key('d');
    expect(c.getState().paint).toMatchObject({ foreground: '#000000', background: '#ffffff' });
    expect(key('e')).toBe(true);
    expect(c.getState().activeTool).toBe('eraser');
    expect(key('v', { target: { tagName: 'INPUT' } })).toBe(false);
    expect(key('z', { metaKey: true })).toBe(false);
  });

  it('turns pointer events into one-undo strokes and layer moves', () => {
    const c = setup();
    const id = c.addPixelLayer();
    c.setTool('brush');
    c.setPaintOptions({ brush: { size: 6, pressureSize: false } });
    const g = new PaintGesture(c);
    expect(g.down({ x: 5, y: 5, pressure: 1 })).toBeNull();
    g.moveTo([{ x: 20, y: 5, pressure: 1 }, { x: 40, y: 5, pressure: 1 }]);
    g.up();
    const surface = () => c.getLayer(id) as PixelLayer;
    expect(readPixel(surface().surface, 30, 5)).toEqual([0, 0, 0, 255]);
    c.setTool('move');
    g.down({ x: 10, y: 10, pressure: 1 });
    g.moveTo([{ x: 13, y: 12, pressure: 1 }]);
    g.moveTo([{ x: 15, y: 14, pressure: 1 }]);
    g.up();
    expect(surface().offset).toEqual({ x: 5, y: 4 });
    c.undo();
    expect(surface().offset).toEqual({ x: 0, y: 0 });
    c.undo();
    expect(readPixel(surface().surface, 30, 5)[3]).toBe(0);
    // Refusals come back as messages.
    c.setLayerProperties(id, { locks: { pixels: true } });
    c.setTool('brush');
    expect(g.down({ x: 1, y: 1, pressure: 1 })).toMatch(/locked/);
    expect(g.active).toBe(false);
  });

  it('reads pen pressure and treats mice as full pressure', () => {
    expect(pointerPressure({ pointerType: 'pen', pressure: 0.3 })).toBe(0.3);
    expect(pointerPressure({ pointerType: 'pen', pressure: 0 })).toBe(1);
    expect(pointerPressure({ pointerType: 'mouse', pressure: 0.5 })).toBe(1);
  });
});
