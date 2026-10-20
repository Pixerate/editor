import React, { useState, useSyncExternalStore } from 'react';
import type { VectorEditorController, VectorGroupNode } from '@pixerate/editor/vector';
import { EffectParameters, EffectsBrowser, useEffectDescription } from '../effects';
import { useVectorEditorState } from './useVectorEditor';

export interface VectorProviderEffectsPanelProps {
  controller: VectorEditorController;
  className?: string;
}

const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

function Controls({ controller, group }: { controller: VectorEditorController; group: VectorGroupNode }) {
  const provider = controller.effectsProvider;
  const tag = group.providerEffect!;
  const { description, error } = useEffectDescription(provider, tag.effect);
  const [message, setMessage] = useState<string | null>(null);
  const run = (work: Promise<unknown>) => void work.then(() => setMessage(null), (e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  if (!provider) return <p className="text-[11px] text-muted-foreground">No effects provider: the shapes are kept as they are.</p>;
  if (error) return <p className="text-[11px] text-amber-500">{error}</p>;
  if (!description) return <p className="text-[11px] text-muted-foreground">Loading…</p>;
  return (
    <>
      <EffectParameters
        description={description}
        values={tag.values}
        onChange={(k, v) => run(controller.updateVectorEffect(group.id, { [k]: v as never }))}
        onReset={(k) => run(controller.updateVectorEffect(group.id, { [k]: null }))}
        onPreset={(v) => run(controller.updateVectorEffect(group.id, v as never))}
      />
      {message && <p role="alert" className="text-[11px] text-destructive">{message}</p>}
    </>
  );
}

/**
 * Provider vector effects in a drawing: add one (its picture at rest becomes a selected group of
 * editable shapes), draw it again with new values, or detach it to keep the shapes. Motion is
 * applied in the animation editor.
 */
export function VectorProviderEffectsPanel({ controller, className = '' }: VectorProviderEffectsPanelProps) {
  const state = useVectorEditorState(controller);
  const provider = useSyncExternalStore(
    (cb) => controller.effects.subscribe(cb),
    () => controller.effects.provider,
    () => controller.effects.provider,
  );
  const [browse, setBrowse] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  void state;
  const groups = controller.vectorEffectGroups();
  const selected = groups.filter((g) => state.selection.includes(g.id));
  const run = (work: () => unknown) => {
    setMessage(null);
    Promise.resolve().then(work).catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section className={`flex flex-col gap-2 text-xs ${className}`} aria-label="Vector effects" data-vector-provider-effects="">
      <div className="flex items-center gap-1">
        <span className="flex-1 font-semibold">Effects</span>
        <button type="button" className={btn} disabled={!provider} aria-pressed={browse} onClick={() => setBrowse(!browse)}>
          Add effect…
        </button>
      </div>
      {!provider && <p className="text-[11px] text-muted-foreground">No effects provider is registered. Effect groups are kept as shapes.</p>}
      {browse && <EffectsBrowser provider={provider} kinds={['vector']} title="Vector effects" onPick={(e) => (setBrowse(false), run(() => controller.addVectorEffect(e.id)))} />}
      {selected.map((g) => (
        <div key={g.id} className="space-y-1 rounded border border-border p-1" data-vector-effect-group={g.id}>
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate font-medium">{g.providerEffect!.name ?? g.providerEffect!.effect}</span>
            <button type="button" className={btn} title="Keep the shapes as a plain group" onClick={() => run(() => controller.detachVectorEffect(g.id))}>
              Detach
            </button>
          </div>
          <Controls controller={controller} group={g} />
        </div>
      ))}
      {groups.length > 0 && !selected.length && <p className="text-[11px] text-muted-foreground">Select an effect group ({groups.length} in the drawing) to change it.</p>}
      {message && <p role="alert" className="text-[11px] text-destructive">{message}</p>}
    </section>
  );
}
