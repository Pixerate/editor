<script lang="ts">
  import type { ChartNodeViewState } from '@pixerate/editor';
  import type { ChartTheme } from '@pixerate/editor/chart';
  import ChartCanvas from '../chart/ChartCanvas.svelte';
  import ChartDataGrid from '../chart/ChartDataGrid.svelte';
  import ChartInspector from '../chart/ChartInspector.svelte';
  import { chartButtonClass } from '../chart/styles.js';

  interface Props {
    /** What the editor's `chart` node passes (see `ChartNodeViewState`). */
    view: ChartNodeViewState;
    /** Chart colours (default: the CSS-variable theme). */
    theme?: Partial<ChartTheme>;
    /** Show the data grid under the chart while editing (default `true`). */
    showDataGrid?: boolean;
  }

  let { view, theme, showDataGrid = true }: Props = $props();

  const clickable = $derived(view.editable && !view.editing);

  function open() {
    if (clickable) view.setEditing(true);
  }

  function onkeydown(event: KeyboardEvent) {
    if (view.editing && event.key === 'Escape') {
      event.stopPropagation();
      view.setEditing(false);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="not-prose my-2 rounded-md border bg-background p-1 {view.selected ? 'border-primary ring-1 ring-primary' : 'border-border'}"
  data-chart-node-view=""
  data-editing={view.editing ? '' : undefined}
  {onkeydown}
>
  {#if view.editing}
    <div class="mb-1 flex items-center justify-between gap-2 px-1" data-chart-node-toolbar="">
      <span class="text-xs text-muted-foreground">Editing chart</span>
      <button type="button" class={chartButtonClass} data-action="done" onclick={() => view.setEditing(false)}>Done</button>
    </div>
  {/if}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class={clickable ? 'cursor-pointer' : undefined} onclick={open} title={clickable ? 'Click to edit the chart' : undefined} data-chart-node-canvas="">
    <ChartCanvas controller={view.controller} width={view.width ?? 640} height={view.height} responsive={view.width === null} editable={view.editing} {theme} />
  </div>
  {#if view.editing}
    <!-- Wraps by the document's width, not the viewport's: side by side when there is room. -->
    <div class="mt-2 flex flex-wrap items-start gap-2" data-chart-node-panel="">
      {#if showDataGrid}
        <div class="min-w-0 flex-[1_1_20rem] overflow-x-auto">
          <ChartDataGrid controller={view.controller} />
        </div>
      {/if}
      <ChartInspector controller={view.controller} class="max-h-96 min-w-0 flex-[1_1_16rem] overflow-y-auto rounded-md border border-border p-3" />
    </div>
  {/if}
</div>
