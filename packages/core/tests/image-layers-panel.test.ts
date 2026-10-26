import { describe, expect, it } from 'vitest';
import { ImageEditorController, dropPlacement, dropZone, layerMenu, layerPanelRows, runLayerMenuAction, type GroupLayer } from '../src/image-editor';

function setup() {
  const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
  return c;
}

describe('layers panel view model', () => {
  it('lists rows top first, indents groups and hides collapsed children', () => {
    const c = setup();
    const a = c.addPixelLayer({ name: 'A' });
    const g = c.groupLayers([a], 'G');
    c.addAdjustmentLayer('curves');
    const rows = layerPanelRows(c.getLayers(), c.getState().activeLayerId);
    expect(rows.map((r) => [r.label, r.depth])).toEqual([['Curves', 0], ['G', 0], ['A', 1], ['Background', 0]]);
    expect(rows.find((r) => r.layer.id === g)!.active).toBe(true);
    c.setLayerProperties(g, { collapsed: true });
    expect(layerPanelRows(c.getLayers(), null).map((r) => r.label)).toEqual(['Curves', 'G', 'Background']);
  });

  it('turns drops into placements', () => {
    const c = setup();
    const a = c.addPixelLayer();
    const g = c.addGroup();
    expect(dropZone(0.1, false)).toBe('above');
    expect(dropZone(0.5, true)).toBe('inside');
    expect(dropZone(0.9, true)).toBe('below');
    expect(dropPlacement(c.getLayers(), a, g, 'inside')).toEqual({ parentId: g });
    expect(dropPlacement(c.getLayers(), a, 'background', 'above')).toEqual({ aboveId: 'background' });
    expect(dropPlacement(c.getLayers(), a, a, 'above')).toBeNull();
    c.moveLayer(a, dropPlacement(c.getLayers(), a, g, 'inside')!);
    expect((c.getLayer(g) as GroupLayer).children.map((l) => l.id)).toEqual([a]);
  });

  it('enables menu items for the active layer and runs them, returning refusals', async () => {
    const c = setup();
    const menu = () => Object.fromEntries(layerMenu(c).map((m) => [m.action, m.enabled]));
    // A new image starts on its Background.
    expect(menu()).toMatchObject({ 'new-layer': true, duplicate: true, 'merge-down': false });
    c.setActiveLayer(null);
    expect(menu()).toMatchObject({ 'new-layer': true, duplicate: false, 'merge-down': false });
    expect(await runLayerMenuAction(c, 'new-layer')).toBeNull();
    expect(menu()).toMatchObject({ duplicate: true, 'merge-down': true, 'via-copy': false, 'apply-mask': false });
    expect(await runLayerMenuAction(c, 'add-mask')).toBeNull();
    expect(menu()['apply-mask']).toBe(true);
    expect(await runLayerMenuAction(c, 'merge-down')).toBeNull();
    expect(c.getLayers()).toHaveLength(1);
    expect(await runLayerMenuAction(c, 'via-copy')).toMatch(/Nothing is selected/);
  });
});
