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
}

export type RowType = 'record' | 'freeform';

export interface SpreadsheetRow {
  id: string;
  index: number;
  height?: number; // default 32
  recordId?: string; // ID of bound record (e.g. taskId)
  type: RowType;
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
  format?: CellFormat;
  readOnly?: boolean;
}

export interface SpreadsheetDocument {
  id: string;
  name: string;
  columns: SpreadsheetColumn[];
  rows: SpreadsheetRow[];
  cells: Record<string, Record<string, CellData>>; // cells[rowId][colId]
  createdAt?: number;
  updatedAt?: number;
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
