<script lang="ts">
  import {
    findVideoClip,
    formatVideoTimecode,
    planVideoClipDrag,
    videoDragLabel,
    videoAssetMap,
    videoSequenceMap,
    videoClipLabel,
    videoClipShowsWaveform,
    videoClipWaveformPath,
    videoClipTint,
    videoDropTracks,
    videoRulerTicks,
    type VideoAsset,
    type VideoClip,
    type VideoClipDragMode,
    type VideoClipDragPlan,
    type VideoEditorController,
    type VideoMediaClip,
    type VideoTrack,
    type VideoWaveformMode,
  } from '@pixerate/editor/video-editor';
  import { onDestroy, untrack } from 'svelte';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    /** Zoom: pixels per second of timeline (default 100). Bindable. */
    pxPerSecond?: number;
    /** Called when the zoom control changes `pxPerSecond`. */
    onpxpersecondchange?: (pxPerSecond: number) => void;
    /** Allow moving and trimming clips, the track toggles and the edit keys (default true). False still scrubs, selects and plays. */
    editable?: boolean;
    /** Draw waveforms in audio clips (default), in every clip with sound (`all`), or not at all. Sound is decoded once per asset through `controller.audioPeaks`. */
    waveforms?: VideoWaveformMode;
    class?: string;
  }

  let { controller, pxPerSecond = $bindable(100), onpxpersecondchange, editable = true, waveforms = 'audio', class: className = '' }: Props = $props();
  /** Bumped when more sound peaks have loaded, so waveforms redraw. */
  let peaksVersion = $state(0);
  $effect(() => controller.audioPeaks.subscribe(() => peaksVersion++));
  const CLIP_HEIGHT = 40;
  /** The waveform path for a clip, starting to load its asset's sound the first time. */
  function waveformPath(clip: VideoMediaClip, asset: VideoAsset, w: number): string {
    void peaksVersion;
    const peaks = controller.audioPeaks.get(asset);
    return peaks ? videoClipWaveformPath(clip, peaks, w, CLIP_HEIGHT) : '';
  }
  const view = videoEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const project = $derived(editor.project);
  const assets = $derived(videoAssetMap(project));
  const sequences = $derived(videoSequenceMap(project));
  const px = $derived(Math.max(1, pxPerSecond));
  const x = (ms: number) => (ms * px) / 1000;
  /** Room after the last clip to drop and drag into. */
  const span = $derived(Math.max(editor.duration + 5000, 10000));
  const width = $derived(x(span));
  const ticks = $derived(videoRulerTicks(span, px, project.fps));
  /** The stretches the controller's frame cache holds, every two pixels, re-read after edits and at most four times a second as frames arrive. */
  let cached: { start: number; end: number }[] = $state.raw([]);
  $effect(() => {
    const cache = controller.frameCache;
    const step = 2000 / px;
    const p = project;
    if (!cache) {
      cached = [];
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      timer = null;
      cached = cache.cachedRanges(p, { step });
    };
    untrack(read);
    const off = cache.subscribe(() => {
      timer ??= setTimeout(read, 250);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  });
  const canEdit = $derived(editable && !editor.readOnly);
  const HEADER = 144;
  const ZOOM_MIN = 10;
  const ZOOM_MAX = 2000;
  const btn = 'rounded border border-border px-1.5 py-0.5 text-[11px] disabled:opacity-40';

  let container: HTMLDivElement | undefined = $state();
  let ruler: HTMLDivElement | undefined = $state();

  interface Drag {
    clip: string;
    mode: VideoClipDragMode;
    pointerX: number;
    moved: boolean;
    /** Whether the drag may edit (false: it only selects). */
    edits: boolean;
    additive: boolean;
    plan: VideoClipDragPlan | null;
  }
  let drag = $state.raw<Drag | null>(null);

  interface Item {
    clip: VideoClip;
    start: number;
    duration: number;
    dragging: boolean;
  }
  // While dragging, the clip is drawn where the plan puts it (possibly on another track).
  const rows = $derived.by(() => {
    const plan = drag?.plan ?? null;
    const moving = plan && drag ? findVideoClip(project, drag.clip) : null;
    return project.tracks.map((track) => {
      const items: Item[] = [];
      for (const clip of track.clips) {
        if (moving && plan && clip.id === moving.clip.id) {
          if (plan.track === track.id) items.push({ clip, start: plan.start, duration: plan.duration, dragging: true });
        } else items.push({ clip, start: clip.start, duration: clip.duration, dragging: false });
      }
      if (moving && plan && plan.track === track.id && moving.track.id !== track.id) items.push({ clip: moving.clip, start: plan.start, duration: plan.duration, dragging: true });
      return { track, items };
    });
  });

  function setZoom(value: number) {
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));
    if (next === pxPerSecond) return;
    pxPerSecond = next;
    onpxpersecondchange?.(next);
  }

  function seekAt(clientX: number) {
    const box = ruler!.getBoundingClientRect();
    controller.seek(Math.max(0, ((clientX - box.left) * 1000) / px));
  }

  /** The track row under the pointer, when the clip may be dropped there. */
  function trackAt(clientY: number, clip: string): string | undefined {
    const allowed = videoDropTracks(project, clip);
    for (const lane of container?.querySelectorAll<HTMLElement>('[data-lane]') ?? []) {
      const box = lane.getBoundingClientRect();
      if (box.height > 0 && clientY >= box.top && clientY < box.bottom) {
        const id = lane.dataset.lane!;
        return allowed.includes(id) ? id : undefined;
      }
    }
    return undefined;
  }

  function onwindowmove(e: PointerEvent) {
    const d = drag;
    if (!d || !d.edits) return;
    const dx = e.clientX - d.pointerX;
    if (!d.moved && Math.abs(dx) < 3) return;
    const clip = d.clip;
    const plan = planVideoClipDrag(project, {
      clip,
      mode: d.mode,
      delta: (dx * 1000) / px,
      track: d.mode === 'move' ? trackAt(e.clientY, clip) : undefined,
      ripple: e.altKey,
      placement: e.altKey ? 'insert' : e.shiftKey ? 'overwrite' : 'refuse',
      snap: (t) => controller.snap(t, { exclude: [clip] }).time,
    });
    drag = { ...d, moved: true, plan };
  }

  function onwindowup() {
    const d = drag;
    stopListening();
    drag = null;
    if (!d) return;
    if (d.moved) {
      const edit = d.plan?.edit;
      if (edit) controller.apply(edit, videoDragLabel(edit));
    } else if (!d.additive) controller.select([d.clip]);
  }

  function oncancel() {
    stopListening();
    drag = null;
  }

  function stopListening() {
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointermove', onwindowmove);
    window.removeEventListener('pointerup', onwindowup);
    window.removeEventListener('pointercancel', oncancel);
  }
  onDestroy(stopListening);

  function onclipdown(e: PointerEvent, clip: VideoClip, track: VideoTrack) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    container?.focus();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) controller.select([clip.id], { add: true });
    else if (!editor.selection.includes(clip.id)) controller.select([clip.id]);
    const edge = (e.target as HTMLElement).closest('[data-edge]')?.getAttribute('data-edge');
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag = {
      clip: clip.id,
      mode: edge === 'start' ? 'trim-start' : edge === 'end' ? 'trim-end' : 'move',
      pointerX: e.clientX,
      moved: false,
      edits: canEdit && !track.locked && !additive,
      additive,
      plan: null,
    };
    // On the window, not the block: a block dragged onto another track is drawn by another row.
    stopListening();
    window.addEventListener('pointermove', onwindowmove);
    window.addEventListener('pointerup', onwindowup);
    window.addEventListener('pointercancel', oncancel);
  }

  function toggleTrack(track: VideoTrack, key: 'muted' | 'hidden' | 'locked') {
    const on = !track[key];
    const verb = { muted: ['Mute', 'Unmute'], hidden: ['Hide', 'Show'], locked: ['Lock', 'Unlock'] }[key][on ? 0 : 1];
    controller.apply({ op: 'update_track', track: track.id, set: { [key]: on } }, `${verb} track`);
  }

  function onkeydown(e: KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) return;
    if (el.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === ' ') controller.toggle();
    else if (e.key === 'ArrowLeft') controller.step(-1);
    else if (e.key === 'ArrowRight') controller.step(1);
    else if (e.key === 'Escape') controller.select(null);
    else if (!editable) return;
    else if (mod && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) controller.redo();
      else controller.undo();
    } else if (!mod && e.key.toLowerCase() === 's') controller.splitAtPlayhead();
    else if (e.key === 'Delete' || e.key === 'Backspace') controller.deleteSelection({ ripple: e.shiftKey });
    else return;
    e.preventDefault();
  }

  const toggles = (track: VideoTrack) =>
    [
      { key: 'muted' as const, short: 'M', label: track.muted ? 'Unmute' : 'Mute' },
      ...(track.kind === 'video' ? [{ key: 'hidden' as const, short: 'H', label: track.hidden ? 'Show' : 'Hide' }] : []),
      { key: 'locked' as const, short: 'L', label: track.locked ? 'Unlock' : 'Lock' },
    ];
</script>

<!--
  The timeline: a ruler to scrub (with markers), the playhead, and a row per track with its
  toggles and clips. Click a clip to select it (shift / ⌘ to add), drag it to move it (onto
  another track of its kind; alt: insert, pushing later material along on every sync-locked track;
  shift: overwrite what is underneath), drag an edge to trim (alt: ripple). Keys: Space plays, ←/→ step a
  frame, S splits, Delete deletes (shift: ripple), ⌘Z / ⇧⌘Z undo and redo. Every edit is one undo step.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={container}
  class="flex flex-col gap-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-rose-500 {className}"
  tabindex="0"
  role="group"
  aria-label="Timeline"
  data-video-timeline=""
  {onkeydown}
>
  <div class="flex items-center gap-1 text-muted-foreground">
    <span class="tabular-nums" data-timecode="">{formatVideoTimecode(editor.time, project.fps)}</span>
    <span class="ml-auto flex items-center gap-1" data-zoom="">
      <button type="button" class={btn} aria-label="Zoom out" onclick={() => setZoom(px / 1.25)}>−</button>
      <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step="1" value={px} aria-label="Zoom" class="w-24" oninput={(e) => setZoom(Number(e.currentTarget.value))} />
      <button type="button" class={btn} aria-label="Zoom in" onclick={() => setZoom(px * 1.25)}>+</button>
    </span>
  </div>
  <div class="relative overflow-x-auto rounded border border-border">
    <div class="relative" style="width:{HEADER + width}px">
      <div class="flex h-6 border-b border-border">
        <div class="sticky left-0 z-20 shrink-0 bg-background" style="width:{HEADER}px"></div>
        <div
          bind:this={ruler}
          class="relative cursor-ew-resize select-none touch-none text-[10px] text-muted-foreground"
          style="width:{width}px"
          role="slider"
          tabindex="-1"
          aria-label="Playhead"
          aria-valuemin={0}
          aria-valuemax={editor.duration}
          aria-valuenow={Math.round(editor.time)}
          data-ruler=""
          onpointerdown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            seekAt(e.clientX);
          }}
          onpointermove={(e) => {
            if (e.buttons & 1) seekAt(e.clientX);
          }}
        >
          {#each ticks as t (t.time)}
            <div class="absolute bottom-0 w-px {t.major ? 'h-2.5 bg-muted-foreground/70' : 'h-1 bg-muted-foreground/40'}" style="left:{t.x}px">
              {#if t.label}<span class="absolute -top-0.5 left-1 whitespace-nowrap tabular-nums">{t.label}</span>{/if}
            </div>
          {/each}
          {#each cached as r (r.start)}
            <div class="pointer-events-none absolute bottom-0 h-[3px] bg-emerald-500/70" style="left:{x(r.start)}px;width:{Math.max(1, x(r.end - r.start))}px" title="Frames cached: plays and scrubs without waiting" data-cached-range=""></div>
          {/each}
          {#each project.markers ?? [] as m (m.id)}
            <div
              class="absolute top-0 h-2 w-2 -translate-x-1/2 rotate-45"
              style="left:{x(m.time)}px;background:{m.color ?? '#f59e0b'}"
              title="{m.label ?? m.id} · {formatVideoTimecode(m.time, project.fps)}"
              data-marker={m.id}
            ></div>
          {/each}
        </div>
      </div>
      {#each rows as row (row.track.id)}
        {@const track = row.track}
        <div class="flex h-12 border-b border-border last:border-b-0" data-track={track.id}>
          <div class="sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-0.5 border-r border-border bg-background px-1.5" style="width:{HEADER}px">
            <div class="flex items-center gap-1">
              <span class="truncate font-medium">{track.name ?? track.id}</span>
              <span class="rounded bg-muted px-1 text-[10px] text-muted-foreground" data-track-kind="">{track.kind}</span>
            </div>
            <div class="flex gap-0.5">
              {#each toggles(track) as t (t.key)}
                <button
                  type="button"
                  class="{btn} {track[t.key] ? 'bg-muted text-foreground' : 'text-muted-foreground'}"
                  aria-label="{t.label} {track.name ?? track.id}"
                  aria-pressed={!!track[t.key]}
                  title="{t.label} track"
                  disabled={!canEdit}
                  data-toggle={t.key}
                  onclick={() => toggleTrack(track, t.key)}>{t.short}</button
                >
              {/each}
            </div>
          </div>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="relative shrink-0 {track.locked ? 'bg-muted/60' : ''} {track.hidden || track.muted ? 'opacity-60' : ''}"
            style="width:{width}px"
            data-lane={track.id}
            onpointerdown={(e) => {
              if (e.button === 0 && !(e.shiftKey || e.metaKey || e.ctrlKey)) controller.select(null);
            }}
          >
            {#each row.items as item (item.clip.id)}
              {@const clip = item.clip}
              {@const asset = clip.type === 'media' ? assets.get(clip.asset) : undefined}
              {@const label = videoClipLabel(clip, asset, clip.type === 'sequence' ? sequences.get(clip.sequence) : undefined)}
              {@const selected = editor.selection.includes(clip.id)}
              <div
                class="absolute inset-y-1 flex select-none touch-none items-center gap-1 overflow-hidden rounded px-1.5 text-[11px] text-white {selected ? 'outline outline-2 outline-offset-1 outline-rose-500' : ''} {item.dragging ? 'opacity-80 shadow-lg' : ''} {canEdit && !track.locked ? 'cursor-grab' : 'cursor-pointer'}"
                style="left:{x(item.start)}px;width:{Math.max(2, x(item.duration))}px;background:{videoClipTint(clip, asset)}"
                role="button"
                tabindex="-1"
                aria-pressed={selected}
                title="{label} · {formatVideoTimecode(item.start, project.fps)}–{formatVideoTimecode(item.start + item.duration, project.fps)}"
                data-clip={clip.id}
                data-compound={clip.type === 'sequence' ? clip.sequence : undefined}
                data-selected={selected ? '' : undefined}
                data-dragging={item.dragging ? '' : undefined}
                onpointerdown={(e) => onclipdown(e, clip, track)}
              >
                {#if clip.type === 'media' && videoClipShowsWaveform(clip, asset, waveforms)}
                  {@const w = Math.max(2, x(clip.duration))}
                  {@const d = waveformPath(clip, asset, w)}
                  {#if d}
                    <svg class="pointer-events-none absolute inset-0" width={w} height={CLIP_HEIGHT} aria-hidden="true" data-waveform={clip.id}><path {d} fill="currentColor" fill-opacity="0.45" /></svg>
                  {/if}
                {/if}
                {#if clip.transition}
                  <span class="relative shrink-0 rounded bg-black/40 px-1 text-[9px]" title="{clip.transition.type} {clip.transition.duration} ms" data-transition={clip.transition.type}>⋈</span>
                {/if}
                <span class="relative truncate drop-shadow">{label}</span>
                {#if canEdit && !track.locked}
                  <div class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40" data-edge="start" aria-hidden="true"></div>
                  <div class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 hover:bg-white/40" data-edge="end" aria-hidden="true"></div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}
      <div class="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-rose-500" style="left:{HEADER + x(editor.time)}px" data-playhead=""></div>
    </div>
  </div>
  {#if editor.error}
    <p class="text-red-500" role="alert" data-edit-error="">{editor.error}</p>
  {/if}
</div>
