// Test cases re-expressed from gridcraft/crates/numfmt/src/{tests.rs,decimal.rs,parse.rs,render.rs}
// and gridcraft/crates/numfmt/tests/poi_number_format_approx.rs (MIT OR Apache-2.0,
// © ArtCraft Team and contributors). See THIRD_PARTY_NOTICES.md.
import { describe, expect, it } from 'vitest';
import {
  NumberFormat,
  MAX_NUMBER_FORMAT_CODE_CHARS,
  builtinNumberFormat,
  builtinNumberFormatId,
  clearNumberFormatCache,
  dateValueToSerial,
  formatGeneralFit,
  formatNumberFormatValue,
  formatTextFunction,
  numberFormatColorToCss,
  cellFormatForNumberFormat,
  numberFormatForCellFormat,
  NUMBER_FORMAT_PRESETS,
} from '../src/spreadsheet';
import { decimalDigits, fixed } from '../src/spreadsheet/numfmt/decimal';
import { parseSections, splitSections } from '../src/spreadsheet/numfmt/parse';
import { approximate } from '../src/spreadsheet/numfmt/render';
import { POI_NUMBER_FORMAT_APPROX_CASES } from './fixtures/poi-number-format-approx';

const f = (code: string, n: number) => NumberFormat.parse(code).format(n).text;
const full = (code: string, v: unknown) => NumberFormat.parse(code).format(v);
const t = (code: string, s: string) => NumberFormat.parse(code).format(s).text;
const text = (v: unknown, code: string) => formatTextFunction(v, code);

describe('number formats: numbers', () => {
  it('formats digits, grouping and rounding', () => {
    expect(f('0.00', 1234.567)).toBe('1234.57');
    expect(f('#,##0', 1234567)).toBe('1,234,567');
    expect(f('#,##0', -1234567.89)).toBe('-1,234,568');
    expect(f('#,##0.00', 0)).toBe('0.00');
    expect(f('0', 0.5)).toBe('1');
    expect(f('0', -2.5)).toBe('-3');
    expect(f('0.00', 2.675)).toBe('2.68');
    expect(f('0.00', 1.005)).toBe('1.01');
    expect(f('0.0', -0.04)).toBe('0.0');
    expect(f('00000', 123)).toBe('00123');
    expect(f('000-00-0000', 123456789)).toBe('123-45-6789');
    expect(f('#.##', 0.5)).toBe('.5');
    expect(f('0.##', 1)).toBe('1.');
    expect(f('#', 0)).toBe('');
    expect(f('0.0?', 1.5)).toBe('1.5 ');
    expect(f('??0.0', 1.5)).toBe('  1.5');
    expect(f('.00', 12.5)).toBe('12.50');
    expect(f('0', 1e20)).toBe('100000000000000000000');
    expect(f('0.0', 1e-20)).toBe('0.0');
    expect(f('0,000', 5)).toBe('0,005');
    expect(f('#,##0.000', 1234.5)).toBe('1,234.500');
  });

  it('scales by commas and percent', () => {
    expect(f('#,##0,', 1234567)).toBe('1,235');
    expect(f('0.0,,', 12345678)).toBe('12.3');
    expect(f('0,"K"', 12345)).toBe('12K');
    expect(f('0%', 0.256)).toBe('26%');
    expect(f('0.00%', 0.12345)).toBe('12.35%');
    expect(f('0%%', 0.5)).toBe('5000%%');
    expect(f('0%', -0.5)).toBe('-50%');
    expect(NumberFormat.parse('0.0%').isPercent()).toBe(true);
    expect(NumberFormat.parse('0.0').isPercent()).toBe(false);
  });

  it('picks sections and colours', () => {
    const r = full('#,##0.00;[Red](#,##0.00)', -5);
    expect(r).toEqual({ text: '(5.00)', color: 'red', numeric: true });
    expect(full('#,##0.00;[Red](#,##0.00)', 5)).toEqual({ text: '5.00', numeric: true });
    expect(f('0;-0;;@', 0)).toBe('');
    expect(t('0;-0;;@', 'hi')).toBe('hi');
    expect(f('0;-0;"zero"', 0)).toBe('zero');
    expect(f('0;-0;"zero"', 0.001)).toBe('0');
    expect(f('0_);(0)', 5)).toBe('5 ');
    expect(f('0_);(0)', -5)).toBe('(5)');
    expect(f(';;;', 5)).toBe('');
    expect(t(';;;', 'x')).toBe('');
    expect(full('[Color10]0', 1).color).toBe('color10');
    expect(full('[blue]0', 1).color).toBe('blue');
    expect(full('[Color99]0', 1).color).toBeUndefined();
    expect(numberFormatColorToCss('red')).toBe('#FF0000');
    expect(numberFormatColorToCss('color10')).toBe('#008000');
  });

  it('applies conditions', () => {
    const c = '[>=100]"big";[<0]"neg";"small"';
    expect(f(c, 150)).toBe('big');
    expect(f(c, -5)).toBe('neg');
    expect(f(c, 50)).toBe('small');
    expect(f('[<1]0.00;0', 0.5)).toBe('0.50');
    expect(f('[<1]0.00;0', 5)).toBe('5');
    // Like Excel, a multi-section format never adds the minus sign itself.
    expect(f('[<1]0.00;0', -5)).toBe('5.00');
    expect(f('[>=1000]0,"K";0', -5)).toBe('5');
    expect(f('[>=1000]0,"K"', -5)).toBe('-5');
    const phone = '[<=9999999]###-####;(###) ###-####';
    expect(f(phone, 5551234)).toBe('555-1234');
    expect(f(phone, 2125551234)).toBe('(212) 555-1234');
    expect(full('[Red][<=100]0;[Blue][>100]0', 150).color).toBe('blue');
  });

  it('formats scientific notation', () => {
    expect(f('0.00E+00', 12345)).toBe('1.23E+04');
    expect(f('0.00E+00', 0.000123)).toBe('1.23E-04');
    expect(f('0.00E+00', 0)).toBe('0.00E+00');
    expect(f('0.00E-00', 12345)).toBe('1.23E04');
    expect(f('0.00e+00', 12345)).toBe('1.23e+04');
    expect(f('##0.0E+0', 12345)).toBe('12.3E+3');
    expect(f('0.0E+0', 0.00001)).toBe('1.0E-5');
    expect(f('0.000E+00', 1e-300)).toBe('1.000E-300');
    expect(f('0.00E+00', 9.999)).toBe('1.00E+01');
    expect(f('0.00E+00', -12345)).toBe('-1.23E+04');
  });

  it('drops the minus sign of a negative number that rounds to zero', () => {
    const cases: Array<[string, number, string]> = [
      ['0.00', -0.0033, '0.00'],
      ['0.00', -2.89e-9, '0.00'],
      ['0.00', -0.005, '-0.01'],
      ['0', -0.4, '0'],
      ['0', -0.5, '-1'],
      ['0.0', -0.004, '0.0'],
      ['#,##0.00', -0.004, '0.00'],
      ['0.00%', -2.89e-9, '0.00%'],
      ['0.00%', -0.0033, '-0.33%'],
      ['0.00;(0.00)', -0.0033, '(0.00)'],
      ['0.00;-0.00;"zero"', -0.0033, '-0.00'],
      ['0.00E+00', -2.89e-9, '-2.89E-09'],
    ];
    for (const [code, n, want] of cases) expect(f(code, n), `${code} with ${n}`).toBe(want);
  });

  it('pads ? placeholders and their thousands separators with spaces', () => {
    const cases: Array<[string, number, string]> = [
      ['?,???????', 1234567, ' 1,234,567'],
      ['?,????????', 1234567, '  1,234,567'],
      ['?,?????????', 1234567, '    1,234,567'],
      ['?,?????????', -1234567, '-    1,234,567'],
      ['?,??????', 1234567, '1,234,567'],
      ['?,????', 12345, '12,345'],
      ['0,000000000', 1234567, '0,001,234,567'],
    ];
    for (const [code, v, want] of cases) expect(f(code, v), `${code} with ${v}`).toBe(want);
  });
});

describe('number formats: fractions', () => {
  it('approximates fractions', () => {
    expect(f('# ?/?', 1.5)).toBe('1 1/2');
    expect(f('# ?/?', 0.25)).toBe(' 1/4');
    expect(f('# ?/?', 2)).toBe('2    ');
    expect(f('# ?/?', 0)).toBe('0    ');
    expect(f('# ?/?', -1.5)).toBe('-1 1/2');
    expect(f('# ??/??', Math.PI)).toBe('3 14/99');
    expect(f('# ??/??', 1 / 3)).toBe('  1/3 ');
    expect(f('?/8', 0.5)).toBe('4/8');
    expect(f('# ?/8', 2.125)).toBe('2 1/8');
    expect(f('?/?', 1.5)).toBe('3/2');
    expect(f('# ?/?', 0.99)).toBe('1    ');
    expect(f('# ???/???', 0.123)).toBe(' 100/813');
    expect(f('# ???/???', 0.5)).toBe('   1/2  ');
    expect(approximate(0.5, 9)).toEqual([1, 2]);
    expect(approximate(0.333333, 9)).toEqual([1, 3]);
    expect(approximate(Math.PI - 3, 99)).toEqual([14, 99]);
    expect(approximate(Math.PI - 3, 9)).toEqual([1, 7]);
    expect(approximate(0, 9)).toEqual([0, 1]);
    expect(approximate(0.999, 9)).toEqual([1, 1]);
  });

  it('renders literals around the parts as Excel does', () => {
    const cases: Array<[string, number, string]> = [
      ['|#\\:#/#|', 23.75, '|23:3/4|'],
      ['|#\\:#=/=#|', 23.75, '|23:3=/=4|'],
      ['|#\\:#=/=#|', -23.75, '-|23:3=/=4|'],
      ['|#\\:? ?=/=#|', 23.75, '|2:3 3=/=4|'],
      ['|#-#-#\\:#/#|', 23.75, '|-2-3:3/4|'],
      ['|#\\:#/#|', 0.75, '|3/4|'],
      ['|#\\:#/#|', -0.75, '-|3/4|'],
      ['|#-#-#\\:#/#|', 0.75, '|--3/4|'],
      ['|#\\:#=/=#|', 0.75, '|3=/=4|'],
      ['|#\\:0=/=?|', 0.75, '|3=/=4|'],
      ['|#\\:?=/=#|', 0.75, '| 3=/=4|'],
      ['|?\\:#=/=#|', 0.75, '|  3=/=4|'],
      ['|?\\:0=/=0|', -0.75, '-|  3=/=4|'],
      ['|?\\:?0=/=#|', 0.75, '|   3=/=4|'],
      ['|0\\:#=/=#|', 0.75, '|0:3=/=4|'],
      ['|#\\:#/#|', 0, '|0|'],
      ['|#\\:#/#|', 1, '|1|'],
      ['|#\\:#/#|', -1, '-|1|'],
      ['|#-#-#\\:#/#|', 0, '|--0|'],
      ['|#-#-#\\:#/#|', 1, '|--1|'],
      ['|#\\:#=/=0|', 0, '|0|'],
      ['|0\\:#=/=#|', 1, '|1|'],
      ['|#\\:#=/=?|', 0, '|0      |'],
      ['|#\\:?=/=0|', 1, '|1      |'],
      ['|?\\:#=/=#|', 0, '|0      |'],
      ['|?\\:#=/=#|', -1, '-|1      |'],
      ['|#\\:? ?=/=#|', 0, '|:0      |'],
      ['|#\\:? ?=/=?|', 1, '|:1      |'],
      ['|#\\:0=/=#|', 0, '|0=/=1|'],
      ['|?\\:0=/=?|', 0, '|0:0=/=1|'],
      ['|0\\:0=/=0|', 0, '|0:0=/=1|'],
      ['|#\\:0=/=#|', 1, '|1:0=/=1|'],
      ['|?\\:0=/=#|', -1, '-|1:0=/=1|'],
      ['|#\\:? ?0#/000', 0, '|:0  00/001'],
      ['|#\\:? ?0#/000', 1, '|:1  00/001'],
      ['|#\\:? ?0#/000', 23.75, '|2:3  03/004'],
      ['|#\\:? ?#/#|', 23.75, '|2:3  3/4|'],
      ['|#_#/#|', 3.75, '|15 /4|'],
      ['|#_#/#|', -0.75, '-|3 /4|'],
      ['|#_#/#|', 0, '|0 /1|'],
      ['|#_#/#|', -1, '-|1 /1|'],
      ['|#_#=/=?|', 3.75, '|15 =/=4|'],
      ['|#_?=/=0|', 0, '|0 =/=1|'],
      ['|#_?=/=?|', 1, '|1 =/=1|'],
    ];
    for (const [code, v, want] of cases) expect(f(code, v), `${code} with ${v}`).toBe(want);
  });

  it('survives a denominator with 65536 zeros', () => {
    const code = `# ?/${'0'.repeat(65_536)}`;
    expect(NumberFormat.parseUncapped(code).format(0.5).text.startsWith(' 1/')).toBe(true);
    expect(f('# ?/000', 0.5)).toBe(' 1/002');
  });
});

describe('number formats: literals, fill, dates, text', () => {
  it('handles literals, currency tags and fill', () => {
    expect(f('"$"#,##0.00', 3)).toBe('$3.00');
    expect(f('$#,##0.00', -3)).toBe('-$3.00');
    expect(f('[$€-407]#,##0.00', 1234.5)).toBe('€1,234.50');
    expect(f('0" units"', 5)).toBe('5 units');
    expect(f('\\A0', 5)).toBe('A5');
    expect(f('(0)', 5)).toBe('(5)');
    expect(full('*-0', 5)).toEqual({ text: '5', fill: { char: '-', index: 0 }, numeric: true });
    const acct = builtinNumberFormat(44)!;
    expect(full(acct, 0)).toMatchObject({ text: ' $-   ', fill: { char: ' ', index: 2 } });
    expect(full(acct, 1234.5)).toMatchObject({ text: ' $1,234.50 ', fill: { char: ' ', index: 2 } });
    expect(full(acct, -1234.5)).toMatchObject({ text: ' $(1,234.50)', fill: { char: ' ', index: 2 } });
    expect(full(acct, 'abc')).toMatchObject({ text: ' abc ', numeric: false });
    expect(full('-* 0', -5)).toMatchObject({ text: '--5', fill: { char: ' ', index: 2 } });
  });

  it('formats dates and times (1900 date system)', () => {
    expect(f('m/d/yyyy', 46302)).toBe('10/7/2026');
    expect(f('dddd, mmmm d, yyyy', 46302)).toBe('Wednesday, October 7, 2026');
    expect(f('ddd mmm yy', 46302)).toBe('Wed Oct 26');
    expect(f('mmmmm', 46302)).toBe('O');
    expect(f('dd/mm/yyyy', 46302)).toBe('07/10/2026');
    expect(f('d-mmm-yy', 46302)).toBe('7-Oct-26');
    expect(f('e', 46302)).toBe('2026');
    expect(f('YYYY-MM-DD', 46302)).toBe('2026-10-07');
    expect(f('yyyy-mm-dd hh:mm:ss', 46302.5)).toBe('2026-10-07 12:00:00');
    expect(f('h:mm AM/PM', 0.75)).toBe('6:00 PM');
    expect(f('h AM/PM', 0)).toBe('12 AM');
    expect(f('h a/p', 0.25)).toBe('6 a');
    expect(f('hh:mm', 0.75)).toBe('18:00');
    expect(f('[h]:mm', 1.5)).toBe('36:00');
    expect(f('[h]:mm:ss', 2.25)).toBe('54:00:00');
    expect(f('[mm]:ss', 1 / 24)).toBe('60:00');
    expect(f('[s]', 1 / 1440)).toBe('60');
    expect(f('mm:ss.0', 61.2 / 86400)).toBe('01:01.2');
    expect(f('mm:ss.00', 61.25 / 86400)).toBe('01:01.25');
    expect(f('h:mm:ss', 0.5 + 59.6 / 86400)).toBe('12:01:00');
    expect(f('h:mm', 0.5 + 40 / 86400)).toBe('12:00');
    // Excel's fictitious 1900-02-29 (serial 60) and 1900-01-00 (serial 0).
    expect(f('m/d/yyyy', 60)).toBe('2/29/1900');
    expect(f('m/d/yyyy', 0)).toBe('1/0/1900');
    expect(f('m/d/yyyy', 61)).toBe('3/1/1900');
    expect(f('m/d/yyyy', 2958465)).toBe('12/31/9999');
    expect(f('m/d/yyyy', 2958466)).toBe('########');
    expect(f('m/d/yyyy', -1)).toBe('########');
    expect(f('m/d/yyyy', 3e6)).toBe('########');
    expect(f('[$-409]m/d/yyyy', 46302)).toBe('10/7/2026');
    expect(f('m/d/yyyy h:mm', 46302.75)).toBe('10/7/2026 18:00');
    expect(f('mmss.0', 0)).toBe('0000.0');
    expect(NumberFormat.parse('h:mm').isDate()).toBe(true);
    expect(NumberFormat.parse('0.00').isDate()).toBe(false);
  });

  it('formats ISO date text as dates', () => {
    expect(dateValueToSerial('2026-10-07')).toBe(46302);
    expect(dateValueToSerial('2026-10-07 18:00:00')).toBe(46302.75);
    expect(dateValueToSerial('1900-03-01')).toBe(61);
    expect(dateValueToSerial('2026-02-30')).toBeNull();
    expect(dateValueToSerial('hello')).toBeNull();
    expect(formatNumberFormatValue('2026-10-07', 'dddd')).toEqual({ text: 'Wednesday', numeric: true });
    expect(formatNumberFormatValue('2026-10-07 18:00:00', 'h:mm AM/PM').text).toBe('6:00 PM');
  });

  it('formats text, booleans and errors', () => {
    expect(t('@', 'hello')).toBe('hello');
    expect(t('"<"@">"', 'x')).toBe('<x>');
    expect(t('0.00', 'abc')).toBe('abc');
    expect(f('@', 5)).toBe('5');
    expect(NumberFormat.parse('@').isText()).toBe(true);
    expect(NumberFormat.parse('0;@').isText()).toBe(false);
    const g = NumberFormat.general();
    expect(g.format(true).text).toBe('TRUE');
    expect(NumberFormat.parse('0.00').format(false).text).toBe('FALSE');
    expect(g.format('#DIV/0!').text).toBe('#DIV/0!');
    expect(g.format('')).toEqual({ text: '', numeric: false });
    expect(g.format('x').numeric).toBe(false);
  });

  it('formats General like a default-width cell', () => {
    expect(f('General', 1e11)).toBe('1E+11');
    expect(f('General', 12345678901)).toBe('12345678901');
    expect(f('General', 0.1 + 0.2)).toBe('0.3');
    expect(f('General', -1234.5)).toBe('-1234.5');
    expect(f('', 1 / 3)).toBe('0.333333333');
    expect(f('general', 123456.789012)).toBe('123456.789');
    expect(f('General" units"', 5)).toBe('5 units');
    expect(f('General;[Red]-General', -5)).toBe('-5');
    expect(NumberFormat.parse('General').isGeneral()).toBe(true);
    expect(NumberFormat.parse('0.0').code).toBe('0.0');
  });

  it('fits General into a width', () => {
    expect(formatGeneralFit(1e11, 11)).toBe('1E+11');
    expect(formatGeneralFit(12345678901, 11)).toBe('12345678901');
    expect(formatGeneralFit(123456789012, 11)).toBe('1.23457E+11');
    expect(formatGeneralFit(0.1 + 0.2, 11)).toBe('0.3');
    expect(formatGeneralFit(1 / 3, 11)).toBe('0.333333333');
    expect(formatGeneralFit(123456.789012, 11)).toBe('123456.789');
    expect(formatGeneralFit(1e-10, 11)).toBe('1E-10');
    expect(formatGeneralFit(0.0000123456789, 11)).toBe('1.23457E-05');
    expect(formatGeneralFit(0.0001, 11)).toBe('0.0001');
    expect(formatGeneralFit(-5, 11)).toBe('-5');
    expect(formatGeneralFit(0, 11)).toBe('0');
    expect(formatGeneralFit(1234.5678, 6)).toBe('1234.6');
    expect(formatGeneralFit(1234.5678, 4)).toBe('1235');
    expect(formatGeneralFit(123456, 5)).toBe('1E+05');
    expect(formatGeneralFit(123456, 3)).toBeNull();
    expect(formatGeneralFit(9.99999999999, 5)).toBe('10');
    expect(formatGeneralFit(NaN, 11)).toBeNull();
    expect(formatGeneralFit(1.7976931348623157e308, 11)).toBe('1.7977E+308');
  });

  it('guesses the format category', () => {
    expect(NumberFormat.general().kind()).toBe('general');
    expect(NumberFormat.parse('0.00').kind()).toBe('number');
    expect(NumberFormat.parse('#,##0.00;[Red](#,##0.00)').kind()).toBe('number');
    expect(NumberFormat.parse('"$"#,##0.00').kind()).toBe('currency');
    expect(NumberFormat.parse(builtinNumberFormat(44)!).kind()).toBe('accounting');
    expect(NumberFormat.parse('m/d/yyyy').kind()).toBe('date');
    expect(NumberFormat.parse('h:mm AM/PM').kind()).toBe('time');
    expect(NumberFormat.parse('0%').kind()).toBe('percentage');
    expect(NumberFormat.parse('# ?/?').kind()).toBe('fraction');
    expect(NumberFormat.parse('0.00E+00').kind()).toBe('scientific');
    expect(NumberFormat.parse('@').kind()).toBe('text');
    expect(NumberFormat.parse('00000').kind()).toBe('special');
    expect(NumberFormat.parse('"hello"').kind()).toBe('custom');
  });

  it('maps codes to and from CellFormat kinds', () => {
    expect(numberFormatForCellFormat('currency')).toBe('"$"#,##0.00');
    expect(numberFormatForCellFormat('percentage')).toBe('0%');
    expect(numberFormatForCellFormat('date')).toBe('m/d/yyyy');
    expect(numberFormatForCellFormat('text')).toBeUndefined();
    expect(numberFormatForCellFormat(undefined)).toBeUndefined();
    expect(cellFormatForNumberFormat('"$"#,##0.00')).toBe('currency');
    expect(cellFormatForNumberFormat('0.0%')).toBe('percentage');
    expect(cellFormatForNumberFormat('m/d/yyyy')).toBe('date');
    expect(cellFormatForNumberFormat('0.00')).toBe('number');
    expect(cellFormatForNumberFormat('@')).toBe('text');
    expect(cellFormatForNumberFormat('General')).toBeUndefined();
    expect(cellFormatForNumberFormat('h:mm')).toBeUndefined();
    expect(NUMBER_FORMAT_PRESETS.map((p) => p.id)).toEqual(['general', 'number', 'currency', 'percent', 'date', 'time']);
  });

  it('knows the built-in formats', () => {
    expect(builtinNumberFormat(0)).toBe('General');
    expect(builtinNumberFormat(14)).toBe('m/d/yyyy');
    expect(builtinNumberFormat(49)).toBe('@');
    expect(builtinNumberFormat(30)).toBeUndefined();
    expect(builtinNumberFormat(50)).toBeUndefined();
    expect(builtinNumberFormatId('m/d/yyyy')).toBe(14);
    expect(builtinNumberFormatId('0.00%')).toBe(10);
    expect(builtinNumberFormatId('GENERAL')).toBe(0);
    expect(builtinNumberFormatId('[h]:mm:ss')).toBe(46);
    expect(builtinNumberFormatId('#,##0.00_);(#,##0.00)')).toBeUndefined();
    for (let id = 0; id <= 60; id++) {
      const code = builtinNumberFormat(id);
      if (code) expect(builtinNumberFormatId(code)).toBe(id);
    }
    expect(f(builtinNumberFormat(5)!, -1234)).toBe('($1,234)');
    expect(f(builtinNumberFormat(12)!, 0.5)).toBe(' 1/2');
    expect(f(builtinNumberFormat(47)!, 61.2 / 86400)).toBe('0101.2');
  });
});

describe('number formats: TEXT()', () => {
  it('formats values like Excel TEXT()', () => {
    expect(text(1234.5, '$#,##0.00')).toEqual({ text: '$1,234.50' });
    expect(text('5', '0.00')).toEqual({ text: '5.00' });
    expect(text('abc', '0.00')).toEqual({ text: 'abc' });
    expect(text('#N/A', '0')).toEqual({ error: '#N/A' });
    expect(text(46302, 'yyyy')).toEqual({ text: '2026' });
    expect(text(0.5, 'General')).toEqual({ text: '0.5' });
    expect(text(1 / 3, '0.000')).toEqual({ text: '0.333' });
    expect(text('', '0.00')).toEqual({ text: '0.00' });
    expect(text(5, '')).toEqual({ text: '' });
    expect(text(-1, 'm/d/yyyy')).toEqual({ error: '#VALUE!' });
    expect(text(Infinity, '0')).toEqual({ error: '#NUM!' });
    expect(text(true, '0')).toEqual({ text: 'TRUE' });
    expect(text(-0.0033, '0')).toEqual({ text: '0' });
    expect(text(-0.4, '0')).toEqual({ text: '0' });
    expect(text('3/4/2026', 'yyyy-mm-dd')).toEqual({ text: '2026-03-04' });
    // Booleans go through the text section as TRUE/FALSE.
    const cases: Array<[boolean, string, string]> = [
      [true, ';;;@', 'TRUE'],
      [true, ';;;"hi"', 'hi'],
      [true, ';;;"h""I"', 'hI'],
      [false, ';;;\\h\\i', 'hi'],
      [true, ';;;\\@@\\@', '@TRUE@'],
      [false, ';;;-@-', '-FALSE-'],
      [true, ';;;@-', 'TRUE-'],
      [false, ';;;-@-@-', '-FALSE-FALSE-'],
      [true, '0.00', 'TRUE'],
    ];
    for (const [b, code, want] of cases) expect(text(b, code), `${code} with ${b}`).toEqual({ text: want });
  });

  it("matches Excel on Apache POI's NumberFormatApproxTests rows", () => {
    expect(POI_NUMBER_FORMAT_APPROX_CASES.length).toBeGreaterThanOrEqual(248);
    const wrong = POI_NUMBER_FORMAT_APPROX_CASES.filter(([code, v, want]) => {
      const got = text(v, code);
      return !('text' in got) || got.text !== want;
    }).map(([code, v, want]) => `TEXT(${v}, ${JSON.stringify(code)}) = ${JSON.stringify(text(v, code))}, Excel ${JSON.stringify(want)}`);
    expect(wrong).toEqual([]);
  });
});

describe('number formats: 15 significant digits', () => {
  it('rounds the decimal string half away from zero', () => {
    expect(fixed(2.675, 2)).toEqual(['2', '68']);
    expect(fixed(1.005, 2)).toEqual(['1', '01']);
    expect(fixed(0.5, 0)).toEqual(['1', '']);
    expect(fixed(0.04, 1)).toEqual(['', '0']);
    expect(fixed(0.05, 1)).toEqual(['', '1']);
    expect(fixed(9.999, 2)).toEqual(['10', '00']);
    expect(fixed(0.0004, 3)).toEqual(['', '000']);
    expect(fixed(0.0005, 3)).toEqual(['', '001']);
    expect(fixed(1e20, 0)[0]).toBe('100000000000000000000');
    expect(fixed(0, 2)).toEqual(['', '00']);
  });

  it('rounds an exact tie at the 16th digit toward zero', () => {
    const ties: Array<[number, string]> = [
      [1234567890123405, '1234567890123400'],
      [1234567890123415, '1234567890123410'],
      [1234567890123425, '1234567890123420'],
      [1234567890123435, '1234567890123430'],
      [1234567890123455, '1234567890123450'],
      [1234567890123475, '1234567890123470'],
      [1234567890123495, '1234567890123490'],
      [6631679258820775, '6631679258820770'],
      [8052991635850695, '8052991635850690'],
    ];
    for (const [v, whole] of ties) {
      expect(f('0', v)).toBe(whole);
      expect(f('0.00', v)).toBe(`${whole}.00`);
      expect(f('0', -v)).toBe(`-${whole}`);
    }
    expect(f('#,##0', 1234567890123455)).toBe('1,234,567,890,123,450');
    expect(f('#,##0', -3267527853107975)).toBe('-3,267,527,853,107,970');
    expect(f('0', 123456789012345.5)).toBe('123456789012345');
    expect(f('0.00', 123456789012345.5)).toBe('123456789012345.00');
    expect(f('0', 999999999999999.5)).toBe('999999999999999');
    expect(f('0', -999999999999999.5)).toBe('-999999999999999');
    expect(f('0', 4999999999999995)).toBe('4999999999999990');
    expect(f('#,##0', -4999999999999995)).toBe('-4,999,999,999,999,990');
  });

  it('only rounds exact ties toward zero', () => {
    expect(f('0', 1234567890123455 + 0.25)).toBe('1234567890123460');
    expect(f('0', 1234567890123455.5)).toBe('1234567890123460');
    expect(f('0', 1234567890123455 - 0.25)).toBe('1234567890123450');
    expect(f('0', 1234567890123456)).toBe('1234567890123460');
    expect(f('0', 1234567890123454)).toBe('1234567890123450');
    expect(f('0.0', 0.285)).toBe('0.3');
    expect(f('0.0', 99999999999999.95)).toBe('100000000000000.0');
    expect(f('0', 2.5)).toBe('3');
  });

  it('keeps fifteen digits', () => {
    expect(decimalDigits(1234567890123455)).toEqual({ digits: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5], exp: 15 });
    expect(decimalDigits(1234567890123456)).toEqual({ digits: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 6], exp: 15 });
    expect(decimalDigits(123456789012345.5)).toEqual({ digits: [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5], exp: 14 });
    expect(decimalDigits(999999999999999.5)).toEqual({ digits: new Array(15).fill(9), exp: 14 });
    expect(decimalDigits(4999999999999995)).toEqual({ digits: [4, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9], exp: 15 });
    expect(decimalDigits(999999999999999.6)).toEqual({ digits: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], exp: 15 });
  });
});

describe('number formats: parsing robustness', () => {
  it('splits sections and resolves minutes and commas', () => {
    expect(splitSections('0;-0;;@')).toHaveLength(4);
    expect(splitSections('"a;b"0')).toHaveLength(1);
    expect(splitSections('\\;0')).toHaveLength(1);
    expect(splitSections('0;0;0;0;0;0')).toHaveLength(4);
    expect(parseSections('h:mm')[0].toks).toContainEqual({ t: 'date', d: { k: 'minute', n: 2 } });
    expect(parseSections('m/d')[0].toks).toContainEqual({ t: 'date', d: { k: 'month', n: 1 } });
    expect(parseSections('mm:ss')[0].toks).toContainEqual({ t: 'date', d: { k: 'minute', n: 2 } });
    expect(parseSections('#,##0,')[0]).toMatchObject({ thousands: true, scale: 1 });
    expect(parseSections('0.0,,')[0]).toMatchObject({ thousands: false, scale: 2 });
  });

  it('treats an unclosed bracket as a literal and keeps closed brackets whole', () => {
    expect(f('[0;0', 5)).toBe('[5');
    expect(f('0;[0', -5)).toBe('[5');
    expect(f('0;-0;[', 0)).toBe('[');
    expect(parseSections('0;[Red-0')).toHaveLength(2);
    expect(parseSections('[0;0')).toHaveLength(2);
    expect(f('[Red]0;[Blue]-0', -5)).toBe('-5');
    expect(f('[>=100]0.0;0', 150)).toBe('150.0');
    expect(f('[$-409]0.00', 2.5)).toBe('2.50');
    expect(f('[$€-2] #,##0', 1234)).toBe('€ 1,234');
    expect(parseSections('[Red]0;[Blue]0')).toHaveLength(2);
    expect(parseSections('[unknown;x]0;0')).toHaveLength(2);
    expect(f('0\\[0', 5)).toBe('0[5');
    expect(f('"["0;0', 5)).toBe('[5');
  });

  it('caps codes at 255 characters', () => {
    const ok = `0${'0'.repeat(254)}`;
    const long = `0${'0'.repeat(255)}`;
    expect(Array.from(ok)).toHaveLength(MAX_NUMBER_FORMAT_CODE_CHARS);
    expect('text' in text(1, ok)).toBe(true);
    expect(text(1, long)).toEqual({ error: '#VALUE!' });
    // Capped codes display as General.
    expect(f(long, 0.5)).toBe('0.5');
    // Characters are counted, not UTF-16 units.
    expect('text' in text(1, '😀'.repeat(255))).toBe(true);
    expect(text(1, '😀'.repeat(256))).toEqual({ error: '#VALUE!' });
    const huge = `# ?/${'0'.repeat(65_536)}`;
    expect(text(0.5, huge)).toEqual({ error: '#VALUE!' });
    expect(f(huge, 0.5)).toBe('0.5');
  });

  it('parses hostile codes in linear time', () => {
    const n = 1_000_000;
    const run = (code: string) => NumberFormat.parseUncapped(code).format(1234.5).text;
    const start = Date.now();
    expect(run('['.repeat(n)).startsWith('[')).toBe(true);
    run(`0${','.repeat(n)}`);
    run(`0${'/'.repeat(n)}`);
    run(`0${','.repeat(n)}0`);
    run('[;'.repeat(n / 2));
    // A quadratic pass over a million characters would take minutes.
    expect(Date.now() - start).toBeLessThan(15_000);
  }, 30_000);

  it('never throws on random codes and values (fuzz)', () => {
    const pieces = [
      '0', '#', '?', '.', ',', '%', 'E+', 'E-', 'e', '/', '8', '16', '"', '\\', '_', '*', '@', ';', '[', ']',
      '[Red]', '[>=100]', '[<0]', '[Color7]', '[$€-407]', '[$-409]', '[h]', '[mm]', '[s]', 'd', 'dd', 'ddd',
      'dddd', 'm', 'mm', 'mmm', 'mmmmm', 'yy', 'yyyy', 'h', 'hh', 's', 'ss', '.000', 'AM/PM', 'A/P', 'General',
      ' ', '-', '(', ')', '$', 'é', '€', '💥', 'b', 'g', '[', '[>', '[=', '"abc', '*', '_',
      '00000000000000000000', '##########', ',,,,', '%%%%%%', 'E+0000', '?/?????????', '/0',
    ];
    const values = [
      0, -0, 1, -1, 0.5, -0.5, 1e-300, -1e-300, 1e300, -1e300, Number.MAX_VALUE, -Number.MAX_VALUE,
      Number.MIN_VALUE, 2958465.999999, 2958466, 46302.75, 123456789.12345678, -987654.321, 1 / 3, Math.PI,
      1e15, 1e16, 0.999999999, NaN, Infinity,
    ];
    let state = 0x9e3779b97f4a7c15n;
    const mask = (1n << 64n) - 1n;
    const next = () => {
      let x = state;
      x ^= (x << 13n) & mask;
      x ^= x >> 7n;
      x ^= (x << 17n) & mask;
      state = x;
      return x;
    };
    for (let iter = 0; iter < 1500; iter++) {
      const len = Number(next() % 8n);
      let code = '';
      for (let i = 0; i < len; i++) code += pieces[Number(next() % BigInt(pieces.length))];
      const fmt = NumberFormat.parse(code);
      void [fmt.kind(), fmt.isDate(), fmt.isPercent(), fmt.isText(), fmt.code];
      for (const v of values) {
        const r = fmt.format(v);
        if (r.fill) expect(r.fill.index).toBeLessThanOrEqual(r.text.length);
        text(v, code);
      }
      fmt.format('text');
      text('12', code);
    }
    const view = new DataView(new ArrayBuffer(8));
    for (let iter = 0; iter < 300; iter++) {
      const len = Number(next() % 24n);
      let code = '';
      for (let i = 0; i < len; i++) code += String.fromCodePoint(Number(next() % 0x3000n));
      const fmt = NumberFormat.parse(code);
      for (let k = 0; k < 5; k++) {
        view.setBigUint64(0, next());
        fmt.format(view.getFloat64(0));
      }
    }
    for (let w = 0; w < 20; w++) {
      for (const v of values) {
        const s = formatGeneralFit(v, w);
        if (s !== null) expect(Array.from(s).length).toBeLessThanOrEqual(w);
      }
    }
  });
});

describe('number formats: parse cache', () => {
  const codes = [
    '0', '0.00', '#,##0.00', '#,##0.00;[Red](#,##0.00)', '$#,##0.00', '0%', '0.0%', '0.00E+00', '##0.0E+0', 'General',
    'general', 'checkbox', '@', '0;@', '0;-0;;@', '00000', '# ?/?', '# ??/16', '?/?', 'm/d/yyyy', 'yyyy-mm-dd hh:mm:ss',
    'dddd, mmmm d, yyyy', 'h:mm AM/PM', '[h]:mm:ss', 'mm:ss.000', '[Red]0;[Blue]-0', '[>100]0.0;[<5]0.000;0',
    '[<=9999999]###-####;(###) ###-####', '[$-409]d mmm yy', '"abc"0', '\\x0', '*-0', '_(* #,##0_)', '0.0.0', '[',
    '"abc', '0;0;0;0;0', '#,##0.00;[Red', '[$-]0', '  0.00  ', '[Color99]0', '0.00_);(0.00)', '#,,"M"', 'yyyy', '',
  ];
  const values: unknown[] = [0, 1234.5678, -42.5, 0.5, 45000.75, 1e15, 1e-7, -0.0001, Infinity, 'abc', '12.5', true, '', '#N/A'];

  it('gives the same results cold and warm', () => {
    clearNumberFormatCache();
    for (let pass = 0; pass < 2; pass++) {
      for (const code of codes) {
        const direct = NumberFormat.parse(code);
        const cached = NumberFormat.parseCached(code);
        expect(cached.code).toBe(direct.code);
        expect([cached.kind(), cached.isDate(), cached.isText(), cached.isGeneral()]).toEqual([
          direct.kind(), direct.isDate(), direct.isText(), direct.isGeneral(),
        ]);
        for (const v of values) expect(cached.format(v), `${String(v)} ${code}`).toEqual(direct.format(v));
      }
    }
  });

  it('parses each code once and stays bounded', () => {
    clearNumberFormatCache();
    const first = NumberFormat.parseCached('0.00');
    for (let i = 0; i < 1000; i++) expect(NumberFormat.parseCached('0.00')).toBe(first);
    // More distinct codes than the capacity: all still format correctly...
    for (let i = 0; i < 74; i++) expect(text(1, `0.00"${i}"`)).toEqual({ text: `1.00${i}` });
    // ...the cache was emptied once full, so '0.00' was evicted.
    expect(NumberFormat.parseCached('0.00')).not.toBe(first);
    // A code too long for the cache is parsed every time.
    const long = `0"${'😀'.repeat(130)}"`;
    expect(NumberFormat.parseCached(long)).not.toBe(NumberFormat.parseCached(long));
    expect(NumberFormat.parseCached(long).format(1).text).toBe(`1${'😀'.repeat(130)}`);
  });
});
