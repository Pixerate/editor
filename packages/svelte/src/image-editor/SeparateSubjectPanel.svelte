<script lang="ts">
  import ImageCheckbox from './controls/ImageCheckbox.svelte';
  import type { ImageEditorController, SelectionMask } from '@pixerate/editor/image-editor';

  /**
   * Separate Subject: the selected subject onto its own masked layer over a background plate with
   * the subject's area filled, in one undo step, as the `separate_subject` tool does. Shows progress
   * while the fill runs and can be cancelled.
   */
  interface Props {
    controller: ImageEditorController;
    /** The current selection (`state.selection`): the subject to separate. */
    selection?: SelectionMask | null;
    class?: string;
  }

  let { controller, selection, class: className = '' }: Props = $props();

  const button =
    'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
  const sel = $derived(selection === undefined ? controller.getSelection() : selection);
  let dilate = $state(8);
  let fill = $state(true);
  let progress = $state<string | null>(null);
  let error = $state<string | null>(null);
  let abort: AbortController | null = null;

  async function run() {
    error = null;
    const ctl = new AbortController();
    abort = ctl;
    progress = 'Starting';
    try {
      await controller.separateSubject({
        dilate,
        fill: fill ? 'content-aware' : 'none',
        signal: ctl.signal,
        onProgress: (fraction, stage) => (progress = `${stage ?? 'Filling'} ${Math.round(fraction * 100)}%`),
      });
    } catch (err) {
      if (!ctl.signal.aborted) error = err instanceof Error ? err.message : String(err);
    } finally {
      abort = null;
      progress = null;
    }
  }
</script>

<div data-testid="separate-subject" class="flex flex-col gap-1.5 text-xs {className}">
  <span class="font-semibold text-foreground uppercase tracking-wider text-[11px]">Separate Subject</span>
  <p class="text-muted-foreground">The selection onto its own masked layer, over the background with the subject filled out.</p>
  <div class="flex flex-wrap items-center gap-2">
    <label class="flex items-center gap-1 text-muted-foreground">
      Grow
      <input
        type="number"
        min="0"
        max="200"
        aria-label="Separate grow"
        value={dilate}
        oninput={(e) => (dilate = Math.min(200, Math.max(0, Number((e.currentTarget as HTMLInputElement).value) || 0)))}
        class="w-12 bg-background border border-border rounded px-1 py-0.5 text-foreground"
      />
      px
    </label>
    <label class="flex items-center gap-1 text-foreground">
      <ImageCheckbox label="Fill the background" checked={fill} onchange={(on) => (fill = on)} />
      Fill the background
    </label>
  </div>
  <div class="flex gap-1">
    <button type="button" class={button} disabled={!sel || progress !== null} onclick={run}>Separate Subject</button>
    {#if progress !== null}
      <button type="button" class={button} onclick={() => abort?.abort()}>Cancel</button>
    {/if}
  </div>
  {#if progress !== null}
    <p role="status" class="text-muted-foreground">{progress}</p>
  {/if}
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
