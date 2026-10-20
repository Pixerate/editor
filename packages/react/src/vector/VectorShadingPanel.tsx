import React, { useState } from 'react';
import { isVectorFreeformGradient, isVectorMeshGradient, vectorPaintToHex, type VectorEditorController, type VectorPathNode } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40';
const numberClass = 'h-7 w-12 rounded border border-border bg-background px-1.5 text-xs';

export interface VectorShadingPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Gradient meshes and freeform gradients of the selected path: make a rows × columns mesh or a
 * freeform gradient, and edit the point picked with the Gradient tool (colour, opacity, and a
 * freeform point's spread, or remove it). Each change is one undo step.
 */
export function VectorShadingPanel({ controller, className }: VectorShadingPanelProps) {
  const state = useVectorEditorState(controller);
  const [rows, setRows] = useState(2);
  const [columns, setColumns] = useState(2);
  const path = state.selection.map((id) => controller.getNode(id)).find((n): n is VectorPathNode => n?.type === 'path');
  if (!path) return null;
  const fill = path.fill;
  const sel = state.shadingPoint?.nodeId === path.id ? state.shadingPoint : null;
  const mesh = isVectorMeshGradient(fill) ? fill : null;
  const free = isVectorFreeformGradient(fill) ? fill : null;
  const color = sel ? (mesh ? mesh.colors[sel.index] : free?.points[sel.index]?.color) : undefined;
  const opacity = sel ? (mesh ? (mesh.opacities?.[sel.index] ?? 1) : (free?.points[sel.index]?.opacity ?? 1)) : 1;
  const spread = sel && free ? (free.points[sel.index]?.spread ?? 0) : 0;
  const edit = (patch: { color?: string; opacity?: number; spread?: number }, merge?: string) => {
    if (!sel) return;
    if (mesh) controller.setMeshPoint(path.id, sel.index, patch, merge ? { merge } : {});
    else controller.setFreeformPoint(path.id, sel.index, patch, merge ? { merge } : {});
  };
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-shading-panel={path.id} aria-label="Mesh and freeform gradient">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Shading</span>
        <input type="number" min={1} max={32} aria-label="Mesh rows" title="Mesh rows" className={numberClass} value={rows} onChange={(e) => setRows(Math.max(1, Math.min(32, parseInt(e.target.value, 10) || 1)))} />
        <span className="text-xs text-muted-foreground">×</span>
        <input type="number" min={1} max={32} aria-label="Mesh columns" title="Mesh columns" className={numberClass} value={columns} onChange={(e) => setColumns(Math.max(1, Math.min(32, parseInt(e.target.value, 10) || 1)))} />
        <button type="button" className={buttonClass} data-vector-shading-action="mesh" title="Create Gradient Mesh: smooth patches whose points blend colours (edit them with the Gradient tool)" onClick={() => controller.setMeshGradient({ rows, columns }, { ids: [path.id] })}>
          Mesh
        </button>
        <button type="button" className={buttonClass} data-vector-shading-action="freeform" title="Freeform Gradient: colour points blended across the shape (click inside with the Gradient tool to add one)" onClick={() => controller.setFreeformGradient({}, { ids: [path.id] })}>
          Freeform
        </button>
      </div>
      {(mesh || free) && !sel && <p className="text-[11px] text-muted-foreground">Gradient tool (G): drag points; {free ? 'click inside to add one, Alt-click to remove.' : 'pick one to colour it.'}</p>}
      {sel && (
        <div className="flex flex-wrap items-center gap-2" data-vector-shading-point={sel.index}>
          <span className="w-16 text-xs text-foreground">Point {sel.index}</span>
          <input type="color" aria-label="Point colour" className="h-7 w-10 cursor-pointer rounded border border-border bg-background" value={vectorPaintToHex(color ?? '#000000') ?? '#000000'} onChange={(e) => edit({ color: e.target.value }, 'shading-color')} />
          <input type="range" min={0} max={1} step={0.05} aria-label="Point opacity" title="Opacity" className="h-4 w-20 accent-primary" value={opacity} onChange={(e) => edit({ opacity: parseFloat(e.target.value) }, 'shading-opacity')} />
          {free && (
            <>
              <input type="range" min={0} max={1} step={0.05} aria-label="Point spread" title="Spread: pure colour round the point" className="h-4 w-20 accent-primary" value={spread} onChange={(e) => edit({ spread: parseFloat(e.target.value) }, 'shading-spread')} />
              <button type="button" className={buttonClass} aria-label="Remove point" onClick={() => controller.removeFreeformPoint(path.id, sel.index)}>
                Remove
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
