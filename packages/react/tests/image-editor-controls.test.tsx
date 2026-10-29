// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ImageEditorControlsProvider,
  SelectionOptionsBar,
  BrushOptionsBar,
  type ImageCheckboxProps,
  type ImageColorProps,
  type ImageRangeProps,
  type ImageSelectProps,
} from '../src/image-editor';
import { DEFAULT_SELECTION_TOOL_OPTIONS, ImageEditorController, type SelectionToolOptions } from '@pixerate/editor/image-editor';

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

const wand = { ...DEFAULT_SELECTION_TOOL_OPTIONS, tool: 'wand' } as SelectionToolOptions;

const HostCheckbox = ({ checked, label, onChange }: ImageCheckboxProps) => (
  <button type="button" data-host="checkbox" aria-label={label} onClick={() => onChange(!checked)} />
);
const HostRange = ({ max, label, onChange }: ImageRangeProps) => (
  <button type="button" data-host="range" aria-label={label} onClick={() => onChange(max)} />
);
const HostSelect = ({ options, label, onChange }: ImageSelectProps) => (
  <button type="button" data-host="select" aria-label={label} onClick={() => onChange(options[options.length - 1]!.value)} />
);

const HostColor = ({ value, label, onChange }: ImageColorProps) => (
  <button type="button" data-host="color" aria-label={label} data-value={value} onClick={() => onChange('#123456')} />
);

describe('image editor panel controls (React)', () => {
  it('uses plain inputs without a provider', () => {
    const controller = new ImageEditorController();
    act(() => root.render(<SelectionOptionsBar controller={controller} options={wand} onOptionsChange={() => {}} />));
    expect(container.querySelector('input[type="range"][aria-label="Tolerance"]')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"][aria-label="Anti-alias"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Sample from"]')).not.toBeNull();
  });

  it("renders the host's controls and passes their changes back", () => {
    const controller = new ImageEditorController();
    const changes: SelectionToolOptions[] = [];
    act(() =>
      root.render(
        <ImageEditorControlsProvider controls={{ Checkbox: HostCheckbox, Range: HostRange, Select: HostSelect }}>
          <SelectionOptionsBar controller={controller} options={wand} onOptionsChange={(o) => changes.push(o)} />
        </ImageEditorControlsProvider>
      )
    );
    expect(container.querySelector('input[type="range"], input[type="checkbox"], select')).toBeNull();
    const host = (kind: string, label: string) => container.querySelector(`[data-host="${kind}"][aria-label="${label}"]`) as HTMLButtonElement;
    act(() => host('range', 'Tolerance').click());
    act(() => host('checkbox', 'Anti-alias').click());
    act(() => host('select', 'Sample from').click());
    expect(changes.map((o) => [o.tolerance, o.antiAlias, o.sample])).toEqual([
      [255, wand.antiAlias, wand.sample],
      [wand.tolerance, !wand.antiAlias, wand.sample],
      [wand.tolerance, wand.antiAlias, 'active-layer'],
    ]);
  });
});

describe('image editor colour controls (React)', () => {
  it('uses native colour wells without a provider', () => {
    const controller = new ImageEditorController();
    act(() => root.render(<BrushOptionsBar controller={controller} />));
    expect(container.querySelector('input[type="color"][aria-label="Foreground colour"]')).not.toBeNull();
    expect(container.querySelector('input[type="color"][aria-label="Background colour"]')).not.toBeNull();
  });

  it("renders the host's Color and passes its picks back", () => {
    const controller = new ImageEditorController();
    act(() =>
      root.render(
        <ImageEditorControlsProvider controls={{ Color: HostColor }}>
          <BrushOptionsBar controller={controller} />
        </ImageEditorControlsProvider>
      )
    );
    expect(container.querySelector('input[type="color"]')).toBeNull();
    const fg = container.querySelector('[data-host="color"][aria-label="Foreground colour"]') as HTMLButtonElement;
    expect(container.querySelector('[data-host="color"][aria-label="Background colour"]')).not.toBeNull();
    act(() => fg.click());
    expect(controller.getState().paint.foreground).toBe('#123456');
  });
});
