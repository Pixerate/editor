import React, { useState } from 'react';
import type { ImageEditorController, ImageLayer, VectorMaskEdge } from '@pixerate/editor/image-editor';

export interface VectorMaskEdgesPanelProps {
  controller: ImageEditorController;
  /** The layer whose vector mask to edit. */
  layer: ImageLayer;
  className?: string;
}

const MODES = ['hard', 'feather', 'matte'] as const;
const input = 'w-12 bg-background border border-border rounded px-1 py-0.5 text-foreground';

/**
 * Hybrid mask edges: the soft segments of a layer's vector mask (feather or matte), with their
 * settings, as `set_vector_mask_edge` sets them. Alt+Shift-click a segment with Direct Selection
 * to cycle its mode on the canvas. Every change is one undo step.
 */
export const VectorMaskEdgesPanel: React.FC<VectorMaskEdgesPanelProps> = ({ controller, layer, className = '' }) => {
  const [error, setError] = useState<string | null>(null);
  const info = controller.getVectorMask(layer.id);
  if (!info) return null;
  const set = (e: VectorMaskEdge, mode: VectorMaskEdge['mode'], options: { radius?: number; inner?: number; outer?: number } = {}) => {
    setError(null);
    try {
      controller.setVectorMaskEdge(layer.id, { component: e.component, subpath: e.subpath, segment: e.segment }, mode, options);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  return (
    <div className={`flex flex-col gap-1.5 text-xs ${className}`} data-testid="vector-mask-edges">
      <span className="text-muted-foreground">Vector mask edges</span>
      <p className="text-muted-foreground">Alt+Shift-click a segment with Direct Selection to make it feathered or a hair matte.</p>
      {info.edges.length === 0 && <p className="text-muted-foreground">Every segment is hard.</p>}
      <ul className="flex flex-col gap-1">
        {info.edges.map((e) => (
          <li key={`${e.component}:${e.subpath}:${e.segment}`} data-testid="vector-mask-edge" className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-muted-foreground">
              {e.component}/{e.subpath}/{e.segment}
            </span>
            <select aria-label="Edge mode" value={e.mode} onChange={(ev) => set(e, ev.target.value as VectorMaskEdge['mode'])} className="bg-background border border-border rounded px-1 py-0.5 text-foreground">
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            {e.mode === 'feather' && (
              <label className="flex items-center gap-1 text-muted-foreground">
                radius
                <input type="number" min={0.5} max={250} step={0.5} aria-label="Edge feather radius" value={e.radius} onChange={(ev) => set(e, 'feather', { radius: num(ev.target.value, 4) })} className={input} />
              </label>
            )}
            {e.mode === 'matte' && (
              <>
                <label className="flex items-center gap-1 text-muted-foreground">
                  in
                  <input type="number" min={0.5} max={200} step={0.5} aria-label="Edge matte inner" value={e.inner} onChange={(ev) => set(e, 'matte', { inner: num(ev.target.value, 4), outer: e.outer })} className={input} />
                </label>
                <label className="flex items-center gap-1 text-muted-foreground">
                  out
                  <input type="number" min={0.5} max={200} step={0.5} aria-label="Edge matte outer" value={e.outer} onChange={(ev) => set(e, 'matte', { inner: e.inner, outer: num(ev.target.value, 8) })} className={input} />
                </label>
              </>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
