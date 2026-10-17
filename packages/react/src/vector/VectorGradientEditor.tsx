import React from 'react';
import {
  VECTOR_GRADIENT_TYPES,
  VECTOR_GRADIENT_SPREADS,
  VECTOR_GRADIENT_INTERPOLATIONS,
  VECTOR_STROKE_GRADIENT_MODES,
  VECTOR_GRADIENT_TYPE_LABELS,
  VECTOR_GRADIENT_SPREAD_LABELS,
  VECTOR_GRADIENT_INTERPOLATION_LABELS,
  VECTOR_STROKE_GRADIENT_MODE_LABELS,
  getVectorGradientEditor,
  vectorPaintToHex,
  type VectorEditorController,
  type VectorGradientInterpolation,
  type VectorGradientSpread,
  type VectorGradientType,
  type VectorStrokeGradientMode,
} from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

export interface VectorGradientEditorProps {
  controller: VectorEditorController;
  className?: string;
}

const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const numberClass = 'h-7 w-14 rounded border border-border bg-background px-1.5 text-xs';
const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded border border-border bg-background px-1.5 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
const percent = (v: number) => Math.round(v * 1000) / 10;

/**
 * Gradient editor for the selection's fill or stroke: style (or solid), the stop ramp (click it
 * to add a stop, pick a stop to edit its colour, opacity, position and midpoint), interpolation
 * space, smoothness, spread, how it lies on a stroke, and reverse.
 */
export function VectorGradientEditor({ controller, className }: VectorGradientEditorProps) {
  const state = useVectorEditorState(controller);
  const ed = getVectorGradientEditor(state);
  if (!ed) return null;
  const g = ed.gradient;
  const sel = ed.selected;
  const end = () => controller.endMergedEdit();
  const setType = (value: string) => {
    if (value === 'solid') {
      const first = ed.stops[0];
      controller.setStyle({ [ed.target]: vectorPaintToHex(first?.color) ?? first?.color ?? '#000000' }, undefined, { label: 'Solid Colour' });
    } else controller.setGradient({ type: value as VectorGradientType });
  };
  return (
    <div className={`space-y-1.5 ${className ?? ''}`} data-vector-gradient-editor={ed.target} aria-label="Gradient">
      <div className="flex items-center gap-1.5">
        <span className="w-16 text-xs text-foreground">Gradient</span>
        {(['fill', 'stroke'] as const).map((t) => (
          <button key={t} type="button" className={buttonClass} aria-pressed={ed.target === t} onClick={() => controller.setGradientTarget(t)}>
            {t === 'fill' ? 'Fill' : 'Stroke'}
          </button>
        ))}
        {ed.mixed && <span className="text-[11px] text-muted-foreground">Mixed</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-16 text-xs text-foreground">Type</span>
        <select aria-label="Gradient type" className={selectClass} value={ed.type ?? 'solid'} onChange={(e) => setType(e.target.value)}>
          <option value="solid">Solid</option>
          {VECTOR_GRADIENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {VECTOR_GRADIENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <button type="button" className={buttonClass} aria-label="Reverse gradient" title="Reverse gradient" disabled={!g} onClick={() => controller.reverseGradient()}>
          ⇄
        </button>
      </div>
      {g && (
        <>
          <div className="relative h-8" data-vector-gradient-ramp="">
            <div
              role="button"
              tabIndex={-1}
              aria-label="Add gradient stop"
              className="absolute inset-x-1.5 top-0 h-4 cursor-copy rounded border border-border"
              style={{ backgroundImage: `${ed.preview}, repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%)`, backgroundSize: 'auto, 8px 8px' }}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                controller.addGradientStop(r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5);
              }}
            />
            {ed.stops.map((s) => (
              <button
                key={s.index}
                type="button"
                data-vector-gradient-stop={s.index}
                aria-label={`Gradient stop ${s.index + 1} at ${percent(s.offset)}%`}
                aria-pressed={s.selected}
                className="absolute top-4 h-3.5 w-3 -translate-x-1/2 rounded-sm border border-border aria-pressed:ring-2 aria-pressed:ring-primary"
                style={{ left: `calc(6px + (100% - 12px) * ${s.offset})`, background: s.color, opacity: 0.4 + 0.6 * (s.opacity ?? 1) }}
                onClick={() => controller.selectGradientStop(s.selected ? null : s.index)}
              />
            ))}
          </div>
          {sel && (
            <div className="flex flex-wrap items-center gap-1.5" data-vector-gradient-selected-stop={sel.index}>
              <input
                type="color"
                aria-label="Stop colour"
                className="h-7 w-9 cursor-pointer rounded border border-border bg-background"
                value={vectorPaintToHex(sel.color) ?? '#000000'}
                onChange={(e) => controller.setGradientStop(sel.index, { color: e.target.value }, { merge: `gradient-stop-color-${sel.index}` })}
                onBlur={end}
              />
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                Opacity
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  aria-label="Stop opacity"
                  className={numberClass}
                  value={percent(sel.opacity ?? 1)}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) controller.setGradientStop(sel.index, { opacity: n / 100 });
                  }}
                />
              </label>
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                At
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  aria-label="Stop position"
                  className={numberClass}
                  value={percent(sel.offset)}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (Number.isFinite(n)) controller.setGradientStop(sel.index, { offset: n / 100 });
                  }}
                />
              </label>
              {!sel.last && (
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  Midpoint
                  <input
                    type="number"
                    min={5}
                    max={95}
                    step={1}
                    aria-label="Stop midpoint"
                    className={numberClass}
                    value={percent(sel.midpoint ?? 0.5)}
                    onChange={(e) => {
                      const n = parseFloat(e.target.value);
                      if (Number.isFinite(n)) controller.setGradientStop(sel.index, { midpoint: n / 100 });
                    }}
                  />
                </label>
              )}
              <button type="button" className={buttonClass} aria-label="Delete stop" title="Delete stop" disabled={ed.stops.length <= 2} onClick={() => controller.removeGradientStop(sel.index)}>
                ✕
              </button>
            </div>
          )}
          <label className="flex items-center gap-1.5 text-xs text-foreground">
            <span className="w-16">Colours</span>
            <select aria-label="Gradient interpolation" className={selectClass} value={ed.interpolation} onChange={(e) => controller.setGradient({ interpolation: e.target.value as VectorGradientInterpolation })}>
              {VECTOR_GRADIENT_INTERPOLATIONS.map((i) => (
                <option key={i} value={i}>
                  {VECTOR_GRADIENT_INTERPOLATION_LABELS[i]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-foreground">
            <span className="w-16">Smooth</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              aria-label="Gradient smoothness"
              className="h-4 flex-1 accent-primary"
              value={ed.smoothness}
              onChange={(e) => controller.setGradient({ smoothness: parseFloat(e.target.value) }, { merge: 'gradient-smoothness' })}
              onPointerUp={end}
              onBlur={end}
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-foreground">
            <span className="w-16">Spread</span>
            <select aria-label="Gradient spread" className={selectClass} value={ed.spread} onChange={(e) => controller.setGradient({ spread: e.target.value as VectorGradientSpread })}>
              {VECTOR_GRADIENT_SPREADS.map((sp) => (
                <option key={sp} value={sp}>
                  {VECTOR_GRADIENT_SPREAD_LABELS[sp]}
                </option>
              ))}
            </select>
          </label>
          {ed.target === 'stroke' && (
            <label className="flex items-center gap-1.5 text-xs text-foreground">
              <span className="w-16">On stroke</span>
              <select aria-label="Gradient on stroke" className={selectClass} value={ed.strokeMode} onChange={(e) => controller.setGradient({ strokeMode: e.target.value as VectorStrokeGradientMode })}>
                {VECTOR_STROKE_GRADIENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {VECTOR_STROKE_GRADIENT_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </div>
  );
}
