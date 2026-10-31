<script lang="ts">
  import type { ImageEditorController, MaskEdgeReport, MaskEdgeTarget, SelectionMask } from '@pixerate/editor/image-editor';
  import { MASK_EDGE_THRESHOLDS } from '@pixerate/editor/image-editor';

  /**
   * Check Edge: measures the selection's (or a mask's) edge, as the `inspect_mask_edge` tool does,
   * and lists the scores (flagged past the thresholds), holes, islands and findings with fixes.
   */
  interface Props {
    controller: ImageEditorController;
    /** The current selection (`state.selection`): a report on an older selection is cleared. */
    selection?: SelectionMask | null;
    /** What to check (default the selection); masks need `layerId`. */
    target?: MaskEdgeTarget;
    layerId?: string;
    class?: string;
  }

  let { controller, selection, target = 'selection', layerId, class: className = '' }: Props = $props();

  const button =
    'px-2 py-1 rounded-md border border-border bg-background text-[11px] text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40';
  const sel = $derived(selection === undefined ? controller.getSelection() : selection);
  let result = $state<{ report: MaskEdgeReport; for: SelectionMask | null } | null>(null);
  let error = $state<string | null>(null);
  const report = $derived(result && (target !== 'selection' || result.for === sel) ? result.report : null);
  const T = MASK_EDGE_THRESHOLDS;
  const rows = $derived(
    report
      ? [
          { label: 'Halo', value: report.haloScore, bad: report.haloScore >= T.halo },
          { label: 'Edge alignment', value: report.edgeAlignment, bad: report.edgeAlignment < T.alignment },
          { label: 'Jaggedness', value: report.jaggedness, bad: report.jaggedness >= T.jaggedness },
          { label: 'Soft edge', value: report.softFraction, bad: report.softFraction >= T.soft },
        ]
      : []
  );

  function check() {
    error = null;
    try {
      result = { report: controller.inspectMaskEdge(target, { layerId }), for: sel };
    } catch (err) {
      result = null;
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div data-testid="mask-edge-check" class="flex flex-col gap-1.5 text-xs {className}">
  <button type="button" class="{button} self-start" disabled={target === 'selection' && !sel} onclick={check}>Check Edge</button>
  {#if report}
    <dl class="grid grid-cols-[1fr_auto] gap-x-2 gap-y-0.5">
      {#each rows as r (r.label)}
        <dt class="text-muted-foreground">{r.label}</dt>
        <dd class="font-mono text-right {r.bad ? 'text-destructive' : 'text-foreground'}">{r.value}</dd>
      {/each}
      <dt class="text-muted-foreground">Holes / islands</dt>
      <dd class="font-mono text-right {report.holes.count || report.islands.count ? 'text-destructive' : 'text-foreground'}">
        {report.holes.count} / {report.islands.count}
      </dd>
    </dl>
    {#if report.issues.length}
      <ul data-testid="mask-edge-issues" class="list-disc pl-4 flex flex-col gap-1 text-foreground">
        {#each report.issues as s (s)}
          <li>{s}</li>
        {/each}
      </ul>
    {:else}
      <p class="text-muted-foreground">The edge looks clean.</p>
    {/if}
  {/if}
  {#if error}
    <p role="alert" class="text-destructive">{error}</p>
  {/if}
</div>
