import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { ImageEditorController } from '@pixerate/editor/image-editor';
import { LayerEffectsPanel, LayersPanel } from '../src/image-editor';

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

function setup() {
  const fake = { width: 20, height: 10, naturalWidth: 20, naturalHeight: 10 } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake });
  c.setSamplePixels({ width: 20, height: 10, data: new Uint8ClampedArray(800).fill(255) });
  const id = c.addPixelLayer({ name: 'Shape' });
  return { c, id };
}

describe('LayerEffectsPanel (Svelte)', () => {
  it('adds an effect, edits a setting with one undo step per drag, toggles and removes it', () => {
    const { c, id } = setup();
    component = mount(LayerEffectsPanel, { target, props: { controller: c } });
    flushSync();
    setValue(q<HTMLSelectElement>('select[aria-label="Add style"]'), 'drop-shadow');
    expect(c.getLayerEffects(id).items.map((e) => e.kind)).toEqual(['drop-shadow']);
    expect(q('[data-testid="effect-settings"]')).toBeTruthy();
    const distance = q<HTMLInputElement>('input[aria-label="Distance"]');
    distance.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    setValue(distance, '12');
    setValue(q<HTMLInputElement>('input[aria-label="Distance"]'), '20');
    q('input[aria-label="Distance"]').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(c.getLayerEffects(id).items[0]).toMatchObject({ distance: 20 });
    c.undo();
    expect(c.getLayerEffects(id).items[0]).toMatchObject({ distance: 5 });
    setValue(q<HTMLInputElement>('input[aria-label="Opacity"]'), '40');
    expect((c.getLayerEffects(id).items[0] as { opacity: number }).opacity).toBeCloseTo(0.4);
    click(q('input[aria-label="Drop Shadow on"]'));
    expect(c.getLayerEffects(id).items[0].enabled).toBe(false);
    click(q('input[aria-label="Effects on"]'));
    expect(c.getLayerEffects(id).enabled).toBe(false);
    setValue(q<HTMLInputElement>('input[aria-label="Scale effects"]'), '150');
    expect(c.getLayerEffects(id).scale).toBe(1.5);
    click(q('button[aria-label="Remove Drop Shadow"]'));
    expect(c.getLayer(id)!.effects?.items ?? []).toEqual([]);
  });

  it('switches a stroke fill to a gradient and shows its controls', () => {
    const { c, id } = setup();
    c.addLayerEffect(id, 'stroke');
    component = mount(LayerEffectsPanel, { target, props: { controller: c } });
    flushSync();
    click(q('[data-effect-id] button[aria-expanded]'));
    setValue(q<HTMLSelectElement>('select[aria-label="Fill"]'), 'gradient');
    expect((c.getLayerEffects(id).items[0] as { fill: { type: string } }).fill.type).toBe('gradient');
    expect(q('input[aria-label="End colour"]')).toBeTruthy();
  });

  it('explains why adjustment layers have no effects', () => {
    const { c } = setup();
    const adj = c.addAdjustmentLayer({ kind: 'curves' });
    component = mount(LayerEffectsPanel, { target, props: { controller: c, layerId: adj } });
    flushSync();
    expect(target.textContent).toMatch(/Adjustment layers cannot have a layer style/);
  });

  it('shows an fx badge in the layers panel that switches the effects on and off', () => {
    const { c, id } = setup();
    c.addLayerEffect(id, 'color-overlay');
    component = mount(LayersPanel, { target, props: { controller: c, psd: false } });
    flushSync();
    expect(q('[data-testid="layer-effects"]')).toBeTruthy();
    const badge = q<HTMLButtonElement>('[data-testid="layer-fx-badge"]');
    expect(badge.getAttribute('aria-label')).toBe('Turn effects off for Shape');
    click(badge);
    expect(c.getLayerEffects(id).enabled).toBe(false);
    expect(q('[data-testid="layer-fx-badge"]').getAttribute('aria-pressed')).toBe('false');
  });
});
