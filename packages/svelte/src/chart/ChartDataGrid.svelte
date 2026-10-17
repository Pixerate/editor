<script lang="ts">
  import { chartColorInputValue, chartSeriesColor, formatChartNumber, type ChartController } from '@pixerate/editor/chart';
  import ChartCommitInput from './ChartCommitInput.svelte';
  import { chartStateOf } from './createChartEditor.svelte.js';
  import { chartButtonClass, chartCellClass, chartIconButtonClass, chartInputClass } from './styles.js';

  interface Props {
    controller: ChartController;
    /** Header of the category column (default "Category"). */
    categoryHeader?: string;
    /** Hide the add / delete buttons. */
    readOnly?: boolean;
    class?: string;
  }

  let { controller, categoryHeader = 'Category', readOnly = false, class: className = '' }: Props = $props();

  const view = chartStateOf(() => controller);
  const spec = $derived(view.current.spec);
  const selection = $derived(view.current.selection);

  const cellText = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

  // Pasting TSV / CSV fills and grows the grid from the cell.
  const paste = (row: number, column: number) => (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!/[\t\n]/.test(text.replace(/\n$/, ''))) return;
    e.preventDefault();
    controller.pasteCells(row, column, text);
  };
</script>

<div class="overflow-auto rounded-md border border-border {className}" data-chart-grid="">
  <table class="w-full border-collapse text-xs">
    <thead class="bg-muted/50">
      <tr>
        <th class="border-b border-r border-border px-2 py-1 text-left font-medium text-muted-foreground">{categoryHeader}</th>
        {#each spec.series as s, si (s.id)}
          {@const selected = selection?.kind === 'series' && selection.seriesId === s.id}
          <th data-series-id={s.id} class="border-b border-r border-border px-1 py-1 font-medium {selected ? 'bg-primary/10' : ''}">
            <div class="flex items-center gap-1">
              <input
                type="color"
                aria-label="{s.name} colour"
                value={chartColorInputValue(chartSeriesColor(spec, si))}
                disabled={readOnly}
                onpointerdown={() => controller.beginGesture(`color:${s.id}`)}
                oninput={(e) => controller.updateSeries(s.id, { color: e.currentTarget.value })}
                onblur={() => controller.endGesture()}
                class="h-5 w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
              />
              <ChartCommitInput
                value={s.name}
                aria-label="Series name"
                onfocus={() => controller.select({ kind: 'series', seriesId: s.id })}
                oncommit={(name) => void controller.updateSeries(s.id, { name })}
                class="{chartInputClass} h-6 min-w-[5rem] border-transparent bg-transparent font-medium {s.hidden ? 'text-muted-foreground line-through' : ''}"
              />
              {#if !readOnly}
                <button
                  type="button"
                  class={chartIconButtonClass}
                  title={s.hidden ? 'Show series' : 'Hide series'}
                  aria-label={s.hidden ? `Show ${s.name}` : `Hide ${s.name}`}
                  aria-pressed={!s.hidden}
                  data-action="toggle-series"
                  onclick={() => controller.toggleSeries(s.id)}>{s.hidden ? '○' : '●'}</button
                >
                <button type="button" class={chartIconButtonClass} title="Delete series" aria-label="Delete {s.name}" data-action="remove-series" onclick={() => controller.removeSeries(s.id)}>×</button>
              {/if}
            </div>
          </th>
        {/each}
        {#if !readOnly}
          <th class="w-8 border-b border-border px-1">
            <button type="button" class={chartIconButtonClass} title="Add series" aria-label="Add series" data-action="add-series" onclick={() => controller.addSeries()}>+</button>
          </th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each spec.categories as category, i (i)}
        {@const rowSelected = selection?.kind === 'category' && selection.index === i}
        <tr data-category-index={i} class={rowSelected ? 'bg-primary/10' : undefined}>
          <th class="border-b border-r border-border p-0 text-left font-normal">
            <ChartCommitInput
              value={category}
              aria-label="Category {i + 1}"
              onfocus={() => controller.select({ kind: 'category', index: i })}
              onpaste={paste(i, -1)}
              oncommit={(label) => void controller.renameCategory(i, label)}
              class="{chartCellClass} text-left"
            />
          </th>
          {#each spec.series as s, si (s.id)}
            {@const value = s.values[i]}
            {@const selected = selection?.kind === 'point' && selection.seriesId === s.id && selection.index === i}
            <td class="border-b border-r border-border p-0 {selected ? 'bg-primary/10' : ''}">
              <ChartCommitInput
                value={cellText(value)}
                inputmode="decimal"
                aria-label="{s.name}, {category}"
                title={value === null ? undefined : formatChartNumber(value, spec.yAxis.format)}
                data-cell="{s.id}:{i}"
                onfocus={() => controller.select({ kind: 'point', seriesId: s.id, index: i })}
                onpaste={paste(i, si)}
                oncommit={(text) => controller.setValue(s.id, i, text).ok}
                class={chartCellClass}
              />
            </td>
          {/each}
          {#if !readOnly}
            <td class="border-b border-border px-1">
              <button type="button" class={chartIconButtonClass} title="Delete category" aria-label="Delete {category}" data-action="remove-category" onclick={() => controller.removeCategory(i)}>×</button>
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
  {#if !readOnly}
    <div class="p-1">
      <button type="button" class="{chartButtonClass} h-6 border-dashed" data-action="add-category" onclick={() => controller.addCategory()}>+ Add category</button>
    </div>
  {/if}
</div>
