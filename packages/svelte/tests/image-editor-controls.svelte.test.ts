import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { DEFAULT_SELECTION_TOOL_OPTIONS, ImageEditorController, type SelectionToolOptions } from '@pixerate/editor/image-editor';
import { SelectionOptionsBar } from '../src/image-editor';
import ControlsProbe from './fixtures/ControlsProbe.svelte';
import HostCheckbox from './fixtures/HostCheckbox.svelte';
import HostRange from './fixtures/HostRange.svelte';
import HostSelect from './fixtures/HostSelect.svelte';
import HostColor from './fixtures/HostColor.svelte';
import BrushControlsProbe from './fixtures/BrushControlsProbe.svelte';
import { BrushOptionsBar } from '../src/image-editor';

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

const magicWand: SelectionToolOptions = { ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'wand' } as SelectionToolOptions;

describe('image editor panel controls', () => {
  it('uses plain inputs when the host sets no controls', () => {
    const controller = new ImageEditorController();
    component = mount(SelectionOptionsBar, { target, props: { controller, options: magicWand, onOptionsChange: () => {} } });
    flushSync();
    expect(target.querySelector('input[type="range"][aria-label="Tolerance"]')).not.toBeNull();
    expect(target.querySelector('input[type="checkbox"][aria-label="Anti-alias"]')).not.toBeNull();
    expect(target.querySelector('select[aria-label="Sample from"]')).not.toBeNull();
  });

  it("renders the host's controls and passes their changes back", () => {
    const controller = new ImageEditorController();
    const changes: SelectionToolOptions[] = [];
    component = mount(ControlsProbe, {
      target,
      props: {
        controller,
        options: magicWand,
        onOptionsChange: (o: SelectionToolOptions) => changes.push(o),
        controls: { Checkbox: HostCheckbox, Range: HostRange, Select: HostSelect },
      },
    });
    flushSync();
    expect(target.querySelector('input[type="range"], input[type="checkbox"], select')).toBeNull();

    const host = (kind: string, label: string) => target.querySelector(`[data-host="${kind}"][aria-label="${label}"]`) as HTMLButtonElement;
    host('range', 'Tolerance').click();
    host('checkbox', 'Anti-alias').click();
    host('select', 'Sample from').click();
    expect(changes.map((o) => [o.tolerance, o.antiAlias, o.sample])).toEqual([
      [255, magicWand.antiAlias, magicWand.sample],
      [magicWand.tolerance, !magicWand.antiAlias, magicWand.sample],
      [magicWand.tolerance, magicWand.antiAlias, 'active-layer'],
    ]);
  });
});

describe('image editor colour controls', () => {
  it('uses native colour wells when the host sets no Color', () => {
    const controller = new ImageEditorController();
    component = mount(BrushOptionsBar, { target, props: { controller } });
    flushSync();
    const fg = target.querySelector('input[type="color"][aria-label="Foreground colour"]') as HTMLInputElement;
    expect(fg).not.toBeNull();
    fg.value = '#00ff00';
    fg.dispatchEvent(new Event('input', { bubbles: true }));
    expect(controller.getState().paint.foreground).toBe('#00ff00');
  });

  it("renders the host's Color and passes its picks back", () => {
    const controller = new ImageEditorController();
    component = mount(BrushControlsProbe, { target, props: { controller, controls: { Color: HostColor } } });
    flushSync();
    expect(target.querySelector('input[type="color"]')).toBeNull();
    const fg = target.querySelector('[data-host="color"][aria-label="Foreground colour"]') as HTMLButtonElement;
    const bg = target.querySelector('[data-host="color"][aria-label="Background colour"]') as HTMLButtonElement;
    expect(fg).not.toBeNull();
    expect(bg).not.toBeNull();
    fg.click();
    flushSync();
    expect(controller.getState().paint.foreground).toBe('#123456');
    expect(fg.dataset.value).toBe('#123456');
  });
});

describe('LayerPanel', () => {
  it('follows changes to the active layer', async () => {
    const { LayerPanel } = await import('../src/image-editor');
    const controller = new ImageEditorController();
    controller.setImageDimensions?.(40, 40);
    const id = controller.addPixelLayer({ name: 'Paint' });
    controller.setActiveLayer(id);
    component = mount(LayerPanel, { target, props: { controller, panelId: 'properties' } });
    flushSync();
    const opacity = () => (target.querySelector('input[type="range"][aria-label="Opacity"]') as HTMLInputElement).value;
    expect(opacity()).toBe('1');
    controller.setLayerProperties(id, { opacity: 0.4, name: 'Renamed' });
    flushSync();
    expect(opacity()).toBe('0.4');
    expect(target.textContent).toContain('40%');
    // The slider works in the control's 0-1 range.
    const input = target.querySelector('input[type="range"][aria-label="Opacity"]') as HTMLInputElement;
    input.value = '0.25';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(controller.getLayer(id)?.opacity).toBe(0.25);
    expect(target.textContent).toContain('Renamed');
  });
});
