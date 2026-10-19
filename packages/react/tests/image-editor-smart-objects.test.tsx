// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LayersPanel, SmartObjectPanel } from '../src/image-editor';
import { ImageEditorController, type SmartObjectLayer } from '@pixerate/editor/image-editor';

let container: HTMLDivElement;
let root: any;
const win: any = window;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
});

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  container = document.getElementById('root') as HTMLDivElement;
  root = createRoot(container);
});

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof win.HTMLSelectElement ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new win.Event(el instanceof win.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

const q = <T extends Element>(sel: string) => container.querySelector(sel) as T;
const click = (el: Element | null) => (el as HTMLElement).click();
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

function setup() {
  const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
  const id = c.addPixelLayer({ name: 'Logo', color: '#ff0000' });
  c.convertToSmartObject([id]);
  return { c, id };
}
const smart = (c: ImageEditorController, id: string) => c.getLayer(id) as SmartObjectLayer;

describe('SmartObjectPanel (React)', () => {
  it('adds, edits, reorders, hides and removes smart filters, one undo step per drag', async () => {
    const { c, id } = setup();
    await act(async () => root.render(<SmartObjectPanel controller={c} />));
    expect(q('[data-testid="smart-contents"]').textContent).toMatch(/Logo\.png · 20 × 10 px/);
    await act(async () => setValue(q<HTMLSelectElement>('select[aria-label="Add smart filter"]'), 'blur'));
    expect(smart(c, id).smartFilters!.filters.map((f) => f.kind)).toEqual(['blur']);
    expect(q('[data-testid="smart-filter-settings"]')).toBeTruthy();
    const steps = (c as any).undoStack.length;
    await act(async () => {
      q('input[aria-label="Radius"]').dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
      setValue(q<HTMLInputElement>('input[aria-label="Radius"]'), '4');
    });
    await act(async () => setValue(q<HTMLInputElement>('input[aria-label="Radius"]'), '6'));
    expect(smart(c, id).smartFilters!.filters[0]).toMatchObject({ radius: 6 });
    expect((c as any).undoStack.length).toBe(steps + 1);
    await act(async () => setValue(q<HTMLSelectElement>('select[aria-label="Mode"]'), 'screen'));
    expect(smart(c, id).smartFilters!.filters[0].blend).toBe('screen');
    await act(async () => setValue(q<HTMLSelectElement>('select[aria-label="Add smart filter"]'), 'develop'));
    expect(smart(c, id).smartFilters!.filters.map((f) => f.kind)).toEqual(['blur', 'develop']);
    // The top filter is listed first; moving it down puts it under the blur.
    await act(async () => click(q('button[aria-label="Move Develop down"]')));
    expect(smart(c, id).smartFilters!.filters.map((f) => f.kind)).toEqual(['develop', 'blur']);
    await act(async () => click(q('input[aria-label="Develop on"]')));
    expect(smart(c, id).smartFilters!.filters[0].enabled).toBe(false);
    await act(async () => click(q('input[aria-label="Smart filters on"]')));
    expect(smart(c, id).smartFilters!.enabled).toBe(false);
    await act(async () => click(q('button[aria-label="Remove Develop"]')));
    expect(smart(c, id).smartFilters!.filters.map((f) => f.kind)).toEqual(['blur']);
  });

  it('adds the filter mask, toggles it and paints it', async () => {
    const { c, id } = setup();
    c.addSmartFilter(id, { kind: 'develop', exposure: 40 });
    await act(async () => root.render(<SmartObjectPanel controller={c} />));
    await act(async () => click(button('Add')));
    expect(smart(c, id).smartFilters!.mask).toBeTruthy();
    expect(c.getState().activeTarget).toBe('filter-mask');
    await act(async () => click(q('input[aria-label="Filter mask on"]')));
    expect(smart(c, id).smartFilters!.mask!.enabled).toBe(false);
    await act(async () => click(q('input[aria-label="Filter mask linked"]')));
    expect(smart(c, id).smartFilters!.mask!.linked).toBe(false);
    await act(async () => click(q('button[aria-label="Remove filter mask"]')));
    expect(smart(c, id).smartFilters!.mask).toBeUndefined();
  });

  it('opens the contents, copies, and rasterizes', async () => {
    const { c, id } = setup();
    await act(async () => root.render(<SmartObjectPanel controller={c} />));
    await act(async () => click(button('New via Copy')));
    const copy = c.getState().activeLayerId!;
    expect(smart(c, copy).contents.id).not.toBe(smart(c, id).contents.id);
    await act(async () => click(button('Rasterize')));
    expect(c.getLayer(copy)!.type).toBe('pixel');
    c.setActiveLayer(id);
    await act(async () => {});
    await act(async () => click(button('Edit Contents')));
    expect(c.getState().editingContents).toEqual([{ layerId: id, name: 'Logo' }]);
    c.closeSmartObjectContents(false);
  });
});

describe('LayersPanel smart objects (React)', () => {
  it('badges smart objects, lists their filters and edits contents with a Save bar', async () => {
    const { c, id } = setup();
    c.addSmartFilter(id, { kind: 'blur', radius: 2 });
    c.copySmartObject(id, true);
    await act(async () => root.render(<LayersPanel controller={c} psd={false} />));
    const badges = container.querySelectorAll('[data-testid="smart-object-badge"]');
    expect(badges).toHaveLength(2);
    expect(badges[0].getAttribute('aria-label')).toBe('Smart object, linked to 1 other');
    expect(q('[data-testid="smart-object"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="smart-filters-row"]')).toHaveLength(2);
    const row = container.querySelector(`li[data-layer-id="${id}"]`)!;
    const filterEye = row.nextElementSibling!.nextElementSibling!.querySelector('button')!;
    expect(filterEye.getAttribute('aria-label')).toBe('Hide Blur (2 px)');
    await act(async () => click(filterEye));
    expect(smart(c, id).smartFilters!.filters[0].enabled).toBe(false);
    const thumb = row.querySelector('[data-testid="smart-object-badge"]')!.parentElement!;
    await act(async () => thumb.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true })));
    expect(q('[data-testid="smart-editing"]').textContent).toMatch(/Editing contents: Logo/);
    c.fillPixels({ color: '#0000ff', useSelection: false });
    await act(async () => click(button('Save & Close')));
    expect(c.getState().editingContents).toBeUndefined();
    expect(q('[data-testid="smart-editing"]')).toBeNull();
    expect(Array.from(c.compositePixels({ x: 1, y: 1, width: 1, height: 1 }).data)).toEqual([0, 0, 255, 255]);
  });

  it('converts the active layer from the layer menu', async () => {
    const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    const id = c.addPixelLayer({ name: 'Plain', color: '#00ff00' });
    await act(async () => root.render(<LayersPanel controller={c} psd={false} />));
    await act(async () => click(q('button[aria-label="Layer menu"]')));
    await act(async () => click([...container.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Convert to Smart Object')!));
    expect(c.getLayer(id)!.type).toBe('smart');
  });
});
