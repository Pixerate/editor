import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { PaintEditorController } from '@pixerate/editor/paint-editor';
import { BRUSH_PRESETS } from '@pixerate/editor/brushes';
import { BrushEditor, BrushLibraryBrowser, BrushPanel, PaintEditor, PaperPanel, SpecialtyPanel } from '../src/paint-editor';
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
  if (component) unmount(component);
  component = mount(C, { target, props });
  flushSync();
};
const byText = (text: string, scope: ParentNode = target) => Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element | null) => {
  (el as HTMLElement).click();
  flushSync();
};

describe('Svelte specialty paint', () => {
  it('shows a guide card for a specialty brush with one-click setup', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    show(BrushPanel, { controller: c });
    expect(target.querySelector('[data-testid="brush-specialty-guide"]')).toBeNull();
    c.setBrush({ id: 'uv-marker' });
    flushSync();
    const card = target.querySelector('[data-testid="brush-specialty-guide"]')!;
    expect(card.textContent).toContain('UV-fluorescent ink');
    expect(card.querySelector('[role="status"]')!.textContent).toContain('UV blacklight is off');
    click(byText('Turn on UV blacklight', card));
    expect(c.getState().uvLight.on).toBe(true);
    expect(target.querySelector('[data-testid="brush-specialty-guide"] [role="status"]')!.textContent).toContain('UV blacklight is on');
    c.setBrush({ id: 'ferrofluid' });
    flushSync();
    click(byText('Add magnet', target.querySelector('[data-testid="brush-specialty-guide"]')!));
    expect(c.listMagnets()).toHaveLength(1);
  });

  it('files specialty brushes in their own group, and the editor gates their controls', () => {
    const entries = BRUSH_PRESETS.map((brush) => ({ brush, builtin: true }));
    show(BrushLibraryBrowser, { entries, onselect: () => {} });
    const group = target.querySelector('[data-group="specialty"]')!;
    expect(group.getAttribute('aria-label')).toBe('Specialty');
    expect(group.textContent).toContain('Ferrofluid');
    expect(target.querySelector('[data-group="paint"]')!.textContent).not.toContain('Scarab lacquer');
    const onchange = vi.fn();
    show(BrushEditor, { brush: BRUSH_PRESETS.find((b) => b.id === 'turing-wash')!, onchange });
    const section = target.querySelector('[data-section="specialty"]')!;
    expect(section).not.toBeNull();
    expect(section.querySelector('[data-hint="livePatterns.pattern"]')!.textContent).toMatch(/patterns grow/);
    expect(target.querySelector('[data-section="behaviour"] select[aria-label="Live pattern"]')).toBeNull();
    click(section.querySelector('input[aria-label="Brush ferrofluid"]'));
    expect(onchange.mock.calls.at(-1)![0].ferro).toEqual({ amount: 0.8 });
  });

  it('moves the UV, heat, magnet and view tilt controls into the Specialty panel', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    show(PaperPanel, { controller: c });
    expect(target.querySelector('[data-testid="uv-heat-panel"]')).toBeNull();
    expect(target.querySelector('[data-testid="ferro-panel"]')).toBeNull();
    expect(target.querySelector('[data-testid="light-panel"]')).not.toBeNull();
    show(SpecialtyPanel, { controller: c });
    expect(target.querySelector('[data-testid="specialty-picks"]')).not.toBeNull();
    for (const id of ['uv-heat-panel', 'ferro-panel', 'view-tilt-panel']) expect(target.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    click(byText('Warm canvas'));
    expect(c.getState().heat.max).toBeGreaterThan(0);
    click(byText('Cool canvas'));
    expect(c.getState().heat.max).toBe(0);
    click(byText('Thermochromic ink'));
    expect(c.getState().brush.id).toBe('thermo-ink');
    expect(target.querySelector('[data-testid="brush-specialty-guide"]')).not.toBeNull();
  });

  it('adds a Specialty tab that lights up while specialty paint is in play', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    show(PaintEditor, { controller: c });
    expect(Array.from(target.querySelectorAll('[data-paint-tab]')).map((t) => t.getAttribute('data-paint-tab'))).toEqual(['color', 'wet', 'paper', 'specialty', 'layers']);
    expect(target.querySelector('[data-paint-tab="specialty"]')!.hasAttribute('data-active')).toBe(false);
    c.setBrush({ id: 'soap-film' });
    flushSync();
    expect(target.querySelector('[data-paint-tab="specialty"]')!.hasAttribute('data-active')).toBe(true);
    click(byText('Open Specialty panel'));
    expect(target.querySelector('[data-testid="specialty-panel"]')).not.toBeNull();
  });
});
