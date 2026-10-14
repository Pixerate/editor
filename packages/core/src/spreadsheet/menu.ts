/**
 * The spreadsheet's table context menu, defined once so the React and Svelte
 * editors show the same actions. Frameworks render the items and call
 * `run()`; the controller's change listeners refresh their state.
 */
import type { SpreadsheetController } from './controller';
import type { CellRange } from './types';
import type { CellPosition } from './formula';
import { indexToColName } from './formula';
import { isSingleCellRange, normalizeRange, rangeContains, rangesIntersect } from './table';

export interface SpreadsheetMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  /** Draw a divider before this item. */
  separatorBefore?: boolean;
  run: () => void;
}

const quote = (value: unknown) => {
  const text = String(value ?? '');
  return text.length > 24 ? `"${text.slice(0, 23)}…"` : `"${text}"`;
};

/**
 * Menu items for a right-click on `cell`. When the cell is inside the
 * selection, range actions (hide, merge, transpose) apply to the selection;
 * otherwise to the clicked cell.
 */
export function getSpreadsheetMenuItems(controller: SpreadsheetController, cell: CellPosition): SpreadsheetMenuItem[] {
  const doc = controller.document;
  const column = doc.columns[cell.col];
  const row = doc.rows[cell.row];
  if (!column || !row) return [];

  const selection: CellRange =
    controller.selectedRange && rangeContains(controller.selectedRange, cell.row, cell.col)
      ? normalizeRange(controller.selectedRange)
      : { startRow: cell.row, startCol: cell.col, endRow: cell.row, endCol: cell.col };
  const colName = indexToColName(cell.col);
  const value = controller.getCell(row.id, column.id).value;
  const table = doc.table ?? {};
  const filter = controller.getFilterState();
  const grouping = table.grouping;
  const rows = Array.from({ length: selection.endRow - selection.startRow + 1 }, (_, i) => selection.startRow + i);
  const cols = Array.from({ length: selection.endCol - selection.startCol + 1 }, (_, i) => selection.startCol + i);
  const anyHidden = doc.rows.some((r) => r.hidden) || doc.columns.some((c) => c.hidden);
  const hasMerge = controller.getMerges().some((m) => rangesIntersect(m, selection));
  const sortRange = isSingleCellRange(selection) ? null : selection;

  const items: SpreadsheetMenuItem[] = [
    {
      id: 'sort-asc',
      label: `Sort ascending by column ${colName}`,
      run: () => controller.sortRows([{ colId: column.id, direction: 'asc' }], { range: sortRange }),
    },
    {
      id: 'sort-desc',
      label: `Sort descending by column ${colName}`,
      run: () => controller.sortRows([{ colId: column.id, direction: 'desc' }], { range: sortRange }),
    },
    {
      id: 'filter-equals',
      label: `Show only rows where ${colName} = ${quote(value)}`,
      separatorBefore: true,
      run: () => controller.addFilterRule({ colId: column.id, operator: 'equals', value: String(value ?? '') }),
    },
    {
      id: 'filter-toggle',
      label: filter.enabled ? 'Turn filters off' : 'Turn filters on',
      disabled: filter.rules.length === 0,
      run: () => controller.toggleFilters(),
    },
    {
      id: 'filter-clear',
      label: 'Clear filters',
      disabled: filter.rules.length === 0,
      run: () => controller.clearFilters(),
    },
    {
      id: 'freeze-rows',
      label: `Freeze rows 1–${cell.row + 1}`,
      separatorBefore: true,
      run: () => controller.setFrozenRowCount(cell.row + 1),
    },
    {
      id: 'freeze-columns',
      label: `Freeze columns A–${colName}`,
      run: () => controller.setFrozenColumnCount(cell.col + 1),
    },
    {
      id: 'unfreeze',
      label: 'Unfreeze rows and columns',
      disabled: !table.frozenRowCount && !table.frozenColumnCount,
      run: () => {
        controller.setFrozenRowCount(0);
        controller.setFrozenColumnCount(0);
      },
    },
    {
      id: 'header-rows',
      label: `Use rows 1–${cell.row + 1} as header rows`,
      run: () => controller.setHeaderRowCount(cell.row + 1),
    },
    {
      id: 'footer-rows',
      label: `Use rows ${cell.row + 1}–${doc.rows.length} as footer rows`,
      run: () => controller.setFooterRowCount(doc.rows.length - cell.row),
    },
    {
      id: 'hide-rows',
      label: rows.length > 1 ? `Hide ${rows.length} rows` : `Hide row ${cell.row + 1}`,
      separatorBefore: true,
      run: () => controller.hideRows(rows),
    },
    {
      id: 'hide-columns',
      label: cols.length > 1 ? `Hide ${cols.length} columns` : `Hide column ${colName}`,
      run: () => controller.hideColumns(cols),
    },
    {
      id: 'unhide-all',
      label: 'Unhide all rows and columns',
      disabled: !anyHidden,
      run: () => controller.unhideAll(),
    },
    {
      id: 'merge',
      label: 'Merge cells',
      separatorBefore: true,
      disabled: isSingleCellRange(selection),
      run: () => {
        controller.mergeCells(selection);
      },
    },
    {
      id: 'unmerge',
      label: 'Unmerge cells',
      disabled: !hasMerge,
      run: () => {
        controller.unmergeCells(selection);
      },
    },
    {
      id: 'transpose',
      label: 'Transpose',
      disabled: isSingleCellRange(selection),
      run: () => {
        controller.transposeRange(selection);
      },
    },
  ];

  if (grouping) {
    items.push(
      {
        id: 'ungroup',
        label: 'Remove categories',
        separatorBefore: true,
        run: () => controller.ungroupRows(),
      },
      ...(['sum', 'count', 'average'] as const).map((aggregate) => ({
        id: `summary-${aggregate}`,
        label: `Summarize column ${colName}: ${aggregate.toUpperCase()}`,
        run: () => controller.setGroupSummary(column.id, aggregate),
      })),
    );
  } else {
    items.push({
      id: 'group-by',
      label: `Categorize by column ${colName}`,
      separatorBefore: true,
      run: () => controller.groupRowsBy(column.id),
    });
  }

  return items;
}
