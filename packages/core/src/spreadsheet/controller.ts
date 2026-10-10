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
  DependencyGraph,
  shiftFormulaReferences,
  WHOLE_COLUMN_END_ROW,
  type StructuralChange
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
  // Set while importing TSV: history and recalculation are done once at the end.
  private batching = false;
  private pendingCommits: Array<[string, string, string]> = [];
  // Row being evaluated, so [property] references resolve per row.
  private evaluatingRowIndex: number | null = null;

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

    const col = this.document.columns.find((c) => c.id === colId);
    const row = this.document.rows.find((r) => r.id === rowId);
    return this.getDerivedCell(row, col);
  }

  /** Value of a cell with no stored data: bound record value, column formula, or blank. */
  private getDerivedCell(row: SpreadsheetRow | undefined, col: SpreadsheetColumn | undefined): CellData {
    // Check if column is bound to record
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
    if (this.batching) {
      this.pendingCommits.push([rowId, colId, raw]);
      return;
    }
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

  /**
   * Recalculates a cell and everything that depends on it, in dependency
   * order. Every cell in a reference cycle is marked `#CYCLE!`.
   */
  public recalculateCell(rowId: string, colId: string): void {
    const cellKey = this.getCellKey(rowId, colId);
    this.runEvaluationPlan(this.depGraph.getEvaluationPlan([cellKey], { includeDependents: true }));
  }

  /**
   * Rebuilds the dependency graph from scratch and recalculates every formula
   * in dependency order.
   */
  public recalculateAll(): void {
    this.depGraph.clear();
    const formulaKeys: string[] = [];
    for (const row of this.document.rows) {
      for (const col of this.document.columns) {
        // Avoid getCell's id lookups: this loop visits every cell.
        const cell = this.document.cells[row.id]?.[col.id] ?? this.getDerivedCell(row, col);
        if (cell.raw.startsWith('=')) {
          const cellKey = `${col.key}${row.index + 1}`.toUpperCase();
          this.depGraph.setCellFormula(cellKey, cell.raw);
          formulaKeys.push(cellKey);
        }
      }
    }
    this.runEvaluationPlan(this.depGraph.getEvaluationPlan(formulaKeys));
  }

  private runEvaluationPlan(plan: { order: string[]; cyclic: Set<string> }): void {
    for (const key of plan.order) {
      if (plan.cyclic.has(key)) {
        this.markCycle(key);
      } else {
        this.evalSingleCellByKey(key);
      }
    }
  }

  private locateCellKey(cellKey: string): { row: SpreadsheetRow; col: SpreadsheetColumn } | null {
    const match = cellKey.match(/^([A-Za-z]+)(\d+)$/);
    if (!match) return null;
    const col = this.document.columns.find((c) => c.key.toUpperCase() === match[1].toUpperCase());
    const row = this.document.rows[parseInt(match[2], 10) - 1];
    return col && row ? { row, col } : null;
  }

  private markCycle(cellKey: string): void {
    const located = this.locateCellKey(cellKey);
    if (!located) return;
    const { row, col } = located;
    const cell = this.getCell(row.id, col.id);
    if (!cell.raw.startsWith('=')) return;
    if (!this.document.cells[row.id]) this.document.cells[row.id] = {};
    this.document.cells[row.id][col.id] = { ...cell, value: '#CYCLE!', error: '#CYCLE!' };
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
      this.evaluatingRowIndex = rowNum - 1;
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
    } finally {
      this.evaluatingRowIndex = null;
    }
  }

  private resolveCellByCoord(colStr: string, rowNum: number): any {
    const col = this.document.columns.find((c) => c.key.toUpperCase() === colStr.toUpperCase());
    const row = this.document.rows[rowNum - 1];
    if (!col || !row) return 0;

    // Blank cells resolve to '' (0 in arithmetic, "" in text), as in spreadsheets.
    return this.getCell(row.id, col.id).value ?? '';
  }

  private resolveRangeByCoords(sCol: string, sRow: number, eCol: string, eRow: number): any[] {
    const startC = colNameToIndex(sCol);
    const endC = colNameToIndex(eCol);
    const minC = Math.min(startC, endC);
    const maxC = Math.max(startC, endC);
    const minR = Math.min(sRow, eRow);
    // Whole-column ranges (A:A) stop at the last row.
    const maxR = Math.min(Math.max(sRow, eRow), WHOLE_COLUMN_END_ROW, this.document.rows.length);

    const results: any[] = [];
    for (let c = minC; c <= maxC; c++) {
      const colName = indexToColName(c);
      const col = this.document.columns.find((colDef) => colDef.key.toUpperCase() === colName);
      if (!col) continue;

      for (let r = minR; r <= maxR; r++) {
        const row = this.document.rows[r - 1];
        if (!row) continue;
        results.push(this.getCell(row.id, col.id).value ?? '');
      }
    }
    return results;
  }

  private resolveCurrentRowProperty(prop: string): any {
    // Resolve against the row being evaluated, not the selected cell's row.
    const rowIndex = this.evaluatingRowIndex ?? this.activeCell?.row;
    if (rowIndex === undefined || rowIndex === null) return 0;
    const row = this.document.rows[rowIndex];
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
    const newId = config?.id || this.generateId('col');
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

    this.shiftReferences({ axis: 'col', index, type: 'insert' });
    this.document.columns.splice(index, 0, newCol);
    this.recomputeRowIndices();
    this.recalculateAll();
    this.notifyChange();
  }

  public deleteColumn(colId: string): void {
    this.recordSnapshot();
    const colIndex = this.document.columns.findIndex((c) => c.id === colId);
    if (colIndex === -1) return;
    this.shiftReferences({ axis: 'col', index: colIndex, type: 'delete' });
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
    const newId = config?.id || this.generateId('row');
    const newRow: SpreadsheetRow = {
      id: newId,
      index,
      height: config?.height || 32,
      recordId: config?.recordId,
      type: config?.type || 'freeform'
    };

    this.shiftReferences({ axis: 'row', index, type: 'insert' });
    this.document.rows.splice(index, 0, newRow);
    this.recomputeRowIndices();
    this.recalculateAll();
    this.notifyChange();
  }

  public deleteRow(rowId: string): void {
    this.recordSnapshot();
    const rowIndex = this.document.rows.findIndex((r) => r.id === rowId);
    if (rowIndex === -1) return;
    this.shiftReferences({ axis: 'row', index: rowIndex, type: 'delete' });
    this.document.rows = this.document.rows.filter((r) => r.id !== rowId);
    delete this.document.cells[rowId];
    this.recomputeRowIndices();
    this.recalculateAll();
    this.notifyChange();
  }

  private generateId(prefix: 'row' | 'col'): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * Rewrites references in every cell formula (and, for column changes, every
   * column formula) so they keep pointing at the same cells.
   */
  private shiftReferences(change: StructuralChange): void {
    for (const rowCells of Object.values(this.document.cells)) {
      for (const cell of Object.values(rowCells)) {
        if (cell.raw?.startsWith('=')) {
          cell.raw = shiftFormulaReferences(cell.raw, change);
        }
      }
    }
    if (change.axis === 'col') {
      for (const col of this.document.columns) {
        if (col.formula?.startsWith('=')) {
          col.formula = shiftFormulaReferences(col.formula, change);
        }
      }
    }
  }

  public setColumnWidth(colId: string, width: number): void {
    const col = this.document.columns.find((c) => c.id === colId);
    if (col) {
      col.width = Math.max(30, width);
      this.notifyChange();
    }
  }

  public autoFitColumnWidth(colId: string, customWidth?: number): void {
    if (customWidth !== undefined) {
      this.setColumnWidth(colId, customWidth);
      return;
    }
    const col = this.document.columns.find((c) => c.id === colId);
    if (!col) return;

    let maxLen = (col.title || '').length + (col.key ? col.key.length + 3 : 0);
    for (const row of this.document.rows) {
      const cell = this.getCell(row.id, col.id);
      const valStr = cell.value != null ? String(cell.value) : '';
      if (valStr.length > maxLen) {
        maxLen = valStr.length;
      }
    }
    const estimatedWidth = Math.min(600, Math.max(50, Math.ceil(maxLen * 8.5 + 32)));
    this.setColumnWidth(colId, estimatedWidth);
  }

  // --- Clipboard TSV/CSV ---

  /**
   * Exports cell values as TSV: the whole sheet, or only `range` (e.g. the
   * current selection) when given.
   */
  public exportToTsv(range?: CellRange | null): string {
    const rows = range
      ? this.document.rows.slice(
          Math.min(range.startRow, range.endRow),
          Math.max(range.startRow, range.endRow) + 1,
        )
      : this.document.rows;
    const columns = range
      ? this.document.columns.slice(
          Math.min(range.startCol, range.endCol),
          Math.max(range.startCol, range.endCol) + 1,
        )
      : this.document.columns;
    return rows
      .map((row) =>
        columns
          .map((col) => {
            const cell = this.getCell(row.id, col.id);
            return String(cell.value ?? '').replace(/\t/g, ' ');
          })
          .join('\t')
      )
      .join('\n');
  }

  /**
   * Pastes tab-separated values starting at (startRow, startCol), adding rows
   * and columns as needed. The whole paste is a single undo step.
   */
  public importFromTsv(tsvData: string, startRow = 0, startCol = 0): void {
    // Only drop the final line break: leading tabs are empty cells.
    const normalized = tsvData.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    if (normalized === '') return;

    this.recordSnapshot();
    this.batching = true;
    this.pendingCommits = [];
    try {
      normalized.split('\n').forEach((line, rIdx) => {
        const targetR = startRow + rIdx;
        // Growing the grid is not an insertion: no references shift.
        while (targetR >= this.document.rows.length) {
          const index = this.document.rows.length;
          this.document.rows.push({ id: this.generateId('row'), index, height: 32, type: 'freeform' });
        }
        const row = this.document.rows[targetR];

        line.split('\t').forEach((val, cIdx) => {
          const targetC = startCol + cIdx;
          while (targetC >= this.document.columns.length) {
            const key = indexToColName(this.document.columns.length);
            this.document.columns.push({
              id: this.generateId('col'),
              key,
              title: key,
              width: 130,
              type: 'freeform',
              format: 'text'
            });
          }
          this.setCellValue(row.id, this.document.columns[targetC].id, val);
        });
      });
    } finally {
      this.batching = false;
    }

    this.recalculateAll();
    this.notifyChange();
    const commits = this.pendingCommits;
    this.pendingCommits = [];
    for (const [rowId, colId, raw] of commits) {
      this.onCellCommit?.(rowId, colId, raw, this.document.cells[rowId]?.[colId]?.value);
    }
  }

  // --- Undo/Redo Snapshots ---

  private recordSnapshot(): void {
    if (this.isApplyingHistory || this.batching) return;
    this.undoStack.push(JSON.stringify(this.document));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  public undo(): void {
    if (this.undoStack.length === 0) return;
    this.isApplyingHistory = true;
    try {
      this.redoStack.push(JSON.stringify(this.document));
      this.document = JSON.parse(this.undoStack.pop()!);
      this.recalculateAll();
      this.notifyChange();
    } finally {
      this.isApplyingHistory = false;
    }
  }

  public redo(): void {
    if (this.redoStack.length === 0) return;
    this.isApplyingHistory = true;
    try {
      this.undoStack.push(JSON.stringify(this.document));
      this.document = JSON.parse(this.redoStack.pop()!);
      this.recalculateAll();
      this.notifyChange();
    } finally {
      this.isApplyingHistory = false;
    }
  }

  private notifyChange(): void {
    this.onDocumentChange?.(this.document);
  }
}
