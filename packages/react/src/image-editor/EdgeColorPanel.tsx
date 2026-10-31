import React, { useRef, useState } from 'react';
import type { ImageEditorController, ImageLayer } from '@pixerate/editor/image-editor';

export interface EdgeColorPanelProps {
  controller: ImageEditorController;
  /** The layer to edit (a pixel, shape, type or smart object layer). */
  layer: ImageLayer;
  className?: string;
}

const SLIDERS = [
  { key: 'decontaminate', label: 'Decontaminate', hint: 'Unmix the old background from a soft-edged mask' },
  { key: 'despill', label: 'Despill', hint: "Take out the old background's hue at the edge" },
  { key: 'ambient', label: 'Cast', hint: 'Tint the edge with what is behind the layer, live' },
] as const;

/**
 * Edge Colour: decontamination, despill and the live edge cast of a layer's soft edge, applied
 * when compositing (nothing is baked), as the `set_edge_*` tools set them. A slider drag is one
 * undo step.
 */
export const EdgeColorPanel: React.FC<EdgeColorPanelProps> = ({ controller, layer, className = '' }) => {
  const [error, setError] = useState<string | null>(null);
  const commitNext = useRef(true);
  const info = controller.getEdgeColor(layer.id);
  const fixed = info.ambientSource !== 'auto';
  const set = (change: Parameters<ImageEditorController['setEdgeColor']>[1]) => {
    setError(null);
    try {
      controller.setEdgeColor(layer.id, change, commitNext.current);
      commitNext.current = false;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const sliderEvents = {
    onPointerDown: () => (commitNext.current = true),
    onPointerUp: () => (commitNext.current = true),
    onKeyDown: () => (commitNext.current = true),
  };
  return (
    <details className={`text-xs ${className}`} data-testid="edge-color-panel" open={Boolean(info.decontaminate || info.despill || info.ambient) || undefined}>
      <summary className="cursor-pointer text-muted-foreground">Edge Colour</summary>
      <div className="flex flex-col gap-1.5 pt-1">
        {SLIDERS.map((s) => (
          <label key={s.key} className="flex flex-col gap-0.5" title={s.hint}>
            <span className="flex justify-between text-muted-foreground">
              <span>{s.label}</span>
              <span className="font-mono">{info[s.key]}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              aria-label={`Edge ${s.label.toLowerCase()}`}
              value={info[s.key]}
              {...sliderEvents}
              onChange={(e) => set({ [s.key]: Number(e.target.value) })}
              className="accent-primary"
            />
          </label>
        ))}
        <label className="flex items-center gap-1.5 text-foreground">
          <input
            type="checkbox"
            aria-label="Fixed cast colour"
            checked={fixed}
            onChange={(e) => {
              commitNext.current = true;
              set({ ambientColor: e.target.checked ? '#808080' : 'auto' });
            }}
            className="accent-primary"
          />
          Fixed cast colour
          {fixed && (
            <input
              type="color"
              aria-label="Cast colour"
              value={info.ambientSource}
              onChange={(e) => {
                commitNext.current = true;
                set({ ambientColor: e.target.value });
              }}
              className="h-5 w-8 bg-background border border-border rounded"
            />
          )}
        </label>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </div>
    </details>
  );
};
