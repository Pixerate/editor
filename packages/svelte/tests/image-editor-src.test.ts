import { describe, it, expect, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { ImageEditor, createReactiveImageEditor } from '../src/image-editor';

describe('Svelte ImageEditor - src prop', () => {
  it('does not revert AI results back to the src prop', async () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
    const editor = createReactiveImageEditor({ image: 'orig.png' });
    const loadSpy = vi.spyOn(editor.controller, 'loadImage');
    const target = document.createElement('div');
    document.body.appendChild(target);

    const component = mount(ImageEditor, { target, props: { editor, src: 'orig.png' } });
    flushSync();

    await editor.applyInpaintedImage('data:image/png;base64,inpainted');
    flushSync();
    await Promise.resolve();
    flushSync();

    expect(editor.state.sourceUrl).toBe('data:image/png;base64,inpainted');
    // The src prop is never reloaded over the AI result.
    expect(loadSpy.mock.calls.some((c) => c[0] === 'orig.png')).toBe(false);

    unmount(component);
    target.remove();
    editor.destroy();
  });
});

describe('Svelte ImageEditor - white balance tint and process versions', () => {
  const legacyAdjustments = { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 20, blur: 0, opacity: 1 };

  it('exposes tint and upgradeProcess through the rune', () => {
    const editor = createReactiveImageEditor({ initialState: { adjustments: legacyAdjustments } });
    expect(editor.state.adjustments.process).toBe(1);
    expect(editor.upgradeProcess()).toBe(true);
    expect(editor.state.adjustments.process).toBe(2);
    editor.setAdjustments({ tint: -15 });
    expect(editor.toJSON().adjustments).toMatchObject({ tint: -15, process: 2, temperature: 20 });
    editor.destroy();
  });

  it('shows a tint slider and an update notice for legacy edits', () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
    const editor = createReactiveImageEditor({ initialState: { adjustments: legacyAdjustments } });
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(ImageEditor, { target, props: { editor } });
    flushSync();

    const adjustBtn = Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Adjustments');
    adjustBtn!.click();
    flushSync();
    const tint = target.querySelector('input[aria-label="Tint"]') as HTMLInputElement;
    expect(tint).not.toBeNull();
    expect(tint.disabled).toBe(true);
    const notice = target.querySelector('[data-testid="image-editor-process-notice"]');
    expect(notice).not.toBeNull();
    (notice!.querySelector('button') as HTMLButtonElement).click();
    flushSync();
    expect(editor.state.adjustments.process).toBe(2);
    expect(target.querySelector('[data-testid="image-editor-process-notice"]')).toBeNull();
    expect((target.querySelector('input[aria-label="Tint"]') as HTMLInputElement).disabled).toBe(false);

    unmount(component);
    target.remove();
    editor.destroy();
  });
});
