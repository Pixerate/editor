/**
 * Virtualised rendering of large sheets: which displayed rows and columns
 * are inside (or near) the scrolled viewport, the space taken by the ones
 * left out, and how far to scroll to bring a cell into view. Framework
 * bindings render the frozen rows/columns, a spacer, the window and another
 * spacer; small sheets render everything (`shouldVirtualizeSpreadsheet`).
 */
import type { CellRange } from './types';
import { normalizeRange } from './table';
import { DEFAULT_COLUMN_WIDTH, DEFAULT_ROW_HEIGHT, type SpreadsheetViewModel } from './view';

/** Height of the sticky column-header row, in pixels. */
export const SPREADSHEET_COLUMN_HEADER_HEIGHT = 28;
/** Width of the sticky row-number column, in pixels. */
export const SPREADSHEET_ROW_HEADER_WIDTH = 48;
/** Height of a category (group) header row, in pixels. */
export const SPREADSHEET_GROUP_ROW_HEIGHT = 28;
/** Displayed rows above which `shouldVirtualizeSpreadsheet` turns virtualisation on. */
export const SPREADSHEET_VIRTUAL_ROW_THRESHOLD = 200;
/** Displayed columns above which `shouldVirtualizeSpreadsheet` turns virtualisation on. */
export const SPREADSHEET_VIRTUAL_COLUMN_THRESHOLD = 60;
/** Viewport assumed before the grid has been measured (server rendering, jsdom). */
export const SPREADSHEET_DEFAULT_VIEWPORT = { width: 1200, height: 600 };

/** Pixel positions of a view model's rows and columns (see `measureSpreadsheetView`). */
export interface SpreadsheetViewMetrics {
  /** Top of each entry of `view.rows`, below the column header; the last entry is the total height. */
  rowTops: Float64Array;
  /** Left of each entry of `view.columns`, after the row header; the last entry is the total width. */
  columnLefts: Float64Array;
  /** Leading frozen entries of `view.rows` (always rendered, sticky). */
  frozenRows: number;
  /** Leading frozen entries of `view.columns`. */
  frozenColumns: number;
  /** Position in `view.rows` of each displayed document row. */
  rowPosition: Map<number, number>;
  /** Position in `view.columns` of each displayed document column. */
  columnPosition: Map<number, number>;
}

/** The scroll container: its scroll offsets and client size, in pixels. */
export interface SpreadsheetViewport {
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
}

/**
 * The part of a view model to render: frozen rows `[0, frozenRows)`, then
 * `topSpace` pixels of rows left out, then rows `[rowStart, rowEnd)`, then
 * `bottomSpace`; columns likewise (indices into `view.rows` / `view.columns`).
 */
export interface SpreadsheetViewWindow {
  virtual: boolean;
  frozenRows: number;
  rowStart: number;
  rowEnd: number;
  topSpace: number;
  bottomSpace: number;
  frozenColumns: number;
  colStart: number;
  colEnd: number;
  leftSpace: number;
  rightSpace: number;
}

export interface SpreadsheetViewWindowOptions {
  /** Extra rows rendered above and below the viewport. Default 8. */
  overscanRows?: number;
  /** Extra columns rendered left and right of the viewport. Default 2. */
  overscanColumns?: number;
  /** Merged ranges (document indices): a merge crossing the window's edge is rendered whole. */
  merges?: readonly CellRange[];
}

/** Measures the rows (row height, or the group row height) and columns (width) of a view model. */
export function measureSpreadsheetView(view: SpreadsheetViewModel): SpreadsheetViewMetrics {
  const rowTops = new Float64Array(view.rows.length + 1);
  const rowPosition = new Map<number, number>();
  let frozenRows = 0;
  let top = 0;
  view.rows.forEach((viewRow, i) => {
    rowTops[i] = top;
    if (viewRow.kind === 'row') {
      rowPosition.set(viewRow.index, i);
      if (viewRow.frozen && frozenRows === i) frozenRows = i + 1;
      top += viewRow.row.height || DEFAULT_ROW_HEIGHT;
    } else {
      top += SPREADSHEET_GROUP_ROW_HEIGHT;
    }
  });
  rowTops[view.rows.length] = top;

  const columnLefts = new Float64Array(view.columns.length + 1);
  const columnPosition = new Map<number, number>();
  let frozenColumns = 0;
  let left = 0;
  view.columns.forEach((viewCol, i) => {
    columnLefts[i] = left;
    columnPosition.set(viewCol.index, i);
    if (viewCol.frozen && frozenColumns === i) frozenColumns = i + 1;
    left += viewCol.column.width || DEFAULT_COLUMN_WIDTH;
  });
  columnLefts[view.columns.length] = left;
  return { rowTops, columnLefts, frozenRows, frozenColumns, rowPosition, columnPosition };
}

/**
 * Whether to virtualise: `true` / `false` force it; `'auto'` (the default)
 * virtualises views with more than `SPREADSHEET_VIRTUAL_ROW_THRESHOLD` rows
 * or `SPREADSHEET_VIRTUAL_COLUMN_THRESHOLD` columns, so small sheets render
 * every cell exactly as before.
 */
export function shouldVirtualizeSpreadsheet(view: SpreadsheetViewModel, mode: boolean | 'auto' = 'auto'): boolean {
  if (mode !== 'auto') return mode;
  return view.rows.length > SPREADSHEET_VIRTUAL_ROW_THRESHOLD || view.columns.length > SPREADSHEET_VIRTUAL_COLUMN_THRESHOLD;
}

/** A window holding every row and column (no spacers). */
export function fullSpreadsheetViewWindow(metrics: SpreadsheetViewMetrics): SpreadsheetViewWindow {
  return {
    virtual: false,
    frozenRows: metrics.frozenRows,
    rowStart: metrics.frozenRows,
    rowEnd: metrics.rowTops.length - 1,
    topSpace: 0,
    bottomSpace: 0,
    frozenColumns: metrics.frozenColumns,
    colStart: metrics.frozenColumns,
    colEnd: metrics.columnLefts.length - 1,
    leftSpace: 0,
    rightSpace: 0,
  };
}

/** First index `i` in `[lo, hi)` with `edges[i + 1] > value` (the entry containing `value`). */
function entryAt(edges: Float64Array, value: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (edges[mid + 1] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The visible slice `[start, end)` of entries after `frozen`, with overscan. */
function visibleSlice(edges: Float64Array, frozen: number, from: number, to: number, overscan: number): [number, number] {
  const count = edges.length - 1;
  if (count <= frozen) return [frozen, frozen];
  const first = entryAt(edges, from, frozen, count);
  const last = entryAt(edges, Math.max(from, to - 1), first, count);
  return [Math.max(frozen, first - overscan), Math.min(count, last + 1 + overscan)];
}

/**
 * The rows and columns to render for a viewport. Frozen rows and columns are
 * always rendered; the rest are limited to the viewport plus overscan, and
 * widened so no merge is cut by the window's edge.
 */
export function getSpreadsheetViewWindow(
  metrics: SpreadsheetViewMetrics,
  viewport: SpreadsheetViewport,
  options: SpreadsheetViewWindowOptions = {},
): SpreadsheetViewWindow {
  const overscanRows = options.overscanRows ?? 8;
  const overscanColumns = options.overscanColumns ?? 2;
  const height = viewport.height > 0 ? viewport.height : SPREADSHEET_DEFAULT_VIEWPORT.height;
  const width = viewport.width > 0 ? viewport.width : SPREADSHEET_DEFAULT_VIEWPORT.width;
  const { rowTops, columnLefts, frozenRows, frozenColumns } = metrics;
  const rowCount = rowTops.length - 1;
  const colCount = columnLefts.length - 1;

  // Body coordinates: rows start under the header, columns after the row numbers.
  const top = Math.max(0, viewport.scrollTop);
  let [rowStart, rowEnd] = visibleSlice(rowTops, frozenRows, top, top + Math.max(0, height - SPREADSHEET_COLUMN_HEADER_HEIGHT), overscanRows);
  const left = Math.max(0, viewport.scrollLeft);
  let [colStart, colEnd] = visibleSlice(columnLefts, frozenColumns, left, left + Math.max(0, width - SPREADSHEET_ROW_HEADER_WIDTH), overscanColumns);

  // Widen the window until no merge crosses its edges (a merge's top-left
  // cell carries the row and column spans).
  const merges = options.merges ?? [];
  for (let changed = merges.length > 0, guard = 0; changed && guard < 8; guard++) {
    changed = false;
    for (const raw of merges) {
      const merge = normalizeRange(raw);
      const rows = displayedSpan(metrics.rowPosition, merge.startRow, merge.endRow);
      const cols = displayedSpan(metrics.columnPosition, merge.startCol, merge.endCol);
      if (!rows || !cols) continue;
      const rowsMeet = rows[1] >= rowStart && rows[0] < rowEnd;
      const colsMeet = cols[1] >= colStart && cols[0] < colEnd;
      if (!rowsMeet && !(rows[1] < frozenRows)) continue;
      if (!colsMeet && !(cols[1] < frozenColumns)) continue;
      if (rowsMeet) {
        const s = Math.max(frozenRows, rows[0]);
        const e = rows[1] + 1;
        if (s < rowStart || e > rowEnd) {
          rowStart = Math.min(rowStart, s);
          rowEnd = Math.max(rowEnd, e);
          changed = true;
        }
      }
      if (colsMeet) {
        const s = Math.max(frozenColumns, cols[0]);
        const e = cols[1] + 1;
        if (s < colStart || e > colEnd) {
          colStart = Math.min(colStart, s);
          colEnd = Math.max(colEnd, e);
          changed = true;
        }
      }
    }
  }

  return {
    virtual: true,
    frozenRows,
    rowStart,
    rowEnd,
    topSpace: rowTops[rowStart] - rowTops[frozenRows],
    bottomSpace: rowTops[rowCount] - rowTops[rowEnd],
    frozenColumns,
    colStart,
    colEnd,
    leftSpace: columnLefts[colStart] - columnLefts[frozenColumns],
    rightSpace: columnLefts[colCount] - columnLefts[colEnd],
  };
}

/** Lowest and highest displayed position of document indices `from..to`, or null when none is displayed. */
function displayedSpan(positions: Map<number, number>, from: number, to: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i <= to; i++) {
    const pos = positions.get(i);
    if (pos === undefined) continue;
    if (pos < lo) lo = pos;
    if (pos > hi) hi = pos;
  }
  return lo === Infinity ? null : [lo, hi];
}

/**
 * Scroll offsets that bring the cell at document (row, col) fully into view
 * (below the frozen rows, right of the frozen columns), or null when it
 * already is (or isn't displayed). Only the axes that must move are set.
 */
export function getSpreadsheetScrollToCell(
  metrics: SpreadsheetViewMetrics,
  viewport: SpreadsheetViewport,
  cell: { row: number; col: number },
): { scrollTop?: number; scrollLeft?: number } | null {
  const height = viewport.height > 0 ? viewport.height : SPREADSHEET_DEFAULT_VIEWPORT.height;
  const width = viewport.width > 0 ? viewport.width : SPREADSHEET_DEFAULT_VIEWPORT.width;
  const result: { scrollTop?: number; scrollLeft?: number } = {};

  const rowPos = metrics.rowPosition.get(cell.row);
  if (rowPos !== undefined && rowPos >= metrics.frozenRows) {
    const frozenHeight = metrics.rowTops[metrics.frozenRows];
    const top = metrics.rowTops[rowPos];
    const bottom = metrics.rowTops[rowPos + 1];
    const visibleHeight = height - SPREADSHEET_COLUMN_HEADER_HEIGHT;
    if (top < viewport.scrollTop + frozenHeight) result.scrollTop = Math.max(0, top - frozenHeight);
    else if (bottom > viewport.scrollTop + visibleHeight) result.scrollTop = Math.max(0, bottom - visibleHeight);
  }

  const colPos = metrics.columnPosition.get(cell.col);
  if (colPos !== undefined && colPos >= metrics.frozenColumns) {
    const frozenWidth = metrics.columnLefts[metrics.frozenColumns];
    const left = metrics.columnLefts[colPos];
    const right = metrics.columnLefts[colPos + 1];
    const visibleWidth = width - SPREADSHEET_ROW_HEADER_WIDTH;
    if (left < viewport.scrollLeft + frozenWidth) result.scrollLeft = Math.max(0, left - frozenWidth);
    else if (right > viewport.scrollLeft + visibleWidth) result.scrollLeft = Math.max(0, right - visibleWidth);
  }

  return result.scrollTop === undefined && result.scrollLeft === undefined ? null : result;
}

/** Whether two windows render the same rows and columns. */
export function sameSpreadsheetViewWindow(a: SpreadsheetViewWindow, b: SpreadsheetViewWindow): boolean {
  return (
    a.virtual === b.virtual &&
    a.rowStart === b.rowStart &&
    a.rowEnd === b.rowEnd &&
    a.colStart === b.colStart &&
    a.colEnd === b.colEnd &&
    a.topSpace === b.topSpace &&
    a.bottomSpace === b.bottomSpace &&
    a.leftSpace === b.leftSpace &&
    a.rightSpace === b.rightSpace
  );
}
