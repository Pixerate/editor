/**
 * Ready-made rules for the conditional formatting and data validation
 * managers and the context menu, so React and Svelte offer the same choices.
 */
import type { CellRange } from '../types';
import type { DataValidationErrorStyle, DataValidationOperator, DataValidationType } from '../validation/types';
import type {
  ConditionalFormatIconSet,
  ConditionalFormatStyle,
  ConditionalFormatTimePeriod,
  NewConditionalFormatRule,
} from './types';

/** Excel's highlight styles. */
export const CONDITIONAL_FORMAT_STYLE_PRESETS: Array<{ id: string; label: string; style: ConditionalFormatStyle }> = [
  { id: 'lightRed', label: 'Light red fill, dark red text', style: { fill: '#ffc7ce', color: '#9c0006' } },
  { id: 'yellow', label: 'Yellow fill, dark yellow text', style: { fill: '#ffeb9c', color: '#9c5700' } },
  { id: 'green', label: 'Green fill, dark green text', style: { fill: '#c6efce', color: '#006100' } },
  { id: 'redText', label: 'Red text', style: { color: '#9c0006' } },
  { id: 'bold', label: 'Bold', style: { bold: true } },
];

export const DEFAULT_CONDITIONAL_FORMAT_STYLE: ConditionalFormatStyle = CONDITIONAL_FORMAT_STYLE_PRESETS[0].style;

export type ConditionalFormatPresetKind =
  | 'greaterThan'
  | 'lessThan'
  | 'between'
  | 'equal'
  | 'textContains'
  | 'dateOccurring'
  | 'duplicate'
  | 'unique'
  | 'top10'
  | 'bottom10'
  | 'aboveAverage'
  | 'belowAverage'
  | 'blanks'
  | 'errors'
  | 'formula'
  | 'colorScale2'
  | 'colorScale3'
  | 'dataBar'
  | 'iconSet';

/** Inputs a preset needs, besides the ranges. */
export type ConditionalFormatPresetField = 'value' | 'value2' | 'text' | 'formula' | 'rank' | 'period' | 'iconSet' | 'color';

export interface ConditionalFormatPresetInfo {
  kind: ConditionalFormatPresetKind;
  label: string;
  fields: ConditionalFormatPresetField[];
  /** Whether the rule takes a highlight style (scales, bars and icons don't). */
  usesStyle: boolean;
}

export const CONDITIONAL_FORMAT_PRESETS: ConditionalFormatPresetInfo[] = [
  { kind: 'greaterThan', label: 'Cell value greater than', fields: ['value'], usesStyle: true },
  { kind: 'lessThan', label: 'Cell value less than', fields: ['value'], usesStyle: true },
  { kind: 'between', label: 'Cell value between', fields: ['value', 'value2'], usesStyle: true },
  { kind: 'equal', label: 'Cell value equal to', fields: ['value'], usesStyle: true },
  { kind: 'textContains', label: 'Text that contains', fields: ['text'], usesStyle: true },
  { kind: 'dateOccurring', label: 'A date occurring', fields: ['period'], usesStyle: true },
  { kind: 'duplicate', label: 'Duplicate values', fields: [], usesStyle: true },
  { kind: 'unique', label: 'Unique values', fields: [], usesStyle: true },
  { kind: 'top10', label: 'Top N items', fields: ['rank'], usesStyle: true },
  { kind: 'bottom10', label: 'Bottom N items', fields: ['rank'], usesStyle: true },
  { kind: 'aboveAverage', label: 'Above average', fields: [], usesStyle: true },
  { kind: 'belowAverage', label: 'Below average', fields: [], usesStyle: true },
  { kind: 'blanks', label: 'Blank cells', fields: [], usesStyle: true },
  { kind: 'errors', label: 'Errors', fields: [], usesStyle: true },
  { kind: 'formula', label: 'Use a formula', fields: ['formula'], usesStyle: true },
  { kind: 'colorScale2', label: '2-color scale', fields: [], usesStyle: false },
  { kind: 'colorScale3', label: '3-color scale', fields: [], usesStyle: false },
  { kind: 'dataBar', label: 'Data bars', fields: ['color'], usesStyle: false },
  { kind: 'iconSet', label: 'Icon set', fields: ['iconSet'], usesStyle: false },
];

export const CONDITIONAL_FORMAT_TIME_PERIODS: Array<{ period: ConditionalFormatTimePeriod; label: string }> = [
  { period: 'yesterday', label: 'Yesterday' },
  { period: 'today', label: 'Today' },
  { period: 'tomorrow', label: 'Tomorrow' },
  { period: 'last7Days', label: 'In the last 7 days' },
  { period: 'lastWeek', label: 'Last week' },
  { period: 'thisWeek', label: 'This week' },
  { period: 'nextWeek', label: 'Next week' },
  { period: 'lastMonth', label: 'Last month' },
  { period: 'thisMonth', label: 'This month' },
  { period: 'nextMonth', label: 'Next month' },
];

export interface ConditionalFormatPresetInput {
  kind: ConditionalFormatPresetKind;
  ranges: CellRange[];
  value?: string;
  value2?: string;
  text?: string;
  formula?: string;
  rank?: number;
  period?: ConditionalFormatTimePeriod;
  iconSet?: ConditionalFormatIconSet;
  /** Data bar colour. */
  color?: string;
  /** Highlight style (default light red fill, dark red text). */
  style?: ConditionalFormatStyle;
  stopIfTrue?: boolean;
}

/** Builds a rule from a preset and its inputs. */
export function createConditionalFormatRule(input: ConditionalFormatPresetInput): NewConditionalFormatRule {
  const style = input.style ?? DEFAULT_CONDITIONAL_FORMAT_STYLE;
  const base = { ranges: input.ranges, ...(input.stopIfTrue ? { stopIfTrue: true } : {}) };
  switch (input.kind) {
    case 'greaterThan':
    case 'lessThan':
    case 'equal':
      return { ...base, type: 'cellIs', operator: input.kind, value: input.value ?? '0', style };
    case 'between':
      return { ...base, type: 'cellIs', operator: 'between', value: input.value ?? '0', value2: input.value2 ?? '0', style };
    case 'textContains':
      return { ...base, type: 'containsText', text: input.text ?? '', style };
    case 'dateOccurring':
      return { ...base, type: 'timePeriod', period: input.period ?? 'today', style };
    case 'duplicate':
    case 'unique':
    case 'blanks':
    case 'errors':
      return { ...base, type: input.kind, style };
    case 'top10':
    case 'bottom10':
      return { ...base, type: 'top10', bottom: input.kind === 'bottom10', rank: input.rank ?? 10, style };
    case 'aboveAverage':
    case 'belowAverage':
      return { ...base, type: 'aboveAverage', below: input.kind === 'belowAverage', style };
    case 'formula':
      return { ...base, type: 'expression', formula: input.formula ?? '=TRUE', style };
    case 'colorScale2':
      return {
        ...base,
        type: 'colorScale',
        stops: [
          { value: { type: 'min' }, color: '#ffffff' },
          { value: { type: 'max' }, color: '#63be7b' },
        ],
      };
    case 'colorScale3':
      return {
        ...base,
        type: 'colorScale',
        stops: [
          { value: { type: 'min' }, color: '#f8696b' },
          { value: { type: 'percentile', value: 50 }, color: '#ffeb84' },
          { value: { type: 'max' }, color: '#63be7b' },
        ],
      };
    case 'dataBar':
      return { ...base, type: 'dataBar', color: input.color ?? '#638ec6' };
    case 'iconSet':
      return { ...base, type: 'iconSet', set: input.iconSet ?? '3TrafficLights1' };
  }
}

export const DATA_VALIDATION_TYPE_OPTIONS: Array<{ type: DataValidationType; label: string }> = [
  { type: 'any', label: 'Any value' },
  { type: 'whole', label: 'Whole number' },
  { type: 'decimal', label: 'Decimal' },
  { type: 'list', label: 'List' },
  { type: 'date', label: 'Date' },
  { type: 'time', label: 'Time' },
  { type: 'textLength', label: 'Text length' },
  { type: 'custom', label: 'Custom formula' },
];

export const DATA_VALIDATION_OPERATOR_OPTIONS: Array<{ operator: DataValidationOperator; label: string }> = [
  { operator: 'between', label: 'between' },
  { operator: 'notBetween', label: 'not between' },
  { operator: 'equal', label: 'equal to' },
  { operator: 'notEqual', label: 'not equal to' },
  { operator: 'greaterThan', label: 'greater than' },
  { operator: 'lessThan', label: 'less than' },
  { operator: 'greaterThanOrEqual', label: 'greater than or equal to' },
  { operator: 'lessThanOrEqual', label: 'less than or equal to' },
];

export const DATA_VALIDATION_ERROR_STYLE_OPTIONS: Array<{ style: DataValidationErrorStyle; label: string }> = [
  { style: 'stop', label: 'Stop' },
  { style: 'warning', label: 'Warning' },
  { style: 'information', label: 'Information' },
];
