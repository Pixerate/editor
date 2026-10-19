// @vitest-environment jsdom
// The DOM must exist before react-dom loads, or range inputs never fire onChange.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageEditor, LayersPanel, SelectionOptionsBar, useImageEditor } from '../src/image-editor';
import { DEFAULT_SELECTION_TOOL_OPTIONS, ImageEditorController, pngDataUrl, type PixelLayer, type SelectionToolOptions } from '@pixerate/editor/image-editor';

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

const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement;
function setValue(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
}

describe('React layer integrations', () => {
  it('background removal masks the active layer in a multi-layer document', async () => {
    let c!: ImageEditorController;
    const { width, height } = { width: 800, height: 600 };
    const alpha = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) alpha.set([0, 0, 0, p % width < 400 ? 0 : 255], p * 4);
    const onRemoveBackground = vi.fn().mockResolvedValue(pngDataUrl(width, height, alpha));
    function Host() {
      const editor = useImageEditor();
      c = editor.controller;
      return <ImageEditor editor={editor} onRemoveBackground={onRemoveBackground} />;
    }
    await act(async () => root.render(<Host />));
    c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
    let id!: string;
    await act(async () => {
      id = c.addPixelLayer({ color: '#ff0000' });
    });
    await act(async () => button('AI Tools').click());
    const target = container.querySelector('select[aria-label="AI result target"]') as HTMLSelectElement;
    expect(target.options[0].textContent).toBe('Auto (new layer)');
    await act(async () => button('Remove Background').click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(onRemoveBackground).toHaveBeenCalled();
    expect((c.getLayer(id) as PixelLayer).mask).toBeDefined();
    // Forcing replace keeps the old behaviour.
    await act(async () => setValue(target, 'replace'));
    expect(target.value).toBe('replace');
  });

  it('the selection options bar chooses the sample source', async () => {
    const c = new ImageEditorController();
    let options: SelectionToolOptions = { ...DEFAULT_SELECTION_TOOL_OPTIONS };
    function Host() {
      const [o, setO] = React.useState(options);
      options = o;
      return <SelectionOptionsBar controller={c} options={o} onOptionsChange={setO} />;
    }
    await act(async () => root.render(<Host />));
    await act(async () => setValue(container.querySelector('select[aria-label="Sample from"]') as HTMLSelectElement, 'active-layer'));
    expect(options.sample).toBe('active-layer');
  });

  it('the layers menu offers Rasterize Layer for filtered pixel layers', async () => {
    const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
    const id = c.addPixelLayer({ color: '#808080' });
    c.addLayerFilter(id, { kind: 'develop', exposure: 20 });
    await act(async () => root.render(<LayersPanel controller={c} />));
    await act(async () => (container.querySelector('button[aria-label="Layer menu"]') as HTMLButtonElement).click());
    const item = Array.from(container.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Rasterize Layer') as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    await act(async () => item.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect((c.getLayer(id) as PixelLayer).filters).toBeUndefined();
  });
});
