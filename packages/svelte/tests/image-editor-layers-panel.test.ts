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
