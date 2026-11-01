import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPaintEffectsToolProvider, PAPER_EFFECT_BLENDS, type PaintEditorController, type PaintEffectsToolProviderOptions, type PaperEffectBlend } from '@pixerate/editor/paint-editor';
import type { EffectProvider } from '@pixerate/editor/effects';
import type { ToolRegistry } from '@pixerate/editor/tools';
import { EffectParameters, EffectsBrowser, useEffectDescription } from '../effects';
import { usePaintEditorState } from './usePaintEditor';
import { ErrorLine, button, panel, useAttempt } from './shared';

export interface PaintEffectsPanelProps {
  controller: PaintEditorController;
  className?: string;
}

/** The controller's effects provider, following `setEffectsProvider`. */
export function usePaintEffectsProvider(controller: PaintEditorController): EffectProvider | null {
  const [provider, setProvider] = useState(controller.effectsProvider);
  useEffect(() => {
    setProvider(controller.effectsProvider);
    return controller.effects.subscribe(setProvider);
  }, [controller]);
  return provider;
}

/** Registers the paint effect tools (`set_paper_effect`, `add_effect_layer`, `apply_effect`, …) while mounted. */
export function usePaintEffectsTools(registry: ToolRegistry | null | undefined, controller: PaintEditorController, options: PaintEffectsToolProviderOptions = {}): void {
  const { id, namespace, readOnly, playbackSurface } = options;
  useEffect(() => {
    if (!registry) return;
    return registry.register(createPaintEffectsToolProvider(controller, { id, namespace, readOnly, playbackSurface }));
  }, [registry, controller, id, namespace, readOnly, playbackSurface]);
}

/** One effect's controls from the provider; the first change of a drag records the undo step, later ones join it. */
function Controls({ provider, effect, name, values, apply }: { provider: EffectProvider | null; effect: string; name?: string; values: Readonly<Record<string, unknown>>; apply: (values: Record<string, unknown>, commit: boolean) => void }) {
  const { description, error } = useEffectDescription(provider, effect);
  const drags = useRef(new Set<string>());
  if (!provider) return <p className="text-[11px] text-slate-400">No effects provider: "{name ?? effect}" is kept as it was drawn.</p>;
  if (error) return <p className="text-[11px] text-amber-400">{error}</p>;
  if (!description) return <p className="text-[11px] text-slate-400">Loading…</p>;
  const commit = (gesture: string | null) => {
    if (!gesture || drags.current.has(gesture)) return !gesture;
    drags.current.add(gesture);
    return true;
  };
  return (
    <EffectParameters
      description={description}
      values={values}
      onChange={(k, v, gesture) => apply({ [k]: v }, commit(gesture))}
      onReset={(k) => apply({ [k]: null }, true)}
      onPreset={(v) => apply({ ...v }, true)}
    />
  );
}

type Browse = null | 'paper' | 'layer' | 'fill' | 'light' | 'paint';

const BROWSERS: Record<Exclude<Browse, null>, { uses: ('generator' | 'overlay' | 'title' | 'filter')[]; title: string }> = {
  paper: { uses: ['generator'], title: 'Effect paper' },
  layer: { uses: ['generator', 'overlay', 'title'], title: 'Effect layer' },
  fill: { uses: ['generator', 'overlay', 'title'], title: 'Fill the layer' },
  light: { uses: ['filter'], title: 'Light on the paint' },
  paint: { uses: ['generator', 'overlay', 'title'], title: 'Paint with an effect' },
};

/**
 * Provider effects in the paint editor: effect paper (a generator over the sheet, multiplied so
 * the grain shows), effect layers, effect fills, light baked onto the active layer's dried paint
 * and effect paint (brushes take their colours from the effect); plus the controls of the effect
 * paper, of an active effect layer and of the effect paint. Each change is one
 * undo step (a slider drag is one). Without a provider it says why nothing can be added.
 */
export const PaintEffectsPanel: React.FC<PaintEffectsPanelProps> = ({ controller, className }) => {
  const state = usePaintEditorState(controller);
  const provider = usePaintEffectsProvider(controller);
  const [error, attempt] = useAttempt();
  const [browse, setBrowse] = useState<Browse>(null);
  const [busy, setBusy] = useState(false);
  const paper = controller.getPaperEffect();
  const activeId = state.document.activeLayerId;
  const layerEffect = activeId ? controller.getEffectLayer(activeId) : undefined;
  const active = activeId ? controller.getLayer(activeId) : undefined;
  const effectPaint = state.effectPaint;
  const thumbnail = useMemo(() => (effectPaint && !state.effectPaintRendering ? controller.effectPaintThumbnail(48) : null), [controller, effectPaint, state.effectPaintRendering]);
  const run = (work: () => Promise<unknown>) =>
    attempt(() => {
      setBusy(true);
      return work().finally(() => setBusy(false));
    });
  const pick = (id: string) => {
    const kind = browse;
    setBrowse(null);
    if (kind === 'paper') run(() => controller.setPaperEffect(id));
    else if (kind === 'layer') run(() => controller.addEffectLayer(id));
    else if (kind === 'fill') run(() => controller.fillLayerWithEffect(id));
    else if (kind === 'light' && activeId) run(() => controller.applyLightEffect(activeId, id));
    else if (kind === 'paint') run(() => controller.setEffectPaint({ effect: id }));
  };
  const toggle = (b: Exclude<Browse, null>) => setBrowse(browse === b ? null : b);
  const pixel = active?.type === 'pixel';
  return (
    <div className={`${panel} ${className ?? ''}`} data-testid="paint-effects-panel" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="flex-1 font-medium text-slate-300">Effects</span>
        <button type="button" className={button} disabled={!provider} aria-pressed={browse === 'paper'} onClick={() => toggle('paper')}>
          Paper…
        </button>
        <button type="button" className={button} disabled={!provider} aria-pressed={browse === 'layer'} onClick={() => toggle('layer')}>
          Layer…
        </button>
        <button type="button" className={button} disabled={!provider || !pixel} aria-pressed={browse === 'fill'} onClick={() => toggle('fill')}>
          Fill…
        </button>
        <button type="button" className={button} disabled={!provider || !pixel} aria-pressed={browse === 'light'} onClick={() => toggle('light')} title="Bake a light, glow or grade into the active layer's dried paint">
          Light…
        </button>
        <button type="button" className={button} disabled={!provider} aria-pressed={browse === 'paint'} onClick={() => toggle('paint')} title="Paint with an effect: brushes take each pixel's colour from it">
          Paint…
        </button>
      </div>
      {!provider && <p className="text-[11px] text-slate-400">No effects provider is registered. Effects in the painting are kept.</p>}
      {browse && <EffectsBrowser provider={provider} uses={BROWSERS[browse].uses} title={BROWSERS[browse].title} onPick={(e) => pick(e.id)} />}
      {paper && (
        <div className="flex flex-col gap-1 rounded border border-slate-700 p-1" data-effect-part="paper">
          <div className="flex items-center gap-1">
            <span className="flex-1 truncate">Paper: {paper.name ?? paper.effect}</span>
            <button type="button" className={button} aria-label="Remove the effect paper" onClick={() => run(() => controller.setPaperEffect(null))}>
              ✕
            </button>
          </div>
          <label className="flex items-center gap-1">
            <span className="w-14 text-[11px] text-slate-400">Opacity</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              className="flex-1"
              aria-label="Effect paper opacity"
              defaultValue={paper.opacity}
              key={`o${paper.opacity}`}
              onPointerUp={(e) => {
                const opacity = Number(e.currentTarget.value);
                run(() => controller.updatePaperEffect({ opacity }));
              }}
              onKeyUp={(e) => {
                const opacity = Number(e.currentTarget.value);
                run(() => controller.updatePaperEffect({ opacity }));
              }}
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="w-14 text-[11px] text-slate-400">Blend</span>
            <select className="flex-1 rounded bg-slate-800 px-1 py-0.5 text-[11px]" aria-label="Effect paper blend" value={paper.blend} onChange={(e) => {
                const blend = e.currentTarget.value as PaperEffectBlend;
                run(() => controller.updatePaperEffect({ blend }));
              }}>
              {PAPER_EFFECT_BLENDS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <Controls provider={provider} effect={paper.effect} name={paper.name} values={paper.values} apply={(values, commit) => run(() => controller.updatePaperEffect({ values: values as never }, commit))} />
        </div>
      )}
      {effectPaint && (
        <div className="flex flex-col gap-1 rounded border border-slate-700 p-1" data-effect-part="paint">
          <div className="flex items-center gap-1">
            {thumbnail ? <img src={thumbnail} alt="" className="h-5 w-8 rounded object-cover ring-1 ring-slate-700" data-testid="effect-paint-thumbnail" /> : null}
            <span className="flex-1 truncate">
              Paint: {effectPaint.effect}
              {state.effectPaintRendering ? ' (rendering…)' : ''}
            </span>
            <button type="button" className={button} aria-label="Stop painting with the effect" onClick={() => attempt(() => controller.setColor(state.color))}>
              ✕
            </button>
          </div>
          <Controls provider={provider} effect={effectPaint.effect} values={effectPaint.values} apply={(values) => run(() => controller.setEffectPaint({ effect: effectPaint.effect, values: { ...effectPaint.values, ...values } as never, time: effectPaint.time }))} />
        </div>
      )}
      {layerEffect && activeId && (
        <div className="flex flex-col gap-1 rounded border border-slate-700 p-1" data-effect-part="layer">
          <div className="flex items-center gap-1">
            <span className="flex-1 truncate">Layer: {layerEffect.name ?? layerEffect.effect}</span>
            <button type="button" className={button} title="Keep the pixels as a plain layer" onClick={() => attempt(() => controller.rasterizeEffectLayer(activeId))}>
              Rasterize
            </button>
          </div>
          <Controls provider={provider} effect={layerEffect.effect} name={layerEffect.name} values={layerEffect.values} apply={(values, commit) => run(() => controller.updateEffectLayer(activeId, { values: values as never }, commit))} />
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
};
