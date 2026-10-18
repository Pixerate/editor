import React from 'react';
import type { AnimationEditorController, MotionIssue } from '@pixerate/editor/animation-editor';
import { useAnimationEditorState } from './useAnimationEditor';

export interface ShotTimelineProps {
  controller: AnimationEditorController;
  className?: string;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function worst(issues: readonly MotionIssue[]): 'error' | 'warning' | null {
  if (issues.some((i) => i.severity === 'error')) return 'error';
  if (issues.some((i) => i.severity === 'warning')) return 'warning';
  return null;
}

/**
 * Play / pause, the playhead and one block per shot (as wide as it is long): click a shot to
 * select it and jump to its start, click the ruler to seek. Shots with errors or warnings are marked.
 */
export function ShotTimeline({ controller, className = '' }: ShotTimelineProps) {
  const state = useAnimationEditorState(controller);
  const { duration, shots, time, playing, selection, issues } = state;
  const span = Math.max(1, duration);
  const onRuler = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    controller.seek(((event.clientX - box.left) / Math.max(1, box.width)) * span);
  };
  return (
    <div className={`flex flex-col gap-1 ${className}`} data-shot-timeline="">
      <div className="flex items-center gap-2 text-xs">
        <button type="button" className="rounded border border-border px-2 py-0.5" onClick={() => controller.toggle()} aria-label={playing ? 'Pause' : 'Play'} disabled={!shots.length}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="tabular-nums text-muted-foreground">
          {seconds(time)} / {seconds(duration)}
        </span>
      </div>
      <div className="relative h-3 cursor-pointer rounded bg-muted" onPointerDown={onRuler} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={Math.round(time)} tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') controller.seek(time + 100);
          if (e.key === 'ArrowLeft') controller.seek(time - 100);
        }}>
        <div className="absolute inset-y-0 w-0.5 bg-rose-500" style={{ left: `${(time / span) * 100}%` }} />
      </div>
      <div className="flex w-full gap-px" role="group" aria-label="Shots">
        {shots.map((shot) => {
          const mark = worst(issues.filter((i) => i.shot === shot.id));
          const selected = selection?.shot === shot.id;
          return (
            <button
              key={shot.id}
              type="button"
              className={`min-w-0 truncate rounded border px-1 py-1 text-left text-[11px] ${selected ? 'border-rose-500 bg-rose-500/10' : 'border-border'} ${state.currentShot === shot.id ? 'font-semibold' : ''}`}
              style={{ flexGrow: Math.max(1, shot.end - shot.start), flexBasis: 0 }}
              title={`${shot.label ?? shot.id} · ${seconds(shot.end - shot.start)}`}
              data-shot={shot.id}
              data-issue={mark ?? undefined}
              onClick={() => {
                controller.select({ shot: shot.id });
                controller.seekShot(shot.id);
              }}
            >
              {mark && <span className={mark === 'error' ? 'text-red-500' : 'text-amber-500'}>● </span>}
              {shot.label ?? shot.id}
            </button>
          );
        })}
      </div>
    </div>
  );
}
