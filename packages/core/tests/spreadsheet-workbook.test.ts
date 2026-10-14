// Cases re-expressed from gridcraft/crates/engine/src/tests.rs, calc/src/tests.rs,
// formula/src/tests.rs and model/src/workbook.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it, vi } from 'vitest';
import {
  SpreadsheetController,
  copySheetName,
  deleteSheetInFormula,
  nextSheetName,
  parseFormula,
  quoteSheetName,
  renameNameInFormula,
  renameSheetInFormula,
  shiftFormulaReferences,
  tokenizeFormula,
  validateDefinedName,
  validateSheetName,
  applyFormulaSuggestion,
  getFormulaHints,
  getNameManagerRows,
  getSheetTabMenuItems,
  runSpreadsheetMenuItem,
  sheetDropIndex,
  type SpreadsheetWorkbook,
} from '../src/spreadsheet';
import { measureGrowth } from './helpers/growth';

/** Value of `ref` (e.g. `B2`) on the active sheet, or on `sheet`. */
function valueOf(c: SpreadsheetController, ref: string, sheet?: string): any {
  const doc = sheet ? c.getSheetDocument(sheet)! : c.document;
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const col = doc.columns.find((x) => x.key === m[1])!;
  const row = doc.rows[Number(m[2]) - 1];
  if (sheet && sheet !== c.activeSheetId && doc !== c.document) {
    const active = c.activeSheetId;
    c.setActiveSheet(sheet);
    const v = c.getCell(row.id, col.id).value;
    c.setActiveSheet(active);
    return v;
  }
  return c.getCell(row.id, col.id).value;
}

function rawOf(c: SpreadsheetController, ref: string, sheet?: string): string {
  const doc = sheet ? c.getSheetDocument(sheet)! : c.document;
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const col = doc.columns.find((x) => x.key === m[1])!;
  const row = doc.rows[Number(m[2]) - 1];
  return doc.cells[row.id]?.[col.id]?.raw ?? '';
}

/** Sets `ref` on the active sheet. */
function set(c: SpreadsheetController, ref: string, raw: string): void {
  const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const col = c.document.columns.find((x) => x.key === m[1])!;
  c.setCellValue(c.document.rows[Number(m[2]) - 1].id, col.id, raw);
}

/** Sets `ref` on `sheet`, then comes back to the previously active sheet. */
function setOn(c: SpreadsheetController, sheet: string, ref: string, raw: string): void {
  const active = c.activeSheetId;
  c.setActiveSheet(sheet);
  set(c, ref, raw);
  c.setActiveSheet(active);
}

describe('formula syntax for sheets', () => {
  it('tokenizes sheet-qualified, quoted and 3-D references', () => {
    const tokens = tokenizeFormula("=Sheet2!A1+'My Sheet'!B2:C3+'Bob''s'!A1#+Sheet1:Sheet3!D4+Data!Rate+A1!=1");
    const refs = tokens.filter((t) => t.sheet !== undefined).map((t) => [t.type, t.value, t.sheet, t.sheetEnd]);
    expect(refs).toEqual([
      ['CELL_REF', 'A1', 'Sheet2', undefined],
      ['RANGE', 'B2:C3', 'My Sheet', undefined],
      ['SPILL_REF', 'A1', "Bob's", undefined],
      ['CELL_REF', 'D4', 'Sheet1', 'Sheet3'],
      ['IDENTIFIER', 'RATE', 'Data', undefined],
    ]);
    // `A1!=1` is still a comparison, and single-quoted strings still work.
    expect(tokens.slice(-4).map((t) => t.type)).toEqual(['CELL_REF', 'OPERATOR', 'NUMBER', 'EOF']);
    expect(parseFormula("='abc'&\"d\"")).toMatchObject({ type: 'BinaryOp', left: { type: 'Literal', value: 'abc' } });
    expect(parseFormula("='Q1:Q4'!A1")).toMatchObject({ type: 'CellRef', sheet: 'Q1', sheetEnd: 'Q4' });
  });

  it('tokenizes input full of apostrophes in linear time', { timeout: 30_000 }, () => {
    const scan = (formula: string) => () => {
      try {
        tokenizeFormula(formula);
      } catch {
        // Unterminated strings are expected; only the scan time matters.
      }
    };
    // Linear: 4× the input takes about 4× the time (quadratic would be 16×).
    const ratio = measureGrowth(scan(`=${"'a''".repeat(20_000)}`), scan(`=${"'a''".repeat(80_000)}`), { limit: 10 });
    expect(ratio).toBeLessThan(10);
  });

  it('quotes sheet names that need it', () => {
    expect(quoteSheetName('Data')).toBe('Data');
    expect(quoteSheetName('My Data')).toBe("'My Data'");
    expect(quoteSheetName("It's")).toBe("'It''s'");
    expect(quoteSheetName('A1')).toBe("'A1'");
    expect(quoteSheetName('R1C1')).toBe("'R1C1'");
    expect(quoteSheetName('2024')).toBe("'2024'");
    expect(quoteSheetName('TRUE')).toBe("'TRUE'");
  });

  it('rewrites sheet names on rename (gridcraft moves_and_renames, rename_sheet_updates_qualified_names)', () => {
    expect(renameSheetInFormula("=Old!A1+'Old'!B2", 'Old', 'New Name')).toBe("='New Name'!A1+'New Name'!B2");
    expect(renameSheetInFormula('=Data!MyName+MyName+Other!MyName', 'data', 'Numbers')).toBe('=Numbers!MyName+MyName+Other!MyName');
    expect(renameSheetInFormula("=Data!MyName", 'Data', "It's")).toBe("='It''s'!MyName");
    expect(renameSheetInFormula("='It''s'!MyName", "It's", 'Totals')).toBe('=Totals!MyName');
    expect(renameSheetInFormula('=SUM(Sheet1:Sheet3!A1)', 'Sheet3', 'End')).toBe('=SUM(Sheet1:End!A1)');
    expect(renameSheetInFormula('="Old!A1"&A1', 'Old', 'New')).toBe('="Old!A1"&A1');
  });

  it('turns references to a deleted sheet into #REF! and shrinks 3-D spans (gridcraft delete_sheet_shrinks_3d_span)', () => {
    const order = ['Sheet1', 'Sheet2', 'Sheet3', 'Results'];
    const del = (f: string, n: string) => deleteSheetInFormula(f, n, order);
    expect(del('=SUM(Sheet1:Sheet3!A1)', 'Sheet1')).toBe('=SUM(Sheet2:Sheet3!A1)');
    expect(del('=SUM(Sheet1:Sheet3!A1)', 'Sheet3')).toBe('=SUM(Sheet1:Sheet2!A1)');
    expect(del('=SUM(Sheet3:Sheet1!A1)', 'Sheet1')).toBe('=SUM(Sheet3:Sheet2!A1)');
    expect(del('=SUM(Sheet1:Sheet3!A1)', 'Sheet2')).toBe('=SUM(Sheet1:Sheet3!A1)');
    expect(del('=SUM(Sheet1:Sheet2!A1)', 'Sheet1')).toBe('=SUM(Sheet2!A1)');
    expect(del('=Sheet1!A1+Sheet3!A1', 'Sheet1')).toBe('=#REF!+Sheet3!A1');
    expect(del('=SUM(Data!A1#)', 'Data')).toBe('=SUM(#REF!)');
  });

  it('shifts only references to the changed sheet when asked', () => {
    const change = { axis: 'row' as const, index: 0, type: 'insert' as const };
    expect(shiftFormulaReferences('=A1+Data!A1', change)).toBe('=A2+Data!A2');
    expect(shiftFormulaReferences('=A1+Data!A1', change, { appliesTo: (sheet) => sheet === 'Data' })).toBe('=A1+Data!A2');
    expect(shiftFormulaReferences("='My Data'!A1:B2", change)).toBe("='My Data'!A2:B3");
    expect(shiftFormulaReferences('=Data!A1', { axis: 'row', index: 0, type: 'delete' })).toBe('=#REF!');
  });

  it('renames defined names in formulas', () => {
    expect(renameNameInFormula('=Price*2+Data!Price+"Price"+PRICE(1)', 'price', 'Cost')).toBe('=Cost*2+Data!Cost+"Price"+Cost(1)');
    expect(renameNameInFormula('=Price+Data!Price', 'Price', 'Cost', { qualifiedOnly: true })).toBe('=Price+Data!Cost');
  });
});

describe('sheet and name validation', () => {
  it('validates sheet names like Excel (gridcraft sheet_names)', () => {
    expect(validateSheetName('sheet1', ['Sheet1'])).toMatch(/taken/);
    expect(validateSheetName('Sheet1', [])).toBeNull();
    expect(validateSheetName('a/b')).toMatch(/characters/);
    expect(validateSheetName('x'.repeat(32))).toMatch(/31/);
    expect(validateSheetName('Budget 2026')).toBeNull();
    expect(validateSheetName("'quoted")).toMatch(/apostrophe/);
    expect(validateSheetName('')).toMatch(/blank/);
    expect(validateSheetName('history')).toMatch(/reserved/);
    expect(nextSheetName(['Sheet 1', 'Sheet 3'])).toBe('Sheet 2');
    expect(copySheetName('Data', ['Data', 'Data (2)'])).toBe('Data (3)');
    expect(copySheetName('Long name of a sheet 31 chars!', [])).toBe('Long name of a sheet 31 cha (2)');
  });

  it('refuses names that look like references (gridcraft names_that_look_like_references_are_refused)', () => {
    for (const bad of ['R1C1', 'r2', 'C3', 'RC', 'R', 'c', 'rc12', 'A1', 'XFD1048576', '1st', 'TAX2024', 'TRUE', 'a b', '']) {
      expect(validateDefinedName(bad), bad).not.toBeNull();
    }
    for (const good of ['R1C1X', 'Rate', 'RCx', 'Rx', '_R1', 'Cost', 'tax.rate', '\\path', 'Größe', 'ABCDE']) {
      expect(validateDefinedName(good), good).toBeNull();
    }
  });
});

describe('workbook with several sheets', () => {
  it('keeps the single-sheet API: a controller is a workbook with one sheet', () => {
    const c = new SpreadsheetController();
    expect(c.getSheets()).toEqual([{ id: c.document.id, name: 'Sheet 1', index: 0, active: true }]);
    expect(c.activeSheetId).toBe(c.document.id);
    expect(c.deleteSheet(c.activeSheetId)).toBe(false);
    set(c, 'A1', '2');
    set(c, 'A2', '=A1*3');
    expect(valueOf(c, 'A2')).toBe(6);
  });

  it('evaluates cross-sheet references and recalculates across sheets (gridcraft sheets, names_and_sheets)', () => {
    const c = new SpreadsheetController();
    const first = c.activeSheetId;
    const data = c.addSheet({ name: 'Data' });
    expect(c.activeSheetId).toBe(data);
    set(c, 'A1', '5');
    c.setActiveSheet(first);
    set(c, 'A1', '=Data!A1*2');
    expect(valueOf(c, 'A1')).toBe(10);
    setOn(c, 'Data', 'A1', '8');
    expect(valueOf(c, 'A1')).toBe(16);
    c.renameSheet('Data', 'My Data');
    expect(rawOf(c, 'A1')).toBe("='My Data'!A1*2");
    expect(valueOf(c, 'A1')).toBe(16);
    set(c, 'A2', "=SUM('My Data'!A1:B3)+'my data'!A1");
    expect(valueOf(c, 'A2')).toBe(16);
  });

  it('reports #REF! for missing sheets until one with that name exists', () => {
    const c = new SpreadsheetController();
    set(c, 'A1', '=Later!B2+1');
    expect(valueOf(c, 'A1')).toBe('#REF!');
    expect(c.document.cells[c.document.rows[0].id][c.document.columns[0].id].errorMessage).toMatch(/sheet that doesn't exist/);
    c.addSheet({ name: 'Later', activate: false });
    expect(valueOf(c, 'A1')).toBe(1);
  });

  it('finds circular references across sheets', () => {
    const c = new SpreadsheetController();
    const first = c.activeSheetId;
    c.addSheet({ name: 'Other' });
    set(c, 'A1', `='Sheet 1'!A1+1`);
    c.setActiveSheet(first);
    set(c, 'A1', '=Other!A1+1');
    expect(valueOf(c, 'A1')).toBe('#CYCLE!');
    expect(valueOf(c, 'A1', 'Other')).toBe('#CYCLE!');
  });

  it('sums 3-D references and follows sheet moves and deletion (gridcraft deleting_a_3d_span_end_sheet_keeps_the_rest)', () => {
    const book = () => {
      const c = new SpreadsheetController({ document: { name: 'Sheet1' } });
      for (const name of ['Sheet2', 'Sheet3', 'Results']) c.addSheet({ name });
      [['Sheet1', 3], ['Sheet2', 5], ['Sheet3', 7]].forEach(([sheet, n]) => setOn(c, sheet as string, 'A1', String(n)));
      c.setActiveSheet('Results');
      set(c, 'A1', '=SUM(Sheet1:Sheet3!A1)');
      set(c, 'B1', '=Sheet1!A1');
      return c;
    };
    expect(valueOf(book(), 'A1')).toBe(15);
    for (const [deleted, total, direct] of [['Sheet1', 12, '#REF!'], ['Sheet3', 8, 3], ['Sheet2', 10, 3]] as const) {
      const c = book();
      expect(c.deleteSheet(deleted)).toBe(true);
      c.setActiveSheet('Results');
      expect(valueOf(c, 'A1'), deleted).toBe(total);
      expect(valueOf(c, 'B1'), deleted).toBe(direct);
    }
    const c = book();
    c.moveSheet('Sheet3', 3); // Sheet1, Sheet2, Results, Sheet3: the span now covers Results.
    expect(c.getSheets().map((s) => s.name)).toEqual(['Sheet1', 'Sheet2', 'Results', 'Sheet3']);
    c.setActiveSheet('Results');
    set(c, 'A2', '=SUM(Sheet1:Sheet2!A1)');
    expect(valueOf(c, 'A2')).toBe(8);
  });

  it('rewrites references from other sheets when rows and columns are inserted or deleted', () => {
    const c = new SpreadsheetController();
    const first = c.activeSheetId;
    c.addSheet({ name: 'Data' });
    set(c, 'A5', '42');
    set(c, 'B1', '=A5');
    c.setActiveSheet(first);
    set(c, 'A1', '=Data!A5+A5');
    c.setActiveSheet('Data');
    c.insertRow(0);
    expect(rawOf(c, 'B2', 'Data')).toBe('=A6');
    c.setActiveSheet(first);
    expect(rawOf(c, 'A1')).toBe('=Data!A6+A5');
    expect(valueOf(c, 'A1')).toBe(42);
    c.setActiveSheet('Data');
    c.deleteRow(c.document.rows[5].id);
    c.setActiveSheet(first);
    expect(rawOf(c, 'A1')).toBe('=#REF!+A5');
  });

  it('keeps each sheet’s selection and spills, and reads spills across sheets', () => {
    const c = new SpreadsheetController();
    const first = c.activeSheetId;
    c.selectCell(2, 1);
    c.addSheet({ name: 'Arr' });
    expect(c.activeCell).toBeNull();
    set(c, 'A1', '=SEQUENCE(3)');
    expect(c.getSpills()).toHaveLength(1);
    c.selectCell(1, 0);
    c.setActiveSheet(first);
    expect(c.activeCell).toMatchObject({ row: 2, col: 1 });
    expect(c.getSpills()).toHaveLength(0);
    set(c, 'A1', '=SUM(Arr!A1#)');
    expect(valueOf(c, 'A1')).toBe(6);
    setOn(c, 'Arr', 'A1', '=SEQUENCE(4)');
    expect(valueOf(c, 'A1')).toBe(10);
    c.setActiveSheet('Arr');
    expect(c.activeCell).toMatchObject({ row: 1, col: 0 });
  });

  it('duplicates sheets with their names and refuses to delete the last one (gridcraft sheet_operations_keep_names_on_their_sheets)', () => {
    const c = new SpreadsheetController({ document: { name: 'Sheet1' } });
    c.addSheet({ name: 'Data' });
    c.addSheet({ name: 'Notes' });
    c.defineName('Rate', '=Data!$A$1', { sheet: 'Data' });
    c.defineName('Rate', '=Notes!$B$1', { sheet: 'Notes' });
    c.defineName('Total', '=Data!$C$1');
    const names = () =>
      c
        .getNames()
        .map((n) => [n.name, n.sheetName ?? null, n.refersTo])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : (a[1] ?? '') < (b[1] ?? '') ? -1 : 1));
    c.moveSheet('Data', 2);
    expect(names()).toEqual([
      ['Rate', 'Data', '=Data!$A$1'],
      ['Rate', 'Notes', '=Notes!$B$1'],
      ['Total', null, '=Data!$C$1'],
    ]);
    const copy = c.duplicateSheet('Data', { index: 0 })!;
    expect(c.getSheets()[0]).toMatchObject({ id: copy, name: 'Data (2)', active: true });
    expect(names()).toEqual([
      ['Rate', 'Data', '=Data!$A$1'],
      ['Rate', 'Data (2)', "='Data (2)'!$A$1"],
      ['Rate', 'Notes', '=Notes!$B$1'],
      ['Total', null, '=Data!$C$1'],
    ]);
    c.deleteSheet('Data');
    expect(names()).toEqual([
      ['Rate', 'Data (2)', "='Data (2)'!$A$1"],
      ['Rate', 'Notes', '=Notes!$B$1'],
      ['Total', null, '=#REF!'],
    ]);
    expect(c.deleteName('rate', { sheet: 'Notes' })).toBe(true);
    expect(c.deleteName('Total', { sheet: 'Notes' })).toBe(false);
    expect(c.deleteName('Total')).toBe(true);
    expect(c.getNames()).toHaveLength(1);
    expect(() => c.addSheet({ name: 'notes' })).toThrow(/taken/);
    expect(() => c.renameSheet('Notes', 'a/b')).toThrow(/characters/);
    c.deleteSheet('Notes');
    c.deleteSheet('Sheet1');
    expect(c.getSheets()).toHaveLength(1);
    expect(c.deleteSheet('Data (2)')).toBe(false);
  });

  it('undoes per sheet, showing the sheet the step belongs to, and undoes sheet operations', () => {
    const c = new SpreadsheetController();
    const first = c.activeSheetId;
    set(c, 'A1', 'one');
    const second = c.addSheet({ name: 'Two' });
    set(c, 'A1', 'two');
    c.setActiveSheet(first);
    c.undo(); // the edit on Two
    expect(c.activeSheetId).toBe(second);
    expect(valueOf(c, 'A1')).toBe('');
    c.undo(); // addSheet
    expect(c.getSheets().map((s) => s.name)).toEqual(['Sheet 1']);
    expect(valueOf(c, 'A1')).toBe('one');
    c.redo();
    expect(c.getSheets().map((s) => s.name)).toEqual(['Sheet 1', 'Two']);
    c.redo();
    expect(valueOf(c, 'A1', 'Two')).toBe('two');
    c.deleteSheet('Two');
    expect(c.getSheets()).toHaveLength(1);
    c.undo();
    expect(c.getSheets()).toHaveLength(2);
    expect(valueOf(c, 'A1', 'Two')).toBe('two');
    c.renameSheet('Two', 'Second');
    c.undo();
    expect(c.getSheets()[1].name).toBe('Two');
  });

  it('imports CSV into a chosen sheet', () => {
    const c = new SpreadsheetController();
    c.addSheet({ name: 'Import', activate: false });
    c.importFromCsv('a,b\n1,2', { sheet: 'Import' });
    expect(valueOf(c, 'A1')).toBe('');
    expect(valueOf(c, 'B2', 'Import')).toBe(2);
    c.importRows([['x']], { sheet: 'Import', startRow: 3 });
    expect(valueOf(c, 'A4', 'Import')).toBe('x');
    expect(() => c.importRows([['x']], { sheet: 'Nope' })).toThrow(/no sheet/);
  });

  it('round-trips workbooks and reports workbook changes', () => {
    const onWorkbookChange = vi.fn();
    const c = new SpreadsheetController({ onWorkbookChange });
    c.addSheet({ name: 'Data' });
    set(c, 'A1', '4');
    c.defineName('Four', '=Data!$A$1');
    expect(onWorkbookChange).toHaveBeenCalled();
    const saved = c.getWorkbook();
    expect(saved.sheets.map((s) => s.name)).toEqual(['Sheet 1', 'Data']);
    expect(saved.names).toEqual([{ name: 'Four', refersTo: '=Data!$A$1' }]);

    const workbook: SpreadsheetWorkbook = JSON.parse(JSON.stringify(saved));
    workbook.activeSheetId = workbook.sheets[0].id;
    const d = new SpreadsheetController({ workbook });
    expect(d.getSheets().map((s) => [s.name, s.active])).toEqual([['Sheet 1', true], ['Data', false]]);
    set(d, 'B1', '=Four*Data!A1');
    expect(valueOf(d, 'B1')).toBe(16);
    d.loadWorkbook({ sheets: [{ ...workbook.sheets[1], name: 'Only' }] });
    expect(d.getSheets().map((s) => s.name)).toEqual(['Only']);
    expect(d.getNames()).toEqual([]);
  });
});

describe('defined names', () => {
  it('evaluates names for ranges, constants, formulas and lambdas', () => {
    const c = new SpreadsheetController();
    set(c, 'A1', '10');
    set(c, 'A2', '20');
    c.defineName('Sales', `='Sheet 1'!$A$1:$A$2`);
    c.defineName('Rate', '0.5');
    c.defineName('Half', '=SUM(Sales)*Rate');
    c.defineName('Double', '=LAMBDA(x, x*2)');
    c.defineName('Quad', '=LAMBDA(x,Double(Double(x)))');
    set(c, 'B1', '=SUM(Sales)');
    set(c, 'B2', '=Half');
    set(c, 'B3', '=double(4)+Quad(1)+sum(1)');
    expect([valueOf(c, 'B1'), valueOf(c, 'B2'), valueOf(c, 'B3')]).toEqual([30, 15, 13]);
    // Editing a cell a name refers to recalculates the formulas using the name.
    set(c, 'A1', '30');
    expect([valueOf(c, 'B1'), valueOf(c, 'B2')]).toEqual([50, 25]);
    // Redefining a name recalculates them too.
    c.defineName('Rate', '=0.1');
    expect(valueOf(c, 'B2')).toBe(5);
    expect(c.evaluateFormula('=Half*2').value).toBe(10);
    expect(c.getNames().find((n) => n.name === 'Double')?.isLambda).toBe(true);
  });

  it('defines recursive named lambdas, capped with #NUM!', () => {
    const c = new SpreadsheetController();
    c.defineName('Fact', '=LAMBDA(n, IF(n<=1, 1, n*Fact(n-1)))');
    c.defineName('Forever', '=LAMBDA(n, Forever(n+1))');
    set(c, 'A1', '=Fact(6)');
    set(c, 'A2', '=Forever(1)');
    set(c, 'A3', '=Fact');
    expect(valueOf(c, 'A1')).toBe(720);
    expect(valueOf(c, 'A2')).toBe('#NUM!');
    expect(valueOf(c, 'A3')).toBe('#CALC!');
  });

  it('scopes names to sheets, sheet names first (gridcraft names_and_sheets)', () => {
    const c = new SpreadsheetController({ document: { name: 'Sheet1' } });
    const first = c.activeSheetId;
    c.addSheet({ name: 'Data' });
    set(c, 'A1', '8');
    set(c, 'B1', '100');
    c.defineName('Rate', '=0.5');
    c.defineName('Rate', '=B1', { sheet: 'Data' }); // unqualified: Data!B1
    set(c, 'C1', '=Rate*2');
    c.setActiveSheet(first);
    set(c, 'A1', '=Rate*Data!A1');
    set(c, 'A2', '=Data!Rate');
    expect(valueOf(c, 'A1')).toBe(4);
    expect(valueOf(c, 'A2')).toBe(100);
    expect(valueOf(c, 'C1', 'Data')).toBe(200);
    setOn(c, 'Data', 'A1', '10');
    expect(valueOf(c, 'A1')).toBe(5);
    setOn(c, 'Data', 'B1', '7');
    expect(valueOf(c, 'A2')).toBe(7);
    expect(c.getNameSuggestions().map((n) => n.description)).toEqual(['=0.5']);
  });

  it('renames names in formulas and refuses collisions (gridcraft editing_a_name_renames_it_in_formulas)', () => {
    const c = new SpreadsheetController({ document: { name: 'Sheet1' } });
    set(c, 'A1', '21');
    c.defineName('Price', '=Sheet1!$A$1');
    c.defineName('Other', '=1');
    c.defineName('Twice', '=Price*2');
    set(c, 'B1', '=Price*2');
    expect(() => c.renameName('Price', 'Other')).toThrow(/already exists/);
    expect(() => c.renameName('Price', 'A1')).toThrow(/cell reference/);
    expect(() => c.renameName('Missing', 'X')).toThrow(/no name/);
    c.renameName('Price', 'Cost');
    expect(c.getNames().map((n) => n.name)).toEqual(['Cost', 'Other', 'Twice']);
    expect(rawOf(c, 'B1')).toBe('=Cost*2');
    expect(c.getName('Twice')?.refersTo).toBe('=Cost*2');
    expect(valueOf(c, 'B1')).toBe(42);
    c.undo();
    expect(rawOf(c, 'B1')).toBe('=Price*2');
  });

  it('shows #NAME? once a name is deleted, and validates definitions', () => {
    const c = new SpreadsheetController();
    c.defineName('Rate', '=0.2');
    set(c, 'A1', '=Rate*10');
    expect(valueOf(c, 'A1')).toBe(2);
    c.deleteName('Rate');
    expect(valueOf(c, 'A1')).toBe('#NAME?');
    expect(() => c.defineName('R1C1', '=1')).toThrow(/R1C1/);
    expect(() => c.defineName('Ok', '=SUM(')).toThrow(/problem/);
    expect(() => c.defineName('Ok', '=1', { sheet: 'Nope' })).toThrow(/no sheet/);
    c.undo();
    expect(valueOf(c, 'A1')).toBe(2);
  });
});

describe('sheet tabs, Name Manager rows and name autocomplete', () => {
  it('offers sheet-tab menu items that insert, rename, duplicate, move and delete', () => {
    const c = new SpreadsheetController();
    const first = c.activeSheetId;
    const items = (id: string) => getSheetTabMenuItems(c, id);
    const item = (id: string, itemId: string) => items(id).find((i) => i.id === itemId)!;
    expect(item(first, 'sheet-delete').disabled).toBe(true);
    expect(item(first, 'sheet-move-left').disabled).toBe(true);
    runSpreadsheetMenuItem(item(first, 'sheet-insert'));
    expect(c.getSheets().map((s) => s.name)).toEqual(['Sheet 1', 'Sheet 2']);
    runSpreadsheetMenuItem(item(first, 'sheet-rename'), () => 'Budget');
    expect(c.getSheets()[0].name).toBe('Budget');
    runSpreadsheetMenuItem(item(first, 'sheet-duplicate'));
    expect(c.getSheets().map((s) => s.name)).toEqual(['Budget', 'Budget (2)', 'Sheet 2']);
    runSpreadsheetMenuItem(item(first, 'sheet-move-right'));
    expect(c.getSheets().map((s) => s.name)).toEqual(['Budget (2)', 'Budget', 'Sheet 2']);
    // Delete asks first; declining keeps the sheet.
    const confirm = vi.fn(() => false);
    expect(runSpreadsheetMenuItem(item(first, 'sheet-delete'), undefined, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"Budget"'));
    expect(runSpreadsheetMenuItem(item(first, 'sheet-delete'), undefined, () => true)).toBe(true);
    expect(c.getSheets().map((s) => s.name)).toEqual(['Budget (2)', 'Sheet 2']);
    // Invalid renames are reported through onError.
    const onError = vi.fn();
    const rename = getSheetTabMenuItems(c, c.activeSheetId, { onError }).find((i) => i.id === 'sheet-rename')!;
    runSpreadsheetMenuItem(rename, () => 'sheet 2');
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/taken/));
  });

  it('computes drop positions for dragged tabs', () => {
    expect(sheetDropIndex(0, 2, true)).toBe(2);
    expect(sheetDropIndex(0, 2, false)).toBe(1);
    expect(sheetDropIndex(3, 0, false)).toBe(0);
    expect(sheetDropIndex(3, 1, true)).toBe(2);
  });

  it('lists names with scopes and current values', () => {
    const c = new SpreadsheetController();
    set(c, 'A1', '3');
    c.defineName('Rate', '=0.25', { comment: 'tax' });
    c.defineName('Cell', `='Sheet 1'!$A$1`, { sheet: c.activeSheetId });
    c.defineName('Pair', `='Sheet 1'!$A$1:$A$2`);
    c.defineName('Twice', '=LAMBDA(x, x*2)');
    expect(getNameManagerRows(c)).toEqual([
      expect.objectContaining({ name: 'Cell', scopeLabel: 'Sheet 1', value: '3' }),
      expect.objectContaining({ name: 'Pair', scopeLabel: 'Workbook', value: '{2×1 array}' }),
      expect.objectContaining({ name: 'Rate', value: '0.25', comment: 'tax' }),
      expect.objectContaining({ name: 'Twice', value: '[LAMBDA]', isLambda: true }),
    ]);
  });

  it('suggests defined names in formula autocomplete', () => {
    const names = [
      { name: 'Revenue', description: '=Data!$B$2:$B$9' },
      { name: 'RoundUpTo', isLambda: true },
    ];
    const hints = getFormulaHints('=SUM(Re', 7, { names });
    expect(hints.suggestions[0]).toMatchObject({ name: 'Revenue', kind: 'name' });
    expect(hints.suggestions.some((s) => s.name === 'REPLACE')).toBe(true);
    expect(applyFormulaSuggestion('=SUM(Re', 7, 'Revenue', { call: false })).toEqual({ value: '=SUM(Revenue', caret: 12 });
    const lambda = getFormulaHints('=Ro', 3, { names }).suggestions[0];
    expect(lambda).toMatchObject({ name: 'RoundUpTo', signature: 'RoundUpTo(…)', isLambda: true });
    expect(applyFormulaSuggestion('=Ro', 3, lambda)).toEqual({ value: '=RoundUpTo(', caret: 11 });
    expect(applyFormulaSuggestion('=SUM(Re', 7, hints.suggestions[0])).toEqual({ value: '=SUM(Revenue', caret: 12 });
    const c = new SpreadsheetController();
    c.defineName('Revenue', '=1');
    expect(c.getNameSuggestions()).toEqual([{ name: 'Revenue', description: '=1', isLambda: false }]);
  });
});
