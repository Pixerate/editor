/**
 * Spreadsheet clipboard formats. Copying writes three representations:
 *
 * - `text/plain`: TSV of the displayed values (pastes into any app)
 * - `text/html`: an HTML `<table>` (pastes into docs, mail, other sheets)
 * - `application/x.pixerate.spreadsheet+json`: raw inputs and formulas, so a
 *   paste into a pixerate spreadsheet is lossless; formulas are re-based to
 *   the paste position like a spreadsheet copy/paste
 *
 * Pasting prefers the custom format, then an HTML table, then TSV. All
 * functions here are pure and DOM-free.
 */
import { offsetFormulaReferences, type CellPosition } from './formula';
import { parseTsv, serializeTsv } from './csv';

export const SPREADSHEET_CLIPBOARD_MIME = 'application/x.pixerate.spreadsheet+json';

export interface SpreadsheetClipboardCell {
  raw: string; // input as typed (formula text for formulas)
  value: unknown; // displayed value
  /** Display text for `text/plain` and `text/html` (e.g. `10%` for 0.1); defaults to the value as text. Not stored in the JSON payload. */
  text?: string;
}

export interface SpreadsheetClipboardPayload {
  type: 'pixerate-spreadsheet';
  version: 1;
  /** Position of the copied block's top-left cell, used to re-base formulas. */
  origin: CellPosition;
  cells: SpreadsheetClipboardCell[][];
}

/** MIME type -> data, as written to `DataTransfer.setData`. */
export type SpreadsheetClipboardData = Record<string, string>;

/** Anything clipboard data can be read from: a `DataTransfer` or a plain record. */
export type SpreadsheetClipboardSource =
  | { getData(format: string): string }
  | Record<string, string | undefined>;

export interface ParsedSpreadsheetClipboard {
  format: 'internal' | 'html' | 'text';
  /** Raw inputs to write, row by row. */
  rows: string[][];
  /** For internal pastes: where the block was copied from. */
  origin?: CellPosition;
}

const displayText = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Serializes displayed values as an HTML table. Line breaks become `<br>`. */
export function serializeHtmlTable(values: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const body = values
    .map(
      (row) =>
        `<tr>${row.map((v) => `<td>${escapeHtml(displayText(v)).replace(/\r?\n/g, '<br>')}</td>`).join('')}</tr>`,
    )
    .join('');
  return `<table><tbody>${body}</tbody></table>`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// Private-use placeholder for line breaks while HTML whitespace is collapsed.
const LINE_BREAK = '';

function cellHtmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, LINE_BREAK)
    .replace(/<\/(p|div)\s*>/gi, LINE_BREAK)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ');
  return decodeEntities(text)
    .replace(/ /g, ' ')
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/**
 * Extracts cell texts from the first `<table>` in `html` (as written by
 * spreadsheet apps and browsers). `colspan`/`rowspan` cells are expanded with
 * blank cells so positions line up. Returns null when there is no table.
 */
export function parseHtmlTable(html: string): string[][] | null {
  const tableMatch = /<table[\s>][\s\S]*?<\/table\s*>/i.exec(html);
  if (!tableMatch) return null;
  const table = tableMatch[0];

  const rows: string[][] = [];
  // Cells still occupied by a rowspan from an earlier row: row -> cols.
  const occupied = new Map<number, Set<number>>();
  const rowPattern = /<tr[\s>]([\s\S]*?)<\/tr\s*>/gi;
  const cellPattern = /<(td|th)(\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
  let rowMatch: RegExpExecArray | null;
  let rowIndex = 0;
  while ((rowMatch = rowPattern.exec(table))) {
    const row: string[] = [];
    const taken = occupied.get(rowIndex) ?? new Set<number>();
    let col = 0;
    let cellMatch: RegExpExecArray | null;
    cellPattern.lastIndex = 0;
    while ((cellMatch = cellPattern.exec(rowMatch[1]))) {
      while (taken.has(col)) row[col++] = '';
      const attrs = cellMatch[2] ?? '';
      const colspan = Math.max(1, parseInt(/colspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? '1', 10));
      const rowspan = Math.max(1, parseInt(/rowspan\s*=\s*["']?(\d+)/i.exec(attrs)?.[1] ?? '1', 10));
      row[col] = cellHtmlToText(cellMatch[3]);
      for (let c = col; c < col + colspan; c++) {
        if (c > col) row[c] = '';
        for (let r = rowIndex + 1; r < rowIndex + rowspan; r++) {
          if (!occupied.has(r)) occupied.set(r, new Set());
          occupied.get(r)!.add(c);
        }
      }
      col += colspan;
    }
    while (taken.has(col)) row[col++] = '';
    rows.push(Array.from(row, (v) => v ?? ''));
    rowIndex++;
  }
  return rows.length > 0 ? rows : null;
}

/** Builds the three clipboard representations of a copied block. */
export function createSpreadsheetClipboardData(
  cells: SpreadsheetClipboardCell[][],
  origin: CellPosition,
): SpreadsheetClipboardData {
  const texts = cells.map((row) => row.map((cell) => cell.text ?? displayText(cell.value)));
  const payload: SpreadsheetClipboardPayload = {
    type: 'pixerate-spreadsheet',
    version: 1,
    origin,
    cells: cells.map((row) => row.map(({ raw, value }) => ({ raw, value }))),
  };
  return {
    'text/plain': serializeTsv(texts),
    'text/html': serializeHtmlTable(texts),
    [SPREADSHEET_CLIPBOARD_MIME]: JSON.stringify(payload),
  };
}

function readFormat(source: SpreadsheetClipboardSource, format: string): string {
  try {
    if (typeof (source as { getData?: unknown }).getData === 'function') {
      return (source as { getData(format: string): string }).getData(format) ?? '';
    }
    return (source as Record<string, string | undefined>)[format] ?? '';
  } catch {
    return '';
  }
}

function parsePayload(json: string): SpreadsheetClipboardPayload | null {
  try {
    const payload = JSON.parse(json);
    if (
      payload?.type !== 'pixerate-spreadsheet' ||
      !Array.isArray(payload.cells) ||
      !payload.cells.every((row: unknown) => Array.isArray(row)) ||
      typeof payload.origin?.row !== 'number' ||
      typeof payload.origin?.col !== 'number'
    ) {
      return null;
    }
    return payload as SpreadsheetClipboardPayload;
  } catch {
    return null;
  }
}

/**
 * Reads clipboard data, preferring the lossless internal format, then an
 * HTML table, then TSV text. Returns null when there is nothing to paste.
 */
export function readSpreadsheetClipboard(source: SpreadsheetClipboardSource): ParsedSpreadsheetClipboard | null {
  const payload = parsePayload(readFormat(source, SPREADSHEET_CLIPBOARD_MIME));
  if (payload) {
    return {
      format: 'internal',
      origin: payload.origin,
      rows: payload.cells.map((row) => row.map((cell) => (typeof cell?.raw === 'string' ? cell.raw : displayText(cell?.value)))),
    };
  }

  const html = readFormat(source, 'text/html');
  if (html) {
    const rows = parseHtmlTable(html);
    if (rows) return { format: 'html', rows };
  }

  const text = readFormat(source, 'text/plain');
  if (text) {
    const rows = parseTsv(text);
    if (rows.length > 0) return { format: 'text', rows };
  }
  return null;
}

/**
 * Moves formulas copied from `origin` so they keep their relative references
 * when pasted at `target`. Non-formula inputs are returned unchanged.
 */
export function rebaseClipboardRows(rows: string[][], origin: CellPosition, target: CellPosition): string[][] {
  const rowOffset = target.row - origin.row;
  const colOffset = target.col - origin.col;
  return rows.map((row) =>
    row.map((raw) => (raw.startsWith('=') ? offsetFormulaReferences(raw, rowOffset, colOffset) : raw)),
  );
}
