import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import {
  DEFAULT_SHAPE_TOOL_OPTIONS,
  DEFAULT_TYPE_TOOL_OPTIONS,
  ImageEditorController,
  createOutlineTextShaper,
  type OutlineFontFace,
  type ShapeToolOptions,
  type TypeLayer,
} from '@pixerate/editor/image-editor';
import { ImageEditor, LayersPanel, ShapeOptionsBar, TypeOptionsBar, createReactiveImageEditor } from '../src/image-editor';

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
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}
const button = (text: string) => Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};
const mouse = (type: string, x: number, y: number) => new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });

function controller() {
  const fake = { width: 300, height: 150, naturalWidth: 300, naturalHeight: 150, src: 'data:fake' } as unknown as HTMLImageElement;
  const c = new ImageEditorController({ image: fake, textShaper: createOutlineTextShaper([boxFont()]) });
  c.setSamplePixels({ width: 300, height: 150, data: new Uint8ClampedArray(300 * 150 * 4).fill(255) });
  return c;
}

describe('Svelte shape and type options bars', () => {
  it('ShapeOptionsBar picks the kind and restyles the active shape', () => {
    const c = controller();
    const id = c.addShapeLayer({ shape: { kind: 'star', x: 10, y: 10, width: 40, height: 40 }, fill: '#000000' });
    let picked: ShapeToolOptions | null = null;
    component = mount(ShapeOptionsBar, { target, props: { controller: c, options: { ...DEFAULT_SHAPE_TOOL_OPTIONS, kind: 'star' }, onchange: (o: ShapeToolOptions) => (picked = o) } });
    flushSync();
    click(button('Ellipse'));
    expect(picked!.kind).toBe('ellipse');
    setValue(target.querySelector('input[aria-label="Points"]')!, '9');
    expect(c.getShapeLayer(id).components[0].live).toMatchObject({ points: 9 });
    setValue(target.querySelector('input[aria-label="Fill colour"]')!, '#ff0000');
    expect(c.getShapeLayer(id).fill).toEqual({ type: 'color', color: '#ff0000' });
  });

  it('TypeOptionsBar styles the active type layer and shows missing fonts', () => {
    const c = controller();
    const id = c.addTextLayer({ text: 'Hello', x: 10, y: 40, style: { fontFamily: 'Nope', fontSize: 20 } });
    component = mount(TypeOptionsBar, { target, props: { controller: c, options: DEFAULT_TYPE_TOOL_OPTIONS, onchange: () => {} } });
    flushSync();
    expect(target.querySelector('[data-testid="type-missing-fonts"]')!.textContent).toMatch(/Nope/);
    click(button('B'));
    expect(c.getTextLayer(id).runs[0].style.fontWeight).toBe(700);
    click(button('Centre'));
    expect(c.getTextLayer(id).paragraphs[0].style).toEqual({ align: 'center' });
    setValue(target.querySelector('input[aria-label="Font size"]')!, '30');
    expect(c.getTextLayer(id).runs[0].style.fontSize).toBe(30);
  });

  it('TypeOptionsBar turns the active type layer vertical and sets Latin upright', () => {
    const c = controller();
    const id = c.addTextLayer({ text: 'AB', x: 40, y: 10, style: { fontFamily: 'Box', fontSize: 20 } });
    let options = DEFAULT_TYPE_TOOL_OPTIONS;
    component = mount(TypeOptionsBar, { target, props: { controller: c, options, onchange: (o: typeof options) => (options = o) } });
    flushSync();
    expect(button('Horizontal').getAttribute('aria-pressed')).toBe('true');
    click(button('Vertical'));
    expect(c.getTextLayer(id).orientation).toBe('vertical');
    expect(options.orientation).toBe('vertical');
    expect(button('Vertical').getAttribute('aria-pressed')).toBe('true');
    click(button('Upright Latin'));
    expect(c.getTextLayer(id).runs[0].style.upright).toBe(true);
    click(button('Horizontal'));
    expect(c.getTextLayer(id).orientation).toBe('horizontal');
  });

  it('LayersPanel shows shape and type thumbnails with a kind badge, and warns about missing fonts', () => {
    const c = controller();
    c.addShapeLayer({ shape: { kind: 'rect', x: 10, y: 10, width: 40, height: 40 } });
    c.addTextLayer({ text: 'Hi', x: 10, y: 80, style: { fontFamily: 'Nope' } });
    component = mount(LayersPanel, { target, props: { controller: c } });
    flushSync();
    const badges = Array.from(target.querySelectorAll('[data-testid="layer-kind-badge"]')).map((b) => b.textContent);
    expect(badges).toEqual(['T', 'shp']);
    expect(target.querySelector('[data-testid="layer-warning"]')!.getAttribute('aria-label')).toMatch(/Missing font: Nope/);
  });
});

describe('Svelte shape and type tools on the canvas', () => {
  it('draws a shape by dragging and types text by clicking', async () => {
    const editor = createReactiveImageEditor({ textShaper: createOutlineTextShaper([boxFont()]) });
    const c = editor.controller;
    const { width, height } = c.getState().imageDimensions;
    c.setSamplePixels({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) });
    component = mount(ImageEditor, { target, props: { editor } });
    flushSync();
    click(button('Annotations'));
    click(button('Shape'));
    expect(c.getState().activeTool).toBe('shape');
    expect(target.querySelector('[data-testid="shape-options"]')).not.toBeNull();
    const canvas = target.querySelector('[data-testid="image-editor-canvas"]') as HTMLCanvasElement;
    const n = c.getLayers().length;
    canvas.dispatchEvent(mouse('mousedown', 100, 60));
    canvas.dispatchEvent(mouse('mousemove', 160, 90));
    canvas.dispatchEvent(mouse('mouseup', 160, 90));
    flushSync();
    expect(c.getLayers()).toHaveLength(n + 1);
    expect(c.getLayers().at(-1)!.type).toBe('shape');

    click(button('Type'));
    expect(target.querySelector('[data-testid="type-options"]')).not.toBeNull();
    canvas.dispatchEvent(mouse('mousedown', 50, 50));
    canvas.dispatchEvent(mouse('mouseup', 50, 50));
    flushSync();
    const input = target.querySelector('[data-testid="type-input"]') as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    for (const key of 'Hey') input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    flushSync();
    const typed = c.getLayers().at(-1) as TypeLayer;
    expect(typed.type).toBe('type');
    expect(typed.text).toBe('Hey');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(target.querySelector('[data-testid="type-input"]')).toBeNull();
    expect(c.getLayers().at(-1)!.name).toBe('Hey');
  });
});
