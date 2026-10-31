// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ImageEditor, LayersPanel, ShapeOptionsBar, TypeOptionsBar, useImageEditor } from '../src/image-editor';
import {
  DEFAULT_SHAPE_TOOL_OPTIONS,
  DEFAULT_TYPE_TOOL_OPTIONS,
  ImageEditorController,
  createOutlineTextShaper,
  type OutlineFontFace,
  type ShapeToolOptions,
  type TypeLayer,
  type TypeToolOptions,
} from '@pixerate/editor/image-editor';

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

/** A box font (every glyph a 0.6 em box) so text lays out without a canvas. */
function boxFont(family = 'Box'): OutlineFontFace {
  const adv = (t: string) => [...t].reduce((w, c) => w + (c === ' ' ? 300 : 600), 0);
  return {
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    names: { fontFamily: { en: family } },
    getAdvanceWidth: (t, size) => (adv(t) * size) / 1000,
    getPath: (t, x, y, size) => {
      const k = size / 1000;
      const commands: any[] = [];
      let at = 0;
      for (const c of t) {
        if (c !== ' ') commands.push({ type: 'M', x: x + at * k, y }, { type: 'L', x: x + (at + 500) * k, y }, { type: 'L', x: x + (at + 500) * k, y: y - 700 * k }, { type: 'Z' });
        at += c === ' ' ? 300 : 600;
      }
      return { commands };
    },
  };
}

function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
}
const button = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const mouse = (type: string, x: number, y: number) => new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });

function controller() {
  const fake = { width: 300, height: 150, naturalWidth: 300, naturalHeight: 150, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, textShaper: createOutlineTextShaper([boxFont()]) });
  c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
  return c;
}

describe('React shape and type options bars', () => {
  it('ShapeOptionsBar picks the kind and restyles the active shape', async () => {
    const c = controller();
    const id = c.addShapeLayer({ shape: { kind: 'star', x: 10, y: 10, width: 40, height: 40 }, fill: '#000000' });
    let options: ShapeToolOptions = { ...DEFAULT_SHAPE_TOOL_OPTIONS, kind: 'star' };
    const Host = () => {
      const [o, setO] = React.useState(options);
      options = o;
      return <ShapeOptionsBar controller={c} options={o} onChange={setO} />;
    };
    await act(async () => root.render(<Host />));
    await act(async () => button('Ellipse').click());
    expect(options.kind).toBe('ellipse');
    await act(async () => button('Star').click());
    await act(async () => setValue(container.querySelector('input[aria-label="Points"]')!, '9'));
    expect(c.getShapeLayer(id).components[0].live).toMatchObject({ points: 9 });
    await act(async () => setValue(container.querySelector('input[aria-label="Fill colour"]')!, '#ff0000'));
    expect(c.getShapeLayer(id).fill).toEqual({ type: 'color', color: '#ff0000' });
    await act(async () => (container.querySelector('input[aria-label="Stroke"]') as HTMLInputElement).click());
    expect(c.getShapeLayer(id).stroke).toMatchObject({ width: 2, paint: { color: '#000000' } });
  });

  it('TypeOptionsBar styles the active type layer and shows missing fonts', async () => {
    const c = controller();
    const id = c.addTextLayer({ text: 'Hello', x: 10, y: 40, style: { fontFamily: 'Nope', fontSize: 20 } });
    let options: TypeToolOptions = DEFAULT_TYPE_TOOL_OPTIONS;
    const Host = () => {
      const [o, setO] = React.useState(options);
      options = o;
      return <TypeOptionsBar controller={c} options={o} onChange={setO} />;
    };
    await act(async () => root.render(<Host />));
    expect(container.querySelector('[data-testid="type-missing-fonts"]')!.textContent).toMatch(/Nope/);
    await act(async () => button('B').click());
    expect(c.getTextLayer(id).runs[0].style.fontWeight).toBe(700);
    await act(async () => button('Centre').click());
    expect(c.getTextLayer(id).paragraphs[0].style).toEqual({ align: 'center' });
    await act(async () => setValue(container.querySelector('input[aria-label="Font size"]')!, '30'));
    expect(c.getTextLayer(id).runs[0].style.fontSize).toBe(30);
  });

  it('TypeOptionsBar turns the active type layer vertical and sets Latin upright', async () => {
    const c = controller();
    const id = c.addTextLayer({ text: 'AB', x: 40, y: 10, style: { fontFamily: 'Box', fontSize: 20 } });
    let options: TypeToolOptions = DEFAULT_TYPE_TOOL_OPTIONS;
    const Host = () => {
      const [o, setO] = React.useState(options);
      options = o;
      return <TypeOptionsBar controller={c} options={o} onChange={setO} />;
    };
    await act(async () => root.render(<Host />));
    expect(button('Horizontal').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('Vertical').click());
    expect(c.getTextLayer(id).orientation).toBe('vertical');
    expect(options.orientation).toBe('vertical');
    expect(button('Vertical').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('Upright Latin').click());
    expect(c.getTextLayer(id).runs[0].style.upright).toBe(true);
    await act(async () => button('Horizontal').click());
    expect(c.getTextLayer(id).orientation).toBe('horizontal');
  });

  it('LayersPanel shows shape and type thumbnails with a kind badge, and warns about missing fonts', async () => {
    const c = controller();
    c.addShapeLayer({ shape: { kind: 'rect', x: 10, y: 10, width: 40, height: 40 } });
    c.addTextLayer({ text: 'Hi', x: 10, y: 80, style: { fontFamily: 'Nope' } });
    await act(async () => root.render(<LayersPanel controller={c} />));
    const badges = Array.from(container.querySelectorAll('[data-testid="layer-kind-badge"]')).map((b) => b.textContent);
    expect(badges).toEqual(['T', 'shp']);
    expect(container.querySelector('[data-testid="layer-warning"]')!.getAttribute('aria-label')).toMatch(/Missing font: Nope/);
  });
});

describe('React shape and type tools on the canvas', () => {
  it('draws a shape by dragging and types text by clicking', async () => {
    let c!: ImageEditorController;
    function Host() {
      const editor = useImageEditor({ textShaper: createOutlineTextShaper([boxFont()]) });
      c = editor.controller;
      return <ImageEditor editor={editor} />;
    }
    await act(async () => root.render(<Host />));
    const { width, height } = c.getState().imageDimensions;
    c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
    await act(async () => button('Annotations').click());
    await act(async () => button('Shape').click());
    expect(c.getState().activeTool).toBe('shape');
    expect(container.querySelector('[data-testid="shape-options"]')).not.toBeNull();
    const canvas = container.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    const n = c.getLayers().length;
    await act(async () => {
      canvas.dispatchEvent(mouse('mousedown', 100, 60));
      canvas.dispatchEvent(mouse('mousemove', 160, 90));
      canvas.dispatchEvent(mouse('mouseup', 160, 90));
    });
    expect(c.getLayers()).toHaveLength(n + 1);
    expect(c.getLayers().at(-1)!.type).toBe('shape');

    await act(async () => button('Type').click());
    expect(container.querySelector('[data-testid="type-options"]')).not.toBeNull();
    await act(async () => {
      canvas.dispatchEvent(mouse('mousedown', 50, 50));
      canvas.dispatchEvent(mouse('mouseup', 50, 50));
    });
    const input = container.querySelector('[data-testid="type-input"]') as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    await act(async () => {
      for (const key of 'Hey') input.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));
    });
    const typed = c.getLayers().at(-1) as TypeLayer;
    expect(typed.type).toBe('type');
    expect(typed.text).toBe('Hey');
    await act(async () => input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[data-testid="type-input"]')).toBeNull();
    expect(c.getLayers().at(-1)!.name).toBe('Hey');
  });
});

describe('React path tools on the canvas', () => {
  it('draws a Work Path with the Pen and drags its anchor with Direct Selection', async () => {
    let c!: ImageEditorController;
    function Host() {
      const editor = useImageEditor({});
      c = editor.controller;
      return <ImageEditor editor={editor} />;
    }
    await act(async () => root.render(<Host />));
    const { width, height } = c.getState().imageDimensions;
    c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
    await act(async () => button('Annotations').click());
    await act(async () => button('Pen').click());
    expect(c.getState().activeTool).toBe('path-pen');
    const canvas = container.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    await act(async () => {
      for (const [x, y] of [[40, 40], [120, 40], [120, 100]]) {
        canvas.dispatchEvent(mouse('mousedown', x, y));
        canvas.dispatchEvent(mouse('mouseup', x, y));
      }
      window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const path = c.getPaths()[0];
    expect(path).toMatchObject({ name: 'Work Path', work: true });
    const sp = path.components[0].subpaths[0];
    expect(sp).toMatchObject({ closed: false });
    expect(sp.anchors).toHaveLength(3);

    await act(async () => button('Direct Selection').click());
    expect(c.getState().activeTool).toBe('direct-select');
    const before = c.getPath(path.id)!.components[0].subpaths[0].anchors[1];
    await act(async () => {
      canvas.dispatchEvent(mouse('mousedown', 120, 40));
      canvas.dispatchEvent(mouse('mousemove', 130, 50));
      canvas.dispatchEvent(mouse('mouseup', 130, 50));
    });
    const after = c.getPath(path.id)!.components[0].subpaths[0].anchors[1];
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
    await act(async () => window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
    expect(c.getPath(path.id)!.components[0].subpaths[0].anchors).toHaveLength(2);
  });
});
