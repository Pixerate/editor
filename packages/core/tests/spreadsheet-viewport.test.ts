import { describe, expect, it } from 'vitest';
import {
  SpreadsheetController,
  SPREADSHEET_COLUMN_HEADER_HEIGHT,
  SPREADSHEET_GROUP_ROW_HEIGHT,
  fullSpreadsheetViewWindow,
  getSpreadsheetScrollToCell,
  getSpreadsheetViewWindow,
  indexToColName,
  measureSpreadsheetView,
  shouldVirtualizeSpreadsheet,
  type SpreadsheetDocument,
} from '../src/spreadsheet';

function controller(rows: number, cols: number): SpreadsheetController {
  const columns = Array.from({ length: cols }, (_, c) => {
    const key = indexToColName(c);
    return { id: `c${c}`, key, title: key, width: 100, type: 'freeform' as const };
  });
  const rowList = Array.from({ length: rows }, (_, r) => ({ id: `r${r}`, index: r, height: 32, type: 'freeform' as const }));
  const doc: SpreadsheetDocument = { id: 's', name: 'S', columns, rows: rowList, cells: {}, createdAt: 0, updatedAt: 0 };
  return new SpreadsheetController({ document: doc });
}

const viewport = (scrollTop: number, scrollLeft = 0) => ({ scrollTop, scrollLeft, width: 800 + 48, height: 320 + 28 });

describe('spreadsheet viewport', () => {
  it('measures rows, group rows and columns', () => {
    const ctrl = controller(10, 3);
    ctrl.setColumnWidth('c1', 50);
    ctrl.getRow(2)!.height = 60;
    ctrl.setFrozenRowCount(1);
    ctrl.setFrozenColumnCount(1);
    const metrics = measureSpreadsheetView(ctrl.getViewModel());
    expect(Array.from(metrics.rowTops.slice(0, 4))).toEqual([0, 32, 64, 124]);
    expect(metrics.rowTops[10]).toBe(32 * 9 + 60);
    expect(Array.from(metrics.columnLefts)).toEqual([0, 100, 150, 250]);
    expect(metrics.frozenRows).toBe(1);
    expect(metrics.frozenColumns).toBe(1);

    ctrl.setFrozenRowCount(0);
    ctrl.groupRowsBy('c0');
    const grouped = measureSpreadsheetView(ctrl.getViewModel());
    // One group (all blank): its header row, then the ten rows.
    expect(grouped.rowTops[1]).toBe(SPREADSHEET_GROUP_ROW_HEIGHT);
    expect(grouped.rowPosition.get(0)).toBe(1);
  });

  it('virtualises large views only, unless forced', () => {
    expect(shouldVirtualizeSpreadsheet(controller(200, 5).getViewModel())).toBe(false);
    expect(shouldVirtualizeSpreadsheet(controller(201, 5).getViewModel())).toBe(true);
    expect(shouldVirtualizeSpreadsheet(controller(10, 61).getViewModel())).toBe(true);
    expect(shouldVirtualizeSpreadsheet(controller(10, 5).getViewModel(), true)).toBe(true);
    expect(shouldVirtualizeSpreadsheet(controller(5000, 5).getViewModel(), false)).toBe(false);
  });

  it('windows the rows and columns in view, with overscan and spacers', () => {
    const metrics = measureSpreadsheetView(controller(1000, 50).getViewModel());
    const win = getSpreadsheetViewWindow(metrics, viewport(100 * 32, 10 * 100), { overscanRows: 2, overscanColumns: 1 });
    // 320px of rows from row 100 (rows 100..109), 800px of columns from column 10 (10..17).
    expect([win.rowStart, win.rowEnd]).toEqual([98, 112]);
    expect([win.colStart, win.colEnd]).toEqual([9, 19]);
    expect(win.topSpace).toBe(98 * 32);
    expect(win.bottomSpace).toBe((1000 - 112) * 32);
    expect(win.leftSpace).toBe(900);
    expect(win.rightSpace).toBe((50 - 19) * 100);
    const full = fullSpreadsheetViewWindow(metrics);
    expect([full.rowStart, full.rowEnd, full.topSpace, full.bottomSpace]).toEqual([0, 1000, 0, 0]);
  });

  it('starts the window after the frozen rows and columns', () => {
    const ctrl = controller(1000, 50);
    ctrl.setFrozenRowCount(3);
    ctrl.setFrozenColumnCount(2);
    const metrics = measureSpreadsheetView(ctrl.getViewModel());
    const top = getSpreadsheetViewWindow(metrics, viewport(0), { overscanRows: 0, overscanColumns: 0 });
    expect([top.frozenRows, top.rowStart, top.topSpace]).toEqual([3, 3, 0]);
    const scrolled = getSpreadsheetViewWindow(metrics, viewport(500 * 32, 2_000), { overscanRows: 0, overscanColumns: 0 });
    expect(scrolled.rowStart).toBe(500);
    expect(scrolled.topSpace).toBe((500 - 3) * 32);
    expect(scrolled.colStart).toBe(20);
    expect(scrolled.leftSpace).toBe((20 - 2) * 100);
  });

  it('widens the window so merges crossing its edges render whole', () => {
    const ctrl = controller(1000, 50);
    const metrics = measureSpreadsheetView(ctrl.getViewModel());
    const merges = [
      { startRow: 90, startCol: 0, endRow: 101, endCol: 1 },
      { startRow: 108, startCol: 3, endRow: 130, endCol: 3 },
      { startRow: 500, startCol: 0, endRow: 600, endCol: 0 }, // out of view
    ];
    const win = getSpreadsheetViewWindow(metrics, viewport(100 * 32), { overscanRows: 0, overscanColumns: 0, merges });
    expect([win.rowStart, win.rowEnd]).toEqual([90, 131]);
  });

  it('scrolls a cell into view below the header and frozen panes', () => {
    const ctrl = controller(1000, 50);
    ctrl.setFrozenRowCount(2);
    const metrics = measureSpreadsheetView(ctrl.getViewModel());
    const vp = viewport(0);
    expect(getSpreadsheetScrollToCell(metrics, vp, { row: 5, col: 0 })).toBeNull();
    // Row 20's bottom (21 × 32) must fit in the 320px under the header.
    expect(getSpreadsheetScrollToCell(metrics, vp, { row: 20, col: 0 })).toEqual({ scrollTop: 21 * 32 - 320 });
    // Scrolled past row 10: it goes just under the two frozen rows.
    expect(getSpreadsheetScrollToCell(metrics, viewport(400 * 32), { row: 10, col: 0 })).toEqual({ scrollTop: 10 * 32 - 64 });
    expect(getSpreadsheetScrollToCell(metrics, vp, { row: 0, col: 30 })).toEqual({ scrollLeft: 31 * 100 - 800 });
    // Frozen rows are always in view.
    expect(getSpreadsheetScrollToCell(metrics, viewport(400 * 32), { row: 1, col: 0 })).toBeNull();
    expect(SPREADSHEET_COLUMN_HEADER_HEIGHT).toBe(28);
  });
});
