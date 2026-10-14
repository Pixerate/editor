import type { CellData } from '../types';
import { numericValue, roundHalfAwayFromZero, toDate, toText } from './values';

/**
 * The text a cell shows: its error, or its value formatted with the number
 * format chosen for typed input (`numberFormat`, e.g. `"$"#,##0.00` for
 * `$1,200.50`, `0%` for `10%`, `m/d/yyyy` for `3/4/2026`). Other numbers use
 * up to 15 significant digits and booleans show as TRUE/FALSE.
 */
export function formatCellDisplay(cell: Pick<CellData, 'value' | 'error' | 'numberFormat'> | null | undefined): string {
  if (!cell) return '';
  if (cell.error) return cell.error;
  const { value, numberFormat } = cell;
  if (numberFormat && value !== '' && value !== null && value !== undefined && typeof value !== 'boolean') {
    if (/^\[h\]/i.test(numberFormat) && typeof value === 'number') return formatElapsedHours(value);
    if (numberFormat === '# ?/?' && typeof value === 'number') return formatFraction(value);
    const formatted = formatValueWithCode(value, numberFormat);
    if (formatted !== null) return formatted;
  }
  return toText(value);
}

/** `# ?/?`: a whole part and the closest fraction with a one-digit denominator (1 1/2). */
function formatFraction(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  let whole = Math.floor(abs);
  const frac = abs - whole;
  let best = { num: 0, den: 1, err: frac };
  for (let den = 2; den <= 9; den++) {
    const num = Math.round(frac * den);
    const err = Math.abs(frac - num / den);
    if (err < best.err - 1e-12) best = { num, den, err };
  }
  if (best.num === best.den) {
    whole += 1;
    best = { num: 0, den: 1, err: 0 };
  }
  if (best.num === 0) return `${sign}${whole}`;
  return `${sign}${whole === 0 ? '' : `${whole} `}${best.num}/${best.den}`;
}

/** `[h]:mm:ss`: hours past 24 keep counting (25:00:00). */
function formatElapsedHours(days: number): string {
  const total = Math.round(Math.abs(days) * 86400);
  const p = (n: number) => String(n).padStart(2, '0');
  const text = `${Math.floor(total / 3600)}:${p(Math.floor(total / 60) % 60)}:${p(total % 60)}`;
  return days < 0 ? `-${text}` : text;
}

/**
 * A subset of spreadsheet number format codes, as used by TEXT():
 * - numbers: `0`, `#`, `0.00`, `#,##0`, `#,##0.00`, `0%`, `0.0%`, `0.00E+00`,
 *   literal prefixes/suffixes (`$#,##0.00`, `0.0 "kg"`), and
 *   `positive;negative;zero` sections;
 * - dates and times: `yyyy yy mmmm mmm mm m dddd ddd dd d hh h mm ss AM/PM`
 *   (`m`/`mm` after an hour or before seconds means minutes).
 * Text values are returned unchanged; unsupported codes are best effort.
 */
export function formatValueWithCode(value: unknown, format: string): string | null {
  if (isDateFormat(format)) {
    const date = toDate(value);
    return date ? formatDate(date, format) : null;
  }
  const num = typeof value === 'boolean' ? null : numericValue(value);
  return num === null ? toText(value) : formatNumber(num, format);
}

/** Splits a format into literal and code runs; quoted text and `\x` escapes are literal. */
function tokenize(format: string): Array<{ literal: boolean; text: string }> {
  const out: Array<{ literal: boolean; text: string }> = [];
  const push = (literal: boolean, text: string) => {
    const last = out[out.length - 1];
    if (last && last.literal === literal) last.text += text;
    else out.push({ literal, text });
  };
  for (let i = 0; i < format.length; i++) {
    const char = format[i];
    if (char === '"') {
      const end = format.indexOf('"', i + 1);
      const stop = end === -1 ? format.length : end;
      push(true, format.slice(i + 1, stop));
      i = stop;
    } else if (char === '\\' && i + 1 < format.length) {
      push(true, format[++i]);
    } else {
      push(false, char);
    }
  }
  return out;
}

const codeText = (format: string) =>
  tokenize(format)
    .filter((t) => !t.literal)
    .map((t) => t.text)
    .join('');

function isDateFormat(format: string): boolean {
  const code = codeText(format);
  if (/[0#?]/.test(code)) return false;
  return /[ydhs]|m/i.test(code);
}

// --- Numbers ---

function formatNumber(num: number, format: string): string {
  const sections = splitSections(format);
  let section = sections[0];
  let value = num;
  let sign = num < 0 ? '-' : '';
  if (num < 0 && sections.length > 1) {
    section = sections[1];
    value = Math.abs(num);
    sign = '';
  } else if (num === 0 && sections.length > 2) {
    section = sections[2];
  }

  let prefix = '';
  let suffix = '';
  let pattern = '';
  for (const token of tokenize(section)) {
    if (token.literal) {
      if (pattern) suffix += token.text;
      else prefix += token.text;
      continue;
    }
    for (let i = 0; i < token.text.length; i++) {
      const char = token.text[i];
      const isExponent = /e/i.test(char) && /[+-]/.test(token.text[i + 1] ?? '');
      const isExponentSign = /[+-]/.test(char) && /e$/i.test(pattern);
      if (/[0#?.,]/.test(char) || (pattern && (isExponent || isExponentSign))) {
        pattern += char;
      } else if (pattern) {
        suffix += char;
      } else {
        prefix += char;
      }
    }
  }

  const percents = (prefix + suffix).split('%').length - 1;
  value = Math.abs(value) * Math.pow(100, percents);
  if (!pattern) return `${sign}${prefix}${suffix}`;

  const expMatch = /^([^Ee]*)[Ee]([+-])(0+)$/.exec(pattern);
  if (expMatch) {
    const [, mantissa, expSign, expDigits] = expMatch;
    const decimals = (mantissa.split('.')[1] ?? '').length;
    const [m, e] = value.toExponential(decimals).split('e');
    const exponent = Number(e);
    const expText = String(Math.abs(exponent)).padStart(expDigits.length, '0');
    const shownSign = exponent < 0 ? '-' : expSign === '+' ? '+' : '';
    return `${sign}${prefix}${m}E${shownSign}${expText}${suffix}`;
  }

  const [intPattern, decPattern = ''] = pattern.split('.');
  const maxDecimals = (decPattern.match(/[0#?]/g) ?? []).length;
  const minDecimals = (decPattern.match(/0/g) ?? []).length;
  const minInt = (intPattern.match(/0/g) ?? []).length;
  const grouping = intPattern.includes(',');

  const rounded = roundHalfAwayFromZero(value, maxDecimals);
  let [intPart, decPart = ''] = rounded.toFixed(maxDecimals).split('.');
  while (decPart.length > minDecimals && decPart.endsWith('0')) decPart = decPart.slice(0, -1);
  if (intPart === '0' && minInt === 0) intPart = '';
  intPart = intPart.padStart(minInt, '0');
  if (grouping) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const showSign = sign && /[1-9]/.test(intPart + decPart) ? sign : '';
  return `${showSign}${prefix}${intPart}${decPart ? `.${decPart}` : ''}${suffix}`;
}

function splitSections(format: string): string[] {
  const sections: string[] = [''];
  let quoted = false;
  for (let i = 0; i < format.length; i++) {
    const char = format[i];
    if (char === '"') quoted = !quoted;
    if (char === '\\' && i + 1 < format.length) {
      sections[sections.length - 1] += char + format[++i];
      continue;
    }
    if (char === ';' && !quoted) sections.push('');
    else sections[sections.length - 1] += char;
  }
  return sections;
}

// --- Dates ---

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number) => String(n).padStart(2, '0');

function formatDate(date: Date, format: string): string {
  type Part = { literal: boolean; text: string };
  const parts: Part[] = [];
  for (const token of tokenize(format)) {
    if (token.literal) {
      parts.push(token);
      continue;
    }
    const re = /AM\/PM|am\/pm|A\/P|a\/p|y+|m+|d+|h+|s+|[^ymdhsaA]+|./gi;
    for (const match of token.text.match(re) ?? []) {
      const isCode = /^(AM\/PM|A\/P|y+|m+|d+|h+|s+)$/i.test(match);
      parts.push({ literal: !isCode, text: match });
    }
  }

  const codes = parts.map((p, i) => ({ ...p, i })).filter((p) => !p.literal);
  const twelveHour = codes.some((p) => /^(AM\/PM|A\/P)$/i.test(p.text));

  return parts
    .map((part, index) => {
      if (part.literal) return part.text;
      const code = part.text;
      const lower = code.toLowerCase();
      if (/^(am\/pm|a\/p)$/.test(lower)) {
        const pm = date.getHours() >= 12;
        const full = pm ? 'PM' : 'AM';
        const text = lower === 'a/p' ? full[0] : full;
        return code[0] === code[0].toLowerCase() ? text.toLowerCase() : text;
      }
      if (lower.startsWith('y')) {
        return lower.length <= 2 ? pad(date.getFullYear() % 100) : String(date.getFullYear());
      }
      if (lower.startsWith('d')) {
        if (lower.length >= 4) return DAYS[date.getDay()];
        if (lower.length === 3) return DAYS[date.getDay()].slice(0, 3);
        return lower.length === 2 ? pad(date.getDate()) : String(date.getDate());
      }
      if (lower.startsWith('h')) {
        let hours = date.getHours();
        if (twelveHour) hours = hours % 12 || 12;
        return lower.length >= 2 ? pad(hours) : String(hours);
      }
      if (lower.startsWith('s')) {
        return lower.length >= 2 ? pad(date.getSeconds()) : String(date.getSeconds());
      }
      // m: minutes right after an hour code or right before a seconds code.
      const position = codes.findIndex((c) => c.i === index);
      const prev = codes[position - 1]?.text.toLowerCase() ?? '';
      const next = codes[position + 1]?.text.toLowerCase() ?? '';
      if (lower.length <= 2 && (prev.startsWith('h') || next.startsWith('s'))) {
        return lower.length === 2 ? pad(date.getMinutes()) : String(date.getMinutes());
      }
      if (lower.length >= 4) return MONTHS[date.getMonth()];
      if (lower.length === 3) return MONTHS[date.getMonth()].slice(0, 3);
      return lower.length === 2 ? pad(date.getMonth() + 1) : String(date.getMonth() + 1);
    })
    .join('');
}
