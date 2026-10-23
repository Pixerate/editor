<script lang="ts">
  import { MOTION_RECORD_GESTURE_MODES, type AnimationEditorController, type MotionRecordGestureMode, type MotionTakeSample } from '@pixerate/editor/animation-editor';
  import { animationEditorStateOf } from './createAnimationEditor.svelte.js';

  interface Props {
    controller: AnimationEditorController;
    /** The element the paint and opacity controls record (e.g. the one picked on the stage). */
    node?: string | null;
    /** What a stage drag does while recording (pass the same to `<AnimationStage recordMode>`). */
    mode: MotionRecordGestureMode;
    onmodechange: (mode: MotionRecordGestureMode) => void;
    class?: string;
  }

  let { controller, node = null, mode, onmodechange, class: className = '' }: Props = $props();
  const view = animationEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const pose = $derived(editor.recording && node ? controller.pose(node) : null);
  const btn = 'rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40';
  const MODE_LABELS: Record<MotionRecordGestureMode, string> = { move: 'Move', scale: 'Scale', rotate: 'Rotate' };
  const hex6 = (c: string | undefined) => (c && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7).toLowerCase() : '#000000');
  const sample = (values: Omit<MotionTakeSample, 'node' | 't'>) => node && controller.recordSample(node, values);
</script>

<!--
  Record a take: Record plays on from the end of the scene while you drag elements on the stage
  (moving, scaling or turning them, as `mode` says) and change the picked element's paint and
  opacity; Stop keeps the performance as a new shot of ordinary commands, one undo step.
-->
<div class="flex flex-wrap items-center gap-2 text-xs {className}" data-animation-record="">
  {#if editor.recording}
    <button type="button" class="{btn} border-red-500 text-red-600" onclick={() => controller.stopRecording()} data-record-stop="">■ Stop</button>
    <button type="button" class={btn} onclick={() => controller.cancelRecording()} data-record-cancel="">Cancel</button>
    <button type="button" class={btn} onclick={() => controller.toggle()}>{editor.playing ? 'Pause' : 'Resume'}</button>
    <span class="tabular-nums text-red-600" aria-live="polite">● REC {(editor.recording.elapsed / 1000).toFixed(1)} s · {editor.recording.samples} samples</span>
  {:else}
    <button type="button" class={btn} onclick={() => controller.startRecording()} disabled={editor.readOnly} title="Perform changes live on the stage and keep them as a new shot" data-record-start="">● Record</button>
  {/if}
  <span class="flex items-center gap-1" role="radiogroup" aria-label="Drag to">
    Drag to
    {#each MOTION_RECORD_GESTURE_MODES as m (m)}
      <label class="flex items-center gap-0.5"><input type="radio" name="animation-record-mode" checked={mode === m} onchange={() => onmodechange(m)} /> {MODE_LABELS[m]}</label>
    {/each}
  </span>
  {#if pose}
    <span class="flex items-center gap-2" data-record-paint="">
      {#if pose.fill !== undefined}
        <label class="flex items-center gap-1">Fill <input type="color" value={hex6(pose.fill)} oninput={(e) => sample({ fill: e.currentTarget.value })} /></label>
      {/if}
      {#if pose.stroke !== undefined}
        <label class="flex items-center gap-1">Stroke <input type="color" value={hex6(pose.stroke)} oninput={(e) => sample({ stroke: e.currentTarget.value })} /></label>
      {/if}
      <label class="flex items-center gap-1">Opacity <input type="range" min="0" max="1" step="0.01" value={pose.opacity} oninput={(e) => sample({ opacity: Number(e.currentTarget.value) })} /></label>
    </span>
  {/if}
  {#if editor.recording && !node}
    <span class="text-muted-foreground">Drag an element; click one to record its paint and opacity.</span>
  {/if}
  {#if !editor.recording && editor.error && /record/i.test(editor.error)}
    <span class="text-amber-600">{editor.error}</span>
  {/if}
</div>
