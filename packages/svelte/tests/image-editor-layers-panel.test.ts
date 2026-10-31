import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { ImageEditorController, type GroupLayer } from '@pixerate/editor/image-editor';
import { ImageEditor, LayersPanel, createReactiveImageEditor } from '../src/image-editor';

let target: HTMLDivElement;
let component: Record<string, any> | null = null;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  target = document.createElement('div');
  document.body.appendChild(target);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target.remove();
});

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  flushSync();
}
const button = (text: string) =>
  Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};
const rowNames = () => Array.from(target.querySelectorAll('[role="treeitem"]')).map((r) => r.querySelector('span.truncate')?.textContent);
const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => flushSync());

function controller() {
  const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
  return c;
}

describe('Svelte LayersPanel', () => {
  it('sets the bits per channel as an undo step', () => {
    const c = controller();
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    const select = target.querySelector('select[aria-label="Bits per channel"]') as HTMLSelectElement;
    expect(select.value).toBe('8');
    setValue(select, '32');
    expect(c.bitDepth).toBe(32);
    c.undo();
    flushSync();
    expect((target.querySelector('select[aria-label="Bits per channel"]') as HTMLSelectElement).value).toBe('8');
  });

  it('lists layers top first and runs layer actions as undo steps', async () => {
    const c = controller();
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    expect(rowNames()).toEqual(['Background']);
    click(button('New Layer'));
    await settle();
    click(button('New Group'));
    await settle();
    expect(rowNames()).toEqual(['Group', 'Layer 1', 'Background']);
    expect(target.querySelector('[aria-selected="true"]')!.getAttribute('data-layer-id')).toBe(c.getState().activeLayerId);
    click(target.querySelector(`[data-layer-id="${c.getLayers()[1].id}"]`));
    const blendMenu = target.querySelector('select[aria-label="Layer blend mode"]') as HTMLSelectElement;
    expect(Array.from(blendMenu.options).find((o) => o.value === 'pigment')?.textContent?.trim()).toBe('Pigment');
    setValue(blendMenu, 'pigment');
    flushSync();
    expect(c.getLayers()[1].blend).toBe('pigment');
    setValue(target.querySelector('select[aria-label="Layer blend mode"]')!, 'multiply');
    expect(c.getLayers()[1].blend).toBe('multiply');
    setValue(target.querySelector('input[aria-label="Layer opacity"]')!, '40');
    expect(c.getLayers()[1].opacity).toBe(0.4);
    click(target.querySelector('button[aria-label="Hide Layer 1"]'));
    expect(c.getLayers()[1].visible).toBe(false);
    c.undo();
    flushSync();
    expect(c.getLayers()[1].visible).toBe(true);
    click(button('Add Mask'));
    await settle();
    expect(c.getState().activeTarget).toBe('mask');
    const mask = target.querySelector('[data-testid="layer-mask-thumbnail"]') as HTMLElement;
    mask.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    flushSync();
    expect(c.getLayers()[1].mask!.enabled).toBe(false);
    mask.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    flushSync();
    expect(c.getSelection()).not.toBeNull();
    c.deselect();
    const thumbs = target.querySelectorAll('[data-testid="layer-thumbnail"]');
    thumbs[thumbs.length - 1]!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
    flushSync();
    expect(c.getSelection()).not.toBeNull();
    // Alt-click shows the mask alone in grey, and the thumbnail says so; again to go back.
    const maskThumb = () => target.querySelector('[data-testid="layer-mask-thumbnail"]') as HTMLElement;
    maskThumb().dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    flushSync();
    expect(c.getMaskView()).toEqual({ layerId: c.getLayers()[1].id, mode: 'gray' });
    expect(maskThumb().getAttribute('aria-label')).toContain('(shown)');
    maskThumb().dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    flushSync();
    expect(c.getMaskView()).toBeNull();
    expect(maskThumb().getAttribute('aria-label')).not.toContain('(shown)');
    // A vector mask from the menu: its own thumbnail, Shift-click turns it off.
    const menuItem = async (label: string) => {
      click(target.querySelector('button[aria-label="Layer menu"]'));
      click(Array.from(target.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === label) as HTMLButtonElement);
      await settle();
    };
    await menuItem('Add Vector Mask (Hide All)');
    const vector = () => target.querySelector('[data-testid="layer-vector-mask-thumbnail"]') as HTMLElement | null;
    expect(vector()).not.toBeNull();
    vector()!.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    flushSync();
    expect(c.getLayers()[1].vectorMask!.enabled).toBe(false);
    expect(vector()!.getAttribute('aria-label')).toContain('(disabled)');
    await menuItem('Delete Vector Mask');
    expect(vector()).toBeNull();
    click(target.querySelector('button[aria-label="Layer menu"]'));
    const del = Array.from(target.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Delete Layer') as HTMLButtonElement;
    click(del);
    await settle();
    expect(rowNames()).toEqual(['Group', 'Background']);
  });

  it('renames on double-click, shows refusals, and drops into groups', async () => {
    const c = controller();
    const a = c.addPixelLayer({ name: 'A' });
    const g = c.addGroup({ name: 'G' });
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    const name = Array.from(target.querySelectorAll('span.truncate')).find((s) => s.textContent === 'A') as HTMLElement;
    name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    const input = target.querySelector('input[aria-label="Layer name"]') as HTMLInputElement;
    input.value = 'Paint';
    input.dispatchEvent(new FocusEvent('blur'));
    flushSync();
    expect(c.getLayer(a)!.name).toBe('Paint');
    const groupRow = target.querySelector(`[data-layer-id="${g}"]`) as HTMLElement;
    groupRow.getBoundingClientRect = () => ({ top: 0, height: 20, left: 0, width: 100, bottom: 20, right: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const drop = new Event('drop', { bubbles: true }) as any;
    drop.clientY = 10;
    drop.dataTransfer = { getData: () => a };
    groupRow.dispatchEvent(drop);
    flushSync();
    expect((c.getLayer(g) as GroupLayer).children.map((l) => l.id)).toEqual([a]);
    c.setLayerProperties('background', { locks: { all: true } });
    c.setActiveLayer('background');
    flushSync();
    click(button('Delete'));
    await settle();
    expect(target.querySelector('[role="alert"]')!.textContent).toMatch(/locked/);
  });

  it('is part of the ImageEditor as a Layers tab', () => {
    const editor = createReactiveImageEditor();
    component = mount(ImageEditor, { target, props: { editor } });
    flushSync();
    click(button('Layers'));
    expect(target.querySelector('[data-testid="layers-panel"]')).not.toBeNull();
  });
});

describe('Svelte LayersPanel PSD buttons', () => {
  const wait = () => new Promise((r) => setTimeout(r, 20)).then(() => flushSync());

  it('exports and opens PSD files, showing the warnings', async () => {
    const source = controller();
    source.addPixelLayer({ name: 'Painted', color: '#ff0000' });
    const { bytes } = await source.toPsd();

    const c = controller();
    component = mount(LayersPanel, { target, props: { controller: c, psdFileName: 'shot.jpg' } });
    flushSync();
    const input = target.querySelector('[data-testid="psd-file-input"]') as HTMLInputElement;
    expect(input.accept).toContain('.psd');
    Object.defineProperty(input, 'files', { value: [new File([bytes as BlobPart], 'shot.psd')], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait();
    expect(rowNames()).toEqual(['Painted', 'Background']);
    expect(c.getState().sourceUrl).toBeNull();

    // Export: a crop cannot be written, and the panel says so (the download is skipped in jsdom).
    c.setCrop({ x: 0, y: 0, width: 5, height: 5 });
    const createObjectURL = URL.createObjectURL;
    (URL as any).createObjectURL = undefined;
    click(button('Export PSD'));
    await wait();
    (URL as any).createObjectURL = createObjectURL;
    expect(target.textContent).toMatch(/crop is not applied/);
    click(button('Dismiss'));
    expect(target.querySelector('[data-testid="psd-warnings"]')).toBeNull();
  });

  it('shows why a file cannot be opened', async () => {
    const c = controller();
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    const input = target.querySelector('[data-testid="psd-file-input"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([new Uint8Array(40)], 'x.psd')], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait();
    expect(target.textContent).toMatch(/8BPS/);
    expect(rowNames()).toEqual(['Background']);
  });

  it('hides the PSD buttons with psd={false}', () => {
    component = mount(LayersPanel, { target, props: { controller: controller(), psd: false } });
    flushSync();
    expect(button('Export PSD')).toBeUndefined();
  });
});

describe('Svelte EdgeColorPanel', () => {
  it('sets edge colour on the active layer with one undo step per drag, and shows why it cannot', async () => {
    const c = controller();
    const id = c.addPixelLayer({ name: 'Cutout', color: '#ff0000' });
    c.selectRect({ x: 4, y: 2, width: 10, height: 6 }, { feather: 2 });
    c.addLayerMask(id, 'selection');
    c.deselect();
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    const slider = target.querySelector('input[aria-label="Edge decontaminate"]') as HTMLInputElement;
    expect(slider).not.toBeNull();
    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    setValue(slider, '40');
    setValue(slider, '80');
    expect(c.getEdgeColor(id).decontaminate).toBe(80);
    c.undo();
    flushSync();
    expect(c.getEdgeColor(id).decontaminate).toBe(0);
    click(target.querySelector('input[aria-label="Fixed cast colour"]'));
    expect(c.getEdgeColor(id).ambientSource).toBe('#808080');

    const hard = c.addPixelLayer({ name: 'Hard', color: '#00ff00' });
    c.setActiveLayer(hard);
    await settle();
    setValue(target.querySelector('input[aria-label="Edge despill"]') as HTMLInputElement, '50');
    expect(target.querySelector('[data-testid="edge-color-panel"] [role="alert"]')!.textContent).toMatch(/no mask with a soft edge/);
    expect(c.getLayer(hard)!.edge).toBeUndefined();
  });
});

describe('Svelte VectorMaskEdgesPanel', () => {
  it('lists soft vector mask edges and edits their mode and settings', () => {
    const c = controller();
    const id = c.addPixelLayer({ name: 'Cutout', color: '#ff0000' });
    c.addVectorMask(id, 'path', { shape: { kind: 'rect', x: 4, y: 2, width: 10, height: 6 } });
    c.setVectorMaskEdge(id, { component: 0, subpath: 0, segment: 1 }, 'feather');
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    expect(target.querySelectorAll('[data-testid="vector-mask-edge"]')).toHaveLength(1);
    setValue(target.querySelector('select[aria-label="Edge mode"]') as HTMLSelectElement, 'matte');
    expect(c.getVectorMask(id)!.edges[0]).toMatchObject({ mode: 'matte', inner: 4, outer: 8 });
    setValue(target.querySelector('input[aria-label="Edge matte outer"]') as HTMLInputElement, '12');
    expect(c.getVectorMask(id)!.edges[0]).toMatchObject({ mode: 'matte', outer: 12 });
    setValue(target.querySelector('select[aria-label="Edge mode"]') as HTMLSelectElement, 'hard');
    flushSync();
    expect(c.getVectorMask(id)!.edges).toEqual([]);
    expect(target.querySelectorAll('[data-testid="vector-mask-edge"]')).toHaveLength(0);
  });
});
