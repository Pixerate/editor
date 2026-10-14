/**
 * RFC 4180 CSV (and other delimiter-separated values) parsing and
 * serialization.
 *
 * - Fields may be quoted with `"`; a quote inside a quoted field is written
 *   as `""`. Quoted fields may contain delimiters and line breaks.
 * - Records end at CRLF, LF or CR. A final line break does not add an empty
 *   record.
 * - A leading UTF-8 byte order mark is ignored.
 * - The parser is lenient like spreadsheet apps: a quote inside an unquoted
 *   field is kept as text, text after a closing quote is appended, and an
 *   unterminated quoted field runs to the end of the input.
 */

export interface CsvParseOptions {
  /** Field separator. Default `,`. */
  delimiter?: string;
  /**
   * Only treat a leading `"` as a quote when the quoted field is closed and
   * followed by a delimiter or line break; otherwise keep it as text. Used for
   * clipboard TSV, where plain text may legitimately start with a quote.
   */
  requireWellFormedQuotes?: boolean;
}

export interface CsvSerializeOptions {
  /** Field separator. Default `,`. */
  delimiter?: string;
  /** Record separator. Default `\r\n` (RFC 4180). */
  lineEnding?: string;
  /** Prefix the output with a UTF-8 byte order mark (helps Excel detect UTF-8). */
  bom?: boolean;
  /** Quote every field, not only those that need it. */
  quoteAll?: boolean;
}

const BOM = '﻿';

export function parseCsv(text: string, options: CsvParseOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ',';
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new Error(`Invalid CSV delimiter: ${JSON.stringify(delimiter)}`);
  }
  const input = text.startsWith(BOM) ? text.slice(1) : text;

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let i = 0;
  // True once the current record has any content (so a trailing newline does
  // not create an empty record, but an empty line in the middle does).
  let recordStarted = false;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    recordStarted = false;
  };

  // True at the first character of a field: only there does `"` open a quote.
  let atFieldStart = true;

  while (i < input.length) {
    const char = input[i];

    if (char === '"' && atFieldStart) {
      const quoted = readQuoted(input, i, delimiter);
      // Otherwise fall through and keep the quote as text.
      if (quoted.wellFormed || !options.requireWellFormedQuotes) {
        recordStarted = true;
        atFieldStart = false;
        field += quoted.value;
        i = quoted.end;
        continue;
      }
    }

    if (char === delimiter) {
      recordStarted = true;
      endField();
      atFieldStart = true;
      i++;
      continue;
    }

    if (char === '\r' || char === '\n') {
      endRecord();
      atFieldStart = true;
      i += char === '\r' && input[i + 1] === '\n' ? 2 : 1;
      continue;
    }

    recordStarted = true;
    atFieldStart = false;
    field += char;
    i++;
  }

  if (recordStarted || field !== '' || record.length > 0) endRecord();
  return records;
}

/**
 * Reads the quoted field opening at `start`. `end` is the index after the
 * closing quote (or the input length when unterminated); `wellFormed` means
 * it was closed and followed by a delimiter, line break or the end of input.
 */
function readQuoted(input: string, start: number, delimiter: string): { value: string; end: number; wellFormed: boolean } {
  let value = '';
  let i = start + 1;
  while (i < input.length) {
    if (input[i] === '"') {
      if (input[i + 1] === '"') {
        value += '"';
        i += 2;
        continue;
      }
      const next = input[i + 1];
      const wellFormed = next === undefined || next === delimiter || next === '\r' || next === '\n';
      return { value, end: i + 1, wellFormed };
    }
    value += input[i];
    i++;
  }
  return { value, end: i, wellFormed: false };
}

/** Quotes `value` when it contains the delimiter, a quote or a line break. */
export function escapeCsvField(value: string, delimiter = ',', quoteAll = false): string {
  if (quoteAll || value.includes(delimiter) || /["\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeCsv(rows: ReadonlyArray<ReadonlyArray<unknown>>, options: CsvSerializeOptions = {}): string {
  const delimiter = options.delimiter ?? ',';
  const lineEnding = options.lineEnding ?? '\r\n';
  const body = rows
    .map((row) =>
      row.map((value) => escapeCsvField(value == null ? '' : String(value), delimiter, options.quoteAll)).join(delimiter),
    )
    .join(lineEnding);
  return options.bom ? BOM + body : body;
}

/**
 * Parses tab-separated clipboard text as spreadsheet apps write it: cells
 * containing line breaks or tabs are quoted CSV-style. A field is only
 * treated as quoted when it starts with `"` *and* its closing quote ends the
 * field, so plain text that happens to start with a quote is kept as is.
 */
export function parseTsv(text: string): string[][] {
  const normalized = text.startsWith(BOM) ? text.slice(1) : text;
  if (!normalized.includes('"')) {
    const body = normalized.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    return body === '' ? [] : body.split('\n').map((line) => line.split('\t'));
  }
  return parseCsv(normalized, { delimiter: '\t', requireWellFormedQuotes: true });
}

/**
 * Serializes values as TSV for the clipboard. Fields containing a tab, line
 * break or a leading quote are quoted so `parseTsv` (and spreadsheet apps)
 * read them back as one cell.
 */
export function serializeTsv(rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const text = value == null ? '' : String(value);
          return /[\t\r\n]/.test(text) || text.startsWith('"') ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join('\t'),
    )
    .join('\n');
}
