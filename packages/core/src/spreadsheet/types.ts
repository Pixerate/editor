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
  value: any;  // Evaluated computed value
  error?: string; // Error string (e.g., "#VALUE!", "#CYCLE!", "#REF!")
  /** Why the formula failed, e.g. `Argument 2 of SUMIF must be a range.` Set alongside `error`. */
  errorMessage?: string;
  format?: CellFormat;
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
