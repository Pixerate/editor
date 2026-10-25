import React, { useEffect, useState } from 'react';
import { findLayer, type ImageEditorController, type ImageLayer, type SmartObjectLayer } from '@pixerate/editor/image-editor';
import { EffectsBrowser } from '../effects';
import { ImageEffectControls as Controls } from './ImageEffectControls';
import { imageOutlineButtonClass } from './styles';

export interface ImageProviderEffectsPanelProps {
  controller: ImageEditorController;
  className?: string;
}

/**
 * Provider effects in the image editor, for the active layer: its effect smart filters (apply,
 * turn on and off, opacity, reorder, change controls, remove) and, for an effect layer, its own
 * controls; plus adding effect layers. Applying a filter effect to a pixel layer converts it to a
 * smart object in the same undo step. Without a provider it says why nothing can be added.
 */
export function ImageProviderEffectsPanel({ controller, className = '' }: ImageProviderEffectsPanelProps) {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  const [browse, setBrowse] = useState<null | 'filter' | 'layer'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const provider = controller.effectsProvider;
  const state = controller.getState();
  const layer: ImageLayer | null = state.activeLayerId ? (findLayer(state.layers, state.activeLayerId)?.layer ?? null) : null;
  const run = (work: () => unknown) => {
    setMessage(null);
    Promise.resolve()
      .then(work)
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  };
  const drags = React.useRef(new Set<string>());
  /** Changes during a drag skip the undo stack; the last one (gesture ended) records one step. */
  const commit = (gesture: string | null) => {
    if (gesture) {
      if (!drags.current.has(gesture)) {
        drags.current.add(gesture);
        return true;
      }
      return false;
    }
    return true;
  };
  const filters = layer?.type === 'smart' ? ((layer as SmartObjectLayer).smartFilters?.filters ?? []).filter((f) => f.kind === 'effect') : [];
  const generator = layer?.type === 'pixel' ? layer.generator : undefined;
  const canFilter = !!layer && layer.type !== 'adjustment' && layer.type !== 'annotation';

  return (
    <section className={`flex flex-col gap-2 text-xs ${className}`} aria-label="Provider effects" data-image-provider-effects="">
      <div className="flex items-center gap-1">
        <span className="flex-1 font-semibold uppercase tracking-wider text-[11px] text-foreground">Effects</span>
        <button type="button" className={imageOutlineButtonClass} disabled={!provider || !canFilter} aria-pressed={browse === 'filter'} onClick={() => setBrowse(browse === 'filter' ? null : 'filter')}>
          Apply effect…
        </button>
        <button type="button" className={imageOutlineButtonClass} disabled={!provider} aria-pressed={browse === 'layer'} onClick={() => setBrowse(browse === 'layer' ? null : 'layer')}>
          Effect layer…
        </button>
      </div>
      {!provider && <p className="text-[11px] text-muted-foreground">No effects provider is registered. Effects in the document are kept.</p>}
      {browse === 'filter' && layer && (
        <EffectsBrowser provider={provider} uses={['filter']} title="Filters" onPick={(e) => (setBrowse(null), run(() => controller.applyEffectFilter(layer.id, e.id)))} />
      )}
      {browse === 'layer' && (
        <EffectsBrowser provider={provider} uses={['generator', 'overlay', 'title']} title="Generators and overlays" onPick={(e) => (setBrowse(null), run(() => controller.addEffectLayer(e.id)))} />
      )}
      {generator && layer && (
        <div className="space-y-1" data-effect-part="generator">
          <div className="flex items-center gap-1">
            <span className="flex-1 font-medium text-foreground">{generator.name ?? generator.effect}</span>
            <button type="button" className={imageOutlineButtonClass} title="Keep the pixels as a plain layer" onClick={() => run(() => controller.rasterizeEffectLayer(layer.id))}>
              Rasterize
            </button>
          </div>
          <Controls
            provider={provider}
            effect={generator.effect}
            name={generator.name}
            values={generator.values}
            onChange={(k, v, gesture) => run(() => controller.updateEffectLayer(layer.id, { values: { [k]: v as never } }, commit(gesture)))}
            onPreset={(values) => run(() => controller.updateEffectLayer(layer.id, { values: values as never }))}
          />
        </div>
      )}
      {filters.length > 0 && layer && (
        <ol className="space-y-1" data-effect-part="filters">
          {filters.map((f) => {
            const label = f.kind === 'effect' ? (f.name ?? f.effect) : f.kind;
            const all = (layer as SmartObjectLayer).smartFilters!.filters;
            const index = all.indexOf(f);
            if (f.kind !== 'effect') return null;
            return (
              <li key={f.id} className="rounded border border-border p-1" data-smart-effect={f.id}>
                <div className="flex items-center gap-1">
                  <input type="checkbox" checked={f.enabled} aria-label={`${label} on`} onChange={(e) => {
                      const enabled = e.currentTarget.checked;
                      run(() => controller.updateEffectFilter(layer.id, f.id, { enabled }));
                    }} />
                  <button type="button" className="min-w-0 flex-1 truncate text-left text-foreground" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
                    {label}
                  </button>
                  <button type="button" className={imageOutlineButtonClass} disabled={index === all.length - 1} aria-label="Move up" onClick={() => run(() => controller.updateEffectFilter(layer.id, f.id, { index: index + 1 }))}>
                    ↑
                  </button>
                  <button type="button" className={imageOutlineButtonClass} disabled={index === 0} aria-label="Move down" onClick={() => run(() => controller.updateEffectFilter(layer.id, f.id, { index: index - 1 }))}>
                    ↓
                  </button>
                  <button type="button" className={imageOutlineButtonClass} aria-label={`Remove ${label}`} onClick={() => run(() => controller.removeSmartFilter(layer.id, f.id))}>
                    ✕
                  </button>
                </div>
                {open === f.id && (
                  <div className="mt-1 space-y-2">
                    <label className="flex items-center gap-1">
                      <span className="w-14 text-[11px] text-foreground">Opacity</span>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        className="flex-1"
                        value={f.opacity}
                        aria-label={`${label} opacity`}
                        onChange={(e) => {
                          const opacity = Number(e.currentTarget.value);
                          run(() => controller.updateEffectFilter(layer.id, f.id, { opacity }));
                        }}
                      />
                    </label>
                    <Controls
                      provider={provider}
                      effect={f.effect}
                      name={f.name}
                      values={f.values}
                      onChange={(k, v, gesture) => run(() => controller.updateEffectFilter(layer.id, f.id, { values: { [k]: v as never } }, commit(gesture)))}
                      onPreset={(values) => run(() => controller.updateEffectFilter(layer.id, f.id, { values: values as never }))}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!layer && <p className="text-[11px] text-muted-foreground">Select a layer to apply effects to it.</p>}
      {message && (
        <p role="alert" className="text-[11px] text-destructive">
          {message}
        </p>
      )}
    </section>
  );
}
