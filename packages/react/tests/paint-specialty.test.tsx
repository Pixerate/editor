// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PaintEditorController } from '@pixerate/editor/paint-editor';
import { BRUSH_PRESETS } from '@pixerate/editor/brushes';
import { BrushEditor, BrushLibraryBrowser, BrushPanel, PaintEditor, PaperPanel, SpecialtyPanel } from '../src/paint-editor';
import { stubBrushThumbnails } from './paint-thumbnails';

let container: HTMLDivElement;
let root: any;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLCanvasElement.prototype.getContext = (() => null) as any;
});

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  container = document.getElementById('root') as HTMLDivElement;
  root = createRoot(container);
  stubBrushThumbnails();
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const byText = (text: string, scope: ParentNode = container) => Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const click = (el: Element) => act(() => (el as HTMLElement).click());

describe('React specialty paint', () => {
  it('shows a guide card for a specialty brush with one-click setup', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    render(<BrushPanel controller={c} />);
    expect(container.querySelector('[data-testid="brush-specialty-guide"]')).toBeNull();
    act(() => void c.setBrush({ id: 'uv-marker' }));
    const card = container.querySelector('[data-testid="brush-specialty-guide"]')!;
    expect(card.textContent).toContain('UV-fluorescent ink');
    expect(card.querySelector('[role="status"]')!.textContent).toContain('UV blacklight is off');
    click(byText('Turn on UV blacklight', card));
    expect(c.getState().uvLight.on).toBe(true);
    expect(container.querySelector('[data-testid="brush-specialty-guide"] [role="status"]')!.textContent).toContain('UV blacklight is on');
    act(() => void c.setBrush({ id: 'ferrofluid' }));
    click(byText('Add magnet', container.querySelector('[data-testid="brush-specialty-guide"]')!));
    expect(c.listMagnets()).toHaveLength(1);
  });

  it('files specialty brushes in their own group, and the editor gates their controls', () => {
    const entries = BRUSH_PRESETS.map((brush) => ({ brush, builtin: true }));
    render(<BrushLibraryBrowser entries={entries} onSelect={() => {}} />);
    const group = container.querySelector('[data-group="specialty"]')!;
    expect(group.getAttribute('aria-label')).toBe('Specialty');
    expect(group.textContent).toContain('Ferrofluid');
    expect(container.querySelector('[data-group="paint"]')!.textContent).not.toContain('Scarab lacquer');
    const onChange = vi.fn();
    render(<BrushEditor brush={BRUSH_PRESETS.find((b) => b.id === 'turing-wash')!} onChange={onChange} />);
    const section = container.querySelector('[data-section="specialty"]')!;
    expect(section).not.toBeNull();
    expect(section.querySelector('[data-hint="livePatterns.pattern"]')!.textContent).toMatch(/patterns grow/);
    expect(container.querySelector('[data-section="behaviour"] select[aria-label="Live pattern"]')).toBeNull();
    click(section.querySelector('input[aria-label="Brush ferrofluid"]')!);
    expect(onChange.mock.calls.at(-1)![0].ferro).toEqual({ amount: 0.8 });
  });

  it('moves the UV, heat, magnet and view tilt controls into the Specialty panel', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    render(<PaperPanel controller={c} />);
    expect(container.querySelector('[data-testid="uv-heat-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="ferro-panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="light-panel"]')).not.toBeNull();
    render(<SpecialtyPanel controller={c} />);
    expect(container.querySelector('[data-testid="specialty-picks"]')).not.toBeNull();
    for (const id of ['uv-heat-panel', 'ferro-panel', 'view-tilt-panel']) expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    click(byText('Warm canvas'));
    expect(c.getState().heat.max).toBeGreaterThan(0);
    click(byText('Cool canvas'));
    expect(c.getState().heat.max).toBe(0);
    click(byText('Thermochromic ink'));
    expect(c.getState().brush.id).toBe('thermo-ink');
    expect(container.querySelector('[data-testid="brush-specialty-guide"]')).not.toBeNull();
  });

  it('adds a Specialty tab that lights up while specialty paint is in play', () => {
    const c = new PaintEditorController({ width: 120, height: 80 });
    render(<PaintEditor controller={c} />);
    const tab = container.querySelector('[data-paint-tab="specialty"]')!;
    expect(Array.from(container.querySelectorAll('[data-paint-tab]')).map((t) => t.getAttribute('data-paint-tab'))).toEqual(['color', 'wet', 'paper', 'specialty', 'layers']);
    expect(tab.hasAttribute('data-active')).toBe(false);
    act(() => void c.setBrush({ id: 'soap-film' }));
    expect(container.querySelector('[data-paint-tab="specialty"]')!.hasAttribute('data-active')).toBe(true);
    click(byText('Open Specialty panel'));
    expect(container.querySelector('[data-testid="specialty-panel"]')).not.toBeNull();
  });
});
