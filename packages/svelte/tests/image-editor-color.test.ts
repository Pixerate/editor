import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { ImageEditorController } from '@pixerate/editor/image-editor';
import { ColorProfilePanel } from '../src/image-editor';

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

function setSelect(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
}
const button = (text: string) => Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('Svelte ColorProfilePanel', () => {
  it('assigns, converts, sets the mode and sets up proofing', () => {
    const fake = { width: 4, height: 2, naturalWidth: 4, naturalHeight: 2 } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: 4, height: 2, data: new Uint8ClampedArray(32).fill(200) });
    component = mount(ColorProfilePanel, { target, props: { controller: c } });
    flushSync();
    expect(target.querySelector('[data-testid="color-profile-name"]')!.textContent).toBe('sRGB IEC61966-2.1');
    setSelect(target.querySelector('select[aria-label="Target profile"]')!, 'adobe-rgb-compat');
    button('Assign').click();
    flushSync();
    expect(c.getColorProfile().builtin).toBe('adobe-rgb-compat');
    expect(target.querySelector('[data-testid="color-profile-name"]')!.textContent).toMatch(/Adobe RGB/);
    setSelect(target.querySelector('select[aria-label="Target profile"]')!, 'srgb');
    setSelect(target.querySelector('select[aria-label="Rendering intent"]')!, 'perceptual');
    button('Convert').click();
    flushSync();
    expect(c.getColorProfile().builtin).toBe('srgb');
    setSelect(target.querySelector('select[aria-label="Proof profile"]')!, 'display-p3');
    expect(c.getState().proofSetup?.profile.builtin).toBe('display-p3');
    (target.querySelector('input[aria-label="Gamut warning"]') as HTMLInputElement).click();
    flushSync();
    expect(c.getState().proofSetup?.gamutWarning).toBe(true);
    setSelect(target.querySelector('select[aria-label="Proof profile"]')!, '');
    expect(c.getState().proofSetup).toBeNull();
    setSelect(target.querySelector('select[aria-label="Colour mode"]')!, 'cmyk');
    expect(c.getColorProfile()).toMatchObject({ mode: 'cmyk', cmykProfile: { builtin: 'coated-cmyk' } });
    expect(target.querySelector('[role="alert"]')).toBeNull();
  }, 60_000);
});
