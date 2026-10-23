import React from 'react';
import { MOTION_RECORD_GESTURE_MODES, type AnimationEditorController, type MotionRecordGestureMode } from '@pixerate/editor/animation-editor';
import { useAnimationEditorState } from './useAnimationEditor';

export interface AnimationRecordPanelProps {
  controller: AnimationEditorController;
  /** The element the paint and opacity controls record (e.g. the one picked on the stage). */
  node?: string | null;
  /** What a stage drag does while recording (pass the same to `<AnimationStage recordMode>`). */
  mode: MotionRecordGestureMode;
  onModeChange: (mode: MotionRecordGestureMode) => void;
  className?: string;
}

const btn = 'rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40';
const MODE_LABELS: Record<MotionRecordGestureMode, string> = { move: 'Move', scale: 'Scale', rotate: 'Rotate' };
const hex6 = (c: string | undefined) => (c && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toLowerCase() : '#000000');

/**
 * Record a take: Record plays on from the end of the scene while you drag elements on the stage
 * (moving, scaling or turning them, as `mode` says) and change the picked element's paint and
 * opacity; Stop keeps the performance as a new shot of ordinary commands, one undo step.
 */
export function AnimationRecordPanel({ controller, node, mode, onModeChange, className = '' }: AnimationRecordPanelProps) {
  const state = useAnimationEditorState(controller);
  const { recording, readOnly, error } = state;
  const pose = recording && node ? controller.pose(node) : null;
  const sample = (values: Parameters<AnimationEditorController['recordSample']>[1]) => node && controller.recordSample(node, values);
  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${className}`} data-animation-record="">
      {recording ? (
        <>
          <button type="button" className={`${btn} border-red-500 text-red-600`} onClick={() => controller.stopRecording()} data-record-stop="">
            ■ Stop
          </button>
          <button type="button" className={btn} onClick={() => controller.cancelRecording()} data-record-cancel="">
            Cancel
          </button>
          <button type="button" className={btn} onClick={() => controller.toggle()}>
            {state.playing ? 'Pause' : 'Resume'}
          </button>
          <span className="tabular-nums text-red-600" aria-live="polite">
            ● REC {(recording.elapsed / 1000).toFixed(1)} s · {recording.samples} samples
          </span>
        </>
      ) : (
        <button type="button" className={btn} onClick={() => controller.startRecording()} disabled={readOnly} title="Perform changes live on the stage and keep them as a new shot" data-record-start="">
          ● Record
        </button>
      )}
      <span className="flex items-center gap-1" role="radiogroup" aria-label="Drag to">
        Drag to
        {MOTION_RECORD_GESTURE_MODES.map((m) => (
          <label key={m} className="flex items-center gap-0.5">
            <input type="radio" name="animation-record-mode" checked={mode === m} onChange={() => onModeChange(m)} /> {MODE_LABELS[m]}
          </label>
        ))}
      </span>
      {pose && (
        <span className="flex items-center gap-2" data-record-paint="">
          {pose.fill !== undefined && (
            <label className="flex items-center gap-1">
              Fill <input type="color" value={hex6(pose.fill)} onChange={(e) => sample({ fill: e.target.value })} />
            </label>
          )}
          {pose.stroke !== undefined && (
            <label className="flex items-center gap-1">
              Stroke <input type="color" value={hex6(pose.stroke)} onChange={(e) => sample({ stroke: e.target.value })} />
            </label>
          )}
          <label className="flex items-center gap-1">
            Opacity <input type="range" min={0} max={1} step={0.01} value={pose.opacity} onChange={(e) => sample({ opacity: Number(e.target.value) })} />
          </label>
        </span>
      )}
      {recording && !node && <span className="text-muted-foreground">Drag an element; click one to record its paint and opacity.</span>}
      {!recording && error && /record/i.test(error) && <span className="text-amber-600">{error}</span>}
    </div>
  );
}
