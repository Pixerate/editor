/**
 * One-line descriptions of rules for the conditional formatting and data
 * validation managers, shared by React and Svelte.
 */
import type { ConditionalFormatOperator, ConditionalFormatRule, ConditionalFormatValue } from './types';
import type { DataValidationRule } from '../validation/types';

const OPERATOR_TEXT: Record<ConditionalFormatOperator, string> = {
  between: 'between',
  notBetween: 'not between',
  equal: '=',
  notEqual: '≠',
  greaterThan: '>',
  lessThan: '<',
  greaterThanOrEqual: '≥',
  lessThanOrEqual: '≤',
};

const anchorText = (v: ConditionalFormatValue | undefined, fallback: string): string => {
  if (!v) return fallback;
  switch (v.type) {
    case 'min':
      return 'min';
    case 'max':
      return 'max';
    case 'number':
      return String(v.value);
    case 'percent':
      return `${v.value}%`;
    case 'percentile':
      return `P${v.value}`;
    case 'formula':
      return v.formula;
  }
};

/** E.g. `Cell value > 100`, `Color scale (min → P50 → max)`, `Formula: =$B2>10`. */
export function describeConditionalFormat(rule: ConditionalFormatRule): string {
  switch (rule.type) {
    case 'cellIs':
      return rule.operator === 'between' || rule.operator === 'notBetween'
        ? `Cell value ${OPERATOR_TEXT[rule.operator]} ${rule.value} and ${rule.value2 ?? ''}`
        : `Cell value ${OPERATOR_TEXT[rule.operator]} ${rule.value}`;
    case 'expression':
      return `Formula: ${rule.formula.startsWith('=') ? rule.formula : `=${rule.formula}`}`;
    case 'containsText':
      return `Text contains "${rule.text}"`;
    case 'notContainsText':
      return `Text does not contain "${rule.text}"`;
    case 'beginsWith':
      return `Text begins with "${rule.text}"`;
    case 'endsWith':
      return `Text ends with "${rule.text}"`;
    case 'blanks':
      return 'Blank cells';
    case 'noBlanks':
      return 'Non-blank cells';
    case 'errors':
      return 'Errors';
    case 'noErrors':
      return 'No errors';
    case 'duplicate':
      return 'Duplicate values';
    case 'unique':
      return 'Unique values';
    case 'top10':
      return `${rule.bottom ? 'Bottom' : 'Top'} ${rule.rank}${rule.percent ? '%' : ''}`;
    case 'aboveAverage':
      return `${rule.below ? 'Below' : 'Above'} average${rule.stdDev ? ` by ${rule.stdDev} std dev` : ''}`;
    case 'timePeriod':
      return `Date occurring: ${rule.period}`;
    case 'colorScale':
      return `Color scale (${rule.stops.map((s) => anchorText(s.value, '')).join(' → ')})`;
    case 'dataBar':
      return `Data bar (${anchorText(rule.min, 'min')} → ${anchorText(rule.max, 'max')})`;
    case 'iconSet':
      return `Icon set ${rule.set ?? '3TrafficLights1'}${rule.reverse ? ' (reversed)' : ''}`;
  }
}

const VALIDATION_OPERATOR_TEXT: Record<string, string> = OPERATOR_TEXT;

/** E.g. `Whole number between 1 and 10`, `List: Low,Medium,High`, `Custom: =A1>0`. */
export function describeDataValidation(rule: DataValidationRule): string {
  const op = rule.operator ?? 'between';
  const bounds =
    op === 'between' || op === 'notBetween'
      ? `${VALIDATION_OPERATOR_TEXT[op]} ${rule.formula1 ?? ''} and ${rule.formula2 ?? ''}`
      : `${VALIDATION_OPERATOR_TEXT[op]} ${rule.formula1 ?? ''}`;
  switch (rule.type) {
    case 'any':
      return 'Any value';
    case 'whole':
      return `Whole number ${bounds}`;
    case 'decimal':
      return `Decimal ${bounds}`;
    case 'date':
      return `Date ${bounds}`;
    case 'time':
      return `Time ${bounds}`;
    case 'textLength':
      return `Text length ${bounds}`;
    case 'list':
      return `List: ${rule.formula1 ?? ''}`;
    case 'custom':
      return `Custom: ${rule.formula1 ?? ''}`;
  }
}
