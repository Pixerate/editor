// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LayerEffectsPanel, LayersPanel } from '../src/image-editor';
import { ImageEditorController } from '@pixerate/editor/image-editor';

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

function setup() {
  const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
  const id = c.addPixelLayer({ name: 'Shape' });
  return { c, id };
}

describe('LayerEffectsPanel (React)', () => {
  it('adds an effect, edits a setting with one undo step per drag, toggles and removes it', async () => {
    const { c, id } = setup();
    await act(async () => root.render(<LayerEffectsPanel controller={c} />));
    await act(async () => setValue(q<HTMLSelectElement>('select[aria-label="Add style"]'), 'drop-shadow'));
    const fx = c.getLayerEffects(id);
    expect(fx.items.map((e) => e.kind)).toEqual(['drop-shadow']);
    // The new effect opens with its settings.
    expect(q('[data-testid="effect-settings"]')).toBeTruthy();
    const distance = q<HTMLInputElement>('input[aria-label="Distance"]');
    await act(async () => {
      distance.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true }));
      setValue(distance, '12');
      setValue(distance, '20');
      distance.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true }));
    });
    expect(c.getLayerEffects(id).items[0]).toMatchObject({ distance: 20 });
    c.undo();
    expect(c.getLayerEffects(id).items[0]).toMatchObject({ distance: 5 });
    await act(async () => setValue(q<HTMLInputElement>('input[aria-label="Opacity"]'), '40'));
    expect((c.getLayerEffects(id).items[0] as { opacity: number }).opacity).toBeCloseTo(0.4);
    await act(async () => q<HTMLInputElement>('input[aria-label="Drop Shadow on"]').click());
    expect(c.getLayerEffects(id).items[0].enabled).toBe(false);
    await act(async () => q<HTMLInputElement>('input[aria-label="Effects on"]').click());
    expect(c.getLayerEffects(id).enabled).toBe(false);
    await act(async () => setValue(q<HTMLInputElement>('input[aria-label="Scale effects"]'), '150'));
    expect(c.getLayerEffects(id).scale).toBe(1.5);
    await act(async () => q<HTMLButtonElement>('button[aria-label="Remove Drop Shadow"]').click());
    expect(c.getLayer(id)!.effects?.items ?? []).toEqual([]);
  });

  it('switches a stroke fill to a gradient and shows its controls', async () => {
    const { c, id } = setup();
    c.addLayerEffect(id, 'stroke');
    await act(async () => root.render(<LayerEffectsPanel controller={c} />));
    await act(async () => q<HTMLButtonElement>('[data-effect-id] button[aria-expanded]').click());
    await act(async () => setValue(q<HTMLSelectElement>('select[aria-label="Fill"]'), 'gradient'));
    expect((c.getLayerEffects(id).items[0] as { fill: { type: string } }).fill.type).toBe('gradient');
    expect(q('input[aria-label="End colour"]')).toBeTruthy();
  });

  it('explains why adjustment layers have no effects', async () => {
    const { c } = setup();
    const adj = c.addAdjustmentLayer({ kind: 'curves' });
    await act(async () => root.render(<LayerEffectsPanel controller={c} layerId={adj} />));
    expect(container.textContent).toMatch(/Adjustment layers cannot have a layer style/);
  });

  it('shows an fx badge in the layers panel that switches the effects on and off', async () => {
    const { c, id } = setup();
    c.addLayerEffect(id, 'color-overlay');
    await act(async () => root.render(<LayersPanel controller={c} psd={false} />));
    expect(q('[data-testid="layer-effects"]')).toBeTruthy();
    const badge = q<HTMLButtonElement>('[data-testid="layer-fx-badge"]');
    expect(badge.getAttribute('aria-label')).toBe('Turn effects off for Shape');
    await act(async () => badge.click());
    expect(c.getLayerEffects(id).enabled).toBe(false);
    expect(q<HTMLButtonElement>('[data-testid="layer-fx-badge"]').getAttribute('aria-pressed')).toBe('false');
  });
});
