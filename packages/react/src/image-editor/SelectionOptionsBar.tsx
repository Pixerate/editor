import React, { useState } from 'react';
import type { ImageEditorController, SelectionMask, SelectionModifyOp, SelectionToolOptions } from '@pixerate/editor/image-editor';
import {
  SELECTION_MODES,
  SELECTION_MODE_LABELS,
  SELECTION_TOOLS,
  describeSelection,
} from '@pixerate/editor/image-editor';

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
    on ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-300 hover:text-white'
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
            <span className="flex justify-between text-slate-400">
              <span>Tolerance</span>
              <span className="font-mono">{options.tolerance}</span>
            </span>
            <input
              type="range"
              min={0}
              max={255}
              step={1}
              aria-label="Tolerance"
              value={options.tolerance}
              onChange={(e) => set({ tolerance: Number(e.target.value) })}
              className="w-full accent-indigo-500"
            />
          </label>
          <label className="flex items-center gap-2 text-slate-300">
            <input type="checkbox" checked={options.contiguous} onChange={(e) => set({ contiguous: e.target.checked })} />
            Contiguous
          </label>
          <label className="flex items-center gap-2 text-slate-300">
            <input type="checkbox" checked={options.sampleMerged} onChange={(e) => set({ sampleMerged: e.target.checked })} />
            Sample adjusted image
          </label>
        </div>
      )}
      <label className="flex items-center gap-2 text-slate-300">
        <input type="checkbox" checked={options.antiAlias} onChange={(e) => set({ antiAlias: e.target.checked })} />
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
        <label className="flex items-center gap-1 text-slate-400">
          Radius
          <input
            type="number"
            min={0}
            max={500}
            step={1}
            aria-label="Modify radius"
            value={radius}
            onChange={(e) => setRadius(Math.max(0, Number(e.target.value) || 0))}
            className="w-14 bg-slate-950 border border-slate-800 rounded px-1 py-0.5 text-slate-200"
          />
        </label>
        {MODIFY_OPS.map(({ op, label }) => (
          <button key={op} type="button" className={btn(false)} disabled={!sel} onClick={() => controller.modifySelection(op, radius)}>
            {label}
          </button>
        ))}
      </div>
      <p data-testid="selection-status" className="text-slate-400">
        {describeSelection(sel)}
      </p>
    </div>
  );
};
