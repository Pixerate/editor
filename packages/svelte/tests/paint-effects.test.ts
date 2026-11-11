import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { createFakeEffectProvider } from '@pixerate/editor/effects';
import { PaintEditorController, type PaintPixelLayer } from '@pixerate/editor/paint-editor';
import { readPixel } from '@pixerate/editor/raster';
import { ColorPanel, PaintEditor, PaintEffectsPanel } from '../src/paint-editor';
import { stubBrushThumbnails } from './paint-thumbnails';

let target: HTMLDivElement;
let component: Record<string, any> | null = null;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as any;
  stubBrushThumbnails();
  target = document.createElement('div');
  document.body.appendChild(target);
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  target.remove();
  vi.restoreAllMocks();
});

const show = (C: any, props: Record<string, unknown>) => {
  component = mount(C, { target, props });
  flushSync();
};
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};
const button = (text: string) => Array.from(target.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = async (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
  await settle();
};
const pickEffect = (id: string) => click(target.querySelector(`[data-effect-id="${id}"]`));

describe('Svelte paint effects', () => {
  it('sets the effect paper, adds an effect layer and bakes light onto paint', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    c.setEffectsProvider(createFakeEffectProvider());
    const base = c.getActiveLayer()!.id;
    show(PaintEffectsPanel, { controller: c });

    await click(button('Paper…'));
    await pickEffect('fake.gradient');
    expect(c.getPaperEffect()).toMatchObject({ effect: 'fake.gradient', blend: 'multiply' });
    expect(target.querySelector('[data-effect-part="paper"]')!.textContent).toContain('Gradient');

    await click(button('Layer…'));
    await pickEffect('fake.bar');
    const fx = c.getActiveLayer()!.id;
    expect(c.getEffectLayer(fx)).toMatchObject({ effect: 'fake.bar' });
    expect(target.querySelector('[data-effect-part="layer"]')).not.toBeNull();
    await click(button('Rasterize'));
    expect(c.getEffectLayer(fx)).toBeUndefined();

    c.setActiveLayer(base);
    c.fillLayer({ color: '#0a141e' });
    flushSync();
    await click(button('Light…'));
    await pickEffect('fake.invert');
    expect(readPixel((c.getLayer(base) as PaintPixelLayer).surface, 0, 0)).toEqual([245, 235, 225, 255]);

    await click(target.querySelector('[aria-label="Remove the effect paper"]'));
    expect(c.getPaperEffect()).toBeNull();
  });

  it('with provider paint hints, Paint… lists only hinted effects and picks from the hint; Layer… lists every effect', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    c.setEffectsProvider(createFakeEffectProvider({ paintHints: true }));
    c.setColor('#ff0000');
    c.setSecondaryColor('#0000ff');
    show(PaintEffectsPanel, { controller: c });
    const listed = () => Array.from(target.querySelectorAll('[data-effect-id]')).map((b) => b.getAttribute('data-effect-id'));
    await click(button('Layer…'));
    expect(listed()).toContain('fake.bar');
    await click(button('Paint…'));
    expect(listed()).toEqual(['fake.gradient', 'fake.trail']);
    await pickEffect('fake.gradient');
    expect(c.getEffectPaint()).toMatchObject({ map: { by: 'stroke', repeat: 'mirror' }, live: true, values: { from: '#ff0000', to: '#0000ff' } });
  });

  it('shows why nothing can be added without a provider, and errors from the controller', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    show(PaintEffectsPanel, { controller: c });
    expect(target.textContent).toContain('No effects provider');
    expect(button('Paper…').disabled).toBe(true);
    c.setEffectsProvider(createFakeEffectProvider());
    flushSync();
    expect(button('Paper…').disabled).toBe(false);
    await click(button('Light…'));
    await pickEffect('fake.invert');
    expect(target.querySelector('[role="alert"]')!.textContent).toMatch(/no paint/);
  });

  it('PaintEditor shows an Effects tab only with a provider', () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    show(PaintEditor, { controller: c });
    const tabs = () => Array.from(target.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabs()).not.toContain('Effects');
    c.setEffectsProvider(createFakeEffectProvider());
    flushSync();
    expect(tabs()).toContain('Effects');
  });

  it('paints with an effect: the Paint placement, its controls, and the thumbnail in the paint well', async () => {
    const c = new PaintEditorController({ width: 16, height: 8 });
    c.setEffectsProvider(createFakeEffectProvider());
    show(PaintEffectsPanel, { controller: c });
    const colors = document.createElement('div');
    document.body.appendChild(colors);
    const colorPanel = mount(ColorPanel, { target: colors, props: { controller: c } });
    flushSync();
    try {
      await click(button('Paint…'));
      await pickEffect('fake.gradient');
      await settle();
      expect(c.getEffectPaint()).toMatchObject({ type: 'effect', effect: 'fake.gradient' });
      const part = target.querySelector('[data-effect-part="paint"]')!;
      expect(part.textContent).toContain('fake.gradient');
      expect(part.querySelector<HTMLImageElement>('[data-testid="effect-paint-thumbnail"]')!.src).toMatch(/^data:image\/png/);
      const well = colors.querySelector<HTMLElement>('[data-testid="paint-well"]')!;
      expect(well.getAttribute('data-effect-paint')).toBe('fake.gradient');
      expect(well.getAttribute('aria-label')).toBe('Effect paint: fake.gradient');
      expect(well.style.background).toContain('data:image/png');

      c.paintStroke({ brushId: 'ink-pen', points: [{ x: 2, y: 4 }, { x: 14, y: 4 }] });
      expect(c.getStrokes().at(-1)!.paint).toMatchObject({ type: 'effect' });

      await click(target.querySelector('[aria-label="Stop painting with the effect"]'));
      expect(c.getEffectPaint()).toBeNull();
      expect(target.querySelector('[data-effect-part="paint"]')).toBeNull();
      expect(colors.querySelector('[data-testid="paint-well"]')!.getAttribute('data-effect-paint')).toBeNull();
    } finally {
      unmount(colorPanel);
      colors.remove();
    }
  });

  it('lays the effect along the stroke, makes it live, and plays or pauses live paint', async () => {
    const c = new PaintEditorController({ width: 32, height: 16 });
    c.setEffectsProvider(createFakeEffectProvider());
    c.addLayer({ type: 'strokes' });
    show(PaintEffectsPanel, { controller: c });
    await click(button('Paint…'));
    await pickEffect('fake.gradient');
    await settle();
    const boxes = () => target.querySelectorAll<HTMLInputElement>('[data-testid="effect-paint-placement"] input[type="checkbox"]');
    await click(boxes()[0]);
    await settle();
    expect(c.getEffectPaint()?.map).toEqual({ by: 'stroke', length: 300, repeat: 'repeat' });
    const repeat = target.querySelector<HTMLSelectElement>('select[aria-label="Effect repeat"]')!;
    repeat.value = 'mirror';
    repeat.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(c.getEffectPaint()?.map?.repeat).toBe('mirror');
    await click(boxes()[1]);
    await settle();
    expect(c.getEffectPaint()).toMatchObject({ live: true, map: { repeat: 'mirror' } });
    expect(target.querySelector('[data-effect-part="playback"]')).toBeNull();
    c.paintStroke({ brushId: 'ink-pen', points: [{ x: 2, y: 8 }, { x: 30, y: 8 }] });
    flushSync();
    expect(target.querySelector('[data-effect-part="playback"]')!.textContent).toContain('1 stroke');
    await click(button('Pause'));
    expect(c.getState().effectPlayback.playing).toBe(false);
    await click(button('Play'));
    expect(c.getState().effectPlayback.playing).toBe(true);
  });

  it('offers "Along the stroke (native)" only for path effects and sets map: { by: "path" }', async () => {
    const c = new PaintEditorController({ width: 32, height: 16 });
    c.setEffectsProvider(createFakeEffectProvider());
    show(PaintEffectsPanel, { controller: c });
    await click(button('Paint…'));
    await pickEffect('fake.gradient');
    await settle();
    const placement = () => target.querySelector('[data-testid="effect-paint-placement"]')!;
    expect(placement().textContent).not.toContain('Along the stroke (native)');

    await click(button('Paint…'));
    await pickEffect('fake.trail');
    await settle();
    expect(placement().textContent).toContain('Along the stroke (native)');
    const nativeInput = Array.from(placement().querySelectorAll('label')).find((l) => l.textContent?.includes('Along the stroke (native)'))!.querySelector('input')!;
    expect(nativeInput.checked).toBe(false);
    await click(nativeInput);
    await settle();
    expect(c.getEffectPaint()?.map).toEqual({ by: 'path' });
    expect(nativeInput.checked).toBe(true);
    expect(target.querySelector('select[aria-label="Effect repeat"]')).toBeNull();
  });
});
