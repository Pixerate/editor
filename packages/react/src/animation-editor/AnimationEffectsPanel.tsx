import React, { useMemo, useState } from 'react';
import { indexMotionNodes, type AnimationEditorController, type MotionEffectResult } from '@pixerate/editor/animation-editor';
import { EffectParameters, EffectsBrowser, useEffectDescription } from '../effects';
import { useAnimationEditorState } from './useAnimationEditor';

export interface AnimationEffectsPanelProps {
  controller: AnimationEditorController;
  /** The node motion effects are applied to (e.g. the element picked on the stage). */
  node?: string | null;
  className?: string;
}

const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

function Controls({ controller, instance, effect, values }: { controller: AnimationEditorController; instance: string; effect: string; values: Readonly<Record<string, unknown>> }) {
  const provider = controller.effectsProvider;
  const { description, error } = useEffectDescription(provider, effect);
  const [message, setMessage] = useState<string | null>(null);
  const report = (r: Promise<MotionEffectResult>) => void r.then((x) => setMessage(x.ok ? null : x.error));
  if (!provider) return <p className="text-[11px] text-muted-foreground">No effects provider: its commands are kept as they are.</p>;
  if (error) return <p className="text-[11px] text-amber-500">{error}</p>;
  if (!description) return <p className="text-[11px] text-muted-foreground">Loading…</p>;
  return (
    <>
      <EffectParameters
        description={description}
        values={values}
        onChange={(k, v, gesture) => report(controller.updateMotionEffect(instance, { [k]: v as never }, { merge: gesture ?? undefined }))}
        onReset={(k) => report(controller.updateMotionEffect(instance, { [k]: null }))}
        onPreset={(v) => report(controller.updateMotionEffect(instance, v as never))}
      />
      {message && <p role="alert" className="text-[11px] text-destructive">{message}</p>}
    </>
  );
}

/**
 * Provider effects in an animation: apply a motion effect to a node (its changes become commands
 * in a new shot), add a vector effect with its own picture, and change or remove the effects the
 * scene holds. Every change is one undo step (a slider drag is one).
 */
export function AnimationEffectsPanel({ controller, node, className = '' }: AnimationEffectsPanelProps) {
  const state = useAnimationEditorState(controller);
  const provider = state.effectsProvider;
  const nodes = useMemo(() => [...indexMotionNodes(state.scene.artwork.nodes).keys()], [state.scene.artwork]);
  const [chosen, setChosen] = useState<string>('');
  const target = node && nodes.includes(node) ? node : chosen && nodes.includes(chosen) ? chosen : '';
  const [browse, setBrowse] = useState<null | 'motion' | 'vector'>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const report = (r: MotionEffectResult | Promise<MotionEffectResult>) => void Promise.resolve(r).then((x) => setMessage(x.ok ? (x.notes.length ? x.notes.join(' ') : null) : x.error));
  const applied = useMemo(() => controller.appliedEffects(), [controller, state.scene]);
  const disabled = state.readOnly;
  return (
    <section className={`flex flex-col gap-2 text-xs ${className}`} aria-label="Effects" data-animation-effects="">
      <div className="flex flex-wrap items-center gap-1">
        <span className="flex-1 font-semibold">Effects</span>
        <select className="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]" aria-label="Node to animate" value={target} disabled={!!node} onChange={(e) => setChosen(e.currentTarget.value)}>
          <option value="">Node…</option>
          {nodes.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button type="button" className={btn} disabled={disabled || !provider || !target} aria-pressed={browse === 'motion'} onClick={() => setBrowse(browse === 'motion' ? null : 'motion')}>
          Animate…
        </button>
        <button type="button" className={btn} disabled={disabled || !provider} aria-pressed={browse === 'vector'} onClick={() => setBrowse(browse === 'vector' ? null : 'vector')}>
          Vector effect…
        </button>
      </div>
      {!provider && <p className="text-[11px] text-muted-foreground">No effects provider is registered. Commands effects made are kept.</p>}
      {browse === 'motion' && (
        <EffectsBrowser provider={provider} uses={['motion']} kinds={['motion']} title={`Motion for ${target}`} onPick={(e) => (setBrowse(null), report(controller.applyMotionEffect(e.id, [target])))} />
      )}
      {browse === 'vector' && <EffectsBrowser provider={provider} kinds={['vector']} title="Vector effects" onPick={(e) => (setBrowse(null), report(controller.addVectorEffect(e.id)))} />}
      <ol className="space-y-1">
        {applied.map((e) => (
          <li key={e.instance} className="rounded border border-border p-1" data-motion-effect={e.instance}>
            <div className="flex items-center gap-1">
              <button type="button" className="min-w-0 flex-1 truncate text-left" aria-expanded={open === e.instance} onClick={() => setOpen(open === e.instance ? null : e.instance)}>
                {e.name ?? e.effect} <span className="text-muted-foreground">· {e.kind === 'vector' ? 'picture' : e.targets.join(', ')}</span>
              </button>
              <button type="button" className={btn} disabled={disabled} aria-label={`Remove ${e.name ?? e.effect}`} onClick={() => report(controller.removeMotionEffect(e.instance))}>
                ✕
              </button>
            </div>
            {open === e.instance && <div className="mt-1"><Controls controller={controller} instance={e.instance} effect={e.effect} values={e.values} /></div>}
          </li>
        ))}
      </ol>
      {!applied.length && <p className="text-[11px] text-muted-foreground">No provider effects in this scene.</p>}
      {message && <p role="status" className="text-[11px] text-muted-foreground" data-effects-message="">{message}</p>}
    </section>
  );
}
