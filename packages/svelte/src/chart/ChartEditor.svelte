<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { describeChartSelection, downloadChartPng, type ChartController, type DownloadChartPngOptions } from '@pixerate/editor/chart';
  import ChartCanvas from './ChartCanvas.svelte';
  import ChartDataGrid from './ChartDataGrid.svelte';
  import ChartInspector from './ChartInspector.svelte';
  import { chartStateOf } from './createChartEditor.svelte.js';
  import { chartButtonClass } from './styles.js';

  interface Props {
    controller: ChartController;
    /** The settings sidebar (default `true`). */
    showInspector?: boolean;
    /** The data grid under the chart (default `true`). */
    showDataGrid?: boolean;
    /** Undo / redo, Download PNG and the selection readout (default `true`). */
    showToolbar?: boolean;
    /** Size, theme, scale and file name for the toolbar's Download PNG (default 800 × 450, light theme). */
    pngOptions?: DownloadChartPngOptions;
    /** Chart height in pixels (default 380). */
    height?: number;
    canvasProps?: Omit<ComponentProps<typeof ChartCanvas>, 'controller' | 'height'>;
    class?: string;
  }

  let { controller, showInspector = true, showDataGrid = true, showToolbar = true, pngOptions, height = 380, canvasProps = {}, class: className = '' }: Props = $props();

  const view = chartStateOf(() => controller);
  const state = $derived(view.current);
  let pngError = $state<string | null>(null);
  function downloadPng() {
    pngError = null;
    downloadChartPng(controller.toJSON(), pngOptions).catch((error: unknown) => (pngError = error instanceof Error ? error.message : String(error)));
  }
</script>

<div class="flex flex-col gap-2 {className}" data-chart-editor="">
  {#if showToolbar}
    <div class="flex items-center gap-1" data-chart-toolbar="">
      <button type="button" class={chartButtonClass} disabled={!state.canUndo} title={state.undoLabel ? `Undo ${state.undoLabel}` : 'Undo'} data-action="undo" onclick={() => controller.undo()}>Undo</button>
      <button type="button" class={chartButtonClass} disabled={!state.canRedo} title={state.redoLabel ? `Redo ${state.redoLabel}` : 'Redo'} data-action="redo" onclick={() => controller.redo()}>Redo</button>
      <button type="button" class={chartButtonClass} title="Download the chart as a PNG image" data-action="download-png" onclick={downloadPng}>Download PNG</button>
      <span class="ml-2 truncate text-xs text-muted-foreground" data-chart-selection="" aria-live="polite">{describeChartSelection(controller, state.selection)}</span>
    </div>
  {/if}
  {#if pngError}
    <p role="alert" class="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-chart-png-error="">{pngError}</p>
  {/if}
  {#if state.issues.length > 0}
    <p role="alert" class="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" data-chart-issues="">
      {state.issues.map((i) => i.message).join(' ')}
    </p>
  {/if}
  <div class="flex min-h-0 flex-col gap-2 md:flex-row">
    <div class="min-w-0 flex-1 rounded-md border border-border bg-background p-1">
      <ChartCanvas {controller} {height} {...canvasProps} />
    </div>
    {#if showInspector}
      <ChartInspector {controller} class="w-full shrink-0 overflow-y-auto rounded-md border border-border p-3 md:w-64" />
    {/if}
  </div>
  {#if showDataGrid}
    <ChartDataGrid {controller} />
  {/if}
</div>
