import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { DEFAULT_SELECTION_TOOL_OPTIONS, ImageEditorController, pngDataUrl, type PixelLayer, type SelectionToolOptions } from '@pixerate/editor/image-editor';
import { ImageEditor, LayersPanel, SelectionOptionsBar, createReactiveImageEditor } from '../src/image-editor';

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

const button = (text: string) =>
  Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim().includes(text)) as HTMLButtonElement;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};
const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => flushSync());
function setValue(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}

describe('Svelte layer integrations', () => {
  it('background removal masks the active layer in a multi-layer document', async () => {
    const width = 800;
    const height = 600;
    const alpha = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) alpha.set([0, 0, 0, p % width < 400 ? 0 : 255], p * 4);
    const onRemoveBackground = vi.fn().mockResolvedValue(pngDataUrl(width, height, alpha));
    const editor = createReactiveImageEditor();
    const c = editor.controller;
    c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
    const id = c.addPixelLayer({ color: '#ff0000' });
    component = mount(ImageEditor, { target, props: { editor, onRemoveBackground } });
    flushSync();
    click(button('AI Tools'));
    const select = target.querySelector('select[aria-label="AI result target"]') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('Auto (new layer)');
    click(button('Remove Background'));
    await settle();
    await settle();
    expect(onRemoveBackground).toHaveBeenCalled();
    expect((c.getLayer(id) as PixelLayer).mask).toBeDefined();
  });

  it('the selection options bar chooses the sample source', () => {
    const controller = new ImageEditorController();
    const props = $state({
      controller,
      options: { ...DEFAULT_SELECTION_TOOL_OPTIONS } as SelectionToolOptions,
      onOptionsChange: (next: SelectionToolOptions) => {
        props.options = next;
      },
    });
    component = mount(SelectionOptionsBar, { target, props });
    flushSync();
    setValue(target.querySelector('select[aria-label="Sample from"]') as HTMLSelectElement, 'active-layer');
    expect(props.options.sample).toBe('active-layer');
  });

  it('the layers menu offers Rasterize Layer for filtered pixel layers', async () => {
    const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
    const id = c.addPixelLayer({ color: '#808080' });
    c.addLayerFilter(id, { kind: 'develop', exposure: 20 });
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    click(target.querySelector('button[aria-label="Layer menu"]'));
    const item = Array.from(target.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Rasterize Layer') as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    click(item);
    await settle();
    expect((c.getLayer(id) as PixelLayer).filters).toBeUndefined();
  });
});
