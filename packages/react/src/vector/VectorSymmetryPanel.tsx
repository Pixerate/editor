import React from 'react';
import { VECTOR_SYMMETRY_MODES, VECTOR_SYMMETRY_MODE_LABELS, isVectorSymmetryGroup, type VectorEditorController, type VectorSymmetryMode } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';
const numberClass = 'h-7 w-12 rounded border border-border bg-background px-1.5 text-xs';

export interface VectorSymmetryPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Live symmetry: make a symmetry group from the selection (or an empty one to draw into), and for
 * a selected symmetry group its mode, radial copies and mirroring, drawing inside it, and release
 * (keeping the copies with Expand). Each change is one undo step.
 */
export function VectorSymmetryPanel({ controller, className }: VectorSymmetryPanelProps) {
  const state = useVectorEditorState(controller);
  const group = state.selection.map((id) => controller.getNode(id)).find(isVectorSymmetryGroup) ?? null;
  const s = group?.symmetry;
  const ids = group ? [group.id] : undefined;
  const drawing = !!group && state.symmetryTarget === group.id;
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-symmetry-panel="" aria-label="Symmetry">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Symmetry</span>
        {!group && (
          <button type="button" className={buttonClass} data-vector-symmetry-action="make" title="Make Symmetry: the selection (or nothing yet) mirrored live across a vertical axis" onClick={() => controller.makeSymmetry({ mode: 'vertical' })}>
            Mirror
          </button>
        )}
        {!group && (
          <button type="button" className={buttonClass} data-vector-symmetry-action="radial" title="Make Symmetry: the selection repeated round its centre" onClick={() => controller.makeSymmetry({ mode: 'radial', copies: 6 })}>
            Radial
          </button>
        )}
        {group && s && (
          <>
            <select aria-label="Symmetry mode" className={selectClass} value={s.mode} onChange={(e) => controller.setSymmetry({ mode: e.target.value as VectorSymmetryMode }, { ids })}>
              {VECTOR_SYMMETRY_MODES.map((m) => (
                <option key={m} value={m}>
                  {VECTOR_SYMMETRY_MODE_LABELS[m]}
                </option>
              ))}
            </select>
            {s.mode === 'radial' && (
              <>
                <input type="number" min={2} max={64} aria-label="Symmetry copies" title="Copies round the circle" className={numberClass} value={s.copies ?? 6} onChange={(e) => controller.setSymmetry({ copies: Math.max(2, Math.min(64, parseInt(e.target.value, 10) || 2)) }, { ids })} />
                <label className="flex items-center gap-1 text-xs text-foreground" title="Mirror each copy too (kaleidoscope)">
                  <input type="checkbox" aria-label="Mirror copies" checked={!!s.mirror} onChange={(e) => controller.setSymmetry({ mirror: e.target.checked }, { ids })} />
                  Mirror
                </label>
              </>
            )}
          </>
        )}
      </div>
      {group && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="w-16" />
          <button type="button" className={buttonClass} aria-pressed={drawing} data-vector-symmetry-action="draw" title="Draw inside: new pen, pencil, shape and text art goes into the group, mirrored as you draw (Escape stops)" onClick={() => (drawing ? controller.exitSymmetry() : controller.enterSymmetry(group.id))}>
            Draw inside
          </button>
          <button type="button" className={buttonClass} title="Expand: keep the copies as real objects" onClick={() => controller.releaseSymmetry({ ids, expand: true })}>
            Expand
          </button>
          <button type="button" className={buttonClass} title="Release: stop repeating (the copies go)" onClick={() => controller.releaseSymmetry({ ids })}>
            Release
          </button>
        </div>
      )}
    </div>
  );
}
