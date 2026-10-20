import React from 'react';
import {
  VECTOR_HORIZONTAL_RESIZING,
  VECTOR_HORIZONTAL_RESIZING_LABELS,
  VECTOR_VERTICAL_RESIZING,
  VECTOR_VERTICAL_RESIZING_LABELS,
  getVectorFramePanel,
  vectorPaintToHex,
  type VectorEditorController,
  type VectorHorizontalResizing,
  type VectorVerticalResizing
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';

export interface VectorFramePanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Frames (artboards): Frame Selection; for a selected frame its position, size (its children
 * follow their constraints), background and clipping; for objects inside a frame their resizing
 * constraints. Each change is one undo step (sizes apply on Enter or blur).
 */
export function VectorFramePanel({ controller, className }: VectorFramePanelProps) {
  const state = useVectorEditorState(controller);
  const panel = getVectorFramePanel(state);
  const f = panel.frame;
  const ids = f ? [f.id] : undefined;
  const fillHex = f ? vectorPaintToHex(f.frame.fill ?? null) : null;
  const number = (key: 'x' | 'y' | 'width' | 'height', label: string) => (
    <label className="flex items-center gap-1 text-xs text-foreground">
      <span className="w-4 text-muted-foreground">{label}</span>
      {/* Applied on Enter or blur: each resize lays the children out again, so the digits typed on the way must not. */}
      <input
        key={`${f!.id}:${f!.frame[key]}`}
        type="number"
        step="1"
        min={key === 'width' || key === 'height' ? 1 : undefined}
        aria-label={`Frame ${key}`}
        className={numberClass}
        defaultValue={Math.round(f!.frame[key] * 100) / 100}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        onBlur={(e) => {
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n) && n !== Math.round(f!.frame[key] * 100) / 100 && (key === 'x' || key === 'y' || n > 0)) controller.setFrame({ [key]: n }, { ids });
        }}
      />
    </label>
  );
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-frame-panel="" aria-label="Frame">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Frame</span>
        <button
          type="button"
          data-vector-frame-action="frame-selection"
          className={buttonClass}
          title="Frame Selection: put the selection in a frame fitted to it"
          aria-label="Frame Selection"
          disabled={!state.selection.length}
          onClick={() => controller.frameSelection()}
        >
          Frame selection
        </button>
      </div>
      {f && (
        <div className="space-y-2" data-vector-frame={f.id}>
          <div className="grid grid-cols-2 gap-1">
            {number('x', 'X')}
            {number('y', 'Y')}
            {number('width', 'W')}
            {number('height', 'H')}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex w-16 items-center gap-1.5 text-xs text-foreground">
              <input
                type="checkbox"
                aria-label="Frame fill on"
                checked={f.frame.fill !== undefined && f.frame.fill !== null}
                onChange={(e) => controller.setFrame({ fill: e.target.checked ? (fillHex ?? '#ffffff') : null }, { ids })}
              />
              Fill
            </label>
            <input
              type="color"
              aria-label="Frame fill colour"
              className="h-7 w-10 cursor-pointer rounded border border-border bg-background disabled:opacity-40"
              disabled={f.frame.fill === undefined || f.frame.fill === null}
              value={fillHex ?? '#ffffff'}
              onChange={(e) => controller.setFrame({ fill: e.target.value }, { ids, merge: 'frame-fill' })}
            />
            <label className="flex items-center gap-1 text-xs text-foreground" title="Hide what lies outside the frame">
              <input type="checkbox" aria-label="Clip content" checked={f.frame.clip !== false} onChange={(e) => controller.setFrame({ clip: e.target.checked }, { ids })} />
              Clip
            </label>
          </div>
        </div>
      )}
      {panel.resizing && (
        <div className="space-y-1" data-vector-resizing="">
          <label className="flex items-center gap-2 text-xs text-foreground">
            <span className="w-16">Horizontal</span>
            <select
              aria-label="Horizontal constraint"
              className={selectClass}
              value={panel.resizing.horizontal}
              onChange={(e) => controller.setResizing({ horizontal: e.target.value as VectorHorizontalResizing }, { ids: panel.resizing!.ids })}
            >
              {panel.resizing.horizontal === 'mixed' && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              {VECTOR_HORIZONTAL_RESIZING.map((h) => (
                <option key={h} value={h}>
                  {VECTOR_HORIZONTAL_RESIZING_LABELS[h]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <span className="w-16">Vertical</span>
            <select
              aria-label="Vertical constraint"
              className={selectClass}
              value={panel.resizing.vertical}
              onChange={(e) => controller.setResizing({ vertical: e.target.value as VectorVerticalResizing }, { ids: panel.resizing!.ids })}
            >
              {panel.resizing.vertical === 'mixed' && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              {VECTOR_VERTICAL_RESIZING.map((v) => (
                <option key={v} value={v}>
                  {VECTOR_VERTICAL_RESIZING_LABELS[v]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
