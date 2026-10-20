// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ColorProfilePanel } from '../src/image-editor';
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

function setSelect(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
}
const button = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

describe('React ColorProfilePanel', () => {
  it('assigns, converts and sets up proofing', async () => {
    const fake = { width: 4, height: 2, naturalWidth: 4, naturalHeight: 2 } as unknown as HTMLImageElement;
    const c = new ImageEditorController({ image: fake });
    c.setSamplePixels({ width: 4, height: 2, data: new Uint8ClampedArray(32).fill(200) });
    await act(async () => root.render(<ColorProfilePanel controller={c} />));
    expect(container.querySelector('[data-testid="color-profile-name"]')!.textContent).toBe('sRGB IEC61966-2.1');
    await act(async () => setSelect(container.querySelector('select[aria-label="Target profile"]')!, 'adobe-rgb-compat'));
    await act(async () => button('Assign').click());
    expect(c.getColorProfile().builtin).toBe('adobe-rgb-compat');
    expect(container.querySelector('[data-testid="color-profile-name"]')!.textContent).toMatch(/Adobe RGB/);
    await act(async () => setSelect(container.querySelector('select[aria-label="Target profile"]')!, 'srgb'));
    await act(async () => setSelect(container.querySelector('select[aria-label="Rendering intent"]')!, 'perceptual'));
    await act(async () => button('Convert').click());
    expect(c.getColorProfile().builtin).toBe('srgb');
    await act(async () => setSelect(container.querySelector('select[aria-label="Proof profile"]')!, 'display-p3'));
    expect(c.getState().proofSetup?.profile.builtin).toBe('display-p3');
    await act(async () => (container.querySelector('input[aria-label="Gamut warning"]') as HTMLInputElement).click());
    expect(c.getState().proofSetup?.gamutWarning).toBe(true);
    await act(async () => setSelect(container.querySelector('select[aria-label="Proof profile"]')!, ''));
    expect(c.getState().proofSetup).toBeNull();
    await act(async () => setSelect(container.querySelector('select[aria-label="Target profile"]')!, 'display-p3'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
