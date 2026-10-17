<script lang="ts" module>
  // A counter keeps label ids unique per inspector. Pass `idPrefix` for ids that match
  // between server and client renders.
  let nextId = 0;

  export type ChartInspectorSection = 'type' | 'titles' | 'options' | 'legend' | 'axes' | 'series';
</script>

<script lang="ts">
  import {
    CHART_CURVES,
    CHART_LEGEND_POSITIONS,
    CHART_NUMBER_STYLES,
    CHART_SERIES_TYPES,
    CHART_STACKINGS,
    CHART_TYPE_LABELS,
    CHART_TYPES,
    chartColorInputValue,
    chartSeriesColor,
    chartSeriesType,
    isCartesianChart,
    type ChartAxis,
    type ChartController,
    type ChartNumberFormat,
    type ChartSeriesType
  } from '@pixerate/editor/chart';
  import ChartCommitInput from './ChartCommitInput.svelte';
  import { chartStateOf } from './createChartEditor.svelte.js';
  import { chartButtonClass, chartInputClass, chartLabelClass, chartSectionClass, chartSegmentClass } from './styles.js';

  interface Props {
    controller: ChartController;
    /** Which sections to show (default: all that apply to the chart). */
    sections?: readonly ChartInspectorSection[];
    /** Prefix for the inspector's element ids. */
    idPrefix?: string;
    class?: string;
  }

  let { controller, sections, idPrefix = `pixerate-chart-${++nextId}`, class: className = '' }: Props = $props();

  const view = chartStateOf(() => controller);
  const spec = $derived(view.current.spec);
  const selectedSeries = $derived(view.current.selectedSeries);
  const show = (section: ChartInspectorSection) => !sections || sections.includes(section);
  const cartesian = $derived(isCartesianChart(spec.type));
  const types = $derived(spec.series.map((s) => chartSeriesType(spec, s)));
  const hasBars = $derived(cartesian && types.includes('bar'));
  const hasLines = $derived(cartesian && types.some((t) => t === 'line' || t === 'area'));
  const seriesIndex = $derived(selectedSeries ? spec.series.findIndex((s) => s.id === selectedSeries.id) : -1);
  const horizontal = $derived(spec.orientation === 'horizontal');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const stackingLabels: Record<string, string> = { none: 'None', stacked: 'Stacked', percent: '100%' };

  const setAxis = (axis: 'x' | 'y', patch: Partial<ChartAxis>) => controller.setAxis(axis, patch);
  const setFormat = (patch: Partial<ChartNumberFormat>) => setAxis('y', { format: { ...spec.yAxis.format, ...patch } });
  const commitBound = (key: 'min' | 'max') => (text: string) => setAxis('y', { [key]: text.trim() === '' ? null : Number(text) }).ok;
  function commitDecimals(text: string) {
    const format = { ...spec.yAxis.format };
    if (text.trim() === '') delete format.decimals;
    else format.decimals = Number(text);
    return setAxis('y', { format }).ok;
  }
</script>

{#snippet toggle(label: string, name: string, checked: boolean, onchange: (checked: boolean) => void)}
  <label class="flex cursor-pointer items-center gap-2 text-xs text-foreground">
    <input type="checkbox" class="h-3.5 w-3.5 accent-primary" {checked} data-option={name} onchange={(e) => onchange(e.currentTarget.checked)} />
    {label}
  </label>
{/snippet}

{#snippet axisSection(axis: 'x' | 'y', value: ChartAxis)}
  <div class={chartSectionClass} data-section="axis-{axis}">
    <div class="flex items-center justify-between">
      <h4 class="text-xs font-semibold text-foreground">
        {axis === 'x' ? 'Category axis' : 'Value axis'}
        <span class="ml-1 font-normal text-muted-foreground">({axis === 'x' ? (horizontal ? 'left' : 'bottom') : horizontal ? 'bottom' : 'left'})</span>
      </h4>
      {@render toggle('Show', `${axis}Axis.show`, value.show, (v) => setAxis(axis, { show: v }))}
    </div>
    <div class="flex items-center gap-2">
      <label for="{idPrefix}-{axis}-title" class="{chartLabelClass} w-20 shrink-0">Title</label>
      <div class="min-w-0 flex-1">
        <ChartCommitInput id="{idPrefix}-{axis}-title" value={value.title} data-option="{axis}Axis.title" oncommit={(title) => void setAxis(axis, { title })} />
      </div>
    </div>
    {@render toggle('Grid lines', `${axis}Axis.gridlines`, value.gridlines, (v) => setAxis(axis, { gridlines: v }))}
    {#if axis === 'y'}
      <div class="flex items-center gap-2">
        <span class="{chartLabelClass} w-20 shrink-0">Min / max</span>
        <div class="flex min-w-0 flex-1 gap-1">
          <ChartCommitInput id="{idPrefix}-y-min" value={value.min === null ? '' : String(value.min)} placeholder="Auto" inputmode="decimal" data-option="yAxis.min" oncommit={commitBound('min')} />
          <ChartCommitInput id="{idPrefix}-y-max" value={value.max === null ? '' : String(value.max)} placeholder="Auto" inputmode="decimal" data-option="yAxis.max" oncommit={commitBound('max')} />
        </div>
      </div>
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-y-format" class="{chartLabelClass} w-20 shrink-0">Format</label>
        <div class="flex min-w-0 flex-1 gap-1">
          <select
            id="{idPrefix}-y-format"
            class={chartInputClass}
            value={value.format.style ?? 'number'}
            data-option="yAxis.format.style"
            onchange={(e) => setFormat({ style: e.currentTarget.value as ChartNumberFormat['style'] })}
          >
            {#each CHART_NUMBER_STYLES as style (style)}
              <option value={style}>{cap(style)}</option>
            {/each}
          </select>
          <ChartCommitInput
            value={value.format.decimals === undefined ? '' : String(value.format.decimals)}
            placeholder="Auto"
            aria-label="Decimals"
            title="Decimals"
            inputmode="numeric"
            data-option="yAxis.format.decimals"
            class="{chartInputClass} w-14 shrink-0"
            oncommit={commitDecimals}
          />
        </div>
      </div>
      {#if value.format.style === 'currency'}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-y-currency" class="{chartLabelClass} w-20 shrink-0">Currency</label>
          <div class="min-w-0 flex-1">
            <ChartCommitInput id="{idPrefix}-y-currency" value={value.format.currency ?? 'USD'} data-option="yAxis.format.currency" oncommit={(c) => void setFormat({ currency: c.toUpperCase() })} />
          </div>
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

<div class="space-y-3 text-xs {className}" data-chart-inspector="">
  {#if show('type')}
    <div class={chartSectionClass} data-section="type">
      <div class="grid grid-cols-3 gap-0.5 rounded-md bg-muted p-0.5" role="radiogroup" aria-label="Chart type">
        {#each CHART_TYPES as type (type)}
          <button type="button" role="radio" aria-checked={spec.type === type} data-chart-type={type} class={chartSegmentClass(spec.type === type)} onclick={() => controller.setType(type)}>
            {CHART_TYPE_LABELS[type]}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if show('titles')}
    <div class={chartSectionClass} data-section="titles">
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-title" class="{chartLabelClass} w-20 shrink-0">Title</label>
        <div class="min-w-0 flex-1">
          <ChartCommitInput id="{idPrefix}-title" value={spec.title} data-option="title" oncommit={(title) => void controller.setTitle(title)} />
        </div>
      </div>
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-subtitle" class="{chartLabelClass} w-20 shrink-0">Subtitle</label>
        <div class="min-w-0 flex-1">
          <ChartCommitInput id="{idPrefix}-subtitle" value={spec.subtitle} data-option="subtitle" oncommit={(subtitle) => void controller.setSubtitle(subtitle)} />
        </div>
      </div>
    </div>
  {/if}

  {#if show('options')}
    <div class={chartSectionClass} data-section="options">
      {#if cartesian}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-stacking" class="{chartLabelClass} w-20 shrink-0">Stacking</label>
          <select
            id="{idPrefix}-stacking"
            class={chartInputClass}
            value={spec.stacking}
            data-option="stacking"
            onchange={(e) => controller.update({ stacking: e.currentTarget.value as (typeof CHART_STACKINGS)[number] })}
          >
            {#each CHART_STACKINGS as s (s)}
              <option value={s}>{stackingLabels[s]}</option>
            {/each}
          </select>
        </div>
      {/if}
      {#if hasBars}
        <div class="flex items-center gap-2">
          <span class="{chartLabelClass} w-20 shrink-0">Bars</span>
          <div class="flex min-w-0 flex-1 gap-0.5 rounded-md bg-muted p-0.5">
            {#each ['vertical', 'horizontal'] as const as o (o)}
              <button type="button" aria-pressed={spec.orientation === o} data-option="orientation.{o}" class={chartSegmentClass(spec.orientation === o)} onclick={() => controller.update({ orientation: o })}>
                {cap(o)}
              </button>
            {/each}
          </div>
        </div>
      {/if}
      {#if hasLines}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-curve" class="{chartLabelClass} w-20 shrink-0">Lines</label>
          <select id="{idPrefix}-curve" class={chartInputClass} value={spec.curve} data-option="curve" onchange={(e) => controller.update({ curve: e.currentTarget.value as (typeof CHART_CURVES)[number] })}>
            {#each CHART_CURVES as c (c)}
              <option value={c}>{cap(c)}</option>
            {/each}
          </select>
        </div>
      {/if}
      {#if spec.type === 'donut'}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-hole" class="{chartLabelClass} w-20 shrink-0">Hole</label>
          <input
            id="{idPrefix}-hole"
            type="range"
            min="0"
            max="0.9"
            step="0.05"
            value={spec.innerRadius}
            data-option="innerRadius"
            class="w-full accent-primary"
            onpointerdown={() => controller.beginGesture('innerRadius')}
            onpointerup={() => controller.endGesture()}
            oninput={(e) => controller.update({ innerRadius: Number(e.currentTarget.value) })}
          />
        </div>
      {/if}
      <div class="flex flex-wrap gap-x-4 gap-y-1">
        {#if hasLines}
          {@render toggle('Points', 'points', spec.points, (points) => controller.update({ points }))}
        {/if}
        {@render toggle('Data labels', 'dataLabels', spec.dataLabels, (dataLabels) => controller.update({ dataLabels }))}
      </div>
    </div>
  {/if}

  {#if show('legend')}
    <div class={chartSectionClass} data-section="legend">
      <div class="flex items-center justify-between">
        <h4 class="text-xs font-semibold text-foreground">Legend</h4>
        {@render toggle('Show', 'legend.show', spec.legend.show, (v) => controller.setLegend({ show: v }))}
      </div>
      {#if spec.legend.show}
        <div class="flex gap-0.5 rounded-md bg-muted p-0.5">
          {#each CHART_LEGEND_POSITIONS as p (p)}
            <button type="button" aria-pressed={spec.legend.position === p} data-option="legend.{p}" class={chartSegmentClass(spec.legend.position === p)} onclick={() => controller.setLegend({ position: p })}>
              {cap(p)}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if show('axes') && cartesian}
    {@render axisSection('x', spec.xAxis)}
    {@render axisSection('y', spec.yAxis)}
  {/if}

  {#if show('series') && selectedSeries}
    {@const series = selectedSeries}
    <div class={chartSectionClass} data-section="series" data-series-id={series.id}>
      <h4 class="text-xs font-semibold text-foreground">Series</h4>
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-series-name" class="{chartLabelClass} w-20 shrink-0">Name</label>
        <div class="min-w-0 flex-1">
          <ChartCommitInput id="{idPrefix}-series-name" value={series.name} data-option="series.name" oncommit={(name) => void controller.updateSeries(series.id, { name })} />
        </div>
      </div>
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-series-color" class="{chartLabelClass} w-20 shrink-0">Colour</label>
        <div class="flex min-w-0 flex-1 items-center gap-1">
          <input
            id="{idPrefix}-series-color"
            type="color"
            value={chartColorInputValue(chartSeriesColor(spec, seriesIndex))}
            data-option="series.color"
            class="h-7 w-9 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
            onpointerdown={() => controller.beginGesture(`color:${series.id}`)}
            onblur={() => controller.endGesture()}
            oninput={(e) => controller.updateSeries(series.id, { color: e.currentTarget.value })}
          />
          {#if series.color}
            <button type="button" class={chartButtonClass} data-action="reset-color" onclick={() => controller.updateSeries(series.id, { color: null })}>Palette</button>
          {/if}
        </div>
      </div>
      {#if cartesian}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-series-type" class="{chartLabelClass} w-20 shrink-0">Draw as</label>
          <select
            id="{idPrefix}-series-type"
            class={chartInputClass}
            value={series.type ?? ''}
            data-option="series.type"
            onchange={(e) => controller.updateSeries(series.id, { type: (e.currentTarget.value || null) as ChartSeriesType | null })}
          >
            <option value="">Chart type</option>
            {#each CHART_SERIES_TYPES as t (t)}
              <option value={t}>{CHART_TYPE_LABELS[t]}</option>
            {/each}
          </select>
        </div>
      {/if}
      <div class="flex flex-wrap items-center gap-1">
        {@render toggle('Hidden', 'series.hidden', !!series.hidden, (hidden) => controller.updateSeries(series.id, { hidden }))}
        <span class="flex-1"></span>
        <button type="button" class={chartButtonClass} disabled={seriesIndex <= 0} aria-label="Move series earlier" data-action="series-up" onclick={() => controller.moveSeries(series.id, seriesIndex - 1)}>↑</button>
        <button
          type="button"
          class={chartButtonClass}
          disabled={seriesIndex >= spec.series.length - 1}
          aria-label="Move series later"
          data-action="series-down"
          onclick={() => controller.moveSeries(series.id, seriesIndex + 1)}>↓</button
        >
        <button type="button" class="{chartButtonClass} text-destructive" data-action="series-delete" onclick={() => controller.removeSeries(series.id)}>Delete</button>
      </div>
    </div>
  {/if}
</div>
