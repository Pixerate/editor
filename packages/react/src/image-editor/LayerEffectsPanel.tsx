import React, { useEffect, useRef, useState } from 'react';
import type { EffectControl, ImageEditorController, LayerEffectKind } from '@pixerate/editor/image-editor';
import { LAYER_EFFECT_MENU, effectControlChange, layerEffectControls, layerEffectsPanel } from '@pixerate/editor/image-editor';
import { imageIconButtonClass, imageSelectClass } from './styles';
import { ImageCheckbox, ImageRange, ImageSelect } from './controls/controls.js';

export interface LayerEffectsPanelProps {
  controller: ImageEditorController;
  /** The layer whose effects to show (default: the active layer). */
  layerId?: string | null;
  className?: string;
}

/**
 * A layer's effects (Photoshop's layer styles): the master switch, Scale Effects, an "Add effect"
 * menu, and each effect with its enabled toggle, remove button and, when expanded, its settings.
 * Every change is one undo step (a slider drag is one step too).
 */
export const LayerEffectsPanel: React.FC<LayerEffectsPanelProps> = ({ controller, layerId, className }) => {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Whether the next slider change records an undo step (the first of a drag does, the rest replace it). */
  const commitNext = useRef(true);

  const layer = layerId ? controller.getLayer(layerId) : controller.getActiveLayer();
  const model = layerEffectsPanel(layer);
  const id = layer?.id;
  const attempt = (fn: () => unknown) => {
    try {
      setError(null);
      fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  if (!model.available || !id) {
    return (
      <div className={`text-xs text-muted-foreground ${className ?? ''}`} data-testid="layer-effects">
        {model.reason}
      </div>
    );
  }
  const effects = controller.getLayerEffects(id);
  const patterns = controller.getDocumentPatterns();
  const change = (effectId: string, control: EffectControl, value: unknown, drag = false) =>
    attempt(() => {
      const effect = controller.getLayerEffects(id).items.find((e) => e.id === effectId)!;
      controller.updateLayerEffect(id, effectId, effectControlChange(effect, control.key, value, patterns), drag ? commitNext.current : true);
      if (drag) commitNext.current = false;
    });

  const renderControl = (effectId: string, c: EffectControl) => {
    const label = `${c.label}`;
    switch (c.type) {
      case 'range': {
        const k = c.percent ? 100 : 1;
        const shown = Math.round(c.value * k * 100) / 100;
        return (
          <label key={c.key} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">
              {label} {shown}
              {c.unit}
            </span>
            <ImageRange
              label={label}
              min={c.min * k}
              max={c.max * k}
              step={c.step * k}
              value={shown}
              disabled={model.readOnly}
              onStart={() => (commitNext.current = true)}
              onEnd={() => (commitNext.current = true)}
              onChange={(v) => change(effectId, c, v / k, true)}
            />
          </label>
        );
      }
      case 'color':
        return (
          <label key={c.key} className="flex items-center gap-1.5 text-foreground">
            <input type="color" aria-label={label} value={c.value} disabled={model.readOnly} onChange={(e) => change(effectId, c, e.target.value)} />
            {label}
          </label>
        );
      case 'checkbox':
        return (
          <label key={c.key} className="flex items-center gap-1.5 text-foreground">
            <ImageCheckbox label={label} checked={c.value} disabled={model.readOnly} onChange={(on) => change(effectId, c, on)} />
            {label}
          </label>
        );
      case 'select':
        return (
          <label key={c.key} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{label}</span>
            <ImageSelect
              label={label}
              value={String(c.value)}
              disabled={model.readOnly}
              options={c.options.map((o) => ({ value: String(o.value), label: o.label }))}
              onChange={(v) => change(effectId, c, v)}
            />
          </label>
        );
    }
  };

  return (
    <div className={`flex flex-col gap-1.5 text-xs text-foreground ${className ?? ''}`} data-testid="layer-effects" aria-label="Layer effects" role="group">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">fx Effects</span>
        <label className="flex items-center gap-1 text-foreground">
          <ImageCheckbox label="Effects on" checked={model.enabled} disabled={model.readOnly} onChange={(on) => attempt(() => controller.setLayerEffectsEnabled(id, on))} />
          On
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          Scale
          <input
            type="number"
            aria-label="Scale effects"
            min={1}
            max={1000}
            step={1}
            value={Math.round(model.scale * 100)}
            disabled={model.readOnly}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v >= 1 && v <= 1000) attempt(() => controller.setLayerEffectsEnabled(id, model.enabled, v / 100));
            }}
            className="w-14 bg-muted border border-border rounded px-1"
          />
          %
        </label>
        <ImageSelect
          label="Add effect"
          value=""
          placeholder="Add effect…"
          disabled={model.readOnly}
          options={LAYER_EFFECT_MENU.map((m) => ({ value: m.kind, label: m.label }))}
          onChange={(v) => {
            const kind = v as LayerEffectKind;
            if (!kind) return;
            attempt(() => setOpen(controller.addLayerEffect(id, kind).effect.id));
          }}
        />
      </div>
      {model.readOnly && model.reason && <p className="text-muted-foreground">{model.reason}</p>}
      <ul className="flex flex-col gap-1" aria-label="Effects">
        {model.rows.map((row) => {
          const effect = effects.items.find((e) => e.id === row.id)!;
          const expanded = open === row.id;
          return (
            <li key={row.id} data-effect-id={row.id} className="rounded bg-background/60 ring-1 ring-border">
              <div className="flex items-center gap-1.5 px-1.5 py-1">
                <ImageCheckbox label={`${row.label} on`} checked={row.enabled} disabled={model.readOnly} onChange={(on) => attempt(() => controller.updateLayerEffect(id, row.id, { enabled: on }))} />
                <button
                  type="button"
                  aria-expanded={expanded}
                  className={`flex-1 text-left ${row.enabled && model.enabled ? '' : 'text-muted-foreground'}`}
                  onClick={() => setOpen(expanded ? null : row.id)}
                >
                  {row.label}
                </button>
                <button type="button" className={imageIconButtonClass} aria-label={`Remove ${row.label}`} disabled={model.readOnly} onClick={() => attempt(() => controller.removeLayerEffect(id, row.id))}>
                  ✕
                </button>
              </div>
              {expanded && (
                <div className="grid grid-cols-2 gap-x-2 gap-y-1 px-1.5 pb-1.5" data-testid="effect-settings">
                  {layerEffectControls(effect, patterns).map((c) => renderControl(row.id, c))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};
