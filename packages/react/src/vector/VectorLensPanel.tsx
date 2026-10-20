import React from 'react';
import { VECTOR_LENS_LABELS, VECTOR_LENS_SPECS, VECTOR_LENS_TYPES, type VectorEditorController, type VectorLensType, type VectorPathNode } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const numberClass = 'h-7 w-16 rounded border border-border bg-background px-1.5 text-xs';

export interface VectorLensPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Lens: for a selected closed path, what it does to what is below it (none, magnify, fish eye,
 * brighten, invert, tinted grayscale, colour add, colour limit, heat map, wireframe,
 * transparency), its amount and colour. Each change is one undo step.
 */
export function VectorLensPanel({ controller, className }: VectorLensPanelProps) {
  const state = useVectorEditorState(controller);
  const path = state.selection
    .map((id) => controller.getNode(id))
    .find((n): n is VectorPathNode => n?.type === 'path' && n.subpaths.some((sp) => sp.closed) && !n.connector);
  if (!path) return null;
  const lens = path.lens ?? null;
  const spec = lens ? VECTOR_LENS_SPECS[lens.type] : null;
  const ids = [path.id];
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-lens-panel="" aria-label="Lens">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Lens</span>
        <select
          aria-label="Lens type"
          className={selectClass}
          value={lens?.type ?? ''}
          onChange={(e) => (e.target.value ? controller.setLens({ type: e.target.value as VectorLensType }, { ids }) : controller.setLens(null, { ids }))}
        >
          <option value="">None</option>
          {VECTOR_LENS_TYPES.map((t) => (
            <option key={t} value={t}>
              {VECTOR_LENS_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      {lens && spec && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16" />
          <input
            type="number"
            aria-label="Lens amount"
            title={`Amount: ${spec.unit} (${spec.min} to ${spec.max})`}
            className={numberClass}
            min={spec.min}
            max={spec.max}
            step={lens.type === 'magnify' ? 0.1 : 1}
            value={lens.amount}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) controller.setLens({ amount: Math.min(spec.max, Math.max(spec.min, v)) }, { ids, merge: `lens-amount-${path.id}` });
            }}
          />
          {spec.color !== null && (
            <input type="color" aria-label="Lens colour" title="Lens colour" className="h-7 w-9 rounded border border-border bg-background" value={lens.color ?? spec.color} onChange={(e) => controller.setLens({ color: e.target.value }, { ids, merge: `lens-color-${path.id}` })} />
          )}
        </div>
      )}
    </div>
  );
}
