import type { FormulaFunctionContext } from '../registry';
import { daysBetween, formatIsoDate, formatIsoDateTime, isBlank, isFormulaError, toDate } from '../values';
import { arg, failed, optional, type FunctionTable } from './helpers';

/**
 * Dates are ISO text ("2026-01-31"), as TODAY() has always returned, so they
 * display readably and sort correctly as text. Date arguments also accept
 * spreadsheet serial numbers. Date functions return ISO text; part functions
 * (YEAR, WEEKDAY, ...) and differences (DAYS, DATEDIF) return numbers.
 */

const START_DATE = arg('start_date', 'The date to start from.', 'date');
const DATE = arg('date', 'A date (e.g. "2026-01-31" or a cell containing one).', 'date');

/** Adds months, clamping the day to the end of the target month (Jan 31 + 1 month = Feb 28). */
function addMonths(date: Date, months: number): Date {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

function datePart(ctx: FormulaFunctionContext, part: (date: Date) => number): number | string {
  const date = ctx.date(0);
  return failed(date) ? date : part(date);
}

const isWorkday = (date: Date) => date.getDay() !== 0 && date.getDay() !== 6;

export const DATE_FUNCTIONS: FunctionTable = [
  {
    name: 'TODAY',
    category: 'date',
    description: 'Returns today\'s date (YYYY-MM-DD). Changes on every recalculation.',
    args: [],
    volatile: true,
    // Local calendar date (toISOString would give the UTC date).
    evaluate: () => formatIsoDate(new Date()),
  },
  {
    name: 'NOW',
    category: 'date',
    description: 'Returns the current date and time (YYYY-MM-DD HH:MM:SS). Changes on every recalculation.',
    args: [],
    volatile: true,
    evaluate: () => formatIsoDateTime(new Date()),
  },
  {
    name: 'DATE',
    category: 'date',
    description: 'Builds a date from a year, month and day. Months and days outside their range roll over.',
    args: [
      arg('year', 'The year (0-1899 are added to 1900).', 'number'),
      arg('month', 'The month (1-12).', 'number'),
      arg('day', 'The day of the month.', 'number'),
    ],
    evaluate: (ctx) => {
      let year = ctx.integer(0);
      if (failed(year)) return year;
      const month = ctx.integer(1);
      if (failed(month)) return month;
      const day = ctx.integer(2);
      if (failed(day)) return day;
      if (year < 0 || year > 9999) return ctx.argError(0, '#NUM!', 'must be between 0 and 9999.');
      if (year < 1900) year += 1900;
      const date = new Date(year, month - 1, 1);
      date.setDate(day);
      if (date.getFullYear() < 1900 || date.getFullYear() > 9999) {
        return ctx.error('#NUM!', 'DATE produced a date outside the years 1900-9999.');
      }
      return formatIsoDate(date);
    },
  },
  {
    name: 'YEAR',
    category: 'date',
    description: 'Returns the year of a date.',
    args: [DATE],
    evaluate: (ctx) => datePart(ctx, (d) => d.getFullYear()),
  },
  {
    name: 'MONTH',
    category: 'date',
    description: 'Returns the month of a date (1-12).',
    args: [DATE],
    evaluate: (ctx) => datePart(ctx, (d) => d.getMonth() + 1),
  },
  {
    name: 'DAY',
    category: 'date',
    description: 'Returns the day of the month of a date (1-31).',
    args: [DATE],
    evaluate: (ctx) => datePart(ctx, (d) => d.getDate()),
  },
  {
    name: 'WEEKDAY',
    category: 'date',
    description: 'Returns the day of the week of a date.',
    args: [DATE, optional('return_type', '1 (default) = Sunday 1 to Saturday 7; 2 = Monday 1 to Sunday 7; 3 = Monday 0 to Sunday 6.', 'number')],
    evaluate: (ctx) => {
      const date = ctx.date(0);
      if (failed(date)) return date;
      const type = ctx.integer(1, 1);
      if (failed(type)) return type;
      const day = date.getDay(); // 0 = Sunday
      if (type === 1) return day + 1;
      if (type === 2) return day === 0 ? 7 : day;
      if (type === 3) return day === 0 ? 6 : day - 1;
      return ctx.argError(1, '#NUM!', 'must be 1, 2 or 3.');
    },
  },
  {
    name: 'DAYS',
    category: 'date',
    description: 'Returns the number of days between two dates.',
    args: [arg('end_date', 'The later date.', 'date'), START_DATE],
    evaluate: (ctx) => {
      const end = ctx.date(0);
      if (failed(end)) return end;
      const start = ctx.date(1);
      if (failed(start)) return start;
      return daysBetween(start, end);
    },
  },
  {
    name: 'EDATE',
    category: 'date',
    description: 'Returns the date a number of months before or after a date.',
    args: [START_DATE, arg('months', 'Months to add (negative for earlier dates).', 'number')],
    evaluate: (ctx) => {
      const start = ctx.date(0);
      if (failed(start)) return start;
      const months = ctx.integer(1);
      if (failed(months)) return months;
      return formatIsoDate(addMonths(start, months));
    },
  },
  {
    name: 'EOMONTH',
    category: 'date',
    description: 'Returns the last day of the month a number of months before or after a date.',
    args: [START_DATE, arg('months', 'Months to add (0 = same month).', 'number')],
    evaluate: (ctx) => {
      const start = ctx.date(0);
      if (failed(start)) return start;
      const months = ctx.integer(1);
      if (failed(months)) return months;
      return formatIsoDate(new Date(start.getFullYear(), start.getMonth() + months + 1, 0));
    },
  },
  {
    name: 'NETWORKDAYS',
    category: 'date',
    description: 'Counts the working days (Monday to Friday) between two dates, inclusive, minus holidays.',
    args: [START_DATE, arg('end_date', 'The last date.', 'date'), optional('holidays', 'Dates to exclude.', 'range')],
    evaluate: (ctx) => {
      const start = ctx.date(0);
      if (failed(start)) return start;
      const end = ctx.date(1);
      if (failed(end)) return end;
      const holidays = new Set<string>();
      if (ctx.has(2)) {
        const raw = ctx.value(2);
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          if (isFormulaError(value)) return value;
          if (isBlank(value)) continue;
          const date = toDate(value);
          if (!date) return ctx.argError(2, '#VALUE!', 'must contain only dates.');
          holidays.add(formatIsoDate(date));
        }
      }
      const sign = daysBetween(start, end) < 0 ? -1 : 1;
      const [from, to] = sign < 0 ? [end, start] : [start, end];
      let count = 0;
      const total = daysBetween(from, to);
      for (let i = 0; i <= total; i++) {
        const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
        if (isWorkday(day) && !holidays.has(formatIsoDate(day))) count++;
      }
      return sign * count;
    },
  },
  {
    name: 'DATEDIF',
    category: 'date',
    description: 'Returns the difference between two dates in years, months or days.',
    args: [
      START_DATE,
      arg('end_date', 'The later date.', 'date'),
      arg('unit', '"Y" years, "M" months, "D" days, "MD" days ignoring months and years, "YM" months ignoring years, "YD" days ignoring years.', 'text'),
    ],
    evaluate: (ctx) => {
      const start = ctx.date(0);
      if (failed(start)) return start;
      const end = ctx.date(1);
      if (failed(end)) return end;
      const unit = ctx.text(2);
      if (failed(unit)) return unit;
      if (daysBetween(start, end) < 0) return ctx.error('#NUM!', 'DATEDIF needs the start date to be on or before the end date.');

      let months = (end.getFullYear() - start.getFullYear()) * 12 + end.getMonth() - start.getMonth();
      if (end.getDate() < start.getDate()) months--;
      switch (unit.trim().toUpperCase()) {
        case 'Y':
          return Math.floor(months / 12);
        case 'M':
          return months;
        case 'D':
          return daysBetween(start, end);
        case 'YM':
          return months % 12;
        case 'MD': {
          const anchor = addMonths(start, months);
          return daysBetween(anchor, end);
        }
        case 'YD': {
          const anchor = addMonths(start, Math.floor(months / 12) * 12);
          return daysBetween(anchor, end);
        }
        default:
          return ctx.argError(2, '#NUM!', 'must be "Y", "M", "D", "MD", "YM" or "YD".');
      }
    },
  },
];
