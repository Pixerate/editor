import {
  SpreadsheetDocument,
  SpreadsheetColumn,
  SpreadsheetRow,
  CellCoordinate,
  CellRange,
  CellData,
  SpreadsheetDataSource
} from './types';
import {
  FormulaEvaluator,
  colNameToIndex,
  indexToColName,
  DependencyGraph
} from './formula';
import { DataSourceBinder } from './datasource';

export interface SpreadsheetControllerOptions {
  document?: Partial<SpreadsheetDocument>;
  dataSources?: SpreadsheetDataSource[];
  primaryDataSourceId?: string;
  onDocumentChange?: (doc: SpreadsheetDocument) => void;
  onSelectionChange?: (activeCell: CellCoordinate | null, range: CellRange | null) => void;
  onCellCommit?: (rowId: string, colId: string, raw: string, value: any) => void;
}

export class SpreadsheetController {
  public document: SpreadsheetDocument;
  public activeCell: CellCoordinate | null = null;
  public selectedRange: CellRange | null = null;
  public editingCell: CellCoordinate | null = null;
  public draftValue = '';

  public readonly binder = new DataSourceBinder();
  public readonly depGraph = new DependencyGraph();
  public readonly evaluator: FormulaEvaluator;

  private primaryDataSourceId?: string;
  private onDocumentChange?: (doc: SpreadsheetDocument) => void;
  private onSelectionChange?: (activeCell: CellCoordinate | null, range: CellRange | null) => void;
  private onCellCommit?: (rowId: string, colId: string, raw: string, value: any) => void;

  // History stack for undo/redo
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private isApplyingHistory = false;

  constructor(options: SpreadsheetControllerOptions = {}) {
    const defaultCols: SpreadsheetColumn[] = [
      { id: 'col_a', key: 'A', title: 'A', width: 120, type: 'freeform' },
      { id: 'col_b', key: 'B', title: 'B', width: 120, type: 'freeform' },
      { id: 'col_c', key: 'C', title: 'C', width: 120, type: 'freeform' },
      { id: 'col_d', key: 'D', title: 'D', width: 120, type: 'freeform' }
    ];

    const defaultRows: SpreadsheetRow[] = options.primaryDataSourceId ? [] : Array.from({ length: 10 }, (_, i) => ({
      id: `row_${i + 1}`,
      index: i,
      height: 32,
      type: 'freeform'
    }));

    this.document = {
      id: options.document?.id || `sheet_${Date.now()}`,
      name: options.document?.name || 'Sheet 1',
      columns: options.document?.columns || defaultCols,
      rows: options.document?.rows || defaultRows,
      cells: options.document?.cells || {},
      createdAt: options.document?.createdAt || Date.now(),
      updatedAt: options.document?.updatedAt || Date.now()
    };

    this.primaryDataSourceId = options.primaryDataSourceId;
    this.onDocumentChange = options.onDocumentChange;
    this.onSelectionChange = options.onSelectionChange;
    this.onCellCommit = options.onCellCommit;

    if (options.dataSources) {
      options.dataSources.forEach((ds) => this.binder.register(ds));
    }

    this.evaluator = new FormulaEvaluator({
      resolveCell: (colStr, rowNum) => this.resolveCellByCoord(colStr, rowNum),
      resolveRange: (sCol, sRow, eCol, eRow) => this.resolveRangeByCoords(sCol, sRow, eCol, eRow),
      resolveProperty: (prop) => this.resolveCurrentRowProperty(prop)
    });

    this.syncWithDataSource();
    this.recalculateAll();
  }

  public loadDocument(document: SpreadsheetDocument): void {
    this.document = JSON.parse(JSON.stringify(document));
    this.activeCell = null;
    this.selectedRange = null;
    this.editingCell = null;
    this.draftValue = '';
    this.undoStack = [];
    this.redoStack = [];
    this.syncWithDataSource();
    this.recalculateAll();
    this.notifyChange();
  }

  public registerDataSource(ds: SpreadsheetDataSource): void {
    this.binder.register(ds);
    this.syncWithDataSource();
    this.recalculateAll();
  }

  public setPrimaryDataSource(dataSourceId: string | undefined): void {
    this.primaryDataSourceId = dataSourceId;
    this.syncWithDataSource();
    this.recalculateAll();
  }

  public syncWithDataSource(): void {
    if (!this.primaryDataSourceId) return;
    this.document.rows = this.binder.syncRows(this.document.rows, this.primaryDataSourceId);
    this.recomputeRowIndices();
  }

  private recomputeRowIndices(): void {
    this.document.rows.forEach((r, idx) => {
      r.index = idx;
    });
    this.document.columns.forEach((c, idx) => {
      c.key = indexToColName(idx);
    });
  }

  public getColumn(colIdOrKey: string): SpreadsheetColumn | undefined {
    return this.document.columns.find(
      (c) => c.id === colIdOrKey || c.key.toUpperCase() === colIdOrKey.toUpperCase()
    );
  }

  public getRow(rowIdOrIndex: string | number): SpreadsheetRow | undefined {
    if (typeof rowIdOrIndex === 'number') {
      return this.document.rows[rowIdOrIndex];
    }
    return this.document.rows.find((r) => r.id === rowIdOrIndex);
  }

  public getCell(rowId: string, colId: string): CellData {
    const existing = this.document.cells[rowId]?.[colId];
    if (existing) return existing;

    // Check if column is bound to record
    const col = this.document.columns.find((c) => c.id === colId);
    const row = this.document.rows.find((r) => r.id === rowId);

    if (col && row && col.type === 'bound' && col.binding && row.recordId) {
      const boundVal = this.binder.resolveBoundValue(
        col.binding.dataSource,
        row.recordId,
        col.binding.field
      );
      return {
        raw: boundVal !== undefined ? String(boundVal) : '',
        value: boundVal ?? '',
        format: col.format
      };
    }

    // Check if column has a column-level formula
    if (col && col.type === 'formula' && col.formula) {
      return {
        raw: col.formula,
        value: '',
        format: col.format
      };
    }

    return { raw: '', value: '', format: col?.format };
  }

  public setCellValue(rowId: string, colId: string, raw: string): void {
    this.recordSnapshot();

    if (!this.document.cells[rowId]) {
      this.document.cells[rowId] = {};
    }

    const col = this.document.columns.find((c) => c.id === colId);
    const row = this.document.rows.find((r) => r.id === rowId);

    // If this is a bound column and row is bound to record, dispatch back to data source
    if (col?.type === 'bound' && col.binding && row?.recordId) {
      this.binder.commitBoundValue(
        col.binding.dataSource,
        row.recordId,
        col.binding.field,
        raw
      );
    }

    const cellKey = this.getCellKey(rowId, colId);
    this.depGraph.setCellFormula(cellKey, raw.startsWith('=') ? raw : null);

    this.document.cells[rowId][colId] = {
      raw,
      value: raw,
      format: col?.format
    };

    this.document.updatedAt = Date.now();
    this.recalculateCell(rowId, colId);
    this.notifyChange();

    const evaluatedVal = this.document.cells[rowId][colId]?.value;
    this.onCellCommit?.(rowId, colId, raw, evaluatedVal);
  }

  private getCellKey(rowId: string, colId: string): string {
    const row = this.document.rows.find((r) => r.id === rowId);
    const col = this.document.columns.find((c) => c.id === colId);
    if (!row || !col) return `${colId}_${rowId}`;
    return `${col.key}${row.index + 1}`.toUpperCase();
  }

  public recalculateCell(rowId: string, colId: string): void {
    const cellKey = this.getCellKey(rowId, colId);
    const { order, hasCycle } = this.depGraph.getEvaluationOrder(cellKey);

    if (hasCycle) {
      if (this.document.cells[rowId]?.[colId]) {
        this.document.cells[rowId][colId].error = '#CYCLE!';
        this.document.cells[rowId][colId].value = '#CYCLE!';
      }
      return;
    }

    for (const key of order) {
      this.evalSingleCellByKey(key);
    }
  }

  public recalculateAll(): void {
    for (const row of this.document.rows) {
      for (const col of this.document.columns) {
        const cell = this.getCell(row.id, col.id);
        const cellKey = `${col.key}${row.index + 1}`.toUpperCase();
        if (cell.raw.startsWith('=')) {
          this.depGraph.setCellFormula(cellKey, cell.raw);
        }
      }
    }

    for (const row of this.document.rows) {
      for (const col of this.document.columns) {
        const cellKey = `${col.key}${row.index + 1}`.toUpperCase();
        this.evalSingleCellByKey(cellKey);
      }
    }
  }

  private evalSingleCellByKey(cellKey: string): void {
    const match = cellKey.match(/^([A-Za-z]+)(\d+)$/);
    if (!match) return;
    const colName = match[1].toUpperCase();
    const rowNum = parseInt(match[2], 10);

    const col = this.document.columns.find((c) => c.key.toUpperCase() === colName);
    const row = this.document.rows[rowNum - 1];
    if (!col || !row) return;

    const cell = this.getCell(row.id, col.id);
    if (!cell.raw.startsWith('=')) {
      if (cell.error === '#CYCLE!') {
        cell.error = undefined;
      }
      return;
    }

    try {
      const computed = this.evaluator.evaluate(cell.raw);
      if (!this.document.cells[row.id]) {
        this.document.cells[row.id] = {};
      }
      this.document.cells[row.id][col.id] = {
        ...cell,
        value: computed,
        error: undefined
      };
    } catch (err: any) {
      if (!this.document.cells[row.id]) {
        this.document.cells[row.id] = {};
      }
      this.document.cells[row.id][col.id] = {
        ...cell,
        value: '#ERROR!',
        error: err?.message || 'Formula error'
      };
    }
  }

  private resolveCellByCoord(colStr: string, rowNum: number): any {
    const col = this.document.columns.find((c) => c.key.toUpperCase() === colStr.toUpperCase());
    const row = this.document.rows[rowNum - 1];
    if (!col || !row) return 0;

    const cell = this.getCell(row.id, col.id);
    return cell.value !== undefined && cell.value !== '' ? cell.value : 0;
  }

  private resolveRangeByCoords(sCol: string, sRow: number, eCol: string, eRow: number): any[] {
    const startC = colNameToIndex(sCol);
    const endC = colNameToIndex(eCol);
    const minC = Math.min(startC, endC);
    const maxC = Math.max(startC, endC);
    const minR = Math.min(sRow, eRow);
    const maxR = Math.max(sRow, eRow);

    const results: any[] = [];
    for (let c = minC; c <= maxC; c++) {
      const colName = indexToColName(c);
      const col = this.document.columns.find((colDef) => colDef.key.toUpperCase() === colName);
      if (!col) continue;

      for (let r = minR; r <= maxR; r++) {
        const row = this.document.rows[r - 1];
        if (!row) continue;
        const cell = this.getCell(row.id, col.id);
        results.push(cell.value !== undefined && cell.value !== '' ? cell.value : 0);
      }
    }
    return results;
  }

  private resolveCurrentRowProperty(prop: string): any {
    if (!this.activeCell) return 0;
    const row = this.document.rows[this.activeCell.row];
    if (!row || !row.recordId || !this.primaryDataSourceId) return 0;
    return this.binder.resolveBoundValue(this.primaryDataSourceId, row.recordId, prop) ?? 0;
  }

  // --- Selection and Navigation ---

  public selectCell(row: number, col: number, extendSelection = false): void {
    const clampedRow = Math.max(0, Math.min(row, this.document.rows.length - 1));
    const clampedCol = Math.max(0, Math.min(col, this.document.columns.length - 1));

    const rowObj = this.document.rows[clampedRow];
    const colObj = this.document.columns[clampedCol];

    this.activeCell = {
      row: clampedRow,
      col: clampedCol,
      rowId: rowObj?.id,
      colId: colObj?.id
    };

    if (extendSelection && this.selectedRange) {
      this.selectedRange = {
        startRow: this.selectedRange.startRow,
        startCol: this.selectedRange.startCol,
        endRow: clampedRow,
        endCol: clampedCol
      };
    } else {
      this.selectedRange = {
        startRow: clampedRow,
        startCol: clampedCol,
        endRow: clampedRow,
        endCol: clampedCol
      };
    }

    this.onSelectionChange?.(this.activeCell, this.selectedRange);
  }

  public selectRange(range: CellRange): void {
    this.selectedRange = range;
    this.onSelectionChange?.(this.activeCell, this.selectedRange);
  }

  public startEditing(row?: number, col?: number, initialValue?: string): void {
    const targetRow = row ?? this.activeCell?.row ?? 0;
    const targetCol = col ?? this.activeCell?.col ?? 0;
    this.selectCell(targetRow, targetCol);

    const rowObj = this.document.rows[targetRow];
    const colObj = this.document.columns[targetCol];
    if (!rowObj || !colObj) return;

    this.editingCell = {
      row: targetRow,
      col: targetCol,
      rowId: rowObj.id,
      colId: colObj.id
    };

    const cell = this.getCell(rowObj.id, colObj.id);
    this.draftValue = initialValue !== undefined ? initialValue : cell.raw;
  }

  public commitEditing(valueToCommit?: string): void {
    if (!this.editingCell) return;
    const val = valueToCommit !== undefined ? valueToCommit : this.draftValue;
    if (this.editingCell.rowId && this.editingCell.colId) {
      this.setCellValue(this.editingCell.rowId, this.editingCell.colId, val);
    }
    this.editingCell = null;
    this.draftValue = '';
  }

  public cancelEditing(): void {
    this.editingCell = null;
    this.draftValue = '';
  }

  public moveCursor(
    direction: 'up' | 'down' | 'left' | 'right',
    extendSelection = false
  ): void {
    if (!this.activeCell) {
      this.selectCell(0, 0);
      return;
    }

    let nextRow = this.activeCell.row;
    let nextCol = this.activeCell.col;

    switch (direction) {
      case 'up':
        nextRow = Math.max(0, nextRow - 1);
        break;
      case 'down':
        nextRow = Math.min(this.document.rows.length - 1, nextRow + 1);
        break;
      case 'left':
        nextCol = Math.max(0, nextCol - 1);
        break;
      case 'right':
        nextCol = Math.min(this.document.columns.length - 1, nextCol + 1);
        break;
    }

    this.selectCell(nextRow, nextCol, extendSelection);
  }

  // --- Grid Structure Mutations ---

  public insertColumn(index: number, config?: Partial<SpreadsheetColumn>): void {
    this.recordSnapshot();
    const newId = config?.id || `col_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newCol: SpreadsheetColumn = {
      id: newId,
      key: indexToColName(index),
      title: config?.title || indexToColName(index),
      width: config?.width || 130,
      type: config?.type || 'freeform',
      binding: config?.binding,
      formula: config?.formula,
      format: config?.format || 'text',
      readOnly: config?.readOnly
    };

    this.document.columns.splice(index, 0, newCol);
    this.recomputeRowIndices();
    this.recalculateAll();
    this.notifyChange();
  }

  public deleteColumn(colId: string): void {
    this.recordSnapshot();
    this.document.columns = this.document.columns.filter((c) => c.id !== colId);
    for (const rowId of Object.keys(this.document.cells)) {
      delete this.document.cells[rowId][colId];
    }
    this.recomputeRowIndices();
    this.recalculateAll();
    this.notifyChange();
  }

  public insertRow(index: number, config?: Partial<SpreadsheetRow>): void {
    this.recordSnapshot();
    const newId = config?.id || `row_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newRow: SpreadsheetRow = {
      id: newId,
      index,
      height: config?.height || 32,
      recordId: config?.recordId,
      type: config?.type || 'freeform'
    };

    this.document.rows.splice(index, 0, newRow);
    this.recomputeRowIndices();
    this.recalculateAll();
    this.notifyChange();
  }

  public deleteRow(rowId: string): void {
    this.recordSnapshot();
    this.document.rows = this.document.rows.filter((r) => r.id !== rowId);
    delete this.document.cells[rowId];
    this.recomputeRowIndices();
    this.recalculateAll();
    this.notifyChange();
  }

  public setColumnWidth(colId: string, width: number): void {
    const col = this.document.columns.find((c) => c.id === colId);
    if (col) {
      col.width = Math.max(30, width);
      this.notifyChange();
    }
  }

  // --- Clipboard TSV/CSV ---

  public exportToTsv(): string {
    return this.document.rows
      .map((row) =>
        this.document.columns
          .map((col) => {
            const cell = this.getCell(row.id, col.id);
            return String(cell.value ?? '').replace(/\t/g, ' ');
          })
          .join('\t')
      )
      .join('\n');
  }

  public importFromTsv(tsvData: string, startRow = 0, startCol = 0): void {
    this.recordSnapshot();
    const lines = tsvData.trim().split('\n');

    lines.forEach((line, rIdx) => {
      const cells = line.split('\t');
      const targetR = startRow + rIdx;

      while (targetR >= this.document.rows.length) {
        this.insertRow(this.document.rows.length);
      }
      const row = this.document.rows[targetR];

      cells.forEach((val, cIdx) => {
        const targetC = startCol + cIdx;
        while (targetC >= this.document.columns.length) {
          this.insertColumn(this.document.columns.length);
        }
        const col = this.document.columns[targetC];
        this.setCellValue(row.id, col.id, val);
      });
    });

    this.recalculateAll();
    this.notifyChange();
  }

  // --- Undo/Redo Snapshots ---

  private recordSnapshot(): void {
    if (this.isApplyingHistory) return;
    this.undoStack.push(JSON.stringify(this.document));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  public undo(): void {
    if (this.undoStack.length === 0) return;
    this.isApplyingHistory = true;
    this.redoStack.push(JSON.stringify(this.document));
    const previous = JSON.parse(this.undoStack.pop()!);
    this.document = previous;
    this.recalculateAll();
    this.notifyChange();
    this.isApplyingHistory = false;
  }

  public redo(): void {
    if (this.redoStack.length === 0) return;
    this.isApplyingHistory = true;
    this.undoStack.push(JSON.stringify(this.document));
    const next = JSON.parse(this.redoStack.pop()!);
    this.document = next;
    this.recalculateAll();
    this.notifyChange();
    this.isApplyingHistory = false;
  }

  private notifyChange(): void {
    this.onDocumentChange?.(this.document);
  }
}
