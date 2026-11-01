import React, { useMemo, useState } from 'react';
import { describeMotionElements, freshShotId, motionCameraFramed, motionCueChoices, motionCueFromKey, motionCueKey, type AnimationEditorController, type MotionEdit } from '@pixerate/editor/animation-editor';
import { CommitInput } from './CommitInput';
import { ShotCameraMoves } from './ShotCameraMoves';
import { useAnimationEditorState } from './useAnimationEditor';

export interface ShotInspectorProps {
  controller: AnimationEditorController;
  /** The shot to edit (default: the selected shot, else the first). */
  shot?: string;
  className?: string;
}

const input = 'w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-xs';
const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';


/**
 * The selected shot: its label, hold, speed, the node the camera frames, the cue it starts
 * on (a beat of the scene's grid or a narration word) and its camera moves (`ShotCameraMoves`). Also adds, moves and deletes shots.
 * Every change is one undo step.
 */
export function ShotInspector({ controller, shot, className = '' }: ShotInspectorProps) {
  const state = useAnimationEditorState(controller);
  const { scene, selection, readOnly, error } = state;
  const [local, setLocalState] = useState<{ text: string; revision: number } | null>(null);
  const setLocal = (text: string | null) => setLocalState(text ? { text, revision: state.revision } : null);
  const elements = useMemo(() => describeMotionElements(scene), [scene.artwork]);
  const cues = useMemo(() => motionCueChoices(scene), [scene]);
  const id = shot ?? selection?.shot ?? scene.shots[0]?.id;
  const index = scene.shots.findIndex((s) => s.id === id);
  const current = scene.shots[index];
  const apply = (edit: MotionEdit | MotionEdit[], label: string) => {
    setLocal(null);
    return controller.apply(edit, label);
  };
  const addShot = () => {
    const newId = freshShotId(scene, 'shot');
    const at = index >= 0 ? index + 1 : scene.shots.length;
    if (apply({ op: 'insert_shots', shots: [{ id: newId, label: 'New shot', run: [] }], at }, 'Add shot').ok) {
      controller.select({ shot: newId });
      controller.seekShot(newId);
    }
  };
  const number = (key: 'hold' | 'speed', raw: string, label: string) => {
    const n = Number(raw);
    if (raw.trim() === '') return apply({ op: 'update_shot', shot: current.id, remove: [key] }, label);
    if (!Number.isFinite(n) || n < 0 || (key === 'speed' && n <= 0)) return setLocal(key === 'speed' ? 'Speed must be a number above 0 (1 = as written).' : 'Hold must be a number of ms, 0 or more.');
    apply({ op: 'update_shot', shot: current.id, set: { [key]: n } }, label);
  };
  // A local error shows until the editor changes; then the editor's own error (if any) shows.
  const message = (local && local.revision === state.revision ? local.text : null) ?? error;
  const cueKey = current ? motionCueKey(current.at) : '';
  const frame = current?.camera && 'frame' in current.camera ? current.camera.frame : '';

  return (
    <div className={`flex flex-col gap-1.5 text-xs ${className}`} data-shot-inspector="">
      <div className="flex items-center gap-1">
        <span className="font-medium">Shot</span>
        {current && <code className="text-[10px] text-muted-foreground">{current.id}</code>}
        <span className="ml-auto flex gap-0.5">
          <button type="button" className={btn} disabled={readOnly} onClick={addShot} data-add-shot="">
            + Shot
          </button>
          {current && (
            <>
              <button type="button" className={btn} aria-label="Move shot earlier" disabled={readOnly || index === 0} onClick={() => apply({ op: 'move_shot', shot: current.id, to: index - 1 }, 'Move shot')}>
                ←
              </button>
              <button type="button" className={btn} aria-label="Move shot later" disabled={readOnly || index === scene.shots.length - 1} onClick={() => apply({ op: 'move_shot', shot: current.id, to: index + 1 }, 'Move shot')}>
                →
              </button>
              <button type="button" className={btn} aria-label="Delete shot" disabled={readOnly} onClick={() => apply({ op: 'delete_shots', shots: [current.id] }, 'Delete shot')}>
                ✕
              </button>
            </>
          )}
        </span>
      </div>
      {current && (
        <div className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
          <label className="text-muted-foreground">Label</label>
          <CommitInput className={input} aria-label="Shot label" disabled={readOnly} value={current.label ?? ''} onCommit={(raw) => apply(raw.trim() ? { op: 'update_shot', shot: current.id, set: { label: raw.trim() } } : { op: 'update_shot', shot: current.id, remove: ['label'] }, 'Rename shot')} />
          <label className="text-muted-foreground">Hold</label>
          <div className="flex items-center gap-1">
            <CommitInput className={input} type="number" min={0} step={50} aria-label="Hold" placeholder="600" disabled={readOnly} value={current.hold !== undefined ? String(current.hold) : ''} onCommit={(raw) => number('hold', raw, 'Change hold')} />
            <span className="text-[10px] text-muted-foreground">ms</span>
          </div>
          <label className="text-muted-foreground">Speed</label>
          <div className="flex items-center gap-1">
            <CommitInput className={input} type="number" min={0.05} step={0.05} aria-label="Speed" placeholder="1" disabled={readOnly} value={current.speed !== undefined ? String(current.speed) : ''} onCommit={(raw) => number('speed', raw, 'Change speed')} />
            <span className="text-[10px] text-muted-foreground">×</span>
          </div>
          <label className="text-muted-foreground">Camera</label>
          <select
            className={input}
            aria-label="Camera frames"
            disabled={readOnly}
            value={current.camera && motionCameraFramed(current.camera) ? (frame ? `frame:${frame}` : 'rect') : ''}
            onChange={(e) => {
              const v = e.target.value;
              // Its camera moves stay when the framing changes.
              const moves = { ...(current.camera?.in !== undefined ? { in: current.camera.in } : {}), ...(current.camera?.during !== undefined ? { during: current.camera.during } : {}) };
              if (!v) apply(Object.keys(moves).length ? { op: 'update_shot', shot: current.id, set: { camera: moves } } : { op: 'update_shot', shot: current.id, remove: ['camera'] }, 'Clear camera');
              else if (v.startsWith('frame:')) apply({ op: 'update_shot', shot: current.id, set: { camera: { ...moves, frame: v.slice(6), padding: 24 } } }, 'Frame camera');
            }}
          >
            <option value="">keep framing</option>
            {current.camera && motionCameraFramed(current.camera) && !frame && <option value="rect">a rectangle</option>}
            {elements.map((e) => (
              <option key={e.id} value={`frame:${e.id}`}>
                frame {e.name ?? e.id}
              </option>
            ))}
          </select>
          <label className="text-muted-foreground">Starts on</label>
          <select
            className={input}
            aria-label="Cue"
            disabled={readOnly || index === 0}
            value={cueKey}
            onChange={(e) => {
              const cue = motionCueFromKey(e.target.value);
              apply(cue ? { op: 'update_shot', shot: current.id, set: { at: cue } } : { op: 'update_shot', shot: current.id, remove: ['at'] }, 'Cue shot');
            }}
          >
            <option value="">after the shot before</option>
            {cueKey && !cues.some((c) => c.value === cueKey) && <option value={cueKey}>{cueKey}</option>}
            {cues.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          {!cues.length && index > 0 && <p className="col-span-2 text-[10px] text-muted-foreground">Add a beat grid or narration in the scene settings to cue shots to them.</p>}
        </div>
      )}
      {current && <ShotCameraMoves controller={controller} shot={current.id} />}
      {message && (
        <p className="text-red-500" role="alert" data-edit-error="">
          {message}
        </p>
      )}
    </div>
  );
}
