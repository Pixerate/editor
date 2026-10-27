import React, { useId } from 'react';
import {
  CHART_COLOR_SCHEMES,
  CHART_ERROR_BAR_DIRECTIONS,
  CHART_ERROR_BAR_LABELS,
  CHART_ERROR_BAR_TYPES,
  CHART_LABEL_POSITIONS,
  CHART_LAYOUT_PRESETS,
  CHART_MARKERS,
  CHART_TRENDLINE_TYPES,
  checkChartColors,
  chartFamily,
  chartSupportsTrendlines,
  chartTrendlineName,
  CHART_CURVES,
  CHART_RADAR_GRATICULES,
  CHART_LEGEND_POSITIONS,
  CHART_LIKERT_NEUTRALS,
  CHART_LIKERT_SORTS,
  CHART_NUMBER_STYLES,
  CHART_SERIES_TYPES,
  CHART_STACKINGS,
  CHART_TYPE_LABELS,
  CHART_TYPES,
  chartColorInputValue,
  chartErrorBarsOfType,
  chartSeriesColor,
  defaultChartErrorBarValue,
  formatChartAmountList,
  parseChartAmountList,
  chartSeriesType,
  isCartesianChart,
  suggestChartReferences,
  type ChartAxis,
  type ChartController,
  type ChartErrorBars,
  type ChartErrorBarType,
  type ChartNumberFormat,
  type ChartSeries,
} from '@pixerate/editor/chart';
import { useChartState } from './useChartEditor';
import { ChartCommitInput } from './ChartDataGrid';
import { chartButtonClass, chartInputClass, chartLabelClass, chartSectionClass, chartSegmentClass } from './styles';

export interface ChartInspectorProps {
  controller: ChartController;
  /** Which sections to show (default: all that apply to the chart). */
  sections?: readonly ChartInspectorSection[];
  className?: string;
}

export type ChartInspectorSection = 'type' | 'style' | 'titles' | 'options' | 'legend' | 'axes' | 'annotations' | 'series';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={htmlFor} className={`${chartLabelClass} w-20 shrink-0`}>
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange, name }: { label: string; checked: boolean; onChange: (checked: boolean) => void; name: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
      <input type="checkbox" className="h-3.5 w-3.5 accent-primary" checked={checked} data-option={name} onChange={(e) => onChange(e.currentTarget.checked)} />
      {label}
    </label>
  );
}

function Select<T extends string>({ id, value, options, onChange, name, labels }: { id?: string; value: T; options: readonly T[]; onChange: (value: T) => void; name: string; labels?: Partial<Record<T, string>> }) {
  return (
    <select id={id} className={chartInputClass} value={value} data-option={name} onChange={(e) => onChange(e.currentTarget.value as T)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? cap(o)}
        </option>
      ))}
    </select>
  );
}

function AxisSection({ controller, axis, value, idBase, horizontal, numeric = false, scales = false }: { controller: ChartController; axis: 'x' | 'y' | 'y2'; value: ChartAxis; idBase: string; horizontal: boolean; numeric?: boolean; scales?: boolean }) {
  const set = (patch: Partial<ChartAxis>) => controller.setAxis(axis, patch);
  const setFormat = (patch: Partial<ChartNumberFormat>) => set({ format: { ...value.format, ...patch } });
  const bound = (key: 'min' | 'max') => (
    <ChartCommitInput
      id={`${idBase}-${axis}-${key}`}
      value={value[key] === null ? '' : String(value[key])}
      placeholder="Auto"
      inputMode="decimal"
      data-option={`${axis}Axis.${key}`}
      className={chartInputClass}
      onCommit={(text) => set({ [key]: text.trim() === '' ? null : Number(text) }).ok}
    />
  );
  const name = axis === 'x' ? (numeric ? 'X axis' : 'Category axis') : axis === 'y' ? 'Value axis' : 'Secondary axis';
  const valueAxis = axis !== 'x' || numeric;
  const key = axis === 'y2' ? 'yAxis2' : `${axis}Axis`;
  return (
    <div className={chartSectionClass} data-section={`axis-${axis}`}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-foreground">
          {name}
          <span className="ml-1 font-normal text-muted-foreground">({axis === 'x' ? (horizontal ? 'left' : 'bottom') : axis === 'y2' ? (horizontal ? 'top' : 'right') : horizontal ? 'bottom' : 'left'})</span>
        </h4>
        <Toggle label="Show" name={`${axis}Axis.show`} checked={value.show} onChange={(show) => set({ show })} />
      </div>
      <Field label="Title" htmlFor={`${idBase}-${axis}-title`}>
        <ChartCommitInput id={`${idBase}-${axis}-title`} value={value.title} data-option={`${axis}Axis.title`} className={chartInputClass} onCommit={(title) => void set({ title })} />
      </Field>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Toggle label="Grid lines" name={`${key}.gridlines`} checked={value.gridlines} onChange={(gridlines) => set({ gridlines })} />
        {axis === 'x' && !numeric && <Toggle label="Dates" name="xAxis.kind" checked={value.kind === 'date'} onChange={(dates) => set({ kind: dates ? 'date' : undefined } as Partial<ChartAxis>)} />}
        {scales && <Toggle label="Reverse" name={`${key}.reverse`} checked={!!value.reverse} onChange={(reverse) => set({ reverse })} />}
        {scales && valueAxis && <Toggle label="Log scale" name={`${key}.scale`} checked={value.scale === 'log'} onChange={(log) => set({ scale: log ? 'log' : 'linear' })} />}
      </div>
      {scales && valueAxis && value.scale === 'log' && (
        <Field label="Log base" htmlFor={`${idBase}-${axis}-log-base`}>
          <ChartCommitInput
            id={`${idBase}-${axis}-log-base`}
            value={String(value.logBase ?? 10)}
            inputMode="decimal"
            data-option={`${key}.logBase`}
            className={chartInputClass}
            onCommit={(text) => set({ logBase: text.trim() === '' ? undefined : Number(text) }).ok}
          />
        </Field>
      )}
      {valueAxis && value.scale !== 'log' && (
        <Field label="Step" htmlFor={`${idBase}-${axis}-step`}>
          <ChartCommitInput
            id={`${idBase}-${axis}-step`}
            value={value.step === null ? '' : String(value.step)}
            placeholder="Auto"
            inputMode="decimal"
            data-option={`${key}.step`}
            className={chartInputClass}
            onCommit={(text) => set({ step: text.trim() === '' ? null : Number(text) }).ok}
          />
        </Field>
      )}
      {valueAxis && (
        <>
          <Field label="Min / max">
            <div className="flex gap-1">
              {bound('min')}
              {bound('max')}
            </div>
          </Field>
          <Field label="Format" htmlFor={`${idBase}-${axis}-format`}>
            <div className="flex gap-1">
               <Select id={`${idBase}-${axis}-format`} name={`${key}.format.style`} value={value.format.style ?? 'number'} options={CHART_NUMBER_STYLES} onChange={(style) => setFormat({ style })} />
              <ChartCommitInput
                value={value.format.decimals === undefined ? '' : String(value.format.decimals)}
                placeholder="Auto"
                aria-label="Decimals"
                title="Decimals"
                inputMode="numeric"
                data-option={`${key}.format.decimals`}
                className={`${chartInputClass} w-14 shrink-0`}
                onCommit={(text) => {
                  const format = { ...value.format };
                  if (text.trim() === '') delete format.decimals;
                  else format.decimals = Number(text);
                  return set({ format }).ok;
                }}
              />
            </div>
          </Field>
          {value.format.style === 'currency' && (
            <Field label="Currency" htmlFor={`${idBase}-${axis}-currency`}>
              <ChartCommitInput id={`${idBase}-${axis}-currency`} value={value.format.currency ?? 'USD'} data-option={`${key}.format.currency`} className={chartInputClass} onCommit={(currency) => void setFormat({ currency: currency.toUpperCase() })} />
            </Field>
          )}
          <Field label="Code" htmlFor={`${idBase}-${axis}-code`}>
            <ChartCommitInput
              id={`${idBase}-${axis}-code`}
              value={value.format.code ?? ''}
              placeholder={'e.g. #,##0.0,,"M"'}
              data-option={`${key}.format.code`}
              className={chartInputClass}
              onCommit={(code) => {
                const format = { ...value.format };
                if (code.trim()) format.code = code.trim();
                else delete format.code;
                return set({ format }).ok;
              }}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/** Error bar type, amount, direction and caps for one series (`which`: y or x error bars). */
function ErrorBarFields({ controller, series, which, idBase }: { controller: ChartController; series: ChartSeries; which: 'errorBars' | 'xErrorBars'; idBase: string }) {
  const bars = series[which];
  const key = `series.${which}`;
  const id = `${idBase}-${which}`;
  const values = which === 'xErrorBars' ? (series.x ?? []) : series.values;
  const set = (next: ChartErrorBars | null) => controller.updateSeries(series.id, { [which]: next });
  const patch = (p: Partial<ChartErrorBars>) => bars && set({ ...bars, ...p });
  return (
    <div className="space-y-1.5" data-section={which === 'errorBars' ? 'error-bars' : 'x-error-bars'}>
      <Field label={which === 'errorBars' ? 'Error bars' : 'X error bars'} htmlFor={`${id}-type`}>
        <select id={`${id}-type`} className={chartInputClass} value={bars?.type ?? ''} data-option={`${key}.type`} onChange={(e) => set(chartErrorBarsOfType(e.currentTarget.value as ChartErrorBarType | '', bars, values))}>
          <option value="">None</option>
          {CHART_ERROR_BAR_TYPES.map((t) => (
            <option key={t} value={t}>
              {CHART_ERROR_BAR_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      {bars && (bars.type === 'fixed' || bars.type === 'percent' || bars.type === 'stddev') && (
        <Field label={bars.type === 'percent' ? 'Percent' : bars.type === 'stddev' ? 'Deviations' : 'Amount'} htmlFor={`${id}-value`}>
          <ChartCommitInput id={`${id}-value`} value={String(bars.value ?? defaultChartErrorBarValue(bars.type))} inputMode="decimal" data-option={`${key}.value`} className={chartInputClass} onCommit={(text) => !!patch({ value: text.trim() === '' ? undefined : Number(text) })?.ok} />
        </Field>
      )}
      {bars?.type === 'custom' && (
        <>
          <Field label="Plus" htmlFor={`${id}-plus`}>
            <ChartCommitInput id={`${id}-plus`} value={formatChartAmountList(bars.plus)} placeholder="1, 2, -, 0.5" data-option={`${key}.plus`} className={chartInputClass} onCommit={(text) => !!patch({ plus: parseChartAmountList(text) as ChartErrorBars['plus'] })?.ok} />
          </Field>
          <Field label="Minus" htmlFor={`${id}-minus`}>
            <ChartCommitInput
              id={`${id}-minus`}
              value={formatChartAmountList(bars.minus)}
              placeholder="Same as plus"
              data-option={`${key}.minus`}
              className={chartInputClass}
              onCommit={(text) => {
                const next = { ...bars };
                if (text.trim()) next.minus = parseChartAmountList(text) as ChartErrorBars['minus'];
                else delete next.minus;
                return set(next).ok;
              }}
            />
          </Field>
        </>
      )}
      {bars && (
        <div className="flex items-center gap-2">
          <select className={`${chartInputClass} flex-1`} aria-label="Error bar direction" value={bars.direction ?? 'both'} data-option={`${key}.direction`} onChange={(e) => patch({ direction: e.currentTarget.value as ChartErrorBars['direction'] })}>
            {CHART_ERROR_BAR_DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {d === 'both' ? 'Both ways' : d === 'plus' ? 'Plus only' : 'Minus only'}
              </option>
            ))}
          </select>
          <Toggle label="Caps" name={`${key}.cap`} checked={bars.cap !== false} onChange={(cap) => patch({ cap })} />
        </div>
      )}
    </div>
  );
}

/**
 * Settings for a chart controller: type, titles, stacking and line options, legend, both
 * axes and the selected series. Every change is one undo step.
 */
export function ChartInspector({ controller, sections, className }: ChartInspectorProps) {
  const { spec, selectedSeries, selection } = useChartState(controller);
  const idBase = useId();
  const show = (section: ChartInspectorSection) => !sections || sections.includes(section);
  const cartesian = isCartesianChart(spec.type);
  const family = chartFamily(spec);
  const hasAxes = family === 'cartesian' || family === 'xy' || family === 'waterfall' || family === 'histogram' || family === 'box';
  const types = spec.series.map((s) => chartSeriesType(spec, s));
  const usesSecondary = family === 'cartesian' && spec.series.some((s) => s.axis === 'secondary' && !s.hidden);
  const colorCheck = checkChartColors(spec.series.filter((s) => !s.hidden).map((s) => chartSeriesColor(spec, spec.series.indexOf(s))));
  const hasBars = cartesian && types.includes('bar');
  const hasLines = cartesian && types.some((t) => t === 'line' || t === 'area');
  const seriesIndex = selectedSeries ? spec.series.findIndex((s) => s.id === selectedSeries.id) : -1;
  // Log and reversed axes and error bars are drawn by the bar / line / area / scatter layouts.
  const scales = family === 'cartesian' || family === 'xy';
  // Reference lines and bands, callouts and colour by category are drawn by the same layouts.
  const annotated = scales;
  const oneSeries = cartesian && spec.series.filter((s) => !s.hidden).length === 1;
  const calloutIndex = selection?.kind === 'point' && selection.seriesId === selectedSeries?.id ? selection.index : null;

  return (
    <div className={`space-y-3 text-xs ${className ?? ''}`} data-chart-inspector="">
      {show('type') && (
        <div className={chartSectionClass} data-section="type">
          <div className="grid grid-cols-3 gap-0.5 rounded-md bg-muted p-0.5" role="radiogroup" aria-label="Chart type">
            {CHART_TYPES.map((type) => (
              <button key={type} type="button" role="radio" aria-checked={spec.type === type} data-chart-type={type} className={chartSegmentClass(spec.type === type)} onClick={() => controller.setType(type)}>
                {CHART_TYPE_LABELS[type]}
              </button>
            ))}
          </div>
        </div>
      )}

      {show('style') && (
        <div className={chartSectionClass} data-section="style">
          <Field label="Layout" htmlFor={`${idBase}-layout`}>
            <select id={`${idBase}-layout`} className={chartInputClass} value="" data-option="preset.layout" onChange={(e) => e.currentTarget.value && controller.applyPreset({ layout: e.currentTarget.value })}>
              <option value="">Quick layout…</option>
              {CHART_LAYOUT_PRESETS.map((p) => (
                <option key={p.id} value={p.id} title={p.description}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Colours" htmlFor={`${idBase}-colors`}>
            <select id={`${idBase}-colors`} className={chartInputClass} value={CHART_COLOR_SCHEMES.find((c) => c.palette.join() === spec.palette.join())?.id ?? ''} data-option="preset.colors" onChange={(e) => e.currentTarget.value && controller.applyPreset({ colors: e.currentTarget.value })}>
              <option value="">Custom</option>
              {CHART_COLOR_SCHEMES.map((c) => (
                <option key={c.id} value={c.id} title={c.description}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {!colorCheck.ok && (
            <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400" data-chart-color-warning="">
              {colorCheck.issues[0]}
            </p>
          )}
          <button type="button" className={chartButtonClass} data-action="transpose" onClick={() => controller.transpose()}>
            Switch rows and columns
          </button>
        </div>
      )}

      {show('titles') && (
        <div className={chartSectionClass} data-section="titles">
          <Field label="Title" htmlFor={`${idBase}-title`}>
            <ChartCommitInput id={`${idBase}-title`} value={spec.title} data-option="title" className={chartInputClass} onCommit={(title) => void controller.setTitle(title)} />
          </Field>
          <Field label="Subtitle" htmlFor={`${idBase}-subtitle`}>
            <ChartCommitInput id={`${idBase}-subtitle`} value={spec.subtitle} data-option="subtitle" className={chartInputClass} onCommit={(subtitle) => void controller.setSubtitle(subtitle)} />
          </Field>
          <Field label="Note" htmlFor={`${idBase}-note`}>
            <ChartCommitInput id={`${idBase}-note`} value={spec.note} placeholder="Source or footnote" data-option="note" className={chartInputClass} onCommit={(note) => void controller.setNote(note)} />
          </Field>
        </div>
      )}

      {show('options') && (
        <div className={chartSectionClass} data-section="options">
          {cartesian && (
            <Field label="Stacking" htmlFor={`${idBase}-stacking`}>
              <Select id={`${idBase}-stacking`} name="stacking" value={spec.stacking} options={CHART_STACKINGS} labels={{ none: 'None', stacked: 'Stacked', percent: '100%' }} onChange={(stacking) => controller.update({ stacking })} />
            </Field>
          )}
          {hasBars && (
            <Field label="Bars">
              <div className="flex gap-0.5 rounded-md bg-muted p-0.5">
                {(['vertical', 'horizontal'] as const).map((o) => (
                  <button key={o} type="button" aria-pressed={spec.orientation === o} data-option={`orientation.${o}`} className={chartSegmentClass(spec.orientation === o)} onClick={() => controller.update({ orientation: o })}>
                    {cap(o)}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {hasLines && (
            <Field label="Lines" htmlFor={`${idBase}-curve`}>
              <Select id={`${idBase}-curve`} name="curve" value={spec.curve} options={CHART_CURVES} onChange={(curve) => controller.update({ curve })} />
            </Field>
          )}
          {spec.type === 'donut' && (
            <Field label="Hole" htmlFor={`${idBase}-hole`}>
              <input
                id={`${idBase}-hole`}
                type="range"
                min={0}
                max={0.9}
                step={0.05}
                value={spec.innerRadius}
                data-option="innerRadius"
                className="w-full accent-primary"
                onPointerDown={() => controller.beginGesture('innerRadius')}
                onPointerUp={() => controller.endGesture()}
                onChange={(e) => controller.update({ innerRadius: Number(e.currentTarget.value) })}
              />
            </Field>
          )}
          {hasBars && (
            <Field label="Spacing" htmlFor={`${idBase}-gap`}>
              <input
                id={`${idBase}-gap`}
                type="range"
                min={0}
                max={0.9}
                step={0.02}
                value={spec.gapWidth}
                data-option="gapWidth"
                className="w-full accent-primary"
                onPointerDown={() => controller.beginGesture('gapWidth')}
                onPointerUp={() => controller.endGesture()}
                onChange={(e) => controller.update({ gapWidth: Number(e.currentTarget.value) })}
              />
            </Field>
          )}
          {spec.type === 'likert' && (
            <Field label="Neutral" htmlFor={`${idBase}-likert-neutral`}>
              <Select id={`${idBase}-likert-neutral`} name="likertNeutral" value={spec.likertNeutral} options={CHART_LIKERT_NEUTRALS} labels={{ split: 'Across the centre', separate: 'In its own column' }} onChange={(likertNeutral) => controller.update({ likertNeutral })} />
            </Field>
          )}
          {spec.type === 'likert' && (
            <Field label="Order" htmlFor={`${idBase}-likert-sort`}>
              <Select id={`${idBase}-likert-sort`} name="likertSort" value={spec.likertSort} options={CHART_LIKERT_SORTS} labels={{ none: 'As entered', positive: 'Most agreement first', negative: 'Most disagreement first' }} onChange={(likertSort) => controller.update({ likertSort })} />
            </Field>
          )}
          {spec.type === 'parliament' && (
            <Field label="Sweep" htmlFor={`${idBase}-parliament-arc`}>
              <input
                id={`${idBase}-parliament-arc`}
                type="range"
                min={90}
                max={360}
                step={10}
                value={spec.parliamentArc}
                data-option="parliamentArc"
                className="w-full accent-primary"
                onPointerDown={() => controller.beginGesture('parliamentArc')}
                onPointerUp={() => controller.endGesture()}
                onChange={(e) => controller.update({ parliamentArc: Number(e.currentTarget.value) })}
              />
            </Field>
          )}
          {spec.type === 'parliament' && (
            <Field label="Majority" htmlFor={`${idBase}-parliament-majority`}>
              <ChartCommitInput id={`${idBase}-parliament-majority`} value={spec.parliamentMajority === null ? '' : String(spec.parliamentMajority)} placeholder="Half plus one" inputMode="numeric" data-option="parliamentMajority" className={chartInputClass} onCommit={(text) => controller.update({ parliamentMajority: text.trim() === '' ? null : Number(text) }).ok} />
            </Field>
          )}
          {spec.type === 'parliament' && (
            <Field label="Caption" htmlFor={`${idBase}-parliament-label`}>
              <ChartCommitInput id={`${idBase}-parliament-label`} value={spec.parliamentLabel} placeholder="seats" data-option="parliamentLabel" className={chartInputClass} onCommit={(parliamentLabel) => controller.update({ parliamentLabel }).ok} />
            </Field>
          )}
          {spec.type === 'radar' && (
            <Field label="Rings" htmlFor={`${idBase}-radar-ticks`}>
              <ChartCommitInput id={`${idBase}-radar-ticks`} value={spec.radarTicks === null ? '' : String(spec.radarTicks)} placeholder="Auto" inputMode="numeric" data-option="radarTicks" className={chartInputClass} onCommit={(text) => controller.update({ radarTicks: text.trim() === '' ? null : Number(text) }).ok} />
            </Field>
          )}
          {spec.type === 'radar' && (
            <Field label="Grid" htmlFor={`${idBase}-radar-graticule`}>
              <Select id={`${idBase}-radar-graticule`} name="radarGraticule" value={spec.radarGraticule} options={CHART_RADAR_GRATICULES} labels={{ polygon: 'Polygons', circle: 'Circles' }} onChange={(radarGraticule) => controller.update({ radarGraticule })} />
            </Field>
          )}
          {spec.dataLabels && hasBars && (
            <Field label="Labels" htmlFor={`${idBase}-label-position`}>
              <Select id={`${idBase}-label-position`} name="labelPosition" value={spec.labelPosition} options={CHART_LABEL_POSITIONS} onChange={(labelPosition) => controller.update({ labelPosition })} />
            </Field>
          )}
          {spec.type === 'histogram' && (
            <Field label="Bins" htmlFor={`${idBase}-bins`}>
              <ChartCommitInput id={`${idBase}-bins`} value={spec.bins === null ? '' : String(spec.bins)} placeholder="Auto" inputMode="numeric" data-option="bins" className={chartInputClass} onCommit={(text) => controller.update({ bins: text.trim() === '' ? null : Number(text) }).ok} />
            </Field>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {spec.type === 'waterfall' && <Toggle label="Total bar" name="showTotal" checked={spec.showTotal} onChange={(showTotal) => controller.update({ showTotal })} />}
            {hasLines && <Toggle label="Points" name="points" checked={spec.points} onChange={(points) => controller.update({ points })} />}
            {oneSeries && <Toggle label="Colour by category" name="varyColors" checked={spec.varyColors} onChange={(varyColors) => controller.update({ varyColors })} />}
            <Toggle label="Data labels" name="dataLabels" checked={spec.dataLabels} onChange={(dataLabels) => controller.update({ dataLabels })} />
          </div>
        </div>
      )}

      {show('legend') && (
        <div className={chartSectionClass} data-section="legend">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-foreground">Legend</h4>
            <Toggle label="Show" name="legend.show" checked={spec.legend.show} onChange={(v) => controller.setLegend({ show: v })} />
          </div>
          {spec.legend.show && (
            <div className="flex gap-0.5 rounded-md bg-muted p-0.5">
              {CHART_LEGEND_POSITIONS.map((p) => (
                <button key={p} type="button" aria-pressed={spec.legend.position === p} data-option={`legend.${p}`} className={chartSegmentClass(spec.legend.position === p)} onClick={() => controller.setLegend({ position: p })}>
                  {cap(p)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {show('axes') && hasAxes && (
        <>
          {family !== 'box' && family !== 'histogram' && <AxisSection controller={controller} axis="x" value={spec.xAxis} idBase={idBase} horizontal={spec.orientation === 'horizontal'} numeric={family === 'xy'} scales={scales} />}
          <AxisSection controller={controller} axis="y" value={spec.yAxis} idBase={idBase} horizontal={spec.orientation === 'horizontal'} scales={scales} />
          {usesSecondary && <AxisSection controller={controller} axis="y2" value={spec.yAxis2} idBase={idBase} horizontal={spec.orientation === 'horizontal'} scales={scales} />}
        </>
      )}

      {show('annotations') && annotated && (
        <div className={chartSectionClass} data-section="annotations">
          <h4 className="text-xs font-semibold text-foreground">Annotations</h4>
          <Field label="Highlight" htmlFor={`${idBase}-highlight`}>
            <ChartCommitInput
              id={`${idBase}-highlight`}
              value={spec.highlight.join(', ')}
              placeholder="Categories or series"
              data-option="highlight"
              className={chartInputClass}
              onCommit={(text) => controller.setHighlight(text.split(',').map((n) => n.trim()).filter(Boolean)).ok}
            />
          </Field>
          {spec.referenceLines.map((line, i) => (
            <div key={`line-${i}`} className="flex items-center gap-1" data-reference-line={i}>
              <ChartCommitInput value={String(line.value)} aria-label="Line value" inputMode="decimal" data-option={`referenceLine.${i}.value`} className={`${chartInputClass} w-16 shrink-0`} onCommit={(text) => controller.updateReferenceLine(i, { value: Number(text) }).ok} />
              <ChartCommitInput value={line.label ?? ''} aria-label="Line label" placeholder="Label" data-option={`referenceLine.${i}.label`} className={`${chartInputClass} flex-1`} onCommit={(text) => controller.updateReferenceLine(i, { label: text || null }).ok} />
              <button type="button" className={chartButtonClass} aria-label="Delete reference line" data-action="reference-line-delete" onClick={() => controller.removeReferenceLine(i)}>
                ×
              </button>
            </div>
          ))}
          {spec.referenceBands.map((band, i) => (
            <div key={`band-${i}`} className="flex items-center gap-1" data-reference-band={i}>
              <ChartCommitInput value={String(band.from)} aria-label="Band from" inputMode="decimal" data-option={`referenceBand.${i}.from`} className={`${chartInputClass} w-14 shrink-0`} onCommit={(text) => controller.updateReferenceBand(i, { from: Number(text) }).ok} />
              <ChartCommitInput value={String(band.to)} aria-label="Band to" inputMode="decimal" data-option={`referenceBand.${i}.to`} className={`${chartInputClass} w-14 shrink-0`} onCommit={(text) => controller.updateReferenceBand(i, { to: Number(text) }).ok} />
              <ChartCommitInput value={band.label ?? ''} aria-label="Band label" placeholder="Label" data-option={`referenceBand.${i}.label`} className={`${chartInputClass} flex-1`} onCommit={(text) => controller.updateReferenceBand(i, { label: text || null }).ok} />
              <button type="button" className={chartButtonClass} aria-label="Delete reference band" data-action="reference-band-delete" onClick={() => controller.removeReferenceBand(i)}>
                ×
              </button>
            </div>
          ))}
          <div className="flex gap-1">
            <button type="button" className={chartButtonClass} data-option="referenceLine.add" onClick={() => controller.addReferenceLine(suggestChartReferences(spec).line)}>
              Add line
            </button>
            <button type="button" className={chartButtonClass} data-option="referenceBand.add" onClick={() => controller.addReferenceBand(suggestChartReferences(spec).band)}>
              Add band
            </button>
          </div>
        </div>
      )}

      {show('series') && selectedSeries && (
        <div className={chartSectionClass} data-section="series" data-series-id={selectedSeries.id}>
          <h4 className="text-xs font-semibold text-foreground">Series</h4>
          <Field label="Name" htmlFor={`${idBase}-series-name`}>
            <ChartCommitInput id={`${idBase}-series-name`} value={selectedSeries.name} data-option="series.name" className={chartInputClass} onCommit={(name) => void controller.updateSeries(selectedSeries.id, { name })} />
          </Field>
          <Field label="Colour" htmlFor={`${idBase}-series-color`}>
            <div className="flex items-center gap-1">
              <input
                id={`${idBase}-series-color`}
                type="color"
                value={chartColorInputValue(chartSeriesColor(spec, seriesIndex))}
                data-option="series.color"
                className="h-7 w-9 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5"
                onPointerDown={() => controller.beginGesture(`color:${selectedSeries.id}`)}
                onBlur={() => controller.endGesture()}
                onChange={(e) => controller.updateSeries(selectedSeries.id, { color: e.currentTarget.value })}
              />
              {selectedSeries.color && (
                <button type="button" className={chartButtonClass} data-action="reset-color" onClick={() => controller.updateSeries(selectedSeries.id, { color: null })}>
                  Palette
                </button>
              )}
            </div>
          </Field>
          {cartesian && (
            <Field label="Draw as" htmlFor={`${idBase}-series-type`}>
              <select
                id={`${idBase}-series-type`}
                className={chartInputClass}
                value={selectedSeries.type ?? ''}
                data-option="series.type"
                onChange={(e) => controller.updateSeries(selectedSeries.id, { type: (e.currentTarget.value || null) as any })}
              >
                <option value="">Chart type</option>
                {CHART_SERIES_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CHART_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(cartesian || family === 'xy') && ['line', 'area', 'scatter'].includes(chartSeriesType(spec, selectedSeries)) && (
            <Field label="Marker" htmlFor={`${idBase}-series-marker`}>
              <select
                id={`${idBase}-series-marker`}
                className={chartInputClass}
                value={selectedSeries.marker ?? ''}
                data-option="series.marker"
                onChange={(e) => controller.updateSeries(selectedSeries.id, { marker: (e.currentTarget.value || null) as any })}
              >
                <option value="">Default</option>
                {CHART_MARKERS.map((m) => (
                  <option key={m} value={m}>
                    {cap(m)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {annotated && calloutIndex !== null && (
            <Field label="Callout" htmlFor={`${idBase}-series-callout`}>
              <ChartCommitInput
                id={`${idBase}-series-callout`}
                value={selectedSeries.callouts?.[calloutIndex] ?? ''}
                placeholder={`Label for ${spec.categories[calloutIndex] ?? 'this point'}`}
                data-option="series.callout"
                className={chartInputClass}
                onCommit={(text) => controller.setCallout(selectedSeries.id, calloutIndex, text || null).ok}
              />
            </Field>
          )}
          {scales && <ErrorBarFields controller={controller} series={selectedSeries} which="errorBars" idBase={idBase} />}
          {family === 'xy' && <ErrorBarFields controller={controller} series={selectedSeries} which="xErrorBars" idBase={idBase} />}
          {chartSupportsTrendlines(spec.type, spec.stacking) && (
            <div className="space-y-1" data-section="trendlines">
              {(selectedSeries.trendlines ?? []).map((t, i) => (
                <div key={i} className="flex items-center gap-1" data-trendline={i}>
                  <span className="flex-1 truncate text-muted-foreground">{chartTrendlineName(t, selectedSeries.name)}</span>
                  <Toggle label="R²" name={`trendline.${i}.showR2`} checked={!!t.showR2} onChange={(showR2) => controller.updateTrendline(selectedSeries.id, i, { showR2 })} />
                  <button type="button" className={chartButtonClass} aria-label="Delete trendline" data-action="trendline-delete" onClick={() => controller.removeTrendline(selectedSeries.id, i)}>
                    ×
                  </button>
                </div>
              ))}
              <select
                className={chartInputClass}
                value=""
                aria-label="Add trendline"
                data-option="trendline.add"
                onChange={(e) => e.currentTarget.value && controller.addTrendline(selectedSeries.id, { type: e.currentTarget.value as any })}
              >
                <option value="">Add trendline…</option>
                {CHART_TRENDLINE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {cap(t.replace('-', ' '))}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            <Toggle label="Hidden" name="series.hidden" checked={!!selectedSeries.hidden} onChange={(hidden) => controller.updateSeries(selectedSeries.id, { hidden })} />
            {family === 'cartesian' && <Toggle label="Secondary axis" name="series.axis" checked={selectedSeries.axis === 'secondary'} onChange={(secondary) => controller.updateSeries(selectedSeries.id, { axis: secondary ? 'secondary' : null })} />}
            <span className="flex-1" />
            <button type="button" className={chartButtonClass} disabled={seriesIndex <= 0} aria-label="Move series earlier" data-action="series-up" onClick={() => controller.moveSeries(selectedSeries.id, seriesIndex - 1)}>
              ↑
            </button>
            <button type="button" className={chartButtonClass} disabled={seriesIndex >= spec.series.length - 1} aria-label="Move series later" data-action="series-down" onClick={() => controller.moveSeries(selectedSeries.id, seriesIndex + 1)}>
              ↓
            </button>
            <button type="button" className={`${chartButtonClass} text-destructive`} data-action="series-delete" onClick={() => controller.removeSeries(selectedSeries.id)}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
