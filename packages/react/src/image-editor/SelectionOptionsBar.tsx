import React, { useState } from 'react';
import type { ImageEditorController, SelectionMask, SelectionModifyOp, SelectionToolOptions } from '@pixerate/editor/image-editor';
import {
  SELECTION_MODES,
  SELECTION_MODE_LABELS,
  SELECTION_TOOLS,
  describeSelection,
} from '@pixerate/editor/image-editor';
import { imageRangeClass } from './styles';
import { ImageCheckbox, ImageRange, ImageSelect } from './controls/controls.js';

export interface SelectionOptionsBarProps {
  controller: ImageEditorController;
  options: SelectionToolOptions;
  onOptionsChange: (next: SelectionToolOptions) => void;
  /** The current selection (pass `state.selection` so the bar re-renders with it). */
  selection?: SelectionMask | null;
  /** The current Quick Mask view flag (`state.quickMask`). */
  quickMask?: boolean;
  className?: string;
}

const MODIFY_OPS: { op: SelectionModifyOp; label: string }[] = [
  { op: 'grow', label: 'Grow' },
  { op: 'shrink', label: 'Shrink' },
  { op: 'feather', label: 'Feather' },
  { op: 'border', label: 'Border' },
  { op: 'smooth', label: 'Smooth' },
];

const btn = (on: boolean) =>
  `px-2 py-1 rounded-md border text-[11px] transition-colors ${
    on ? 'bg-primary border-primary text-primary-foreground' : 'bg-background border-border text-foreground hover:bg-accent hover:text-accent-foreground'
  }`;

/**
 * Options bar of the selection tools: tool, mode (new / add / subtract / intersect), magic wand
 * tolerance and contiguous, anti-alias, sample merged, Select › All / Deselect / Inverse,
 * Modify (grow, shrink, feather, border, smooth) and the Quick Mask toggle.
 */
export const SelectionOptionsBar: React.FC<SelectionOptionsBarProps> = ({
  controller,
  options,
  onOptionsChange,
  selection,
  quickMask,
  className = '',
}) => {
  const [radius, setRadius] = useState(2);
  const set = (patch: Partial<SelectionToolOptions>) => onOptionsChange({ ...options, ...patch });
  const sel = selection === undefined ? controller.getSelection() : selection;
  const qm = quickMask ?? Boolean(controller.getState().quickMask);
  return (
    <div data-testid="selection-options-bar" className={`flex flex-col gap-3 text-xs ${className}`}>
      <div role="group" aria-label="Selection tool" className="flex flex-wrap gap-1">
        {SELECTION_TOOLS.map((t) => (
          <button key={t.id} type="button" aria-pressed={options.tool === t.id} className={btn(options.tool === t.id)} onClick={() => set({ tool: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Selection mode" className="flex flex-wrap gap-1">
        {SELECTION_MODES.map((m) => (
          <button key={m} type="button" aria-pressed={options.mode === m} className={btn(options.mode === m)} onClick={() => set({ mode: m })}>
            {SELECTION_MODE_LABELS[m]}
          </button>
        ))}
      </div>
      {options.tool === 'wand' && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-muted-foreground">
              <span>Tolerance</span>
              <span className="font-mono">{options.tolerance}</span>
            </span>
            <ImageRange label="Tolerance" min={0} max={255} step={1} value={options.tolerance} onChange={(v) => set({ tolerance: v })} />
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Contiguous" checked={options.contiguous} onChange={(on) => set({ contiguous: on })} />
            Contiguous
          </label>
          <label className="flex items-center gap-2 text-foreground">
            <ImageCheckbox label="Sample adjusted image" checked={options.sampleMerged} onChange={(on) => set({ sampleMerged: on })} />
            Sample adjusted image
          </label>
          <label className="flex items-center gap-2 text-foreground">
            Sample
            <ImageSelect
              label="Sample from"
              value={options.sample ?? 'composite'}
              options={[
                { value: 'composite', label: 'All layers' },
                { value: 'active-layer', label: 'Active layer' },
              ]}
              onChange={(v) => set({ sample: v as 'composite' | 'active-layer' })}
            />
          </label>
        </div>
      )}
      <label className="flex items-center gap-2 text-foreground">
        <ImageCheckbox label="Anti-alias" checked={options.antiAlias} onChange={(on) => set({ antiAlias: on })} />
        Anti-alias
      </label>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={btn(false)} onClick={() => controller.selectAll()}>
          Select All
        </button>
        <button type="button" className={btn(false)} disabled={!sel} onClick={() => controller.deselect()}>
          Deselect
        </button>
        <button type="button" className={btn(false)} onClick={() => controller.invertSelection()}>
          Inverse
        </button>
        <button type="button" aria-pressed={qm} className={btn(qm)} onClick={() => controller.setQuickMask(!qm)}>
          Quick Mask
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <label className="flex items-center gap-1 text-muted-foreground">
          Radius
          <input
            type="number"
            min={0}
            max={500}
            step={1}
            aria-label="Modify radius"
            value={radius}
            onChange={(e) => setRadius(Math.max(0, Number(e.target.value) || 0))}
            className="w-14 bg-background border border-border rounded px-1 py-0.5 text-foreground"
          />
        </label>
        {MODIFY_OPS.map(({ op, label }) => (
          <button key={op} type="button" className={btn(false)} disabled={!sel} onClick={() => controller.modifySelection(op, radius)}>
            {label}
          </button>
        ))}
      </div>
      <p data-testid="selection-status" className="text-muted-foreground">
        {describeSelection(sel)}
      </p>
    </div>
  );
};
