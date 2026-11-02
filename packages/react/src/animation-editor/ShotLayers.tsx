import React, { useEffect, useState } from 'react';
import type { AnimationEditorController, MotionLayerSubject, MotionShotLayer, MotionShotLayerChanges, MotionShotLayerResult } from '@pixerate/editor/animation-editor';
import { EFFECT_LAYER_ROLES, effectLayerOffered, type EffectLayerRole, type EffectProvider, type EffectSummary } from '@pixerate/editor/effects';
import { EffectParameters, useEffectDescription } from '../effects';
import { CommitInput } from './CommitInput';
import { useAnimationEditorState } from './useAnimationEditor';

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
const button = 'rounded border border-border px-1 text-[11px] disabled:opacity-40';

/** The provider's effects that `keep` accepts, reloaded when the provider changes. */
function useEffectList(provider: EffectProvider | null, keep: (e: EffectSummary) => boolean): EffectSummary[] {
  const [list, setList] = useState<EffectSummary[]>([]);
  useEffect(() => {
    let live = true;
    if (!provider) return setList([]);
    void Promise.resolve(provider.list()).then(
      (all) => live && setList(all.filter(keep)),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);
  return list;
}

const isTransition = (e: EffectSummary) => e.uses.includes('transition') && e.kind !== 'camera';

/** A layer's subject in words, for its row. */
function subjectLabel(subject: MotionLayerSubject | undefined): string {
  if (!subject) return '';
  if ('slot' in subject) return `slot ${subject.slot}`;
  if ('text' in subject) return `“${subject.text}”`;
  return 'image' in subject ? 'picture' : 'SVG';
}

function SubjectField({ layer, disabled, onSet }: { layer: MotionShotLayer; disabled: boolean; onSet: (subject: MotionLayerSubject | null) => void }) {
  const s = layer.subject;
  const kind = !s ? '' : 'slot' in s ? 'slot' : 'text' in s ? 'text' : 'image' in s ? 'image' : 'svg';
  const value = !s ? '' : 'slot' in s ? s.slot : 'text' in s ? s.text : 'image' in s ? s.image : s.svg;
  return (
    <>
      <span className="text-muted-foreground">Subject</span>
      <div className="flex gap-1">
        <select
          className={`${input} w-20 flex-none`}
          aria-label="Subject kind"
          disabled={disabled}
          value={kind}
          onChange={(e) => {
            const k = e.target.value;
            onSet(k === '' ? null : k === 'slot' ? { slot: value || 'picture' } : k === 'text' ? { text: value || 'Title' } : k === 'image' ? { image: value || 'https://' } : { svg: value || '<svg xmlns="http://www.w3.org/2000/svg"/>' });
          }}
        >
          <option value="">none</option>
          <option value="image">picture</option>
          <option value="svg">SVG</option>
          <option value="text">words</option>
          <option value="slot">slot</option>
        </select>
        {kind && (
          <CommitInput
            className={input}
            aria-label={kind === 'image' ? 'Picture URL' : kind === 'svg' ? 'SVG markup' : kind === 'text' ? 'Words' : 'Slot name'}
            disabled={disabled}
            value={value}
            onCommit={(raw) => raw.trim() && onSet({ [kind]: raw } as MotionLayerSubject)}
          />
        )}
      </div>
    </>
  );
}

function LayerControls({ controller, layer, report }: { controller: AnimationEditorController; layer: MotionShotLayer; report: (r: Promise<MotionShotLayerResult>) => void }) {
  const state = useAnimationEditorState(controller);
  const { description, error } = useEffectDescription(state.effectsProvider, layer.effect);
  const set = (changes: MotionShotLayerChanges, merge?: string | null) => report(controller.updateShotLayer(layer.id, changes, { merge: merge ?? undefined }));
  const number = (raw: string, field: 'opacity' | 'fade', max: number) => {
    if (raw.trim() === '') return set({ [field]: null });
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= max) set({ [field]: n });
  };
  return (
    <div className="col-span-2 grid grid-cols-[4.5rem_1fr] items-center gap-x-2 gap-y-1 border-l border-border pl-2" data-shot-layer-controls={layer.id}>
      <span className="text-muted-foreground">Role</span>
      <select className={input} aria-label="Layer role" disabled={state.readOnly} value={layer.role ?? ''} onChange={(e) => set({ role: (e.target.value || null) as EffectLayerRole | null })}>
        <option value="">{layer.rect ? 'subject' : 'background'} (default)</option>
        {EFFECT_LAYER_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <SubjectField layer={layer} disabled={state.readOnly} onSet={(subject) => set({ subject })} />
      <span className="text-muted-foreground">Opacity</span>
      <CommitInput className={input} type="number" min={0} max={1} step={0.05} aria-label="Layer opacity" placeholder="1" disabled={state.readOnly} value={layer.opacity !== undefined ? String(layer.opacity) : ''} onCommit={(raw) => number(raw, 'opacity', 1)} />
      <span className="text-muted-foreground">Fade</span>
      <CommitInput className={input} type="number" min={0} step={50} aria-label="Layer fade (ms)" placeholder="0" disabled={state.readOnly} value={layer.fade !== undefined ? String(layer.fade) : ''} onCommit={(raw) => number(raw, 'fade', 60000)} />
      <span className="text-muted-foreground">Until</span>
      <select
        className={input}
        aria-label="Layer lasts until"
        disabled={state.readOnly}
        value={typeof layer.until === 'object' ? String(layer.until.shots) : layer.until === undefined ? '1' : 'ms'}
        onChange={(e) => set({ until: e.target.value === '1' ? null : { shots: Number(e.target.value) } })}
      >
        <option value="1">the next shot</option>
        <option value="2">the shot after next</option>
        <option value="3">three shots on</option>
        {typeof layer.until === 'number' && <option value="ms">{layer.until} ms</option>}
      </select>
      {error && <p className="col-span-2 text-[11px] text-amber-500">{error}</p>}
      {description && !state.readOnly && (
        <div className="col-span-2">
          <EffectParameters
            description={description}
            values={layer.values ?? {}}
            onChange={(k, v, gesture) => set({ values: { ...(layer.values ?? {}), [k]: v as never }, preset: null }, gesture)}
            onReset={(k) => {
              const { [k]: _gone, ...rest } = layer.values ?? {};
              set({ values: Object.keys(rest).length ? rest : null, preset: null });
            }}
            onPresetName={(name) => set({ preset: name, values: null })}
          />
        </div>
      )}
    </div>
  );
}

export interface ShotLayersProps {
  controller: AnimationEditorController;
  /** The shot whose layers to edit. */
  shot: string;
  className?: string;
}

/**
 * A shot's layers: provider effects (backgrounds, filters, overlays, titles) and bare pictures or
 * words shown with the shot, bottom to top, with their role, subject, opacity, fade, length and
 * controls. Add one from the provider's layer effects or as a picture or words; restack or remove
 * it. Every change is one undo step (a slider drag is one).
 */
export function ShotLayers({ controller, shot, className = '' }: ShotLayersProps) {
  const state = useAnimationEditorState(controller);
  const effects = useEffectList(state.effectsProvider, effectLayerOffered);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const current = state.scene.shots.find((s) => s.id === shot);
  if (!current) return null;
  const layers = current.layers ?? [];
  const report = (r: Promise<MotionShotLayerResult>) =>
    void r.then((x) => {
      setMessage(x.ok ? null : x.error);
      if (x.ok && x.layer) setOpen(x.layer.id);
    });
  const add = (value: string) => {
    if (!value) return;
    if (value === ':picture') return report(controller.addShotLayer(shot, { subject: { slot: 'picture' } }));
    if (value === ':words') return report(controller.addShotLayer(shot, { subject: { text: 'Title' }, role: 'overlay' }));
    const e = effects.find((x) => x.id === value);
    const needsSubject = e?.uses.includes('filter');
    report(controller.addShotLayer(shot, { effect: value, ...(needsSubject ? { subject: { slot: 'picture' } } : {}) }));
  };
  if (!layers.length && !effects.length && state.readOnly) return null;
  return (
    <div className={`grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1 ${className}`} data-shot-layers="">
      <span className="text-muted-foreground">Layers</span>
      <select className={input} aria-label="Add a layer" disabled={state.readOnly} value="" onChange={(e) => add(e.target.value)}>
        <option value="">add a layer…</option>
        <option value=":picture">Picture</option>
        <option value=":words">Words</option>
        {effects.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name} ({e.uses.filter((u) => u !== 'interactive').join(', ')})
          </option>
        ))}
      </select>
      {layers
        .map((layer, i) => ({ layer, i }))
        .reverse()
        .map(({ layer, i }) => (
          <React.Fragment key={layer.id}>
            <button type="button" className="truncate text-left text-xs" aria-expanded={open === layer.id} onClick={() => setOpen(open === layer.id ? null : layer.id)} data-shot-layer={layer.id}>
              {layer.name ?? (layer.effect ? layer.effect : 'Picture')}
            </button>
            <div className="flex items-center gap-1">
              <span className="flex-1 truncate text-[10px] text-muted-foreground">
                {layer.role ?? (layer.rect ? 'subject' : 'background')} {subjectLabel(layer.subject)}
              </span>
              <button type="button" className={button} aria-label={`Move ${layer.id} up`} disabled={state.readOnly || i === layers.length - 1} onClick={() => report(controller.moveShotLayer(layer.id, i + 1))}>
                ↑
              </button>
              <button type="button" className={button} aria-label={`Move ${layer.id} down`} disabled={state.readOnly || i === 0} onClick={() => report(controller.moveShotLayer(layer.id, i - 1))}>
                ↓
              </button>
              <button type="button" className={button} aria-label={`Remove ${layer.id}`} disabled={state.readOnly} onClick={() => report(controller.removeShotLayer(layer.id))}>
                ×
              </button>
            </div>
            {open === layer.id && <LayerControls controller={controller} layer={layer} report={report} />}
          </React.Fragment>
        ))}
      {!state.effectsProvider && layers.some((l) => l.effect) && <p className="col-span-2 text-[10px] text-muted-foreground">No effects provider is set, so effect layers are not drawn.</p>}
      {message && (
        <p className="col-span-2 text-[11px] text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

export interface ShotTransitionProps {
  controller: AnimationEditorController;
  /** The shot the transition leads into (not the first shot). */
  shot: string;
  className?: string;
}

/**
 * The provider transition into a shot from the one before: pick it, set its length, preset and
 * controls, or clear it. Hidden on the first shot. Every change is one undo step.
 */
export function ShotTransition({ controller, shot, className = '' }: ShotTransitionProps) {
  const state = useAnimationEditorState(controller);
  const transitions = useEffectList(state.effectsProvider, isTransition);
  const index = state.scene.shots.findIndex((s) => s.id === shot);
  const current = state.scene.shots[index];
  const transition = current?.transition;
  const { description } = useEffectDescription(state.effectsProvider, transition?.effect);
  const [message, setMessage] = useState<string | null>(null);
  if (!current || index === 0 || (!transitions.length && !transition)) return null;
  const report = (r: Promise<MotionShotLayerResult> | MotionShotLayerResult) => void Promise.resolve(r).then((x) => setMessage(x.ok ? null : x.error));
  const set = (changes: { ms?: number; values?: Record<string, unknown> | null; preset?: string | null; effect?: string }, merge?: string | null) => {
    const next: Record<string, unknown> = { ...transition, ...changes };
    for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
    report(controller.setShotTransition(shot, next as never, { merge: merge ?? undefined }));
  };
  const known = transitions.some((t) => t.id === transition?.effect);
  return (
    <div className={`grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1 ${className}`} data-shot-transition="">
      <label className="text-muted-foreground">Transition in</label>
      <select className={input} aria-label="Transition in" disabled={state.readOnly} value={transition?.effect ?? ''} onChange={(e) => (e.target.value ? report(controller.setShotTransition(shot, { effect: e.target.value, ...(transition?.ms ? { ms: transition.ms } : {}) })) : report(controller.clearShotTransition(shot)))}>
        <option value="">cut</option>
        {transition && !known && <option value={transition.effect}>{transition.name ?? transition.effect} (not in the provider)</option>}
        {transitions.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {transition && known && !state.readOnly && (
        <div className="col-span-2 flex flex-col gap-1 border-l border-border pl-2" data-shot-transition-controls="">
          <div className="flex items-center gap-1">
            <span className="w-16 text-muted-foreground">Length</span>
            <CommitInput className={input} type="number" min={1} step={50} aria-label="Transition length" value={String(transition.ms ?? '')} onCommit={(raw) => (Number(raw) > 0 ? set({ ms: Number(raw) }) : setMessage('Length is a number of ms above 0.'))} />
            <span className="text-[10px] text-muted-foreground">ms</span>
          </div>
          {description && (
            <EffectParameters
              description={description}
              values={transition.values ?? {}}
              onChange={(k, v, gesture) => set({ values: { ...(transition.values ?? {}), [k]: v }, preset: null }, gesture)}
              onReset={(k) => {
                const { [k]: _gone, ...rest } = transition.values ?? {};
                set({ values: Object.keys(rest).length ? rest : null, preset: null });
              }}
              onPresetName={(name) => set({ preset: name, values: null })}
            />
          )}
        </div>
      )}
      {message && (
        <p className="col-span-2 text-[11px] text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
