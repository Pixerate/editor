<script lang="ts">
  import { formatVideoTimecode, parseVideoPreviewScale, VIDEO_PREVIEW_SCALE_OPTIONS, videoProjectHasProxies, type VideoEditorController } from '@pixerate/editor/video-editor';
  import { videoEditorStateOf } from './createVideoEditor.svelte.js';

  interface Props {
    controller: VideoEditorController;
    /** Show the editing buttons: split, delete, ripple delete, undo and redo (default true). */
    editable?: boolean;
    class?: string;
  }

  let { controller, editable = true, class: className = '' }: Props = $props();
  const view = videoEditorStateOf(() => controller);
  const editor = $derived(view.current);
  const fps = $derived(editor.project.fps);
  const btn = 'rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40';
  const locked = $derived(editor.readOnly);
</script>

<!-- Play / pause, frame steps, the playhead's timecode, a preview size when there are proxies, and split, delete, undo and redo. -->
<div class="flex flex-wrap items-center gap-1.5 text-xs {className}" data-video-transport="">
  <button type="button" class={btn} aria-label="Step back one frame" onclick={() => controller.step(-1)} data-step-back="">◀︎|</button>
  <button type="button" class={btn} aria-label={editor.playing ? 'Pause' : 'Play'} onclick={() => controller.toggle()} disabled={editor.duration <= 0} data-play="">
    {editor.playing ? 'Pause' : 'Play'}
  </button>
  <button type="button" class={btn} aria-label="Step forward one frame" onclick={() => controller.step(1)} data-step-forward="">|▶︎</button>
  <span class="tabular-nums text-muted-foreground" data-timecode="">{formatVideoTimecode(editor.time, fps)} / {formatVideoTimecode(editor.duration, fps)}</span>
  {#if videoProjectHasProxies(editor.project)}
    <select class="rounded border border-border bg-transparent px-1 py-0.5 text-xs" value={String(editor.previewScale)} onchange={(e) => controller.setPreviewScale(parseVideoPreviewScale(e.currentTarget.value))} aria-label="Preview size" title="Play proxies in the preview (the export always uses the originals)" data-preview-scale="">
      {#each VIDEO_PREVIEW_SCALE_OPTIONS as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </select>
  {/if}
  {#if editable}
    <span class="ml-auto flex flex-wrap gap-1">
      <button type="button" class={btn} disabled={locked} onclick={() => controller.splitAtPlayhead()} title="Split at the playhead (S)" data-split="">Split</button>
      <button type="button" class={btn} disabled={locked || !editor.selection.length} onclick={() => controller.deleteSelection()} title="Delete the selected clips (Delete)" data-delete="">Delete</button>
      <button type="button" class={btn} disabled={locked || !editor.selection.length} onclick={() => controller.deleteSelection({ ripple: true })} title="Delete and close the gaps (Shift+Delete)" data-ripple-delete="">Ripple delete</button>
      <button type="button" class={btn} disabled={locked || !editor.canUndo} onclick={() => controller.undo()} title={editor.canUndo ? `Undo ${editor.undoLabel}` : 'Nothing to undo'} data-undo="">Undo</button>
      <button type="button" class={btn} disabled={locked || !editor.canRedo} onclick={() => controller.redo()} title={editor.canRedo ? `Redo ${editor.redoLabel}` : 'Nothing to redo'} data-redo="">Redo</button>
    </span>
  {/if}
</div>
