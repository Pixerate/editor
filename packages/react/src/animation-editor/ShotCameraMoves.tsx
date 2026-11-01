import React, { useEffect, useState } from 'react';
import { motionShotCameraMove, type AnimationEditorController, type MotionCameraMoveResult } from '@pixerate/editor/animation-editor';
import type { CameraMoveRole, EffectSummary } from '@pixerate/editor/effects';
import { EffectParameters, useEffectDescription } from '../effects';
import { CommitInput } from './CommitInput';
import { useAnimationEditorState } from './useAnimationEditor';

export interface ShotCameraMovesProps {
  controller: AnimationEditorController;
  /** The shot whose moves to edit. */
  shot: string;
  className?: string;
}

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
const ROLES: { role: CameraMoveRole; label: string; none: string }[] = [
  { role: 'transition', label: 'Move in', none: 'ease in' },
  { role: 'hold', label: 'While holding', none: 'stay still' }
];

/** The provider's camera moves of each role, loaded when the provider changes. */
function useCameraMoves(controller: AnimationEditorController, provider: unknown): Record<CameraMoveRole, EffectSummary[]> {
  const [moves, setMoves] = useState<Record<CameraMoveRole, EffectSummary[]>>({ transition: [], hold: [] });
  useEffect(() => {
    let live = true;
    void Promise.all([controller.cameraMoves('transition'), controller.cameraMoves('hold')]).then(
      ([transition, hold]) => live && setMoves({ transition, hold }),
      () => live && setMoves({ transition: [], hold: [] }),
    );
    return () => {
      live = false;
    };
  }, [controller, provider]);
  return moves;
}

function MoveControls({ controller, shot, role }: { controller: AnimationEditorController; shot: string; role: CameraMoveRole }) {
  const state = useAnimationEditorState(controller);
  const move = motionShotCameraMove(state.scene.shots.find((s) => s.id === shot), role);
  const { description, error } = useEffectDescription(state.effectsProvider, move?.move);
  const [message, setMessage] = useState<string | null>(null);
  if (!move) return null;
  const report = (r: Promise<MotionCameraMoveResult>) => void r.then((x) => setMessage(x.ok ? null : x.error));
  // Changes over the move as saved; null removes a field (a changed value drops the preset's name).
  const set = (changes: { values?: Record<string, unknown>; preset?: string | null; ms?: number | null }, merge?: string | null) => {
    const next: Record<string, unknown> = { ...move, ...changes };
    for (const k of Object.keys(next)) if (next[k] === null || (k === 'values' && !Object.keys(next[k] as object).length)) delete next[k];
    report(controller.setShotCameraMove(shot, role, next as never, { merge: merge ?? undefined }));
  };
  if (error) return <p className="text-[11px] text-amber-500">{error}</p>;
  if (!description) return null;
  return (
    <div className="col-span-2 flex flex-col gap-1 border-l border-border pl-2" data-camera-move-controls={role}>
      {role === 'transition' && (
        <div className="flex items-center gap-1">
          <span className="w-16 text-muted-foreground">Length</span>
          <CommitInput
            className={input}
            type="number"
            min={0}
            step={50}
            aria-label="Move length"
            placeholder={String(description.camera?.durationMs ?? '')}
            value={move.ms !== undefined ? String(move.ms) : ''}
            onCommit={(raw) => (raw.trim() === '' ? set({ ms: null }) : Number.isFinite(Number(raw)) && Number(raw) >= 0 ? set({ ms: Number(raw) }) : setMessage('Length is a number of ms, 0 or more.'))}
          />
          <span className="text-[10px] text-muted-foreground">ms</span>
        </div>
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
 * A shot's camera moves from the effects provider: the move it gets in with and the move it
 * makes while it holds, each with its length (a move in), presets and controls. Hidden with the
 * reason when the provider has no camera moves. Every change is one undo step (a slider drag is one).
 */
export function ShotCameraMoves({ controller, shot, className = '' }: ShotCameraMovesProps) {
  const state = useAnimationEditorState(controller);
  const moves = useCameraMoves(controller, state.effectsProvider);
  const current = state.scene.shots.find((s) => s.id === shot);
  const [message, setMessage] = useState<string | null>(null);
  if (!current) return null;
  const has = moves.transition.length + moves.hold.length > 0;
  const named = current.camera?.in !== undefined || current.camera?.during !== undefined;
  if (!has)
    return named ? (
      <p className={`text-[10px] text-muted-foreground ${className}`} data-camera-moves="unavailable">
        This shot names camera moves, but {state.effectsProvider ? `${state.effectsProvider.name} has none` : 'no effects provider is set'}, so the camera eases instead.
      </p>
    ) : null;
  const report = (r: Promise<MotionCameraMoveResult> | MotionCameraMoveResult) => void Promise.resolve(r).then((x) => setMessage(x.ok ? null : x.error));
  return (
    <div className={`grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1 ${className}`} data-camera-moves="">
      {ROLES.map(({ role, label, none }) => {
        const move = motionShotCameraMove(current, role);
        const known = moves[role].some((m) => m.id === move?.move);
        return (
          <React.Fragment key={role}>
            <label className="text-muted-foreground">{label}</label>
            <select
              className={input}
              aria-label={label}
              disabled={state.readOnly}
              value={move?.move ?? ''}
              onChange={(e) => report(e.target.value ? controller.setShotCameraMove(current.id, role, e.target.value) : controller.clearShotCameraMove(current.id, role))}
            >
              <option value="">{none}</option>
              {move && !known && <option value={move.move}>{move.move} (not in the provider)</option>}
              {moves[role].map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            {move && known && !state.readOnly && <MoveControls controller={controller} shot={current.id} role={role} />}
          </React.Fragment>
        );
      })}
      {message && (
        <p className="col-span-2 text-[11px] text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
