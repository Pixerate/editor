import type { CellData } from '../types';
import { formatTextFunction, NumberFormat, type FormattedNumberValue } from '../numfmt';
import { isGeneralNumberFormat, numberFormatForCellFormat } from '../numfmt/presets';
import { isBlank, toText } from './values';

type DisplayCell = Pick<CellData, 'value' | 'error' | 'numberFormat' | 'format'>;

/**
 * How a cell is shown: its error, or its value formatted with its number
 * format code (`numberFormat`: set explicitly, inherited from the column, or
 * chosen for typed input, e.g. `"$"#,##0.00` for `$1,200.50`). Numbers in a
 * cell with a `currency` / `percentage` / `date` `CellFormat` but no code use
 * that kind's code. Without a code (General), numbers use up to 15
 * significant digits and booleans show as TRUE/FALSE.
 *
 * `numeric` is true for numbers (and dates shown through a date format):
 * grids right-align those. `color` comes from a `[Red]` / `[ColorN]` tag.
 */
export function formatCellForDisplay(cell: DisplayCell | null | undefined): FormattedNumberValue {
  if (!cell) return { text: '', numeric: false };
  if (cell.error) return { text: cell.error, numeric: false };
  const { value } = cell;
  const code = cell.numberFormat ?? (typeof value === 'number' ? numberFormatForCellFormat(cell.format) : undefined);
  if (code !== undefined && !isGeneralNumberFormat(code) && !isBlank(value) && typeof value !== 'boolean') {
    return NumberFormat.parseCached(code).format(value);
  }
  return { text: toText(value), numeric: typeof value === 'number' };
}

/** The text a cell shows (see `formatCellForDisplay`). Used by grids, CSV export and the clipboard. */
export function formatCellDisplay(cell: DisplayCell | null | undefined): string {
  return formatCellForDisplay(cell).text;
}

/**
 * Formats a value with a number format code, as `TEXT()` does (see
 * `formatTextFunction`). Null when the value can't be shown with that code
 * (a date out of range, a code over 255 characters, an error value).
 */
export function formatValueWithCode(value: unknown, format: string): string | null {
  const result = formatTextFunction(value, format);
  return 'text' in result ? result.text : null;
}
