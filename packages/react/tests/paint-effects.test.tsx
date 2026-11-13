// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createFakeEffectProvider, PixelWebGL, type EffectRenderer } from '@pixerate/editor/effects';
import { PaintEditorController, type PaintPixelLayer } from '@pixerate/editor/paint-editor';
import { readPixel } from '@pixerate/editor/raster';
import { ColorPanel, PaintCanvas, PaintEditor, PaintEffectsPanel, usePaintEditor } from '../src/paint-editor';
import { stubBrushThumbnails } from './paint-thumbnails';

let container: HTMLDivElement;
let root: any;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubBrushThumbnails();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  for (let i = 0; i < 4; i++) await settle();
};
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const pickEffect = (id: string) => click(container.querySelector(`[data-effect-id="${id}"]`)!);


/** A stand-in WebGL2 that draws every live frame pure green (no WebGL in jsdom). */
class GreenGPU extends PixelWebGL {
  override get available() {
    return true;
  }
  override async createRenderer(_p: unknown, d: { id: string }, o: { width: number; height: number }): Promise<EffectRenderer> {
    const draw = () => {
      const data = new Uint8ClampedArray(o.width * o.height * 4);
      for (let i = 0; i < data.length; i += 4) data.set([0, 255, 0, 255], i);
      return { width: o.width, height: o.height, data };
    };
    return { effectId: d.id, width: o.width, height: o.height, depth: 8, render: async () => draw(), renderSync: draw, dispose: () => {} };
  }
}
const HARD = { tip: { size: 8, hardness: 1, opacity: 1, flow: 1, spacing: 0.05, pressureOpacity: false, pressureSize: false, smoothing: 0 }, grain: 0 };
/** Saves a pulsing red effect and paints a live stroke with it. */
async function paintLive(c: PaintEditorController) {
  const session = await c.openEffectAuthoring('pixel.blank');
  await session.setSource!('out = vec3(fract(time), 0, 0)');
  const saved = await c.saveAuthoredEffect({ name: 'Pulse' });
  c.closeEffectAuthoring();
  c.addLayer({ type: 'strokes' });
  await c.setEffectPaint({ effect: saved.id, live: true });
  c.paintStroke({ brushId: 'ink-pen', brush: HARD, points: [{ x: 2, y: 8 }, { x: 30, y: 8 }] });
}

describe('paint effects (React)', () => {
  it('plays live frames of authored effects with WebGL2 when there is one (authoredEffectsGPU)', async () => {
    let c!: PaintEditorController;
    function Host() {
      c = usePaintEditor({ width: 32, height: 16, paper: 'smooth', authoredEffects: 'author', authoredEffectsGPU: new GreenGPU() }).controller;
      return <PaintCanvas controller={c} fitOnMount={false} />;
    }
    act(() => root.render(<Host />));
    await act(() => paintLive(c));
    for (let i = 0; i < 50 && c.authoredEffectsGPUStatus.renderer !== 'webgl2'; i++) await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(c.authoredEffectsGPUStatus).toEqual({ gpu: true, renderer: 'webgl2', reason: null });
    // The view shows the GPU's frame; an export at the same moment renders on the CPU.
    const at = (8 * 32 + 16) * 4;
    expect(c.compositePixels().data[at + 1]).toBe(255);
    expect((await c.renderAnimationFrame(c.getState().effectPlayback.time)).data[at + 1]).toBeLessThan(50);
    // Off: the CPU draws live frames too.
    const off = new PaintEditorController({ authoredEffectsGPU: false });
    expect(off.authoredEffectsGPU).toBe(false);
  });

  it('sets the effect paper, adds an effect layer and bakes light onto paint', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    c.setEffectsProvider(createFakeEffectProvider());
    const base = c.getActiveLayer()!.id;
    act(() => root.render(<PaintEffectsPanel controller={c} />));
    expect(button('Light…').disabled).toBe(false);

    await click(button('Paper…'));
    await pickEffect('fake.gradient');
    expect(c.getPaperEffect()).toMatchObject({ effect: 'fake.gradient', blend: 'multiply' });
    expect(container.querySelector('[data-effect-part="paper"]')!.textContent).toContain('Gradient');

    await click(button('Layer…'));
    await pickEffect('fake.bar');
    const fx = c.getActiveLayer()!.id;
    expect(c.getEffectLayer(fx)).toMatchObject({ effect: 'fake.bar' });
    expect(container.querySelector('[data-effect-part="layer"]')).not.toBeNull();
    await click(button('Rasterize'));
    expect(c.getEffectLayer(fx)).toBeUndefined();

    c.setActiveLayer(base);
    c.fillLayer({ color: '#0a141e' });
    await settle();
    await click(button('Light…'));
    await pickEffect('fake.invert');
    expect(readPixel((c.getLayer(base) as PaintPixelLayer).surface, 0, 0)).toEqual([245, 235, 225, 255]);

    await click(container.querySelector('[aria-label="Remove the effect paper"]')!);
    expect(c.getPaperEffect()).toBeNull();
  });

  it('with provider paint hints, Paint… lists only hinted effects and picks from the hint; Layer… lists every effect', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    c.setEffectsProvider(createFakeEffectProvider({ paintHints: true }));
    c.setColor('#ff0000');
    c.setSecondaryColor('#0000ff');
    act(() => root.render(<PaintEffectsPanel controller={c} />));
    const listed = () => [...container.querySelectorAll('[data-effect-id]')].map((b) => b.getAttribute('data-effect-id'));
    await click(button('Layer…'));
    expect(listed()).toContain('fake.bar');
    await click(button('Paint…'));
    expect(listed()).toEqual(['fake.gradient', 'fake.trail']);
    await pickEffect('fake.gradient');
    expect(c.getEffectPaint()).toMatchObject({ map: { by: 'stroke', repeat: 'mirror' }, live: true, values: { from: '#ff0000', to: '#0000ff' } });
    // Unticking "Along the stroke" fixes it to the canvas and keeps it there through a later change.
    await click(container.querySelector('[data-testid="effect-paint-placement"] input[type="checkbox"]')!);
    expect(c.getEffectPaint()!.map).toBeUndefined();
  });

  it('shows why nothing can be added without a provider, and errors from the controller', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    act(() => root.render(<PaintEffectsPanel controller={c} />));
    expect(container.textContent).toContain('No effects provider');
    expect(button('Paper…').disabled).toBe(true);
    act(() => c.setEffectsProvider(createFakeEffectProvider()));
    expect(button('Paper…').disabled).toBe(false);
    await click(button('Light…'));
    await pickEffect('fake.invert');
    expect(container.querySelector('[role="alert"]')?.textContent ?? container.textContent).toMatch(/no paint/);
  });

  it('PaintEditor shows an Effects tab only with a provider', () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    act(() => root.render(<PaintEditor controller={c} />));
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain('Effects');
    act(() => c.setEffectsProvider(createFakeEffectProvider()));
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toContain('Effects');
  });

  it('paints with an effect: the Paint placement, its controls, and the thumbnail in the paint well', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    c.setEffectsProvider(createFakeEffectProvider());
    act(() =>
      root.render(
        <>
          <PaintEffectsPanel controller={c} />
          <ColorPanel controller={c} />
        </>
      )
    );
    await click(button('Paint…'));
    await pickEffect('fake.gradient');
    for (let i = 0; i < 4; i++) await settle();
    expect(c.getEffectPaint()).toMatchObject({ type: 'effect', effect: 'fake.gradient' });
    const part = container.querySelector('[data-effect-part="paint"]')!;
    expect(part.textContent).toContain('fake.gradient');
    expect(part.querySelector<HTMLImageElement>('[data-testid="effect-paint-thumbnail"]')!.src).toMatch(/^data:image\/png/);
    const well = container.querySelector<HTMLElement>('[data-testid="paint-well"]')!;
    expect(well.getAttribute('data-effect-paint')).toBe('fake.gradient');
    expect(well.getAttribute('aria-label')).toBe('Effect paint: fake.gradient');
    expect(well.style.background).toContain('data:image/png');

    c.paintStroke({ brushId: 'ink-pen', points: [{ x: 2, y: 4 }, { x: 14, y: 4 }] });
    expect(c.getStrokes().at(-1)!.paint).toMatchObject({ type: 'effect' });

    await click(container.querySelector('[aria-label="Stop painting with the effect"]')!);
    expect(c.getEffectPaint()).toBeNull();
    expect(container.querySelector('[data-effect-part="paint"]')).toBeNull();
    expect(container.querySelector('[data-testid="paint-well"]')!.getAttribute('data-effect-paint')).toBeNull();
  });

  it('lays the effect along the stroke, makes it live, and plays or pauses live paint', async () => {
    const c = new PaintEditorController({ width: 32, height: 16 });
    c.setEffectsProvider(createFakeEffectProvider());
    c.addLayer({ type: 'strokes' });
    act(() => root.render(<PaintEffectsPanel controller={c} />));
    await click(button('Paint…'));
    await pickEffect('fake.gradient');
    for (let i = 0; i < 4; i++) await settle();
    const along = () => container.querySelector<HTMLInputElement>('[data-testid="effect-paint-placement"] input[type="checkbox"]')!;
    await click(along());
    for (let i = 0; i < 4; i++) await settle();
    expect(c.getEffectPaint()?.map).toEqual({ by: 'stroke', length: 300, repeat: 'repeat' });
    const repeat = container.querySelector<HTMLSelectElement>('select[aria-label="Effect repeat"]')!;
    await act(async () => {
      repeat.value = 'mirror';
      repeat.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let i = 0; i < 4; i++) await settle();
    expect(c.getEffectPaint()?.map?.repeat).toBe('mirror');
    const live = container.querySelectorAll<HTMLInputElement>('[data-testid="effect-paint-placement"] input[type="checkbox"]')[1];
    await click(live);
    for (let i = 0; i < 4; i++) await settle();
    expect(c.getEffectPaint()).toMatchObject({ live: true, map: { repeat: 'mirror' } });
    expect(container.querySelector('[data-effect-part="playback"]')).toBeNull();
    act(() => void c.paintStroke({ brushId: 'ink-pen', points: [{ x: 2, y: 8 }, { x: 30, y: 8 }] }));
    const playback = container.querySelector('[data-effect-part="playback"]')!;
    expect(playback.textContent).toContain('1 stroke');
    await click(button('Pause'));
    expect(c.getState().effectPlayback.playing).toBe(false);
    await click(button('Play'));
    expect(c.getState().effectPlayback.playing).toBe(true);
  });

  it('offers "Along the stroke (native)" only for path effects and sets map: { by: "path" }', async () => {
    const c = new PaintEditorController({ width: 32, height: 16 });
    c.setEffectsProvider(createFakeEffectProvider());
    act(() => root.render(<PaintEffectsPanel controller={c} />));
    await click(button('Paint…'));
    await pickEffect('fake.gradient');
    for (let i = 0; i < 4; i++) await settle();
    const placement = () => container.querySelector('[data-testid="effect-paint-placement"]')!;
    expect(placement().textContent).not.toContain('Along the stroke (native)');

    await click(button('Paint…'));
    await pickEffect('fake.trail');
    for (let i = 0; i < 4; i++) await settle();
    expect(placement().textContent).toContain('Along the stroke (native)');
    const nativeInput = [...placement().querySelectorAll('label')].find((l) => l.textContent?.includes('Along the stroke (native)'))!.querySelector('input')!;
    expect(nativeInput.checked).toBe(false);
    await click(nativeInput);
    for (let i = 0; i < 4; i++) await settle();
    expect(c.getEffectPaint()?.map).toEqual({ by: 'path' });
    expect(nativeInput.checked).toBe(true);
    expect(container.querySelector('select[aria-label="Effect repeat"]')).toBeNull();
  });
});
