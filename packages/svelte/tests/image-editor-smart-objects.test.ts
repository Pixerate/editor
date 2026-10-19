import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { ImageEditorController, type SmartObjectLayer } from '@pixerate/editor/image-editor';
import { LayersPanel, SmartObjectPanel } from '../src/image-editor';

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
const q = <T extends Element>(sel: string) => target.querySelector(sel) as T;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};
const button = (text: string) => [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

function setup() {
  const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
  const id = c.addPixelLayer({ name: 'Logo', color: '#ff0000' });
  c.convertToSmartObject([id]);
  return { c, id };
}
const smart = (c: ImageEditorController, id: string) => c.getLayer(id) as SmartObjectLayer;

describe('SmartObjectPanel (Svelte)', () => {
  it('adds, edits, reorders, hides and removes smart filters, one undo step per drag', () => {
    const { c, id } = setup();
    component = mount(SmartObjectPanel, { target, props: { controller: c } });
    flushSync();
    expect(q('[data-testid="smart-contents"]').textContent).toMatch(/Logo\.png · 20 × 10 px/);
    setValue(q<HTMLSelectElement>('select[aria-label="Add smart filter"]'), 'blur');
    expect(smart(c, id).smartFilters!.filters.map((f) => f.kind)).toEqual(['blur']);
    expect(q('[data-testid="smart-filter-settings"]')).toBeTruthy();
    const steps = (c as any).undoStack.length;
    q('input[aria-label="Radius"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    setValue(q<HTMLInputElement>('input[aria-label="Radius"]'), '4');
    setValue(q<HTMLInputElement>('input[aria-label="Radius"]'), '6');
    expect(smart(c, id).smartFilters!.filters[0]).toMatchObject({ radius: 6 });
    expect((c as any).undoStack.length).toBe(steps + 1);
    setValue(q<HTMLSelectElement>('select[aria-label="Mode"]'), 'screen');
    expect(smart(c, id).smartFilters!.filters[0].blend).toBe('screen');
    setValue(q<HTMLSelectElement>('select[aria-label="Add smart filter"]'), 'develop');
    expect(smart(c, id).smartFilters!.filters.map((f) => f.kind)).toEqual(['blur', 'develop']);
    click(q('button[aria-label="Move Develop down"]'));
    expect(smart(c, id).smartFilters!.filters.map((f) => f.kind)).toEqual(['develop', 'blur']);
    click(q('input[aria-label="Develop on"]'));
    expect(smart(c, id).smartFilters!.filters[0].enabled).toBe(false);
    click(q('input[aria-label="Smart filters on"]'));
    expect(smart(c, id).smartFilters!.enabled).toBe(false);
    click(q('button[aria-label="Remove Develop"]'));
    expect(smart(c, id).smartFilters!.filters.map((f) => f.kind)).toEqual(['blur']);
  });

  it('adds the filter mask, toggles it and paints it', () => {
    const { c, id } = setup();
    c.addSmartFilter(id, { kind: 'develop', exposure: 40 });
    component = mount(SmartObjectPanel, { target, props: { controller: c } });
    flushSync();
    click(button('Add'));
    expect(smart(c, id).smartFilters!.mask).toBeTruthy();
    expect(c.getState().activeTarget).toBe('filter-mask');
    click(q('input[aria-label="Filter mask on"]'));
    expect(smart(c, id).smartFilters!.mask!.enabled).toBe(false);
    click(q('input[aria-label="Filter mask linked"]'));
    expect(smart(c, id).smartFilters!.mask!.linked).toBe(false);
    click(q('button[aria-label="Remove filter mask"]'));
    expect(smart(c, id).smartFilters!.mask).toBeUndefined();
  });

  it('opens the contents, copies, and rasterizes', () => {
    const { c, id } = setup();
    component = mount(SmartObjectPanel, { target, props: { controller: c } });
    flushSync();
    click(button('New via Copy'));
    const copy = c.getState().activeLayerId!;
    expect(smart(c, copy).contents.id).not.toBe(smart(c, id).contents.id);
    click(button('Rasterize'));
    expect(c.getLayer(copy)!.type).toBe('pixel');
    c.setActiveLayer(id);
    flushSync();
    click(button('Edit Contents'));
    expect(c.getState().editingContents).toEqual([{ layerId: id, name: 'Logo' }]);
    c.closeSmartObjectContents(false);
  });
});

describe('LayersPanel smart objects (Svelte)', () => {
  it('badges smart objects, lists their filters and edits contents with a Save bar', () => {
    const { c, id } = setup();
    c.addSmartFilter(id, { kind: 'blur', radius: 2 });
    c.copySmartObject(id, true);
    component = mount(LayersPanel, { target, props: { controller: c, psd: false } });
    flushSync();
    const badges = target.querySelectorAll('[data-testid="smart-object-badge"]');
    expect(badges).toHaveLength(2);
    expect(badges[0].getAttribute('aria-label')).toBe('Smart object, linked to 1 other');
    expect(q('[data-testid="smart-object"]')).toBeTruthy();
    expect(target.querySelectorAll('[data-testid="smart-filters-row"]')).toHaveLength(2);
    const row = target.querySelector(`li[data-layer-id="${id}"]`)!;
    const filterEye = row.nextElementSibling!.nextElementSibling!.querySelector('button')!;
    expect(filterEye.getAttribute('aria-label')).toBe('Hide Blur (2 px)');
    click(filterEye);
    expect(smart(c, id).smartFilters!.filters[0].enabled).toBe(false);
    const thumb = row.querySelector('[data-testid="smart-object-badge"]')!.parentElement!;
    thumb.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    flushSync();
    expect(q('[data-testid="smart-editing"]').textContent).toMatch(/Editing contents: Logo/);
    c.fillPixels({ color: '#0000ff', useSelection: false });
    flushSync();
    click(button('Save & Close'));
    expect(c.getState().editingContents).toBeUndefined();
    expect(q('[data-testid="smart-editing"]')).toBeNull();
    expect(Array.from(c.compositePixels({ x: 1, y: 1, width: 1, height: 1 }).data)).toEqual([0, 0, 255, 255]);
  });

  it('converts the active layer from the layer menu', () => {
    const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    const id = c.addPixelLayer({ name: 'Plain', color: '#00ff00' });
    component = mount(LayersPanel, { target, props: { controller: c, psd: false } });
    flushSync();
    click(q('button[aria-label="Layer menu"]'));
    click([...target.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Convert to Smart Object')!);
    expect(c.getLayer(id)!.type).toBe('smart');
  });
});
