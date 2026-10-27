import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { IMAGE_ADJUSTMENT_CONTROLS, ImageEditorController } from '@pixerate/editor/image-editor';
import { AdjustmentLayersPanel, ControlSlider, CurvesEditor, ImageEditor, ImageEffectControls } from '../src/image-editor';

let target: HTMLDivElement;
let components: Record<string, any>[] = [];
beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(() => {
  components.forEach((c) => unmount(c));
  components = [];
  target.remove();
});
const put = (C: any, props: Record<string, unknown>) => {
  components.push(mount(C, { target, props }));
  flushSync();
};

const PALETTE = /\b(?:bg|text|border|ring|accent)-(?:slate|indigo|purple|emerald|rose)-\d/;
const tabs = ['Transform & Crop', 'Adjustments', 'Layers', 'Paint', 'Select & Mask', 'Annotations', 'Depth Mask', 'AI Tools'];

describe('image editor theme tokens (Svelte)', () => {
  it('ImageEditor uses shadcn tokens in every tab, and marks the open tab', () => {
    put(ImageEditor, {});
    for (const label of tabs) {
      const tab = [...target.querySelectorAll('[data-image-tab]')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
      tab.click();
      flushSync();
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(tab.className).toContain('bg-primary');
      expect(target.innerHTML).not.toMatch(PALETTE);
    }
    expect(target.querySelector('[role="tablist"]')).toBeTruthy();
  });

  it('panels take class', () => {
    const c = new ImageEditorController();
    const spec = IMAGE_ADJUSTMENT_CONTROLS[0]!;
    put(AdjustmentLayersPanel, { controller: c, class: 'x-adjust' });
    put(ControlSlider, { spec, value: 0, onchange: () => {}, class: 'x-slider' });
    put(CurvesEditor, { points: [{ x: 0, y: 0 }, { x: 255, y: 255 }], onchange: () => {}, class: 'x-curves' });
    put(ImageEffectControls, { provider: null, effect: 'fake.tint', values: {}, onchange: () => {}, onpreset: () => {}, class: 'x-effect' });
    expect(target.querySelector('[data-testid="adjustment-layers-panel"]')!.className).toContain('x-adjust');
    expect(target.querySelector(`[data-control-id="${spec.id}"]`)!.className).toContain('x-slider');
    expect(target.querySelector('[data-testid="curves-editor"]')!.getAttribute('class')).toContain('x-curves');
    expect(target.querySelector('[data-testid="image-effect-controls"]')!.className).toContain('x-effect');
    expect(target.innerHTML).not.toMatch(PALETTE);
  });
});
