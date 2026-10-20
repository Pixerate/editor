import React, { useState } from 'react';
import {
  findVideoClip,
  isVideoKeyframes,
  type VideoClip,
  type VideoEditorController,
  type VideoEffectEditResult,
  type VideoEffectValues,
} from '@pixerate/editor/video-editor';
import type { EffectProvider } from '@pixerate/editor/effects';
import { EffectParameters, EffectsBrowser, useEffectDescription } from '../effects';
import { useVideoEditorState } from './useVideoEditor';

export interface VideoEffectsPanelProps {
  controller: VideoEditorController;
  className?: string;
}

const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';
const keyedOf = (values: VideoEffectValues | undefined) => new Set(Object.entries(values ?? {}).filter(([, v]) => isVideoKeyframes(v)).map(([k]) => k));

/** One effect's controls, loaded from the provider; a note when the provider does not have it. */
function EffectControls({
  provider,
  effect,
  name,
  values,
  disabled,
  onChange,
  onPreset,
}: {
  provider: EffectProvider | null;
  effect: string;
  name?: string;
  values: VideoEffectValues | undefined;
  disabled: boolean;
  onChange: (control: string, value: unknown, gesture: string | null) => void;
  onPreset: (values: Readonly<Record<string, unknown>>) => void;
}) {
  const { description, error } = useEffectDescription(provider, effect);
  if (!provider) return <p className="text-[11px] text-muted-foreground">No effects provider: "{name ?? effect}" is kept and shown as a placeholder.</p>;
  if (error) return <p className="text-[11px] text-amber-500">{error}</p>;
  if (!description) return <p className="text-[11px] text-muted-foreground">Loading…</p>;
  return <EffectParameters description={description} values={values ?? {}} keyframed={keyedOf(values)} disabled={disabled} onChange={onChange} onReset={(k) => onChange(k, description.defaults[k], null)} onPreset={onPreset} />;
}

/**
 * Provider effects for the selected clip: its effect stack (add, turn on and off, reorder, change
 * controls, remove), its effect transition, and an effect clip's own controls; plus adding effect
 * clips at the playhead. Every change is one undo step (a slider drag is one). Without a provider it
 * lists what the project holds and says why nothing can be added.
 */
export function VideoEffectsPanel({ controller, className = '' }: VideoEffectsPanelProps) {
  const state = useVideoEditorState(controller);
  const provider = state.effectsProvider;
  const [browse, setBrowse] = useState<null | 'clip' | 'transition' | 'generator'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const selected = state.selection[0];
  const at = selected ? findVideoClip(state.project, selected) : null;
  const clip: VideoClip | null = at?.clip ?? null;
  const disabled = state.readOnly;
  const report = (r: VideoEffectEditResult | Promise<VideoEffectEditResult>) =>
    void Promise.resolve(r).then((x) => setMessage(x.ok ? null : x.error));

  const addEffectClip = (effect: string) => {
    const track = at && at.track.kind === 'video' ? at.track.id : state.project.tracks.find((t) => t.kind === 'video')?.id;
    if (!track) return setMessage('Add a video track first.');
    report(controller.addEffectClip(track, effect, { start: Math.round(state.time), mode: 'overwrite' }).then((r) => (r.ok && r.clip && controller.select([r.clip]), r)));
  };

  return (
    <section className={`flex flex-col gap-2 rounded-md border border-border p-2 text-xs ${className}`} aria-label="Effects" data-video-effects="">
      <div className="flex items-center gap-1">
        <h3 className="flex-1 font-semibold">Effects</h3>
        <button type="button" className={btn} disabled={disabled || !provider} onClick={() => setBrowse(browse === 'generator' ? null : 'generator')} aria-pressed={browse === 'generator'}>
          Add effect clip
        </button>
      </div>
      {!provider && <p className="text-[11px] text-muted-foreground">No effects provider is registered. Effects in the project are kept and drawn as placeholders.</p>}
      {browse === 'generator' && (
        <EffectsBrowser provider={provider} uses={['generator', 'title', 'overlay']} title="Generators and titles" onPick={(e) => (setBrowse(null), addEffectClip(e.id))} />
      )}
      {!clip && <p className="text-[11px] text-muted-foreground">Select a clip to see its effects.</p>}
      {clip && (
        <>
          {clip.type === 'effect' && (
            <div className="space-y-1" data-effect-part="generator">
              <div className="font-medium">{clip.name ?? clip.effect}</div>
              <EffectControls
                provider={provider}
                effect={clip.effect}
                name={clip.name}
                values={clip.values}
                disabled={disabled}
                onChange={(k, v, gesture) => report(controller.updateEffectValues(clip.id, 'generator', { [k]: v } as VideoEffectValues, { merge: gesture ?? undefined }))}
                onPreset={(values) => report(controller.updateEffectValues(clip.id, 'generator', values as VideoEffectValues))}
              />
            </div>
          )}
          <div className="space-y-1" data-effect-part="transition">
            <div className="flex items-center gap-1">
              <span className="flex-1 font-medium">Transition in</span>
              {clip.transition?.type === 'effect' ? (
                <button type="button" className={btn} disabled={disabled} onClick={() => report(controller.apply({ op: 'set_transition', clip: clip.id, transition: null }, 'Remove transition') as VideoEffectEditResult)}>
                  Remove
                </button>
              ) : (
                <button type="button" className={btn} disabled={disabled || !provider} aria-pressed={browse === 'transition'} onClick={() => setBrowse(browse === 'transition' ? null : 'transition')}>
                  Effect transition…
                </button>
              )}
            </div>
            {browse === 'transition' && (
              <EffectsBrowser provider={provider} uses={['transition']} title="Transitions" onPick={(e) => (setBrowse(null), report(controller.setEffectTransition(clip.id, e.id)))} />
            )}
            {clip.transition?.type === 'effect' && clip.transition.effect && (
              <EffectControls
                provider={provider}
                effect={clip.transition.effect.effect}
                name={clip.transition.effect.name}
                values={clip.transition.effect.values}
                disabled={disabled}
                onChange={(k, v, gesture) => report(controller.updateEffectValues(clip.id, 'transition', { [k]: v } as VideoEffectValues, { merge: gesture ?? undefined }))}
                onPreset={(values) => report(controller.updateEffectValues(clip.id, 'transition', values as VideoEffectValues))}
              />
            )}
          </div>
          <div className="space-y-1" data-effect-part="stack">
            <div className="flex items-center gap-1">
              <span className="flex-1 font-medium">On this clip</span>
              <button type="button" className={btn} disabled={disabled || !provider} aria-pressed={browse === 'clip'} onClick={() => setBrowse(browse === 'clip' ? null : 'clip')}>
                Add effect…
              </button>
            </div>
            {browse === 'clip' && (
              <EffectsBrowser provider={provider} uses={['filter', 'overlay']} title="Filters and overlays" onPick={(e) => (setBrowse(null), report(controller.applyClipEffect(clip.id, e.id)))} />
            )}
            <ol className="space-y-1">
              {(clip.effects ?? []).map((e, i, all) => (
                <li key={e.id} className="rounded border border-border p-1" data-clip-effect={e.id}>
                  <div className="flex items-center gap-1">
                    <input type="checkbox" checked={e.enabled !== false} disabled={disabled} aria-label={`${e.name ?? e.effect} on`} onChange={(ev) => report(controller.updateClipEffect(clip.id, e.id, { enabled: ev.currentTarget.checked }))} />
                    <button type="button" className="min-w-0 flex-1 truncate text-left" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                      {e.name ?? e.effect}
                    </button>
                    <button type="button" className={btn} disabled={disabled || i === 0} aria-label="Move up" onClick={() => report(controller.updateClipEffect(clip.id, e.id, { index: i - 1 }))}>
                      ↑
                    </button>
                    <button type="button" className={btn} disabled={disabled || i === all.length - 1} aria-label="Move down" onClick={() => report(controller.updateClipEffect(clip.id, e.id, { index: i + 1 }))}>
                      ↓
                    </button>
                    <button type="button" className={btn} disabled={disabled} aria-label={`Remove ${e.name ?? e.effect}`} onClick={() => report(controller.removeClipEffect(clip.id, e.id))}>
                      ✕
                    </button>
                  </div>
                  {open === e.id && (
                    <div className="mt-1 space-y-2">
                      <label className="flex items-center gap-1">
                        <span className="w-14 text-[11px]">Opacity</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          className="flex-1"
                          disabled={disabled || isVideoKeyframes(e.opacity)}
                          value={typeof e.opacity === 'number' ? e.opacity : 1}
                          aria-label={`${e.name ?? e.effect} opacity`}
                          onChange={(ev) => report(controller.updateClipEffect(clip.id, e.id, { opacity: Number(ev.currentTarget.value) }, { merge: `opacity:${clip.id}:${e.id}` }))}
                        />
                      </label>
                      <EffectControls
                        provider={provider}
                        effect={e.effect}
                        name={e.name}
                        values={e.values}
                        disabled={disabled}
                        onChange={(k, v, gesture) => report(controller.updateClipEffect(clip.id, e.id, { values: { [k]: v as never } }, { merge: gesture ?? undefined }))}
                        onPreset={(values) => report(controller.updateClipEffect(clip.id, e.id, { values: values as never }))}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ol>
            {!clip.effects?.length && <p className="text-[11px] text-muted-foreground">No effects on this clip.</p>}
          </div>
        </>
      )}
      {message && (
        <p role="alert" className="text-[11px] text-destructive">
          {message}
        </p>
      )}
    </section>
  );
}
