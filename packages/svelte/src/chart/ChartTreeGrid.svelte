<script lang="ts">
  import {
    addChartTreeRow,
    chartTreeColumnLabels,
    chartTreeDepth,
    chartTreeToRows,
    formatChartNumber,
    removeChartTreeRow,
    setChartTreeRowName,
    setChartTreeRowValue,
    type ChartController
  } from '@pixerate/editor/chart';
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
  const spec = $derived(view.current.spec);
  // `+ Level` raises the column count; it stays until the grid is unmounted, so a new column can be filled in.
  let columns = $state(1);
  const rows = $derived(chartTreeToRows(spec.tree));
  const depth = $derived(Math.max(columns, chartTreeDepth(spec.tree)));
  const labels = $derived(chartTreeColumnLabels(depth));

  const commit = (next: Parameters<ChartController['setTreeRows']>[0]) => controller.setTreeRows(next).ok;
</script>

<!-- Grouped data as a table: the names from the group down to each item, then its value. -->
<div class="overflow-auto rounded-md border border-border {className}" data-chart-grid="" data-chart-tree-grid="">
  <table class="w-full border-collapse text-xs">
    <thead class="bg-muted/50">
      <tr>
        {#each labels as label (label)}
          <th class="border-b border-r border-border px-2 py-1 text-left font-medium text-muted-foreground">{label}</th>
        {/each}
        <th class="border-b border-r border-border px-2 py-1 text-right font-medium text-muted-foreground">Value</th>
        {#if !readOnly}<th class="w-8 border-b border-border"></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, r (r)}
        <tr data-tree-row={r}>
          {#each labels as label, k (k)}
            <td class="border-b border-r border-border p-0">
              <ChartCommitInput
                value={row.path[k] ?? ''}
                aria-label="{label}, row {r + 1}"
                data-tree-cell="{r}:{k}"
                readonly={readOnly}
                oncommit={(name) => commit(setChartTreeRowName(rows, r, k, name))}
                class="{chartCellClass} text-left"
              />
            </td>
          {/each}
          <td class="border-b border-r border-border p-0">
            <ChartCommitInput
              value={String(row.value)}
              inputmode="decimal"
              aria-label="Value of {row.path.join(' / ')}"
              title={formatChartNumber(row.value, spec.yAxis.format)}
              data-tree-value={r}
              readonly={readOnly}
              oncommit={(text) => commit(setChartTreeRowValue(rows, r, text))}
              class={chartCellClass}
            />
          </td>
          {#if !readOnly}
            <td class="border-b border-border px-1">
              <button type="button" class={chartIconButtonClass} title="Delete item" aria-label="Delete {row.path.join(' / ')}" data-action="tree-remove-row" onclick={() => commit(removeChartTreeRow(rows, r))}>×</button>
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !readOnly}
    <div class="flex flex-wrap gap-1 p-1">
      <button type="button" class="{chartButtonClass} h-6 border-dashed" data-action="tree-add-row" onclick={() => commit(addChartTreeRow(rows))}>+ Add item</button>
      <button type="button" class="{chartButtonClass} h-6 border-dashed" data-action="tree-add-level" disabled={depth >= 6} onclick={() => (columns = depth + 1)}>+ Level</button>
      <span class="flex-1"></span>
      <button type="button" class="{chartButtonClass} h-6" data-action="tree-ungroup" title="Keep the group totals as plain data" onclick={() => controller.setTree([])}>Ungroup</button>
    </div>
  {/if}
</div>
