<script lang="ts">
  import type { ImageEditorController, SelectionDiff, SelectionMask } from '@pixerate/editor/image-editor';

  /**
   * Show Last Change: what the last step did to the selection, as the `compare_selections` tool
   * reports it, with the added area tinted green and the removed red on the canvas until the
   * selection changes again.
   */
  interface Props {
    controller: ImageEditorController;
    /** The current selection (`state.selection`): the summary clears when it changes. */
    selection?: SelectionMask | null;
    class?: string;
  }

  let { controller, selection, class: className = '' }: Props = $props();

  const button =
    'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
  const sel = $derived(selection === undefined ? controller.getSelection() : selection);
  let result = $state<{ diff: SelectionDiff; for: SelectionMask | null } | null>(null);
  let error = $state<string | null>(null);
  const diff = $derived(result && result.for === sel ? result.diff : null);

  function show() {
    error = null;
    try {
      result = { diff: controller.compareSelections(), for: sel };
    } catch (err) {
      result = null;
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div data-testid="selection-change-check" class="flex flex-col gap-1 text-xs {className}">
  <button type="button" class="{button} self-start" onclick={show}>Show Last Change</button>
  {#if diff}
    <p data-testid="selection-change-summary" class="text-foreground">
      {#if diff.identical}
        The last step did not change the selection.
      {:else}
        <span class="text-green-600">+{diff.added.area} px</span> <span class="text-destructive">−{diff.removed.area} px</span>, overlap {Math.round(diff.iou * 100)}%
      {/if}
    </p>
  {/if}
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
