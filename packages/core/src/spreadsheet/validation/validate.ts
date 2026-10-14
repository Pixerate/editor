/**
 * Data validation: checks typed input against a cell's rule, lists dropdown
 * items and finds invalid cells ("circle invalid data").
 *
 * Portions ported from gridcraft/crates/engine/src/cmd/data.rs (MIT OR
 * Apache-2.0, © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
 */
import { compareValues, numberToText, parseCellInput } from '../formula';
import { isFormulaError, toBoolean } from '../formula/values';
import { conditionalFormatNumber } from '../conditional-format/evaluate';
import { forEachRangeCell, rangesContain, ruleAnchor, ruleFormulaAt } from '../rule-ranges';
import type { CellPosition } from '../formula';
import type {
  DataValidationOperator,
  DataValidationResult,
  DataValidationRule,
  DataValidationSheet,
} from './types';

/** Excel's message when a rule has no error message of its own. */
export const DEFAULT_DATA_VALIDATION_MESSAGE =
  "This value doesn't match the data validation restrictions defined for this cell.";
export const DEFAULT_DATA_VALIDATION_TITLE = 'Invalid value';

// A bare reference (`H1:H5`, `$H$1:$H$5`) used as a list source without `=`.
const BARE_REFERENCE = /^\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/;

const isBlank = (v: unknown) => v === '' || v === null || v === undefined;

function valueText(value: unknown): string {
  if (isBlank(value)) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return numberToText(value);
  return String(value);
}

/** The rule that applies to (row, col): the first one containing it. */
export function findDataValidation(rules: DataValidationRule[] | undefined, row: number, col: number): DataValidationRule | undefined {
  if (!rules) return undefined;
  for (const rule of rules) if (rangesContain(rule.ranges, row, col)) return rule;
  return undefined;
}

type Entered = { row: number; col: number; value: unknown };

function evaluate(sheet: DataValidationSheet, rule: DataValidationRule, formula: string, row: number, col: number, entered?: Entered): unknown {
  if (!sheet.evaluateFormula) return '#NAME?';
  try {
    return sheet.evaluateFormula(ruleFormulaAt(formula, ruleAnchor(rule.ranges), row, col), row, col, entered);
  } catch {
    return '#ERROR!';
  }
}

const first = (v: unknown) => (Array.isArray(v) ? (v.length ? v[0] : '') : v);

/**
 * The items of a list rule: literal (`Low, Medium, High`, optionally in
 * quotes) or read from a range or formula (`=$H$1:$H$5`), blanks skipped.
 * Formulas are evaluated at the range's top-left cell.
 */
export function getValidationListValues(sheet: DataValidationSheet, rule: DataValidationRule): string[] {
  const f = (rule.formula1 ?? '').trim();
  if (f === '') return [];
  if (f.startsWith('=') || BARE_REFERENCE.test(f)) {
    const anchor = ruleAnchor(rule.ranges);
    const result = evaluate(sheet, rule, f, anchor.row, anchor.col);
    const values = Array.isArray(result) ? result : [result];
    const out: string[] = [];
    for (const v of values) if (!isBlank(v) && !isFormulaError(v)) out.push(valueText(v));
    return out;
  }
  const unquoted = f.length >= 2 && f.startsWith('"') && f.endsWith('"') ? f.slice(1, -1) : f;
  return unquoted
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

function compareOp(op: DataValidationOperator, n: number, a: number | null, b: number | null): boolean {
  if (a === null) return false;
  switch (op) {
    case 'between':
      return b !== null && n >= Math.min(a, b) && n <= Math.max(a, b);
    case 'notBetween':
      return b !== null && (n < Math.min(a, b) || n > Math.max(a, b));
    case 'equal':
      return n === a;
    case 'notEqual':
      return n !== a;
    case 'greaterThan':
      return n > a;
    case 'lessThan':
      return n < a;
    case 'greaterThanOrEqual':
      return n >= a;
    case 'lessThanOrEqual':
      return n <= a;
  }
}

/** A bound (`formula1` / `formula2`): a formula, or typed input such as `10`, `1/31/2026`, `9:00`. */
function bound(sheet: DataValidationSheet, rule: DataValidationRule, text: string | undefined, row: number, col: number, entered?: Entered): number | null {
  if (text === undefined || text.trim() === '') return null;
  const value = text.trim().startsWith('=') ? first(evaluate(sheet, rule, text, row, col, entered)) : parseCellInput(text.trim()).value;
  return conditionalFormatNumber(value);
}

/** Whether `value` (typed as `text`) satisfies `rule` at (row, col). */
function satisfies(
  sheet: DataValidationSheet,
  rule: DataValidationRule,
  row: number,
  col: number,
  value: unknown,
  text: string,
  entered?: Entered
): boolean {
  const op = rule.operator ?? 'between';
  switch (rule.type) {
    case 'any':
      return true;
    case 'list': {
      const typed = text.trim().toLowerCase();
      return getValidationListValues(sheet, rule).some(
        (item) => item.toLowerCase() === typed || compareValues(parseCellInput(item).value, value) === 0
      );
    }
    case 'custom':
      return toBoolean(first(evaluate(sheet, rule, rule.formula1 ?? '', row, col, entered))) === true;
    case 'textLength':
      return compareOp(op, Array.from(text).length, bound(sheet, rule, rule.formula1, row, col, entered), bound(sheet, rule, rule.formula2, row, col, entered));
    case 'whole':
    case 'decimal':
    case 'date':
    case 'time': {
      if (isFormulaError(value)) return false;
      let n = conditionalFormatNumber(value);
      if (n === null) return false;
      if (rule.type === 'whole' && !Number.isInteger(n)) return false;
      // A date-time typed into a time rule counts by its time of day.
      if (rule.type === 'time' && typeof value === 'string') n -= Math.floor(n);
      return compareOp(op, n, bound(sheet, rule, rule.formula1, row, col, entered), bound(sheet, rule, rule.formula2, row, col, entered));
    }
  }
}

function invalid(rule: DataValidationRule): DataValidationResult {
  return {
    valid: false,
    rule,
    errorStyle: rule.errorStyle ?? 'stop',
    title: rule.errorTitle || DEFAULT_DATA_VALIDATION_TITLE,
    message: rule.errorMessage || DEFAULT_DATA_VALIDATION_MESSAGE,
  };
}

/**
 * Checks `input` typed into (row, col) against the cell's rule. Typed input
 * is parsed like a cell commit (`10%` is 0.1, `3/4/2026` a date); a formula
 * is checked through its result. Custom and bound formulas are relative to
 * the range's top-left cell and see the value being entered. Blank input is
 * valid unless `ignoreBlank` is false; rules with `showErrorAlert: false`
 * accept anything.
 */
export function validateCellInput(
  sheet: DataValidationSheet,
  rules: DataValidationRule[] | undefined,
  row: number,
  col: number,
  input: string
): DataValidationResult {
  const rule = findDataValidation(rules, row, col);
  if (!rule) return { valid: true };
  if (rule.type === 'any' || rule.showErrorAlert === false) return { valid: true, rule };
  if (input.trim() === '' && (rule.ignoreBlank ?? true)) return { valid: true, rule };
  let value: unknown;
  let text = input;
  if (input.startsWith('=')) {
    value = first(sheet.evaluateFormula ? safeEval(sheet, input, row, col) : '#NAME?');
    text = valueText(value);
  } else {
    value = parseCellInput(input).value;
    if (input.startsWith("'")) text = input.slice(1);
  }
  const entered = { row, col, value };
  return satisfies(sheet, rule, row, col, value, text, entered) ? { valid: true, rule } : invalid(rule);
}

function safeEval(sheet: DataValidationSheet, formula: string, row: number, col: number): unknown {
  try {
    return sheet.evaluateFormula!(formula, row, col);
  } catch {
    return '#ERROR!';
  }
}

/**
 * Cells whose current value breaks their rule ("circle invalid data").
 * Blank cells are skipped, as are `any` rules. Alerts being off does not
 * matter here. Each cell is listed once, rule by rule, in row-major order.
 */
export function findInvalidCells(sheet: DataValidationSheet, rules: DataValidationRule[] | undefined): CellPosition[] {
  const out: CellPosition[] = [];
  if (!rules?.length) return out;
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.type === 'any') continue;
    forEachRangeCell(rule.ranges, sheet.rowCount, sheet.colCount, (row, col) => {
      const key = `${row}:${col}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Only the first rule containing a cell applies to it.
      if (findDataValidation(rules, row, col) !== rule) return;
      const value = sheet.getValue(row, col);
      if (isBlank(value)) return;
      const raw = sheet.getInput?.(row, col);
      const text = raw !== undefined && raw !== '' && !raw.startsWith('=') ? (raw.startsWith("'") ? raw.slice(1) : raw) : valueText(value);
      if (!satisfies(sheet, rule, row, col, value, text)) out.push({ row, col });
    });
  }
  return out;
}
