import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { DEFAULT_SELECTION_TOOL_OPTIONS, ImageEditorController, type SelectionToolOptions } from '@pixerate/editor/image-editor';
import { SelectionOptionsBar } from '../src/image-editor';
import ControlsProbe from './fixtures/ControlsProbe.svelte';
import HostCheckbox from './fixtures/HostCheckbox.svelte';
import HostRange from './fixtures/HostRange.svelte';
import HostSelect from './fixtures/HostSelect.svelte';

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
