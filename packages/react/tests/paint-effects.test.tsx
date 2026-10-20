// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createFakeEffectProvider } from '@pixerate/editor/effects';
import { PaintEditorController, type PaintPixelLayer } from '@pixerate/editor/paint-editor';
import { readPixel } from '@pixerate/editor/raster';
import { PaintEditor, PaintEffectsPanel } from '../src/paint-editor';
import { stubBrushThumbnails } from './paint-thumbnails';

let container: HTMLDivElement;
let root: any;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubBrushThumbnails();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  for (let i = 0; i < 4; i++) await settle();
};
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const pickEffect = (id: string) => click(container.querySelector(`[data-effect-id="${id}"]`)!);

describe('paint effects (React)', () => {
  it('sets the effect paper, adds an effect layer and bakes light onto paint', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    c.setEffectsProvider(createFakeEffectProvider());
    const base = c.getActiveLayer()!.id;
    act(() => root.render(<PaintEffectsPanel controller={c} />));
    expect(button('Light…').disabled).toBe(false);

    await click(button('Paper…'));
    await pickEffect('fake.gradient');
    expect(c.getPaperEffect()).toMatchObject({ effect: 'fake.gradient', blend: 'multiply' });
    expect(container.querySelector('[data-effect-part="paper"]')!.textContent).toContain('Gradient');

    await click(button('Layer…'));
    await pickEffect('fake.bar');
    const fx = c.getActiveLayer()!.id;
    expect(c.getEffectLayer(fx)).toMatchObject({ effect: 'fake.bar' });
    expect(container.querySelector('[data-effect-part="layer"]')).not.toBeNull();
    await click(button('Rasterize'));
    expect(c.getEffectLayer(fx)).toBeUndefined();

    c.setActiveLayer(base);
    c.fillLayer({ color: '#0a141e' });
    await settle();
    await click(button('Light…'));
    await pickEffect('fake.invert');
    expect(readPixel((c.getLayer(base) as PaintPixelLayer).surface, 0, 0)).toEqual([245, 235, 225, 255]);

    await click(container.querySelector('[aria-label="Remove the effect paper"]')!);
    expect(c.getPaperEffect()).toBeNull();
  });

  it('shows why nothing can be added without a provider, and errors from the controller', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    act(() => root.render(<PaintEffectsPanel controller={c} />));
    expect(container.textContent).toContain('No effects provider');
    expect(button('Paper…').disabled).toBe(true);
    act(() => c.setEffectsProvider(createFakeEffectProvider()));
    expect(button('Paper…').disabled).toBe(false);
    await click(button('Light…'));
    await pickEffect('fake.invert');
    expect(container.querySelector('[role="alert"]')?.textContent ?? container.textContent).toMatch(/no paint/);
  });

  it('PaintEditor shows an Effects tab only with a provider', () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    act(() => root.render(<PaintEditor controller={c} />));
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain('Effects');
    act(() => c.setEffectsProvider(createFakeEffectProvider()));
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toContain('Effects');
  });
});
