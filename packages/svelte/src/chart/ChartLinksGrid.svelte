<script lang="ts">
  import { addChartLink, setChartLinkField, type ChartController } from '@pixerate/editor/chart';
  import ChartCommitInput from './ChartCommitInput.svelte';
  import { chartStateOf } from './createChartEditor.svelte.js';
  import { chartButtonClass, chartCellClass, chartIconButtonClass } from './styles.js';

  interface Props {
    controller: ChartController;
    /** Hide the add / delete buttons. */
    readOnly?: boolean;
    class?: string;
  }

  let { controller, readOnly = false, class: className = '' }: Props = $props();

  const view = chartStateOf(() => controller);
  const links = $derived(view.current.spec.links);
  const commit = (next: unknown) => controller.setLinks(next).ok;
  const fields = ['source', 'target'] as const;
</script>

<!-- Flows as a table: source, target and value per row. Edits are checked as a whole (no loops, no repeated pairs). -->
<div class="overflow-auto rounded-md border border-border {className}" data-chart-grid="" data-chart-links-grid="">
  <table class="w-full border-collapse text-xs">
    <thead class="bg-muted/50">
      <tr>
        <th class="border-b border-r border-border px-2 py-1 text-left font-medium text-muted-foreground">Source</th>
        <th class="border-b border-r border-border px-2 py-1 text-left font-medium text-muted-foreground">Target</th>
        <th class="border-b border-r border-border px-2 py-1 text-right font-medium text-muted-foreground">Value</th>
        {#if !readOnly}<th class="w-8 border-b border-border"></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each links as link, i (i)}
        <tr data-link-row={i}>
          {#each fields as field (field)}
            <td class="border-b border-r border-border p-0">
              <ChartCommitInput value={link[field]} aria-label="{field === 'source' ? 'Source' : 'Target'} of flow {i + 1}" data-link-cell="{i}:{field}" readonly={readOnly} oncommit={(text) => commit(setChartLinkField(links, i, field, text))} class="{chartCellClass} text-left" />
            </td>
          {/each}
          <td class="border-b border-r border-border p-0">
            <ChartCommitInput value={String(link.value)} inputmode="decimal" aria-label="Value of {link.source} → {link.target}" data-link-cell="{i}:value" readonly={readOnly} oncommit={(text) => commit(setChartLinkField(links, i, 'value', text))} class={chartCellClass} />
          </td>
          {#if !readOnly}
            <td class="border-b border-border px-1">
              <button type="button" class={chartIconButtonClass} title="Delete flow" aria-label="Delete {link.source} → {link.target}" data-action="link-remove" onclick={() => controller.removeLink(i)}>×</button>
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !readOnly}
    <div class="flex flex-wrap gap-1 p-1">
      <button type="button" class="{chartButtonClass} h-6 border-dashed" data-action="link-add" onclick={() => commit(addChartLink(links))}>+ Add flow</button>
      <span class="flex-1"></span>
      {#if links.length}
        <button type="button" class="{chartButtonClass} h-6" data-action="links-clear" title="Keep how much passes through each node as plain data" onclick={() => controller.setLinks([])}>Remove flows</button>
      {/if}
    </div>
  {/if}
</div>
