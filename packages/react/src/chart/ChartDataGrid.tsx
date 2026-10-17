import React, { useEffect, useRef, useState } from 'react';
import { chartColorInputValue, chartSeriesColor, formatChartNumber, type ChartController } from '@pixerate/editor/chart';
import { useChartState } from './useChartEditor';
import { chartButtonClass, chartCellClass, chartIconButtonClass, chartInputClass } from './styles';

type CommitInputProps = {
  value: string;
  /** Called with the typed text. Return `false` to show the stored value again (a refused edit). */
  onCommit: (value: string) => boolean | void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'>;

/** A text box that commits on blur or Enter and resets on Escape. Follows `value` unless the user is typing. */
export function ChartCommitInput({ value, onCommit, onKeyDown, onBlur, ...rest }: CommitInputProps) {
  const [draft, setDraft] = useState(value);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setDraft(value);
  }, [value]);
  const commit = () => {
    if (!typing.current) return;
    typing.current = false;
    if (draft === value) return;
    if (onCommit(draft) === false) setDraft(value);
  };
  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => {
        typing.current = true;
        setDraft(e.currentTarget.value);
      }}
      onBlur={(e) => {
        onBlur?.(e);
        commit();
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          typing.current = false;
          setDraft(value);
        }
      }}
    />
  );
}

export interface ChartDataGridProps {
  controller: ChartController;
  /** Header of the category column (default "Category"). */
  categoryHeader?: string;
  /** Hide the add / delete buttons. */
  readOnly?: boolean;
  className?: string;
}

/**
 * The chart's data as an editable grid: categories down the side, one column per series
 * (name, colour, show / hide, delete). Cells take numbers as people type them (`1,200`,
 * `12%`, blank for a gap); pasting TSV or CSV fills and grows the grid from the cell.
 */
export function ChartDataGrid({ controller, categoryHeader = 'Category', readOnly = false, className }: ChartDataGridProps) {
  const { spec, selection } = useChartState(controller);
  const paste = (row: number, column: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!/[\t\n]/.test(text.replace(/\n$/, ''))) return;
    e.preventDefault();
    controller.pasteCells(row, column, text);
  };
  return (
    <div className={`overflow-auto rounded-md border border-border ${className ?? ''}`} data-chart-grid="">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="border-b border-r border-border px-2 py-1 text-left font-medium text-muted-foreground">{categoryHeader}</th>
            {spec.series.map((s, si) => {
              const color = chartSeriesColor(spec, si);
              const selected = selection?.kind === 'series' && selection.seriesId === s.id;
              return (
                <th key={s.id} data-series-id={s.id} className={`border-b border-r border-border px-1 py-1 font-medium ${selected ? 'bg-primary/10' : ''}`}>
                  <div className="flex items-center gap-1">
                    <input
                      type="color"
                      aria-label={`${s.name} colour`}
                      value={chartColorInputValue(color)}
                      disabled={readOnly}
                      onPointerDown={() => controller.beginGesture(`color:${s.id}`)}
                      onChange={(e) => controller.updateSeries(s.id, { color: e.currentTarget.value })}
                      onBlur={() => controller.endGesture()}
                      className="h-5 w-5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                    <ChartCommitInput
                      value={s.name}
                      aria-label="Series name"
                      onFocus={() => controller.select({ kind: 'series', seriesId: s.id })}
                      onCommit={(name) => void controller.updateSeries(s.id, { name })}
                      className={`${chartInputClass} h-6 min-w-[5rem] border-transparent bg-transparent font-medium ${s.hidden ? 'text-muted-foreground line-through' : ''}`}
                    />
                    {!readOnly && (
                      <>
                        <button
                          type="button"
                          className={chartIconButtonClass}
                          title={s.hidden ? 'Show series' : 'Hide series'}
                          aria-label={s.hidden ? `Show ${s.name}` : `Hide ${s.name}`}
                          aria-pressed={!s.hidden}
                          data-action="toggle-series"
                          onClick={() => controller.toggleSeries(s.id)}
                        >
                          {s.hidden ? '○' : '●'}
                        </button>
                        <button type="button" className={chartIconButtonClass} title="Delete series" aria-label={`Delete ${s.name}`} data-action="remove-series" onClick={() => controller.removeSeries(s.id)}>
                          ×
                        </button>
                      </>
                    )}
                  </div>
                </th>
              );
            })}
            {!readOnly && (
              <th className="w-8 border-b border-border px-1">
                <button type="button" className={chartIconButtonClass} title="Add series" aria-label="Add series" data-action="add-series" onClick={() => controller.addSeries()}>
                  +
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {spec.categories.map((category, i) => {
            const rowSelected = selection?.kind === 'category' && selection.index === i;
            return (
              <tr key={i} data-category-index={i} className={rowSelected ? 'bg-primary/10' : undefined}>
                <th className="border-b border-r border-border p-0 text-left font-normal">
                  <ChartCommitInput
                    value={category}
                    aria-label={`Category ${i + 1}`}
                    onFocus={() => controller.select({ kind: 'category', index: i })}
                    onPaste={paste(i, -1)}
                    onCommit={(label) => void controller.renameCategory(i, label)}
                    className={`${chartCellClass} text-left`}
                  />
                </th>
                {spec.series.map((s) => {
                  const value = s.values[i];
                  const selected = selection?.kind === 'point' && selection.seriesId === s.id && selection.index === i;
                  return (
                    <td key={s.id} className={`border-b border-r border-border p-0 ${selected ? 'bg-primary/10' : ''}`}>
                      <ChartCommitInput
                        value={value === null || value === undefined ? '' : String(value)}
                        inputMode="decimal"
                        aria-label={`${s.name}, ${category}`}
                        title={value === null ? undefined : formatChartNumber(value, spec.yAxis.format)}
                        data-cell={`${s.id}:${i}`}
                        onFocus={() => controller.select({ kind: 'point', seriesId: s.id, index: i })}
                        onPaste={paste(i, spec.series.indexOf(s))}
                        onCommit={(text) => controller.setValue(s.id, i, text).ok}
                        className={chartCellClass}
                      />
                    </td>
                  );
                })}
                {!readOnly && (
                  <td className="border-b border-border px-1">
                    <button type="button" className={chartIconButtonClass} title="Delete category" aria-label={`Delete ${category}`} data-action="remove-category" onClick={() => controller.removeCategory(i)}>
                      ×
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {!readOnly && (
        <div className="p-1">
          <button type="button" className={`${chartButtonClass} h-6 border-dashed`} data-action="add-category" onClick={() => controller.addCategory()}>
            + Add category
          </button>
        </div>
      )}
    </div>
  );
}
