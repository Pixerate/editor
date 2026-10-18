import React, { useEffect, useRef, useState } from 'react';
import { motionBeatTime, motionCueTime, motionRulerTicks, type AnimationEditorController, type MotionIssue } from '@pixerate/editor/animation-editor';
import { useAnimationEditorState } from './useAnimationEditor';

export interface PlayheadScrubberProps {
  controller: AnimationEditorController;
  className?: string;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

function worst(issues: readonly MotionIssue[]): 'error' | 'warning' | null {
  if (issues.some((i) => i.severity === 'error')) return 'error';
  if (issues.some((i) => i.severity === 'warning')) return 'warning';
  return null;
}

/**
 * Play, pause and loop, a time ruler (with the beat grid and narration words when the scene has
 * them) to scrub by dragging, and one band per shot (as wide as it is long): click a band to
 * select the shot and jump to its start. Loop is a scene setting, so changing it is one undo step.
 */
export function PlayheadScrubber({ controller, className = '' }: PlayheadScrubberProps) {
  const state = useAnimationEditorState(controller);
  const { duration, shots, time, playing, selection, issues, scene, readOnly } = state;
  const span = Math.max(1, duration);
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = track.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth || 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const ticks = motionRulerTicks(duration, width);
  const pct = (ms: number) => `${(Math.min(span, Math.max(0, ms)) / span) * 100}%`;
  const seekAt = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    controller.seek(Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width))) * span);
  };
  const beats: number[] = [];
  if (scene.beat && scene.beat.bpm > 0) for (let b = 0, t = motionBeatTime(scene.beat, 0); t <= span && beats.length < 400; t = motionBeatTime(scene.beat, ++b)) if (t >= 0) beats.push(t);

  return (
    <div className={`flex flex-col gap-1 ${className}`} data-playhead-scrubber="" data-shot-timeline="">
      <div className="flex items-center gap-2 text-xs">
        <button type="button" className="rounded border border-border px-2 py-0.5" onClick={() => controller.toggle()} aria-label={playing ? 'Pause' : 'Play'} disabled={!shots.length}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="rounded border border-border px-2 py-0.5" onClick={() => { controller.pause(); controller.seek(0); }} aria-label="Back to start">
          ⏮
        </button>
        <label className="flex items-center gap-1 text-muted-foreground">
          Loop
          <select
            className="rounded border border-border bg-transparent px-1 py-0.5"
            value={scene.loop ?? 'none'}
            disabled={readOnly}
            aria-label="Loop"
            onChange={(e) => controller.apply({ op: 'set_settings', loop: e.target.value as 'none' | 'loop' | 'ping-pong' }, 'Change loop')}
          >
            <option value="none">Off</option>
            <option value="loop">Loop</option>
            <option value="ping-pong">Ping-pong</option>
          </select>
        </label>
        <span className="ml-auto tabular-nums text-muted-foreground" data-time="">
          {seconds(time)} / {seconds(duration)}
        </span>
      </div>
      <div
        ref={track}
        className="relative cursor-ew-resize select-none touch-none"
        role="slider"
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.round(time)}
        tabIndex={0}
        data-scrub-track=""
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seekAt(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) seekAt(e.clientX);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1000 : 100;
          if (e.key === 'ArrowRight') controller.seek(time + step);
          else if (e.key === 'ArrowLeft') controller.seek(time - step);
          else if (e.key === 'Home') controller.seek(0);
          else if (e.key === 'End') controller.seek(duration);
          else if (e.key === ' ') controller.toggle();
          else return;
          e.preventDefault();
        }}
      >
        <div className="relative h-5 border-b border-border text-[10px] text-muted-foreground" data-ruler="">
          {beats.map((t, i) => (
            <div key={`b${i}`} className="absolute bottom-0 h-1.5 w-px bg-sky-500/60" style={{ left: pct(t) }} data-beat={i} />
          ))}
          {scene.narration?.words.map((w, i) => (
            <div key={`w${i}`} className="absolute top-0 h-1.5 w-px bg-emerald-500/70" style={{ left: pct(w.start) }} title={`“${w.text}” at ${seconds(w.start)}`} data-word={i} />
          ))}
          {ticks.map((t) => (
            <div key={t.time} className={`absolute bottom-0 w-px ${t.major ? 'h-2.5 bg-muted-foreground/70' : 'h-1 bg-muted-foreground/40'}`} style={{ left: pct(t.time) }}>
              {t.label && <span className="absolute -top-0.5 left-1 whitespace-nowrap tabular-nums">{t.label}</span>}
            </div>
          ))}
        </div>
        <div className="mt-1 flex w-full gap-px" role="group" aria-label="Shots">
          {shots.map((shot, i) => {
            const mark = worst(issues.filter((x) => x.shot === shot.id));
            const selected = selection?.shot === shot.id;
            const cue = scene.shots[i]?.at;
            const cueTime = cue ? motionCueTime(scene, cue) : undefined;
            return (
              <button
                key={shot.id}
                type="button"
                className={`relative min-w-0 truncate rounded border px-1 py-1 text-left text-[11px] ${selected ? 'border-rose-500 bg-rose-500/10' : 'border-border bg-muted/40'} ${state.currentShot === shot.id ? 'font-semibold' : ''}`}
                style={{ flexGrow: Math.max(1, shot.end - shot.start), flexBasis: 0 }}
                title={`${shot.label ?? shot.id} · ${seconds(shot.start)}–${seconds(shot.end)}${cueTime !== undefined ? ` · cued at ${seconds(cueTime)}` : ''}`}
                data-shot={shot.id}
                data-issue={mark ?? undefined}
                onPointerDown={(e) => e.stopPropagation()}
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
        <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-rose-500" style={{ left: pct(time) }} data-playhead="" />
      </div>
    </div>
  );
}
