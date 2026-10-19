import React from 'react';
import { VECTOR_MASK_TYPE_OPTIONS, getVectorMaskPanel, type VectorEditorController, type VectorMaskType } from '@pixerate/editor/vector';
import { useVectorEditorState } from './useVectorEditor';

const buttonClass =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-background px-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-primary aria-pressed:text-primary-foreground';
const selectClass = 'h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs';

export interface VectorMaskPanelProps {
  controller: VectorEditorController;
  className?: string;
}

/**
 * Masks of the selection: Make Clipping Mask, Make Opacity Mask (the topmost selected object
 * masks the others) and Release; for a mask group (or something inside one) its type, Invert, a
 * switch that turns the mask off by hiding it, and Edit Mask / Edit Contents, which select the mask
 * (a path opens for anchor editing) or what it masks. Each change is one undo step.
 */
export function VectorMaskPanel({ controller, className }: VectorMaskPanelProps) {
  const state = useVectorEditorState(controller);
  const panel = getVectorMaskPanel(state);
  if (!panel) return null;
  const g = panel.group;
  const ids = g ? [g.id] : undefined;
  return (
    <div className={`space-y-2 ${className ?? ''}`} data-vector-mask-panel="" aria-label="Mask">
      <div className="flex flex-wrap items-center gap-1">
        <span className="w-16 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Mask</span>
        <button
          type="button"
          data-vector-mask-action="clip"
          className={buttonClass}
          title={panel.makeHint ?? 'Make Clipping Mask: the topmost object clips the others'}
          aria-label="Make Clipping Mask"
          disabled={!panel.canMake}
          onClick={() => controller.makeMask('clip')}
        >
          Clip
        </button>
        <button
          type="button"
          data-vector-mask-action="opacity"
          className={buttonClass}
          title={panel.makeHint ?? 'Make Opacity Mask: the topmost object fades the others by its brightness'}
          aria-label="Make Opacity Mask"
          disabled={!panel.canMake}
          onClick={() => controller.makeMask('luminance')}
        >
          Opacity
        </button>
        <button
          type="button"
          data-vector-mask-action="release"
          className={buttonClass}
          title="Release: the mask goes back on top and draws as itself"
          aria-label="Release Mask"
          disabled={!g}
          onClick={() => controller.releaseMask({ ids })}
        >
          Release
        </button>
      </div>
      {g && (
        <div className="space-y-2" data-vector-mask-group={g.id} data-mask-type={g.type}>
          <div className="flex items-center gap-1">
            <select
              aria-label="Mask type"
              className={selectClass}
              value={g.type}
              title={VECTOR_MASK_TYPE_OPTIONS.find((o) => o.value === g.type)?.title}
              onChange={(e) => controller.setMaskOptions({ type: e.target.value as VectorMaskType }, { ids })}
            >
              {VECTOR_MASK_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.title}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-foreground" title="Show the contents where the mask hides them">
              <input type="checkbox" aria-label="Invert mask" checked={g.invert} onChange={(e) => controller.setMaskOptions({ invert: e.target.checked }, { ids })} />
              Invert
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              data-vector-mask-action="edit-mask"
              className={buttonClass}
              aria-pressed={g.editing === 'mask'}
              title="Edit Mask: select the mask (a path opens for anchor editing)"
              aria-label="Edit Mask"
              onClick={() => controller.editMask({ id: g.id })}
            >
              Edit mask
            </button>
            <button
              type="button"
              data-vector-mask-action="edit-contents"
              className={buttonClass}
              aria-pressed={g.editing === 'contents'}
              title="Edit Contents: select what the mask masks"
              aria-label="Edit Contents"
              disabled={!g.contents.length}
              onClick={() => controller.editMaskContents({ id: g.id })}
            >
              Contents
            </button>
            <button
              type="button"
              data-vector-mask-action="toggle"
              className={buttonClass}
              aria-pressed={g.enabled}
              title={g.enabled ? 'Turn the mask off (hide it): the contents draw whole' : 'Turn the mask on'}
              aria-label="Mask on"
              onClick={() => controller.setMaskOptions({ enabled: !g.enabled }, { ids })}
            >
              {g.enabled ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
