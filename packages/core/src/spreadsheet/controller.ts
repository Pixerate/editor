// Portions ported from gridcraft/crates/engine/src/cmd/sheet.rs and
// gridcraft/crates/engine/src/cmd/formulas.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
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
  SpreadsheetSpill,
  SpreadsheetWorkbook,
  SpreadsheetDefinedName,
  SpreadsheetSheetInfo
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
  parseFormula,
  extractCellDependencies,
  extractNameDependencies,
  columnDependencyKey,
  getFormulaFunction,
  renameSheetInFormula,
  deleteSheetInFormula,
  renameNameInFormula,
  type ASTNode,
  type FormulaRange,
  type FormulaNameDefinition,
  type FormulaEvaluationResult,
  type StructuralChange,
  type CellPosition,
  type FormulaReferenceFilter
} from './formula';
import {
  copySheetName,
  isLambdaDefinition,
  nextSheetName,
  validateDefinedName,
  validateSheetName
} from './workbook';
import { parseCellInput } from './formula/parse-input';
import { formatCellDisplay } from './formula/format';
import { cellFormatForNumberFormat, isGeneralNumberFormat } from './numfmt/presets';
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
  ConditionalFormatEngine,
  EMPTY_CONDITIONAL_FORMAT_OVERLAY,
  type ConditionalCellFormat,
  type ConditionalFormatOverlay,
  type ConditionalFormatRule,
  type ConditionalFormatSheet,
  type ConditionalFormatValue,
  type NewConditionalFormatRule
} from './conditional-format';
import {
  findDataValidation,
  findInvalidCells,
  getValidationListValues,
  validateCellInput,
  type DataValidationResult,
  type DataValidationRule,
  type DataValidationSheet,
  type NewDataValidationRule
} from './validation';
import { adjustRangesForStructuralChange, shiftRuleFormula, subtractRangeFromRanges } from './rule-ranges';
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
  /** Sheet (id or name) to import into; default the active sheet. */
  sheet?: string;
}

export type NewFilterRule = Omit<FilterRule, 'id'> & { id?: string };

/**
 * Invalid input waiting for the user: a `stop` alert (retry or cancel) or a
 * `warning` / `information` prompt (accept, retry or cancel). See
 * `SpreadsheetController.resolveValidationPrompt`.
 */
export interface SpreadsheetValidationPrompt {
  rowId: string;
  colId: string;
  row: number;
  col: number;
  /** The input that failed validation. */
  raw: string;
  /** The failed check: rule, alert style, title and message. */
  result: DataValidationResult;
  /** True when the input came from the cell editor (which stays open meanwhile). */
  editing: boolean;
}

/**
 * Outcome of committing input: `committed`; `rejected` (a `stop` rule) or
 * `confirm` (a `warning` / `information` rule), with `prompt` now waiting
 * in `validationPrompt`; `pending` when an earlier prompt is still open;
 * `none` when nothing was being edited.
 */
export type SpreadsheetCommitResult =
  | { status: 'committed' | 'none' }
  | { status: 'rejected' | 'confirm' | 'pending'; prompt: SpreadsheetValidationPrompt };

/** How the user answered a validation prompt. */
export type SpreadsheetValidationAction = 'accept' | 'retry' | 'cancel';

export interface SpreadsheetControllerOptions {
  document?: Partial<SpreadsheetDocument>;
  dataSources?: SpreadsheetDataSource[];
  primaryDataSourceId?: string;
  onDocumentChange?: (doc: SpreadsheetDocument) => void;
  onSelectionChange?: (activeCell: CellCoordinate | null, range: CellRange | null) => void;
  onCellCommit?: (rowId: string, colId: string, raw: string, value: any) => void;
  /**
   * Start from a workbook with several sheets and defined names instead of
   * `document`. `document` then names nothing; the active sheet is
   * `workbook.activeSheetId` (default the first sheet).
   */
  workbook?: SpreadsheetWorkbook;
  /**
   * Called after any change, like `onDocumentChange`, with the whole
   * workbook. The object holds the live sheet documents: copy it (or use
   * `getWorkbook()`) before keeping it.
   */
  onWorkbookChange?: (workbook: SpreadsheetWorkbook) => void;
  /** Called when another sheet becomes active. */
  onActiveSheetChange?: (sheetId: string) => void;
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

/**
 * One sheet of the workbook: its document plus derived state (spilled
 * arrays) and, while it is not active, its saved selection.
 */
interface SheetRuntime {
  doc: SpreadsheetDocument;
  spills: Map<string, SpillRecord>; // anchor key -> spill
  spilledBy: Map<string, string>; // spilled cell key -> anchor key
  spillCells: Map<string, CellData>; // spillCellId -> displayed cell
  activeCell: CellCoordinate | null;
  selectedRange: CellRange | null;
}

const createRuntime = (doc: SpreadsheetDocument): SheetRuntime => ({
  doc,
  spills: new Map(),
  spilledBy: new Map(),
  spillCells: new Map(),
  activeCell: null,
  selectedRange: null
});

/**
 * An undo/redo step: a snapshot of one sheet (cell edits, table operations)
 * or of the whole workbook (sheet and name operations).
 */
type HistoryEntry = { kind: 'sheet'; sheetId: string; data: string } | { kind: 'workbook'; data: string };

interface WorkbookSnapshot {
  sheets: SpreadsheetDocument[];
  activeSheetId: string;
  names: SpreadsheetDefinedName[];
}

const sameName = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/** A defined name as listed by `getNames()`. */
export interface SpreadsheetNameInfo extends SpreadsheetDefinedName {
  /** Name of the sheet a sheet-scoped name belongs to; unset for workbook scope. */
  sheetName?: string;
  /** Whether the name holds a LAMBDA (it is called like a function). */
  isLambda: boolean;
}

/** Where a defined name lives: `sheet` (id or name) for a sheet-scoped name. */
export interface SpreadsheetNameScope {
  sheet?: string;
}

// Default undo/redo snapshot budget (see SpreadsheetControllerOptions.maxHistoryBytes).
const DEFAULT_MAX_HISTORY_BYTES = 64 * 1024 * 1024;

// Recalculation passes after spill ranges change (see recalculateKeys).
const MAX_SPILL_PASSES = 25;

const spillCellId = (rowId: string, colId: string) => `${rowId}\u0000${colId}`;

export class SpreadsheetController {
  public activeCell: CellCoordinate | null = null;
  public selectedRange: CellRange | null = null;
  public editingCell: CellCoordinate | null = null;
  public draftValue = '';

  public readonly binder = new DataSourceBinder();
  public readonly depGraph = new DependencyGraph();
  public readonly evaluator: FormulaEvaluator;

  private primaryDataSourceId?: string;
  private onDocumentChange?: (doc: SpreadsheetDocument) => void;
  private onWorkbookChange?: (workbook: SpreadsheetWorkbook) => void;
  private onActiveSheetChange?: (sheetId: string) => void;

  // Workbook: sheets in tab order, the active one, and the one being worked
  // on (the active sheet, or another sheet while one of its cells is read or
  // evaluated). Everything that uses `this.document` works on `ctx`.
  private runtimes: SheetRuntime[] = [];
  private active!: SheetRuntime;
  private ctx!: SheetRuntime;
  // The sheet bound to the primary data source (the first sheet).
  private boundSheetId: string | null = null;
  private names: SpreadsheetDefinedName[] = [];
  private onSelectionChange?: (activeCell: CellCoordinate | null, range: CellRange | null) => void;
  private onCellCommit?: (rowId: string, colId: string, raw: string, value: any) => void;

  // History stack for undo/redo
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private isApplyingHistory = false;
  private readonly maxHistoryBytes: number;
  // Set while importing TSV: history and recalculation are done once at the end.
  private batching = false;
  private pendingCommits: Array<[string, string, string]> = [];
  // Row being evaluated, so [property] references resolve per row.
  private evaluatingRowIndex: number | null = null;
  // Cell being evaluated, for implicit intersection (`=@A:A`).
  private evaluatingCell: { col: string; row: number } | null = null;

  // Dynamic arrays. Spilled values are derived state: they live in the sheet
  // runtimes, not in the documents, and every recalculation rebuilds them.
  // Cells (sheet-qualified keys) whose spill ownership changed during the current pass.
  private spillChanges: Set<string> | null = null;

  /** The active sheet's document (the sheet the editor shows). */
  public get document(): SpreadsheetDocument {
    return this.ctx.doc;
  }

  public set document(doc: SpreadsheetDocument) {
    this.ctx.doc = doc;
  }

  private get spills(): Map<string, SpillRecord> {
    return this.ctx.spills;
  }

  private get spilledBy(): Map<string, string> {
    return this.ctx.spilledBy;
  }

  private get spillCells(): Map<string, CellData> {
    return this.ctx.spillCells;
  }

  // Conditional formatting is evaluated lazily (getConditionalFormatOverlay).
  // Cell keys whose values changed since, or 'all' to evaluate from scratch.
  private cfEngine: ConditionalFormatEngine | null = null;
  private cfDirty: Set<string> | 'all' = 'all';
  // Set while a single cell edit notifies, so the change stays incremental.
  private cfIncremental = false;
  // Value being entered, seen by validation formulas instead of the cell's value.
  private valueOverride: { row: number; col: number; value: unknown } | null = null;
  // "Circle invalid data": on/off and the cached cells.
  private circlesShown = false;
  private invalidCircles: Set<string> | null = null;
  /** Invalid input waiting for the user's answer (see `resolveValidationPrompt`). */
  public validationPrompt: SpreadsheetValidationPrompt | null = null;

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

    const first: SpreadsheetDocument = {
      id: options.document?.id || `sheet_${Date.now()}`,
      name: options.document?.name || 'Sheet 1',
      columns: options.document?.columns || defaultCols,
      rows: options.document?.rows || defaultRows,
      cells: options.document?.cells || {},
      createdAt: options.document?.createdAt || Date.now(),
      updatedAt: options.document?.updatedAt || Date.now(),
      ...(options.document?.table ? { table: options.document.table } : {})
    };
    if (options.workbook && options.workbook.sheets.length > 0) {
      this.setWorkbookState(options.workbook, false);
    } else {
      this.runtimes = [createRuntime(first)];
      this.active = this.ctx = this.runtimes[0];
    }
    this.boundSheetId = this.runtimes[0].doc.id;

    this.primaryDataSourceId = options.primaryDataSourceId;
    this.maxHistoryBytes = Math.max(0, options.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES);
    this.onDocumentChange = options.onDocumentChange;
    this.onSelectionChange = options.onSelectionChange;
    this.onCellCommit = options.onCellCommit;
    this.onWorkbookChange = options.onWorkbookChange;
    this.onActiveSheetChange = options.onActiveSheetChange;

    if (options.dataSources) {
      options.dataSources.forEach((ds) => this.binder.register(ds));
    }

    this.evaluator = new FormulaEvaluator({
      resolveCell: (colStr, rowNum, sheet) => this.onSheet(sheet, () => this.resolveCellByCoord(colStr, rowNum)),
      resolveRange: (sCol, sRow, eCol, eRow, sheet) =>
        this.onSheet(sheet, () => this.resolveRangeByCoords(sCol, sRow, eCol, eRow)),
      resolveProperty: (prop) => this.resolveCurrentRowProperty(prop),
      resolveSpill: (colStr, rowNum, sheet) => this.onSheet(sheet, () => this.resolveSpillByCoord(colStr, rowNum)),
      resolveSheetSpan: (first, last) => this.resolveSheetSpan(first, last),
      resolveName: (name, sheet) => this.resolveDefinedName(name, sheet),
      getFormulaCell: () => this.evaluatingCell
    });

    this.syncWithDataSource();
    for (const rt of this.runtimes) this.withSheet(rt, () => this.rederiveTypedValues());
    this.recalculateAll();
  }

  // --- Workbook: sheet runtimes ---

  private get boundRuntime(): SheetRuntime | null {
    return this.boundSheetId === null ? null : this.findRuntimeById(this.boundSheetId) ?? null;
  }

  /** Runs `fn` with `rt` as the sheet `this.document` (and spills) refer to. */
  private withSheet<T>(rt: SheetRuntime, fn: () => T): T {
    if (rt === this.ctx) return fn();
    const saved = this.ctx;
    this.ctx = rt;
    try {
      return fn();
    } finally {
      this.ctx = saved;
    }
  }

  /**
   * Runs `fn` on the sheet named `sheet` (a sheet-qualified reference), or
   * on the current sheet when undefined. `#REF!` when no sheet has that name.
   */
  private onSheet<T>(sheet: string | undefined, fn: () => T): T | string {
    if (sheet === undefined) return fn();
    const rt = this.findRuntimeByName(sheet);
    return rt ? this.withSheet(rt, fn) : '#REF!';
  }

  private findRuntimeByName(name: string): SheetRuntime | undefined {
    return this.runtimes.find((rt) => sameName(rt.doc.name, name));
  }

  private findRuntimeById(id: string): SheetRuntime | undefined {
    return this.runtimes.find((rt) => rt.doc.id === id) ?? this.runtimes.find((rt) => sameName(rt.doc.id, id));
  }

  /** A sheet by id or name. */
  private findRuntime(idOrName: string): SheetRuntime | undefined {
    return this.runtimes.find((rt) => rt.doc.id === idOrName) ?? this.findRuntimeByName(idOrName);
  }

  /** Dependency-graph key of a cell (`A1`) on a sheet: sheet-qualified, so keys are unique in the workbook. */
  private qualify(key: string, rt: SheetRuntime = this.ctx): string {
    return `${rt.doc.id}!${key}`.toUpperCase();
  }

  /** The sheet and A1 key of a qualified key. */
  private unqualify(qualified: string): { rt: SheetRuntime; key: string } | null {
    const bang = qualified.lastIndexOf('!');
    if (bang < 0) return null;
    const id = qualified.slice(0, bang);
    const rt = this.runtimes.find((r) => r.doc.id.toUpperCase() === id);
    return rt ? { rt, key: qualified.slice(bang + 1) } : null;
  }

  private resolveSheetSpan(first: string, last: string): string[] | string {
    const a = this.runtimes.findIndex((rt) => sameName(rt.doc.name, first));
    const b = this.runtimes.findIndex((rt) => sameName(rt.doc.name, last));
    if (a < 0 || b < 0) return '#REF!';
    return this.runtimes.slice(Math.min(a, b), Math.max(a, b) + 1).map((rt) => rt.doc.name);
  }

  /** The defined name `name` visible from `rt`: its sheet-scoped name first, then the workbook one. */
  private findName(name: string, rt: SheetRuntime | null): SpreadsheetDefinedName | undefined {
    return (
      (rt ? this.names.find((n) => n.sheetId === rt.doc.id && sameName(n.name, name)) : undefined) ??
      this.names.find((n) => n.sheetId === undefined && sameName(n.name, name))
    );
  }

  private resolveDefinedName(name: string, sheet?: string): FormulaNameDefinition | null {
    const rt = sheet === undefined ? this.ctx : this.findRuntimeByName(sheet);
    if (!rt) return null;
    const def = this.findName(name, rt);
    if (!def) return null;
    const scope = def.sheetId !== undefined ? this.findRuntimeById(def.sheetId) : undefined;
    return {
      formula: def.refersTo,
      ...(scope ? { sheet: scope.doc.name } : {}),
      key: `${def.sheetId ?? ''}!${def.name}`
    };
  }

  /**
   * Replaces the active sheet with `document` (its name becomes the sheet's
   * name, made unique). Clears undo history.
   */
  public loadDocument(document: SpreadsheetDocument): void {
    const loaded: SpreadsheetDocument = JSON.parse(JSON.stringify(document));
    const others = this.runtimes.filter((rt) => rt !== this.active);
    if (others.some((rt) => rt.doc.id === loaded.id)) loaded.id = this.generateSheetId();
    const otherNames = others.map((rt) => rt.doc.name);
    if (!loaded.name || otherNames.some((n) => sameName(n, loaded.name))) {
      loaded.name = loaded.name ? copySheetName(loaded.name, otherNames) : nextSheetName(otherNames);
    }
    const previousId = this.active.doc.id;
    this.ctx = this.active;
    this.document = loaded;
    if (previousId !== loaded.id) {
      for (const n of this.names) if (n.sheetId === previousId) n.sheetId = loaded.id;
      if (this.boundSheetId === previousId) this.boundSheetId = loaded.id;
    }
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

  // --- Workbook: loading and saving ---

  /** A deep copy of the workbook: every sheet, the active sheet and the defined names. */
  public getWorkbook(): SpreadsheetWorkbook {
    return JSON.parse(JSON.stringify(this.workbookSnapshot()));
  }

  /** Replaces the whole workbook (sheets, names, active sheet). Clears undo history. */
  public loadWorkbook(workbook: SpreadsheetWorkbook): void {
    if (!workbook.sheets.length) return;
    this.setWorkbookState(JSON.parse(JSON.stringify(workbook)), true);
    this.boundSheetId = this.runtimes[0].doc.id;
    this.editingCell = null;
    this.draftValue = '';
    this.undoStack = [];
    this.redoStack = [];
    this.syncWithDataSource();
    for (const rt of this.runtimes) this.withSheet(rt, () => this.rederiveTypedValues());
    this.recalculateAll();
    this.notifyChange();
    this.onSelectionChange?.(this.activeCell, this.selectedRange);
  }

  private workbookSnapshot(): WorkbookSnapshot {
    return {
      sheets: this.runtimes.map((rt) => rt.doc),
      activeSheetId: this.active.doc.id,
      names: this.names
    };
  }

  /**
   * Installs a workbook's sheets and names (taking ownership of the objects).
   * Duplicate sheet ids and names are made unique.
   */
  private setWorkbookState(workbook: SpreadsheetWorkbook, resetSelection: boolean): void {
    const ids = new Set<string>();
    const names: string[] = [];
    const runtimes = workbook.sheets.map((doc) => {
      if (!doc.id || ids.has(doc.id)) doc.id = this.generateSheetId();
      ids.add(doc.id);
      if (!doc.name || names.some((n) => sameName(n, doc.name))) {
        doc.name = doc.name ? copySheetName(doc.name, names) : nextSheetName(names);
      }
      names.push(doc.name);
      doc.columns ??= [];
      doc.rows ??= [];
      doc.cells ??= {};
      return createRuntime(doc);
    });
    this.runtimes = runtimes;
    this.active = this.ctx =
      runtimes.find((rt) => rt.doc.id === workbook.activeSheetId) ?? runtimes[0];
    this.names = (workbook.names ?? [])
      .filter((n) => n.sheetId === undefined || ids.has(n.sheetId))
      .map((n) => ({ ...n, refersTo: n.refersTo.startsWith('=') ? n.refersTo : `=${n.refersTo}` }));
    if (resetSelection) {
      this.activeCell = null;
      this.selectedRange = null;
    }
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
        const typed = this.typedCell(cell.raw, cell.format, col, cell);
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
  private typedCell(
    raw: string,
    format: CellData['format'],
    col?: SpreadsheetColumn,
    existing?: CellData
  ): Pick<CellData, 'value' | 'numberFormat' | 'explicitNumberFormat' | 'format'> {
    const parsed = parseCellInput(raw);
    const fixed = this.fixedNumberFormat(col, existing);
    const numberFormat = fixed ?? parsed.numberFormat;
    return {
      value: parsed.value,
      ...(numberFormat ? { numberFormat } : {}),
      ...(existing?.explicitNumberFormat ? { explicitNumberFormat: true } : {}),
      format: fixed === undefined && parsed.cellFormat && (!format || format === 'text') ? parsed.cellFormat : format
    };
  }

  /**
   * The number format a cell keeps whatever is typed into it: its explicit
   * one, else its column's. Undefined lets typed input choose one.
   */
  private fixedNumberFormat(col: SpreadsheetColumn | undefined, existing: CellData | undefined): string | undefined {
    if (existing?.explicitNumberFormat && existing.numberFormat !== undefined) return existing.numberFormat;
    return col?.numberFormat && !isGeneralNumberFormat(col.numberFormat) ? col.numberFormat : undefined;
  }

  /** `numberFormat` / `explicitNumberFormat` fields for a formula, bound or spilled cell. */
  private fixedNumberFormatFields(col: SpreadsheetColumn | undefined, existing: CellData | undefined): Partial<CellData> {
    const numberFormat = this.fixedNumberFormat(col, existing);
    if (numberFormat === undefined) return {};
    return existing?.explicitNumberFormat ? { numberFormat, explicitNumberFormat: true } : { numberFormat };
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
    if (!this.primaryDataSourceId || !this.boundRuntime) return;
    const id = this.primaryDataSourceId;
    // Records are bound to the first sheet (the one the controller was created with).
    this.withSheet(this.boundRuntime, () => {
      this.document.rows = this.binder.syncRows(this.document.rows, id);
      this.recomputeRowIndices();
    });
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
    if (existing && !existing.explicitNumberFormat) return existing;

    const col = this.document.columns.find((c) => c.id === colId);
    const row = this.document.rows.find((r) => r.id === rowId);
    const derived = this.getDerivedCell(row, col);
    if (!existing) return derived;
    // A blank cell holding only an explicit number format, over a bound
    // record value or a column formula: show that value with the format.
    if (derived.raw === '') return existing;
    return { ...derived, numberFormat: existing.numberFormat, explicitNumberFormat: true };
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
        format: col.format,
        ...this.fixedNumberFormatFields(col, undefined)
      };
    }

    // Check if column has a column-level formula
    if (col && col.type === 'formula' && col.formula) {
      return {
        raw: col.formula,
        value: '',
        format: col.format,
        ...this.fixedNumberFormatFields(col, undefined)
      };
    }

    return { raw: '', value: '', format: col?.format, ...this.fixedNumberFormatFields(col, undefined) };
  }

  public setCellValue(rowId: string, colId: string, raw: string): void {
    this.recordSnapshot();

    if (!this.document.cells[rowId]) {
      this.document.cells[rowId] = {};
    }

    const col = this.document.columns.find((c) => c.id === colId);
    const row = this.document.rows.find((r) => r.id === rowId);

    const isFormula = raw.startsWith('=');
    const existing = this.document.cells[rowId][colId];
    let cell: CellData;
    // If this is a bound column and row is bound to record, dispatch back to data source
    if (col?.type === 'bound' && col.binding && row?.recordId) {
      const value = this.boundInputValue(col.binding.dataSource, col.binding.field, raw);
      this.binder.commitBoundValue(col.binding.dataSource, row.recordId, col.binding.field, value);
      cell = { raw, value, format: col.format, ...this.fixedNumberFormatFields(col, existing) };
    } else if (isFormula) {
      cell = { raw, value: raw, format: col?.format, ...this.fixedNumberFormatFields(col, existing) };
    } else {
      cell = { raw, ...this.typedCell(raw, col?.format, col, existing) };
    }

    const cellKey = this.getCellKey(rowId, colId);
    this.registerFormula(cellKey, isFormula ? raw : null);

    this.document.cells[rowId][colId] = cell;

    this.document.updatedAt = Date.now();
    if (this.batching) {
      this.pendingCommits.push([rowId, colId, raw]);
      return;
    }
    if (this.cfDirty !== 'all') this.cfDirty.add(cellKey);
    this.recalculateCell(rowId, colId);
    this.cfIncremental = true;
    try {
      this.notifyChange();
    } finally {
      this.cfIncremental = false;
    }

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
    this.recalculateKeys(anchor ? [this.qualify(cellKey), this.qualify(anchor)] : [this.qualify(cellKey)], true);
  }

  /**
   * Registers the dependencies of the formula in `cellKey` (A1 key on the
   * current sheet), or removes them when `formula` is null: its references
   * (sheet-qualified ones on their sheet, 3-D ones on every sheet of the
   * span) and, through defined names, the cells those names refer to.
   */
  private registerFormula(cellKey: string, formula: string | null): void {
    const key = this.qualify(cellKey);
    if (!formula || !formula.startsWith('=')) {
      this.depGraph.setCellDependencies(key, []);
      return;
    }
    let ast: ASTNode;
    try {
      ast = parseFormula(formula);
    } catch {
      this.depGraph.setCellDependencies(key, []);
      return;
    }
    const deps = new Set<string>();
    this.collectDependencies(ast, this.ctx, deps, new Set());
    this.depGraph.setCellDependencies(key, deps);
  }

  /** Adds the qualified keys `ast` depends on, with unqualified references on `home`. */
  private collectDependencies(ast: ASTNode, home: SheetRuntime, out: Set<string>, seenNames: Set<string>): void {
    for (const dep of extractCellDependencies(ast)) {
      let sheets: SheetRuntime[];
      if (dep.sheet === undefined) {
        sheets = [home];
      } else if (dep.sheetEnd === undefined) {
        const rt = this.findRuntimeByName(dep.sheet);
        sheets = rt ? [rt] : [];
      } else {
        const span = this.resolveSheetSpan(dep.sheet, dep.sheetEnd);
        sheets = Array.isArray(span) ? span.map((name) => this.findRuntimeByName(name)!) : [];
      }
      for (const rt of sheets) {
        out.add(dep.row === 0 ? columnDependencyKey(`${rt.doc.id}!${dep.col}`) : this.qualify(`${dep.col}${dep.row}`, rt));
      }
    }
    for (const used of extractNameDependencies(ast)) {
      // A call of a built-in function is not a name.
      if (used.call && getFormulaFunction(used.name)) continue;
      const lookupSheet = used.sheet === undefined ? home : this.findRuntimeByName(used.sheet);
      if (!lookupSheet) continue;
      const def = this.findName(used.name, lookupSheet);
      if (!def) continue;
      const scope = def.sheetId !== undefined ? this.findRuntimeById(def.sheetId) : undefined;
      // Unqualified references in a workbook-scoped name refer to the using sheet.
      const nameHome = scope ?? home;
      const seenKey = `${def.sheetId ?? ''}!${def.name.toUpperCase()}@${nameHome.doc.id}`;
      if (seenNames.has(seenKey)) continue;
      seenNames.add(seenKey);
      try {
        this.collectDependencies(parseFormula(def.refersTo), nameHome, out, seenNames);
      } catch {
        // A name whose formula can't be parsed has no dependencies.
      }
    }
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
    this.cfDirty = 'all';
    this.depGraph.clear();
    const formulaKeys: string[] = [];
    for (const rt of this.runtimes) {
      this.withSheet(rt, () => {
        this.spills.clear();
        this.spilledBy.clear();
        this.spillCells.clear();
        for (const row of this.document.rows) {
          for (const col of this.document.columns) {
            // Avoid getCell's id lookups: this loop visits every cell.
            const cell = this.document.cells[row.id]?.[col.id] ?? this.getDerivedCell(row, col);
            if (cell.raw.startsWith('=')) {
              const cellKey = `${col.key}${row.index + 1}`.toUpperCase();
              this.registerFormula(cellKey, cell.raw);
              formulaKeys.push(this.qualify(cellKey));
            }
          }
        }
      });
    }
    this.recalculateKeys(formulaKeys, false);
  }

  private runEvaluationPlan(plan: { order: string[]; cyclic: Set<string> }): void {
    for (const qualified of plan.order) {
      const located = this.unqualify(qualified);
      if (!located) continue;
      // Conditional formatting tracks changed cells on the active sheet only; other
      // sheets are evaluated from scratch when they are activated.
      const onActive = located.rt === this.active;
      this.withSheet(located.rt, () => {
        if (onActive) this.markValueChanged(located.key); // before: cells it spilled into
        if (plan.cyclic.has(qualified)) {
          this.markCycle(located.key);
        } else {
          this.evalSingleCellByKey(located.key);
        }
        if (onActive) this.markValueChanged(located.key); // after: cells it spills into now
      });
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
    const qualified = this.qualify(cellKey);
    const deps = this.depGraph.getDependencies(qualified);
    const selfReference = deps.includes(qualified) || deps.includes(columnDependencyKey(`${this.document.id}!${col.key}`));
    const spilledKeys = this.depGraph.getSpilledKeys(qualified);
    const ownSpill = deps.find((dep) => spilledKeys.includes(dep));
    const errorMessage = selfReference
      ? "This formula can't reference its own cell."
      : ownSpill
        ? `This formula refers to ${ownSpill.slice(ownSpill.lastIndexOf('!') + 1)}, which holds its own spilled results (a circular reference).`
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
      this.depGraph.setSpillEdges(this.qualify(anchor), [], blockers.map((key) => this.qualify(key)));
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
        const display: CellData = {
          raw: '',
          value,
          format: column.format,
          spillAnchor: anchor,
          ...this.fixedNumberFormatFields(column, this.document.cells[rowObj.id]?.[column.id])
        };
        if (isFormulaError(value)) {
          display.error = value;
          display.errorMessage = describeFormulaError(value);
        }
        this.spillCells.set(spillCellId(rowObj.id, column.id), display);
        if (this.spilledBy.get(key) !== anchor) {
          this.spilledBy.set(key, anchor);
          this.spillChanges?.add(this.qualify(key));
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
    this.depGraph.setSpillEdges(this.qualify(anchor), cells.map((cell) => this.qualify(cell.key)));
    return null;
  }

  /** Removes the array spilled from `anchor`. With `keepEdges`, its dependency edges stay. */
  private clearSpill(anchor: string, keepEdges = false): void {
    const record = this.spills.get(anchor);
    if (record) {
      for (const cell of record.cells) this.forgetSpilledCell(anchor, cell);
      this.spills.delete(anchor);
    }
    if (!keepEdges) this.depGraph.setSpillEdges(this.qualify(anchor), []);
  }

  private forgetSpilledCell(anchor: string, cell: SpillRecord['cells'][number]): void {
    if (this.spilledBy.get(cell.key) !== anchor) return;
    this.spilledBy.delete(cell.key);
    this.spillCells.delete(spillCellId(cell.rowId, cell.colId));
    this.spillChanges?.add(this.qualify(cell.key));
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
    const override = this.valueOverride;
    if (override && override.row === rowNum - 1 && this.document.columns[override.col] === col) return override.value;

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

      const override = this.valueOverride && this.document.columns[this.valueOverride.col] === col ? this.valueOverride : null;
      for (let r = minR; r <= maxR; r++) {
        const row = this.document.rows[r - 1];
        if (!row) continue;
        if (override && override.row === r - 1) {
          results.push(override.value);
          continue;
        }
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

  /**
   * Commits the cell editor's draft (or `valueToCommit`). Input that breaks
   * the cell's data validation is not committed: the editor stays open and
   * `validationPrompt` holds the alert until `resolveValidationPrompt`.
   * Unchanged input is not validated.
   */
  public commitEditing(valueToCommit?: string): SpreadsheetCommitResult {
    if (!this.editingCell) return { status: 'none' };
    if (this.validationPrompt) return { status: 'pending', prompt: this.validationPrompt };
    const val = valueToCommit !== undefined ? valueToCommit : this.draftValue;
    const { rowId, colId, row, col } = this.editingCell;
    if (rowId && colId) {
      const failed = this.checkInput(rowId, colId, row, col, val, true);
      if (failed) return failed;
      this.setCellValue(rowId, colId, val);
    }
    this.editingCell = null;
    this.draftValue = '';
    return { status: 'committed' };
  }

  /**
   * Commits typed input to a cell (e.g. from the formula bar or a list
   * dropdown) with data validation, like `commitEditing` without an open
   * editor. `setCellValue` never validates (paste, import and code bypass
   * validation, as in Excel).
   */
  public commitCellInput(rowId: string, colId: string, raw: string): SpreadsheetCommitResult {
    if (this.validationPrompt) return { status: 'pending', prompt: this.validationPrompt };
    const row = this.document.rows.findIndex((r) => r.id === rowId);
    const col = this.document.columns.findIndex((c) => c.id === colId);
    if (row === -1 || col === -1) return { status: 'none' };
    const failed = this.checkInput(rowId, colId, row, col, raw, false);
    if (failed) return failed;
    this.setCellValue(rowId, colId, raw);
    return { status: 'committed' };
  }

  /** Validates input; when it fails, records and returns the prompt. */
  private checkInput(
    rowId: string,
    colId: string,
    row: number,
    col: number,
    raw: string,
    editing: boolean
  ): SpreadsheetCommitResult | null {
    if (!this.document.table?.dataValidations?.length) return null;
    if (this.getCell(rowId, colId).raw === raw) return null;
    const result = this.validateCellInput(row, col, raw);
    if (result.valid) return null;
    const prompt: SpreadsheetValidationPrompt = { rowId, colId, row, col, raw, result, editing };
    this.validationPrompt = prompt;
    return { status: result.errorStyle === 'stop' ? 'rejected' : 'confirm', prompt };
  }

  /**
   * Answers `validationPrompt`: `accept` keeps the input (warning and
   * information alerts only; for a stop alert it acts as `retry`), `retry`
   * returns to editing it, `cancel` discards it.
   */
  public resolveValidationPrompt(action: SpreadsheetValidationAction): void {
    const prompt = this.validationPrompt;
    if (!prompt) return;
    this.validationPrompt = null;
    const editingSameCell =
      prompt.editing && this.editingCell?.rowId === prompt.rowId && this.editingCell?.colId === prompt.colId;
    if (action === 'accept' && prompt.result.errorStyle !== 'stop') {
      this.setCellValue(prompt.rowId, prompt.colId, prompt.raw);
      if (editingSameCell) {
        this.editingCell = null;
        this.draftValue = '';
      }
    } else if (action === 'cancel') {
      if (editingSameCell) this.cancelEditing();
    } else if (editingSameCell) {
      this.draftValue = prompt.raw;
    } else {
      this.startEditing(prompt.row, prompt.col, prompt.raw);
    }
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
      ...(config?.numberFormat ? { numberFormat: config.numberFormat } : {}),
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
    // On every sheet: references to this sheet (unqualified ones on this
    // sheet, `ThisSheet!A1` anywhere) shift. 3-D references don't.
    const changed = this.ctx;
    for (const rt of this.runtimes) {
      const filter = this.referencesTo(changed, rt);
      for (const rowCells of Object.values(rt.doc.cells)) {
        for (const cell of Object.values(rowCells)) {
          if (cell.raw?.startsWith('=')) {
            cell.raw = shiftFormulaReferences(cell.raw, change, filter);
          }
        }
      }
      if (change.axis === 'col') {
        for (const col of rt.doc.columns) {
          if (col.formula?.startsWith('=')) {
            col.formula = shiftFormulaReferences(col.formula, change, filter);
          }
        }
      }
    }
    for (const n of this.names) {
      const scope = n.sheetId !== undefined ? this.findRuntimeById(n.sheetId) : undefined;
      n.refersTo = shiftFormulaReferences(n.refersTo, change, {
        appliesTo: (sheet, sheetEnd) =>
          sheetEnd === undefined && (sheet === undefined ? scope === changed : sameName(sheet, changed.doc.name))
      });
    }
  }

  /** Filter for references, in formulas on sheet `on`, that point at sheet `target`. */
  private referencesTo(target: SheetRuntime, on: SheetRuntime): FormulaReferenceFilter {
    return {
      appliesTo: (sheet, sheetEnd) =>
        sheetEnd === undefined && (sheet === undefined ? on === target : sameName(sheet, target.doc.name))
    };
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
    this.onTargetSheet(options.sheet, () => this.writeMatrix(matrix, options.startRow ?? 0, options.startCol ?? 0));
  }

  /** Runs `fn` on the sheet `sheet` (id or name), default the active one. Throws for an unknown sheet. */
  private onTargetSheet(sheet: string | undefined, fn: () => void): void {
    if (sheet === undefined) {
      fn();
      return;
    }
    const rt = this.findRuntime(sheet);
    if (!rt) throw new Error(`There is no sheet "${sheet}".`);
    this.withSheet(rt, fn);
  }

  /**
   * Writes already-parsed rows of raw inputs (e.g. from an import adapter)
   * starting at (startRow, startCol), as a single undo step.
   */
  public importRows(rows: string[][], options: Omit<CsvImportOptions, 'delimiter'> = {}): void {
    this.onTargetSheet(options.sheet, () => this.writeMatrix(rows, options.startRow ?? 0, options.startCol ?? 0));
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
    const moved = this.ctx;
    for (const rt of this.runtimes) {
      const filter = this.referencesTo(moved, rt);
      for (const rowCells of Object.values(rt.doc.cells)) {
        for (const cell of Object.values(rowCells)) {
          if (cell.raw?.startsWith('=')) {
            cell.raw = remapFormulaReferences(cell.raw, moveCell, filter);
          }
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
    this.adjustRulesForStructuralChange(change);
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

  // --- Number formats ---
  //
  // Cells are replaced, never mutated in place: framework bindings compare
  // cell objects by identity to decide what to re-render.

  /**
   * Sets an explicit number format code (e.g. `0.00`, `"$"#,##0.00`,
   * `m/d/yyyy`, `[Red]0;[Blue]-0`) on every cell in `range`, including blank
   * cells, so values typed later keep it. `null` removes explicit formats: the
   * cells go back to their column's format or the one chosen for typed input.
   * Undoable as one step. Returns false when there is no range.
   */
  public setCellNumberFormat(range: CellRange | null, code: string | null): boolean {
    if (!range) return false;
    const r = normalizeRange(range);
    this.recordSnapshot();
    const kind = code === null ? undefined : cellFormatForNumberFormat(code);
    for (let ri = r.startRow; ri <= r.endRow; ri++) {
      const row = this.document.rows[ri];
      if (!row) continue;
      for (let ci = r.startCol; ci <= r.endCol; ci++) {
        const col = this.document.columns[ci];
        if (!col) continue;
        const cells = (this.document.cells[row.id] ??= {});
        const existing = cells[col.id];
        if (code === null) {
          if (!existing?.explicitNumberFormat) continue;
          if (existing.raw === '' && existing.value === '' && !existing.error) {
            delete cells[col.id];
          } else {
            const { explicitNumberFormat: _explicit, ...rest } = existing;
            cells[col.id] = this.withNumberFormat(rest, this.implicitNumberFormat(rest, col, row));
          }
        } else {
          cells[col.id] = {
            ...(existing ?? { raw: '', value: '' }),
            format: kind ?? existing?.format ?? col.format,
            numberFormat: code,
            explicitNumberFormat: true
          };
        }
        this.refreshSpilledNumberFormat(row, col);
      }
    }
    this.document.updatedAt = Date.now();
    this.notifyChange();
    return true;
  }

  /**
   * Sets the number format code of a column (`null` or `General` clears it).
   * Its cells without an explicit format of their own use it, including
   * values typed later; when cleared they go back to the format chosen for
   * typed input. Undoable.
   */
  public setColumnNumberFormat(colId: string, code: string | null): void {
    const col = this.getColumn(colId);
    if (!col) return;
    this.recordSnapshot();
    if (code === null || isGeneralNumberFormat(code)) delete col.numberFormat;
    else col.numberFormat = code;
    for (const row of this.document.rows) {
      const cells = this.document.cells[row.id];
      const cell = cells?.[col.id];
      if (cells && cell && !cell.explicitNumberFormat) {
        cells[col.id] = this.withNumberFormat(cell, this.implicitNumberFormat(cell, col, row));
      }
      this.refreshSpilledNumberFormat(row, col);
    }
    this.document.updatedAt = Date.now();
    this.notifyChange();
  }

  /** The column's format, or the one typed input chose (typed cells only). */
  private implicitNumberFormat(cell: CellData, col: SpreadsheetColumn, row: SpreadsheetRow): string | undefined {
    const typed = cell.raw !== '' && !cell.raw.startsWith('=') && !(col.type === 'bound' && col.binding && row.recordId);
    return this.fixedNumberFormat(col, undefined) ?? (typed ? parseCellInput(cell.raw).numberFormat : undefined);
  }

  /** A copy of `cell` with `numberFormat` set, or removed when undefined. */
  private withNumberFormat(cell: CellData, numberFormat: string | undefined): CellData {
    const { numberFormat: _old, ...rest } = cell;
    return numberFormat === undefined ? rest : { ...rest, numberFormat };
  }

  /** Re-applies the stored cell's (or the column's) format to a spilled value shown there. */
  private refreshSpilledNumberFormat(row: SpreadsheetRow, col: SpreadsheetColumn): void {
    const id = spillCellId(row.id, col.id);
    const spilled = this.spillCells.get(id);
    if (!spilled) return;
    const { numberFormat: _old, explicitNumberFormat: _explicit, ...rest } = spilled;
    this.spillCells.set(id, { ...rest, ...this.fixedNumberFormatFields(col, this.document.cells[row.id]?.[col.id]) });
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

  // --- Sheets ---

  /** The sheets in tab order. */
  public getSheets(): SpreadsheetSheetInfo[] {
    return this.runtimes.map((rt, index) => ({ id: rt.doc.id, name: rt.doc.name, index, active: rt === this.active }));
  }

  /** Id of the active sheet (the one `document` is). */
  public get activeSheetId(): string {
    return this.active.doc.id;
  }

  /** A sheet's document by id or name (live: don't mutate it directly). */
  public getSheetDocument(idOrName: string): SpreadsheetDocument | undefined {
    return this.findRuntime(idOrName)?.doc;
  }

  /** Why `name` can't name a sheet (or null): see `validateSheetName`. `exceptSheet` is the sheet being renamed. */
  public validateSheetName(name: string, exceptSheet?: string): string | null {
    const except = exceptSheet === undefined ? undefined : this.findRuntime(exceptSheet);
    return validateSheetName(
      name,
      this.runtimes.filter((rt) => rt !== except).map((rt) => rt.doc.name)
    );
  }

  /**
   * Shows another sheet (by id or name). The current edit is committed and
   * each sheet keeps its own selection. Returns false for an unknown sheet.
   */
  public setActiveSheet(idOrName: string): boolean {
    const rt = this.findRuntime(idOrName);
    if (!rt) return false;
    if (rt === this.active) return true;
    if (this.editingCell) this.commitEditing();
    this.activateRuntime(rt);
    this.notifyChange();
    return true;
  }

  private activateRuntime(rt: SheetRuntime): void {
    if (rt === this.active) return;
    if (this.runtimes.includes(this.active)) {
      this.active.activeCell = this.activeCell;
      this.active.selectedRange = this.selectedRange;
    }
    this.active = this.ctx = rt;
    this.activeCell = rt.activeCell;
    this.selectedRange = rt.selectedRange;
    this.editingCell = null;
    this.draftValue = '';
    this.onSelectionChange?.(this.activeCell, this.selectedRange);
    this.onActiveSheetChange?.(rt.doc.id);
  }

  /**
   * Adds a sheet (default: `Sheet N`, empty, after the last sheet) and
   * activates it unless `activate` is false. Returns its id. Throws when
   * `name` is invalid or taken. Undoable.
   */
  public addSheet(
    options: { name?: string; index?: number; document?: Partial<SpreadsheetDocument>; activate?: boolean } = {}
  ): string {
    const existing = this.runtimes.map((rt) => rt.doc.name);
    const name = options.name ?? options.document?.name ?? nextSheetName(existing);
    const invalid = validateSheetName(name, existing);
    if (invalid) throw new Error(invalid);
    this.recordWorkbookSnapshot();
    const id = options.document?.id && !this.findRuntimeById(options.document.id) ? options.document.id : this.generateSheetId();
    const doc: SpreadsheetDocument = {
      columns: Array.from({ length: 4 }, (_, i) => ({
        id: `col_${String.fromCharCode(97 + i)}`,
        key: indexToColName(i),
        title: indexToColName(i),
        width: 120,
        type: 'freeform' as const
      })),
      rows: Array.from({ length: 10 }, (_, i) => ({ id: `row_${i + 1}`, index: i, height: 32, type: 'freeform' as const })),
      cells: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...JSON.parse(JSON.stringify(options.document ?? {})),
      id,
      name
    };
    const rt = createRuntime(doc);
    const index = Math.max(0, Math.min(options.index ?? this.runtimes.length, this.runtimes.length));
    this.runtimes.splice(index, 0, rt);
    this.withSheet(rt, () => {
      this.recomputeRowIndices();
      this.rederiveTypedValues();
    });
    if (options.activate !== false) this.activateRuntime(rt);
    // Formulas that referred to a sheet of this name (#REF!) now find it.
    this.recalculateAll();
    this.notifyChange();
    return id;
  }

  /**
   * Renames a sheet. Formulas on every sheet and defined names that refer to
   * it follow (`=Old!A1` becomes `='New Name'!A1`). Throws when the name is
   * invalid or taken. Undoable.
   */
  public renameSheet(idOrName: string, newName: string): void {
    const rt = this.findRuntime(idOrName);
    if (!rt) throw new Error(`There is no sheet "${idOrName}".`);
    if (rt.doc.name === newName) return;
    const invalid = this.validateSheetName(newName, rt.doc.id);
    if (invalid) throw new Error(invalid);
    this.recordWorkbookSnapshot();
    const oldName = rt.doc.name;
    this.rewriteAllFormulas((formula) => renameSheetInFormula(formula, oldName, newName));
    rt.doc.name = newName;
    rt.doc.updatedAt = Date.now();
    this.recalculateAll();
    this.notifyChange();
  }

  /** Moves a sheet to position `toIndex` in tab order. Returns false for an unknown sheet. Undoable. */
  public moveSheet(idOrName: string, toIndex: number): boolean {
    const rt = this.findRuntime(idOrName);
    if (!rt) return false;
    const from = this.runtimes.indexOf(rt);
    const to = Math.max(0, Math.min(Math.floor(toIndex), this.runtimes.length - 1));
    if (from === to) return true;
    this.recordWorkbookSnapshot();
    this.runtimes.splice(from, 1);
    this.runtimes.splice(to, 0, rt);
    // 3-D references (Sheet1:Sheet3!A1) cover the sheets between their ends.
    this.recalculateAll();
    this.notifyChange();
    return true;
  }

  /**
   * Deletes a sheet and its sheet-scoped names. References to it become
   * `#REF!` (a 3-D reference losing an end sheet shrinks). The last sheet
   * can't be deleted (returns false). Undoable.
   */
  public deleteSheet(idOrName: string): boolean {
    const rt = this.findRuntime(idOrName);
    if (!rt || this.runtimes.length <= 1) return false;
    this.recordWorkbookSnapshot();
    const order = this.runtimes.map((r) => r.doc.name);
    const index = this.runtimes.indexOf(rt);
    this.runtimes.splice(index, 1);
    this.names = this.names.filter((n) => n.sheetId !== rt.doc.id);
    this.rewriteAllFormulas((formula) => deleteSheetInFormula(formula, rt.doc.name, order));
    if (this.active === rt) {
      this.ctx = this.active;
      this.activateRuntime(this.runtimes[Math.min(index, this.runtimes.length - 1)]);
    } else if (this.ctx === rt) {
      this.ctx = this.active;
    }
    this.recalculateAll();
    this.notifyChange();
    return true;
  }

  /**
   * Copies a sheet (default name `Name (2)`, placed after it) with its
   * sheet-scoped names, which refer to the copy. Activates the copy unless
   * `activate` is false. Returns the new sheet's id, or null for an unknown
   * sheet. Undoable.
   */
  public duplicateSheet(idOrName: string, options: { name?: string; index?: number; activate?: boolean } = {}): string | null {
    const source = this.findRuntime(idOrName);
    if (!source) return null;
    const existing = this.runtimes.map((rt) => rt.doc.name);
    const name = options.name ?? copySheetName(source.doc.name, existing);
    const invalid = validateSheetName(name, existing);
    if (invalid) throw new Error(invalid);
    this.recordWorkbookSnapshot();
    const doc: SpreadsheetDocument = JSON.parse(JSON.stringify(source.doc));
    doc.id = this.generateSheetId();
    doc.name = name;
    doc.createdAt = doc.updatedAt = Date.now();
    const copies = this.names
      .filter((n) => n.sheetId === source.doc.id)
      .map((n) => ({ ...n, sheetId: doc.id, refersTo: renameSheetInFormula(n.refersTo, source.doc.name, name) }));
    this.names.push(...copies);
    const rt = createRuntime(doc);
    const index = Math.max(0, Math.min(options.index ?? this.runtimes.indexOf(source) + 1, this.runtimes.length));
    this.runtimes.splice(index, 0, rt);
    if (options.activate !== false) this.activateRuntime(rt);
    this.recalculateAll();
    this.notifyChange();
    return doc.id;
  }

  /** Applies `rewrite` to every formula: cells and column formulas on every sheet, and defined names. */
  private rewriteAllFormulas(rewrite: (formula: string) => string): void {
    for (const rt of this.runtimes) {
      for (const [rowId, rowCells] of Object.entries(rt.doc.cells)) {
        for (const [colId, cell] of Object.entries(rowCells)) {
          if (!cell.raw?.startsWith('=')) continue;
          const raw = rewrite(cell.raw);
          // Replace the cell object (bindings compare cells by identity).
          if (raw !== cell.raw) rt.doc.cells[rowId][colId] = { ...cell, raw };
        }
      }
      for (const col of rt.doc.columns) {
        if (col.formula?.startsWith('=')) col.formula = rewrite(col.formula);
      }
    }
    for (const n of this.names) n.refersTo = rewrite(n.refersTo);
  }

  private generateSheetId(): string {
    return `sheet_${Date.now()}_${(nextIdSequence++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  // --- Defined names (Name Manager) ---

  /** Every defined name, workbook-scoped and sheet-scoped. */
  public getNames(): SpreadsheetNameInfo[] {
    return this.names.map((n) => {
      const scope = n.sheetId !== undefined ? this.findRuntimeById(n.sheetId) : undefined;
      return {
        ...n,
        ...(scope ? { sheetName: scope.doc.name } : {}),
        isLambda: isLambdaDefinition(n)
      };
    });
  }

  /** The defined name `name` visible from the active sheet (its own sheet-scoped name first), or undefined. */
  public getName(name: string, scope?: SpreadsheetNameScope): SpreadsheetNameInfo | undefined {
    const rt = scope?.sheet !== undefined ? this.findRuntime(scope.sheet) : undefined;
    const def =
      scope?.sheet !== undefined
        ? rt
          ? this.names.find((n) => n.sheetId === rt.doc.id && sameName(n.name, name))
          : undefined
        : this.findName(name, this.active);
    return def ? this.getNames().find((n) => n.name === def.name && n.sheetId === def.sheetId) : undefined;
  }

  /** Why `name` can't be a defined name (or null): see `validateDefinedName`. */
  public validateDefinedName(name: string): string | null {
    return validateDefinedName(name);
  }

  private scopeRuntime(scope: SpreadsheetNameScope | undefined): SheetRuntime | undefined {
    if (scope?.sheet === undefined) return undefined;
    const rt = this.findRuntime(scope.sheet);
    if (!rt) throw new Error(`There is no sheet "${scope.sheet}".`);
    return rt;
  }

  /**
   * Defines (or redefines) a name in the workbook, or on one sheet with
   * `sheet`. `refersTo` is a formula: a range (`=Data!$A$2:$A$20`), a
   * constant (`=0.07`), a formula or a LAMBDA (`=LAMBDA(x, x*2)`, called as
   * `=Double(4)`). Formulas using the name recalculate. Throws when the name
   * is invalid or the formula can't be read. Undoable.
   */
  public defineName(name: string, refersTo: string, options: SpreadsheetNameScope & { comment?: string } = {}): void {
    const invalid = validateDefinedName(name);
    if (invalid) throw new Error(invalid);
    const formula = refersTo.trim().startsWith('=') ? refersTo.trim() : `=${refersTo.trim()}`;
    try {
      parseFormula(formula);
    } catch (err: any) {
      throw new Error(`There's a problem with this formula: ${err?.message ?? formula}`);
    }
    const rt = this.scopeRuntime(options);
    this.recordWorkbookSnapshot();
    const sheetId = rt?.doc.id;
    const index = this.names.findIndex((n) => n.sheetId === sheetId && sameName(n.name, name));
    const def: SpreadsheetDefinedName = {
      name,
      refersTo: formula,
      ...(sheetId !== undefined ? { sheetId } : {}),
      ...(options.comment ? { comment: options.comment } : {})
    };
    if (index >= 0) this.names[index] = def;
    else this.names.push(def);
    this.recalculateAll();
    this.notifyChange();
  }

  /**
   * Renames a defined name. Formulas that use it (cells, column formulas and
   * other names) follow, on the sheets where the old name meant this one.
   * Throws when the name doesn't exist or the new name is invalid or taken.
   * Undoable.
   */
  public renameName(oldName: string, newName: string, options: SpreadsheetNameScope = {}): void {
    const rt = this.scopeRuntime(options);
    const sheetId = rt?.doc.id;
    const def = this.names.find((n) => n.sheetId === sheetId && sameName(n.name, oldName));
    if (!def) throw new Error(`There is no name "${oldName}"${rt ? ` on sheet ${rt.doc.name}` : ''}.`);
    if (def.name === newName) return;
    const invalid = validateDefinedName(newName);
    if (invalid) throw new Error(invalid);
    if (!sameName(oldName, newName) && this.names.some((n) => n.sheetId === sheetId && sameName(n.name, newName))) {
      throw new Error('The name entered already exists. Enter a unique name.');
    }
    this.recordWorkbookSnapshot();
    // Sheets where the old name means this definition.
    const shadowedOn = new Set(this.names.filter((n) => n.sheetId !== undefined && sameName(n.name, oldName)).map((n) => n.sheetId));
    const appliesOn = (sheet: SheetRuntime | undefined) =>
      sheetId !== undefined ? sheet?.doc.id === sheetId : !sheet || !shadowedOn.has(sheet.doc.id);
    const appliesToSheetName = (sheetName: string) => appliesOn(this.findRuntimeByName(sheetName));
    for (const sheet of this.runtimes) {
      const options = { appliesTo: appliesToSheetName, qualifiedOnly: !appliesOn(sheet) };
      for (const [rowId, rowCells] of Object.entries(sheet.doc.cells)) {
        for (const [colId, cell] of Object.entries(rowCells)) {
          if (!cell.raw?.startsWith('=')) continue;
          const raw = renameNameInFormula(cell.raw, oldName, newName, options);
          if (raw !== cell.raw) sheet.doc.cells[rowId][colId] = { ...cell, raw };
        }
      }
      for (const col of sheet.doc.columns) {
        if (col.formula?.startsWith('=')) col.formula = renameNameInFormula(col.formula, oldName, newName, options);
      }
    }
    for (const n of this.names) {
      const scope = n.sheetId !== undefined ? this.findRuntimeById(n.sheetId) : undefined;
      n.refersTo = renameNameInFormula(n.refersTo, oldName, newName, {
        appliesTo: appliesToSheetName,
        qualifiedOnly: scope ? !appliesOn(scope) : sheetId !== undefined
      });
    }
    def.name = newName;
    this.recalculateAll();
    this.notifyChange();
  }

  /**
   * Deletes a defined name. Formulas still using it show `#NAME?`. Returns
   * false when there is no such name. Undoable.
   */
  public deleteName(name: string, options: SpreadsheetNameScope = {}): boolean {
    const rt = this.scopeRuntime(options);
    const sheetId = rt?.doc.id;
    const index = this.names.findIndex((n) => n.sheetId === sheetId && sameName(n.name, name));
    if (index < 0) return false;
    this.recordWorkbookSnapshot();
    this.names.splice(index, 1);
    this.recalculateAll();
    this.notifyChange();
    return true;
  }

  /**
   * Names formula autocomplete can offer on the active sheet: its
   * sheet-scoped names and the workbook names they don't hide.
   */
  public getNameSuggestions(): Array<{ name: string; description: string; isLambda: boolean }> {
    const visible = new Map<string, SpreadsheetDefinedName>();
    for (const n of this.names) {
      if (n.sheetId === this.active.doc.id) visible.set(n.name.toUpperCase(), n);
    }
    for (const n of this.names) {
      if (n.sheetId === undefined && !visible.has(n.name.toUpperCase())) visible.set(n.name.toUpperCase(), n);
    }
    return Array.from(visible.values(), (n) => ({
      name: n.name,
      description: n.comment ? `${n.comment} (${n.refersTo})` : n.refersTo,
      isLambda: isLambdaDefinition(n)
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Evaluates a formula (e.g. `=Rate*2`, `=SUM(Sales)`) as if it were in a
   * cell of `sheet` (id or name; default the active sheet), without storing
   * it. Used by the Name Manager to show a name's current value.
   */
  public evaluateFormula(formula: string, options: { sheet?: string } = {}): FormulaEvaluationResult {
    const rt = options.sheet === undefined ? this.active : this.findRuntime(options.sheet);
    if (!rt) return { value: '#REF!', error: '#REF!', message: `There is no sheet "${options.sheet}".` };
    const text = formula.startsWith('=') ? formula : `=${formula}`;
    return this.withSheet(rt, () => this.evaluator.evaluateWithDiagnostics(text));
  }

  // --- Undo/Redo Snapshots ---
  //
  // Most steps snapshot one sheet (the one changed); sheet and name
  // operations snapshot the whole workbook. Undoing a sheet's step shows
  // that sheet.

  private recordSnapshot(): void {
    if (this.isApplyingHistory || this.batching) return;
    this.pushUndo({ kind: 'sheet', sheetId: this.ctx.doc.id, data: JSON.stringify(this.ctx.doc) });
  }

  private recordWorkbookSnapshot(): void {
    if (this.isApplyingHistory || this.batching) return;
    this.pushUndo({ kind: 'workbook', data: JSON.stringify(this.workbookSnapshot()) });
  }

  private pushUndo(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.trimHistory();
  }

  /** Drops the oldest snapshots beyond `maxHistoryBytes`, always keeping the newest. */
  private trimHistory(): void {
    if (this.maxHistoryBytes <= 0 || this.undoStack.length <= 1) return;
    let total = this.getHistoryByteSize();
    while (total > this.maxHistoryBytes && this.undoStack.length > 1) {
      total -= this.undoStack.shift()!.data.length * 2;
    }
  }

  /** Approximate bytes held by the undo/redo snapshots (UTF-16 size). */
  public getHistoryByteSize(): number {
    let total = 0;
    for (const s of this.undoStack) total += s.data.length * 2;
    for (const s of this.redoStack) total += s.data.length * 2;
    return total;
  }

  /** Number of undo / redo snapshots currently held. */
  public getHistoryDepth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  public undo(): void {
    this.applyHistory(this.undoStack, this.redoStack);
  }

  public redo(): void {
    this.applyHistory(this.redoStack, this.undoStack);
  }

  /** Restores the newest entry of `from`, saving the current state of the same scope on `to`. */
  private applyHistory(from: HistoryEntry[], to: HistoryEntry[]): void {
    const entry = from.pop();
    if (!entry) return;
    this.isApplyingHistory = true;
    try {
      if (entry.kind === 'sheet') {
        const rt = this.findRuntimeById(entry.sheetId);
        if (!rt) return;
        to.push({ kind: 'sheet', sheetId: rt.doc.id, data: JSON.stringify(rt.doc) });
        rt.doc = JSON.parse(entry.data);
        if (rt !== this.active) {
          this.ctx = this.active;
          this.activateRuntime(rt);
        }
      } else {
        to.push({ kind: 'workbook', data: JSON.stringify(this.workbookSnapshot()) });
        const previousActive = this.active.doc.id;
        const selection = { activeCell: this.activeCell, selectedRange: this.selectedRange };
        const saved = new Map(this.runtimes.map((rt) => [rt.doc.id, rt]));
        this.setWorkbookState(JSON.parse(entry.data), false);
        // Sheets that survive keep their saved selections.
        for (const rt of this.runtimes) {
          const old = saved.get(rt.doc.id);
          if (old) {
            rt.activeCell = old.activeCell;
            rt.selectedRange = old.selectedRange;
          }
        }
        if (this.active.doc.id === previousActive) {
          this.activeCell = selection.activeCell;
          this.selectedRange = selection.selectedRange;
        } else {
          this.activeCell = this.active.activeCell;
          this.selectedRange = this.active.selectedRange;
          this.onSelectionChange?.(this.activeCell, this.selectedRange);
          this.onActiveSheetChange?.(this.active.doc.id);
        }
      }
      this.recalculateAll();
      this.notifyChange();
    } finally {
      this.isApplyingHistory = false;
    }
  }

  private notifyChange(): void {
    if (!this.cfIncremental) this.cfDirty = 'all';
    this.invalidCircles = null;
    this.onDocumentChange?.(this.active.doc);
    if (this.onWorkbookChange) {
      const snapshot = this.workbookSnapshot();
      this.onWorkbookChange({ sheets: snapshot.sheets, activeSheetId: snapshot.activeSheetId, names: snapshot.names });
    }
  }

  // --- Conditional formatting and data validation ---

  /** The sheet as rule evaluation sees it. */
  private ruleSheet(): ConditionalFormatSheet & DataValidationSheet {
    return {
      rowCount: this.document.rows.length,
      colCount: this.document.columns.length,
      getValue: (row, col) => this.getCellValueAt(row, col) ?? '',
      getInput: (row, col) => {
        const r = this.document.rows[row];
        const c = this.document.columns[col];
        return r && c ? this.getCell(r.id, c.id).raw : '';
      },
      evaluateFormula: (formula: string, row: number, col: number, entered?: { row: number; col: number; value: unknown }) =>
        this.evaluateFormulaAt(formula, row, col, entered)
    };
  }

  /**
   * Evaluates `formula` as if it were in (row, col), without storing it:
   * relative references and `[property]` resolve from that cell. With
   * `entered`, that cell reads as the given value (input being validated).
   * Returns the value, or an array's values (column-major) for a range.
   */
  public evaluateFormulaAt(
    formula: string,
    row: number,
    col: number,
    entered?: { row: number; col: number; value: unknown }
  ): unknown {
    const saved = { rowIndex: this.evaluatingRowIndex, cell: this.evaluatingCell, override: this.valueOverride };
    this.evaluatingRowIndex = row;
    this.evaluatingCell = { col: this.document.columns[col]?.key ?? indexToColName(col), row: row + 1 };
    this.valueOverride = entered ?? null;
    try {
      const result = this.evaluator.evaluateWithDiagnostics(formula.startsWith('=') ? formula : `=${formula}`);
      return result.array ? result.array.values : result.value;
    } finally {
      this.evaluatingRowIndex = saved.rowIndex;
      this.evaluatingCell = saved.cell;
      this.valueOverride = saved.override;
    }
  }

  /** Records that the value of `cellKey` (and of the array it spills) may have changed. */
  private markValueChanged(cellKey: string): void {
    if (this.cfDirty === 'all') return;
    this.cfDirty.add(cellKey);
    const spill = this.spills.get(cellKey);
    if (spill) for (const cell of spill.cells) this.cfDirty.add(cell.key);
  }

  private generateRuleId(prefix: 'cf' | 'dv'): string {
    return `${prefix}_${Date.now()}_${(nextIdSequence++).toString(36)}`;
  }

  /** Moves rule ranges and rule formulas with inserted / deleted rows and columns. */
  private adjustRulesForStructuralChange(change: StructuralChange): void {
    const table = this.document.table;
    if (!table) return;
    const shiftIfFormula = (text: string | undefined) =>
      text !== undefined && text.trimStart().startsWith('=') ? shiftRuleFormula(text, change) : text;
    const shiftAnchor = (value: ConditionalFormatValue): ConditionalFormatValue =>
      value.type === 'formula' ? { ...value, formula: shiftRuleFormula(value.formula, change) } : value;
    if (table.conditionalFormats?.length) {
      table.conditionalFormats = table.conditionalFormats
        .map((rule) => {
          const next = { ...rule, ranges: adjustRangesForStructuralChange(rule.ranges, change) } as ConditionalFormatRule;
          if (next.type === 'expression') next.formula = shiftRuleFormula(next.formula, change);
          if (next.type === 'cellIs') {
            next.value = shiftIfFormula(next.value) ?? '';
            if (next.value2 !== undefined) next.value2 = shiftIfFormula(next.value2);
          }
          if (next.type === 'colorScale') next.stops = next.stops.map((s) => ({ ...s, value: shiftAnchor(s.value) }));
          if (next.type === 'dataBar') {
            if (next.min) next.min = shiftAnchor(next.min);
            if (next.max) next.max = shiftAnchor(next.max);
          }
          if (next.type === 'iconSet' && next.thresholds) next.thresholds = next.thresholds.map(shiftAnchor);
          return next;
        })
        .filter((rule) => rule.ranges.length > 0);
    }
    if (table.dataValidations?.length) {
      table.dataValidations = table.dataValidations
        .map((rule) => {
          const next: DataValidationRule = { ...rule, ranges: adjustRangesForStructuralChange(rule.ranges, change) };
          if (rule.formula1 !== undefined) next.formula1 = shiftIfFormula(rule.formula1);
          if (rule.formula2 !== undefined) next.formula2 = shiftIfFormula(rule.formula2);
          return next;
        })
        .filter((rule) => rule.ranges.length > 0);
    }
  }

  /** Conditional formats of the sheet, highest priority first. */
  public getConditionalFormats(): ConditionalFormatRule[] {
    return this.document.table?.conditionalFormats ?? [];
  }

  /**
   * Adds a conditional format (one undo step). New rules get the highest
   * priority, as in Excel; pass `priority: 'last'` to add it below the
   * others. Returns the rule id.
   */
  public addConditionalFormat(rule: NewConditionalFormatRule, options: { priority?: 'first' | 'last' } = {}): string {
    const id = rule.id || this.generateRuleId('cf');
    const stored = { ...rule, id, ranges: rule.ranges.map((r) => normalizeRange(r)) } as ConditionalFormatRule;
    this.applyTableChange(() => {
      const rules = [...(this.table.conditionalFormats ?? [])];
      if (options.priority === 'last') rules.push(stored);
      else rules.unshift(stored);
      this.table.conditionalFormats = rules;
    });
    return id;
  }

  /** Changes a conditional format (its condition, ranges or stop-if-true). Returns false when not found. */
  public updateConditionalFormat(id: string, changes: Partial<NewConditionalFormatRule>): boolean {
    const rules = this.document.table?.conditionalFormats ?? [];
    const index = rules.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.applyTableChange(() => {
      const next = [...rules];
      const updated = { ...rules[index], ...changes, id } as ConditionalFormatRule;
      if (changes.ranges) updated.ranges = changes.ranges.map((r) => normalizeRange(r));
      next[index] = updated;
      this.table.conditionalFormats = next;
    });
    return true;
  }

  /** Removes a conditional format. Returns false when not found. */
  public deleteConditionalFormat(id: string): boolean {
    const rules = this.document.table?.conditionalFormats ?? [];
    if (!rules.some((r) => r.id === id)) return false;
    this.applyTableChange(() => {
      this.table.conditionalFormats = rules.filter((r) => r.id !== id);
    });
    return true;
  }

  /**
   * Moves a conditional format to priority `to` (0 = highest), or by
   * `{ by: -1 }` (up) / `{ by: 1 }` (down). Returns false when nothing moved.
   */
  public moveConditionalFormat(id: string, to: number | { by: number }): boolean {
    const rules = this.document.table?.conditionalFormats ?? [];
    const from = rules.findIndex((r) => r.id === id);
    if (from === -1) return false;
    const target = Math.max(0, Math.min(rules.length - 1, typeof to === 'number' ? to : from + to.by));
    if (target === from) return false;
    this.applyTableChange(() => {
      const next = [...rules];
      const [moved] = next.splice(from, 1);
      next.splice(target, 0, moved);
      this.table.conditionalFormats = next;
    });
    return true;
  }

  /**
   * Removes conditional formatting from the cells of `range` (rules keep
   * their other cells; rules left without cells are deleted), or every rule
   * when `range` is null.
   */
  public clearConditionalFormats(range: CellRange | null = null): void {
    const rules = this.document.table?.conditionalFormats ?? [];
    if (rules.length === 0) return;
    this.applyTableChange(() => {
      this.table.conditionalFormats = range
        ? rules
            .map((rule) => ({ ...rule, ranges: subtractRangeFromRanges(rule.ranges, range) }) as ConditionalFormatRule)
            .filter((rule) => rule.ranges.length > 0)
        : [];
    });
  }

  /**
   * The conditional look of every formatted cell. Evaluated on demand and
   * cached: after a cell edit only the affected cells are re-evaluated.
   */
  public getConditionalFormatOverlay(): ConditionalFormatOverlay {
    const rules = this.document.table?.conditionalFormats ?? [];
    if (rules.length === 0) {
      this.cfEngine = null;
      this.cfDirty = 'all';
      return EMPTY_CONDITIONAL_FORMAT_OVERLAY;
    }
    const sheet = this.ruleSheet();
    if (!this.cfEngine || this.cfDirty === 'all') {
      this.cfEngine = new ConditionalFormatEngine(sheet);
      this.cfEngine.evaluate(rules);
    } else if (this.cfDirty.size > 0) {
      const changed: Array<{ row: number; col: number }> = [];
      for (const key of this.cfDirty) {
        const located = this.locateCellKey(key);
        if (located) changed.push({ row: located.row.index, col: this.document.columns.indexOf(located.col) });
      }
      this.cfEngine.setSheet(sheet);
      this.cfEngine.update(rules, changed);
    }
    this.cfDirty = new Set();
    return this.cfEngine.overlay;
  }

  /** The conditional look of (row, col), if any. */
  public getConditionalFormat(row: number, col: number): ConditionalCellFormat | undefined {
    return this.getConditionalFormatOverlay().get(row, col);
  }

  /** Data validation rules of the sheet. */
  public getDataValidations(): DataValidationRule[] {
    return this.document.table?.dataValidations ?? [];
  }

  /** The rule that applies to (row, col), if any. */
  public getDataValidationAt(row: number, col: number): DataValidationRule | undefined {
    return findDataValidation(this.document.table?.dataValidations, row, col);
  }

  /**
   * Adds a data validation rule (one undo step). Its cells are first
   * removed from other rules, so each cell has at most one. Returns the id.
   */
  public addDataValidation(rule: NewDataValidationRule): string {
    const id = rule.id || this.generateRuleId('dv');
    const ranges = rule.ranges.map((r) => normalizeRange(r));
    this.applyTableChange(() => {
      let rules = this.table.dataValidations ?? [];
      for (const cut of ranges) {
        rules = rules
          .map((r) => ({ ...r, ranges: subtractRangeFromRanges(r.ranges, cut) }))
          .filter((r) => r.ranges.length > 0);
      }
      this.table.dataValidations = [...rules, { ...rule, id, ranges }];
    });
    return id;
  }

  /** Changes a data validation rule. Returns false when not found. */
  public updateDataValidation(id: string, changes: Partial<NewDataValidationRule>): boolean {
    const rules = this.document.table?.dataValidations ?? [];
    const index = rules.findIndex((r) => r.id === id);
    if (index === -1) return false;
    this.applyTableChange(() => {
      const next = [...rules];
      const updated: DataValidationRule = { ...rules[index], ...changes, id };
      if (changes.ranges) updated.ranges = changes.ranges.map((r) => normalizeRange(r));
      next[index] = updated;
      this.table.dataValidations = next;
    });
    return true;
  }

  /** Removes a data validation rule. Returns false when not found. */
  public deleteDataValidation(id: string): boolean {
    const rules = this.document.table?.dataValidations ?? [];
    if (!rules.some((r) => r.id === id)) return false;
    this.applyTableChange(() => {
      this.table.dataValidations = rules.filter((r) => r.id !== id);
    });
    return true;
  }

  /** Removes validation from the cells of `range`, or every rule when `range` is null. */
  public clearDataValidation(range: CellRange | null = null): void {
    const rules = this.document.table?.dataValidations ?? [];
    if (rules.length === 0) return;
    this.applyTableChange(() => {
      this.table.dataValidations = range
        ? rules.map((r) => ({ ...r, ranges: subtractRangeFromRanges(r.ranges, range) })).filter((r) => r.ranges.length > 0)
        : [];
    });
  }

  /** Checks input for (row, col) against its data validation, without committing it. */
  public validateCellInput(row: number, col: number, raw: string): DataValidationResult {
    return validateCellInput(this.ruleSheet(), this.document.table?.dataValidations, row, col, raw);
  }

  /**
   * Dropdown items of a list-validated cell, or null when the cell has no
   * list rule (or its in-cell dropdown is off).
   */
  public getValidationListValues(row: number, col: number): string[] | null {
    const rule = this.getDataValidationAt(row, col);
    if (!rule || rule.type !== 'list' || rule.inCellDropdown === false) return null;
    return getValidationListValues(this.ruleSheet(), rule);
  }

  /** Cells whose current value breaks their validation rule. */
  public findInvalidCells(): CellPosition[] {
    return findInvalidCells(this.ruleSheet(), this.document.table?.dataValidations);
  }

  /**
   * Turns "circle invalid data" on or off. View state, not part of the
   * document (not undoable, not saved); listeners are notified so the grid
   * redraws.
   */
  public setInvalidDataCircles(show: boolean): void {
    if (this.circlesShown === show) return;
    this.circlesShown = show;
    this.invalidCircles = null;
    this.onDocumentChange?.(this.document);
  }

  /** Whether invalid cells are circled. */
  public getInvalidDataCircles(): boolean {
    return this.circlesShown;
  }

  /** Whether (row, col) is circled as invalid (always false while circles are off). */
  public isInvalidDataCircled(row: number, col: number): boolean {
    if (!this.circlesShown) return false;
    if (!this.invalidCircles) {
      this.invalidCircles = new Set(this.findInvalidCells().map((c) => `${c.row}:${c.col}`));
    }
    return this.invalidCircles.has(`${row}:${col}`);
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
