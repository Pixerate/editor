import React, { useState } from 'react';
import type { AdjustmentKind, AdjustmentLayer, ImageEditorController, RefineEdgeParams, RefineOutput, SelectionMask } from '@pixerate/editor/image-editor';
import {
  ADJUSTMENT_KINDS,
  REFINE_EDGE_CONTROLS,
  REFINE_OUTPUTS,
  adjustmentKindLabel,
  layerMaskFromSelection,
} from '@pixerate/editor/image-editor';
import { imageRangeClass, imageSectionTitleClass } from './styles';
import { MaskEdgeCheck } from './MaskEdgeCheck';
import { SelectionChangeCheck } from './SelectionChangeCheck';

export interface RefineEdgePanelProps {
  controller: ImageEditorController;
  /** The current selection (`state.selection`), so the panel re-renders with it. */
  selection?: SelectionMask | null;
  /** The adjustment layers (`state.adjustments.layers`), for the mask actions. */
  layers?: AdjustmentLayer[];
  className?: string;
}

const DEFAULT_PARAMS: Required<RefineEdgeParams> = { radius: 8, smartRadius: false, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0 };

const button =
  'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';

/**
 * Refine Edge (snap the selection, e.g. a coarse AI mask, to the image's edges), Check Edge (its
 * measured quality, see `MaskEdgeCheck`) and layer masks:
 * use the selection as an adjustment layer's mask, edit mask density and feather, load a mask
 * back as a selection.
 */
export const RefineEdgePanel: React.FC<RefineEdgePanelProps> = ({ controller, selection, layers, className = '' }) => {
  const [params, setParams] = useState<Required<RefineEdgeParams>>(DEFAULT_PARAMS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layerId, setLayerId] = useState('');
  const [newKind, setNewKind] = useState<AdjustmentKind>('hueSaturation');
  const [output, setOutput] = useState<RefineOutput>('selection');
  const [decontaminate, setDecontaminate] = useState(0);
  const [objectAware, setObjectAware] = useState(false);
  const [onlyUncertain, setOnlyUncertain] = useState(false);
  const canObject = Boolean(controller.segmentationProvider);
  const toLayer = output !== 'selection' && output !== 'layer-mask';
  const sel = selection === undefined ? controller.getSelection() : selection;
  const list = layers ?? controller.getAdjustmentLayers();
  const target = list.find((l) => l.id === layerId) ?? list[list.length - 1];

  const refine = async () => {
    setBusy(true);
    setError(null);
    try {
      // Only where the edge has no image edge under it (the selection's uncertain regions).
      const regions = onlyUncertain ? controller.selectionUncertainty().regions.map((r) => r.bounds) : undefined;
      if (regions && !regions.length) throw new Error("No uncertain areas: the selection's edge already follows edges in the image. Untick Only uncertain areas to refine everywhere.");
      await controller.refineSelectionTo(params, output, {
        decontaminate: toLayer ? decontaminate : 0,
        refineMode: canObject && objectAware ? 'object' : 'color',
        ...(regions ? { regions } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="refine-edge-panel" className={`flex flex-col gap-3 text-xs ${className}`}>
      <span className={imageSectionTitleClass}>Refine Edge</span>
      {REFINE_EDGE_CONTROLS.map((c) => (
        <label key={c.id} className="flex flex-col gap-1">
          <span className="flex justify-between text-muted-foreground">
            <span>{c.label}</span>
            <span className="font-mono">
              {params[c.id]}
              {c.unit}
            </span>
          </span>
          <input
            type="range"
            min={c.min}
            max={c.max}
            step={c.step}
            aria-label={c.label}
            value={params[c.id]}
            onChange={(e) => setParams({ ...params, [c.id]: Number(e.target.value) })}
            className={imageRangeClass}
          />
        </label>
      ))}
      <label className="flex items-center gap-2 text-foreground">
        <input type="checkbox" checked={params.smartRadius} onChange={(e) => setParams({ ...params, smartRadius: e.target.checked })} />
        Smart Radius
      </label>
      <label className="flex items-center gap-2 text-foreground" title="Refine only where the edge has no image edge under it">
        <input type="checkbox" aria-label="Only uncertain areas" checked={onlyUncertain} onChange={(e) => setOnlyUncertain(e.target.checked)} />
        Only uncertain areas
      </label>
      {canObject && (
        <label className="flex items-center gap-2 text-foreground">
          <input type="checkbox" aria-label="Object aware" checked={objectAware} onChange={(e) => setObjectAware(e.target.checked)} />
          Object aware (segmentation model)
        </label>
      )}
      <label className="flex items-center gap-2 text-muted-foreground">
        Output to
        <select
          aria-label="Refine output"
          value={output}
          onChange={(e) => setOutput(e.target.value as RefineOutput)}
          className="flex-1 bg-background border border-border rounded px-1 py-1 text-foreground"
        >
          {REFINE_OUTPUTS.filter((o) => !o.needsDocuments || controller.canOpenDocuments).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="flex justify-between text-muted-foreground">
          <span>Decontaminate colors{toLayer ? '' : ' (new layer or document outputs)'}</span>
          <span className="font-mono">{decontaminate}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          aria-label="Decontaminate amount"
          disabled={!toLayer}
          value={decontaminate}
          onChange={(e) => setDecontaminate(Number(e.target.value))}
          className={imageRangeClass}
        />
      </label>
      <div className="flex gap-1">
        <button type="button" className={button} disabled={!sel || busy} onClick={refine}>
          Refine Edge
        </button>
        <button type="button" className={button} onClick={() => setParams(DEFAULT_PARAMS)}>
          Reset
        </button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <MaskEdgeCheck controller={controller} selection={sel} />
      <SelectionChangeCheck controller={controller} selection={sel} />

      <span className="font-semibold text-foreground uppercase tracking-wider text-[11px] mt-2">Layer Mask</span>
      <div className="flex gap-1 items-center">
        <select
          aria-label="New masked layer kind"
          value={newKind}
          onChange={(e) => setNewKind(e.target.value as AdjustmentKind)}
          className="flex-1 bg-background border border-border rounded px-1 py-1 text-foreground"
        >
          {ADJUSTMENT_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={button}
          disabled={!sel}
          onClick={() => sel && setLayerId(controller.addAdjustmentLayer({ kind: newKind, mask: layerMaskFromSelection(sel) }))}
        >
          New Masked Layer
        </button>
      </div>
      {list.length > 0 && target && (
        <div className="flex flex-col gap-2">
          <select
            aria-label="Mask layer"
            value={target.id}
            onChange={(e) => setLayerId(e.target.value)}
            className="bg-background border border-border rounded px-1 py-1 text-foreground"
          >
            {list.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name || adjustmentKindLabel(l.kind)}
                {l.mask ? ' (masked)' : ''}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={button} disabled={!sel} onClick={() => controller.applySelectionAsLayerMask(target.id)}>
              Mask with Selection
            </button>
            <button type="button" className={button} disabled={!target.mask} onClick={() => controller.selectionFromLayerMask(target.id)}>
              Load as Selection
            </button>
            <button type="button" className={button} disabled={!target.mask} onClick={() => controller.setAdjustmentLayerMask(target.id, null)}>
              Remove Mask
            </button>
          </div>
          {target.mask && (
            <>
              <label className="flex flex-col gap-1">
                <span className="flex justify-between text-muted-foreground">
                  <span>Density</span>
                  <span className="font-mono">{Math.round((target.mask.density ?? 1) * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  aria-label="Mask density"
                  value={Math.round((target.mask.density ?? 1) * 100)}
                  onChange={(e) => controller.setAdjustmentLayerMaskProps(target.id, { density: Number(e.target.value) / 100 })}
                  className={imageRangeClass}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="flex justify-between text-muted-foreground">
                  <span>Mask Feather</span>
                  <span className="font-mono">{target.mask.feather ?? 0}px</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={0.5}
                  aria-label="Mask feather"
                  value={target.mask.feather ?? 0}
                  onChange={(e) => controller.setAdjustmentLayerMaskProps(target.id, { feather: Number(e.target.value) })}
                  className={imageRangeClass}
                />
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
};
