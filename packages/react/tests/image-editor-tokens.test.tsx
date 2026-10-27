// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IMAGE_ADJUSTMENT_CONTROLS, ImageEditorController } from '@pixerate/editor/image-editor';
import { AdjustmentLayersPanel, ControlSlider, CurvesEditor, ImageEditor, ImageEffectControls, useImageEditor } from '../src/image-editor';

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
});
afterEach(() => act(() => root.unmount()));

const PALETTE = /\b(?:bg|text|border|ring|accent)-(?:slate|indigo|purple|emerald|rose)-\d/;
const tabs = ['Transform & Crop', 'Adjustments', 'Layers', 'Paint', 'Select & Mask', 'Annotations', 'Depth Mask', 'AI Tools'];

describe('image editor theme tokens (React)', () => {
  it('ImageEditor uses shadcn tokens in every tab, and marks the open tab', async () => {
    function Host() {
      const editor = useImageEditor();
      return <ImageEditor editor={editor} />;
    }
    await act(async () => root.render(<Host />));
    for (const label of tabs) {
      const tab = [...container.querySelectorAll('[data-image-tab]')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
      await act(async () => tab.click());
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(tab.className).toContain('bg-primary');
      expect(container.innerHTML).not.toMatch(PALETTE);
    }
    expect(container.querySelector('[role="tablist"]')).toBeTruthy();
  });

  it('panels take className', async () => {
    const c = new ImageEditorController();
    const spec = IMAGE_ADJUSTMENT_CONTROLS[0]!;
    await act(async () =>
      root.render(
        <>
          <AdjustmentLayersPanel controller={c} className="x-adjust" />
          <ControlSlider spec={spec} value={0} onChange={() => {}} className="x-slider" />
          <CurvesEditor points={[{ x: 0, y: 0 }, { x: 255, y: 255 }]} onChange={() => {}} className="x-curves" />
          <ImageEffectControls provider={null} effect="fake.tint" values={{}} onChange={() => {}} onPreset={() => {}} className="x-effect" />
        </>
      )
    );
    expect(container.querySelector('[data-testid="adjustment-layers-panel"]')!.className).toContain('x-adjust');
    expect(container.querySelector(`[data-control-id="${spec.id}"]`)!.className).toContain('x-slider');
    expect(container.querySelector('[data-testid="curves-editor"]')!.getAttribute('class')).toContain('x-curves');
    expect(container.querySelector('[data-testid="image-effect-controls"]')!.className).toContain('x-effect');
    expect(container.innerHTML).not.toMatch(PALETTE);
  });
});
