// @vitest-environment jsdom
// The DOM must exist before react-dom loads, or range inputs never fire onChange.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PaintEditorController, documentToScreen } from '@pixerate/editor/paint-editor';
import { BrushPanel, ColorPanel, PaintCanvas, PaintEditor, PaintLayersPanel, PaperPanel, PaintToolbar, usePaintDirector, usePaintEditor } from '../src/paint-editor';

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

const render = (el: React.ReactElement) => act(() => root.render(el));
const byText = (text: string) => Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element) => act(() => (el as HTMLElement).click());
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, commit = false) {
  const proto = el instanceof win.HTMLSelectElement ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new win.Event(el instanceof win.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    if (commit) el.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
}
const pointer = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
  const e = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.assign(e, { pointerId: 1, pointerType: 'mouse', pressure: 0.5, ...extra });
  return e;
};

describe('React paint editor', () => {
  it('usePaintEditor creates a controller and re-renders on changes', () => {
    let seen: ReturnType<typeof usePaintEditor> | null = null;
    const Probe = () => {
      seen = usePaintEditor({ width: 32, height: 16 });
      return <span>{seen.state.color}</span>;
    };
    render(<Probe />);
    expect(container.textContent).toBe('#1f2937');
    act(() => seen!.controller.setColor('#ff0000'));
    expect(container.textContent).toBe('#ff0000');
  });

  it('paints with the pointer on the canvas (one undo step) and reports refusals', () => {
    const c = new PaintEditorController({ width: 800, height: 600, paper: 'smooth' });
    let error: string | null = null;
    render(<PaintCanvas controller={c} fitOnMount={false} onError={(e) => (error = e)} />);
    const el = container.querySelector('[data-testid="paint-canvas"]')!;
    act(() => {
      el.dispatchEvent(pointer('pointerdown', 100, 100));
      el.dispatchEvent(pointer('pointermove', 150, 120));
      el.dispatchEvent(pointer('pointerup', 150, 120));
    });
    expect(c.getStrokes()).toHaveLength(1);
    expect(c.getStrokes()[0].points.map((p) => [p.x, p.y])).toEqual([[100, 100], [150, 120]]);
    expect(c.historyLabels().undo).toHaveLength(1);
    act(() => c.updateLayer(c.document.activeLayerId!, { locks: { pixels: true } }));
    act(() => el.dispatchEvent(pointer('pointerdown', 10, 10)));
    expect(error).toMatch(/locked/);
    expect(container.querySelector('[data-testid="paint-view-status"]')?.textContent).toBe('100% · 0°');
  });

  it('the toolbar drives tools, history, view and guides', () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    let tool = 'brush';
    const Host = () => {
      const [t, setT] = React.useState<any>('brush');
      tool = t;
      return <PaintToolbar controller={c} tool={t} onToolChange={setT} />;
    };
    render(<Host />);
    click(byText('Eyedropper'));
    expect(tool).toBe('eyedropper');
    act(() => void c.paintStroke({ points: [{ x: 5, y: 5 }] }));
    click(byText('Undo'));
    expect(c.getStrokes()).toHaveLength(0);
    click(byText('Mirror view'));
    expect(c.getState().view.mirror).toBe(true);
    click(container.querySelector('[aria-label="Rotate view right"]')!);
    expect(c.getState().view.rotation).toBe(15);
    setValue(container.querySelector('select[aria-label="Symmetry"]')!, 'kaleidoscope');
    expect(c.getState().guides.symmetry.mode).toBe('kaleidoscope');
    setValue(container.querySelector('input[aria-label="Kaleidoscope segments"]')!, '8');
    expect(c.getState().guides.symmetry.segments).toBe(8);
    click(byText('Perspective'));
    expect(c.getState().guides.perspective).toMatchObject({ enabled: true, points: [{ x: 32, y: 25.6 }] });
    setValue(container.querySelector('select[aria-label="Vanishing points"]')!, '2');
    expect(c.getState().guides.perspective.points).toHaveLength(2);
    click(byText('Right-handed'));
    expect(c.getState().hand).toBe('left');
  });

  it('the brush panel picks brushes and edits settings', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    render(<BrushPanel controller={c} />);
    const charcoal = Array.from(container.querySelectorAll('[role="option"]')).find((o) => o.getAttribute('title')?.startsWith('Charcoal stick'))!;
    click(charcoal);
    expect(c.getState().brush.id).toBe('charcoal-stick');
    setValue(container.querySelector('input[aria-label="Size"]')!, '60');
    expect(c.getState().brush.tip.size).toBe(60);
    setValue(container.querySelector('input[aria-label="Grain"]')!, '0.3');
    expect(c.getState().brush.grain).toBe(0.3);
    setValue(container.querySelector('select[aria-label="Brush rotation"]')!, 'barrel');
    expect(c.getState().brush.rotation).toBe('barrel');
    setValue(container.querySelector('input[aria-label="Brush name"]')!, 'My Charcoal');
    click(byText('Save brush'));
    expect(c.getUserBrushes().map((b) => b.id)).toEqual(['my-charcoal']);
  });

  it('the paper panel sets presets and commits sliders on release (one undo step)', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    render(<PaperPanel controller={c} />);
    click(container.querySelector('[role="option"][title="Gesso panel"]')!);
    expect(c.document.paper.preset).toBe('gesso');
    const depth = container.querySelector('input[aria-label="Grain depth"]') as HTMLInputElement;
    setValue(depth, '0.6');
    setValue(depth, '0.8');
    expect(c.document.paper.depth).toBe(0.35);
    setValue(depth, '0.9', true);
    expect(c.document.paper.depth).toBe(0.9);
    expect(c.historyLabels().undo).toEqual(['Paper', 'Paper']);
  });

  it('the colour panel sets colours from harmonies and swatches, and mixes on the pad', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    c.setColor('#ff0000');
    render(<ColorPanel controller={c} />);
    const harmonyChips = container.querySelector('[aria-label="Harmony colours"]')!.querySelectorAll('button[aria-label^="Use"]');
    expect(harmonyChips).toHaveLength(2);
    click(harmonyChips[1]);
    expect(c.getState().color).toBe('#00ff00');
    click(byText('RGB'));
    setValue(container.querySelector('select[aria-label="Harmony"]')!, 'triadic');
    expect(container.querySelector('[aria-label="Harmony colours"]')!.querySelectorAll('button[aria-label^="Use"]')).toHaveLength(3);
    click(container.querySelector('[role="option"][aria-label="Lemon yellow"]')!);
    expect(c.getState().color).toBe('#f3d23a');
    const n = c.getState().swatches.length;
    click(container.querySelector('button[aria-label="Add swatch"]')!);
    expect(c.getState().swatches).toHaveLength(n + 1);
    const pad = container.querySelector('[aria-label="Mixing pad"]')!;
    act(() => {
      pad.dispatchEvent(pointer('pointerdown', 50, 50));
      pad.dispatchEvent(pointer('pointermove', 120, 60));
      pad.dispatchEvent(pointer('pointerup', 120, 60));
    });
    expect(c.getState().mixingPadVersion).toBe(1);
    act(() => void c.setColor('#000000'));
    click(byText('Pick'));
    act(() => pad.dispatchEvent(pointer('pointerdown', 80, 54)));
    // The pad holds the yellow it was painted with.
    expect(c.getState().color).toBe('#f3d23a');
  });

  it('the layers panel adds, renames, reorders and changes layers', () => {
    const c = new PaintEditorController({ width: 32, height: 32 });
    render(<PaintLayersPanel controller={c} />);
    click(byText('New layer'));
    expect(c.listLayers()).toHaveLength(2);
    const name = container.querySelector('[role="treeitem"][aria-selected="true"] span.truncate')!;
    act(() => name.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true })));
    const input = container.querySelector('input[aria-label="Layer name"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Ink');
      input.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
    });
    expect(c.listLayers()[0].name).toBe('Ink');
    click(container.querySelector('button[aria-label="Move layer down"]')!);
    expect(c.listLayers()[1].name).toBe('Ink');
    setValue(container.querySelector('select[aria-label="Layer blend"]')!, 'multiply');
    expect(c.listLayers().find((l) => l.name === 'Ink')?.blend).toBe('multiply');
    const blendSelect = container.querySelector('select[aria-label="Layer blend"]')!;
    expect(Array.from(blendSelect.querySelectorAll('optgroup')).map((g) => g.getAttribute('label'))).toEqual(['Standard', 'Paint']);
    expect(Array.from(blendSelect.querySelectorAll('optgroup[label="Paint"] option')).map((o) => o.getAttribute('value'))).toEqual(['pigment', 'watercolor', 'tint', 'highlight', 'shadow']);
    setValue(blendSelect, 'watercolor');
    expect(c.listLayers().find((l) => l.name === 'Ink')?.blend).toBe('watercolor');
    click(byText('Lock pixels'));
    expect(c.listLayers().find((l) => l.name === 'Ink')?.locks.pixels).toBe(true);
    click(container.querySelector('button[aria-label="Hide Ink"]')!);
    expect(c.listLayers().find((l) => l.name === 'Ink')?.visible).toBe(false);
  });

  it('PaintEditor composes the panels with tabs', () => {
    const c = new PaintEditorController({ width: 64, height: 64 });
    render(<PaintEditor controller={c} />);
    expect(container.querySelector('[data-testid="paint-toolbar"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="brush-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="color-panel"]')).not.toBeNull();
    click(byText('Paper'));
    expect(container.querySelector('[data-testid="paper-panel"]')).not.toBeNull();
    click(byText('Layers'));
    expect(container.querySelector('[data-testid="paint-layers-panel"]')).not.toBeNull();
  });

  it('usePaintDirector paints agent strokes live with a cursor drawn through the view', async () => {
    const controller = new PaintEditorController({ width: 200, height: 100 });
    let made: ReturnType<typeof usePaintDirector> | null = null;
    const Host = () => {
      made = usePaintDirector(controller, { speed: Infinity, linger: 0 });
      return <PaintEditor controller={controller} presence={made.presence} />;
    };
    render(<Host />);
    const { presence, director } = made!;
    act(() => presence.set({ id: 'agent', name: 'Agent', x: 50, y: 25, message: 'Sky first' }));
    const cursor = container.querySelector('[data-paint-presence] [data-actor="agent"]') as HTMLElement;
    expect(cursor.textContent).toBe('Sky first');
    const s = controller.getState();
    const at = documentToScreen(s.view, s.document.canvas, { width: 800, height: 600 }, 50, 25);
    expect(parseFloat(cursor.style.left)).toBeCloseTo(at.x, 3);
    expect(parseFloat(cursor.style.top)).toBeCloseTo(at.y, 3);
    act(() => presence.remove('agent'));
    let results: Awaited<ReturnType<typeof director.perform>> = [];
    await act(async () => {
      results = await director.perform({ id: 'agent' }, [{ kind: 'stroke', stroke: { points: [{ x: 10, y: 10 }, { x: 150, y: 80 }] } }]);
    });
    expect(results[0]).toMatchObject({ ok: true, result: { strokeId: 's1' } });
    expect(controller.getStrokes()).toHaveLength(1);
    // linger 0 keeps the cursor where the stroke ended.
    expect(container.querySelector('[data-paint-presence] [data-actor="agent"]')).not.toBeNull();
  });
});
