import React from 'react';
import { vectorPerspectivePlanes, vectorPerspectivePreset, type VectorEditorController, type VectorPerspectivePlane } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const PLANE_LABELS: Record<VectorPerspectivePlane, string> = { floor: 'Floor', left: 'Left wall', right: 'Right wall', side: 'Side wall', front: 'Front' };

export interface VectorPerspectivePanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Perspective drawing: add a 1-, 2- or 3-point grid, pick the plane new shapes are drawn on, lay
 * the selection onto it, show or hide the grid, or remove it. Grid changes and attaching are one
 * undo step each.
 */
export function VectorPerspectivePanel({ controller, className }: VectorPerspectivePanelProps) {
  const state = useVectorEditorState(controller);
  const grid = state.document.perspective ?? null;
  const planes = grid ? vectorPerspectivePlanes(grid) : [];
  const [attachTo, setAttachTo] = React.useState<VectorPerspectivePlane | ''>('');
  const target = (state.perspectivePlane ?? attachTo) || planes[0];
  const add = (n: 1 | 2 | 3) => controller.setPerspective(vectorPerspectivePreset(n, state.document.width, state.document.height));
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-perspective-panel="" aria-label="Perspective">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Perspective</span>
        {([1, 2, 3] as const).map((n) => (
          <button key={n} type="button" className={buttonClass} aria-pressed={grid?.vanishingPoints.length === n} data-vector-perspective-preset={n} title={`A ${n}-point perspective grid for the page`} onClick={() => add(n)}>
            {n}-pt
          </button>
        ))}
      </div>
      {grid && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16" />
          <select aria-label="Draw on plane" title="New rectangles, ellipses, polygons and stars are drawn on this plane" className={selectClass} value={state.perspectivePlane ?? ''} onChange={(e) => controller.setPerspectivePlane((e.target.value || null) as VectorPerspectivePlane | null)}>
            <option value="">Draw flat</option>
            {planes.map((p) => (
              <option key={p} value={p}>
                Draw on {PLANE_LABELS[p].toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      )}
      {grid && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16" />
          {!state.perspectivePlane && (
            <select aria-label="Attach to plane" className="h-7 w-24 rounded border border-border bg-background px-1 text-xs" value={attachTo || planes[0]} onChange={(e) => setAttachTo(e.target.value as VectorPerspectivePlane)}>
              {planes.map((p) => (
                <option key={p} value={p}>
                  {PLANE_LABELS[p]}
                </option>
              ))}
            </select>
          )}
          <button type="button" className={buttonClass} disabled={!state.selection.length} title="Lay the selection onto the plane (read flat from the grid's origin)" onClick={() => controller.attachToPerspective(target)}>
            Attach
          </button>
          <label className="flex items-center gap-1 text-xs text-foreground" title="Show the grid on the canvas">
            <input type="checkbox" aria-label="Show perspective grid" checked={grid.visible !== false} onChange={(e) => controller.setPerspective({ ...grid, visible: e.target.checked })} />
            Show
          </label>
          <button type="button" className={buttonClass} title="Remove the grid (art on it stays)" onClick={() => controller.setPerspective(null)}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
