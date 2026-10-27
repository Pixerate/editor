import React, { useEffect, useState } from 'react';
import type { FreeTransformField, FreeTransformTool, Interpolation, TransformAnchor, WarpBar } from '@pixerate/editor/image-editor';
import { FREE_TRANSFORM_FIELDS, FREE_TRANSFORM_MODE_OPTIONS, INTERPOLATIONS, TRANSFORM_ANCHORS, WARP_GRID_OPTIONS, WARP_STYLE_OPTIONS } from '@pixerate/editor/image-editor';
import { imageChipClass, imageFieldClass } from './styles';

export interface FreeTransformOptionsBarProps {
  tool: FreeTransformTool;
  className?: string;
}


const round = (v: number, unit: string) => (unit === 'px' ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

/**
 * Free Transform's options bar (Photoshop's): the mode switch (Free, Rotate, Skew, Distort,
 * Perspective, Warp), the reference-point locator, X / Y of the reference point, W / H in percent
 * with the proportional chain, the angle and skews, the interpolation, and Commit (Enter) / Cancel
 * (Esc). In Warp mode the numbers give way to the warp style, bend, horizontal and vertical
 * distortion, orientation and grid. Typed values apply on Enter or when the field loses focus.
 */
export const FreeTransformOptionsBar: React.FC<FreeTransformOptionsBarProps> = ({ tool, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => tool.subscribe(() => setTick((n) => n + 1)), [tool]);
  const bar = tool.bar();
  if (!tool.active || !bar) return null;
  const warp = tool.warpBar();
  const warpNumber = (key: 'bend' | 'horizontal' | 'vertical', raw: string) => {
    const v = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(v) && v !== warp[key]) tool.setWarp({ [key]: Math.max(-100, Math.min(100, v)) } as Partial<WarpBar>);
  };
  const apply = (field: FreeTransformField, raw: string) => {
    const v = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(v) && Math.abs(v - bar[field]) > 1e-9) tool.setField(field, v);
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs text-foreground ${className ?? ''}`} data-testid="free-transform-options" role="toolbar" aria-label="Free Transform options">
      <div className="flex gap-1" role="group" aria-label="Transform mode">
        {FREE_TRANSFORM_MODE_OPTIONS.map((m) => (
          <button key={m.id} type="button" title={m.title} aria-pressed={tool.mode === m.id} className={imageChipClass(tool.mode === m.id)} onClick={() => tool.setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-px" role="group" aria-label="Reference point">
        {TRANSFORM_ANCHORS.map((a: TransformAnchor) => (
          <button key={a} type="button" aria-label={`Reference point ${a}`} title={`Reference point: ${a}`} className="h-2.5 w-2.5 rounded-sm bg-accent hover:bg-primary/90" onClick={() => tool.setReference(a)} />
        ))}
      </div>
      {tool.mode === 'warp' && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Warp options">
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">Warp</span>
            <select aria-label="Warp style" value={warp.style} onChange={(e) => tool.setWarp({ style: e.target.value as WarpBar['style'] })} className={imageFieldClass}>
              {WARP_STYLE_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {(['bend', 'horizontal', 'vertical'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <span className="text-muted-foreground">{k === 'bend' ? 'Bend' : k === 'horizontal' ? 'H' : 'V'}</span>
              <input
                key={`${k}:${warp[k]}`}
                type="number"
                aria-label={k === 'bend' ? 'Warp bend in percent' : `Warp ${k} distortion in percent`}
                defaultValue={warp[k]}
                min={-100}
                max={100}
                disabled={warp.style === 'custom'}
                className="w-14 rounded border border-border bg-background px-1 py-0.5 text-right disabled:opacity-40"
                onBlur={(e) => warpNumber(k, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    warpNumber(k, e.currentTarget.value);
                  }
                }}
              />
              <span className="text-muted-foreground">%</span>
            </label>
          ))}
          <button
            type="button"
            title="Bend along the vertical axis"
            aria-pressed={warp.orientation === 'vertical'}
            disabled={warp.style === 'custom'}
            className={imageChipClass(warp.orientation === 'vertical')}
            onClick={() => tool.setWarp({ orientation: warp.orientation === 'vertical' ? 'horizontal' : 'vertical' })}
          >
            Vertical
          </button>
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">Grid</span>
            <select
              aria-label="Warp grid"
              value={WARP_GRID_OPTIONS.find((g) => g.columns === warp.columns && g.rows === warp.rows)?.id ?? '1x1'}
              onChange={(e) => {
                const g = WARP_GRID_OPTIONS.find((o) => o.id === e.target.value)!;
                tool.setWarp({ columns: g.columns, rows: g.rows });
              }}
              className={imageFieldClass}
            >
              {WARP_GRID_OPTIONS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {tool.mode !== 'warp' && FREE_TRANSFORM_FIELDS.map((f) => (
        <label key={f.id} className="flex items-center gap-1" title={f.title}>
          <span className="text-muted-foreground">{f.label}</span>
          <input
            key={`${f.id}:${round(bar[f.id], f.unit)}`}
            type="number"
            aria-label={f.title}
            defaultValue={round(bar[f.id], f.unit)}
            disabled={!bar.affine}
            step={f.unit === 'px' ? 1 : 0.1}
            className="w-16 rounded border border-border bg-background px-1 py-0.5 text-right disabled:opacity-40"
            onBlur={(e) => apply(f.id, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                apply(f.id, e.currentTarget.value);
              }
            }}
          />
          <span className="text-muted-foreground">{f.unit}</span>
          {f.id === 'scaleX' && (
            <button
              type="button"
              aria-label="Keep width and height proportional"
              aria-pressed={tool.proportional}
              className={imageChipClass(tool.proportional)}
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
        <span className="text-muted-foreground">Interpolation</span>
        <select
          aria-label="Interpolation"
          value={tool.interpolation}
          onChange={(e) => tool.setInterpolation(e.target.value as Interpolation)}
          className={imageFieldClass}
        >
          {INTERPOLATIONS.map((i) => (
            <option key={i} value={i}>
              {i[0].toUpperCase() + i.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <button type="button" title="Commit (Enter)" className="px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => tool.commit()}>
        Commit
      </button>
      <button type="button" title="Cancel (Esc)" className={imageChipClass(false)} onClick={() => tool.cancel()}>
        Cancel
      </button>
      {tool.error && (
        <span role="alert" className="text-destructive">
          {tool.error}
        </span>
      )}
    </div>
  );
};
