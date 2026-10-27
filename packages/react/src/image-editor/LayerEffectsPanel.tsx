import React, { useEffect, useRef, useState } from 'react';
import type { EffectControl, ImageEditorController, LayerEffectKind } from '@pixerate/editor/image-editor';
import { LAYER_EFFECT_MENU, effectControlChange, layerEffectControls, layerEffectsPanel } from '@pixerate/editor/image-editor';
import { imageIconButtonClass, imageSelectClass } from './styles';

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
  const sliderEvents = {
    onPointerDown: () => (commitNext.current = true),
    onPointerUp: () => (commitNext.current = true),
    onKeyDown: () => (commitNext.current = true),
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
            <input
              type="range"
              aria-label={label}
              min={c.min * k}
              max={c.max * k}
              step={c.step * k}
              value={shown}
              disabled={model.readOnly}
              {...sliderEvents}
              onChange={(e) => change(effectId, c, Number(e.target.value) / k, true)}
              className="accent-primary"
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
            <input type="checkbox" aria-label={label} checked={c.value} disabled={model.readOnly} onChange={(e) => change(effectId, c, e.target.checked)} className="accent-primary" />
            {label}
          </label>
        );
      case 'select':
        return (
          <label key={c.key} className="flex flex-col gap-0.5">
            <span className="text-muted-foreground">{label}</span>
            <select
              aria-label={label}
              value={c.value}
              disabled={model.readOnly}
              onChange={(e) => change(effectId, c, e.target.value)}
              className={imageSelectClass}
            >
              {c.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        );
    }
  };

  return (
    <div className={`flex flex-col gap-1.5 text-xs text-foreground ${className ?? ''}`} data-testid="layer-effects" aria-label="Layer effects" role="group">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">fx Effects</span>
        <label className="flex items-center gap-1 text-foreground">
          <input
            type="checkbox"
            aria-label="Effects on"
            checked={model.enabled}
            disabled={model.readOnly}
            onChange={(e) => attempt(() => controller.setLayerEffectsEnabled(id, e.target.checked))}
            className="accent-primary"
          />
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
        <select
          aria-label="Add effect"
          value=""
          disabled={model.readOnly}
          onChange={(e) => {
            const kind = e.target.value as LayerEffectKind;
            if (!kind) return;
            attempt(() => setOpen(controller.addLayerEffect(id, kind).effect.id));
          }}
          className={imageSelectClass}
        >
          <option value="">Add effect…</option>
          {LAYER_EFFECT_MENU.map((m) => (
            <option key={m.kind} value={m.kind}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {model.readOnly && model.reason && <p className="text-muted-foreground">{model.reason}</p>}
      <ul className="flex flex-col gap-1" aria-label="Effects">
        {model.rows.map((row) => {
          const effect = effects.items.find((e) => e.id === row.id)!;
          const expanded = open === row.id;
          return (
            <li key={row.id} data-effect-id={row.id} className="rounded bg-background/60 ring-1 ring-border">
              <div className="flex items-center gap-1.5 px-1.5 py-1">
                <input
                  type="checkbox"
                  aria-label={`${row.label} on`}
                  checked={row.enabled}
                  disabled={model.readOnly}
                  onChange={(e) => attempt(() => controller.updateLayerEffect(id, row.id, { enabled: e.target.checked }))}
                  className="accent-primary"
                />
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
