import { afterEach, describe, expect, it } from 'vitest';
import { ImageEditorController, SELECT_AND_MASK_VIEWS, SelectAndMaskSession, forgetSelectAndMaskSettings, selectionArea } from '../src/image-editor';

const W = 80;
const H = 60;

/** A red square (20..50, 15..45) on a grey ground. */
function scene() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= 20 && x < 50 && y >= 15 && y < 45;
      data.set(inside ? [220, 40, 40, 255] : [120, 120, 120, 255], (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data };
}

function controller() {
  const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels(scene());
  return c;
}

afterEach(() => forgetSelectAndMaskSettings());

describe('Select and Mask session', () => {
  it('previews strokes and applies them with OK as one undo step', async () => {
    const c = controller();
    const s = new SelectAndMaskSession(c);
    expect(await s.open()).toBe(true);
    expect(s.previewSize).toEqual({ width: W, height: H, scale: 1 });
    s.update({ tool: 'quick-select', brushSize: 6, params: { radius: 0 } });
    s.begin({ x: 30, y: 30 });
    s.move({ x: 40, y: 30 });
    s.end();
    expect(s.edits).toHaveLength(1);
    expect(s.coverageAt(25, 20)).toBe(1);
    expect(s.coverageAt(5, 5)).toBe(0);
    // Nothing has changed in the document yet.
    expect(c.getSelection()).toBeNull();
    const result = await s.commit();
    expect(result.output).toBe('selection');
    expect(Math.abs(selectionArea(c.getSelection()) - 900) / 900).toBeLessThan(0.05);
    c.undo();
    expect(c.getSelection()).toBeNull();
  });

  it('starts from the selection, paints with the brush, subtracts with Alt, and undoes a stroke', async () => {
    const c = controller();
    c.selectRect({ x: 20, y: 15, width: 30, height: 30 });
    const s = new SelectAndMaskSession(c);
    await s.open();
    s.update({ tool: 'brush', brushSize: 10, params: { radius: 0 } });
    expect(s.coverageAt(35, 30)).toBe(1);
    s.begin({ x: 35, y: 30 }, { altKey: true });
    s.end();
    expect(s.coverageAt(35, 30)).toBe(0);
    expect(s.undoEdit()).toBe(true);
    expect(s.coverageAt(35, 30)).toBe(1);
    expect(s.undoEdit()).toBe(false);
  });

  it('draws each view mode, Show Original and Show Edge', async () => {
    const c = controller();
    c.selectRect({ x: 20, y: 15, width: 30, height: 30 });
    const s = new SelectAndMaskSession(c);
    await s.open();
    const at = (rgba: Uint8ClampedArray, x: number, y: number) => Array.from(rgba.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
    s.update({ view: 'on-black' });
    expect(at(s.render(), 5, 5)).toEqual([0, 0, 0]);
    expect(at(s.render(), 30, 30)).toEqual([220, 40, 40]);
    s.update({ view: 'on-white' });
    expect(at(s.render(), 5, 5)).toEqual([255, 255, 255]);
    s.update({ view: 'black-white' });
    expect(at(s.render(), 30, 30)).toEqual([255, 255, 255]);
    s.update({ view: 'overlay' });
    expect(s.settings.opacity).toBe(0.5);
    expect(at(s.render(), 5, 5)[0]).toBeGreaterThan(120);
    s.update({ view: 'marching-ants' });
    const ants = at(s.render(), 20, 30);
    expect(ants[0] === 0 || ants[0] === 255).toBe(true);
    // Show Original shows the selection as it was; a brush stroke doesn't show there.
    s.update({ view: 'black-white', tool: 'brush', brushSize: 6 });
    s.begin({ x: 5, y: 5 });
    s.end();
    expect(at(s.render(), 5, 5)).toEqual([255, 255, 255]);
    s.update({ showOriginal: true });
    expect(at(s.render(), 5, 5)).toEqual([0, 0, 0]);
    s.update({ showOriginal: false, showEdge: true, view: 'on-white', params: { radius: 0, feather: 3 } });
    // Far from the edge is dimmed.
    expect(at(s.render(), 75, 55)[0]).toBeLessThan(60);
  });

  it('answers Photoshop\'s keys for views, tools, Show Edge and Show Original', async () => {
    const c = controller();
    const s = new SelectAndMaskSession(c);
    await s.open();
    expect(s.handleKey('k')).toBe(true);
    expect(s.settings.view).toBe('black-white');
    expect(s.handleKey('F')).toBe(true);
    expect(s.settings.view).toBe(SELECT_AND_MASK_VIEWS[(SELECT_AND_MASK_VIEWS.findIndex((v) => v.id === 'black-white') + 1) % SELECT_AND_MASK_VIEWS.length].id);
    s.handleKey('r');
    expect(s.settings.tool).toBe('refine-brush');
    s.handleKey('j');
    expect(s.settings.showEdge).toBe(true);
    s.handleKey('p');
    expect(s.settings.showOriginal).toBe(true);
    const size = s.settings.brushSize;
    s.handleKey(']');
    expect(s.settings.brushSize).toBeGreaterThan(size);
    expect(s.handleKey('9')).toBe(false);
  });

  it('outputs to a new layer, and remembers settings when asked', async () => {
    const c = controller();
    c.selectRect({ x: 20, y: 15, width: 30, height: 30 });
    const s = new SelectAndMaskSession(c);
    await s.open();
    s.update({ output: 'new-layer-with-mask', remember: true, view: 'on-black', params: { radius: 2 } });
    const result = await s.commit();
    expect(result.newLayerId).toBeDefined();
    expect(c.getLayers()).toHaveLength(2);
    const again = new SelectAndMaskSession(c);
    expect(again.settings).toMatchObject({ output: 'new-layer-with-mask', view: 'on-black', remember: true });
    again.update({ remember: false });
    c.selectAll();
    await again.commit();
    expect(new SelectAndMaskSession(c).settings.view).toBe('onion-skin');
  });

  it('draws an object box and a lasso', async () => {
    const c = controller();
    const s = new SelectAndMaskSession(c);
    await s.open();
    s.update({ tool: 'object', params: { radius: 0 } });
    s.begin({ x: 12, y: 8 });
    s.move({ x: 58, y: 52 });
    s.end();
    expect(s.coverageAt(35, 30)).toBe(1);
    expect(s.coverageAt(15, 10)).toBe(0);
    s.update({ tool: 'lasso', brushMode: 'subtract' });
    s.begin({ x: 20, y: 15 });
    s.move({ x: 35, y: 15 });
    s.move({ x: 35, y: 45 });
    s.move({ x: 20, y: 45 });
    s.end();
    expect(s.coverageAt(25, 30)).toBe(0);
    expect(s.coverageAt(45, 30)).toBe(1);
  });

  it('reports when the pixels cannot be read', async () => {
    const fake = { width: W, height: H, naturalWidth: W, naturalHeight: H, src: 'data:fake' } as unknown as HTMLImageElement;
    const s = new SelectAndMaskSession(new ImageEditorController({ image: fake }));
    expect(await s.open()).toBe(false);
    expect(s.error).toMatch(/pixels/);
    expect(s.render()).toHaveLength(0);
  });
});
