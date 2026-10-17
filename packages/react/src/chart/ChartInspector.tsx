import React, { useId } from 'react';
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

export type ChartInspectorSection = 'type' | 'titles' | 'options' | 'legend' | 'axes' | 'series';

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

function AxisSection({ controller, axis, value, idBase, horizontal }: { controller: ChartController; axis: 'x' | 'y'; value: ChartAxis; idBase: string; horizontal: boolean }) {
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
  const name = axis === 'x' ? 'Category axis' : 'Value axis';
  return (
    <div className={chartSectionClass} data-section={`axis-${axis}`}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-foreground">
          {name}
          <span className="ml-1 font-normal text-muted-foreground">({axis === 'x' ? (horizontal ? 'left' : 'bottom') : horizontal ? 'bottom' : 'left'})</span>
        </h4>
        <Toggle label="Show" name={`${axis}Axis.show`} checked={value.show} onChange={(show) => set({ show })} />
      </div>
      <Field label="Title" htmlFor={`${idBase}-${axis}-title`}>
        <ChartCommitInput id={`${idBase}-${axis}-title`} value={value.title} data-option={`${axis}Axis.title`} className={chartInputClass} onCommit={(title) => void set({ title })} />
      </Field>
      <Toggle label="Grid lines" name={`${axis}Axis.gridlines`} checked={value.gridlines} onChange={(gridlines) => set({ gridlines })} />
      {axis === 'y' && (
        <>
          <Field label="Min / max">
            <div className="flex gap-1">
              {bound('min')}
              {bound('max')}
            </div>
          </Field>
          <Field label="Format" htmlFor={`${idBase}-y-format`}>
            <div className="flex gap-1">
              <Select id={`${idBase}-y-format`} name="yAxis.format.style" value={value.format.style ?? 'number'} options={CHART_NUMBER_STYLES} onChange={(style) => setFormat({ style })} />
              <ChartCommitInput
                value={value.format.decimals === undefined ? '' : String(value.format.decimals)}
                placeholder="Auto"
                aria-label="Decimals"
                title="Decimals"
                inputMode="numeric"
                data-option="yAxis.format.decimals"
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
            <Field label="Currency" htmlFor={`${idBase}-y-currency`}>
              <ChartCommitInput id={`${idBase}-y-currency`} value={value.format.currency ?? 'USD'} data-option="yAxis.format.currency" className={chartInputClass} onCommit={(currency) => void setFormat({ currency: currency.toUpperCase() })} />
            </Field>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Settings for a chart controller: type, titles, stacking and line options, legend, both
 * axes and the selected series. Every change is one undo step.
 */
export function ChartInspector({ controller, sections, className }: ChartInspectorProps) {
  const { spec, selectedSeries } = useChartState(controller);
  const idBase = useId();
  const show = (section: ChartInspectorSection) => !sections || sections.includes(section);
  const cartesian = isCartesianChart(spec.type);
  const types = spec.series.map((s) => chartSeriesType(spec, s));
  const hasBars = cartesian && types.includes('bar');
  const hasLines = cartesian && types.some((t) => t === 'line' || t === 'area');
  const seriesIndex = selectedSeries ? spec.series.findIndex((s) => s.id === selectedSeries.id) : -1;

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

      {show('titles') && (
        <div className={chartSectionClass} data-section="titles">
          <Field label="Title" htmlFor={`${idBase}-title`}>
            <ChartCommitInput id={`${idBase}-title`} value={spec.title} data-option="title" className={chartInputClass} onCommit={(title) => void controller.setTitle(title)} />
          </Field>
          <Field label="Subtitle" htmlFor={`${idBase}-subtitle`}>
            <ChartCommitInput id={`${idBase}-subtitle`} value={spec.subtitle} data-option="subtitle" className={chartInputClass} onCommit={(subtitle) => void controller.setSubtitle(subtitle)} />
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
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {hasLines && <Toggle label="Points" name="points" checked={spec.points} onChange={(points) => controller.update({ points })} />}
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

      {show('axes') && cartesian && (
        <>
          <AxisSection controller={controller} axis="x" value={spec.xAxis} idBase={idBase} horizontal={spec.orientation === 'horizontal'} />
          <AxisSection controller={controller} axis="y" value={spec.yAxis} idBase={idBase} horizontal={spec.orientation === 'horizontal'} />
        </>
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
          <div className="flex flex-wrap items-center gap-1">
            <Toggle label="Hidden" name="series.hidden" checked={!!selectedSeries.hidden} onChange={(hidden) => controller.updateSeries(selectedSeries.id, { hidden })} />
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
