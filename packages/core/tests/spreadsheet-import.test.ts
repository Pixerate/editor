import { describe, it, expect } from 'vitest';
import { createImportAdapterRegistry, type FileLike } from '../src/import';
import {
  SpreadsheetController,
  csvImportAdapter,
  importFileIntoSpreadsheet,
  registerSpreadsheetImportAdapters,
} from '../src/spreadsheet';

const file = (name: string, content: string, type = ''): FileLike => ({
  name,
  type,
  size: content.length,
  text: async () => content,
});

const valueAt = (ctrl: SpreadsheetController, row: number, col: number) =>
  ctrl.getCell(ctrl.document.rows[row].id, ctrl.document.columns[col].id).value;

describe('Spreadsheet import adapters', () => {
  it('registers CSV and TSV for the spreadsheet target only', () => {
    const registry = createImportAdapterRegistry();
    const unregister = registerSpreadsheetImportAdapters(registry);
    expect(registry.find({ fileName: 'data.csv' })?.id).toBe('csv');
    expect(registry.find({ fileName: 'data.tsv' })?.id).toBe('tsv');
    expect(registry.find({ mimeType: 'text/csv' })?.id).toBe('csv');
    expect(registry.find({ fileName: 'data.csv', target: 'document' })).toBeUndefined();
    expect(registry.accept('spreadsheet').split(',')).toEqual(expect.arrayContaining(['.csv', '.tsv', 'text/csv']));
    unregister();
    expect(registry.find({ fileName: 'data.csv' })).toBeUndefined();
    // Document adapters are untouched.
    expect(registry.find({ fileName: 'a.md' })?.id).toBe('markdown');
  });

  it('parses quoted CSV fields', async () => {
    const context = {
      target: 'spreadsheet',
      readText: async () => 'name,note\r\n"Smith, J","said ""hi""\nthen left"\r\n',
      readArrayBuffer: async () => new ArrayBuffer(0),
    };
    const result = await csvImportAdapter.import('', context);
    expect(result).toEqual({
      rows: [
        ['name', 'note'],
        ['Smith, J', 'said "hi"\nthen left'],
      ],
      delimiter: ',',
    });
  });

  it('imports a file into the controller at an offset as one undo step', async () => {
    const registry = createImportAdapterRegistry({ builtIns: false });
    registerSpreadsheetImportAdapters(registry);
    const ctrl = new SpreadsheetController();
    ctrl.importFromTsv('keep');

    const outcome = await importFileIntoSpreadsheet(ctrl, file('t.tsv', 'a\tb\n1\t=A3*2'), {
      registry,
      startRow: 1,
    });

    expect(outcome.adapterId).toBe('tsv');
    expect(valueAt(ctrl, 0, 0)).toBe('keep');
    expect(valueAt(ctrl, 1, 1)).toBe('b');
    expect(valueAt(ctrl, 2, 1)).toBe(2);

    ctrl.undo();
    const undone = ctrl.document.rows.length > 1 ? valueAt(ctrl, 1, 1) : '';
    expect(['', undefined]).toContain(undone);
    expect(valueAt(ctrl, 0, 0)).toBe('keep');
  });

  it('rejects files no spreadsheet adapter handles', async () => {
    const registry = createImportAdapterRegistry();
    registerSpreadsheetImportAdapters(registry);
    await expect(
      importFileIntoSpreadsheet(new SpreadsheetController(), file('a.md', '# x'), { registry }),
    ).rejects.toMatchObject({ code: 'unsupported_type' });
  });
});
