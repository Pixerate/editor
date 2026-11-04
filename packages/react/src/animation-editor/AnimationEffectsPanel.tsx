import React, { useMemo, useState } from 'react';
import { indexMotionNodes, type AnimationEditorController, type MotionEffectResult } from '@pixerate/editor/animation-editor';
import { pathControlsOf } from '@pixerate/editor/effects';
import { EffectParameters, EffectsBrowser, EffectTemplates, useEffectDescription } from '../effects';
import { useAnimationEditorState } from './useAnimationEditor';

export interface AnimationEffectsPanelProps {
  controller: AnimationEditorController;
  /** The node motion effects are applied to (e.g. the element picked on the stage). */
  node?: string | null;
  className?: string;
}

const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

function Controls({
  controller,
  instance,
  effect,
  values,
  pathNodes,
  defaultPathNode,
  disabled,
}: {
  controller: AnimationEditorController;
  instance: string;
  effect: string;
  values: Readonly<Record<string, unknown>>;
  pathNodes: readonly string[];
  defaultPathNode: string;
  disabled: boolean;
}) {
  const provider = controller.effectsProvider;
  const { description, error } = useEffectDescription(provider, effect);
  const [message, setMessage] = useState<string | null>(null);
  const [pathNode, setPathNode] = useState('');
  const [words, setWords] = useState('');
  const report = (r: Promise<MotionEffectResult>) => void r.then((x) => setMessage(x.ok ? null : x.error));
  if (!provider) return <p className="text-[11px] text-muted-foreground">No effects provider: its commands are kept as they are.</p>;
  if (error) return <p className="text-[11px] text-amber-500">{error}</p>;
  if (!description) return <p className="text-[11px] text-muted-foreground">Loading…</p>;
  const pathControls = pathControlsOf(description);
  const chosenPathNode = pathNode && pathNodes.includes(pathNode) ? pathNode : defaultPathNode && pathNodes.includes(defaultPathNode) ? defaultPathNode : pathNodes[0] ?? '';
  return (
    <>
      {pathControls.length > 0 && (
        <div className="mb-1 flex flex-wrap items-center gap-1" data-effect-part="path">
          <span className="text-muted-foreground">Path</span>
          <select
            className="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]"
            aria-label="Path node"
            value={chosenPathNode}
            disabled={disabled || !pathNodes.length}
            onChange={(e) => setPathNode(e.currentTarget.value)}
          >
            <option value="">Path node…</option>
            {pathNodes.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={btn}
            disabled={disabled || !chosenPathNode}
            onClick={() => report(controller.setVectorEffectPath(instance, { node: chosenPathNode }))}
          >
            Use path node
          </button>
          {provider.pathFromText && (
            <>
              <input
                className="w-24 rounded border border-border bg-transparent px-1 py-0.5"
                aria-label="Words to write along the path"
                placeholder="Words"
                value={words}
                disabled={disabled}
                onChange={(e) => setWords(e.currentTarget.value)}
              />
              <button
                type="button"
                className={btn}
                disabled={disabled || !words.trim()}
                onClick={() => report(controller.setVectorEffectPath(instance, { text: words }))}
              >
                Write
              </button>
            </>
          )}
          <button
            type="button"
            className={btn}
            disabled={disabled}
            onClick={() => report(controller.updateMotionEffect(instance, { [pathControls[0]]: '' }))}
          >
            Clear path
          </button>
        </div>
      )}
      <EffectParameters
        description={description}
        values={values}
        disabled={disabled}
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
  const applied = useMemo(() => controller.appliedEffects(), [controller, state.scene]);
  const nodes = useMemo(() => [...indexMotionNodes(state.scene.artwork.nodes).keys()], [state.scene.artwork]);
  const pathNodes = useMemo(() => {
    const vectorGroups = new Set(applied.filter((e) => e.kind === 'vector').map((e) => e.instance));
    const own = state.scene.artwork.nodes.filter((n) => !vectorGroups.has(n.id));
    return [...indexMotionNodes(own).values()].filter((e) => e.node.type === 'path').map((e) => e.node.id);
  }, [state.scene.artwork, applied]);
  const [chosen, setChosen] = useState<string>('');
  const target = node && nodes.includes(node) ? node : chosen && nodes.includes(chosen) ? chosen : '';
  const [browse, setBrowse] = useState<null | 'motion' | 'vector'>(null);
  const [vectorPathNode, setVectorPathNode] = useState<string>('');
  const [vectorWords, setVectorWords] = useState<string>('');
  const activeVectorPathNode = vectorPathNode && pathNodes.includes(vectorPathNode) ? vectorPathNode : '';
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const report = (r: MotionEffectResult | Promise<MotionEffectResult>) => void Promise.resolve(r).then((x) => setMessage(x.ok ? (x.notes.length ? x.notes.join(' ') : null) : x.error));
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
      <EffectTemplates provider={provider} disabled={disabled} fillLabel="New scene from template" onFill={(t, v) => controller.fillTemplate(t, v).then((r) => (r.ok && r.notes.length && setMessage(r.notes.join(' ')), r))} />
      {browse === 'vector' && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1" data-effect-part="vector-path">
            <span className="text-muted-foreground">Path</span>
            <select
              className="rounded border border-border bg-transparent px-1 py-0.5 text-[11px]"
              aria-label="Path node for vector effect"
              value={activeVectorPathNode}
              disabled={disabled || !pathNodes.length}
              onChange={(e) => setVectorPathNode(e.currentTarget.value)}
            >
              <option value="">Default path</option>
              {pathNodes.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            {provider?.pathFromText && (
              <input
                className="w-24 rounded border border-border bg-transparent px-1 py-0.5"
                aria-label="Words for vector effect path"
                placeholder="Words"
                value={vectorWords}
                disabled={disabled}
                onChange={(e) => setVectorWords(e.currentTarget.value)}
              />
            )}
          </div>
          <EffectsBrowser
            provider={provider}
            kinds={['vector']}
            title="Vector effects"
            onPick={(e) => {
              setBrowse(null);
              const path = e.accepts?.includes('path')
                ? vectorWords.trim()
                  ? { text: vectorWords }
                  : activeVectorPathNode
                    ? { node: activeVectorPathNode }
                    : undefined
                : undefined;
              report(controller.addVectorEffect(e.id, path ? { path } : undefined));
            }}
          />
        </div>
      )}
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
            {open === e.instance && (
              <div className="mt-1">
                <Controls controller={controller} instance={e.instance} effect={e.effect} values={e.values} pathNodes={pathNodes} defaultPathNode={target} disabled={disabled} />
              </div>
            )}
          </li>
        ))}
      </ol>
      {!applied.length && <p className="text-[11px] text-muted-foreground">No provider effects in this scene.</p>}
      {message && <p role="status" className="text-[11px] text-muted-foreground" data-effects-message="">{message}</p>}
    </section>
  );
}
