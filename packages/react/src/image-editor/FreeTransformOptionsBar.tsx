import React, { useEffect, useState } from 'react';
import type { FreeTransformField, FreeTransformTool, Interpolation, TransformAnchor } from '@pixerate/editor/image-editor';
import { FREE_TRANSFORM_FIELDS, FREE_TRANSFORM_MODE_OPTIONS, INTERPOLATIONS, TRANSFORM_ANCHORS } from '@pixerate/editor/image-editor';

export interface FreeTransformOptionsBarProps {
  tool: FreeTransformTool;
  className?: string;
}

const chip = (on: boolean) => `px-2 py-1 rounded text-[11px] ${on ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`;
const round = (v: number, unit: string) => (unit === 'px' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

/**
 * Free Transform's options bar (Photoshop's): the mode switch (Free, Rotate, Skew, Distort,
 * Perspective), the reference-point locator, X / Y of the reference point, W / H in percent with
 * the proportional chain, the angle and skews, the interpolation, and Commit (Enter) / Cancel
 * (Esc). Typed values apply on Enter or when the field loses focus.
 */
export const FreeTransformOptionsBar: React.FC<FreeTransformOptionsBarProps> = ({ tool, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => tool.subscribe(() => setTick((n) => n + 1)), [tool]);
  const bar = tool.bar();
  if (!tool.active || !bar) return null;
  const apply = (field: FreeTransformField, raw: string) => {
    const v = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(v) && Math.abs(v - bar[field]) > 1e-9) tool.setField(field, v);
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs text-slate-200 ${className ?? ''}`} data-testid="free-transform-options" role="toolbar" aria-label="Free Transform options">
      <div className="flex gap-1" role="group" aria-label="Transform mode">
        {FREE_TRANSFORM_MODE_OPTIONS.map((m) => (
          <button key={m.id} type="button" title={m.title} aria-pressed={tool.mode === m.id} className={chip(tool.mode === m.id)} onClick={() => tool.setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-px" role="group" aria-label="Reference point">
        {TRANSFORM_ANCHORS.map((a: TransformAnchor) => (
          <button key={a} type="button" aria-label={`Reference point ${a}`} title={`Reference point: ${a}`} className="h-2.5 w-2.5 rounded-sm bg-slate-700 hover:bg-indigo-500" onClick={() => tool.setReference(a)} />
        ))}
      </div>
      {FREE_TRANSFORM_FIELDS.map((f) => (
        <label key={f.id} className="flex items-center gap-1" title={f.title}>
          <span className="text-slate-400">{f.label}</span>
          <input
            key={`${f.id}:${round(bar[f.id], f.unit)}`}
            type="number"
            aria-label={f.title}
            defaultValue={round(bar[f.id], f.unit)}
            disabled={!bar.affine}
            step={f.unit === 'px' ? 1 : 0.1}
            className="w-16 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-right disabled:opacity-40"
            onBlur={(e) => apply(f.id, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                apply(f.id, e.currentTarget.value);
              }
            }}
          />
          <span className="text-slate-500">{f.unit}</span>
          {f.id === 'scaleX' && (
            <button
              type="button"
              aria-label="Keep width and height proportional"
              aria-pressed={tool.proportional}
              className={chip(tool.proportional)}
              onClick={() => {
                tool.proportional = !tool.proportional;
                setTick((n) => n + 1);
              }}
            >
              ⛓︎
            </button>
          )}
        </label>
      ))}
      <label className="flex items-center gap-1">
        <span className="text-slate-400">Interpolation</span>
        <select
          aria-label="Interpolation"
          value={tool.interpolation}
          onChange={(e) => tool.setInterpolation(e.target.value as Interpolation)}
          className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5"
        >
          {INTERPOLATIONS.map((i) => (
            <option key={i} value={i}>
              {i[0].toUpperCase() + i.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" title="Commit (Enter)" className="px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => tool.commit()}>
        Commit
      </button>
      <button type="button" title="Cancel (Esc)" className={chip(false)} onClick={() => tool.cancel()}>
        Cancel
      </button>
      {tool.error && (
        <span role="alert" className="text-rose-400">
          {tool.error}
        </span>
      )}
    </div>
  );
};
