import { FORMULA_ERRORS, isBlank, isFormulaError, numericValue } from './values';

/** Tests one value against a criterion. */
export type FormulaCriteriaPredicate = (value: unknown) => boolean;

/**
 * Builds a regular expression from a spreadsheet wildcard pattern: `*` is any
 * run of characters, `?` any single character, and `~` escapes the next
 * character (`~*` is a literal asterisk). Matching is case-insensitive.
 */
export function wildcardToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '~' && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[++i]);
    } else if (char === '*') {
      source += '[\\s\\S]*';
    } else if (char === '?') {
      source += '[\\s\\S]';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const hasWildcards = (pattern: string): boolean => /(^|[^~])[*?]/.test(pattern);

/**
 * Parses a criterion as used by SUMIF, COUNTIFS etc.:
 * - a number or boolean matches equal values (`5` matches 5 and the text "5");
 * - text may start with `=`, `<>`, `<`, `<=`, `>` or `>=`. Numeric operands
 *   compare numbers; text operands compare text case-insensitively;
 * - `=`/`<>` text operands and plain text support `*` and `?` wildcards;
 * - `""` and `"="` match blank cells, `"<>"` matches non-blank cells.
 * Error values in the data never match.
 */
export function parseCriteria(criterion: unknown): FormulaCriteriaPredicate {
  if (typeof criterion === 'number') {
    return (value) => numericValue(value) === criterion;
  }
  if (typeof criterion === 'boolean') {
    return (value) => value === criterion;
  }
  if (isBlank(criterion)) return (value) => isBlank(value);

  const text = String(criterion);
  const match = /^(<>|<=|>=|=|<|>)?([\s\S]*)$/.exec(text)!;
  const op = match[1] ?? '=';
  const operand = match[2];

  if (operand === '') {
    if (op === '=') return (value) => isBlank(value);
    if (op === '<>') return (value) => !isBlank(value);
    // "<" or ">" with nothing to compare: nothing matches.
    return () => false;
  }

  const operandNumber = numericValue(operand);
  const operandUpper = operand.trim().toUpperCase();
  const operandBoolean = operandUpper === 'TRUE' ? true : operandUpper === 'FALSE' ? false : null;

  if (op === '=' || op === '<>') {
    let equals: FormulaCriteriaPredicate;
    if (operandNumber !== null) {
      equals = (value) => numericValue(value) === operandNumber;
    } else if (operandBoolean !== null) {
      equals = (value) => value === operandBoolean || (typeof value === 'string' && value.trim().toUpperCase() === operandUpper);
    } else if (isFormulaError(operand)) {
      // Counting errors ("#N/A") is the one case where error values match.
      return op === '=' ? (value) => value === operand : (value) => value !== operand && !isBlank(value);
    } else {
      const regex = wildcardToRegExp(operand);
      equals = (value) => typeof value === 'string' && !isFormulaError(value) && regex.test(value);
    }
    return op === '=' ? (value) => !isFormulaError(value) && equals(value) : (value) => !isFormulaError(value) && !equals(value);
  }

  const test = (cmp: number) =>
    op === '<' ? cmp < 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : cmp >= 0;

  if (operandNumber !== null) {
    // Numeric comparisons only consider numbers (and numeric text).
    return (value) => {
      const num = numericValue(value);
      return num !== null && test(num - operandNumber);
    };
  }

  const lower = operand.toLowerCase();
  return (value) => {
    if (typeof value !== 'string' || value === '' || FORMULA_ERRORS.has(value) || numericValue(value) !== null) {
      return false;
    }
    const v = value.toLowerCase();
    return test(v < lower ? -1 : v > lower ? 1 : 0);
  };
}
