// Range-aware dependency graph and incremental recalculation. Cases about the
// interval index and dirty propagation are re-expressed from
// gridcraft/crates/calc/src/tests.rs and recalc.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it, vi } from 'vitest';
import {
  DependencyGraph,
  FormulaEvaluator,
  IntervalIndex,
  SpreadsheetController,
  colNameToIndex,
  extractReferenceDependencies,
  indexToColName,
  parseFormula,
  rangeDependencyKey,
  type SpreadsheetDocument,
  type SpreadsheetWorkbook,
} from '../src/spreadsheet';
import { measureGrowth } from './helpers/growth';

/**
 * Interval-tree nodes `run` visits. "Stays O(log n + k)" tests count these rather than time
 * the work: a wall-clock ratio with little headroom (log growth is ~1.2× for 4× the size,
 * linear 4×) flaked on loaded CI runners.
 */
function indexVisits(run: () => void): number {
  const walk = vi.spyOn(IntervalIndex.prototype as any, 'walk');
  try {
    run();
    return walk.mock.calls.length;
  } finally {
    walk.mockRestore();
  }
}

/** A seeded pseudo-random generator (mulberry32), so failures reproduce. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] };
}

function makeDocument(id: string, name: string, rows: number, cols: number, cell?: (r: number, c: number) => string | null): SpreadsheetDocument {
  const columns = Array.from({ length: cols }, (_, c) => {
    const key = indexToColName(c);
    return { id: `${id}_c${c}`, key, title: key, width: 100, type: 'freeform' as const };
  });
  const rowList = Array.from({ length: rows }, (_, r) => ({ id: `${id}_r${r}`, index: r, height: 32, type: 'freeform' as const }));
  const cells: SpreadsheetDocument['cells'] = {};
  if (cell) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const raw = cell(r, c);
        if (raw === null) continue;
        (cells[rowList[r].id] ??= {})[columns[c].id] = { raw, value: raw.startsWith('=') ? raw : Number(raw) };
      }
    }
  }
  return { id, name, columns, rows: rowList, cells, createdAt: 0, updatedAt: 0 };
}

/** A1-style access to the active sheet. */
function sheet(ctrl: SpreadsheetController) {
  const ids = (key: string) => {
    const [, col, row] = /^([A-Z]+)(\d+)$/.exec(key)!;
    return [ctrl.document.rows[Number(row) - 1].id, ctrl.document.columns[colNameToIndex(col)].id] as const;
  };
  return {
    set: (key: string, raw: string) => ctrl.setCellValue(...ids(key), raw),
    value: (key: string) => ctrl.getCell(...ids(key)).value,
    error: (key: string) => ctrl.getCell(...ids(key)).error,
  };
}

describe('IntervalIndex', () => {
  it('answers overlap queries like a linear scan, through inserts and removals', () => {
    const r = rng(7);
    const index = new IntervalIndex<string>();
    const live = new Map<string, [number, number]>();
    for (let step = 0; step < 3000; step++) {
      if (live.size > 0 && r.next() < 0.3) {
        const id = r.pick(Array.from(live.keys()));
        index.remove(id);
        live.delete(id);
      } else {
        const a = 1 + r.int(500);
        const b = a + r.int(r.next() < 0.1 ? 5000 : 40);
        const id = `${a}:${b}:${step}`;
        index.insert(a, b, id, id);
        live.set(id, [a, b]);
      }
      if (step % 50 === 0) {
        const qa = 1 + r.int(600);
        const qb = qa + r.int(30);
        const found: string[] = [];
        index.query(qa, qb, (id) => found.push(id));
        const expected = Array.from(live).filter(([, [a, b]]) => a <= qb && b >= qa).map(([id]) => id);
        expect(found.sort()).toEqual(expected.sort());
        expect(index.size).toBe(live.size);
      }
    }
  });

  it('revives a removed entry when it is inserted again', () => {
    const index = new IntervalIndex<number>();
    for (let i = 0; i < 100; i++) index.insert(i, i + 1, `e${i}`, i);
    const hits = () => {
      const out: number[] = [];
      index.query(10, 10, (v) => out.push(v));
      return out.sort((a, b) => a - b);
    };
    expect(hits()).toEqual([9, 10]);
    index.remove('e10');
    expect(hits()).toEqual([9]);
    index.insert(10, 11, 'e10', 10);
    expect(hits()).toEqual([9, 10]);
  });
});

describe('extractReferenceDependencies', () => {
  it('keeps ranges whole and normalises them', () => {
    expect(extractReferenceDependencies(parseFormula('=SUM(B9:A1)+C3+D1#'))).toEqual([
      { kind: 'range', startCol: 'A', startRow: 1, endCol: 'B', endRow: 9 },
      { kind: 'cell', col: 'C', row: 3 },
      { kind: 'cell', col: 'D', row: 1 },
    ]);
    expect(extractReferenceDependencies(parseFormula('=SUM(Data!A:A)'))).toEqual([
      { kind: 'range', startCol: 'A', startRow: 1, endCol: 'A', endRow: 1048576, sheet: 'Data' },
    ]);
  });
});

describe('DependencyGraph with ranges', () => {
  it('stores a range as one entry instead of one key per cell', () => {
    const graph = new DependencyGraph();
    graph.setCellFormula('B1', '=SUM(A1:A50000)');
    graph.setCellFormula('B2', '=SUM(A:A)');
    graph.setCellFormula('B3', '=SUM(A1:CZ10)'); // wider than 64 columns: one wide entry
    expect(graph.getIndexStats()).toEqual({ formulas: 3, cellEdges: 0, rangeEntries: 3, volatile: 0 });
    expect(graph.getDependencies('B1')).toEqual(['A1:A50000']);
    expect(graph.getDependencies('B2')).toEqual(['A:']);
    expect(graph.getDependents('A25000').sort()).toEqual(['B1', 'B2']);
    expect(graph.getDependents('A50001')).toEqual(['B2']);
    expect(graph.getDependents('CX5').sort()).toEqual(['B3']);
    expect(graph.getDependents('DA5')).toEqual([]);
    expect(graph.dependsOn('B1', 'A7')).toBe(true);
    expect(graph.dependsOn('B1', 'B7')).toBe(false);
    graph.setCellFormula('B1', '=1');
    expect(graph.getDependents('A25000')).toEqual(['B2']);
  });

  it('keeps sheets apart in the range index', () => {
    const graph = new DependencyGraph();
    graph.setCellDependencies('S1!B1', [rangeDependencyKey('A', 1, 'A', 10, 'S2')]);
    expect(graph.getDependents('S2!A5')).toEqual(['S1!B1']);
    expect(graph.getDependents('S1!A5')).toEqual([]);
    expect(graph.getDependents('A5')).toEqual([]);
  });

  it('orders formulas inside a range before the formulas reading it', () => {
    const graph = new DependencyGraph();
    graph.setCellFormula('B1', '=SUM(A1:A5)');
    graph.setCellFormula('A3', '=C1*2');
    graph.setCellFormula('A4', '=A3+1');
    const { order, cyclic } = graph.getEvaluationPlan(['C1'], { includeDependents: true });
    expect(cyclic.size).toBe(0);
    expect(order.indexOf('C1')).toBeLessThan(order.indexOf('A3'));
    expect(order.indexOf('A3')).toBeLessThan(order.indexOf('A4'));
    expect(order.indexOf('A4')).toBeLessThan(order.indexOf('B1'));
    expect(order).toHaveLength(4);
  });

  it('finds cycles through ranges and reports every member', () => {
    const graph = new DependencyGraph();
    graph.setCellFormula('A2', '=SUM(A1:A3)');
    expect(graph.hasCycle('A2')).toBe(true);
    graph.setCellFormula('A2', '=1');
    graph.setCellFormula('B1', '=SUM(C1:C3)');
    graph.setCellFormula('C2', '=B1+1');
    graph.setCellFormula('D1', '=C2');
    const plan = graph.getEvaluationPlan(['B1', 'C2', 'D1']);
    expect([...plan.cyclic].sort()).toEqual(['B1', 'C2']);
    expect(plan.order.indexOf('D1')).toBeGreaterThan(plan.order.indexOf('C2'));
  });

  it('plans volatile formulas with includeVolatile', () => {
    const graph = new DependencyGraph();
    graph.setCellFormula('A1', '=1');
    graph.setVolatile('A1', true);
    graph.setCellFormula('B1', '=A1*2');
    expect(graph.getEvaluationPlan(['C9'], { includeDependents: true }).order).toEqual(['C9']);
    expect(graph.getEvaluationPlan(['C9'], { includeDependents: true, includeVolatile: true }).order.sort()).toEqual(['A1', 'B1', 'C9']);
  });

  it('finds dependents in O(log n + k) however many ranges share a column', () => {
    const build = (n: number) => {
      const graph = new DependencyGraph();
      for (let i = 1; i <= n; i++) graph.setCellFormula(`B${i}`, `=SUM(A${i}:A${i + 5})`);
      graph.getDependents('A1'); // settle the index
      return graph;
    };
    const small = build(2_000);
    const large = build(8_000);
    const lookups = (graph: DependencyGraph, n: number) => () => {
      for (let i = 0; i < 200; i++) graph.getDependents(`A${1 + ((i * 37) % n)}`);
    };
    expect(large.getDependents('A4000').sort()).toEqual(['B3995', 'B3996', 'B3997', 'B3998', 'B3999', 'B4000']);
    const smallVisits = indexVisits(lookups(small, 2_000));
    const largeVisits = indexVisits(lookups(large, 8_000));
    // The lookups go through the tree, touching about log2(n) + k nodes each, not all n.
    expect(smallVisits).toBeGreaterThan(0);
    expect(largeVisits / 200).toBeLessThan(4 * (Math.log2(8_000) + 6));
    // A linear scan per lookup would be 4×.
    expect(largeVisits / smallVisits).toBeLessThan(2.5);
  });
});

describe('incremental recalculation work counts', () => {
  const ROWS = 50_000;

  it('editing one cell under SUM(A1:A50000) evaluates one formula, not 50k', () => {
    const doc = makeDocument('big', 'Big', ROWS, 3, (r, c) => {
      if (c === 0) return String(r % 10);
      if (c === 1 && r === 0) return `=SUM(A1:A${ROWS})`;
      if (c === 1 && r === 1) return '=SUM(A:A)';
      if (c === 1 && r === 2) return `=SUMIF(A1:A${ROWS},">5")`;
      return null;
    });
    const ctrl = new SpreadsheetController({ document: doc });
    expect(ctrl.getRecalculationStats().evaluated).toBe(3);
    expect(ctrl.depGraph.getIndexStats()).toMatchObject({ formulas: 3, cellEdges: 0, rangeEntries: 3 });
    const s = sheet(ctrl);
    const before = s.value('B1') as number;
    s.set('A25000', '1000');
    expect(ctrl.getRecalculationStats()).toEqual({ evaluated: 3, planned: 4, passes: 1 });
    expect(s.value('B1')).toBe(before - (24999 % 10) + 1000);
    expect(s.value('B2')).toBe(s.value('B1'));
    // A cell nothing reads evaluates nothing.
    s.set('C7', '5');
    expect(ctrl.getRecalculationStats().evaluated).toBe(0);
    // Past the end of SUM(A1:A50000) but inside A:A.
    ctrl.insertRow(ROWS);
    expect(ctrl.document.rows.length).toBe(ROWS + 1);
    s.set(`A${ROWS + 1}`, '7');
    expect(ctrl.getRecalculationStats().evaluated).toBe(1);
    expect(s.value('B2')).toBe((s.value('B1') as number) + 7);
  });

  it('a chain recalculates only the cells after the edit', () => {
    const doc = makeDocument('chain', 'Chain', 2_000, 2, (r, c) => (c === 0 ? '1' : r === 0 ? '=A1' : `=B${r}+A${r + 1}`));
    const ctrl = new SpreadsheetController({ document: doc });
    const s = sheet(ctrl);
    s.set('A1990', '2');
    expect(ctrl.getRecalculationStats().evaluated).toBe(11);
    expect(s.value('B2000')).toBe(2001);
  });

  it('many formulas over the same large range register one entry each and resolve the range once per plan', () => {
    const doc = makeDocument('same', 'Same', 5_000, 2, (r, c) => (c === 0 ? '1' : r < 50 ? `=SUM($A$1:$A$5000)+${r}` : null));
    const ctrl = new SpreadsheetController({ document: doc });
    expect(ctrl.depGraph.getIndexStats().rangeEntries).toBe(50);
    const resolve = vi.spyOn(ctrl as any, 'resolveRangeByCoords');
    sheet(ctrl).set('A10', '3');
    expect(ctrl.getRecalculationStats().evaluated).toBe(50);
    expect(sheet(ctrl).value('B50')).toBe(5_002 + 49);
    // Every formula asks, but the cells are read once (the rest are cache hits).
    expect(resolve).toHaveBeenCalledTimes(50);
    resolve.mockRestore();
  });

  it('recalculates volatile formulas on every edit, also through names', () => {
    const ctrl = new SpreadsheetController();
    const s = sheet(ctrl);
    ctrl.defineName('Roll', '=RAND()');
    s.set('A1', '=RAND()');
    s.set('A2', '=Roll*0');
    s.set('A3', '=A2+1');
    expect(ctrl.depGraph.getIndexStats().volatile).toBe(2);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    s.set('D9', 'x');
    expect(ctrl.getRecalculationStats().evaluated).toBe(3); // A1, A2 and its dependent A3
    expect(s.value('A1')).toBe(0.25);
    random.mockRestore();
    s.set('A1', '5');
    expect(ctrl.depGraph.getIndexStats().volatile).toBe(1);
  });

  // ~0.5 s alone; the generous timeout covers parallel test runs (it counts work, not time).
  it('a CSV import builds the graph and evaluates every formula once', { timeout: 30_000 }, () => {
    const ctrl = new SpreadsheetController();
    const lines: string[] = [];
    for (let r = 1; r <= 3_000; r++) lines.push(`${r},=A${r}*2,=SUM(B$1:B${r})`);
    const evaluate = vi.spyOn(ctrl.evaluator, 'evaluateWithDiagnostics');
    ctrl.importFromCsv(lines.join('\n'));
    expect(evaluate).toHaveBeenCalledTimes(6_000);
    expect(ctrl.getRecalculationStats().evaluated).toBe(6_000);
    expect(sheet(ctrl).value('C3000')).toBe(3_000 * 3_001);
    evaluate.mockRestore();
  });

  it('a paste inside the grid recalculates the pasted cells and their dependents in one plan', () => {
    const doc = makeDocument('p', 'P', 1_000, 4, (r, c) => (c === 0 ? String(r) : c === 1 ? `=A${r + 1}+1` : null));
    const ctrl = new SpreadsheetController({ document: doc });
    ctrl.importFromTsv('5\n6', 0, 0);
    expect(ctrl.getRecalculationStats().evaluated).toBe(2); // B1 and B2
    expect(sheet(ctrl).value('B1')).toBe(6);
    expect(sheet(ctrl).value('B2')).toBe(7);
    ctrl.importFromTsv('=A1*10', 2, 2);
    expect(ctrl.getRecalculationStats().evaluated).toBe(1);
    expect(sheet(ctrl).value('C3')).toBe(50);
  });

  it('undoes a single-cell edit without a whole-sheet snapshot', () => {
    const doc = makeDocument('u', 'U', 5_000, 3, (r, c) => (c === 0 ? '1' : c === 1 && r === 0 ? '=SUM(A:A)' : null));
    const ctrl = new SpreadsheetController({ document: doc });
    const s = sheet(ctrl);
    s.set('A3', '10');
    expect(s.value('B1')).toBe(5_009);
    expect(ctrl.getHistoryByteSize()).toBeLessThan(1_000);
    ctrl.undo();
    expect(s.value('A3')).toBe(1);
    expect(s.value('B1')).toBe(5_000);
    expect(ctrl.getRecalculationStats().evaluated).toBe(1);
    ctrl.redo();
    expect(s.value('B1')).toBe(5_009);
    s.set('C1', 'new');
    ctrl.undo();
    expect(ctrl.document.cells[ctrl.document.rows[0].id][ctrl.document.columns[2].id]).toBeUndefined();
    ctrl.undo();
    expect(s.value('B1')).toBe(5_000);
  });

  it('edits stay O(log n + k) as the sheet grows', () => {
    const build = (rows: number) => {
      const doc = makeDocument('g', 'G', rows, 3, (r, c) =>
        c === 0 ? String(r) : c === 1 ? `=SUM(A${r + 1}:A${Math.min(rows, r + 10)})` : null,
      );
      const ctrl = new SpreadsheetController({ document: doc, maxHistoryBytes: 1 });
      return { ctrl, ids: [ctrl.document.rows[Math.floor(rows / 2)].id, ctrl.document.columns[0].id] as const };
    };
    const small = build(2_000);
    const large = build(8_000);
    let n = 0;
    const edit = (target: ReturnType<typeof build>) => () => target.ctrl.setCellValue(...target.ids, String(n++ % 7));
    // Counted, not timed (see indexVisits): the same formulas recalculate whatever the sheet's
    // size, and finding them visits about as many index nodes.
    const smallVisits = indexVisits(edit(small));
    const smallStats = small.ctrl.getRecalculationStats();
    const largeVisits = indexVisits(edit(large));
    expect(large.ctrl.getRecalculationStats()).toEqual(smallStats);
    expect(smallStats.evaluated).toBeGreaterThan(0);
    expect(smallVisits).toBeGreaterThan(0);
    // Linear work per edit would be 4×.
    expect(largeVisits / smallVisits).toBeLessThan(2.5);
  });

  it('registering formulas over large ranges grows linearly', () => {
    // IF never evaluates the SUM, so this measures registration and
    // planning, which no longer expand ranges cell by cell.
    const load = (rows: number) => () =>
      new SpreadsheetController({
        document: makeDocument('l', 'L', rows, 2, (r, c) => (c === 0 ? '1' : `=IF(TRUE,1,SUM(A1:A${rows})+SUM(A${r + 1}:A${rows}))`)),
      });
    expect(measureGrowth(load(500), load(2_000), { limit: 8 })).toBeLessThan(8);
  });
});

describe('recalculation cases from gridcraft', () => {
  /** A sheet of `cols` columns and `rows` rows, addressed A1-style. */
  const grid = (rows = 20, cols = 4) => {
    const ctrl = new SpreadsheetController({ document: makeDocument('t', 'T', rows, cols) });
    const s = sheet(ctrl);
    return { ctrl, ...s, num: (key: string) => s.value(key) as number };
  };

  it('arithmetic and dependencies', () => {
    const t = grid();
    t.set('A1', '2');
    t.set('A2', '3');
    t.set('A3', '=A1*A2+1');
    expect(t.num('A3')).toBe(7);
    t.set('A1', '10');
    expect(t.num('A3')).toBe(31);
    t.set('B1', '=SUM(A1:A3)');
    expect(t.num('B1')).toBe(44);
    t.set('A2', '0');
    expect([t.num('A3'), t.num('B1')]).toEqual([1, 11]);
  });

  it('chains entered out of order', () => {
    const t = grid();
    t.set('A5', '=A4+1');
    t.set('A4', '=A3+1');
    t.set('A3', '=A2+1');
    t.set('A2', '=A1+1');
    t.set('A1', '1');
    expect(t.num('A5')).toBe(5);
  });

  it('a long chain', () => {
    const t = grid(3_000, 1);
    t.set('A1', '1');
    t.ctrl.importFromTsv(Array.from({ length: 2_999 }, (_, i) => `=A${i + 1}+1`).join('\n'), 1, 0);
    expect(t.num('A3000')).toBe(3_000);
    t.set('A1', '10');
    expect(t.num('A3000')).toBe(3_009);
  });

  it('SUM, COUNT and AVERAGE over spilled values', () => {
    const t = grid();
    t.set('A1', '=SEQUENCE(3)');
    t.set('A4', '10');
    for (const [fn, want] of [['SUM', 16], ['COUNT', 4], ['AVERAGE', 4]] as const) {
      t.set('C1', `=${fn}(A1:A5)`);
      expect(t.num('C1')).toBe(want);
    }
  });

  it('SUM, COUNT and AVERAGE follow edits inside the range', () => {
    for (const range of ['A1:A5', 'A:A']) {
      const t = grid();
      t.set('A1', '1');
      t.set('A3', '3');
      t.set('C1', `=SUM(${range})`);
      t.set('C2', `=COUNT(${range})`);
      t.set('C3', `=AVERAGE(${range})`);
      const all = () => [t.num('C1'), t.num('C2'), t.num('C3')];
      expect(all()).toEqual([4, 2, 2]);
      t.set('A1', '5');
      expect(all()).toEqual([8, 2, 4]);
      t.set('A2', '10');
      expect(all()).toEqual([18, 3, 6]);
      t.set('A3', 'text');
      expect(all()).toEqual([15, 2, 7.5]);
      t.set('A2', '');
      expect(all()).toEqual([5, 1, 5]);
      t.set('A5', '=A1*2');
      expect(all()).toEqual([15, 2, 7.5]);
      t.set('A1', '1');
      expect(all()).toEqual([3, 2, 1.5]);
      // A7 is inside the whole column A:A but outside A1:A5.
      t.set('A7', '100');
      expect(all()).toEqual(range === 'A:A' ? [103, 3, 103 / 3] : [3, 2, 1.5]);
    }
  });

  it('finds range dependents again after edits, for wide ranges, whole columns and other sheets', () => {
    const ctrl = new SpreadsheetController({
      workbook: { sheets: [makeDocument('s1', 'Main', 12, 110), makeDocument('s2', 'Data', 12, 110)], activeSheetId: 's1' },
    });
    const t = sheet(ctrl);
    const num = (key: string) => t.value(key) as number;
    t.set('A1', '1');
    t.set('B2', '2');
    t.set('CZ3', '3');
    t.set('DA5', '=SUM(A1:B2)');
    t.set('DA6', '=SUM(A1:CZ3)');
    t.set('DA7', '=SUM(B:B)');
    expect([num('DA5'), num('DA6'), num('DA7')]).toEqual([3, 6, 2]);
    t.set('B2', '20');
    expect([num('DA5'), num('DA6'), num('DA7')]).toEqual([21, 24, 20]);
    // Re-entering a formula with another range drops the old one.
    t.set('DA5', '=SUM(A1:A2)');
    t.set('B2', '5');
    expect(num('DA5')).toBe(1);
    expect(ctrl.depGraph.getDependents('S1!B2').sort()).toEqual(['S1!DA6', 'S1!DA7']);
    t.set('CZ3', '30');
    expect(num('DA6')).toBe(36);
    t.set('DA9', '=SUM(Data!A1:A3)+SUM(Data!A:CZ)');
    expect(num('DA9')).toBe(0);
    ctrl.setActiveSheet('s2');
    sheet(ctrl).set('A2', '4');
    ctrl.setActiveSheet('s1');
    expect(num('DA9')).toBe(8);
    expect(ctrl.depGraph.getDependents('S2!A2')).toEqual(['S1!DA9']);
  });

  it('range formulas recalculate correctly after opening and bulk edits', () => {
    // `rows` rows of six numbers (E:J) and =SUM(E{r}:J{r}) in K.
    const rows = 500;
    const doc = makeDocument('b', 'B', rows, 11, (r, c) =>
      c >= 4 && c < 10 ? String((r % 97) + c) : c === 10 ? `=SUM(E${r + 1}:J${r + 1})` : null,
    );
    const ctrl = new SpreadsheetController({ document: doc });
    // Change every value of column E (one paste), then re-enter every formula.
    ctrl.importFromTsv(Array.from({ length: rows }, () => '1').join('\n'), 0, 4);
    expect(ctrl.getRecalculationStats().evaluated).toBe(rows);
    ctrl.importFromTsv(Array.from({ length: rows }, (_, r) => `=SUM(E${r + 1}:J${r + 1})`).join('\n'), 0, 10);
    const r = rows - 1;
    let want = 1;
    for (let c = 5; c < 10; c++) want += (r % 97) + c;
    expect(sheet(ctrl).value(`K${rows}`)).toBe(want);
  });
});

describe('blank-skipping range resolution', () => {
  it('SUM, PRODUCT, AVERAGE, COUNT, COUNTA, MIN and MAX give the same results without blanks', () => {
    const r = rng(11);
    for (let trial = 0; trial < 50; trial++) {
      const cells: Record<string, any> = {};
      for (let row = 1; row <= 12; row++) {
        for (const col of ['A', 'B']) {
          cells[`${col}${row}`] = r.pick(['', '', '', 3, -2, 0.5, 'text', '7', true, false, 0]);
        }
      }
      if (trial % 10 === 0) cells.B5 = '#N/A';
      const make = (honour: boolean) => {
        const asked: boolean[] = [];
        const evaluator = new FormulaEvaluator({
          resolveCell: (col, row) => cells[`${col}${row}`] ?? '',
          resolveRange: (sc, sr, ec, er, _sheet, options) => {
            asked.push(!!options?.skipBlanks);
            const out: any[] = [];
            for (let c = colNameToIndex(sc); c <= colNameToIndex(ec); c++) {
              for (let row = sr; row <= er; row++) {
                const v = cells[`${indexToColName(c)}${row}`] ?? '';
                if (honour && options?.skipBlanks && v === '') continue;
                out.push(v);
              }
            }
            return out;
          },
        });
        return { evaluator, asked };
      };
      const full = make(false);
      const sparse = make(true);
      for (const fn of ['SUM', 'PRODUCT', 'AVERAGE', 'COUNT', 'COUNTA', 'MIN', 'MAX']) {
        const formula = `=${fn}(A1:B12, 4, A3)`;
        expect(sparse.evaluator.evaluateWithDiagnostics(formula)).toEqual(full.evaluator.evaluateWithDiagnostics(formula));
      }
      expect(sparse.asked.every(Boolean)).toBe(true);
    }
  });

  it('is not used for functions that see blanks', () => {
    const ctrl = new SpreadsheetController();
    const s = sheet(ctrl);
    s.set('A2', '4');
    s.set('B1', '=COUNTBLANK(A1:A10)');
    s.set('B2', '=COUNTIF(A1:A10,"")');
    s.set('B3', '=COUNTA(A1:A10)');
    s.set('B4', '=INDEX(A1:A10,2)');
    expect([s.value('B1'), s.value('B2'), s.value('B3'), s.value('B4')]).toEqual([9, 9, 1, 4]);
  });
});

describe('incremental recalculation matches a full recalculation', () => {
  const ROWS = 12;
  const COLS = 6;
  const refOf = (r: ReturnType<typeof rng>) => `${indexToColName(r.int(COLS))}${1 + r.int(ROWS)}`;
  const rangeOf = (r: ReturnType<typeof rng>) => {
    const c0 = r.int(COLS);
    const r0 = 1 + r.int(ROWS);
    return `${indexToColName(c0)}${r0}:${indexToColName(Math.min(COLS - 1, c0 + r.int(3)))}${Math.min(ROWS, r0 + r.int(6))}`;
  };

  function randomInput(r: ReturnType<typeof rng>, col: number, otherSheet: string): string {
    if (r.next() < 0.45) return r.pick(['', '1', '2', '5', '9', 'x', '-3', 'TRUE']);
    const templates: Array<() => string> = [
      () => `=${refOf(r)}+${refOf(r)}`,
      () => `=SUM(${rangeOf(r)})`,
      () => `=COUNTIF(${rangeOf(r)},">3")`,
      () => `=AVERAGE(${rangeOf(r)})`,
      () => `=MAX(${rangeOf(r)})*2`,
      () => `=COUNTA(${indexToColName(r.int(COLS))}:${indexToColName(r.int(COLS))})`,
      () => `=SUM(${indexToColName(r.int(COLS))}:${indexToColName(r.int(COLS))})`,
      () => `=${otherSheet}!${refOf(r)}*2`,
      () => `=SUM(${otherSheet}!${rangeOf(r)})`,
      () => `=SUM(Sheet1:Sheet2!${refOf(r)})`,
      () => `=Total+${refOf(r)}`,
      () => `=SUM(Block)`,
      () => `=IF(${refOf(r)}>4,${refOf(r)},0)`,
      () => `=SUM(E1#)+SUM(E7#)`,
      () => `=LET(x,SUM(${rangeOf(r)}),x*2)`,
    ];
    // Arrays only spill down column E, so two spills never compete for cells
    // (which one wins would depend on the order, as in Excel).
    if (col === 4 && r.next() < 0.5) return `=SEQUENCE(${1 + r.int(4)})`;
    return r.pick(templates)();
  }

  function snapshot(ctrl: SpreadsheetController): string[] {
    const out: string[] = [];
    const active = ctrl.activeSheetId;
    for (const info of ctrl.getSheets()) {
      ctrl.setActiveSheet(info.id);
      for (const row of ctrl.document.rows) {
        for (const col of ctrl.document.columns) {
          const cell = ctrl.getCell(row.id, col.id);
          out.push(`${info.name}!${col.key}${row.index + 1}=${JSON.stringify(cell.value)}|${cell.error ?? ''}`);
        }
      }
    }
    ctrl.setActiveSheet(active);
    return out;
  }

  /** Values of every cell, after the edits and after a full recalculation of the same workbook. */
  function compareWithFull(ctrl: SpreadsheetController) {
    return { got: snapshot(ctrl), want: snapshot(new SpreadsheetController({ workbook: ctrl.getWorkbook() })) };
  }

  it('a blocked anchor is not part of a cycle through its blocker', () => {
    const ctrl = new SpreadsheetController();
    const s = sheet(ctrl);
    s.set('B1', '=A1');
    s.set('A1', '=SEQUENCE(3)');
    s.set('A3', '=B1');
    s.set('A3', '=B1+0'); // plans A1 (blocked by A3), B1 and A3 together
    expect([s.value('A1'), s.value('B1'), s.value('A3')]).toEqual(['#SPILL!', '#SPILL!', '#SPILL!']);
    const { got, want } = compareWithFull(ctrl);
    expect(got).toEqual(want);
  });

  it('a formula written over a spilled cell drops its edge to the old anchor', () => {
    const ctrl = new SpreadsheetController();
    const s = sheet(ctrl);
    s.set('A1', '=SEQUENCE(4)');
    ctrl.importFromTsv('=MAX(A2:A9)*2\n=SEQUENCE(3)', 0, 0); // A1 reads A2, which held A1's values
    expect([s.value('A1'), s.value('A2'), s.value('A3'), s.value('A4')]).toEqual([6, 1, 2, 3]);
    const { got, want } = compareWithFull(ctrl);
    expect(got).toEqual(want);
  });

  it("an anchor's new formula is not cyclic through the cells it used to spill into", () => {
    const ctrl = new SpreadsheetController();
    const s = sheet(ctrl);
    s.set('A1', '=SEQUENCE(3)');
    s.set('B1', '=SUM(A2:A3)');
    expect(s.value('B1')).toBe(5);
    s.set('A1', '=B1*2');
    expect([s.value('A1'), s.value('B1'), s.value('A2')]).toEqual([0, 0, '']);
    const { got, want } = compareWithFull(ctrl);
    expect(got).toEqual(want);
  });

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`random edits, pastes, undo and redo (seed ${seed})`, () => {
      const r = rng(seed);
      const workbook: SpreadsheetWorkbook = {
        sheets: [makeDocument('s1', 'Sheet1', ROWS, COLS), makeDocument('s2', 'Sheet2', ROWS, COLS)],
        activeSheetId: 's1',
        names: [
          { name: 'Total', refersTo: '=SUM(Sheet1!$A$1:$B$4)' },
          { name: 'Block', refersTo: '=Sheet2!$A$1:$C$6' },
        ],
      };
      const ctrl = new SpreadsheetController({ workbook });
      for (let step = 0; step < 150; step++) {
        const sheetIndex = r.int(2);
        const info = ctrl.getSheets()[sheetIndex];
        if (ctrl.activeSheetId !== info.id) ctrl.setActiveSheet(info.id);
        const other = sheetIndex === 0 ? 'Sheet2' : 'Sheet1';
        const roll = r.next();
        if (roll < 0.75) {
          const col = r.int(COLS);
          const row = r.int(ROWS);
          ctrl.setCellValue(ctrl.document.rows[row].id, ctrl.document.columns[col].id, randomInput(r, col, other));
        } else if (roll < 0.85) {
          const col = r.int(COLS - 1);
          const row = r.int(ROWS - 1);
          const tsv = [0, 1].map(() => [0, 1].map((dc) => randomInput(r, col + dc, other).replace(/\t/g, '')).join('\t')).join('\n');
          ctrl.importFromTsv(tsv, row, col);
        } else if (roll < 0.95) {
          ctrl.undo();
        } else {
          ctrl.redo();
        }
        const fresh = new SpreadsheetController({ workbook: ctrl.getWorkbook() });
        const got = snapshot(ctrl);
        const want = snapshot(fresh);
        if (got.join('\n') !== want.join('\n')) {
          const diff = got.filter((line, i) => line !== want[i]).slice(0, 5);
          const formulas = ctrl.getSheets().flatMap((s) => {
            const doc = ctrl.getSheetDocument(s.id)!;
            return Object.entries(doc.cells).flatMap(([rowId, cells]) =>
              Object.entries(cells).map(([colId, cell]) => `${s.name}:${rowId}/${colId}=${cell.raw}`),
            );
          });
          throw new Error(`step ${step}: incremental differs from full\n${diff.join('\n')}\nexpected\n${want.filter((line, i) => line !== got[i]).slice(0, 5).join('\n')}\n${formulas.join('\n')}`);
        }
      }
    });
  }
});
