import React, { useState } from 'react';
import type { PaintGradientKit, PaintGradientMappingKind, PaintGradientRepeat, PaintGradientSource, PaintGradientSpace } from '@pixerate/editor/paint-editor';

export interface PaintGradientEditorProps {
  value: PaintGradientSource;
  onChange: (paint: PaintGradientSource) => void;
  /** What `paint` / `secondary` stops show as (the editor's two colours). */
  colors: { paint: string; secondary: string };
  className?: string;
}

export interface PaintGradientEditorViewProps extends PaintGradientEditorProps {
  /** The gradient helpers (`PAINT_GRADIENT_KIT`, from the editor's own entry). */
  kit: PaintGradientKit;
}

const button = 'px-2 py-1 rounded text-[11px] bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40';
const select = 'rounded bg-slate-800 px-1 py-0.5 text-[11px]';
const number = 'w-16 rounded bg-slate-800 px-1 py-0.5 text-[11px]';
const pct = (v: number) => Math.round(v * 1000) / 10;

/**
 * Gradient paint editor (the vector editor's stop ramp, for paint): click the ramp to add a stop,
 * pick a stop to edit its colour (or the paint / second colour), opacity, position and midpoint;
 * the mixing space, what moves the stroke along it (distance with length and repeat, pressure,
 * tilt, speed, direction, time, across the tip, random), softness, reverse, and starting presets.
 */
export const PaintGradientEditorView: React.FC<PaintGradientEditorViewProps> = ({ value, onChange, colors, className, kit }) => {
  const {
    PAINT_GRADIENT_MAPPINGS,
    PAINT_GRADIENT_MAPPING_LABELS,
    PAINT_GRADIENT_PRESETS,
    PAINT_GRADIENT_REPEATS,
    PAINT_GRADIENT_REPEAT_LABELS,
    PAINT_GRADIENT_SPACES,
    PAINT_GRADIENT_SPACE_LABELS,
    addPaintGradientStop,
    paintGradientMappingFor,
    paintSourceCss,
    removePaintGradientStop,
    reversePaintGradient,
    updatePaintGradientStop,
  } = kit;
  const [selected, setSelected] = useState(0);
  const sel = Math.min(selected, value.stops.length - 1);
  const stop = value.stops[sel];
  const map = value.map;
  const stopHex = (c: string) => (c === 'paint' ? colors.paint : c === 'secondary' ? colors.secondary : c);
  const patchStop = (patch: Parameters<PaintGradientKit['updatePaintGradientStop']>[2]) => {
    const r = updatePaintGradientStop(value, sel, patch);
    setSelected(r.index);
    onChange(r.paint);
  };
  return (
    <div className={`flex flex-col gap-1.5 text-xs text-slate-200 ${className ?? ''}`} data-testid="paint-gradient-editor" aria-label="Gradient paint">
      <div className="flex items-center gap-1">
        <select aria-label="Gradient preset" className={select} value="" onChange={(e) => e.target.value && (setSelected(0), onChange(PAINT_GRADIENT_PRESETS[Number(e.target.value)].paint))}>
          <option value="">Presets…</option>
          {PAINT_GRADIENT_PRESETS.map((p, i) => (
            <option key={p.name} value={i}>
              {p.name}
            </option>
          ))}
        </select>
        <button type="button" className={button} onClick={() => onChange(reversePaintGradient(value))}>
          Reverse
        </button>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Gradient ramp: click to add a stop"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct(stop.offset)}
        data-testid="paint-gradient-ramp"
        className="relative h-6 cursor-copy rounded ring-1 ring-slate-700"
        style={{ background: paintSourceCss(value, colors) }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const r = addPaintGradientStop(value, rect.width ? (e.clientX - rect.left) / rect.width : 0.5, colors);
          if (r.index >= 0) {
            setSelected(r.index);
            onChange(r.paint);
          }
        }}
      />
      <div className="relative h-4" aria-label="Stops">
        {value.stops.map((s, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Stop ${i + 1} at ${pct(s.offset)}%`}
            aria-pressed={i === sel}
            className={`absolute top-0 h-4 w-3 -translate-x-1/2 rounded-sm ring-1 ${i === sel ? 'ring-white' : 'ring-slate-600'}`}
            style={{ left: `${s.offset * 100}%`, background: stopHex(s.color) }}
            onClick={() => setSelected(i)}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1" data-testid="paint-gradient-stop">
        <select aria-label="Stop colour source" className={select} value={stop.color === 'paint' || stop.color === 'secondary' ? stop.color : 'color'} onChange={(e) => patchStop({ color: e.target.value === 'color' ? stopHex(stop.color) : e.target.value })}>
          <option value="color">Colour</option>
          <option value="paint">Paint colour</option>
          <option value="secondary">Second colour</option>
        </select>
        {stop.color !== 'paint' && stop.color !== 'secondary' && <input type="color" aria-label="Stop colour" value={stop.color} onChange={(e) => patchStop({ color: e.target.value })} className="h-6 w-8 rounded bg-transparent" />}
        <label className="flex items-center gap-1">
          At
          <input type="number" aria-label="Stop position" min={0} max={100} step={1} value={pct(stop.offset)} onChange={(e) => patchStop({ offset: Number(e.target.value) / 100 })} className={number} />%
        </label>
        <label className="flex items-center gap-1">
          Opacity
          <input type="number" aria-label="Stop opacity" min={0} max={100} step={5} value={pct(stop.opacity ?? 1)} onChange={(e) => patchStop({ opacity: Number(e.target.value) / 100 })} className={number} />%
        </label>
        {sel < value.stops.length - 1 && (
          <label className="flex items-center gap-1">
            Midpoint
            <input type="number" aria-label="Stop midpoint" min={5} max={95} step={1} value={pct(stop.midpoint ?? 0.5)} onChange={(e) => patchStop({ midpoint: Number(e.target.value) / 100 })} className={number} />%
          </label>
        )}
        <button type="button" className={button} disabled={value.stops.length <= 2} onClick={() => (setSelected(Math.max(0, sel - 1)), onChange(removePaintGradientStop(value, sel)))}>
          Remove stop
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1" data-testid="paint-gradient-mapping">
        <select aria-label="Gradient follows" className={select} value={map.by} onChange={(e) => onChange({ ...value, map: paintGradientMappingFor(e.target.value as PaintGradientMappingKind, map) })}>
          {PAINT_GRADIENT_MAPPINGS.map((m) => (
            <option key={m} value={m}>
              {PAINT_GRADIENT_MAPPING_LABELS[m]}
            </option>
          ))}
        </select>
        {map.by === 'distance' && (
          <>
            <input type="number" aria-label="Gradient length" min={1} max={100000} value={map.length} onChange={(e) => onChange({ ...value, map: { ...map, length: Math.max(1, Number(e.target.value) || 1) } })} className={number} />
            <select aria-label="Gradient length unit" className={select} value={map.unit ?? 'px'} onChange={(e) => onChange({ ...value, map: { ...map, unit: e.target.value as 'px' | 'dabs' } })}>
              <option value="px">px</option>
              <option value="dabs">dabs</option>
            </select>
          </>
        )}
        {map.by === 'time' && <input type="number" aria-label="Gradient duration" min={1} max={600000} value={map.duration} onChange={(e) => onChange({ ...value, map: { ...map, duration: Math.max(1, Number(e.target.value) || 1) } })} className={number} />}
        {map.by === 'random' && <input type="number" aria-label="Dabs per pick" min={1} max={500} value={map.every ?? 1} onChange={(e) => onChange({ ...value, map: { ...map, every: Math.max(1, Math.round(Number(e.target.value) || 1)) } })} className={number} />}
        {(map.by === 'distance' || map.by === 'time') && (
          <select aria-label="Gradient repeat" className={select} value={map.repeat ?? 'clamp'} onChange={(e) => onChange({ ...value, map: { ...map, repeat: e.target.value as PaintGradientRepeat } })}>
            {PAINT_GRADIENT_REPEATS.map((r) => (
              <option key={r} value={r}>
                {PAINT_GRADIENT_REPEAT_LABELS[r]}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex items-center gap-1">
        <select aria-label="Gradient mixing" className={select} value={value.space} onChange={(e) => onChange({ ...value, space: e.target.value as PaintGradientSpace })}>
          {PAINT_GRADIENT_SPACES.map((s) => (
            <option key={s} value={s}>
              {PAINT_GRADIENT_SPACE_LABELS[s]}
            </option>
          ))}
        </select>
        <label className="flex flex-1 items-center gap-1">
          Softness
          <input type="range" aria-label="Gradient softness" min={0} max={1} step={0.05} value={value.softness ?? 1} onChange={(e) => onChange({ ...value, softness: Number(e.target.value) })} className="flex-1 accent-indigo-500" />
        </label>
      </div>
    </div>
  );
};
