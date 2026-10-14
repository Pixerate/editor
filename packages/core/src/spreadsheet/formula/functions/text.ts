import type { FormulaFunctionContext } from '../registry';
import { wildcardToRegExp } from '../criteria';
import { formatValueWithCode } from '../format';
import { dateToSerial, isBlank, isFormulaError, toDate, toText } from '../values';
import { parseNumberText } from '../parse-input';
import { arg, failed, optional, repeating, type FunctionTable } from './helpers';

const TEXT = arg('text', 'The text to use.', 'text');

/** Text argument plus a non-negative character count (default `fallback`). */
function textAndCount(ctx: FormulaFunctionContext, countIndex: number, fallback?: number) {
  const text = ctx.text(0);
  if (failed(text)) return text;
  const count = ctx.integer(countIndex, fallback);
  if (failed(count)) return count;
  if (count < 0) return ctx.argError(countIndex, '#VALUE!', "can't be negative.");
  return { text, count };
}

/** Converts text such as "1,234.5", "$12", "50%" or an ISO date to a number, or null. */
export function parseNumericText(text: string): number | null {
  let trimmed = text.trim();
  if (trimmed === '') return null;
  let scale = 1;
  if (trimmed.endsWith('%')) {
    trimmed = trimmed.slice(0, -1).trim();
    scale = 0.01;
  }
  const negative = /^\(.*\)$/.test(trimmed);
  if (negative) trimmed = trimmed.slice(1, -1);
  const cleaned = trimmed.replace(/^([+-]?)[$€£¥]/, '$1').replace(/,(?=\d{3}(\D|$))/g, '');
  if (cleaned !== '' && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(cleaned)) {
    const num = Number(cleaned) * scale;
    return negative ? -num : num;
  }
  if (scale === 1 && !negative) {
    const date = /^\d{4}-\d{1,2}-\d{1,2}/.test(trimmed) ? toDate(trimmed) : null;
    if (date) return dateToSerial(date);
  }
  return null;
}

/** FIND / SEARCH: 1-based position of `find_text` in `within_text`. */
function findText(ctx: FormulaFunctionContext, caseInsensitive: boolean): number | string {
  const needle = ctx.text(0);
  if (failed(needle)) return needle;
  const haystack = ctx.text(1);
  if (failed(haystack)) return haystack;
  const start = ctx.integer(2, 1);
  if (failed(start)) return start;
  if (start < 1 || start > haystack.length + 1) {
    return ctx.argError(2, '#VALUE!', `must be between 1 and the length of the text (${haystack.length}).`);
  }
  let index: number;
  if (caseInsensitive) {
    // SEARCH supports wildcards: find the first start position where the pattern matches a prefix.
    const pattern = wildcardToRegExp(needle).source.slice(1, -1);
    const regex = new RegExp(pattern, 'i');
    const match = regex.exec(haystack.slice(start - 1));
    index = match ? match.index + start - 1 : -1;
  } else {
    index = haystack.indexOf(needle, start - 1);
  }
  if (index === -1) return ctx.error('#VALUE!', `${ctx.name} couldn't find "${needle}" in "${haystack}".`);
  return index + 1;
}

export const TEXT_FUNCTIONS: FunctionTable = [
  {
    name: 'CONCAT',
    category: 'text',
    description: 'Joins text, numbers and the values of ranges into one piece of text.',
    args: [repeating('text', 'A value, cell or range to join.', 'text')],
    evaluate: (ctx) => {
      const items = ctx.flatValues();
      const error = items.find(isFormulaError);
      if (error) return error;
      return items.map(toText).join('');
    },
  },
  {
    name: 'TEXTJOIN',
    category: 'text',
    description: 'Joins values with a delimiter, optionally skipping empty values.',
    args: [
      arg('delimiter', 'Text to put between values.', 'text'),
      arg('ignore_empty', 'TRUE to skip empty values.', 'logical'),
      repeating('text', 'A value, cell or range to join.', 'text'),
    ],
    evaluate: (ctx) => {
      const delimiter = ctx.text(0);
      if (failed(delimiter)) return delimiter;
      const ignoreEmpty = ctx.boolean(1);
      if (failed(ignoreEmpty)) return ignoreEmpty;
      const items = ctx.flatValues(2);
      const error = items.find(isFormulaError);
      if (error) return error;
      return items
        .map(toText)
        .filter((text) => !ignoreEmpty || text !== '')
        .join(delimiter);
    },
  },
  {
    name: 'UPPER',
    category: 'text',
    description: 'Converts text to upper case.',
    args: [TEXT],
    evaluate: (ctx) => {
      const text = ctx.text(0);
      return failed(text) ? text : text.toUpperCase();
    },
  },
  {
    name: 'LOWER',
    category: 'text',
    description: 'Converts text to lower case.',
    args: [TEXT],
    evaluate: (ctx) => {
      const text = ctx.text(0);
      return failed(text) ? text : text.toLowerCase();
    },
  },
  {
    name: 'PROPER',
    category: 'text',
    description: 'Capitalizes the first letter of each word and lower-cases the rest.',
    args: [TEXT],
    evaluate: (ctx) => {
      const text = ctx.text(0);
      if (failed(text)) return text;
      return text.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase());
    },
  },
  {
    name: 'TRIM',
    category: 'text',
    description: 'Removes leading and trailing spaces and collapses runs of inner spaces to one, like Excel.',
    args: [TEXT],
    evaluate: (ctx) => {
      const text = ctx.text(0);
      // Inner runs of spaces collapse (Excel); tabs and line breaks inside are kept.
      return failed(text) ? text : text.trim().replace(/ {2,}/g, ' ');
    },
  },
  {
    name: 'LEN',
    category: 'text',
    description: 'Returns the number of characters in text.',
    args: [TEXT],
    evaluate: (ctx) => {
      const text = ctx.text(0);
      return failed(text) ? text : text.length;
    },
  },
  {
    name: 'LEFT',
    category: 'text',
    description: 'Returns the first characters of text.',
    args: [TEXT, optional('num_chars', 'How many characters to return (default 1).', 'number')],
    evaluate: (ctx) => {
      const parts = textAndCount(ctx, 1, 1);
      return typeof parts === 'string' ? parts : parts.text.slice(0, parts.count);
    },
  },
  {
    name: 'RIGHT',
    category: 'text',
    description: 'Returns the last characters of text.',
    args: [TEXT, optional('num_chars', 'How many characters to return (default 1).', 'number')],
    evaluate: (ctx) => {
      const parts = textAndCount(ctx, 1, 1);
      if (typeof parts === 'string') return parts;
      return parts.count === 0 ? '' : parts.text.slice(-parts.count);
    },
  },
  {
    name: 'MID',
    category: 'text',
    description: 'Returns characters from the middle of text, starting at a position.',
    args: [
      TEXT,
      arg('start_num', 'Position of the first character (1 = first).', 'number'),
      arg('num_chars', 'How many characters to return.', 'number'),
    ],
    evaluate: (ctx) => {
      const parts = textAndCount(ctx, 2);
      if (typeof parts === 'string') return parts;
      const start = ctx.integer(1);
      if (failed(start)) return start;
      if (start < 1) return ctx.argError(1, '#VALUE!', 'must be 1 or more.');
      return parts.text.slice(start - 1, start - 1 + parts.count);
    },
  },
  {
    name: 'FIND',
    category: 'text',
    description: 'Returns the position of text within other text (case-sensitive, no wildcards).',
    args: [
      arg('find_text', 'The text to find.', 'text'),
      arg('within_text', 'The text to search.', 'text'),
      optional('start_num', 'Position to start searching from (default 1).', 'number'),
    ],
    evaluate: (ctx) => findText(ctx, false),
  },
  {
    name: 'SEARCH',
    category: 'text',
    description: 'Returns the position of text within other text (case-insensitive, supports * and ? wildcards).',
    args: [
      arg('find_text', 'The text to find.', 'text'),
      arg('within_text', 'The text to search.', 'text'),
      optional('start_num', 'Position to start searching from (default 1).', 'number'),
    ],
    evaluate: (ctx) => findText(ctx, true),
  },
  {
    name: 'SUBSTITUTE',
    category: 'text',
    description: 'Replaces occurrences of old text with new text (all of them, or only the given instance).',
    args: [
      TEXT,
      arg('old_text', 'The text to replace.', 'text'),
      arg('new_text', 'The replacement text.', 'text'),
      optional('instance_num', 'Which occurrence to replace (default: all).', 'number'),
    ],
    evaluate: (ctx) => {
      const text = ctx.text(0);
      if (failed(text)) return text;
      const oldText = ctx.text(1);
      if (failed(oldText)) return oldText;
      const newText = ctx.text(2);
      if (failed(newText)) return newText;
      if (oldText === '') return text;
      if (!ctx.has(3)) return text.split(oldText).join(newText);
      const instance = ctx.integer(3);
      if (failed(instance)) return instance;
      if (instance < 1) return ctx.argError(3, '#VALUE!', 'must be 1 or more.');
      let index = -1;
      for (let n = 0; n < instance; n++) {
        index = text.indexOf(oldText, index + 1);
        if (index === -1) return text;
      }
      return text.slice(0, index) + newText + text.slice(index + oldText.length);
    },
  },
  {
    name: 'REPLACE',
    category: 'text',
    description: 'Replaces part of text, by position, with new text.',
    args: [
      arg('old_text', 'The text to change.', 'text'),
      arg('start_num', 'Position of the first character to replace (1 = first).', 'number'),
      arg('num_chars', 'How many characters to replace.', 'number'),
      arg('new_text', 'The replacement text.', 'text'),
    ],
    evaluate: (ctx) => {
      const text = ctx.text(0);
      if (failed(text)) return text;
      const start = ctx.integer(1);
      if (failed(start)) return start;
      if (start < 1) return ctx.argError(1, '#VALUE!', 'must be 1 or more.');
      const count = ctx.integer(2);
      if (failed(count)) return count;
      if (count < 0) return ctx.argError(2, '#VALUE!', "can't be negative.");
      const newText = ctx.text(3);
      if (failed(newText)) return newText;
      return text.slice(0, start - 1) + newText + text.slice(start - 1 + count);
    },
  },
  {
    name: 'REPT',
    category: 'text',
    description: 'Repeats text a number of times.',
    args: [TEXT, arg('number_times', 'How many times to repeat the text.', 'number')],
    evaluate: (ctx) => {
      const parts = textAndCount(ctx, 1);
      if (typeof parts === 'string') return parts;
      if (parts.text.length * parts.count > 32767) {
        return ctx.error('#VALUE!', 'REPT would produce text longer than 32,767 characters.');
      }
      return parts.text.repeat(parts.count);
    },
  },
  {
    name: 'EXACT',
    category: 'text',
    description: 'Returns TRUE if two pieces of text are identical, including case.',
    args: [arg('text1', 'The first text.', 'text'), arg('text2', 'The second text.', 'text')],
    evaluate: (ctx) => {
      const a = ctx.text(0);
      if (failed(a)) return a;
      const b = ctx.text(1);
      if (failed(b)) return b;
      return a === b;
    },
  },
  {
    name: 'VALUE',
    category: 'text',
    description: 'Converts text that looks like a number (e.g. "1,234.5", "50%", "$12") or an ISO date to a number.',
    args: [TEXT],
    evaluate: (ctx) => {
      const value = ctx.scalar(0);
      if (isFormulaError(value)) return value;
      if (typeof value === 'number') return value;
      if (isBlank(value)) return 0;
      // Typed-input rules ("3/4/2026", "10:30 PM", "1 1/2") after the lenient ones ("€12").
      const num = parseNumericText(toText(value)) ?? parseNumberText(toText(value));
      if (num === null) return ctx.argError(0, '#VALUE!', `("${toText(value)}") can't be converted to a number.`);
      return num;
    },
  },
  {
    name: 'TEXT',
    category: 'text',
    description: 'Formats a number or date as text using a format code such as "0.00", "#,##0", "0%" or "yyyy-mm-dd".',
    args: [arg('value', 'The number or date to format.'), arg('format_text', 'The format code.', 'text')],
    evaluate: (ctx) => {
      const value = ctx.scalar(0);
      if (isFormulaError(value)) return value;
      const format = ctx.text(1);
      if (failed(format)) return format;
      const result = formatValueWithCode(value, format);
      return result ?? ctx.argError(0, '#VALUE!', `isn't a date, so it can't use the format "${format}".`);
    },
  },
];
