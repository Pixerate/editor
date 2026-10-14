/**
 * Data validation rule model.
 *
 * Portions ported from gridcraft/crates/model/src/features.rs (MIT OR
 * Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
 */
import type { CellRange } from '../types';

/** What a validated cell may hold. `any` only shows the input message. */
export type DataValidationType = 'any' | 'whole' | 'decimal' | 'list' | 'date' | 'time' | 'textLength' | 'custom';

export type DataValidationOperator =
  | 'between'
  | 'notBetween'
  | 'equal'
  | 'notEqual'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual';

/**
 * How invalid input is handled: `stop` rejects it; `warning` asks whether to
 * keep it (Yes keeps, No returns to editing, Cancel discards); `information`
 * tells and keeps it unless cancelled.
 */
export type DataValidationErrorStyle = 'stop' | 'warning' | 'information';

export interface DataValidationRule {
  id: string;
  /** Cells the rule applies to (0-based, on the sheet that stores the rule). */
  ranges: CellRange[];
  type: DataValidationType;
  /** For whole, decimal, date, time and text length (default `between`). */
  operator?: DataValidationOperator;
  /**
   * First value: a number, date (`2026-01-31`, `1/31/2026`), time (`9:00`)
   * or a formula (`=B1`, relative to the range's top-left cell). For `list`,
   * comma-separated items (`Low,Medium,High`) or a range / formula
   * (`=$H$1:$H$5`). For `custom`, a formula that must be TRUE; it sees the
   * value being entered.
   */
  formula1?: string;
  /** Second value, for `between` / `notBetween`. */
  formula2?: string;
  /** Blank input is always valid (default true). */
  ignoreBlank?: boolean;
  /** Show a dropdown arrow on list cells (default true). */
  inCellDropdown?: boolean;
  inputTitle?: string;
  /** Shown while a cell of the rule is selected. */
  inputMessage?: string;
  /** Default true. */
  showInputMessage?: boolean;
  errorTitle?: string;
  errorMessage?: string;
  /** Default `stop`. */
  errorStyle?: DataValidationErrorStyle;
  /** When false, any input is accepted (the rule still drives dropdowns and circles). Default true. */
  showErrorAlert?: boolean;
}

/** A rule to add: the id is generated when left out. */
export type NewDataValidationRule = Omit<DataValidationRule, 'id'> & { id?: string };

/** The outcome of checking input against a cell's validation. */
export interface DataValidationResult {
  valid: boolean;
  /** The rule that applied, if any. */
  rule?: DataValidationRule;
  /** For invalid input: how to alert. */
  errorStyle?: DataValidationErrorStyle;
  /** Alert title and message (defaults filled in). */
  title?: string;
  message?: string;
}

/** What validation needs to know about a sheet. Rows and columns are 0-based. */
export interface DataValidationSheet {
  rowCount: number;
  colCount: number;
  getValue(row: number, col: number): unknown;
  /** Typed input of a cell (`raw`), used by `findInvalidCells`. Formulas are checked through their value. */
  getInput?(row: number, col: number): string;
  /**
   * Evaluates a formula (with a leading `=`) as if it were in (row, col).
   * `entered`, when given, is the value being typed into that cell: the
   * formula must see it instead of the cell's current value.
   */
  evaluateFormula?(formula: string, row: number, col: number, entered?: { row: number; col: number; value: unknown }): unknown;
}
