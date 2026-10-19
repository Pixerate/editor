// @vitest-environment jsdom
// The DOM must exist before react-dom loads, or range inputs never fire onChange.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageEditor, LayersPanel, useImageEditor } from '../src/image-editor';
import { ImageEditorController, type GroupLayer } from '@pixerate/editor/image-editor';

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

const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const rowNames = () => Array.from(container.querySelectorAll('[role="treeitem"]')).map((r) => r.querySelector('span.truncate')?.textContent);

function controller() {
  const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
  return c;
}

describe('React LayersPanel', () => {
  it('lists layers top first and runs layer actions as undo steps', async () => {
    const c = controller();
    await act(async () => root.render(<LayersPanel controller={c} />));
    expect(rowNames()).toEqual(['Background']);
    await act(async () => button('New Layer').click());
    await act(async () => button('New Group').click());
    expect(rowNames()).toEqual(['Group', 'Layer 1', 'Background']);
    expect(container.querySelector('[aria-selected="true"]')!.getAttribute('data-layer-id')).toBe(c.getState().activeLayerId);
    // Select a row, change its properties.
    const layerRow = container.querySelector(`[data-layer-id="${c.getLayers()[1].id}"]`) as HTMLElement;
    await act(async () => layerRow.click());
    const blendMenu = container.querySelector('select[aria-label="Layer blend mode"]') as HTMLSelectElement;
    expect(Array.from(blendMenu.options).find((o) => o.value === 'pigment')?.textContent).toBe('Pigment');
    await act(async () => setValue(blendMenu, 'pigment'));
    expect(c.getLayers()[1].blend).toBe('pigment');
    await act(async () => setValue(container.querySelector('select[aria-label="Layer blend mode"]')!, 'multiply'));
    expect(c.getLayers()[1].blend).toBe('multiply');
    await act(async () => setValue(container.querySelector('input[aria-label="Layer opacity"]')!, '40'));
    expect(c.getLayers()[1].opacity).toBe(0.4);
    await act(async () => (container.querySelector('button[aria-label="Hide Layer 1"]') as HTMLButtonElement).click());
    expect(c.getLayers()[1].visible).toBe(false);
    c.undo();
    expect(c.getLayers()[1].visible).toBe(true);
    // Masks: add one, click the thumbnail to target it, shift-click to disable it.
    await act(async () => button('Add Mask').click());
    expect(c.getState().activeTarget).toBe('mask');
    const mask = container.querySelector('[data-testid="layer-mask-thumbnail"]') as HTMLElement;
    await act(async () => mask.dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(c.getLayers()[1].mask!.enabled).toBe(false);
    // The menu: delete via the ⋯ menu.
    await act(async () => (container.querySelector('button[aria-label="Layer menu"]') as HTMLButtonElement).click());
    const del = Array.from(container.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Delete Layer') as HTMLButtonElement;
    await act(async () => del.click());
    expect(rowNames()).toEqual(['Group', 'Background']);
  });

  it('renames on double-click, shows refusals, and drops into groups', async () => {
    const c = controller();
    const a = c.addPixelLayer({ name: 'A' });
    const g = c.addGroup({ name: 'G' });
    await act(async () => root.render(<LayersPanel controller={c} />));
    const name = Array.from(container.querySelectorAll('span.truncate')).find((s) => s.textContent === 'A') as HTMLElement;
    await act(async () => name.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true })));
    const input = container.querySelector('input[aria-label="Layer name"]') as HTMLInputElement;
    await act(async () => {
      setValue(input, 'Paint');
      input.blur();
    });
    expect(c.getLayer(a)!.name).toBe('Paint');
    // A drop on the middle of a group row moves the layer into it.
    const groupRow = container.querySelector(`[data-layer-id="${g}"]`) as HTMLElement;
    groupRow.getBoundingClientRect = () => ({ top: 0, height: 20, left: 0, width: 100, bottom: 20, right: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const drop = new win.Event('drop', { bubbles: true }) as any;
    drop.clientY = 10;
    drop.dataTransfer = { getData: () => a };
    await act(async () => groupRow.dispatchEvent(drop));
    expect((c.getLayer(g) as GroupLayer).children.map((l) => l.id)).toEqual([a]);
    // A refused action shows its reason.
    c.setLayerProperties('background', { locks: { all: true } });
    c.setActiveLayer('background');
    await act(async () => button('Delete').click());
    expect(container.querySelector('[role="alert"]')!.textContent).toMatch(/locked/);
  });

  it('is part of the ImageEditor as a Layers tab', async () => {
    function Host() {
      const editor = useImageEditor();
      return <ImageEditor editor={editor} />;
    }
    await act(async () => root.render(<Host />));
    await act(async () => button('Layers').click());
    expect(container.querySelector('[data-testid="layers-panel"]')).not.toBeNull();
  });
});

describe('React LayersPanel PSD buttons', () => {
  it('exports and opens PSD files, showing the warnings', async () => {
    const source = controller();
    source.addPixelLayer({ name: 'Painted', color: '#ff0000' });
    source.setCrop({ x: 0, y: 0, width: 10, height: 10 });
    const { bytes } = await source.toPsd();

    const c = controller();
    await act(async () => root.render(<LayersPanel controller={c} psdFileName="shot.jpg" />));
    const input = container.querySelector('[data-testid="psd-file-input"]') as HTMLInputElement;
    expect(input.accept).toContain('.psd');
    const file = new win.File([bytes], 'shot.psd');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rowNames()).toEqual(['Painted', 'Background']);
    expect(c.getState().sourceUrl).toBeNull();

    // Export: a crop cannot be written, and the panel says so. (jsdom cannot build a Blob from
    // Node's typed arrays, so the download itself is skipped here.)
    c.setCrop({ x: 0, y: 0, width: 5, height: 5 });
    const createObjectURL = URL.createObjectURL;
    (URL as any).createObjectURL = undefined;
    await act(async () => {
      button('Export PSD').click();
      await new Promise((r) => setTimeout(r, 20));
    });
    (URL as any).createObjectURL = createObjectURL;
    expect(container.textContent).toMatch(/crop is not applied/);
    await act(async () => button('Dismiss').click());
    expect(container.querySelector('[data-testid="psd-warnings"]')).toBeNull();
  });

  it('shows why a file cannot be opened', async () => {
    const c = controller();
    await act(async () => root.render(<LayersPanel controller={c} />));
    const input = container.querySelector('[data-testid="psd-file-input"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new win.File([new Uint8Array(40)], 'x.psd')], configurable: true });
    await act(async () => {
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.textContent).toMatch(/8BPS/);
    expect(rowNames()).toEqual(['Background']);
  });

  it('hides the PSD buttons with psd={false}', async () => {
    await act(async () => root.render(<LayersPanel controller={controller()} psd={false} />));
    expect(button('Export PSD')).toBeUndefined();
  });
});
