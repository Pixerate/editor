import { describe, it, expect } from 'vitest';
import {
  SpreadsheetController,
  ConditionalFormatEngine,
  evaluateConditionalFormats,
  createConditionalFormatRule,
  describeConditionalFormat,
  getConditionalFormatIcon,
  getConditionalFormatCss,
  getDataBarCss,
  conditionalFormatStyleString,
  matchesTimePeriod,
  adjustRangesForStructuralChange,
  subtractRange,
  formatRuleRanges,
  parseRuleRanges,
  ruleFormulaAt,
  getSpreadsheetMenuItems,
  runSpreadsheetMenuItem,
  type CellRange,
  type ConditionalFormatRule,
  type ConditionalFormatSheet,
  type NewConditionalFormatRule
} from '../src/spreadsheet';

/** A controller whose cells are filled from `grid` (row-major raw inputs). */
function sheet(grid: string[][], rows = Math.max(grid.length, 1), cols = 4) {
  const ctrl = new SpreadsheetController({
    document: {
      columns: Array.from({ length: cols }, (_, i) => ({
        id: `c${i}`,
        key: String.fromCharCode(65 + i),
        title: String.fromCharCode(65 + i),
        type: 'freeform' as const
      })),
      rows: Array.from({ length: rows }, (_, i) => ({ id: `r${i}`, index: i, type: 'freeform' as const }))
    }
  });
  grid.forEach((line, r) => line.forEach((raw, c) => raw !== '' && ctrl.setCellValue(`r${r}`, `c${c}`, raw)));
  return ctrl;
}

const col = (startRow: number, endRow: number, c = 0): CellRange => ({ startRow, startCol: c, endRow, endCol: c });
const RED = { fill: '#ffc7ce' };
const BORDERISH = { bold: true };

/** A plain value grid as a ConditionalFormatSheet (no formulas). */
function grid(values: unknown[][]): ConditionalFormatSheet {
  return {
    rowCount: values.length,
    colCount: Math.max(...values.map((r) => r.length)),
    getValue: (r, c) => values[r]?.[c] ?? ''
  };
}

const rule = (r: NewConditionalFormatRule, id = 'r1'): ConditionalFormatRule => ({ ...r, id }) as ConditionalFormatRule;

describe('conditional formatting: highlight rules', () => {
  it('applies every matching rule; the higher-priority rule wins a shared part', () => {
    // gridcraft cf.rs: every_matching_rule_applies
    const s = grid([[200], [400], [510]]);
    const overlay = evaluateConditionalFormats(s, [
      rule({ type: 'cellIs', operator: 'greaterThan', value: '500', style: { bold: true, fill: '#00ff00' }, ranges: [col(0, 2)] }, 'a'),
      rule({ type: 'cellIs', operator: 'greaterThan', value: '300', style: RED, ranges: [col(0, 2)] }, 'b')
    ]);
    expect(overlay.get(0, 0)).toBeUndefined();
    expect(overlay.get(1, 0)).toEqual({ fill: '#ffc7ce' });
    expect(overlay.get(2, 0)).toEqual({ fill: '#00ff00', bold: true });
  });

  it('cell value rules treat blanks as 0 and never match errors', () => {
    // gridcraft cf.rs: cell_value_rules_on_blanks_and_errors
    const s = grid([[3, '#N/A'], ['', 7], ['#N/A', ''], [' ', ''], [7, '']]);
    const overlay = evaluateConditionalFormats(s, [
      rule({ type: 'cellIs', operator: 'lessThan', value: '5', style: RED, ranges: [col(0, 4)] }, 'lt'),
      rule({ type: 'noBlanks', style: BORDERISH, ranges: [col(0, 4)] }, 'nb'),
      rule({ type: 'cellIs', operator: 'greaterThan', value: '5', style: RED, ranges: [col(0, 1, 1)] }, 'gt')
    ]);
    const fill = (r: number, c = 0) => overlay.get(r, c)?.fill !== undefined;
    const bold = (r: number) => !!overlay.get(r, 0)?.bold;
    expect([fill(0), fill(1), fill(2), fill(4)]).toEqual([true, true, false, false]);
    expect([fill(0, 1), fill(1, 1)]).toEqual([false, true]);
    // No blanks: neither the empty cell nor the one holding a space.
    expect([bold(0), bold(1), bold(3)]).toEqual([true, false, false]);
  });

  it('supports every cell value operator', () => {
    const s = grid([[1], [5], [9]]);
    const check = (operator: any, value: string, value2?: string) => {
      const o = evaluateConditionalFormats(s, [rule({ type: 'cellIs', operator, value, value2, style: RED, ranges: [col(0, 2)] })]);
      return [0, 1, 2].map((r) => !!o.get(r, 0));
    };
    expect(check('equal', '5')).toEqual([false, true, false]);
    expect(check('notEqual', '5')).toEqual([true, false, true]);
    expect(check('greaterThanOrEqual', '5')).toEqual([false, true, true]);
    expect(check('lessThanOrEqual', '5')).toEqual([true, true, false]);
    expect(check('between', '9', '4')).toEqual([false, true, true]);
    expect(check('notBetween', '4', '9')).toEqual([true, false, false]);
  });

  it('matches text case-insensitively', () => {
    const s = grid([['Apple pie'], ['banana'], ['APPLE']]);
    const on = (type: any, text: string) => {
      const o = evaluateConditionalFormats(s, [rule({ type, text, style: RED, ranges: [col(0, 2)] })]);
      return [0, 1, 2].map((r) => !!o.get(r, 0));
    };
    expect(on('containsText', 'apple')).toEqual([true, false, true]);
    expect(on('notContainsText', 'apple')).toEqual([false, true, false]);
    expect(on('beginsWith', 'BAN')).toEqual([false, true, false]);
    expect(on('endsWith', 'pie')).toEqual([true, false, false]);
  });

  it('finds errors, blanks, duplicates and unique values', () => {
    const s = grid([['a'], ['A'], ['b'], [''], ['#DIV/0!']]);
    const on = (type: any) => {
      const o = evaluateConditionalFormats(s, [rule({ type, style: RED, ranges: [col(0, 4)] })]);
      return [0, 1, 2, 3, 4].map((r) => !!o.get(r, 0));
    };
    expect(on('duplicate')).toEqual([true, true, false, false, false]);
    expect(on('unique')).toEqual([false, false, true, false, true]);
    expect(on('blanks')).toEqual([false, false, false, true, false]);
    expect(on('errors')).toEqual([false, false, false, false, true]);
    expect(on('noErrors')).toEqual([true, true, true, true, false]);
  });

  it('top/bottom N, top N percent and above/below average', () => {
    const s = grid([[10], [20], [30], [40], [50], ['text']]);
    const on = (r: NewConditionalFormatRule) => {
      const o = evaluateConditionalFormats(s, [rule(r)]);
      return [0, 1, 2, 3, 4, 5].map((i) => !!o.get(i, 0));
    };
    const ranges = [col(0, 5)];
    expect(on({ type: 'top10', rank: 2, style: RED, ranges })).toEqual([false, false, false, true, true, false]);
    expect(on({ type: 'top10', bottom: true, rank: 1, style: RED, ranges })).toEqual([true, false, false, false, false, false]);
    // 40% of 5 values = 2.
    expect(on({ type: 'top10', percent: true, rank: 40, style: RED, ranges })).toEqual([false, false, false, true, true, false]);
    expect(on({ type: 'aboveAverage', style: RED, ranges })).toEqual([false, false, false, true, true, false]);
    expect(on({ type: 'aboveAverage', below: true, equal: true, style: RED, ranges })).toEqual([true, true, true, false, false, false]);
    // Population std dev of 10..50 is ~14.14: above 30 + 14.14.
    expect(on({ type: 'aboveAverage', stdDev: 1, style: RED, ranges })).toEqual([false, false, false, false, true, false]);
  });

  it('dates occurring, relative to today', () => {
    const today = new Date(2026, 9, 14); // Wednesday 14 Oct 2026
    expect(matchesTimePeriod('today', 46309, today)).toBe(true); // 2026-10-14
    expect(matchesTimePeriod('yesterday', 46308, today)).toBe(true);
    expect(matchesTimePeriod('tomorrow', 46310, today)).toBe(true);
    expect(matchesTimePeriod('thisWeek', 46306, today)).toBe(true); // Sunday 11 Oct
    expect(matchesTimePeriod('thisWeek', 46305, today)).toBe(false);
    expect(matchesTimePeriod('lastWeek', 46305, today)).toBe(true);
    expect(matchesTimePeriod('nextWeek', 46313, today)).toBe(true); // Sunday 18 Oct
    expect(matchesTimePeriod('last7Days', 46303, today)).toBe(true);
    expect(matchesTimePeriod('last7Days', 46302, today)).toBe(false);
    expect(matchesTimePeriod('lastMonth', 46295, today)).toBe(true); // 30 Sep
    expect(matchesTimePeriod('nextMonth', 46327, today)).toBe(true); // 1 Nov
    expect(matchesTimePeriod('thisMonth', 46296, today)).toBe(true); // 1 Oct

    const s: ConditionalFormatSheet = { ...grid([['2026-10-14'], ['2026-10-13'], ['note']]), today: () => today };
    const o = evaluateConditionalFormats(s, [rule({ type: 'timePeriod', period: 'today', style: RED, ranges: [col(0, 2)] })]);
    expect([0, 1, 2].map((r) => !!o.get(r, 0))).toEqual([true, false, false]);
  });
});

describe('conditional formatting: scales, bars and icons', () => {
  it('blends 2- and 3-colour scales between min, percentile and max', () => {
    const s = grid([[0], [50], [100], ['x']]);
    const two = evaluateConditionalFormats(s, [
      rule({ type: 'colorScale', ranges: [col(0, 3)], stops: [{ value: { type: 'min' }, color: '#000000' }, { value: { type: 'max' }, color: '#ffffff' }] })
    ]);
    expect([two.get(0, 0)?.fill, two.get(1, 0)?.fill, two.get(2, 0)?.fill, two.get(3, 0)]).toEqual(['#000000', '#808080', '#ffffff', undefined]);

    const three = evaluateConditionalFormats(grid([[0], [10], [100]]), [
      rule({
        type: 'colorScale',
        ranges: [col(0, 2)],
        stops: [
          { value: { type: 'min' }, color: '#ff0000' },
          { value: { type: 'percentile', value: 50 }, color: '#ffff00' },
          { value: { type: 'max' }, color: '#00ff00' }
        ]
      })
    ]);
    // The median (10) is the midpoint colour.
    expect([three.get(0, 0)?.fill, three.get(1, 0)?.fill, three.get(2, 0)?.fill]).toEqual(['#ff0000', '#ffff00', '#00ff00']);
  });

  it('supports number, percent and formula anchors', () => {
    const s: ConditionalFormatSheet = { ...grid([[0], [5], [10], [20]]), evaluateFormula: () => 20 };
    const o = evaluateConditionalFormats(s, [
      rule({
        type: 'colorScale',
        ranges: [col(0, 3)],
        stops: [{ value: { type: 'number', value: 5 }, color: '#000000' }, { value: { type: 'formula', formula: '=$Z$1' }, color: '#ffffff' }]
      })
    ]);
    // Values below the low anchor clamp to the low colour.
    expect([o.get(0, 0)?.fill, o.get(1, 0)?.fill, o.get(3, 0)?.fill]).toEqual(['#000000', '#000000', '#ffffff']);
    const pct = evaluateConditionalFormats(grid([[0], [100]]), [
      rule({ type: 'colorScale', ranges: [col(0, 1)], stops: [{ value: { type: 'percent', value: 50 }, color: '#000000' }, { value: { type: 'max' }, color: '#ffffff' }] })
    ]);
    expect(pct.get(0, 0)?.fill).toBe('#000000');
  });

  it('sizes data bars from zero for positive numbers', () => {
    const o = evaluateConditionalFormats(grid([[0], [50], [100], ['x']]), [rule({ type: 'dataBar', ranges: [col(0, 3)], color: '#123456', showValue: false })]);
    expect(o.get(0, 0)?.dataBar?.fraction).toBe(0);
    expect(o.get(1, 0)?.dataBar?.fraction).toBeCloseTo(0.55);
    expect(o.get(2, 0)?.dataBar).toEqual({ fraction: 1, color: '#123456', gradient: true });
    expect(o.get(2, 0)?.hideValue).toBe(true);
    expect(o.get(3, 0)).toBeUndefined();
  });

  it('picks icons from default or file thresholds', () => {
    // gridcraft tests.rs: icon_set_thresholds_from_files_pick_the_icon
    const s = grid([[0], [10], [20], [30], [100]]);
    const icon = (o: ReturnType<typeof evaluateConditionalFormats>, r: number) => o.get(r, 0)?.icon?.index;
    const defaults = evaluateConditionalFormats(s, [rule({ type: 'iconSet', set: '3Arrows', ranges: [col(0, 4)] })]);
    // Percent of the 0..100 span, so 30 is still the lowest icon.
    expect([icon(defaults, 0), icon(defaults, 3), icon(defaults, 4)]).toEqual([0, 0, 2]);
    expect(defaults.get(4, 0)?.icon).toEqual({ set: '3Arrows', index: 2, id: '3Arrows:2' });
    const fromFile = evaluateConditionalFormats(s, [
      rule({
        type: 'iconSet',
        set: '3Arrows',
        ranges: [col(0, 4)],
        thresholds: [{ type: 'percent', value: 0 }, { type: 'number', value: 10 }, { type: 'number', value: 25 }]
      })
    ]);
    expect([0, 1, 2, 3].map((r) => icon(fromFile, r))).toEqual([0, 1, 1, 2]);
    const reversed = evaluateConditionalFormats(s, [rule({ type: 'iconSet', set: '3Arrows', reverse: true, ranges: [col(0, 4)] })]);
    expect(icon(reversed, 4)).toBe(0);
    expect(getConditionalFormatIcon('3Arrows', 2).glyph).toBe('↑');
    expect(getConditionalFormatIcon('5Quarters', 9).label).toBe('Full');
  });
});

describe('conditional formatting: priority and stop if true', () => {
  it('stops lower-priority rules when a matching rule has stopIfTrue', () => {
    const s = grid([[10], [60]]);
    const rules = [
      rule({ type: 'cellIs', operator: 'greaterThan', value: '50', style: { bold: true }, stopIfTrue: true, ranges: [col(0, 1)] }, 'a'),
      rule({ type: 'dataBar', ranges: [col(0, 1)] }, 'b'),
      rule({ type: 'cellIs', operator: 'greaterThan', value: '0', style: RED, ranges: [col(0, 1)] }, 'c')
    ];
    const o = evaluateConditionalFormats(s, rules);
    expect(o.get(1, 0)).toEqual({ bold: true });
    expect(o.get(0, 0)?.fill).toBe('#ffc7ce');
    expect(o.get(0, 0)?.dataBar).toBeDefined();
  });

  it('lets a higher-priority highlight fill win over a colour scale', () => {
    const s = grid([[1], [2]]);
    const o = evaluateConditionalFormats(s, [
      rule({ type: 'cellIs', operator: 'equal', value: '2', style: RED, ranges: [col(0, 1)] }, 'a'),
      rule({ type: 'colorScale', ranges: [col(0, 1)], stops: [{ value: { type: 'min' }, color: '#000000' }, { value: { type: 'max' }, color: '#ffffff' }] }, 'b')
    ]);
    expect(o.get(1, 0)?.fill).toBe('#ffc7ce');
    expect(o.get(0, 0)?.fill).toBe('#000000');
  });
});

describe('conditional formatting: formula rules in the controller', () => {
  it('offsets relative references from the top-left cell of the range', () => {
    const ctrl = sheet([
      ['5', 'a'],
      ['50', 'b'],
      ['500', 'c']
    ]);
    // Whole rows where column A > 10: $A1 stays on column A, the row moves.
    ctrl.addConditionalFormat({ type: 'expression', formula: '=$A1>10', style: RED, ranges: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 1 }] });
    const overlay = ctrl.getConditionalFormatOverlay();
    expect([0, 1, 2].map((r) => [!!overlay.get(r, 0), !!overlay.get(r, 1)])).toEqual([
      [false, false],
      [true, true],
      [true, true]
    ]);
    expect(ruleFormulaAt('=$A1>B$1', { row: 0, col: 0 }, 2, 1)).toBe('=$A3>C$1');
  });

  it('evaluates cellIs formula operands relative to each cell', () => {
    const ctrl = sheet([
      ['5', '4'],
      ['5', '6']
    ]);
    ctrl.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '=B1', style: RED, ranges: [col(0, 1)] });
    expect(!!ctrl.getConditionalFormat(0, 0)).toBe(true);
    expect(!!ctrl.getConditionalFormat(1, 0)).toBe(false);
  });

  it('re-evaluates incrementally after edits, including dependent formulas', () => {
    const ctrl = sheet([['1'], ['2'], ['=A1*10']]);
    ctrl.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '15', style: RED, ranges: [col(0, 2)] });
    expect(!!ctrl.getConditionalFormat(2, 0)).toBe(false);
    ctrl.setCellValue('r0', 'c0', '3');
    // A3 = 30 now: the dependent formula's look updates too.
    expect(!!ctrl.getConditionalFormat(2, 0)).toBe(true);
    expect(!!ctrl.getConditionalFormat(0, 0)).toBe(false);
    ctrl.setCellValue('r1', 'c0', '20');
    expect(!!ctrl.getConditionalFormat(1, 0)).toBe(true);
  });

  it('re-scales a whole colour scale when one value changes', () => {
    const ctrl = sheet([['0'], ['50'], ['100']]);
    ctrl.addConditionalFormat(createConditionalFormatRule({ kind: 'colorScale2', ranges: [col(0, 2)] }));
    const before = ctrl.getConditionalFormat(1, 0)?.fill;
    ctrl.setCellValue('r2', 'c0', '200');
    expect(ctrl.getConditionalFormat(1, 0)?.fill).not.toBe(before);
  });

  it('incremental updates give the same result as a full evaluation', () => {
    const values: unknown[][] = Array.from({ length: 30 }, (_, i) => [i % 7, `t${i % 5}`]);
    const s: ConditionalFormatSheet = { rowCount: 30, colCount: 2, getValue: (r, c) => values[r][c] };
    const rules: ConditionalFormatRule[] = [
      rule({ type: 'cellIs', operator: 'greaterThan', value: '3', style: RED, ranges: [col(0, 29)] }, 'a'),
      rule({ type: 'duplicate', style: { bold: true }, ranges: [col(0, 29, 1)] }, 'b'),
      rule({ type: 'dataBar', ranges: [col(0, 29)] }, 'c'),
      rule({ type: 'top10', rank: 3, style: { italic: true }, ranges: [col(0, 29)] }, 'd')
    ];
    const engine = new ConditionalFormatEngine(s);
    engine.evaluate(rules);
    values[4][0] = 100;
    values[7][1] = 'unique!';
    const incremental = engine.update(rules, [{ row: 4, col: 0 }, { row: 7, col: 1 }]);
    const full = evaluateConditionalFormats(s, rules);
    expect(Object.fromEntries(Array.from(incremental.entries(), ([p, f]) => [`${p.row}:${p.col}`, f]))).toEqual(
      Object.fromEntries(Array.from(full.entries(), ([p, f]) => [`${p.row}:${p.col}`, f]))
    );
  });
});

describe('conditional formatting: rule manager', () => {
  it('adds new rules at the highest priority, reorders, updates and deletes them (undoably)', () => {
    const ctrl = sheet([['1'], ['2']]);
    const a = ctrl.addConditionalFormat({ type: 'blanks', style: RED, ranges: [col(0, 1)] });
    const b = ctrl.addConditionalFormat({ type: 'errors', style: RED, ranges: [col(0, 1)] });
    expect(ctrl.getConditionalFormats().map((r) => r.id)).toEqual([b, a]);
    expect(ctrl.moveConditionalFormat(a, { by: -1 })).toBe(true);
    expect(ctrl.getConditionalFormats().map((r) => r.id)).toEqual([a, b]);
    expect(ctrl.moveConditionalFormat(a, 0)).toBe(false);
    ctrl.updateConditionalFormat(a, { stopIfTrue: true });
    expect(ctrl.getConditionalFormats()[0].stopIfTrue).toBe(true);
    ctrl.deleteConditionalFormat(b);
    expect(ctrl.getConditionalFormats().map((r) => r.id)).toEqual([a]);
    ctrl.undo();
    expect(ctrl.getConditionalFormats().map((r) => r.id)).toEqual([a, b]);
    ctrl.undo();
    expect(ctrl.getConditionalFormats()[0].stopIfTrue).toBeUndefined();
    ctrl.redo();
    expect(ctrl.getConditionalFormats()[0].stopIfTrue).toBe(true);
    const last = ctrl.addConditionalFormat({ type: 'noErrors', style: RED, ranges: [col(0, 1)] }, { priority: 'last' });
    expect(ctrl.getConditionalFormats().at(-1)?.id).toBe(last);
  });

  it('clears rules from a selection, keeping their other cells', () => {
    const ctrl = sheet([['1'], ['2'], ['3']]);
    ctrl.addConditionalFormat({ type: 'noBlanks', style: RED, ranges: [col(0, 2)] });
    ctrl.clearConditionalFormats(col(1, 1));
    expect(ctrl.getConditionalFormats()[0].ranges).toEqual([col(0, 0), col(2, 2)]);
    expect(!!ctrl.getConditionalFormat(1, 0)).toBe(false);
    expect(!!ctrl.getConditionalFormat(2, 0)).toBe(true);
    ctrl.clearConditionalFormats(col(0, 2));
    expect(ctrl.getConditionalFormats()).toEqual([]);
  });

  it('moves applies-to ranges and rule formulas when rows and columns are inserted or deleted', () => {
    const ctrl = sheet([['1', '2'], ['3', '4'], ['5', '6']], 5, 4);
    ctrl.addConditionalFormat({ type: 'expression', formula: '=$B2>3', style: RED, ranges: [{ startRow: 1, startCol: 0, endRow: 2, endCol: 0 }] });
    ctrl.insertRow(0);
    let rule0 = ctrl.getConditionalFormats()[0];
    expect(rule0.ranges).toEqual([{ startRow: 2, startCol: 0, endRow: 3, endCol: 0 }]);
    expect(rule0.type === 'expression' && rule0.formula).toBe('=$B3>3');
    ctrl.insertColumn(0);
    rule0 = ctrl.getConditionalFormats()[0];
    expect(rule0.ranges).toEqual([{ startRow: 2, startCol: 1, endRow: 3, endCol: 1 }]);
    expect(rule0.type === 'expression' && rule0.formula).toBe('=$C3>3');
    // Inserting inside the range grows it.
    ctrl.insertRow(3);
    expect(ctrl.getConditionalFormats()[0].ranges).toEqual([{ startRow: 2, startCol: 1, endRow: 4, endCol: 1 }]);
    // Deleting every column of the range removes the rule.
    ctrl.deleteColumn(ctrl.document.columns[1].id);
    expect(ctrl.getConditionalFormats()).toEqual([]);
  });

  it('adjusts ranges like merges: shift, grow, shrink, drop', () => {
    const r: CellRange = { startRow: 2, startCol: 0, endRow: 4, endCol: 1 };
    expect(adjustRangesForStructuralChange([r], { axis: 'row', index: 0, type: 'insert' })).toEqual([{ ...r, startRow: 3, endRow: 5 }]);
    expect(adjustRangesForStructuralChange([r], { axis: 'row', index: 3, type: 'insert' })).toEqual([{ ...r, endRow: 5 }]);
    expect(adjustRangesForStructuralChange([r], { axis: 'row', index: 3, type: 'delete' })).toEqual([{ ...r, endRow: 3 }]);
    expect(adjustRangesForStructuralChange([col(1, 1)], { axis: 'row', index: 1, type: 'delete' })).toEqual([]);
    expect(adjustRangesForStructuralChange([r], { axis: 'col', index: 5, type: 'insert' })).toEqual([r]);
  });

  it('subtracts, formats and parses rule ranges', () => {
    const r: CellRange = { startRow: 0, startCol: 0, endRow: 2, endCol: 2 };
    const parts = subtractRange(r, { startRow: 1, startCol: 1, endRow: 1, endCol: 1 });
    expect(parts.reduce((n, p) => n + (p.endRow - p.startRow + 1) * (p.endCol - p.startCol + 1), 0)).toBe(8);
    expect(formatRuleRanges([r, col(4, 4, 3)])).toBe('A1:C3, D5');
    expect(parseRuleRanges('A1:C3, $D$5')).toEqual([r, col(4, 4, 3)]);
    expect(parseRuleRanges('A1:C3, nope')).toBeNull();
  });

  it('reads rules from a loaded document and serializes them with it', () => {
    const ctrl = sheet([['1'], ['20']]);
    ctrl.addConditionalFormat(createConditionalFormatRule({ kind: 'greaterThan', value: '10', ranges: [col(0, 1)] }));
    const saved = JSON.parse(JSON.stringify(ctrl.document));
    const other = new SpreadsheetController({ document: saved });
    expect(other.getConditionalFormat(1, 0)).toEqual({ fill: '#ffc7ce', color: '#9c0006' });
  });
});

describe('conditional formatting: presets, menu and rendering helpers', () => {
  it('builds rules from presets and describes them', () => {
    const ranges = [col(0, 3)];
    expect(describeConditionalFormat(createConditionalFormatRule({ kind: 'between', value: '1', value2: '5', ranges }) as ConditionalFormatRule)).toBe(
      'Cell value between 1 and 5'
    );
    expect(describeConditionalFormat(createConditionalFormatRule({ kind: 'colorScale3', ranges }) as ConditionalFormatRule)).toBe(
      'Color scale (min → P50 → max)'
    );
    expect(createConditionalFormatRule({ kind: 'bottom10', rank: 3, ranges })).toMatchObject({ type: 'top10', bottom: true, rank: 3 });
    expect(createConditionalFormatRule({ kind: 'iconSet', ranges })).toMatchObject({ type: 'iconSet', set: '3TrafficLights1' });
  });

  it('adds rules from the context menu and opens the manager panel', () => {
    const ctrl = sheet([['1'], ['2']]);
    ctrl.selectRange(col(0, 1));
    const items = getSpreadsheetMenuItems(ctrl, { row: 0, col: 0 });
    expect(items.find((i) => i.id === 'conditional-format-manage')?.panel).toBe('conditionalFormatting');
    expect(items.find((i) => i.id === 'data-validation-manage')?.panel).toBe('dataValidation');
    expect(items.find((i) => i.id === 'conditional-format-clear')?.disabled).toBe(true);
    runSpreadsheetMenuItem(items.find((i) => i.id === 'conditional-format-greater-than')!, () => '1');
    expect(ctrl.getConditionalFormats()).toHaveLength(1);
    expect(!!ctrl.getConditionalFormat(1, 0)).toBe(true);
    runSpreadsheetMenuItem(items.find((i) => i.id === 'conditional-format-data-bars')!);
    expect(ctrl.getConditionalFormat(1, 0)?.dataBar).toBeDefined();
    const after = getSpreadsheetMenuItems(ctrl, { row: 0, col: 0 });
    runSpreadsheetMenuItem(after.find((i) => i.id === 'conditional-format-clear')!);
    expect(ctrl.getConditionalFormats()).toEqual([]);
  });

  it('turns a look into CSS', () => {
    const css = getConditionalFormatCss({ fill: '#fff000', color: '#111111', bold: true, italic: true, underline: true, strikethrough: true });
    expect(css).toEqual({ background: '#fff000', color: '#111111', fontWeight: '700', fontStyle: 'italic', textDecoration: 'underline line-through' });
    expect(conditionalFormatStyleString(css)).toBe(
      'background: #fff000; color: #111111; font-weight: 700; font-style: italic; text-decoration: underline line-through;'
    );
    expect(getDataBarCss({ fraction: 0.5, color: '#638ec6', gradient: false }).width).toBe('50%');
    // A fill without a font colour gets readable text in any theme.
    expect(getConditionalFormatCss({ fill: '#ffeb84' }).color).toBe('#1f2328');
    expect(getConditionalFormatCss({ fill: '#203040' }).color).toBe('#ffffff');
    expect(getConditionalFormatCss({ fill: 'var(--x)' }).color).toBeUndefined();
  });
});

describe('conditional formatting: performance', () => {
  it(
    'evaluates large ranges in time that grows linearly',
    () => {
      const time = (n: number) => {
        const values = Array.from({ length: n }, (_, i) => [(i * 7919) % 1000, `v${i % 97}`]);
        const s: ConditionalFormatSheet = { rowCount: n, colCount: 2, getValue: (r, c) => values[r][c] };
        const rules: ConditionalFormatRule[] = [
          rule({ type: 'colorScale', ranges: [col(0, n - 1)], stops: [{ value: { type: 'min' }, color: '#ff0000' }, { value: { type: 'max' }, color: '#00ff00' }] }, 'a'),
          rule({ type: 'duplicate', style: RED, ranges: [col(0, n - 1, 1)] }, 'b'),
          rule({ type: 'containsText', text: 'v1', style: RED, ranges: [col(0, n - 1, 1)] }, 'c')
        ];
        const start = performance.now();
        evaluateConditionalFormats(s, rules);
        return performance.now() - start;
      };
      // Best of three runs each, so GC pauses and machine load don't decide.
      const best = (n: number) => Math.min(time(n), time(n), time(n));
      time(2000); // warm up
      const small = Math.max(best(5000), 1);
      const large = best(40000);
      // 8x the cells: linear is ~8x, quadratic would be ~64x; allow slack for machine load.
      expect(large / small).toBeLessThan(24);
    },
    30000
  );
});

describe('conditional formatting: multiple sheets', () => {
  const setA1 = (c: SpreadsheetController, raw: string) =>
    c.setCellValue(c.document.rows[0].id, c.document.columns[0].id, raw);

  it('keeps rules per sheet and re-evaluates cross-sheet values after switching sheets', () => {
    const c = sheet([['']], 2, 2);
    const summary = c.activeSheetId;
    const data = c.addSheet({ name: 'Data' });
    setA1(c, '4');
    c.setActiveSheet(summary);
    setA1(c, '=Data!A1*2');
    c.addConditionalFormat({ type: 'cellIs', operator: 'greaterThan', value: '10', style: RED, ranges: [col(0, 0)] });
    expect(c.getConditionalFormat(0, 0)).toBeUndefined(); // 8

    // The other sheet has no rules of its own.
    c.setActiveSheet(data);
    expect(c.getConditionalFormatOverlay().get(0, 0)).toBeUndefined();
    setA1(c, '6');

    // Back on the summary sheet the dependent formula (now 12) matches.
    c.setActiveSheet(summary);
    expect(c.getConditionalFormat(0, 0)).toEqual(RED);

    // An incremental edit on the active sheet still updates the overlay.
    setA1(c, '=Data!A1');
    expect(c.getConditionalFormat(0, 0)).toBeUndefined();
  });
});
