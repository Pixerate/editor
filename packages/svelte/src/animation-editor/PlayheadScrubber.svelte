<script lang="ts">
  import { motionBeatTime, motionCueTime, motionRulerTicks, type AnimationEditorController, type MotionIssue } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const span = $derived(Math.max(1, editor.duration));
  let width = $state(600);
  let track: HTMLDivElement | undefined = $state();
  // Not bind:clientWidth: that needs ResizeObserver, which test DOMs (jsdom) lack.
  $effect(() => {
    const el = track;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => (width = el.clientWidth || 600));
    observer.observe(el);
    return () => observer.disconnect();
  });
  const ticks = $derived(motionRulerTicks(editor.duration, width || 600));
  const beats = $derived.by(() => {
    const out: number[] = [];
    const grid = editor.scene.beat;
    if (grid && grid.bpm > 0) for (let b = 0, t = motionBeatTime(grid, 0); t <= span && out.length < 400; t = motionBeatTime(grid, ++b)) if (t >= 0) out.push(t);
    return out;
  });
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  const pct = (ms: number) => `${(Math.min(span, Math.max(0, ms)) / span) * 100}%`;
  const worst = (issues: readonly MotionIssue[]): 'error' | 'warning' | null =>
    issues.some((i) => i.severity === 'error') ? 'error' : issues.some((i) => i.severity === 'warning') ? 'warning' : null;

  function seekAt(clientX: number) {
    const box = track!.getBoundingClientRect();
    controller.seek(Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width))) * span);
  }
  function onKey(event: KeyboardEvent) {
    const step = event.shiftKey ? 1000 : 100;
    if (event.key === 'ArrowRight') controller.seek(editor.time + step);
    else if (event.key === 'ArrowLeft') controller.seek(editor.time - step);
    else if (event.key === 'Home') controller.seek(0);
    else if (event.key === 'End') controller.seek(editor.duration);
    else if (event.key === ' ') controller.toggle();
    else return;
    event.preventDefault();
  }
</script>

<!--
  Play, pause and loop, a time ruler (with the beat grid and narration words when the scene has
  them) to scrub by dragging, and one band per shot: click a band to select the shot and jump to it.
-->
<div class="flex flex-col gap-1 {className}" data-playhead-scrubber="" data-shot-timeline="">
  <div class="flex items-center gap-2 text-xs">
    <button type="button" class="rounded border border-border px-2 py-0.5" onclick={() => controller.toggle()} aria-label={editor.playing ? 'Pause' : 'Play'} disabled={!editor.shots.length}>
      {editor.playing ? 'Pause' : 'Play'}
    </button>
    <button type="button" class="rounded border border-border px-2 py-0.5" onclick={() => { controller.pause(); controller.seek(0); }} aria-label="Back to start">⏮</button>
    <label class="flex items-center gap-1 text-muted-foreground">
      Loop
      <select
        class="rounded border border-border bg-transparent px-1 py-0.5"
        value={editor.scene.loop ?? 'none'}
        disabled={editor.readOnly}
        aria-label="Loop"
        onchange={(e) => controller.apply({ op: 'set_settings', loop: e.currentTarget.value as 'none' | 'loop' | 'ping-pong' }, 'Change loop')}
      >
        <option value="none">Off</option>
        <option value="loop">Loop</option>
        <option value="ping-pong">Ping-pong</option>
      </select>
    </label>
    <span class="ml-auto tabular-nums text-muted-foreground" data-time="">{seconds(editor.time)} / {seconds(editor.duration)}</span>
  </div>
  <div
    bind:this={track}
    class="relative cursor-ew-resize select-none touch-none"
    role="slider"
    aria-label="Playhead"
    aria-valuemin={0}
    aria-valuemax={editor.duration}
    aria-valuenow={Math.round(editor.time)}
    tabindex="0"
    data-scrub-track=""
    onpointerdown={(e) => {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      seekAt(e.clientX);
    }}
    onpointermove={(e) => {
      if (e.buttons & 1) seekAt(e.clientX);
    }}
    onkeydown={onKey}
  >
    <div class="relative h-5 border-b border-border text-[10px] text-muted-foreground" data-ruler="">
      {#each beats as t, i (i)}
        <div class="absolute bottom-0 h-1.5 w-px bg-sky-500/60" style="left:{pct(t)}" data-beat={i}></div>
      {/each}
      {#each editor.scene.narration?.words ?? [] as w, i (i)}
        <div class="absolute top-0 h-1.5 w-px bg-emerald-500/70" style="left:{pct(w.start)}" title="“{w.text}” at {seconds(w.start)}" data-word={i}></div>
      {/each}
      {#each ticks as t (t.time)}
        <div class="absolute bottom-0 w-px {t.major ? 'h-2.5 bg-muted-foreground/70' : 'h-1 bg-muted-foreground/40'}" style="left:{pct(t.time)}">
          {#if t.label}<span class="absolute -top-0.5 left-1 whitespace-nowrap tabular-nums">{t.label}</span>{/if}
        </div>
      {/each}
    </div>
    <div class="mt-1 flex w-full gap-px" role="group" aria-label="Shots">
      {#each editor.shots as shot, i (shot.id)}
        {@const mark = worst(editor.issues.filter((x) => x.shot === shot.id))}
        {@const cue = editor.scene.shots[i]?.at}
        {@const cueTime = cue ? motionCueTime(editor.scene, cue) : undefined}
        <button
          type="button"
          class="relative min-w-0 truncate rounded border px-1 py-1 text-left text-[11px] {editor.selection?.shot === shot.id ? 'border-rose-500 bg-rose-500/10' : 'border-border bg-muted/40'} {editor.currentShot === shot.id ? 'font-semibold' : ''}"
          style="flex-grow:{Math.max(1, shot.end - shot.start)};flex-basis:0"
          title="{shot.label ?? shot.id} · {seconds(shot.start)}–{seconds(shot.end)}{cueTime !== undefined ? ` · cued at ${seconds(cueTime)}` : ''}"
          data-shot={shot.id}
          data-issue={mark ?? undefined}
          onpointerdown={(e) => e.stopPropagation()}
          onclick={() => {
            controller.select({ shot: shot.id });
            controller.seekShot(shot.id);
          }}
        >
          {#if mark}<span class={mark === 'error' ? 'text-red-500' : 'text-amber-500'}>● </span>{/if}{shot.label ?? shot.id}
        </button>
      {/each}
    </div>
    <div class="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-rose-500" style="left:{pct(editor.time)}" data-playhead=""></div>
  </div>
</div>
