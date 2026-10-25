// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageEditorCanvas, useImageEditor, type ImageEditorCanvasProps, type UseImageEditorReturn } from '../src/image-editor';
import { FreeTransformTool, createImageEditorToolProvider } from '@pixerate/editor/image-editor';
import { ToolRegistry, createAgentPlayback, createInstantPresenceClock, type PlaybackRef } from '@pixerate/editor/tools';
import { useAgentToolProvider } from '../src';

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
afterEach(() => act(() => root.unmount()));

const fake = { width: 300, height: 150, naturalWidth: 300, naturalHeight: 150, src: 'data:fake' } as unknown as HTMLImageElement;
const pointer = (type: string, x: number, y: number) => {
  const e = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' || type === 'pointerup' ? 0 : 1 });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', pressure: 0.5 });
  return e;
};
const canvas = () => container.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;

async function renderCanvas(props: Partial<ImageEditorCanvasProps> = {}) {
  let editor!: UseImageEditorReturn;
  function Host() {
    editor = useImageEditor({ image: fake });
    return <ImageEditorCanvas editor={editor} className="h-64 w-96" {...props} />;
  }
  await act(async () => root.render(<Host />));
  const c = editor.controller;
  c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
  return { editor: () => editor, c };
}

describe('ImageEditorCanvas (React)', () => {
  it('renders on its own, sized by its box, with the class it is given', async () => {
    await renderCanvas();
    const rootEl = container.querySelector('[data-testid="image-editor-canvas-root"]') as HTMLElement;
    expect(rootEl.className).toContain('h-64');
    expect(canvas()).toBeTruthy();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('paints in paint mode and ignores the same gesture in none mode', async () => {
    const { c } = await renderCanvas({ mode: 'none' });
    let id!: string;
    await act(async () => {
      id = c.addPixelLayer();
      c.setTool('brush');
    });
    await act(async () => {
      canvas().dispatchEvent(pointer('pointerdown', 120, 70));
      canvas().dispatchEvent(pointer('pointermove', 150, 75));
      canvas().dispatchEvent(pointer('pointerup', 150, 75));
    });
    expect(c.getLayerBounds(id)).toBeNull();
  });

  it('paints in paint mode', async () => {
    const { c } = await renderCanvas({ mode: 'paint' });
    let id!: string;
    await act(async () => {
      id = c.addPixelLayer();
      c.setTool('brush');
    });
    await act(async () => {
      canvas().dispatchEvent(pointer('pointerdown', 120, 70));
      canvas().dispatchEvent(pointer('pointermove', 150, 75));
      canvas().dispatchEvent(pointer('pointerup', 150, 75));
    });
    expect(c.getLayerBounds(id)).not.toBeNull();
  });

  it('reports gesture errors through onError', async () => {
    const errors: Array<[string, string | null]> = [];
    const { c } = await renderCanvas({ mode: 'paint', onError: (source, message) => errors.push([source, message]) });
    await act(async () => c.setTool('move'));
    await act(async () => canvas().dispatchEvent(pointer('pointerdown', 50, 50)));
    expect(errors.at(-1)?.[0]).toBe('paint');
    expect(errors.at(-1)?.[1]).toMatch(/layer/i);
  });

  it('crops in crop mode', async () => {
    const { c } = await renderCanvas({ mode: 'crop' });
    await act(async () => c.setTool('crop'));
    await act(async () => {
      canvas().dispatchEvent(pointer('mousedown', 10, 10));
      canvas().dispatchEvent(pointer('mousemove', 200, 120));
      canvas().dispatchEvent(pointer('mouseup', 200, 120));
    });
    expect(c.getState().crop).not.toBeNull();
  });

  it('drives a Free Transform tool the host passes in', async () => {
    let tool!: FreeTransformTool;
    let editor!: UseImageEditorReturn;
    function Host() {
      editor = useImageEditor({ image: fake });
      const [t] = React.useState(() => new FreeTransformTool(editor.controller));
      tool = t;
      return <ImageEditorCanvas editor={editor} transformTool={t} />;
    }
    await act(async () => root.render(<Host />));
    const c = editor.controller;
    c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
    await act(async () => void c.addPixelLayer({ name: 'P', color: '#3366cc' }));
    await act(async () => void tool.begin());
    expect(tool.active).toBe(true);
    expect(canvas().className).toContain('touch-none');
    await act(async () => tool.cancel());
    expect(canvas().className).not.toContain('touch-none');
  });

  it('plays on its surface and answers chrome refs through locateElement and open', async () => {
    const playback = createAgentPlayback({ clock: createInstantPresenceClock(), linger: 0 });
    const registry = new ToolRegistry();
    const opened: PlaybackRef[] = [];
    const slider = document.createElement('div');
    slider.getBoundingClientRect = () => ({ left: 10, top: 10, width: 20, height: 10, right: 30, bottom: 20, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    function Host() {
      const editor = useImageEditor({ image: fake });
      const provider = useMemo(() => createImageEditorToolProvider(editor.controller, { id: 'img', namespace: 'img' }), [editor.controller]);
      useAgentToolProvider(registry, provider, { playback });
      return (
        <ImageEditorCanvas
          editor={editor}
          playback={playback}
          playbackId="img"
          locateElement={(ref) => (ref.kind === 'control' ? slider : null)}
          open={(ref) => void opened.push(ref)}
        />
      );
    }
    await act(async () => root.render(<Host />));
    const surface = playback.surface('img')!;
    expect(surface).toBeTruthy();
    (surface as { visible?: () => boolean }).visible = () => true;
    expect(surface.locate!({ kind: 'control', id: 'contrast' })).toBeTruthy();
    const steps = playback.record();
    const result = await act(() => registry.callTool('img__set_adjustments', { values: { contrast: 20 } }));
    expect(result.isError).toBeFalsy();
    expect(steps.map((r) => r.step.type)).toEqual(['open', 'target', 'commit']);
    expect(opened).toEqual([{ kind: 'panel', id: 'adjust' }]);
    expect(container.querySelector('.pixerate-presence')).toBeTruthy();
  });
});
