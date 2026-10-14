<script lang="ts">
  import type { SpreadsheetRowGroup, SpreadsheetViewColumn } from '@pixerate/editor/spreadsheet';

  interface Props {
    group: SpreadsheetRowGroup;
    columns: SpreadsheetViewColumn[];
    /** Column the rows are grouped by: shows the group label and toggle. */
    groupColId: string;
    onToggle: (key: string) => void;
    /** Render a trailing cell for the "add column" column. */
    trailingCell?: boolean;
  }

  let { group, columns, groupColId, onToggle, trailingCell = false }: Props = $props();

  // The label goes in the grouping column, or the first column when that one is hidden.
  let labelColId = $derived(columns.some((c) => c.column.id === groupColId) ? groupColId : columns[0]?.column.id);

  const formatSummary = (value: number | null) => (value === null ? '–' : String(value));
</script>

<!-- A category header row: collapse toggle, label, row count and per-column summaries. -->
<tr class="border-b border-border bg-muted/40 font-semibold" data-group-key={group.key} style="height: 28px;">
  <td class="w-12 min-w-[3rem] sticky left-0 z-10 bg-muted border-r border-border text-center">
    <button
      type="button"
      aria-label="{group.collapsed ? 'Expand' : 'Collapse'} group {group.label}"
      aria-expanded={!group.collapsed}
      class="h-5 w-5 rounded text-[10px] text-muted-foreground hover:bg-muted"
      onclick={(e) => {
        e.stopPropagation();
        onToggle(group.key);
      }}
    >
      {group.collapsed ? '▸' : '▾'}
    </button>
  </td>
  {#each columns as { column } (column.id)}
    {@const summary = group.summaries[column.id]}
    <td class="border-r border-border px-2 py-1 truncate max-w-0 text-foreground" style="max-width: 0; overflow: hidden;">
      {#if column.id === labelColId}
        <span class="truncate">
          {group.label} <span class="font-normal text-muted-foreground">({group.rowIndices.length})</span>
        </span>
      {:else if summary !== undefined}
        <span class="truncate" data-summary={column.id}>{formatSummary(summary)}</span>
      {/if}
    </td>
  {/each}
  {#if trailingCell}
    <td class="w-10 min-w-[2.5rem] bg-muted/10 border-r border-border"></td>
  {/if}
  <!-- Spacer cell to absorb remaining table width -->
  <td class="border-b border-border bg-transparent p-0"></td>
</tr>
