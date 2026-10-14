import React from 'react';
import type { SpreadsheetRowGroup, SpreadsheetViewColumn } from '@pixerate/editor/spreadsheet';

export interface SpreadsheetGroupRowProps {
  group: SpreadsheetRowGroup;
  columns: SpreadsheetViewColumn[];
  /** Column the rows are grouped by: shows the group label and toggle. */
  groupColId: string;
  onToggle: (key: string) => void;
  /** Render a trailing cell for the "add column" column. */
  trailingCell?: boolean;
  /** Every displayed column, when `columns` is a virtualised window of them (picks the label column). */
  labelColumns?: SpreadsheetViewColumn[];
  /** Virtualised: columns before the left spacer (the frozen ones), and the spacers' widths. */
  leadingColumns?: number;
  leftSpace?: number;
  rightSpace?: number;
}

const formatSummary = (value: number | null) => (value === null ? '–' : String(value));

/** A category header row: collapse toggle, label, row count and per-column summaries. */
export const SpreadsheetGroupRow: React.FC<SpreadsheetGroupRowProps> = ({
  group,
  columns,
  groupColId,
  onToggle,
  trailingCell,
  labelColumns = columns,
  leadingColumns,
  leftSpace = 0,
  rightSpace = 0
}) => {
  // The label goes in the grouping column, or the first column when that one is hidden.
  const labelColId = labelColumns.some((c) => c.column.id === groupColId) ? groupColId : labelColumns[0]?.column.id;
  const spacer = (key: string) => <td key={key} aria-hidden="true" data-spacer="" style={{ padding: 0 }} />;
  return (
  <tr className="border-b border-border bg-muted/40 font-semibold" data-group-key={group.key} style={{ height: 28 }}>
    <td className="w-12 min-w-[3rem] sticky left-0 z-10 bg-muted border-r border-border text-center">
      <button
        type="button"
        aria-label={`${group.collapsed ? 'Expand' : 'Collapse'} group ${group.label}`}
        aria-expanded={!group.collapsed}
        className="h-5 w-5 rounded text-[10px] text-muted-foreground hover:bg-muted"
        onClick={(e) => {
          e.stopPropagation();
          onToggle(group.key);
        }}
      >
        {group.collapsed ? '▸' : '▾'}
      </button>
    </td>
    {columns.map(({ column }, i) => {
      const summary = group.summaries[column.id];
      const before = leadingColumns !== undefined && i === leadingColumns && leftSpace > 0 ? spacer('space:left') : null;
      return (
        <React.Fragment key={column.id}>
        {before}
        <td className="border-r border-border px-2 py-1 truncate max-w-0 text-foreground" style={{ maxWidth: 0, overflow: 'hidden' }}>
          {column.id === labelColId ? (
            <span className="truncate">
              {group.label} <span className="font-normal text-muted-foreground">({group.rowIndices.length})</span>
            </span>
          ) : summary !== undefined ? (
            <span className="truncate" data-summary={column.id}>{formatSummary(summary)}</span>
          ) : null}
        </td>
        </React.Fragment>
      );
    })}
    {leadingColumns !== undefined && leadingColumns >= columns.length && leftSpace > 0 && spacer('space:left')}
    {rightSpace > 0 && spacer('space:right')}
    {trailingCell && <td className="w-10 min-w-[2.5rem] bg-muted/10 border-r border-border" />}
  </tr>
  );
};
