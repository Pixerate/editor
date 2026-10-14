/**
 * The render model of a spreadsheet: which rows and columns are shown, in
 * which order, with group header rows, frozen (sticky) offsets and merged
 * cell spans. Filters, hidden rows/columns and collapsed groups only affect
 * this view; the document keeps every row.
 */
import type {
  CellRange,
  SpreadsheetColumn,
  SpreadsheetDocument,
  SpreadsheetRow,
} from './types';
import type { CellPosition } from './formula';
import { aggregateValues, compareCellValues, isBlankValue, matchesFilterRule, normalizeRange } from './table';

export const DEFAULT_ROW_HEIGHT = 32;
export const DEFAULT_COLUMN_WIDTH = 130;

export type SpreadsheetRowSection = 'header' | 'body' | 'footer';

export interface SpreadsheetRowGroup {
  key: string; // grouping value as text ('' for blanks)
  label: string;
  rowIndices: number[]; // member rows that pass the filters, in document order
  collapsed: boolean;
  summaries: Record<string, number | null>; // colId -> aggregate
}

export type SpreadsheetViewRow =
  | {
      kind: 'row';
      row: SpreadsheetRow;
      index: number; // document row index
      section: SpreadsheetRowSection;
      frozen: boolean;
      stickyTop: number; // offset from the first frozen row (frozen rows only)
      groupKey?: string;
    }
  | { kind: 'group'; group: SpreadsheetRowGroup };

export interface SpreadsheetViewColumn {
  column: SpreadsheetColumn;
  index: number; // document column index
  header: boolean; // inside the header columns
  frozen: boolean;
  stickyLeft: number; // offset from the first frozen column (frozen columns only)
}

export interface SpreadsheetCellSpan {
  rowSpan: number;
  colSpan: number;
  /** The cell whose content is shown (a merge's top-left cell). */
  source: CellPosition;
  merge?: CellRange;
}

export interface SpreadsheetViewModel {
  rows: SpreadsheetViewRow[];
  columns: SpreadsheetViewColumn[];
  groups: SpreadsheetRowGroup[];
  /** Visible document row indices in display order (for keyboard navigation). */
  rowOrder: number[];
  /** Visible document column indices in display order. */
  columnOrder: number[];
  filteredOutCount: number;
  hiddenRowCount: number;
  hiddenColumnCount: number;
  /**
   * Span of the cell rendered at (row, col): `{ rowSpan: 1, colSpan: 1 }` for
   * an ordinary cell, the visible extent for a merge's first visible cell, and
   * null for cells covered by a merge (render nothing).
   */
  getCellSpan(row: number, col: number): SpreadsheetCellSpan | null;
}

export type CellValueReader = (rowIndex: number, colIndex: number) => unknown;

const clampCount = (value: number | undefined, max: number) => Math.max(0, Math.min(Math.floor(value ?? 0), max));

/** Header and footer row counts, clamped so they never overlap. */
export function getTableSections(doc: SpreadsheetDocument): { headerRows: number; footerRows: number } {
  const total = doc.rows.length;
  const headerRows = clampCount(doc.table?.headerRowCount, total);
  const footerRows = clampCount(doc.table?.footerRowCount, total - headerRows);
  return { headerRows, footerRows };
}

export function getRowSection(doc: SpreadsheetDocument, rowIndex: number): SpreadsheetRowSection {
  const { headerRows, footerRows } = getTableSections(doc);
  if (rowIndex < headerRows) return 'header';
  if (rowIndex >= doc.rows.length - footerRows) return 'footer';
  return 'body';
}

/** Whether a body row passes the active filters. Header/footer rows always do. */
export function rowPassesFilters(doc: SpreadsheetDocument, rowIndex: number, getValue: CellValueReader): boolean {
  const filter = doc.table?.filter;
  if (!filter?.enabled || filter.rules.length === 0) return true;
  if (getRowSection(doc, rowIndex) !== 'body') return true;
  return filter.rules.every((rule) => {
    const colIndex = doc.columns.findIndex((c) => c.id === rule.colId);
    if (colIndex === -1) return true; // rules on deleted columns are ignored
    return matchesFilterRule(getValue(rowIndex, colIndex), rule);
  });
}

/** Category groups of the (unhidden, unfiltered) body rows. */
export function computeRowGroups(doc: SpreadsheetDocument, getValue: CellValueReader): SpreadsheetRowGroup[] {
  const grouping = doc.table?.grouping;
  if (!grouping) return [];
  const groupCol = doc.columns.findIndex((c) => c.id === grouping.colId);
  if (groupCol === -1) return [];

  const { headerRows, footerRows } = getTableSections(doc);
  const byKey = new Map<string, number[]>();
  for (let r = headerRows; r < doc.rows.length - footerRows; r++) {
    if (doc.rows[r].hidden || !rowPassesFilters(doc, r, getValue)) continue;
    const value = getValue(r, groupCol);
    const key = isBlankValue(value) ? '' : String(value).trim();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }

  const collapsed = new Set(grouping.collapsed);
  return Array.from(byKey.keys())
    .sort((a, b) => compareCellValues(a, b))
    .map((key) => {
      const rowIndices = byKey.get(key)!;
      const summaries: Record<string, number | null> = {};
      for (const summary of grouping.summaries) {
        const colIndex = doc.columns.findIndex((c) => c.id === summary.colId);
        if (colIndex === -1) continue;
        summaries[summary.colId] = aggregateValues(
          rowIndices.map((r) => getValue(r, colIndex)),
          summary.aggregate,
        );
      }
      return { key, label: key === '' ? '(blank)' : key, rowIndices, collapsed: collapsed.has(key), summaries };
    });
}

export function buildSpreadsheetView(doc: SpreadsheetDocument, getValue: CellValueReader): SpreadsheetViewModel {
  const { headerRows, footerRows } = getTableSections(doc);
  const frozenRows = clampCount(doc.table?.frozenRowCount, doc.rows.length);
  const frozenCols = clampCount(doc.table?.frozenColumnCount, doc.columns.length);
  const headerCols = clampCount(doc.table?.headerColumnCount, doc.columns.length);

  // Columns
  const columns: SpreadsheetViewColumn[] = [];
  let left = 0;
  let hiddenColumnCount = 0;
  doc.columns.forEach((column, index) => {
    if (column.hidden) {
      hiddenColumnCount++;
      return;
    }
    const frozen = index < frozenCols;
    columns.push({ column, index, header: index < headerCols, frozen, stickyLeft: frozen ? left : 0 });
    if (frozen) left += column.width || DEFAULT_COLUMN_WIDTH;
  });

  // Rows
  const rows: SpreadsheetViewRow[] = [];
  let hiddenRowCount = 0;
  let filteredOutCount = 0;
  const pushRow = (index: number, section: SpreadsheetRowSection, groupKey?: string) => {
    const row = doc.rows[index];
    rows.push({ kind: 'row', row, index, section, frozen: false, stickyTop: 0, groupKey });
  };

  for (let r = 0; r < headerRows; r++) {
    if (doc.rows[r].hidden) hiddenRowCount++;
    else pushRow(r, 'header');
  }

  const bodyEnd = doc.rows.length - footerRows;
  const groups = computeRowGroups(doc, getValue);
  for (let r = headerRows; r < bodyEnd; r++) {
    if (doc.rows[r].hidden) hiddenRowCount++;
    else if (!rowPassesFilters(doc, r, getValue)) filteredOutCount++;
  }
  const grouping = doc.table?.grouping;
  if (grouping && doc.columns.some((c) => c.id === grouping.colId)) {
    for (const group of groups) {
      rows.push({ kind: 'group', group });
      if (!group.collapsed) group.rowIndices.forEach((r) => pushRow(r, 'body', group.key));
    }
  } else {
    for (let r = headerRows; r < bodyEnd; r++) {
      if (!doc.rows[r].hidden && rowPassesFilters(doc, r, getValue)) pushRow(r, 'body');
    }
  }

  for (let r = bodyEnd; r < doc.rows.length; r++) {
    if (doc.rows[r].hidden) hiddenRowCount++;
    else pushRow(r, 'footer');
  }

  // Frozen rows: the leading run of displayed rows inside the frozen count.
  let top = 0;
  for (const viewRow of rows) {
    if (viewRow.kind !== 'row' || viewRow.index >= frozenRows) break;
    viewRow.frozen = true;
    viewRow.stickyTop = top;
    top += viewRow.row.height || DEFAULT_ROW_HEIGHT;
  }

  const rowOrder = rows.flatMap((r) => (r.kind === 'row' ? [r.index] : []));
  const columnOrder = columns.map((c) => c.index);

  // Merged cells: span the visible, display-contiguous part of each merge.
  const rowPos = new Map(rowOrder.map((index, pos) => [index, pos]));
  const colPos = new Map(columnOrder.map((index, pos) => [index, pos]));
  const spans = new Map<string, SpreadsheetCellSpan | null>();
  const contiguousRun = (indices: number[], positions: Map<number, number>) => {
    const visible = indices
      .filter((i) => positions.has(i))
      .sort((a, b) => positions.get(a)! - positions.get(b)!);
    if (visible.length === 0) return null;
    let run = 1;
    while (run < visible.length && positions.get(visible[run])! === positions.get(visible[0])! + run) run++;
    return { first: visible[0], run };
  };
  for (const raw of doc.table?.merges ?? []) {
    const merge = normalizeRange(raw);
    const rowIdx: number[] = [];
    const colIdx: number[] = [];
    for (let r = merge.startRow; r <= merge.endRow; r++) rowIdx.push(r);
    for (let c = merge.startCol; c <= merge.endCol; c++) colIdx.push(c);
    const rowRun = contiguousRun(rowIdx, rowPos);
    const colRun = contiguousRun(colIdx, colPos);
    for (const r of rowIdx) for (const c of colIdx) spans.set(`${r}:${c}`, null);
    if (rowRun && colRun) {
      spans.set(`${rowRun.first}:${colRun.first}`, {
        rowSpan: rowRun.run,
        colSpan: colRun.run,
        source: { row: merge.startRow, col: merge.startCol },
        merge,
      });
    }
  }

  return {
    rows,
    columns,
    groups,
    rowOrder,
    columnOrder,
    filteredOutCount,
    hiddenRowCount,
    hiddenColumnCount,
    getCellSpan(row, col) {
      const span = spans.get(`${row}:${col}`);
      if (span === undefined) return { rowSpan: 1, colSpan: 1, source: { row, col } };
      return span;
    },
  };
}
