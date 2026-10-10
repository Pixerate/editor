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
    expect(loadSpy.mock.calls.map((c) => c[0])).toEqual(['data:image/png;base64,inpainted']);

    unmount(component);
    target.remove();
    editor.destroy();
  });
});
