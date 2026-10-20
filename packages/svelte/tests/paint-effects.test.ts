import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { createFakeEffectProvider } from '@pixerate/editor/effects';
import { PaintEditorController, type PaintPixelLayer } from '@pixerate/editor/paint-editor';
import { readPixel } from '@pixerate/editor/raster';
import { PaintEditor, PaintEffectsPanel } from '../src/paint-editor';
import { stubBrushThumbnails } from './paint-thumbnails';

let target: HTMLDivElement;
let component: Record<string, any> | null = null;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  stubBrushThumbnails();
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target.remove();
  vi.restoreAllMocks();
});

const show = (C: any, props: Record<string, unknown>) => {
  component = mount(C, { target, props });
  flushSync();
};
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};
const button = (text: string) => Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = async (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
  await settle();
};
const pickEffect = (id: string) => click(target.querySelector(`[data-effect-id="${id}"]`));

describe('Svelte paint effects', () => {
  it('sets the effect paper, adds an effect layer and bakes light onto paint', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    c.setEffectsProvider(createFakeEffectProvider());
    const base = c.getActiveLayer()!.id;
    show(PaintEffectsPanel, { controller: c });

    await click(button('Paper…'));
    await pickEffect('fake.gradient');
    expect(c.getPaperEffect()).toMatchObject({ effect: 'fake.gradient', blend: 'multiply' });
    expect(target.querySelector('[data-effect-part="paper"]')!.textContent).toContain('Gradient');

    await click(button('Layer…'));
    await pickEffect('fake.bar');
    const fx = c.getActiveLayer()!.id;
    expect(c.getEffectLayer(fx)).toMatchObject({ effect: 'fake.bar' });
    expect(target.querySelector('[data-effect-part="layer"]')).not.toBeNull();
    await click(button('Rasterize'));
    expect(c.getEffectLayer(fx)).toBeUndefined();

    c.setActiveLayer(base);
    c.fillLayer({ color: '#0a141e' });
    flushSync();
    await click(button('Light…'));
    await pickEffect('fake.invert');
    expect(readPixel((c.getLayer(base) as PaintPixelLayer).surface, 0, 0)).toEqual([245, 235, 225, 255]);

    await click(target.querySelector('[aria-label="Remove the effect paper"]'));
    expect(c.getPaperEffect()).toBeNull();
  });

  it('shows why nothing can be added without a provider, and errors from the controller', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    show(PaintEffectsPanel, { controller: c });
    expect(target.textContent).toContain('No effects provider');
    expect(button('Paper…').disabled).toBe(true);
    c.setEffectsProvider(createFakeEffectProvider());
    flushSync();
    expect(button('Paper…').disabled).toBe(false);
    await click(button('Light…'));
    await pickEffect('fake.invert');
    expect(target.querySelector('[role="alert"]')!.textContent).toMatch(/no paint/);
  });

  it('PaintEditor shows an Effects tab only with a provider', () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    show(PaintEditor, { controller: c });
    const tabs = () => Array.from(target.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabs()).not.toContain('Effects');
    c.setEffectsProvider(createFakeEffectProvider());
    flushSync();
    expect(tabs()).toContain('Effects');
  });
});
