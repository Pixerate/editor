import React, { useEffect, useState } from 'react';
import type { ImageEditorController, LiveShapeKind, ShapeToolOptions } from '@pixerate/editor/image-editor';
import { LIVE_SHAPE_KINDS, SHAPE_KIND_LABELS, applyShapeOptions } from '@pixerate/editor/image-editor';
import { imageChipClass, imageColorInputClass, imageFieldClass } from './styles';

export interface ShapeOptionsBarProps {
  controller: ImageEditorController;
  options: ShapeToolOptions;
  onChange: (options: ShapeToolOptions) => void;
  className?: string;
}



/**
 * The shape tool's options: the kind to draw, fill and stroke (colour or none), stroke width and
 * the kind's own settings (corner radius, sides, points, line weight and arrowhead). Changes also
 * apply to the active shape layer, as one undo step each.
 */
export const ShapeOptionsBar: React.FC<ShapeOptionsBarProps> = ({ controller, options, onChange, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [error, setError] = useState<string | null>(null);
  const active = controller.getActiveLayer();
  const shapeId = active?.type === 'shape' ? active.id : null;
  const set = (change: Partial<ShapeToolOptions>) => {
    onChange({ ...options, ...change });
    if (!shapeId) return;
    try {
      setError(null);
      applyShapeOptions(controller, shapeId, change);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const num = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Number(v) || min));

  return (
    <div className={`flex flex-col gap-2 text-xs text-foreground ${className ?? ''}`} data-testid="shape-options">
      <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Shape kind">
        {LIVE_SHAPE_KINDS.map((k: LiveShapeKind) => (
          <button key={k} type="button" aria-pressed={options.kind === k} className={imageChipClass(options.kind === k)} onClick={() => onChange({ ...options, kind: k })}>
            {SHAPE_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1">
          <input type="checkbox" aria-label="Fill" checked={options.fill !== null} onChange={(e) => set({ fill: e.target.checked ? '#4f46e5' : null })} />
          Fill
          <input
            type="color"
            aria-label="Fill colour"
            disabled={options.fill === null}
            value={options.fill ?? '#4f46e5'}
            onChange={(e) => set({ fill: e.target.value })}
            className={imageColorInputClass}
          />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" aria-label="Stroke" checked={options.stroke !== null} onChange={(e) => set({ stroke: e.target.checked ? '#000000' : null })} />
          Stroke
          <input
            type="color"
            aria-label="Stroke colour"
            disabled={options.stroke === null}
            value={options.stroke ?? '#000000'}
            onChange={(e) => set({ stroke: e.target.value })}
            className={imageColorInputClass}
          />
        </label>
        <label className="flex items-center gap-1">
          Width
          <input
            type="number"
            aria-label="Stroke width"
            min={0}
            max={200}
            value={options.strokeWidth}
            onChange={(e) => set({ strokeWidth: num(e.target.value, 0, 200) })}
            className={`w-14 ${imageFieldClass}`}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {options.kind === 'rect' && (
          <label className="flex items-center gap-1">
            Radius
            <input type="number" aria-label="Corner radius" min={0} max={1000} value={options.radius} onChange={(e) => set({ radius: num(e.target.value, 0, 1000) })} className={`w-14 ${imageFieldClass}`} />
          </label>
        )}
        {options.kind === 'polygon' && (
          <label className="flex items-center gap-1">
            Sides
            <input type="number" aria-label="Sides" min={3} max={100} value={options.sides} onChange={(e) => set({ sides: num(e.target.value, 3, 100) })} className={`w-14 ${imageFieldClass}`} />
          </label>
        )}
        {options.kind === 'star' && (
          <>
            <label className="flex items-center gap-1">
              Points
              <input type="number" aria-label="Points" min={3} max={100} value={options.points} onChange={(e) => set({ points: num(e.target.value, 3, 100) })} className={`w-14 ${imageFieldClass}`} />
            </label>
            <label className="flex items-center gap-1">
              Inner
              <input
                type="range"
                aria-label="Inner radius"
                min={0.05}
                max={1}
                step={0.05}
                value={options.innerRatio}
                onChange={(e) => set({ innerRatio: Number(e.target.value) })}
                className="accent-primary"
              />
            </label>
          </>
        )}
        {options.kind === 'line' && (
          <>
            <label className="flex items-center gap-1">
              Weight
              <input type="number" aria-label="Line weight" min={1} max={200} value={options.weight} onChange={(e) => set({ weight: num(e.target.value, 1, 200) })} className={`w-14 ${imageFieldClass}`} />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" aria-label="Arrowhead" checked={options.arrow} onChange={(e) => set({ arrow: e.target.checked })} />
              Arrowhead
            </label>
          </>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">Drag on the image to draw. Shift: square, circle or 45° line. Alt: from the centre.</p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
