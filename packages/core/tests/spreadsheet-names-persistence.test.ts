import { describe, expect, it } from 'vitest';
import {
  SpreadsheetController,
  type SpreadsheetDocument,
  type SpreadsheetWorkbook
} from '../src/spreadsheet';

/** Value of `ref` (e.g. `B2`) on the active sheet. */
function valueOf(c: SpreadsheetController, ref: string): any {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const col = c.document.columns.find((x) => x.key === m[1])!;
  return c.getCell(c.document.rows[Number(m[2]) - 1].id, col.id).value;
}

function set(c: SpreadsheetController, ref: string, raw: string): void {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const col = c.document.columns.find((x) => x.key === m[1])!;
  c.setCellValue(c.document.rows[Number(m[2]) - 1].id, col.id, raw);
}

/** A controller that records the last document passed to `onDocumentChange`, as JSON (what an app saves). */
function persisting(options: ConstructorParameters<typeof SpreadsheetController>[0] = {}) {
  const saved: { doc: SpreadsheetDocument | null } = { doc: null };
  const c = new SpreadsheetController({
    ...options,
    onDocumentChange: (doc) => {
      saved.doc = JSON.parse(JSON.stringify(doc));
    }
  });
  return { c, saved };
}

const namesOf = (doc: SpreadsheetDocument | null) =>
  (doc?.names ?? []).map((n) => `${n.sheetId ? 'sheet' : 'book'}:${n.name}=${n.refersTo}`).sort();

describe('defined names in sheet documents (onDocumentChange persistence)', () => {
  it('round-trips workbook, sheet-scoped and LAMBDA names through a single saved document', () => {
    const { c, saved } = persisting();
    set(c, 'A1', '10');
    set(c, 'A2', '20');
    c.defineName('Sales', `='Sheet 1'!$A$1:$A$2`);
    c.defineName('Rate', '0.5', { comment: 'Tax' });
    c.defineName('Double', '=LAMBDA(x, x*2)');
    c.defineName('Local', '=100', { sheet: c.activeSheetId });
    set(c, 'B1', '=SUM(Sales)*Rate');
    set(c, 'B2', '=Double(Local)');
    expect(namesOf(saved.doc)).toEqual([
      'book:Double==LAMBDA(x, x*2)',
      'book:Rate==0.5',
      "book:Sales=='Sheet 1'!$A$1:$A$2",
      'sheet:Local==100'
    ]);
    expect(saved.doc!.names!.find((n) => n.name === 'Rate')?.comment).toBe('Tax');
    expect(saved.doc!.names!.find((n) => n.name === 'Local')?.sheetId).toBe(saved.doc!.id);

    const reloaded = new SpreadsheetController({ document: saved.doc! });
    expect(valueOf(reloaded, 'B1')).toBe(15);
    expect(valueOf(reloaded, 'B2')).toBe(200);
    expect(reloaded.getNames().map((n) => [n.name, n.sheetId === undefined ? 'book' : 'sheet', n.isLambda])).toEqual([
      ['Sales', 'book', false],
      ['Rate', 'book', false],
      ['Double', 'book', true],
      ['Local', 'sheet', false]
    ]);
    // The reloaded controller writes the same names back.
    expect(namesOf(reloaded.document)).toEqual(namesOf(saved.doc));
  });

  it('maps sheet-scoped names to the loaded sheet whatever their saved sheetId', () => {
    const doc: Partial<SpreadsheetDocument> = {
      id: 'mine',
      name: 'Data',
      names: [
        { name: 'Local', refersTo: '7', sheetId: 'some-old-id' },
        { name: 'Local', refersTo: '=8', sheetId: 'another' }, // duplicate: first wins
        { name: 'Book', refersTo: '=1' }
      ]
    };
    const c = new SpreadsheetController({ document: doc });
    expect(c.getNames().map((n) => [n.name, n.refersTo, n.sheetId])).toEqual([
      ['Local', '=7', 'mine'],
      ['Book', '=1', undefined]
    ]);
  });

  it('fires onDocumentChange with the current names after define, rename, delete, undo and redo', () => {
    const { c, saved } = persisting();
    c.defineName('Rate', '=0.1');
    expect(namesOf(saved.doc)).toEqual(['book:Rate==0.1']);
    c.defineName('Local', '=5', { sheet: c.activeSheetId });
    expect(namesOf(saved.doc)).toEqual(['book:Rate==0.1', 'sheet:Local==5']);
    c.renameName('Rate', 'TaxRate');
    expect(namesOf(saved.doc)).toEqual(['book:TaxRate==0.1', 'sheet:Local==5']);
    c.deleteName('Local', { sheet: c.activeSheetId });
    expect(namesOf(saved.doc)).toEqual(['book:TaxRate==0.1']);
    c.undo();
    expect(namesOf(saved.doc)).toEqual(['book:TaxRate==0.1', 'sheet:Local==5']);
    c.undo();
    expect(namesOf(saved.doc)).toEqual(['book:Rate==0.1', 'sheet:Local==5']);
    c.redo();
    expect(namesOf(saved.doc)).toEqual(['book:TaxRate==0.1', 'sheet:Local==5']);
    c.deleteName('TaxRate');
    c.deleteName('Local', { sheet: c.activeSheetId });
    // No names: the field is left out.
    expect(saved.doc && 'names' in saved.doc).toBe(false);
    expect(c.document.names).toBeUndefined();
  });

  it('keeps the live document in sync for bindings that copy `controller.document`', () => {
    const c = new SpreadsheetController();
    c.defineName('Rate', '=0.2');
    expect(c.document.names).toEqual([{ name: 'Rate', refersTo: '=0.2' }]);
    // Copies: editing the document's list does not change the controller's names.
    c.document.names![0].refersTo = '=9';
    expect(c.getName('Rate')?.refersTo).toBe('=0.2');
  });

  it('loads old documents without names unchanged', () => {
    const old: SpreadsheetDocument = {
      id: 'old',
      name: 'Old',
      columns: [{ id: 'col_a', key: 'A', title: 'A', type: 'freeform' }],
      rows: [{ id: 'row_1', index: 0, type: 'freeform' }],
      cells: { row_1: { col_a: { raw: '=Rate', value: '' } } }
    };
    const c = new SpreadsheetController({ document: old });
    expect(c.getNames()).toEqual([]);
    expect(c.document.names).toBeUndefined();
    expect(valueOf(c, 'A1')).toBe('#NAME?');
    // loadDocument of an old document keeps the controller's names.
    c.defineName('Rate', '=3');
    c.loadDocument(old);
    expect(c.getNames().map((n) => n.name)).toEqual(['Rate']);
    expect(valueOf(c, 'A1')).toBe(3);
  });

  it('loadDocument replaces the names when the document has them', () => {
    const { c: source, saved } = persisting();
    source.defineName('Rate', '=0.5');
    source.defineName('Local', '=2', { sheet: source.activeSheetId });

    const c = new SpreadsheetController();
    c.defineName('Stale', '=1');
    c.defineName('Mine', '=1', { sheet: c.activeSheetId });
    c.loadDocument(saved.doc!);
    expect(c.getNames().map((n) => [n.name, n.sheetId === c.activeSheetId])).toEqual([
      ['Rate', false],
      ['Local', true]
    ]);
  });

  it('loadDocument into one sheet of several merges its workbook names', () => {
    const c = new SpreadsheetController();
    c.addSheet({ name: 'Other', activate: false });
    c.defineName('Kept', '=1');
    c.defineName('Rate', '=1');
    c.defineName('OtherLocal', '=1', { sheet: 'Other' });
    c.loadDocument({
      ...c.document,
      names: [
        { name: 'Rate', refersTo: '=2' },
        { name: 'Local', refersTo: '=3', sheetId: 'x' }
      ]
    });
    expect(c.getNames().map((n) => `${n.sheetName ?? 'book'}:${n.name}=${n.refersTo}`).sort()).toEqual([
      'Other:OtherLocal==1',
      'Sheet 1:Local==3',
      'book:Kept==1',
      'book:Rate==2'
    ]);
  });

  it('addSheet({ document }) brings the document’s names, keeping existing workbook names', () => {
    const c = new SpreadsheetController();
    c.defineName('Rate', '=1');
    const id = c.addSheet({
      name: 'Imported',
      document: { names: [{ name: 'Rate', refersTo: '=2' }, { name: 'New', refersTo: '=3' }, { name: 'Lx', refersTo: '=4', sheetId: 'old' }] }
    });
    expect(c.getNames().map((n) => [n.name, n.refersTo, n.sheetId])).toEqual([
      ['Rate', '=1', undefined],
      ['New', '=3', undefined],
      ['Lx', '=4', id]
    ]);
  });

  it('every sheet document carries the workbook names and only its own sheet-scoped names', () => {
    const c = new SpreadsheetController();
    const first = c.activeSheetId;
    const second = c.addSheet({ name: 'Two' });
    c.defineName('Book', '=1');
    c.defineName('LocalOne', '=1', { sheet: first });
    c.defineName('LocalTwo', '=2', { sheet: second });
    expect(namesOf(c.getSheetDocument(first)!)).toEqual(['book:Book==1', 'sheet:LocalOne==1']);
    expect(namesOf(c.getSheetDocument(second)!)).toEqual(['book:Book==1', 'sheet:LocalTwo==2']);
    // Deleting a sheet drops its names from the others too (they never had them).
    c.deleteSheet(second);
    expect(namesOf(c.document)).toEqual(['book:Book==1', 'sheet:LocalOne==1']);
  });
});

describe('defined names in workbooks', () => {
  function buildWorkbook() {
    const c = new SpreadsheetController();
    const first = c.activeSheetId;
    const second = c.addSheet({ name: 'Data', activate: false });
    c.defineName('Rate', '=0.5');
    c.defineName('Twice', '=LAMBDA(x, x*2)');
    c.defineName('Local', '=10', { sheet: second });
    set(c, 'A1', '=Twice(Rate)+Data!Local');
    return { c, first, second };
  }

  it('getWorkbook() keeps names in `names` only, as before', () => {
    const { c, first, second } = buildWorkbook();
    const wb = c.getWorkbook();
    expect(wb.sheets.every((s) => !('names' in s))).toBe(true);
    expect(wb.names).toEqual([
      { name: 'Rate', refersTo: '=0.5' },
      { name: 'Twice', refersTo: '=LAMBDA(x, x*2)' },
      { name: 'Local', refersTo: '=10', sheetId: second }
    ]);
    expect(wb.sheets.map((s) => s.id)).toEqual([first, second]);
    const reloaded = new SpreadsheetController({ workbook: wb });
    expect(valueOf(reloaded, 'A1')).toBe(11);
    expect(reloaded.getNames()).toEqual(c.getNames());
    // Undo history snapshots don't repeat the names per sheet either.
    const other = new SpreadsheetController();
    other.loadWorkbook(wb);
    expect(other.getNames()).toEqual(c.getNames());
  });

  it('loads old saved workbooks that have `names` only', () => {
    const wb: SpreadsheetWorkbook = {
      sheets: [
        { id: 's1', name: 'One', columns: [{ id: 'a', key: 'A', title: 'A', type: 'freeform' }], rows: [{ id: 'r1', index: 0, type: 'freeform' }], cells: { r1: { a: { raw: '=Rate+Local', value: '' } } } }
      ],
      names: [
        { name: 'Rate', refersTo: '1' },
        { name: 'Local', refersTo: '=2', sheetId: 's1' }
      ]
    };
    const c = new SpreadsheetController({ workbook: wb });
    expect(valueOf(c, 'A1')).toBe(3);
    expect(namesOf(c.document)).toEqual(['book:Rate==1', 'sheet:Local==2']);
    // The caller's sheet objects don't get a `names` copy written into them.
    expect('names' in wb.sheets[0]).toBe(false);
  });

  it('workbook.names wins over sheet documents, and names only in documents are added once', () => {
    const wb: SpreadsheetWorkbook = {
      sheets: [
        {
          id: 's1', name: 'One', columns: [], rows: [], cells: {},
          names: [
            { name: 'Rate', refersTo: '=99' }, // stale copy: workbook.names wins
            { name: 'FromDoc', refersTo: '=1' },
            { name: 'Local', refersTo: '=5', sheetId: 's1' }
          ]
        },
        {
          id: 's2', name: 'Two', columns: [], rows: [], cells: {},
          names: [
            { name: 'FromDoc', refersTo: '=2' }, // the first sheet's copy wins
            { name: 'Local', refersTo: '=6', sheetId: 'whatever' } // this sheet's own
          ]
        }
      ],
      names: [
        { name: 'Rate', refersTo: '=0.5' },
        { name: 'Local', refersTo: '=7', sheetId: 's1' }
      ]
    };
    const c = new SpreadsheetController();
    c.loadWorkbook(wb);
    expect(c.getNames().map((n) => `${n.sheetId ?? 'book'}:${n.name}=${n.refersTo}`)).toEqual([
      'book:Rate==0.5',
      's1:Local==7',
      'book:FromDoc==1',
      's2:Local==6'
    ]);
    // The input wasn't modified.
    expect(wb.sheets[0].names![0].refersTo).toBe('=99');
  });

  it('a workbook assembled from documents saved by onDocumentChange restores the names', () => {
    const { c } = buildWorkbook();
    const docs: SpreadsheetDocument[] = [];
    for (const s of c.getSheets()) docs.push(JSON.parse(JSON.stringify(c.getSheetDocument(s.id))));
    const reloaded = new SpreadsheetController({ workbook: { sheets: docs } });
    expect(reloaded.getNames()).toEqual(c.getNames());
    expect(valueOf(reloaded, 'A1')).toBe(11);
  });

  it('undoing a sheet edit after a name change does not bring back stale names', () => {
    const { c, saved } = persisting();
    set(c, 'A1', '1');
    c.defineName('Rate', '=1');
    set(c, 'A1', '2');
    c.deleteName('Rate');
    c.undo(); // name back
    c.undo(); // cell back; the name stays
    expect(c.getNames().map((n) => n.name)).toEqual(['Rate']);
    expect(namesOf(saved.doc)).toEqual(['book:Rate==1']);
    c.undo(); // name gone
    expect(c.getNames()).toEqual([]);
    expect(saved.doc && 'names' in saved.doc).toBe(false);
  });
});
