// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PresenceStore, ToolRegistry, createAgentPlayback, createInstantPresenceClock } from '@pixerate/editor/tools';
import { createFakeEffectProvider } from '@pixerate/editor/effects';
import { ImageEditorController, type PixelLayer, type SmartObjectLayer } from '@pixerate/editor/image-editor';
import { ImageProviderEffectsPanel, useImageEffectsTools } from '../src/image-editor';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  container = document.getElementById('root') as HTMLDivElement;
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

const q = <T extends Element>(sel: string) => {
  const el = container.querySelector(sel) as T | null;
  if (!el) throw new Error(`No element for ${sel}`);
  return el;
};
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await settle();
  await settle();
};

function setup(effects: ReturnType<typeof createFakeEffectProvider> | null = createFakeEffectProvider()) {
  const fake = { width: 8, height: 4, naturalWidth: 8, naturalHeight: 4 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, effects });
  const data = new Uint8ClampedArray(8 * 4 * 4).fill(255);
  const id = c.addPixelLayer({ name: 'Photo', pixels: { width: 8, height: 4, data } });
  return { c, id };
}

describe('ImageProviderEffectsPanel (React)', () => {
  it('applies a filter effect as a smart filter, edits it and removes it', async () => {
    const { c, id } = setup();
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    await click(button('Apply effect…'));
    await click(q('[data-effect-id="fake.invert"]'));
    const layer = c.getLayer(id) as SmartObjectLayer;
    expect(layer.type).toBe('smart');
    const f = layer.smartFilters!.filters[0];
    expect(f).toMatchObject({ kind: 'effect', effect: 'fake.invert' });
    await click(q(`[data-smart-effect="${f.id}"] input[type="checkbox"]`));
    expect((c.getLayer(id) as SmartObjectLayer).smartFilters!.filters[0].enabled).toBe(false);
    await click(q('[aria-label="Remove Invert"]'));
    expect((c.getLayer(id) as SmartObjectLayer).smartFilters?.filters ?? []).toEqual([]);
  });

  it('adds an effect layer and shows its controls', async () => {
    const { c } = setup();
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    await click(button('Effect layer…'));
    await click(q('[data-effect-id="fake.gradient"]'));
    const id = c.getState().activeLayerId!;
    expect((c.getLayer(id) as PixelLayer).generator).toMatchObject({ effect: 'fake.gradient' });
    expect(q('[data-effect-part="generator"]').textContent).toMatch(/Gradient/);
    expect(container.querySelectorAll('[data-effect-control]').length).toBe(4);
    await click(button('Rasterize'));
    expect((c.getLayer(id) as PixelLayer).generator).toBeUndefined();
  });

  it('without a provider, says so and adds nothing', async () => {
    const { c } = setup(null);
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    expect(container.textContent).toMatch(/No effects provider/);
    expect(button('Apply effect…').disabled).toBe(true);
    expect(button('Effect layer…').disabled).toBe(true);
  });

  it('useImageEffectsTools registers the tools', async () => {
    const { c, id } = setup();
    const registry = new ToolRegistry();
    function Probe() {
      useImageEffectsTools(registry, c, { namespace: 'imgfx' });
      return null;
    }
    await act(async () => root.render(<Probe />));
    const r = await act(async () => registry.callTool('imgfx__apply_effect', { target: id, effect: 'fake.tint' }));
    expect(r.isError).toBeFalsy();
  });

  it('useImageEffectsTools plays the tools on an explicit playbackSurface', async () => {
    const { c, id } = setup();
    const registry = new ToolRegistry();
    const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
    playback.install(registry);
    playback.attach('image4:surface', { presence: new PresenceStore(), locate: () => ({ x: 0, y: 0, width: 4, height: 4 }) });
    const steps = playback.record();
    function Probe() {
      useImageEffectsTools(registry, c, { namespace: 'imgfx', playbackSurface: 'image4:surface' });
      return null;
    }
    await act(async () => root.render(<Probe />));
    const r = await act(async () => registry.callTool('imgfx__apply_effect', { target: id, effect: 'fake.tint' }));
    expect(r.isError).toBeFalsy();
    expect(steps.length).toBeGreaterThan(0);
    expect(new Set(steps.map((s) => s.surface))).toEqual(new Set(['image4:surface']));
  });
});
