/**
 * Common number formats offered by the "Format cells" menu, and the mapping
 * between format codes and the coarser `CellFormat` kinds.
 */
import type { CellFormat } from '../types';
import { NumberFormat } from './index';

export interface NumberFormatPreset {
  id: 'general' | 'number' | 'currency' | 'percent' | 'date' | 'time';
  label: string;
  code: string;
}

/** Presets of the "Format cells" menu (en-US). */
export const NUMBER_FORMAT_PRESETS: readonly NumberFormatPreset[] = [
  { id: 'general', label: 'General', code: 'General' },
  { id: 'number', label: 'Number (0.00)', code: '0.00' },
  { id: 'currency', label: 'Currency ($1,234.50)', code: '"$"#,##0.00' },
  { id: 'percent', label: 'Percent (12.5%)', code: '0.0%' },
  { id: 'date', label: 'Date (3/14/2026)', code: 'm/d/yyyy' },
  { id: 'time', label: 'Time (1:30 PM)', code: 'h:mm AM/PM' },
];

/**
 * Format code for a `CellFormat` kind, used to display numbers in cells that
 * have a kind but no format code: `currency` → `"$"#,##0.00`, `percentage` →
 * `0%`, `date` → `m/d/yyyy`. Other kinds (`number`, `text` — the default of
 * new columns —, `badge`, `status`, `assignee`) display as General (undefined).
 */
export function numberFormatForCellFormat(format: CellFormat | undefined): string | undefined {
  switch (format) {
    case 'currency':
      return '"$"#,##0.00';
    case 'percentage':
      return '0%';
    case 'date':
      return 'm/d/yyyy';
    default:
      return undefined;
  }
}

/**
 * `CellFormat` kind matching a format code (`"$"#,##0.00` → `currency`,
 * `0%` → `percentage`, `m/d/yyyy` → `date`, `0.00` → `number`, `@` → `text`);
 * undefined for General, times and custom codes.
 */
export function cellFormatForNumberFormat(code: string): CellFormat | undefined {
  switch (NumberFormat.parseCached(code).kind()) {
    case 'number':
    case 'fraction':
    case 'scientific':
    case 'special':
      return 'number';
    case 'currency':
    case 'accounting':
      return 'currency';
    case 'percentage':
      return 'percentage';
    case 'date':
      return 'date';
    case 'text':
      return 'text';
    default:
      return undefined;
  }
}

/** True for an empty or `General` code. */
export const isGeneralNumberFormat = (code: string | undefined): boolean =>
  code === undefined || NumberFormat.parseCached(code).isGeneral();
