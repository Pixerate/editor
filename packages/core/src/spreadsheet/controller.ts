import {
  SpreadsheetDocument,
  SpreadsheetColumn,
  SpreadsheetRow,
  CellCoordinate,
  CellRange,
  CellData,
  SpreadsheetDataSource,
  SpreadsheetTableSettings,
  SortKey,
  FilterRule,
  SpreadsheetFilterState,
  GroupAggregate,
  GroupSummary,
  SpreadsheetSpill
} from './types';
import {
  FormulaEvaluator,
  colNameToIndex,
  indexToColName,
  DependencyGraph,
  shiftFormulaReferences,
  remapFormulaReferences,
  offsetFormulaReferences,
  WHOLE_COLUMN_END_ROW,
  describeFormulaError,
  isFormulaError,
  type FormulaRange,
  type StructuralChange,
  type CellPosition
} from './formula';
import { parseCellInput } from './formula/parse-input';
import { formatCellDisplay } from './formula/format';
import { DataSourceBinder } from './datasource';
import {
  compareCellValues,
  fillSeries,
  getFillDirection,
  isSingleCellRange,
  normalizeRange,
  rangeContains,
  rangeContainsRange,
  rangesIntersect
} from './table';
import { parseCsv, serializeCsv } from './csv';
import {
  createSpreadsheetClipboardData,
  readSpreadsheetClipboard,
  rebaseClipboardRows,
  type SpreadsheetClipboardData,
  type SpreadsheetClipboardSource
} from './clipboard';
import {
  buildSpreadsheetView,
  computeRowGroups,
  getTableSections,
  type SpreadsheetRowGroup,
  type SpreadsheetViewModel
} from './view';

export interface CsvExportOptions {
  range?: CellRange | null;
  delimiter?: string;
  lineEnding?: string;
  bom?: boolean;
  /** Export formulas as typed (`=SUM(A1:A3)`) instead of their values. */
  formulas?: boolean;
}

export interface CsvImportOptions {
  startRow?: number;
  startCol?: number;
  delimiter?: string;
}

export type NewFilterRule = Omit<FilterRule, 'id'> & { id?: string };

export interface SpreadsheetControllerOptions {
  document?: Partial<SpreadsheetDocument>;
  dataSources?: SpreadsheetDataSource[];
  primaryDataSourceId?: string;
  onDocumentChange?: (doc: SpreadsheetDocument) => void;
  onSelectionChange?: (activeCell: CellCoordinate | null, range: CellRange | null) => void;
  onCellCommit?: (rowId: string, colId: string, raw: string, value: any) => void;
  /**
   * Approximate memory budget for undo/redo snapshots, in bytes (UTF-16 size of
   * the serialized documents). The oldest undo steps beyond it are dropped, but
   * the most recent one is always kept. Defaults to 64 MiB; 0 = unlimited.
   */
  maxHistoryBytes?: number;
}

/** Module-wide sequence that makes generated row, column and filter ids unique. */
let nextIdSequence = 0;

/** A placed dynamic array: derived state, rebuilt by every recalculation. */
interface SpillRecord {
  anchor: string;
  row: number;
  col: number;
  rows: number;
  cols: number;
  /** Column-major values, anchor (top-left) first. */
  values: any[];
  /** The spilled cells (anchor excluded). */
  cells: Array<{ key: string; rowId: string; colId: string }>;
}

// Default undo/redo snapshot budget (see SpreadsheetControllerOptions.maxHistoryBytes).
const DEFAULT_MAX_HISTORY_BYTES = 64 * 1024 * 1024;

// Recalculation passes after spill ranges change (see recalculateKeys).
const MAX_SPILL_PASSES = 25;

const spillCellId = (rowId: string, colId: string) => `${rowId}\u0000${colId}`;

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
  private readonly maxHistoryBytes: number;
  // Set while importing TSV: history and recalculation are done once at the end.
  private batching = false;
  private pendingCommits: Array<[string, string, string]> = [];
  // Row being evaluated, so [property] references resolve per row.
  private evaluatingRowIndex: number | null = null;
  // Cell being evaluated, for implicit intersection (`=@A:A`).
  private evaluatingCell: { col: string; row: number } | null = null;

  // Dynamic arrays. Spilled values are derived state: they live here, not in
  // the document, and every recalculation rebuilds them.
  private spills = new Map<string, SpillRecord>(); // anchor key -> spill
  private spilledBy = new Map<string, string>(); // spilled cell key -> anchor key
  private spillCells = new Map<string, CellData>(); // spillCellId -> displayed cell
  // Cells whose spill ownership changed during the current pass.
  private spillChanges: Set<string> | null = null;

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
      updatedAt: options.document?.updatedAt || Date.now(),
      ...(options.document?.table ? { table: options.document.table } : {})
    };

    this.primaryDataSourceId = options.primaryDataSourceId;
    this.maxHistoryBytes = Math.max(0, options.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES);
    this.onDocumentChange = options.onDocumentChange;
    this.onSelectionChange = options.onSelectionChange;
    this.onCellCommit = options.onCellCommit;

    if (options.dataSources) {
      options.dataSources.forEach((ds) => this.binder.register(ds));
    }

    this.evaluator = new FormulaEvaluator({
      resolveCell: (colStr, rowNum) => this.resolveCellByCoord(colStr, rowNum),
      resolveRange: (sCol, sRow, eCol, eRow) => this.resolveRangeByCoords(sCol, sRow, eCol, eRow),
      resolveProperty: (prop) => this.resolveCurrentRowProperty(prop),
      resolveSpill: (colStr, rowNum) => this.resolveSpillByCoord(colStr, rowNum),
      getFormulaCell: () => this.evaluatingCell
    });

    this.syncWithDataSource();
    this.rederiveTypedValues();
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
    this.rederiveTypedValues();
    this.recalculateAll();
    this.notifyChange();
  }

  /**
   * Re-parses the value of every stored typed (non-formula) cell from its
   * `raw` input, so documents saved before typed input was parsed (whose
   * values are text such as `"120"`) compare and sort as numbers. Cells of
   * bound columns in record rows keep their value: it belongs to the data
   * source.
   */
  private rederiveTypedValues(): void {
    for (const row of this.document.rows) {
      const cells = this.document.cells[row.id];
      if (!cells) continue;
      for (const col of this.document.columns) {
        const cell = cells[col.id];
        if (!cell || typeof cell.raw !== 'string' || cell.raw.startsWith('=')) continue;
        if (col.type === 'bound' && col.binding && row.recordId) continue;
        const typed = this.typedCell(cell.raw, cell.format);
        cell.value = typed.value;
        if (typed.numberFormat) cell.numberFormat = typed.numberFormat;
        else delete cell.numberFormat;
        if (typed.format) cell.format = typed.format;
      }
    }
  }

  /**
   * Value of typed (non-formula) input: a number, boolean, ISO date, error
   * or text (see `parseCellInput`), its automatic number format, and the
   * `CellFormat` to use: the automatic one (currency, percentage, date,
   * number) when `format` is unset or `text` (the default of new columns).
   */
  private typedCell(raw: string, format: CellData['format']): Pick<CellData, 'value' | 'numberFormat' | 'format'> {
    const parsed = parseCellInput(raw);
    return {
      value: parsed.value,
      ...(parsed.numberFormat ? { numberFormat: parsed.numberFormat } : {}),
      format: parsed.cellFormat && (!format || format === 'text') ? parsed.cellFormat : format
    };
  }

  /**
   * Typed input for a bound field, coerced by the field's declared type:
   * number, boolean and date fields get a number, boolean or ISO date when
   * the input parses as one; string and enum fields (and unknown fields)
   * keep the text exactly as typed.
   */
  private boundInputValue(dataSourceId: string, field: string, raw: string): unknown {
    if (raw.startsWith('=')) return raw;
    const type = this.binder.getDataSource(dataSourceId)?.getFields().find((f) => f.key === field)?.type;
    if (type !== 'number' && type !== 'boolean' && type !== 'date') return raw;
    const parsed = parseCellInput(raw);
    if (type === 'number' && parsed.type === 'number') return parsed.value;
    if (type === 'boolean' && parsed.type === 'boolean') return parsed.value;
    if (type === 'date' && parsed.type === 'date') return parsed.value;
    return raw;
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
    if (existing && existing.raw !== '') return existing;
    if (this.spillCells.size > 0) {
      const spilled = this.spillCells.get(spillCellId(rowId, colId));
      if (spilled) return spilled;
    }
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

    const isFormula = raw.startsWith('=');
    let cell: CellData;
    // If this is a bound column and row is bound to record, dispatch back to data source
    if (col?.type === 'bound' && col.binding && row?.recordId) {
      const value = this.boundInputValue(col.binding.dataSource, col.binding.field, raw);
      this.binder.commitBoundValue(col.binding.dataSource, row.recordId, col.binding.field, value);
      cell = { raw, value, format: col.format };
    } else if (isFormula) {
      cell = { raw, value: raw, format: col?.format };
    } else {
      cell = { raw, ...this.typedCell(raw, col?.format) };
    }

    const cellKey = this.getCellKey(rowId, colId);
    this.depGraph.setCellFormula(cellKey, isFormula ? raw : null);

    this.document.cells[rowId][colId] = cell;

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
    // Typing into a spilled cell blocks its array: the anchor recalculates (#SPILL!).
    const anchor = this.spilledBy.get(cellKey);
    this.recalculateKeys(anchor ? [cellKey, anchor] : [cellKey], true);
  }

  /**
   * Recalculates `keys` (and, with `includeDependents`, their dependents) in
   * dependency order. Spill ranges are only known after evaluating their
   * anchors, so when a pass changes which cells hold spilled values (and so
   * the dependency graph), the dependents of those cells are recalculated in
   * another pass, until nothing changes.
   */
  private recalculateKeys(keys: Iterable<string>, includeDependents: boolean): void {
    let pending = Array.from(keys);
    let withDependents = includeDependents;
    for (let pass = 0; pass < MAX_SPILL_PASSES && pending.length > 0; pass++) {
      const changed = new Set<string>();
      this.spillChanges = changed;
      try {
        this.runEvaluationPlan(this.depGraph.getEvaluationPlan(pending, { includeDependents: withDependents }));
      } finally {
        this.spillChanges = null;
      }
      pending = Array.from(changed);
      withDependents = true;
    }
  }

  /**
   * Rebuilds the dependency graph from scratch and recalculates every formula
   * in dependency order.
   */
  public recalculateAll(): void {
    this.depGraph.clear();
    this.spills.clear();
    this.spilledBy.clear();
    this.spillCells.clear();
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
    this.recalculateKeys(formulaKeys, false);
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
    // A direct self reference (A1 = A1+1, or SUM(A:A) in column A) gets its own message.
    const deps = this.depGraph.getDependencies(cellKey);
    const selfReference = deps.includes(cellKey) || deps.includes(`${col.key.toUpperCase()}:`);
    const spilledKeys = this.depGraph.getSpilledKeys(cellKey);
    const ownSpill = deps.find((dep) => spilledKeys.includes(dep));
    const errorMessage = selfReference
      ? "This formula can't reference its own cell."
      : ownSpill
        ? `This formula refers to ${ownSpill}, which holds its own spilled results (a circular reference).`
        : 'This formula is part of a circular reference: it depends on its own result through other cells.';
    // Keep the spill edges, so the cycle stays detected on the next pass.
    this.clearSpill(cellKey.toUpperCase(), true);
    this.document.cells[row.id][col.id] = { ...cell, value: '#CYCLE!', error: '#CYCLE!', errorMessage };
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
        cell.errorMessage = undefined;
      }
      // No longer a formula: drop any array it spilled.
      this.clearSpill(`${colName}${rowNum}`);
      return;
    }

    try {
      this.evaluatingRowIndex = rowNum - 1;
      this.evaluatingCell = { col: colName, row: rowNum };
      const result = this.evaluator.evaluateWithDiagnostics(cell.raw);
      if (!this.document.cells[row.id]) {
        this.document.cells[row.id] = {};
      }
      let { value, error, message } = result;
      if (result.array) {
        const blocked = this.placeSpill(`${colName}${rowNum}`, rowNum - 1, this.document.columns.indexOf(col), result.array);
        if (blocked) {
          value = '#SPILL!';
          error = '#SPILL!';
          message = blocked;
        }
      } else {
        this.clearSpill(`${colName}${rowNum}`);
      }
      this.document.cells[row.id][col.id] = {
        ...cell,
        value,
        // `#ERROR!` (malformed formula, wrong argument count) keeps its
        // message in `error`, as before; other errors store their code.
        error: error === '#ERROR!' ? message : error,
        errorMessage: message
      };
    } finally {
      this.evaluatingRowIndex = null;
      this.evaluatingCell = null;
    }
  }

  // --- Dynamic arrays (spilling) ---

  /**
   * Spills `array` from the anchor at (row, col) into the cells below and to
   * the right. Returns why it can't (the anchor then shows `#SPILL!`), or
   * null once placed. The grid never grows to fit an array, as in Excel.
   */
  private placeSpill(anchor: string, row: number, col: number, array: FormulaRange): string | null {
    const { rows, cols } = array;
    const area: CellRange = { startRow: row, startCol: col, endRow: row + rows - 1, endCol: col + cols - 1 };
    const label = `${indexToColName(area.startCol)}${area.startRow + 1}:${indexToColName(area.endCol)}${area.endRow + 1}`;
    let reason: string | null = null;
    const blockers: string[] = [];

    if (area.endRow >= this.document.rows.length || area.endCol >= this.document.columns.length) {
      reason = `The ${rows}×${cols} result needs ${label}, which extends past the edge of the sheet.`;
    } else if (this.getMerges().some((m) => rangesIntersect(m, area))) {
      reason = `The result can't spill into merged cells (it needs ${label}).`;
    } else {
      for (let c = area.startCol; c <= area.endCol; c++) {
        const column = this.document.columns[c];
        for (let r = area.startRow; r <= area.endRow; r++) {
          if (r === row && c === col) continue;
          const rowObj = this.document.rows[r];
          const key = `${column.key}${r + 1}`.toUpperCase();
          const stored = this.document.cells[rowObj.id]?.[column.id];
          const raw = stored ? stored.raw : this.getDerivedCell(rowObj, column).raw;
          const owner = this.spilledBy.get(key);
          if (raw !== '') {
            blockers.push(key);
            reason ??= `The result needs ${label}, but ${key} isn't empty.`;
          } else if (owner && owner !== anchor) {
            blockers.push(key);
            reason ??= `The result needs ${label}, but ${key} already holds values spilled from ${owner}.`;
          }
        }
      }
    }

    if (reason) {
      this.clearSpill(anchor);
      // Clearing a blocking cell recalculates this anchor.
      this.depGraph.setSpillEdges(anchor, [], blockers);
      return reason;
    }

    const previous = this.spills.get(anchor);
    const cells: SpillRecord['cells'] = [];
    for (let c = 0; c < cols; c++) {
      const column = this.document.columns[col + c];
      for (let r = 0; r < rows; r++) {
        if (r === 0 && c === 0) continue;
        const rowObj = this.document.rows[row + r];
        const key = `${column.key}${row + r + 1}`.toUpperCase();
        const value = array.values[c * rows + r] ?? '';
        const display: CellData = { raw: '', value, format: column.format, spillAnchor: anchor };
        if (isFormulaError(value)) {
          display.error = value;
          display.errorMessage = describeFormulaError(value);
        }
        this.spillCells.set(spillCellId(rowObj.id, column.id), display);
        if (this.spilledBy.get(key) !== anchor) {
          this.spilledBy.set(key, anchor);
          this.spillChanges?.add(key);
        }
        cells.push({ key, rowId: rowObj.id, colId: column.id });
      }
    }
    if (previous) {
      const kept = new Set(cells.map((cell) => cell.key));
      for (const old of previous.cells) {
        if (kept.has(old.key)) continue;
        this.forgetSpilledCell(anchor, old);
      }
    }
    this.spills.set(anchor, { anchor, row, col, rows, cols, values: array.values, cells });
    this.depGraph.setSpillEdges(anchor, cells.map((cell) => cell.key));
    return null;
  }

  /** Removes the array spilled from `anchor`. With `keepEdges`, its dependency edges stay. */
  private clearSpill(anchor: string, keepEdges = false): void {
    const record = this.spills.get(anchor);
    if (record) {
      for (const cell of record.cells) this.forgetSpilledCell(anchor, cell);
      this.spills.delete(anchor);
    }
    if (!keepEdges) this.depGraph.setSpillEdges(anchor, []);
  }

  private forgetSpilledCell(anchor: string, cell: SpillRecord['cells'][number]): void {
    if (this.spilledBy.get(cell.key) !== anchor) return;
    this.spilledBy.delete(cell.key);
    this.spillCells.delete(spillCellId(cell.rowId, cell.colId));
    this.spillChanges?.add(cell.key);
  }

  private resolveSpillByCoord(colStr: string, rowNum: number): FormulaRange | string {
    const record = this.spills.get(`${colStr}${rowNum}`.toUpperCase());
    if (record) return { rows: record.rows, cols: record.cols, values: record.values };
    const value = this.resolveCellByCoord(colStr, rowNum);
    return isFormulaError(value) ? value : '#REF!';
  }

  private toSpill(record: SpillRecord): SpreadsheetSpill {
    const row = this.document.rows[record.row];
    const col = this.document.columns[record.col];
    return {
      key: record.anchor,
      anchor: { row: record.row, col: record.col },
      range: {
        startRow: record.row,
        startCol: record.col,
        endRow: record.row + record.rows - 1,
        endCol: record.col + record.cols - 1
      },
      formula: row && col ? this.getCell(row.id, col.id).raw : ''
    };
  }

  /**
   * The dynamic array covering (row, col), whether it is the anchor (the cell
   * holding the formula) or a spilled cell; null when there is none.
   */
  public getSpillAt(row: number, col: number): SpreadsheetSpill | null {
    if (this.spills.size === 0) return null;
    const key = `${indexToColName(col)}${row + 1}`;
    const record = this.spills.get(key) ?? this.spills.get(this.spilledBy.get(key) ?? '');
    return record ? this.toSpill(record) : null;
  }

  /** Every dynamic array currently spilled. */
  public getSpills(): SpreadsheetSpill[] {
    return Array.from(this.spills.values(), (record) => this.toSpill(record));
  }

  /** Whether `range` overlaps a spilled array (its anchor or spilled cells). */
  private intersectsSpill(range: CellRange): boolean {
    for (const record of this.spills.values()) {
      const area: CellRange = {
        startRow: record.row,
        startCol: record.col,
        endRow: record.row + record.rows - 1,
        endCol: record.col + record.cols - 1
      };
      if (rangesIntersect(area, range)) return true;
    }
    return false;
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

    // A merged cell is selected as a whole, through its top-left cell.
    const merge = extendSelection ? null : this.getMergeAt(clampedRow, clampedCol);
    const activeRow = merge ? merge.startRow : clampedRow;
    const activeCol = merge ? merge.startCol : clampedCol;
    const rowObj = this.document.rows[activeRow];
    const colObj = this.document.columns[activeCol];

    this.activeCell = {
      row: activeRow,
      col: activeCol,
      rowId: rowObj?.id,
      colId: colObj?.id
    };

    if (extendSelection && this.selectedRange) {
      this.selectedRange = this.expandRangeToMerges({
        startRow: this.selectedRange.startRow,
        startCol: this.selectedRange.startCol,
        endRow: clampedRow,
        endCol: clampedCol
      });
    } else if (merge) {
      this.selectedRange = { ...merge };
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
    this.selectCell(row ?? this.activeCell?.row ?? 0, col ?? this.activeCell?.col ?? 0);
    // selectCell moves into a merge's top-left cell, which holds its content.
    const targetRow = this.activeCell?.row ?? 0;
    const targetCol = this.activeCell?.col ?? 0;

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

    // Move in display order: skip hidden, filtered and collapsed rows, hidden
    // columns, and step over merged cells as a whole.
    const { rowOrder, columnOrder } = this.getViewModel();
    let nextRow = this.activeCell.row;
    let nextCol = this.activeCell.col;
    const merge = extendSelection ? null : this.getMergeAt(nextRow, nextCol);

    switch (direction) {
      case 'up':
        nextRow = stepInOrder(rowOrder, merge ? merge.startRow : nextRow, -1);
        break;
      case 'down':
        nextRow = stepInOrder(rowOrder, merge ? merge.endRow : nextRow, 1);
        break;
      case 'left':
        nextCol = stepInOrder(columnOrder, merge ? merge.startCol : nextCol, -1);
        break;
      case 'right':
        nextCol = stepInOrder(columnOrder, merge ? merge.endCol : nextCol, 1);
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
    this.adjustTableForStructuralChange({ axis: 'col', index, type: 'insert' });
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
    this.adjustTableForStructuralChange({ axis: 'col', index: colIndex, type: 'delete' });
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
    this.adjustTableForStructuralChange({ axis: 'row', index, type: 'insert' });
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
    this.adjustTableForStructuralChange({ axis: 'row', index: rowIndex, type: 'delete' });
    this.document.rows = this.document.rows.filter((r) => r.id !== rowId);
    delete this.document.cells[rowId];
    this.recomputeRowIndices();
    this.recalculateAll();
    this.notifyChange();
  }

  private generateId(prefix: 'row' | 'col'): string {
    // The counter keeps ids unique when many rows are created in the same
    // millisecond (e.g. growing the grid on import); duplicate row ids would
    // share cell storage.
    return `${prefix}_${Date.now()}_${(nextIdSequence++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
      const valStr = formatCellDisplay(cell);
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
            return formatCellDisplay(this.getCell(row.id, col.id)).replace(/\t/g, ' ');
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
    this.writeMatrix(normalized.split('\n').map((line) => line.split('\t')), startRow, startCol);
  }

  /** Adds rows/columns at the end until (rowIndex, colIndex) exists. */
  private growGrid(rowIndex: number, colIndex: number): void {
    // Growing the grid is not an insertion: no references shift.
    while (rowIndex >= this.document.rows.length) {
      const index = this.document.rows.length;
      this.document.rows.push({ id: this.generateId('row'), index, height: 32, type: 'freeform' });
    }
    while (colIndex >= this.document.columns.length) {
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
  }

  /**
   * Writes raw inputs starting at (startRow, startCol), growing the grid as
   * needed, as a single undo step with one recalculation.
   */
  private writeMatrix(matrix: string[][], startRow: number, startCol: number): void {
    if (matrix.length === 0) return;
    this.runBatch(() => {
      matrix.forEach((line, rIdx) => {
        line.forEach((val, cIdx) => {
          this.growGrid(startRow + rIdx, startCol + cIdx);
          const row = this.document.rows[startRow + rIdx];
          this.setCellValue(row.id, this.document.columns[startCol + cIdx].id, val);
        });
      });
    });
  }

  /**
   * Runs `fn` as one undo step: cell writes inside it are batched and
   * recalculated once, then listeners are notified.
   */
  private runBatch(fn: () => void): void {
    this.recordSnapshot();
    this.batching = true;
    this.pendingCommits = [];
    try {
      fn();
    } finally {
      this.batching = false;
    }

    this.recomputeRowIndices();
    this.recalculateAll();
    this.document.updatedAt = Date.now();
    this.notifyChange();
    const commits = this.pendingCommits;
    this.pendingCommits = [];
    for (const [rowId, colId, raw] of commits) {
      this.onCellCommit?.(rowId, colId, raw, this.document.cells[rowId]?.[colId]?.value);
    }
  }

  // --- CSV ---

  /**
   * Exports the sheet (or `range`) as RFC 4180 CSV. Values are exported as
   * displayed unless `formulas` is set.
   */
  public exportToCsv(options: CsvExportOptions = {}): string {
    const matrix = this.readMatrix(options.range ?? null).map((row) =>
      row.map((cell) => (options.formulas ? cell.raw : formatCellDisplay(cell)))
    );
    return serializeCsv(matrix, {
      delimiter: options.delimiter,
      lineEnding: options.lineEnding,
      bom: options.bom
    });
  }

  /**
   * Imports CSV text at (startRow, startCol) (default A1), growing the grid
   * as needed. The whole import is a single undo step.
   */
  public importFromCsv(csv: string, options: CsvImportOptions = {}): void {
    const matrix = parseCsv(csv, { delimiter: options.delimiter });
    this.writeMatrix(matrix, options.startRow ?? 0, options.startCol ?? 0);
  }

  /**
   * Writes already-parsed rows of raw inputs (e.g. from an import adapter)
   * starting at (startRow, startCol), as a single undo step.
   */
  public importRows(rows: string[][], options: Omit<CsvImportOptions, 'delimiter'> = {}): void {
    this.writeMatrix(rows, options.startRow ?? 0, options.startCol ?? 0);
  }

  /** The cells of `range` (or the whole sheet), row by row. */
  private readMatrix(range: CellRange | null): CellData[][] {
    const r = range ? normalizeRange(range) : null;
    const rows = r ? this.document.rows.slice(r.startRow, r.endRow + 1) : this.document.rows;
    const columns = r ? this.document.columns.slice(r.startCol, r.endCol + 1) : this.document.columns;
    return rows.map((row) => columns.map((col) => this.getCell(row.id, col.id)));
  }

  // --- Spreadsheet clipboard ---

  /**
   * Builds clipboard data for `range` (default: the selection) as TSV,
   * an HTML table and the lossless internal JSON format. Write every entry
   * with `clipboardData.setData(type, data)` in a `copy` event.
   */
  public copyToClipboardData(range: CellRange | null = this.selectedRange): SpreadsheetClipboardData {
    const r = range
      ? normalizeRange(range)
      : { startRow: 0, startCol: 0, endRow: this.document.rows.length - 1, endCol: this.document.columns.length - 1 };
    const cells = this.readMatrix(r).map((row) =>
      row.map((cell) => {
        const value = cell.error || cell.value;
        const text = formatCellDisplay(cell);
        // A spilled value is pasted as a constant unless its anchor (whose
        // formula re-spills) is copied too.
        if (cell.spillAnchor && !this.spillAnchorInRange(cell.spillAnchor, r)) {
          return { raw: text, value, text };
        }
        return { raw: cell.raw, value, text };
      })
    );
    return createSpreadsheetClipboardData(cells, { row: r.startRow, col: r.startCol });
  }

  /**
   * Pastes clipboard data at `target` (default: the selection's top-left).
   * Prefers the internal format (formulas re-based to the target), then an
   * HTML table, then TSV. Returns false when there was nothing to paste.
   */
  public pasteClipboardData(source: SpreadsheetClipboardSource, target?: CellPosition): boolean {
    const parsed = readSpreadsheetClipboard(source);
    if (!parsed) return false;
    const at = target ?? this.getSelectionTopLeft();
    const rows = parsed.origin ? rebaseClipboardRows(parsed.rows, parsed.origin, at) : parsed.rows;
    this.writeMatrix(rows, at.row, at.col);
    const r = normalizeRange({
      startRow: at.row,
      startCol: at.col,
      endRow: at.row + rows.length - 1,
      endCol: at.col + rows.reduce((max, row) => Math.max(max, row.length), 1) - 1
    });
    this.selectRange(r);
    return true;
  }

  private spillAnchorInRange(anchor: string, range: CellRange): boolean {
    const record = this.spills.get(anchor);
    return !!record && rangeContains(range, record.row, record.col);
  }

  private getSelectionTopLeft(): CellPosition {
    if (this.selectedRange) {
      const r = normalizeRange(this.selectedRange);
      return { row: r.startRow, col: r.startCol };
    }
    return { row: this.activeCell?.row ?? 0, col: this.activeCell?.col ?? 0 };
  }

  // --- Table operations: shared helpers ---

  /** The table settings object, created on first use. */
  private get table(): SpreadsheetTableSettings {
    if (!this.document.table) this.document.table = {};
    return this.document.table;
  }

  /** Records an undo step, applies `fn`, then notifies listeners. */
  private applyTableChange(fn: () => void, options: { recalculate?: boolean } = {}): void {
    this.recordSnapshot();
    fn();
    if (options.recalculate) {
      this.recomputeRowIndices();
      this.recalculateAll();
    }
    this.document.updatedAt = Date.now();
    this.notifyChange();
  }

  /** First and last (inclusive) body row: rows between header and footer rows. */
  private getBodyRowBounds(): { start: number; end: number } {
    const { headerRows, footerRows } = getTableSections(this.document);
    return { start: headerRows, end: this.document.rows.length - footerRows - 1 };
  }

  private getCellValueAt = (rowIndex: number, colIndex: number): unknown => {
    const row = this.document.rows[rowIndex];
    const col = this.document.columns[colIndex];
    if (!row || !col) return '';
    return this.getCell(row.id, col.id).value;
  };

  /** Rewrites every formula so references follow cells that moved. */
  private remapAllFormulas(moveCell: (position: CellPosition) => CellPosition | null): void {
    for (const rowCells of Object.values(this.document.cells)) {
      for (const cell of Object.values(rowCells)) {
        if (cell.raw?.startsWith('=')) {
          cell.raw = remapFormulaReferences(cell.raw, moveCell);
        }
      }
    }
  }

  /**
   * Keeps merges in place when rows/columns are inserted or deleted:
   * merges after the change shift, merges across it grow or shrink, and
   * merges reduced to a single cell are dropped.
   */
  private adjustTableForStructuralChange(change: StructuralChange): void {
    const merges = this.document.table?.merges;
    if (!merges?.length) return;
    const startKey = change.axis === 'row' ? 'startRow' : 'startCol';
    const endKey = change.axis === 'row' ? 'endRow' : 'endCol';
    const next: CellRange[] = [];
    for (const merge of merges) {
      const m = { ...merge };
      if (change.type === 'insert') {
        if (m[startKey] >= change.index) m[startKey]++;
        if (m[endKey] >= change.index) m[endKey]++;
      } else {
        if (m[startKey] === change.index && m[endKey] === change.index) continue;
        if (m[startKey] > change.index) m[startKey]--;
        if (m[endKey] >= change.index) m[endKey]--;
      }
      if (!isSingleCellRange(m)) next.push(m);
    }
    this.document.table!.merges = next;
  }

  // --- Sort ---

  /**
   * Sorts rows by one or more columns (stable; numbers before text, blanks
   * last). Without a range (or with a range spanning every column) whole rows
   * move; with a range only the cells inside it move. Header and footer rows
   * never move. References follow the moved cells. Returns false when the
   * sort is rejected (no valid keys, a key outside the range, or merged
   * cells in the sorted area).
   */
  public sortRows(keys: SortKey[], options: { range?: CellRange | null } = {}): boolean {
    const colCount = this.document.columns.length;
    const body = this.getBodyRowBounds();
    const range = options.range ? normalizeRange(options.range) : null;
    const startRow = Math.max(range?.startRow ?? body.start, body.start);
    const endRow = Math.min(range?.endRow ?? body.end, body.end);
    const startCol = range ? Math.max(0, range.startCol) : 0;
    const endCol = range ? Math.min(colCount - 1, range.endCol) : colCount - 1;
    if (endRow - startRow < 1 || startCol > endCol) return false;

    const keyCols = keys.map((key) => ({
      index: this.document.columns.findIndex((c) => c.id === key.colId),
      direction: key.direction ?? 'asc'
    }));
    if (keyCols.length === 0 || keyCols.some((k) => k.index < startCol || k.index > endCol)) return false;

    const area: CellRange = { startRow, startCol, endRow, endCol };
    if ((this.document.table?.merges ?? []).some((m) => rangesIntersect(m, area))) return false;
    // Part of a dynamic array can't move (Excel: "You can't change part of an array").
    if (this.intersectsSpill(area)) return false;

    const sourceRows: number[] = [];
    for (let r = startRow; r <= endRow; r++) sourceRows.push(r);
    const sorted = sourceRows
      .map((r) => ({ r, values: keyCols.map((k) => this.getCellValueAt(r, k.index)) }))
      .sort((a, b) => {
        for (let i = 0; i < keyCols.length; i++) {
          const result = compareCellValues(a.values[i], b.values[i], keyCols[i].direction);
          if (result !== 0) return result;
        }
        return a.r - b.r; // stable
      })
      .map((entry) => entry.r);
    if (sorted.every((r, i) => r === sourceRows[i])) return true; // already sorted

    // newIndexOf[oldRow] = newRow
    const newIndexOf = new Map<number, number>();
    sorted.forEach((oldRow, i) => newIndexOf.set(oldRow, startRow + i));
    const wholeRows = startCol === 0 && endCol === colCount - 1;

    this.applyTableChange(() => {
      this.remapAllFormulas(({ row, col }) => {
        const target = newIndexOf.get(row);
        if (target === undefined || col < startCol || col > endCol) return null;
        return { row: target, col };
      });

      if (wholeRows) {
        const moved = sorted.map((r) => this.document.rows[r]);
        this.document.rows.splice(startRow, moved.length, ...moved);
      } else {
        const colIds = this.document.columns.slice(startCol, endCol + 1).map((c) => c.id);
        const snapshot = sorted.map((oldRow) => {
          const rowId = this.document.rows[oldRow].id;
          return colIds.map((colId) => this.document.cells[rowId]?.[colId]);
        });
        snapshot.forEach((cells, i) => {
          const rowId = this.document.rows[startRow + i].id;
          if (!this.document.cells[rowId]) this.document.cells[rowId] = {};
          colIds.forEach((colId, c) => {
            if (cells[c]) this.document.cells[rowId][colId] = cells[c]!;
            else delete this.document.cells[rowId][colId];
          });
        });
      }
    }, { recalculate: true });
    return true;
  }

  // --- Filters ---

  public getFilterState(): SpreadsheetFilterState {
    return this.document.table?.filter ?? { enabled: false, rules: [] };
  }

  /** Replaces all filter rules (and turns filters on when there are any). */
  public setFilterRules(rules: NewFilterRule[]): void {
    this.applyTableChange(() => {
      this.table.filter = {
        enabled: rules.length > 0,
        rules: rules.map((rule) => ({ ...rule, id: rule.id ?? this.generateFilterId() }))
      };
    });
  }

  /** Adds a filter rule (AND-combined with the others) and turns filters on. Returns its id. */
  public addFilterRule(rule: NewFilterRule): string {
    const id = rule.id ?? this.generateFilterId();
    this.applyTableChange(() => {
      const current = this.getFilterState();
      this.table.filter = { enabled: true, rules: [...current.rules, { ...rule, id }] };
    });
    return id;
  }

  public updateFilterRule(ruleId: string, changes: Partial<Omit<FilterRule, 'id'>>): void {
    const current = this.getFilterState();
    if (!current.rules.some((r) => r.id === ruleId)) return;
    this.applyTableChange(() => {
      this.table.filter = {
        ...current,
        rules: current.rules.map((r) => (r.id === ruleId ? { ...r, ...changes } : r))
      };
    });
  }

  public removeFilterRule(ruleId: string): void {
    const current = this.getFilterState();
    if (!current.rules.some((r) => r.id === ruleId)) return;
    this.applyTableChange(() => {
      this.table.filter = { ...current, rules: current.rules.filter((r) => r.id !== ruleId) };
    });
  }

  public clearFilters(): void {
    if (this.getFilterState().rules.length === 0) return;
    this.applyTableChange(() => {
      this.table.filter = { enabled: false, rules: [] };
    });
  }

  /** Turns filtering on or off, keeping the rules. */
  public setFiltersEnabled(enabled: boolean): void {
    const current = this.getFilterState();
    if (current.enabled === enabled) return;
    this.applyTableChange(() => {
      this.table.filter = { ...current, enabled };
    });
  }

  public toggleFilters(): void {
    this.setFiltersEnabled(!this.getFilterState().enabled);
  }

  private generateFilterId(): string {
    return `filter_${Date.now()}_${(nextIdSequence++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // --- Header, footer and frozen rows/columns ---

  public setHeaderRowCount(count: number): void {
    this.setTableCount('headerRowCount', count, this.document.rows.length);
  }

  public setFooterRowCount(count: number): void {
    this.setTableCount('footerRowCount', count, this.document.rows.length);
  }

  public setHeaderColumnCount(count: number): void {
    this.setTableCount('headerColumnCount', count, this.document.columns.length);
  }

  /** Keeps the first `count` rows visible while scrolling. 0 unfreezes. */
  public setFrozenRowCount(count: number): void {
    this.setTableCount('frozenRowCount', count, this.document.rows.length);
  }

  /** Keeps the first `count` columns visible while scrolling. 0 unfreezes. */
  public setFrozenColumnCount(count: number): void {
    this.setTableCount('frozenColumnCount', count, this.document.columns.length);
  }

  private setTableCount(
    key: 'headerRowCount' | 'footerRowCount' | 'headerColumnCount' | 'frozenRowCount' | 'frozenColumnCount',
    count: number,
    max: number
  ): void {
    const value = Math.max(0, Math.min(Math.floor(count), max));
    if ((this.document.table?.[key] ?? 0) === value) return;
    this.applyTableChange(() => {
      this.table[key] = value;
    });
  }

  // --- Hide / unhide ---

  public hideRows(indices: number[]): void {
    this.setHidden('row', indices, true);
  }

  public unhideRows(indices: number[]): void {
    this.setHidden('row', indices, false);
  }

  public hideColumns(indices: number[]): void {
    this.setHidden('col', indices, true);
  }

  public unhideColumns(indices: number[]): void {
    this.setHidden('col', indices, false);
  }

  /** Unhides every hidden row and column (filters are unaffected). */
  public unhideAll(): void {
    const rows = this.document.rows.flatMap((r, i) => (r.hidden ? [i] : []));
    const cols = this.document.columns.flatMap((c, i) => (c.hidden ? [i] : []));
    if (rows.length === 0 && cols.length === 0) return;
    this.applyTableChange(() => {
      rows.forEach((i) => delete this.document.rows[i].hidden);
      cols.forEach((i) => delete this.document.columns[i].hidden);
    });
  }

  private setHidden(axis: 'row' | 'col', indices: number[], hidden: boolean): void {
    const items: Array<SpreadsheetRow | SpreadsheetColumn> = axis === 'row' ? this.document.rows : this.document.columns;
    const targets = indices.filter((i) => items[i] && !!items[i].hidden !== hidden);
    if (targets.length === 0) return;
    this.applyTableChange(() => {
      for (const i of targets) {
        if (hidden) items[i].hidden = true;
        else delete items[i].hidden;
      }
    });
  }

  // --- Merged cells ---

  public getMerges(): CellRange[] {
    return this.document.table?.merges ?? [];
  }

  /** The merge containing (row, col), or null. */
  public getMergeAt(row: number, col: number): CellRange | null {
    return this.getMerges().find((m) => rangeContains(m, row, col)) ?? null;
  }

  /** Grows `range` until no merge crosses its edge. Keeps the drag direction. */
  public expandRangeToMerges(range: CellRange): CellRange {
    let r = normalizeRange(range);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of this.getMerges()) {
        if (rangesIntersect(m, r) && !rangeContainsRange(r, m)) {
          r = {
            startRow: Math.min(r.startRow, m.startRow),
            startCol: Math.min(r.startCol, m.startCol),
            endRow: Math.max(r.endRow, m.endRow),
            endCol: Math.max(r.endCol, m.endCol)
          };
          changed = true;
        }
      }
    }
    const rowsReversed = range.startRow > range.endRow;
    const colsReversed = range.startCol > range.endCol;
    return {
      startRow: rowsReversed ? r.endRow : r.startRow,
      endRow: rowsReversed ? r.startRow : r.endRow,
      startCol: colsReversed ? r.endCol : r.startCol,
      endCol: colsReversed ? r.startCol : r.endCol
    };
  }

  /**
   * Merges `range` (default: the selection) into one cell anchored on its
   * top-left cell; the other cells are cleared. Merges fully inside the range
   * are absorbed. Returns false for single cells and for ranges that
   * partially overlap an existing merge.
   */
  public mergeCells(range: CellRange | null = this.selectedRange): boolean {
    if (!range) return false;
    const r = normalizeRange(range);
    if (
      isSingleCellRange(r) ||
      r.startRow < 0 ||
      r.startCol < 0 ||
      r.endRow >= this.document.rows.length ||
      r.endCol >= this.document.columns.length
    ) {
      return false;
    }
    const merges = this.getMerges();
    if (merges.some((m) => rangesIntersect(m, r) && !rangeContainsRange(r, m))) return false;
    if (this.intersectsSpill(r)) return false;

    this.applyTableChange(() => {
      for (let row = r.startRow; row <= r.endRow; row++) {
        const rowId = this.document.rows[row].id;
        for (let col = r.startCol; col <= r.endCol; col++) {
          if (row === r.startRow && col === r.startCol) continue;
          delete this.document.cells[rowId]?.[this.document.columns[col].id];
        }
      }
      this.table.merges = [...merges.filter((m) => !rangeContainsRange(r, m)), r];
    }, { recalculate: true });
    this.selectCell(r.startRow, r.startCol);
    return true;
  }

  /** Removes every merge intersecting `range` (default: the selection). */
  public unmergeCells(range: CellRange | null = this.selectedRange): boolean {
    if (!range) return false;
    const merges = this.getMerges();
    const remaining = merges.filter((m) => !rangesIntersect(m, range));
    if (remaining.length === merges.length) return false;
    // Recalculate: the merge may have blocked a dynamic array (#SPILL!).
    this.applyTableChange(() => {
      this.table.merges = remaining;
    }, { recalculate: true });
    return true;
  }

  // --- Autofill ---

  /**
   * Fills `target` from `source` like dragging the fill handle. `target` is
   * the extended range (source included) and must extend `source` down, up,
   * right or left. Numbers and dates continue their series, text ending in a
   * number counts up, other text repeats, and formulas are copied with
   * their relative references shifted (`$` parts stay). Returns false when
   * the ranges don't line up.
   */
  public autofill(source: CellRange, target: CellRange): boolean {
    const s = normalizeRange(source);
    const t = normalizeRange(target);
    const direction = getFillDirection(s, t);
    if (!direction || t.startRow < 0 || t.startCol < 0) return false;
    if (s.endRow >= this.document.rows.length || s.endCol >= this.document.columns.length) return false;

    const vertical = direction === 'down' || direction === 'up';
    const forward = direction === 'down' || direction === 'right';
    // Source positions along the fill axis, nearest to the fill area last.
    const sourceSteps: number[] = [];
    const [sLo, sHi] = vertical ? [s.startRow, s.endRow] : [s.startCol, s.endCol];
    for (let i = sLo; i <= sHi; i++) sourceSteps.push(i);
    if (!forward) sourceSteps.reverse();
    const fillSteps: number[] = [];
    if (forward) for (let i = sHi + 1; i <= (vertical ? t.endRow : t.endCol); i++) fillSteps.push(i);
    else for (let i = sLo - 1; i >= (vertical ? t.startRow : t.startCol); i--) fillSteps.push(i);

    const [lLo, lHi] = vertical ? [s.startCol, s.endCol] : [s.startRow, s.endRow];
    this.runBatch(() => {
      this.growGrid(vertical ? Math.max(t.endRow, 0) : s.endRow, vertical ? s.endCol : Math.max(t.endCol, 0));
      for (let line = lLo; line <= lHi; line++) {
        const at = (step: number) => (vertical ? { row: step, col: line } : { row: line, col: step });
        const raws = sourceSteps.map((step) => {
          const p = at(step);
          return this.getCell(this.document.rows[p.row].id, this.document.columns[p.col].id).raw;
        });
        const hasFormula = raws.some((raw) => raw.startsWith('='));
        const series = hasFormula ? null : fillSeries(raws, fillSteps.length);
        fillSteps.forEach((step, i) => {
          const p = at(step);
          let raw: string;
          if (series) {
            raw = series[i];
          } else {
            const from = sourceSteps[i % sourceSteps.length];
            raw = raws[i % raws.length];
            if (raw.startsWith('=')) {
              const delta = step - from;
              raw = vertical ? offsetFormulaReferences(raw, delta, 0) : offsetFormulaReferences(raw, 0, delta);
            }
          }
          this.setCellValue(this.document.rows[p.row].id, this.document.columns[p.col].id, raw);
        });
      }
    });
    this.selectRange(t);
    return true;
  }

  // --- Categories (row groups) ---

  /**
   * Groups body rows by the value in `colId`, with optional per-group
   * summaries (e.g. `[{ colId, aggregate: 'sum' }]`).
   */
  public groupRowsBy(colId: string, summaries: GroupSummary[] = []): void {
    if (!this.getColumn(colId)) return;
    this.applyTableChange(() => {
      this.table.grouping = { colId, summaries, collapsed: [] };
    });
  }

  public ungroupRows(): void {
    if (!this.document.table?.grouping) return;
    this.applyTableChange(() => {
      delete this.table.grouping;
    });
  }

  /** Sets (or with `null`, removes) the group summary for a column. */
  public setGroupSummary(colId: string, aggregate: GroupAggregate | null): void {
    const grouping = this.document.table?.grouping;
    if (!grouping) return;
    this.applyTableChange(() => {
      const others = grouping.summaries.filter((s) => s.colId !== colId);
      this.table.grouping = {
        ...grouping,
        summaries: aggregate ? [...others, { colId, aggregate }] : others
      };
    });
  }

  public setGroupCollapsed(key: string, collapsed: boolean): void {
    const grouping = this.document.table?.grouping;
    if (!grouping || grouping.collapsed.includes(key) === collapsed) return;
    this.applyTableChange(() => {
      this.table.grouping = {
        ...grouping,
        collapsed: collapsed ? [...grouping.collapsed, key] : grouping.collapsed.filter((k) => k !== key)
      };
    });
  }

  public toggleGroupCollapsed(key: string): void {
    const grouping = this.document.table?.grouping;
    if (!grouping) return;
    this.setGroupCollapsed(key, !grouping.collapsed.includes(key));
  }

  /** The current row groups with their summaries (empty when not grouped). */
  public getGroups(): SpreadsheetRowGroup[] {
    return computeRowGroups(this.document, this.getCellValueAt);
  }

  // --- Transpose ---

  /**
   * Transposes `range` (default: the selection) in place around its top-left
   * cell: rows become columns. Cells left uncovered are cleared, the grid
   * grows if needed, and references follow the moved cells. Returns false
   * for single cells or when merged cells are involved.
   */
  public transposeRange(range: CellRange | null = this.selectedRange): boolean {
    if (!range) return false;
    const s = normalizeRange(range);
    if (isSingleCellRange(s)) return false;
    const height = s.endRow - s.startRow + 1;
    const width = s.endCol - s.startCol + 1;
    const t: CellRange = { startRow: s.startRow, startCol: s.startCol, endRow: s.startRow + width - 1, endCol: s.startCol + height - 1 };
    if (this.getMerges().some((m) => rangesIntersect(m, s) || rangesIntersect(m, t))) return false;
    if (this.intersectsSpill(s) || this.intersectsSpill(t)) return false;

    this.applyTableChange(() => {
      this.growGrid(t.endRow, t.endCol);
      this.remapAllFormulas(({ row, col }) => {
        if (!rangeContains(s, row, col)) return null;
        return { row: s.startRow + (col - s.startCol), col: s.startCol + (row - s.startRow) };
      });

      const rowId = (r: number) => this.document.rows[r].id;
      const colId = (c: number) => this.document.columns[c].id;
      const moved: Array<{ row: number; col: number; cell: CellData | undefined }> = [];
      for (let r = s.startRow; r <= s.endRow; r++) {
        for (let c = s.startCol; c <= s.endCol; c++) {
          moved.push({
            row: s.startRow + (c - s.startCol),
            col: s.startCol + (r - s.startRow),
            cell: this.document.cells[rowId(r)]?.[colId(c)]
          });
          delete this.document.cells[rowId(r)]?.[colId(c)];
        }
      }
      for (const { row, col, cell } of moved) {
        if (!cell) continue;
        if (!this.document.cells[rowId(row)]) this.document.cells[rowId(row)] = {};
        this.document.cells[rowId(row)][colId(col)] = cell;
      }
    }, { recalculate: true });
    this.selectRange(t);
    return true;
  }

  // --- View model ---

  /**
   * What to render: visible rows (with group headers) and columns in display
   * order, frozen offsets and merged-cell spans. Filters, hidden rows/columns
   * and collapsed groups only affect this view, never the document.
   */
  public getViewModel(): SpreadsheetViewModel {
    return buildSpreadsheetView(this.document, this.getCellValueAt);
  }

  // --- Undo/Redo Snapshots ---

  private recordSnapshot(): void {
    if (this.isApplyingHistory || this.batching) return;
    this.undoStack.push(JSON.stringify(this.document));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.trimHistory();
  }

  /** Drops the oldest snapshots beyond `maxHistoryBytes`, always keeping the newest. */
  private trimHistory(): void {
    if (this.maxHistoryBytes <= 0 || this.undoStack.length <= 1) return;
    let total = 0;
    for (const s of this.undoStack) total += s.length * 2;
    for (const s of this.redoStack) total += s.length * 2;
    while (total > this.maxHistoryBytes && this.undoStack.length > 1) {
      total -= this.undoStack.shift()!.length * 2;
    }
  }

  /** Approximate bytes held by the undo/redo snapshots (UTF-16 size). */
  public getHistoryByteSize(): number {
    let total = 0;
    for (const s of this.undoStack) total += s.length * 2;
    for (const s of this.redoStack) total += s.length * 2;
    return total;
  }

  /** Number of undo / redo snapshots currently held. */
  public getHistoryDepth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
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

/**
 * The index after (`delta` = 1) or before (-1) `from` in a display order,
 * staying put at the edges. When `from` is not displayed (hidden), moves to
 * the nearest displayed index in that direction.
 */
function stepInOrder(order: number[], from: number, delta: 1 | -1): number {
  if (order.length === 0) return from;
  const pos = order.indexOf(from);
  if (pos === -1) {
    const candidates = order.filter((i) => (delta > 0 ? i > from : i < from));
    if (candidates.length === 0) return from;
    return candidates.reduce((best, i) => (delta > 0 ? Math.min(best, i) : Math.max(best, i)));
  }
  return order[Math.max(0, Math.min(order.length - 1, pos + delta))];
}
