<script lang="ts" module>
  // A counter keeps label ids unique per inspector. Pass `idPrefix` for ids that match
  // between server and client renders.
  let nextId = 0;

  export type ChartInspectorSection = 'type' | 'style' | 'titles' | 'options' | 'legend' | 'axes' | 'series';
</script>

<script lang="ts">
  import {
    CHART_COLOR_SCHEMES,
    CHART_CURVES,
    CHART_LABEL_POSITIONS,
    CHART_LAYOUT_PRESETS,
    CHART_LEGEND_POSITIONS,
    CHART_MARKERS,
    CHART_NUMBER_STYLES,
    CHART_SERIES_TYPES,
    CHART_STACKINGS,
    CHART_TRENDLINE_TYPES,
    CHART_TYPE_LABELS,
    CHART_TYPES,
    checkChartColors,
    chartColorInputValue,
    chartFamily,
    chartSeriesColor,
    chartSeriesType,
    chartSupportsTrendlines,
    chartTrendlineName,
    isCartesianChart,
    type ChartAxis,
    type ChartController,
    type ChartLabelPosition,
    type ChartMarker,
    type ChartNumberFormat,
    type ChartSeriesType,
    type ChartTrendlineType
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
  const family = $derived(chartFamily(spec));
  const hasAxes = $derived(family === 'cartesian' || family === 'xy' || family === 'waterfall' || family === 'histogram' || family === 'box');
  const types = $derived(spec.series.map((s) => chartSeriesType(spec, s)));
  const hasBars = $derived(cartesian && types.includes('bar'));
  const hasLines = $derived(cartesian && types.some((t) => t === 'line' || t === 'area'));
  const usesSecondary = $derived(family === 'cartesian' && spec.series.some((s) => s.axis === 'secondary' && !s.hidden));
  const colorCheck = $derived(checkChartColors(spec.series.filter((s) => !s.hidden).map((s) => chartSeriesColor(spec, spec.series.indexOf(s)))));
  const currentScheme = $derived(CHART_COLOR_SCHEMES.find((c) => c.palette.join() === spec.palette.join())?.id ?? '');
  const seriesIndex = $derived(selectedSeries ? spec.series.findIndex((s) => s.id === selectedSeries.id) : -1);
  const horizontal = $derived(spec.orientation === 'horizontal');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const stackingLabels: Record<string, string> = { none: 'None', stacked: 'Stacked', percent: '100%' };

  const keyOf = (axis: 'x' | 'y' | 'y2') => (axis === 'y2' ? 'yAxis2' : `${axis}Axis`);
  const setAxis = (axis: 'x' | 'y' | 'y2', patch: Partial<ChartAxis>) => controller.setAxis(axis, patch);
  const setFormat = (axis: 'x' | 'y' | 'y2', value: ChartAxis, patch: Partial<ChartNumberFormat>) => setAxis(axis, { format: { ...value.format, ...patch } });
  const commitNumber = (axis: 'x' | 'y' | 'y2', key: 'min' | 'max' | 'step') => (text: string) => setAxis(axis, { [key]: text.trim() === '' ? null : Number(text) }).ok;
  function commitDecimals(axis: 'x' | 'y' | 'y2', value: ChartAxis, text: string) {
    const format = { ...value.format };
    if (text.trim() === '') delete format.decimals;
    else format.decimals = Number(text);
    return setAxis(axis, { format }).ok;
  }
  function commitCode(axis: 'x' | 'y' | 'y2', value: ChartAxis, code: string) {
    const format = { ...value.format };
    if (code.trim()) format.code = code.trim();
    else delete format.code;
    return setAxis(axis, { format }).ok;
  }
  const side = (axis: 'x' | 'y' | 'y2') => (axis === 'x' ? (horizontal ? 'left' : 'bottom') : axis === 'y2' ? (horizontal ? 'top' : 'right') : horizontal ? 'bottom' : 'left');
</script>

{#snippet toggle(label: string, name: string, checked: boolean, onchange: (checked: boolean) => void)}
  <label class="flex cursor-pointer items-center gap-2 text-xs text-foreground">
    <input type="checkbox" class="h-3.5 w-3.5 accent-primary" {checked} data-option={name} onchange={(e) => onchange(e.currentTarget.checked)} />
    {label}
  </label>
{/snippet}

{#snippet axisSection(axis: 'x' | 'y' | 'y2', value: ChartAxis, numeric: boolean)}
  {@const key = keyOf(axis)}
  {@const valueAxis = axis !== 'x' || numeric}
  <div class={chartSectionClass} data-section="axis-{axis}">
    <div class="flex items-center justify-between">
      <h4 class="text-xs font-semibold text-foreground">
        {axis === 'x' ? (numeric ? 'X axis' : 'Category axis') : axis === 'y' ? 'Value axis' : 'Secondary axis'}
        <span class="ml-1 font-normal text-muted-foreground">({side(axis)})</span>
      </h4>
      {@render toggle('Show', `${key}.show`, value.show, (v) => setAxis(axis, { show: v }))}
    </div>
    <div class="flex items-center gap-2">
      <label for="{idPrefix}-{axis}-title" class="{chartLabelClass} w-20 shrink-0">Title</label>
      <div class="min-w-0 flex-1">
        <ChartCommitInput id="{idPrefix}-{axis}-title" value={value.title} data-option="{key}.title" oncommit={(title) => void setAxis(axis, { title })} />
      </div>
    </div>
    <div class="flex flex-wrap gap-x-4 gap-y-1">
      {@render toggle('Grid lines', `${key}.gridlines`, value.gridlines, (v) => setAxis(axis, { gridlines: v }))}
      {#if axis === 'x' && !numeric}
        {@render toggle('Dates', 'xAxis.kind', value.kind === 'date', (dates) => setAxis('x', { kind: dates ? 'date' : undefined } as Partial<ChartAxis>))}
      {/if}
    </div>
    {#if valueAxis}
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-{axis}-step" class="{chartLabelClass} w-20 shrink-0">Step</label>
        <div class="min-w-0 flex-1">
          <ChartCommitInput id="{idPrefix}-{axis}-step" value={value.step === null ? '' : String(value.step)} placeholder="Auto" inputmode="decimal" data-option="{key}.step" oncommit={commitNumber(axis, 'step')} />
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span class="{chartLabelClass} w-20 shrink-0">Min / max</span>
        <div class="flex min-w-0 flex-1 gap-1">
          <ChartCommitInput id="{idPrefix}-{axis}-min" value={value.min === null ? '' : String(value.min)} placeholder="Auto" inputmode="decimal" data-option="{key}.min" oncommit={commitNumber(axis, 'min')} />
          <ChartCommitInput id="{idPrefix}-{axis}-max" value={value.max === null ? '' : String(value.max)} placeholder="Auto" inputmode="decimal" data-option="{key}.max" oncommit={commitNumber(axis, 'max')} />
        </div>
      </div>
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-{axis}-format" class="{chartLabelClass} w-20 shrink-0">Format</label>
        <div class="flex min-w-0 flex-1 gap-1">
          <select
            id="{idPrefix}-{axis}-format"
            class={chartInputClass}
            value={value.format.style ?? 'number'}
            data-option="{key}.format.style"
            onchange={(e) => setFormat(axis, value, { style: e.currentTarget.value as ChartNumberFormat['style'] })}
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
            data-option="{key}.format.decimals"
            class="{chartInputClass} w-14 shrink-0"
            oncommit={(text) => commitDecimals(axis, value, text)}
          />
        </div>
      </div>
      {#if value.format.style === 'currency'}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-{axis}-currency" class="{chartLabelClass} w-20 shrink-0">Currency</label>
          <div class="min-w-0 flex-1">
            <ChartCommitInput id="{idPrefix}-{axis}-currency" value={value.format.currency ?? 'USD'} data-option="{key}.format.currency" oncommit={(c) => void setFormat(axis, value, { currency: c.toUpperCase() })} />
          </div>
        </div>
      {/if}
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-{axis}-code" class="{chartLabelClass} w-20 shrink-0">Code</label>
        <div class="min-w-0 flex-1">
          <ChartCommitInput id="{idPrefix}-{axis}-code" value={value.format.code ?? ''} placeholder={'e.g. #,##0.0,,"M"'} data-option="{key}.format.code" oncommit={(code) => commitCode(axis, value, code)} />
        </div>
      </div>
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

  {#if show('style')}
    <div class={chartSectionClass} data-section="style">
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-layout" class="{chartLabelClass} w-20 shrink-0">Layout</label>
        <select id="{idPrefix}-layout" class={chartInputClass} value="" data-option="preset.layout" onchange={(e) => e.currentTarget.value && controller.applyPreset({ layout: e.currentTarget.value })}>
          <option value="">Quick layout…</option>
          {#each CHART_LAYOUT_PRESETS as p (p.id)}
            <option value={p.id} title={p.description}>{p.label}</option>
          {/each}
        </select>
      </div>
      <div class="flex items-center gap-2">
        <label for="{idPrefix}-colors" class="{chartLabelClass} w-20 shrink-0">Colours</label>
        <select id="{idPrefix}-colors" class={chartInputClass} value={currentScheme} data-option="preset.colors" onchange={(e) => e.currentTarget.value && controller.applyPreset({ colors: e.currentTarget.value })}>
          <option value="">Custom</option>
          {#each CHART_COLOR_SCHEMES as c (c.id)}
            <option value={c.id} title={c.description}>{c.label}</option>
          {/each}
        </select>
      </div>
      {#if !colorCheck.ok}
        <p class="text-[11px] leading-snug text-amber-600 dark:text-amber-400" data-chart-color-warning="">{colorCheck.issues[0]}</p>
      {/if}
      <button type="button" class={chartButtonClass} data-action="transpose" onclick={() => controller.transpose()}>Switch rows and columns</button>
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
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-gap" class="{chartLabelClass} w-20 shrink-0">Spacing</label>
          <input
            id="{idPrefix}-gap"
            type="range"
            min="0"
            max="0.9"
            step="0.02"
            value={spec.gapWidth}
            data-option="gapWidth"
            class="w-full accent-primary"
            onpointerdown={() => controller.beginGesture('gapWidth')}
            onpointerup={() => controller.endGesture()}
            oninput={(e) => controller.update({ gapWidth: Number(e.currentTarget.value) })}
          />
        </div>
      {/if}
      {#if spec.dataLabels && hasBars}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-label-position" class="{chartLabelClass} w-20 shrink-0">Labels</label>
          <select id="{idPrefix}-label-position" class={chartInputClass} value={spec.labelPosition} data-option="labelPosition" onchange={(e) => controller.update({ labelPosition: e.currentTarget.value as ChartLabelPosition })}>
            {#each CHART_LABEL_POSITIONS as p (p)}
              <option value={p}>{cap(p)}</option>
            {/each}
          </select>
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
      {#if spec.type === 'histogram'}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-bins" class="{chartLabelClass} w-20 shrink-0">Bins</label>
          <div class="min-w-0 flex-1">
            <ChartCommitInput id="{idPrefix}-bins" value={spec.bins === null ? '' : String(spec.bins)} placeholder="Auto" inputmode="numeric" data-option="bins" oncommit={(text) => controller.update({ bins: text.trim() === '' ? null : Number(text) }).ok} />
          </div>
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
        {#if spec.type === 'waterfall'}
          {@render toggle('Total bar', 'showTotal', spec.showTotal, (showTotal) => controller.update({ showTotal }))}
        {/if}
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

  {#if show('axes') && hasAxes}
    {#if family !== 'box' && family !== 'histogram'}
      {@render axisSection('x', spec.xAxis, family === 'xy')}
    {/if}
    {@render axisSection('y', spec.yAxis, false)}
    {#if usesSecondary}
      {@render axisSection('y2', spec.yAxis2, false)}
    {/if}
  {/if}

  {#if show('series') && selectedSeries}
    {@const series = selectedSeries}
    {@const drawnAs = chartSeriesType(spec, series)}
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
      {#if (cartesian || family === 'xy') && (drawnAs === 'line' || drawnAs === 'area' || drawnAs === 'scatter')}
        <div class="flex items-center gap-2">
          <label for="{idPrefix}-series-marker" class="{chartLabelClass} w-20 shrink-0">Marker</label>
          <select
            id="{idPrefix}-series-marker"
            class={chartInputClass}
            value={series.marker ?? ''}
            data-option="series.marker"
            onchange={(e) => controller.updateSeries(series.id, { marker: (e.currentTarget.value || null) as ChartMarker | null })}
          >
            <option value="">Default</option>
            {#each CHART_MARKERS as m (m)}
              <option value={m}>{cap(m)}</option>
            {/each}
          </select>
        </div>
      {/if}
      {#if chartSupportsTrendlines(spec.type, spec.stacking)}
        <div class="space-y-1" data-section="trendlines">
          {#each series.trendlines ?? [] as t, i (i)}
            <div class="flex items-center gap-1" data-trendline={i}>
              <span class="flex-1 truncate text-muted-foreground">{chartTrendlineName(t, series.name)}</span>
              {@render toggle('R²', `trendline.${i}.showR2`, !!t.showR2, (showR2) => controller.updateTrendline(series.id, i, { showR2 }))}
              <button type="button" class={chartButtonClass} aria-label="Delete trendline" data-action="trendline-delete" onclick={() => controller.removeTrendline(series.id, i)}>×</button>
            </div>
          {/each}
          <select
            class={chartInputClass}
            value=""
            aria-label="Add trendline"
            data-option="trendline.add"
            onchange={(e) => e.currentTarget.value && controller.addTrendline(series.id, { type: e.currentTarget.value as ChartTrendlineType })}
          >
            <option value="">Add trendline…</option>
            {#each CHART_TRENDLINE_TYPES as t (t)}
              <option value={t}>{cap(t.replace('-', ' '))}</option>
            {/each}
          </select>
        </div>
      {/if}
      <div class="flex flex-wrap items-center gap-1">
        {@render toggle('Hidden', 'series.hidden', !!series.hidden, (hidden) => controller.updateSeries(series.id, { hidden }))}
        {#if family === 'cartesian'}
          {@render toggle('Secondary axis', 'series.axis', series.axis === 'secondary', (secondary) => controller.updateSeries(series.id, { axis: secondary ? 'secondary' : null }))}
        {/if}
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
