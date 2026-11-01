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

/** Sets a form field's value the way a person would, so React sees the change. */
const enter = async (el: HTMLInputElement | HTMLSelectElement, value: string, event: 'input' | 'change' | 'blur') => {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    if (event === 'blur') el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    else el.dispatchEvent(new Event(event, { bubbles: true }));
  });
  await settle();
  await settle();
};

describe('ImageProviderEffectsPanel (React)', () => {
  it('applies a filter effect from Add filter as a smart filter, edits it and removes it', async () => {
    const { c, id } = setup();
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    expect(container.textContent).toMatch(/No filters yet/);
    await click(button('Add filter…'));
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

  it('keeps the layer\'s transparency for a new filter, toggled by Keep transparency', async () => {
    const { c, id } = setup();
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    await click(button('Add filter…'));
    await click(q('[data-effect-id="fake.invert"]'));
    const f = (c.getLayer(id) as SmartObjectLayer).smartFilters!.filters[0];
    expect(f).toMatchObject({ kind: 'effect', preserveTransparency: true });
    const keep = q<HTMLInputElement>('input[aria-label="Invert: keep transparency"]');
    expect(keep.checked).toBe(true);
    await click(keep);
    expect((c.getLayer(id) as SmartObjectLayer).smartFilters!.filters[0]).toMatchObject({ preserveTransparency: false });
    expect(q<HTMLInputElement>('input[aria-label="Invert: keep transparency"]').checked).toBe(false);
  });

  it('adds an effect layer above the active layer, clipped to it with Clip to layer below', async () => {
    const { c, id } = setup();
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    await click(q('input[aria-label="Clip to layer below"]'));
    await click(button('Add effect layer…'));
    await click(q('[data-effect-id="fake.gradient"]'));
    const layers = c.getState().layers;
    const added = layers[layers.length - 1];
    expect(added).toMatchObject({ type: 'pixel', clipped: true, generator: { effect: 'fake.gradient' } });
    expect(layers[layers.length - 2].id).toBe(id);
  });

  it('leaves layer styles to the layer\'s properties', async () => {
    const { c, id } = setup();
    c.addLayerEffect(id, 'drop-shadow');
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    expect(container.querySelector('[data-testid="layer-effects"]')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).toMatch(/Layer styles such as a drop shadow are in the layer's properties/);
  });

  it('shows an effect layer\'s controls, changes its effect and rasterizes it', async () => {
    const { c } = setup();
    const id = await c.addEffectLayer('fake.bar');
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    await settle();
    expect(q('[data-effect-part="generator"]').textContent).toMatch(/Lower-third bar/);
    await click(button('Change…'));
    await click(q('[data-effect-id="fake.gradient"]'));
    expect((c.getLayer(id) as PixelLayer).generator).toMatchObject({ effect: 'fake.gradient', values: { opacity: 0 } });
    await settle();
    expect(container.querySelectorAll('[data-effect-control]').length).toBe(5);
    await click(button('Rasterize'));
    expect((c.getLayer(id) as PixelLayer).generator).toBeUndefined();
  });

  it('picks a still frame or an animation with its length', async () => {
    const { c } = setup();
    const id = await c.addEffectLayer('fake.gradient');
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    await settle();
    expect(q('[data-effect-part="timing"] [aria-checked="true"]').textContent).toBe('Still frame');
    const frame = q<HTMLInputElement>('input[aria-label="Frame"]');
    expect(frame.max).toBe('4000');
    await enter(frame, '1000', 'input');
    expect((c.getLayer(id) as PixelLayer).generator!.time).toBe(1000);
    await click(button('Animate'));
    expect(c.getAnimation()).toMatchObject({ duration: 4000 });
    await enter(q<HTMLInputElement>('input[aria-label="Animation length in seconds"]'), '2.5', 'blur');
    expect((c.getLayer(id) as PixelLayer).generator!.animate).toEqual({ duration: 2500 });
    await click(button('Still frame'));
    expect(c.getAnimation()).toBeNull();
  });

  it('without a provider, says so and adds no filters', async () => {
    const { c } = setup(null);
    await act(async () => root.render(<ImageProviderEffectsPanel controller={c} />));
    expect(container.textContent).toMatch(/No effects provider/);
    expect(button('Add filter…')).toBeUndefined();
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
