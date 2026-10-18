<script lang="ts">
  import type { AnimationEditorController, MotionIssue } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    class?: string;
  }

  let { controller, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const state = $derived(view.current);
  const span = $derived(Math.max(1, state.duration));
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const worst = (issues: readonly MotionIssue[]): 'error' | 'warning' | null =>
    issues.some((i) => i.severity === 'error') ? 'error' : issues.some((i) => i.severity === 'warning') ? 'warning' : null;

  function onRuler(event: PointerEvent) {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    controller.seek(((event.clientX - box.left) / Math.max(1, box.width)) * span);
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === 'ArrowRight') controller.seek(state.time + 100);
    if (event.key === 'ArrowLeft') controller.seek(state.time - 100);
  }
</script>

<!-- Play / pause, the playhead and one block per shot (as wide as it is long). -->
<div class="flex flex-col gap-1 {className}" data-shot-timeline="">
  <div class="flex items-center gap-2 text-xs">
    <button type="button" class="rounded border border-border px-2 py-0.5" onclick={() => controller.toggle()} aria-label={state.playing ? 'Pause' : 'Play'} disabled={!state.shots.length}>
      {state.playing ? 'Pause' : 'Play'}
    </button>
    <span class="tabular-nums text-muted-foreground">{seconds(state.time)} / {seconds(state.duration)}</span>
  </div>
  <div
    class="relative h-3 cursor-pointer rounded bg-muted"
    onpointerdown={onRuler}
    onkeydown={onKey}
    role="slider"
    aria-label="Playhead"
    aria-valuemin={0}
    aria-valuemax={state.duration}
    aria-valuenow={Math.round(state.time)}
    tabindex="0"
  >
    <div class="absolute inset-y-0 w-0.5 bg-rose-500" style="left:{(state.time / span) * 100}%"></div>
  </div>
  <div class="flex w-full gap-px" role="group" aria-label="Shots">
    {#each state.shots as shot (shot.id)}
      {@const mark = worst(state.issues.filter((i) => i.shot === shot.id))}
      <button
        type="button"
        class="min-w-0 truncate rounded border px-1 py-1 text-left text-[11px] {state.selection?.shot === shot.id ? 'border-rose-500 bg-rose-500/10' : 'border-border'} {state.currentShot === shot.id ? 'font-semibold' : ''}"
        style="flex-grow:{Math.max(1, shot.end - shot.start)};flex-basis:0"
        title="{shot.label ?? shot.id} · {seconds(shot.end - shot.start)}"
        data-shot={shot.id}
        data-issue={mark ?? undefined}
        onclick={() => {
          controller.select({ shot: shot.id });
          controller.seekShot(shot.id);
        }}
      >
        {#if mark}<span class={mark === 'error' ? 'text-red-500' : 'text-amber-500'}>● </span>{/if}{shot.label ?? shot.id}
      </button>
    {/each}
  </div>
</div>
