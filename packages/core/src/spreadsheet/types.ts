import type { ConditionalFormatRule } from './conditional-format/types';
import type { DataValidationRule } from './validation/types';

export type CellFormat =
  | 'text'
  | 'number'
  | 'currency'
  | 'percentage'
  | 'date'
  | 'badge'
  | 'status'
  | 'assignee';

export type ColumnType = 'bound' | 'freeform' | 'formula';

export interface ColumnBinding {
  dataSource: string; // e.g. "tasks"
  field: string;      // e.g. "status", "title", "priority", "assignee"
}

export interface SpreadsheetColumn {
  id: string;
  key: string; // "A", "B", "C", etc.
  title: string;
  width?: number; // default 150
  type: ColumnType;
  binding?: ColumnBinding;
  formula?: string; // column-level template/formula applied across rows
  format?: CellFormat;
  /**
   * Number format code for the column's cells (e.g. `#,##0.00`,
   * `"$"#,##0.00;[Red]("$"#,##0.00)`, `m/d/yyyy`). Cells without an explicit
   * code of their own use it instead of the automatic one chosen for typed
   * input. See `SpreadsheetController.setColumnNumberFormat`.
   */
  numberFormat?: string;
  readOnly?: boolean;
  hidden?: boolean; // hidden by the user (hide/unhide columns)
}

export type RowType = 'record' | 'freeform';

export interface SpreadsheetRow {
  id: string;
  index: number;
  height?: number; // default 32
  recordId?: string; // ID of bound record (e.g. taskId)
  type: RowType;
  hidden?: boolean; // hidden by the user (hide/unhide rows); filters do not set this
}

export interface CellCoordinate {
  row: number; // 0-indexed row index
  col: number; // 0-indexed column index
  rowId?: string;
  colId?: string;
}

export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface CellData {
  raw: string; // Raw input (e.g., "120", "=SUM(A1:A5)", "In Progress")
  /**
   * Evaluated value. Typed (non-formula) input is parsed: `"120"` → 120,
   * `"TRUE"` → true, `"3/4/2026"` → `"2026-03-04"` (dates are ISO text),
   * `"10:30"` → 0.4375 (a time alone is a fraction of a day); `'120` forces
   * the text `"120"`. Formulas store their result.
   */
  value: any;
  error?: string; // Error string (e.g., "#VALUE!", "#CYCLE!", "#REF!")
  /** Why the formula failed, e.g. `Argument 2 of SUMIF must be a range.` Set alongside `error`. */
  errorMessage?: string;
  format?: CellFormat;
  /**
   * Excel number format code used to display the value (see
   * `formatCellDisplay`). Set explicitly (`explicitNumberFormat`), inherited
   * from the column's `numberFormat`, or chosen automatically for typed input,
   * e.g. `"$"#,##0.00` for `$1,200.50`, `0%` for `10%`, `#,##0` for `1,234`,
   * `m/d/yyyy` for `3/4/2026`, `h:mm` for `10:30`. Absent for General.
   */
  numberFormat?: string;
  /**
   * True when `numberFormat` was set explicitly (`setCellNumberFormat`):
   * typing into the cell keeps it instead of choosing an automatic format.
   */
  explicitNumberFormat?: boolean;
  readOnly?: boolean;
  /**
   * Set (only) on cells showing a value spilled from a dynamic array: the
   * anchor cell holding the formula, e.g. `A1`. Spilled cells keep an empty
   * `raw` and are never stored in the document.
   */
  spillAnchor?: string;
}

/** A dynamic array spilled from its anchor cell (the cell holding the formula). */
export interface SpreadsheetSpill {
  /** Anchor cell key, e.g. `A1`. */
  key: string;
  anchor: { row: number; col: number };
  /** Every cell the array covers, anchor included. */
  range: CellRange;
  /** The anchor's formula. */
  formula: string;
}

export interface SpreadsheetDocument {
  id: string;
  name: string;
  columns: SpreadsheetColumn[];
  rows: SpreadsheetRow[];
  cells: Record<string, Record<string, CellData>>; // cells[rowId][colId]
  createdAt?: number;
  updatedAt?: number;
  table?: SpreadsheetTableSettings; // sort/filter/freeze/merge/grouping state
}

// --- Table operations (sort, filters, freeze, merges, categories) ---

export type SortDirection = 'asc' | 'desc';

export interface SortKey {
  colId: string;
  direction?: SortDirection; // default 'asc'
}

export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'between'
  | 'isBlank'
  | 'isNotBlank'
  | 'oneOf';

export interface FilterRule {
  id: string;
  colId: string;
  operator: FilterOperator;
  value?: string | number; // equals/contains/comparisons; lower bound of `between`
  value2?: string | number; // upper bound of `between`
  values?: string[]; // `oneOf`
}

export interface SpreadsheetFilterState {
  enabled: boolean;
  rules: FilterRule[]; // combined with AND
}

export type GroupAggregate = 'sum' | 'count' | 'average' | 'min' | 'max';

export interface GroupSummary {
  colId: string;
  aggregate: GroupAggregate;
}

export interface SpreadsheetGrouping {
  colId: string; // rows are grouped by this column's value
  summaries: GroupSummary[];
  collapsed: string[]; // keys of collapsed groups
}

export interface SpreadsheetTableSettings {
  headerRowCount?: number; // header rows: never sorted, filtered or grouped
  footerRowCount?: number; // footer rows at the bottom: never sorted, filtered or grouped
  headerColumnCount?: number;
  frozenRowCount?: number; // rows kept visible while scrolling (sticky)
  frozenColumnCount?: number; // columns kept visible while scrolling (sticky)
  merges?: CellRange[]; // normalized (start <= end), non-overlapping
  filter?: SpreadsheetFilterState;
  grouping?: SpreadsheetGrouping;
  /**
   * Conditional formats of this sheet, highest priority first. Kept with the
   * other per-sheet table state (undoable through document snapshots).
   */
  conditionalFormats?: ConditionalFormatRule[];
  /** Data validation rules of this sheet; a cell uses the first rule containing it. */
  dataValidations?: DataValidationRule[];
}

export interface SpreadsheetDataSourceField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'enum';
  options?: Array<{ key: string; label: string; color?: string }>;
}

export interface SpreadsheetDataSource {
  id: string;
  name: string;
  getRecords(): Array<{ id: string; [key: string]: any }>;
  getFields(): SpreadsheetDataSourceField[];
  updateRecord(recordId: string, field: string, value: any): Promise<void> | void;
}

// --- Workbooks: sheets and defined names ---

/**
 * A defined name (Formulas › Name Manager): a range, constant, formula or
 * LAMBDA that formulas can use by name, e.g. `=Price*(1+Rate)`,
 * `=SUM(Sales)`, `=Double(4)`.
 */
export interface SpreadsheetDefinedName {
  /** The name, e.g. `Rate`. Unique per scope, compared case-insensitively. */
  name: string;
  /**
   * What the name refers to, as a formula: `=Data!$A$2:$A$20`, `=0.07`,
   * `=Rate*2` or `=LAMBDA(x, x*2)`. Unqualified references refer to the
   * name's sheet (sheet scope) or to the sheet of the formula using it.
   */
  refersTo: string;
  /** Id of the sheet for a sheet-scoped name; unset for workbook scope. */
  sheetId?: string;
  comment?: string;
}

/**
 * A workbook: several sheets plus defined names. A `SpreadsheetController`
 * created from a single document is a workbook with one sheet.
 */
export interface SpreadsheetWorkbook {
  /** The sheets in tab order. A sheet's `name` is its tab name (unique, case-insensitively). */
  sheets: SpreadsheetDocument[];
  /** Id of the sheet shown (default: the first). */
  activeSheetId?: string;
  names?: SpreadsheetDefinedName[];
}

/** A sheet tab: what sheet-tab bars render. */
export interface SpreadsheetSheetInfo {
  id: string;
  name: string;
  /** Position in tab order (0-based). */
  index: number;
  active: boolean;
}
