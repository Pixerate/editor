import React, { useEffect, useState } from 'react';
import { findVideoClip, videoClipCameraMove, type VideoCameraMoveResult, type VideoEditorController } from '@pixerate/editor/video-editor';
import type { CameraMoveRole, EffectSummary } from '@pixerate/editor/effects';
import { EffectParameters, useEffectDescription } from '../effects';
import { useVideoEditorState } from './useVideoEditor';

export interface ClipCameraMovesProps {
  controller: VideoEditorController;
  /** The clip whose moves to edit. */
  clip: string;
  className?: string;
}

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
const ROLES: { role: CameraMoveRole; label: string; none: string }[] = [
  { role: 'transition', label: 'Move in', none: 'none' },
  { role: 'hold', label: 'While holding', none: 'none' },
];

function MoveControls({ controller, clip, role }: { controller: VideoEditorController; clip: string; role: CameraMoveRole }) {
  const state = useVideoEditorState(controller);
  const move = videoClipCameraMove(findVideoClip(state.project, clip)?.clip, role);
  const { description, error } = useEffectDescription(state.effectsProvider, move?.move);
  const [message, setMessage] = useState<string | null>(null);
  if (!move) return null;
  const report = (r: Promise<VideoCameraMoveResult>) => void r.then((x) => setMessage(x.ok ? null : x.error));
  // Changes over the move as saved; null removes a field (a changed value drops the preset's name).
  const set = (changes: { values?: Record<string, unknown>; preset?: string | null; ms?: number | null }, merge?: string | null) => {
    const next: Record<string, unknown> = { ...move, ...changes };
    for (const k of Object.keys(next)) if (next[k] === null || (k === 'values' && !Object.keys(next[k] as object).length)) delete next[k];
    report(controller.setClipCameraMove(clip, role, next as never, { merge: merge ?? undefined }));
  };
  if (error) return <p className="text-[11px] text-amber-500">{error}</p>;
  if (!description) return null;
  return (
    <div className="flex flex-col gap-1 border-l border-border pl-2" data-camera-move-controls={role}>
      {role === 'transition' && (
        <label className="flex items-center gap-1 text-xs">
          <span className="w-16 text-muted-foreground">Length</span>
          <input
            key={String(move.ms)}
            className={input}
            type="number"
            min={0}
            step={50}
            aria-label="Move length"
            defaultValue={move.ms ?? ''}
            placeholder={String(description.camera?.durationMs ?? '')}
            onBlur={(e) => {
              const raw = e.currentTarget.value.trim();
              if (raw === String(move.ms ?? '')) return;
              if (raw === '') set({ ms: null });
              else if (Number.isFinite(Number(raw)) && Number(raw) >= 0) set({ ms: Number(raw) });
              else setMessage('Length is a number of ms, 0 or more.');
            }}
          />
          <span className="text-[10px] text-muted-foreground">ms</span>
        </label>
      )}
      <EffectParameters
        description={description}
        values={move.values ?? {}}
        onChange={(k, v, gesture) => set({ values: { ...(move.values ?? {}), [k]: v }, preset: null }, gesture)}
        onReset={(k) => {
          const { [k]: _gone, ...rest } = move.values ?? {};
          set({ values: rest, preset: null });
        }}
        onPresetName={(name) => set({ preset: name, values: {} })}
      />
      {message && <p role="alert" className="text-[11px] text-destructive">{message}</p>}
    </div>
  );
}

/**
 * A clip's camera moves from the effects provider: the move into the clip and the move across
 * the rest of it, with the zoom they frame, a move in's length, presets and controls. The moves
 * are baked into the clip's transform keys. Hidden with the reason when the provider has no
 * camera moves. Every change is one undo step (a slider drag is one).
 */
export function ClipCameraMoves({ controller, clip, className = '' }: ClipCameraMovesProps) {
  const state = useVideoEditorState(controller);
  const [moves, setMoves] = useState<Record<CameraMoveRole, EffectSummary[]>>({ transition: [], hold: [] });
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([controller.cameraMoves('transition'), controller.cameraMoves('hold')]).then(
      ([transition, hold]) => live && setMoves({ transition, hold }),
      () => live && setMoves({ transition: [], hold: [] }),
    );
    return () => {
      live = false;
    };
  }, [controller, state.effectsProvider]);
  const at = findVideoClip(state.project, clip);
  if (!at || at.track.kind === 'audio' || at.clip.type === 'adjustment') return null;
  const current = at.clip;
  if (!moves.transition.length && !moves.hold.length)
    return current.camera ? (
      <p className={`text-[10px] text-muted-foreground ${className}`} data-camera-moves="unavailable">
        This clip's camera moves are baked into its keys; {state.effectsProvider ? `${state.effectsProvider.name} has no camera moves` : 'no effects provider is set'}, so they cannot be changed here.
      </p>
    ) : null;
  const report = (r: Promise<VideoCameraMoveResult>) => void r.then((x) => setMessage(x.ok ? null : x.error));
  const disabled = state.readOnly || !!at.track.locked;
  return (
    <div className={`flex flex-col gap-1 text-xs ${className}`} data-camera-moves="">
      {ROLES.map(({ role, label, none }) => {
        const move = videoClipCameraMove(current, role);
        const known = moves[role].some((m) => m.id === move?.move);
        return (
          <React.Fragment key={role}>
            <label className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
              <span className="text-muted-foreground">{label}</span>
              <select
                className={input}
                aria-label={label}
                disabled={disabled}
                value={move?.move ?? ''}
                onChange={(e) => report(e.target.value ? controller.setClipCameraMove(clip, role, e.target.value) : controller.clearClipCameraMove(clip, role))}
              >
                <option value="">{none}</option>
                {move && !known && <option value={move.move}>{move.move} (not in the provider)</option>}
                {moves[role].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            {move && known && !disabled && <MoveControls controller={controller} clip={clip} role={role} />}
          </React.Fragment>
        );
      })}
      {current.camera && !disabled && (
        <label className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
          <span className="text-muted-foreground">Camera zoom</span>
          <input
            key={String(current.camera.framing?.zoom)}
            className={input}
            type="number"
            min={0.1}
            step={0.1}
            aria-label="Camera zoom"
            placeholder="1"
            defaultValue={current.camera.framing?.zoom ?? ''}
            onBlur={(e) => {
              const raw = e.currentTarget.value.trim();
              const zoom = Number(raw);
              if (raw === String(current.camera?.framing?.zoom ?? '')) return;
              const role: CameraMoveRole = current.camera?.in !== undefined ? 'transition' : 'hold';
              const spec = videoClipCameraMove(current, role)!;
              if (raw !== '' && !(zoom > 0)) return setMessage('Zoom is a number above 0 (1 shows the whole picture).');
              report(controller.setClipCameraMove(clip, role, spec, { framing: raw === '' ? null : { ...current.camera?.framing, zoom } }));
            }}
          />
        </label>
      )}
      {message && (
        <p className="text-[11px] text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
