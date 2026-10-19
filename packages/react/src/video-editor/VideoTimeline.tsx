import React, { useEffect, useRef, useState } from 'react';
import {
  planVideoClipDrag,
  videoDragLabel,
  videoAssetMap,
  videoClipLabel,
  videoClipTint,
  videoDropTracks,
  videoRulerTicks,
  formatVideoSeconds,
  type VideoClip,
  type VideoClipDragMode,
  type VideoClipDragPlan,
  type VideoEditorController,
  type VideoTrack,
} from '@pixerate/editor/video-editor';
import { useVideoEditorState } from './useVideoEditor';

export interface VideoTimelineProps {
  controller: VideoEditorController;
  /** Zoom: pixels per second of timeline. With `onPxPerSecondChange` the host owns it; otherwise it is the starting zoom (default 100). */
  pxPerSecond?: number;
  /** Called when the zoom control changes. Without it the timeline keeps its own zoom and shows a zoom slider. */
  onPxPerSecondChange?: (pxPerSecond: number) => void;
  /** Allow selecting, dragging, trimming and the track toggles (default true). */
  editable?: boolean;
  className?: string;
}

const HEADER = 150;
const RULER = 24;
const ROW = 44;
const HANDLE = 6;
const DRAG_THRESHOLD = 3;
const MIN_ZOOM = 10;
const MAX_ZOOM = 400;

interface Drag {
  clip: string;
  mode: VideoClipDragMode;
  x: number;
  pointer: number;
  moved: boolean;
  plan: VideoClipDragPlan | null;
}

const isField = (el: EventTarget | null) => el instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

/**
 * The tracks of a `VideoEditorController` laid out in time: a ruler with markers (click or drag it
 * to scrub), a playhead, and one row per track with its toggles (mute, hide, lock) and its clips.
 * Click a clip to select it (Shift / Cmd to add or remove it), drag it to move it (onto another
 * track of the same kind too; hold Alt to insert, pushing later material along on every sync-locked
 * track, or Shift to overwrite what is underneath), drag an edge to trim it (Alt to ripple). Moves snap to clip edges,
 * markers, the playhead and frames. Every edit is one undo step; refused edits show why.
 *
 * Keyboard (when focused): Space plays, ←/→ step a frame, S splits at the playhead, Delete removes
 * the selection (Shift to ripple), Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z redoes.
 */
export function VideoTimeline({ controller, pxPerSecond, onPxPerSecondChange, editable = true, className = '' }: VideoTimelineProps) {
  const state = useVideoEditorState(controller);
  const { project, duration, time, selection, readOnly, error } = state;
  const [ownZoom, setOwnZoom] = useState(pxPerSecond ?? 100);
  const px = onPxPerSecondChange ? (pxPerSecond ?? 100) : ownZoom;
  const canEdit = editable && !readOnly;
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const ruler = useRef<HTMLDivElement>(null);
  const assets = videoAssetMap(project);
  const msToPx = (ms: number) => (ms * px) / 1000;
  const span = Math.max(duration + 5000, 10000);
  const width = msToPx(span);
  const ticks = videoRulerTicks(span, px, project.fps);

  const seekAt = (clientX: number) => {
    const box = ruler.current!.getBoundingClientRect();
    controller.seek(Math.max(0, ((clientX - box.left) * 1000) / px));
  };

  const trackAt = (clipId: string, clientY: number): string | undefined => {
    const allowed = videoDropTracks(project, clipId);
    for (const [id, el] of rows.current) {
      const box = el.getBoundingClientRect();
      if (clientY >= box.top && clientY < box.bottom && allowed.includes(id)) return id;
    }
    return undefined;
  };

  const planFor = (d: Drag, e: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }) =>
    planVideoClipDrag(project, {
      clip: d.clip,
      mode: d.mode,
      delta: ((e.clientX - d.x) * 1000) / px,
      track: d.mode === 'move' ? trackAt(d.clip, e.clientY) : undefined,
      ripple: e.altKey,
      placement: e.altKey ? 'insert' : e.shiftKey ? 'overwrite' : 'refuse',
      snap: (t) => controller.snap(t, { exclude: [d.clip] }).time,
    });

  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // The latest render's values, for the window listeners of a drag in progress.
  const live = useRef({ planFor, selection });
  live.current = { planFor, selection };
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const onClipPointerDown = (e: React.PointerEvent<HTMLDivElement>, clip: VideoClip, track: VideoTrack) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.stopPropagation();
    if (!editable) return;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // No pointer to capture (synthetic events).
    }
    const handle = (e.target as HTMLElement).closest('[data-handle]')?.getAttribute('data-handle');
    const mode: VideoClipDragMode = handle === 'start' ? 'trim-start' : handle === 'end' ? 'trim-end' : 'move';
    const fixed = !canEdit || !!track.locked;
    stopDrag.current?.();
    update({ clip: clip.id, mode, x: e.clientX, pointer: e.pointerId, moved: false, plan: null });
    // Follow the pointer on the window: the block may move to another track's row (a new element) mid-drag.
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || fixed) return;
      if (!d.moved && Math.abs(ev.clientX - d.x) < DRAG_THRESHOLD) return;
      if (!d.moved && !live.current.selection.includes(d.clip)) controller.select([d.clip]);
      update({ ...d, moved: true, plan: live.current.planFor(d, ev) });
    };
    const up = (ev: PointerEvent) => {
      stop();
      const d = dragRef.current;
      if (!d) return;
      update(null);
      if (!d.moved) {
        if (ev.shiftKey || ev.metaKey || ev.ctrlKey) controller.select([d.clip], { add: true });
        else controller.select([d.clip]);
        return;
      }
      const plan = live.current.planFor(d, ev);
      if (plan?.edit) controller.apply(plan.edit, videoDragLabel(plan.edit));
    };
    const cancel = () => {
      stop();
      update(null);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      stopDrag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    stopDrag.current = stop;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isField(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (e.key === ' ') {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      controller.toggle();
    } else if (e.key === 'ArrowLeft' && !mod) controller.step(-1);
    else if (e.key === 'ArrowRight' && !mod) controller.step(1);
    else if (e.key === 'Escape') controller.select(null);
    else if (!canEdit) return;
    else if (key === 's' && !mod) controller.splitAtPlayhead();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) controller.deleteSelection({ ripple: e.shiftKey });
    else if (key === 'z' && mod) {
      if (e.shiftKey) controller.redo();
      else controller.undo();
    } else return;
    e.preventDefault();
  };

  // Where each clip is drawn: the dragged one follows the plan (possibly on another track).
  const placed = project.tracks.map((track) => ({
    track,
    clips: project.tracks.flatMap((t) =>
      t.clips
        .map((clip) => {
          const plan = drag?.moved && drag.clip === clip.id ? drag.plan : null;
          const on = plan ? plan.track : t.id;
          return on === track.id ? { clip, home: t, start: plan ? plan.start : clip.start, duration: plan ? plan.duration : clip.duration, dragging: !!plan } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    ),
  }));

  const toggle = (track: VideoTrack, field: 'muted' | 'hidden' | 'locked', label: string) => (
    <button
      type="button"
      className={`rounded border px-1 text-[10px] leading-4 ${track[field] ? 'border-rose-500 bg-rose-500/15 text-rose-600' : 'border-border text-muted-foreground'} disabled:opacity-40`}
      aria-pressed={!!track[field]}
      aria-label={`${label} ${track.name ?? track.id}`}
      title={label}
      disabled={!canEdit}
      data-track-toggle={field}
      onClick={() => controller.apply({ op: 'update_track', track: track.id, set: { [field]: !track[field] } }, `${track[field] ? 'Un' : ''}${field === 'muted' ? 'mute' : field === 'hidden' ? 'hide' : 'lock'} track`)}
    >
      {field === 'muted' ? 'M' : field === 'hidden' ? 'H' : 'L'}
    </button>
  );

  return (
    <div className={`flex flex-col gap-1 ${className}`} data-video-timeline-wrapper="">
      {!onPxPerSecondChange && (
        <label className="flex items-center gap-2 self-end text-xs text-muted-foreground">
          Zoom
          <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={5} value={ownZoom} aria-label="Timeline zoom" onChange={(e) => setOwnZoom(Number(e.target.value))} data-zoom="" />
        </label>
      )}
      <div
        className="relative overflow-x-auto rounded border border-border outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50"
        tabIndex={0}
        role="group"
        aria-label="Video timeline"
        onKeyDown={onKeyDown}
        data-video-timeline=""
      >
        <div className="relative" style={{ width: HEADER + width }}>
          <div className="flex" style={{ height: RULER }}>
            <div className="sticky left-0 z-20 shrink-0 border-b border-r border-border bg-background" style={{ width: HEADER }} />
            <div
              ref={ruler}
              className="relative shrink-0 cursor-ew-resize select-none touch-none border-b border-border text-[10px] text-muted-foreground"
              style={{ width }}
              role="slider"
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={Math.round(time)}
              data-ruler=""
              onPointerDown={(e) => {
                try {
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                } catch {
                  // No pointer to capture (synthetic events).
                }
                seekAt(e.clientX);
              }}
              onPointerMove={(e) => {
                if (e.buttons & 1) seekAt(e.clientX);
              }}
            >
              {ticks.map((t) => (
                <div key={t.time} className={`absolute bottom-0 w-px ${t.major ? 'h-2.5 bg-muted-foreground/70' : 'h-1 bg-muted-foreground/40'}`} style={{ left: t.x }} data-tick={t.time}>
                  {t.label && <span className="absolute -top-3.5 left-1 whitespace-nowrap tabular-nums">{t.label}</span>}
                </div>
              ))}
              {(project.markers ?? []).map((m) => (
                <div
                  key={m.id}
                  className="absolute top-0 h-2.5 w-2.5 -translate-x-1/2 rotate-45"
                  style={{ left: msToPx(m.time), background: m.color ?? '#f59e0b' }}
                  title={`${m.label ?? m.id} at ${formatVideoSeconds(m.time)}`}
                  data-marker={m.id}
                />
              ))}
            </div>
          </div>
          {placed.map(({ track, clips }) => (
            <div key={track.id} className="flex border-b border-border last:border-b-0" style={{ height: ROW }} data-track={track.id}>
              <div className="sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-0.5 border-r border-border bg-background px-2 text-xs" style={{ width: HEADER }} data-track-header="">
                <div className="flex items-center gap-1">
                  <span className="truncate font-medium">{track.name ?? track.id}</span>
                  <span className="rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground" data-track-kind="">
                    {track.kind}
                  </span>
                </div>
                {editable && (
                  <div className="flex gap-1">
                    {toggle(track, 'muted', 'Mute')}
                    {track.kind === 'video' && toggle(track, 'hidden', 'Hide')}
                    {toggle(track, 'locked', 'Lock')}
                  </div>
                )}
              </div>
              <div
                ref={(el) => {
                  if (el) rows.current.set(track.id, el);
                  else rows.current.delete(track.id);
                }}
                className={`relative shrink-0 ${track.hidden ? 'opacity-50' : ''} ${track.locked ? 'bg-muted/40' : ''}`}
                style={{ width }}
                data-track-lane={track.id}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget && editable) controller.select(null);
                }}
              >
                {clips.map(({ clip, home, start, duration: length, dragging }) => {
                  const asset = clip.type === 'media' ? assets.get(clip.asset) : undefined;
                  const selected = selection.includes(clip.id);
                  const label = videoClipLabel(clip, asset);
                  return (
                    <div
                      key={clip.id}
                      className={`absolute top-1 bottom-1 select-none touch-none overflow-hidden rounded text-[11px] text-white ${canEdit && !home.locked ? 'cursor-grab' : 'cursor-default'} ${dragging ? 'opacity-80 shadow-lg' : ''}`}
                      style={{
                        left: msToPx(start),
                        width: Math.max(2, msToPx(length)),
                        background: videoClipTint(clip, asset),
                        outline: selected ? '2px solid #f43f5e' : undefined,
                        outlineOffset: selected ? 1 : undefined,
                        zIndex: dragging ? 10 : selected ? 2 : 1,
                      }}
                      title={`${label} · ${formatVideoSeconds(start)}–${formatVideoSeconds(start + length)}`}
                      data-clip={clip.id}
                      data-selected={selected ? '' : undefined}
                      data-dragging={dragging ? '' : undefined}
                      aria-selected={selected}
                      onPointerDown={(e) => onClipPointerDown(e, clip, home)}
                    >
                      <span className="pointer-events-none block truncate px-1.5 py-0.5 leading-4">{label}</span>
                      {clip.transition && (
                        <span className="pointer-events-none absolute left-1 bottom-0.5 rounded bg-black/40 px-1 text-[9px] leading-3" title={`${clip.transition.type} ${clip.transition.duration} ms`} data-transition={clip.transition.type}>
                          ⧓ {clip.transition.type}
                        </span>
                      )}
                      {canEdit && !home.locked && (
                        <>
                          <div className="absolute inset-y-0 left-0 cursor-ew-resize bg-white/0 hover:bg-white/40" style={{ width: HANDLE }} data-handle="start" aria-hidden="true" />
                          <div className="absolute inset-y-0 right-0 cursor-ew-resize bg-white/0 hover:bg-white/40" style={{ width: HANDLE }} data-handle="end" aria-hidden="true" />
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-rose-500" style={{ left: HEADER + msToPx(time), zIndex: 15 }} data-playhead="" />
        </div>
      </div>
      {error && (
        <p className="text-xs text-red-500" role="alert" data-edit-error="">
          {error}
        </p>
      )}
    </div>
  );
}
