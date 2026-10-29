import React, { useEffect, useRef, useState } from 'react';
import { EFFECT_LAYER_USES, LAYER_EFFECT_MENU, effectLayerTiming, findLayer, layerEffectsPanel, type ImageEditorController, type ImageLayer, type LayerEffectKind, type SmartObjectLayer } from '@pixerate/editor/image-editor';
import { EffectsBrowser, useEffectDescription } from '../effects';
import { ImageEffectControls as Controls } from './ImageEffectControls';
import { LayerEffectsPanel } from './LayerEffectsPanel';
import { imageOutlineButtonClass } from './styles';
import { ImageCheckbox, ImageRange, ImageSelect } from './controls/controls.js';
import type { ParameterComponents } from '../parameters/index.js';

export interface ImageProviderEffectsPanelProps {
  controller: ImageEditorController;
  className?: string;
  /** Host controls for the effects' parameters. */
  components?: ParameterComponents;
}

const fmt = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;

/**
 * Effects for the active layer, in one place. An effect layer first: its effect (change it or
 * rasterize it), a still frame or an animation for an effect that moves, and its controls. Then
 * what is applied to any layer: provider filters (smart filters; applying one converts a pixel
 * layer to a smart object in the same undo step) and layer styles, added from one menu. New
 * effect layers come from the layers panel. Without a provider it says why nothing can be added.
 */
export function ImageProviderEffectsPanel({ controller, className = '', components }: ImageProviderEffectsPanelProps) {
  const [, setTick] = useState(0);
  useEffect(() => controller.subscribe(() => setTick((n) => n + 1)), [controller]);
  /** The open effect browser: filters to apply, or effects to change an effect layer to. */
  const [browse, setBrowse] = useState<null | 'filter' | 'change'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [scrubbed, setScrubbed] = useState<number | null>(null);
  const provider = controller.effectsProvider;
  const state = controller.getState();
  const layer: ImageLayer | null = state.activeLayerId ? (findLayer(state.layers, state.activeLayerId)?.layer ?? null) : null;
  const run = (work: () => unknown) => {
    setMessage(null);
    Promise.resolve()
      .then(work)
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  };
  const drags = useRef(new Set<string>());
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
  const styles = layerEffectsPanel(layer);
  const { description } = useEffectDescription(provider, generator?.effect);
  const timing = generator ? effectLayerTiming(generator, description) : null;
  const addOptions = [
    ...(provider && canFilter ? [{ value: 'filter', label: 'Filter…' }] : []),
    ...(styles.available && !styles.readOnly ? LAYER_EFFECT_MENU.map((m) => ({ value: `style:${m.kind}`, label: m.label })) : []),
  ];
  const add = (value: string) => {
    if (!value || !layer) return;
    if (value === 'filter') setBrowse(browse === 'filter' ? null : 'filter');
    else run(() => controller.addLayerEffect(layer.id, value.slice('style:'.length) as LayerEffectKind));
  };

  // Scrubbing the frame draws the effect again: one render at a time, the latest frame wins.
  const scrub = useRef<{ next: { layerId: string; time: number; commit: boolean } | null; busy: boolean; gesture: string | null }>({ next: null, busy: false, gesture: null });
  const scrubTo = (layerId: string, time: number) => {
    const s = scrub.current;
    setScrubbed(time);
    s.next = { layerId, time, commit: commit(s.gesture) };
    if (s.busy) return;
    s.busy = true;
    const step = (): Promise<void> => {
      const n = s.next;
      s.next = null;
      if (!n) return Promise.resolve();
      return controller.updateEffectLayer(n.layerId, { time: n.time }, n.commit).then(step);
    };
    step()
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        s.busy = false;
        setScrubbed(null);
      });
  };
  const shown = scrubbed ?? timing?.time ?? 0;

  return (
    <section className={`flex flex-col gap-2 text-xs ${className}`} aria-label="Effects" data-image-provider-effects="">
      {!provider && <p className="text-[11px] text-muted-foreground">No effects provider is registered. Effects in the document are kept.</p>}
      {generator && layer && (
        <div className="space-y-2" data-effect-part="generator">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={generator.name ?? generator.effect}>
              {generator.name ?? generator.effect}
            </span>
            <button type="button" className={imageOutlineButtonClass} disabled={!provider} aria-pressed={browse === 'change'} onClick={() => setBrowse(browse === 'change' ? null : 'change')}>
              Change…
            </button>
            <button type="button" className={imageOutlineButtonClass} title="Keep the pixels as a plain layer" onClick={() => run(() => controller.rasterizeEffectLayer(layer.id))}>
              Rasterize
            </button>
          </div>
          {browse === 'change' && (
            <EffectsBrowser provider={provider} uses={EFFECT_LAYER_USES} title="Change the effect to" onPick={(e) => (setBrowse(null), run(() => controller.updateEffectLayer(layer.id, { effect: e.id })))} />
          )}
          {timing && (
            <div className="space-y-1.5 rounded border border-border p-1.5" data-effect-part="timing" role="group" aria-label="Frames">
              <div className="flex gap-1" role="radiogroup" aria-label="Output">
                <button
                  type="button"
                  role="radio"
                  aria-checked={timing.mode === 'still'}
                  className={`${imageOutlineButtonClass} flex-1 ${timing.mode === 'still' ? 'bg-accent text-accent-foreground' : ''}`}
                  onClick={() => run(() => controller.updateEffectLayer(layer.id, { animate: null }))}
                >
                  Still frame
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={timing.mode === 'animate'}
                  className={`${imageOutlineButtonClass} flex-1 ${timing.mode === 'animate' ? 'bg-accent text-accent-foreground' : ''}`}
                  onClick={() => run(() => controller.updateEffectLayer(layer.id, { animate: { duration: timing.duration } }))}
                >
                  Animate
                </button>
              </div>
              <label className="flex items-center gap-1.5">
                <span className="w-16 shrink-0 text-[11px] text-foreground">{timing.mode === 'still' ? 'Frame' : 'Starts at'}</span>
                <ImageRange
                  min={0}
                  max={timing.range}
                  step={Math.max(1, Math.round(timing.range / 200))}
                  className="flex-1"
                  value={shown}
                  label={timing.mode === 'still' ? 'Frame' : 'Starts at'}
                  onStart={() => (scrub.current.gesture = `time:${Date.now()}`)}
                  onEnd={() => (scrub.current.gesture = null)}
                  onChange={(t) => scrubTo(layer.id, t)}
                />
                <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{fmt(shown)}</span>
              </label>
              {timing.mode === 'animate' && (
                <label className="flex items-center gap-1.5">
                  <span className="w-16 shrink-0 text-[11px] text-foreground">Length</span>
                  <input
                    type="number"
                    aria-label="Animation length in seconds"
                    min={0.1}
                    max={60}
                    step={0.1}
                    defaultValue={Math.round(timing.duration / 100) / 10}
                    key={timing.duration}
                    className="w-16 rounded border border-border bg-muted px-1 text-foreground"
                    onBlur={(e) => {
                      const s = Number(e.currentTarget.value);
                      if (s > 0 && s * 1000 !== timing.duration) run(() => controller.updateEffectLayer(layer.id, { animate: { duration: Math.min(60, s) * 1000 } }));
                    }}
                  />
                  <span className="text-muted-foreground">s{timing.loops ? ` · loops every ${fmt(timing.range)}` : ''}</span>
                </label>
              )}
            </div>
          )}
          <Controls
            provider={provider}
            effect={generator.effect}
            name={generator.name}
            values={generator.values}
            components={components}
            onChange={(k, v, gesture) => run(() => controller.updateEffectLayer(layer.id, { values: { [k]: v as never } }, commit(gesture)))}
            onPreset={(values) => run(() => controller.updateEffectLayer(layer.id, { values: values as never }))}
          />
        </div>
      )}
      {layer && canFilter && (
        <div className="flex items-center gap-1" data-effect-part="applied">
          <span className="flex-1 font-semibold uppercase tracking-wider text-[11px] text-foreground">{generator ? 'On this layer' : 'Effects'}</span>
          {addOptions.length > 0 && <ImageSelect label="Add effect" value="" placeholder="Add…" options={addOptions} onChange={add} />}
        </div>
      )}
      {browse === 'filter' && layer && (
        <EffectsBrowser provider={provider} uses={['filter']} title="Filters" onPick={(e) => (setBrowse(null), run(() => controller.applyEffectFilter(layer.id, e.id)))} />
      )}
      {filters.length > 0 && layer && (
        <ol className="space-y-1" data-effect-part="filters" aria-label="Filters">
          {filters.map((f) => {
            const label = f.kind === 'effect' ? (f.name ?? f.effect) : f.kind;
            const all = (layer as SmartObjectLayer).smartFilters!.filters;
            const index = all.indexOf(f);
            if (f.kind !== 'effect') return null;
            return (
              <li key={f.id} className="rounded border border-border p-1" data-smart-effect={f.id}>
                <div className="flex items-center gap-1">
                  <ImageCheckbox
                    checked={f.enabled}
                    label={`${label} on`}
                    onChange={(enabled) => run(() => controller.updateEffectFilter(layer.id, f.id, { enabled }))}
                  />
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
                      <ImageRange
                        min={0}
                        max={1}
                        step={0.01}
                        className="flex-1"
                        value={f.opacity}
                        label={`${label} opacity`}
                        onChange={(opacity) => run(() => controller.updateEffectFilter(layer.id, f.id, { opacity }))}
                      />
                    </label>
                    <Controls
                      provider={provider}
                      effect={f.effect}
                      name={f.name}
                      values={f.values}
                      components={components}
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
      {layer && styles.available && styles.rows.length > 0 && <LayerEffectsPanel controller={controller} layerId={layer.id} heading={false} />}
      {layer && canFilter && !generator && filters.length === 0 && styles.rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No effects yet. Add a filter, or a style such as a drop shadow. New effect layers are added from the layers panel.</p>
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
