// Recalculation benchmark for large sheets. Not a CI assertion: it only runs
// with SPREADSHEET_BENCH=1 and prints a table of costs (formulas evaluated per
// edit, wall time of loads and single-cell edits). Run it with
//
//   SPREADSHEET_BENCH=1 pnpm vitest run packages/core/tests/spreadsheet-recalc.bench.test.ts
//
// SPREADSHEET_BENCH_ROWS changes the row count (default 50,000) and
// SPREADSHEET_BENCH_OUT=<file> writes the report to a file.
import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SpreadsheetController, type SpreadsheetDocument } from '../src/spreadsheet';

const ROWS = Number(process.env.SPREADSHEET_BENCH_ROWS ?? 50_000);
const FORMULAS = Number(process.env.SPREADSHEET_BENCH_FORMULAS ?? 100);

function makeDocument(rows: number, cols: number, cell: (r: number, c: number) => string | null): SpreadsheetDocument {
  const columns = Array.from({ length: cols }, (_, c) => {
    const key = String.fromCharCode(65 + c);
    return { id: `c${c}`, key, title: key, width: 100, type: 'freeform' as const };
  });
  const rowList = Array.from({ length: rows }, (_, r) => ({ id: `r${r}`, index: r, height: 32, type: 'freeform' as const }));
  const cells: SpreadsheetDocument['cells'] = {};
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const raw = cell(r, c);
      if (raw === null) continue;
      (cells[`r${r}`] ??= {})[`c${c}`] = { raw, value: raw.startsWith('=') ? raw : Number(raw) };
    }
  }
  return { id: 'bench', name: 'Bench', columns, rows: rowList, cells, createdAt: 0, updatedAt: 0 };
}

function time<T>(fn: () => T): { ms: number; result: T } {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}

/** Formulas evaluated (evaluator calls) and wall time of one edit. */
function edit(ctrl: SpreadsheetController, row: number, col: number, raw: string) {
  const spy = vi.spyOn(ctrl.evaluator, 'evaluateWithDiagnostics');
  const { ms } = time(() => ctrl.setCellValue(ctrl.document.rows[row].id, ctrl.document.columns[col].id, raw));
  const evaluated = spy.mock.calls.length;
  spy.mockRestore();
  return { ms: Math.round(ms * 10) / 10, evaluated };
}

function load(doc: SpreadsheetDocument) {
  const { ms, result } = time(() => new SpreadsheetController({ document: doc, maxHistoryBytes: 0 }));
  return { ctrl: result, ms: Math.round(ms) };
}

describe.runIf(process.env.SPREADSHEET_BENCH)('spreadsheet recalculation benchmark', () => {
  const report: Array<Record<string, unknown>> = [];

  it('SUM(A:A), SUM over a range, SUMIF and AVERAGE over 50k values', () => {
    const doc = makeDocument(ROWS, 3, (r, c) => {
      if (c === 0) return String(r % 100);
      if (c === 1 && r === 0) return '=SUM(A:A)';
      if (c === 1 && r === 1) return `=SUM(A1:A${ROWS})`;
      if (c === 1 && r === 2) return `=SUMIF(A1:A${ROWS},">50")`;
      if (c === 1 && r === 3) return '=AVERAGE(A:A)';
      if (c === 1 && r === 4) return `=COUNTIF(A1:A${ROWS},7)`;
      return null;
    });
    const { ctrl, ms } = load(doc);
    report.push({ scenario: 'aggregates: load', ms });
    report.push({ scenario: 'aggregates: edit A(mid)', ...edit(ctrl, Math.floor(ROWS / 2), 0, '1000') });
    report.push({ scenario: 'aggregates: edit unrelated C1', ...edit(ctrl, 0, 2, '5') });
    expect(ctrl.getCell('r0', 'c1').value).toBeTypeOf('number');
  });

  it('running total chain', () => {
    const doc = makeDocument(ROWS, 2, (r, c) => (c === 0 ? '1' : r === 0 ? '=A1' : `=B${r}+A${r + 1}`));
    const { ctrl, ms } = load(doc);
    report.push({ scenario: 'chain: load', ms });
    report.push({ scenario: 'chain: edit last A', ...edit(ctrl, ROWS - 1, 0, '2') });
    report.push({ scenario: 'chain: edit A1 (whole chain)', ...edit(ctrl, 0, 0, '2') });
    expect(ctrl.getCell(`r${ROWS - 1}`, 'c1').value).toBe(ROWS + 2);
  });

  it(`${FORMULAS} formulas over the same large range`, () => {
    const doc = makeDocument(ROWS, 3, (r, c) => {
      if (c === 0) return String(r % 10);
      if (c === 1 && r < FORMULAS) return `=SUM($A$1:$A$${ROWS})+${r}`;
      return null;
    });
    const { ctrl, ms } = load(doc);
    report.push({ scenario: `${FORMULAS} big ranges: load`, ms });
    report.push({ scenario: `${FORMULAS} big ranges: edit A(mid)`, ...edit(ctrl, Math.floor(ROWS / 2), 0, '3') });
    report.push({ scenario: `${FORMULAS} big ranges: edit unrelated C1`, ...edit(ctrl, 0, 2, '3') });
  });

  it('CSV import of 50k rows with formulas', () => {
    const ctrl = new SpreadsheetController({ maxHistoryBytes: 0 });
    const lines: string[] = [];
    for (let r = 0; r < ROWS; r++) lines.push(`${r},=A${r + 1}*2`);
    const { ms } = time(() => ctrl.importFromCsv(lines.join('\n')));
    report.push({ scenario: 'csv import: 2 cols', ms: Math.round(ms) });
    expect(ctrl.document.rows.length).toBe(ROWS);
  });

  it('prints the report', () => {
    const lines = report.map((r) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join('  '));
    // Vitest may swallow console output: SPREADSHEET_BENCH_OUT writes the report to a file.
    if (process.env.SPREADSHEET_BENCH_OUT) writeFileSync(process.env.SPREADSHEET_BENCH_OUT, `${lines.join('\n')}\n`);
    else console.log(lines.join('\n'));
  });
});
