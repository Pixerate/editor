import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chartDateToSerial,
  chartSerialToDate,
  compileChartFormatCode,
  formatChartValueWithCode,
} from "../src/chart/numfmt.js";
import {
  daysFromCivil,
  daysInMonth,
  daysInMonth1900,
  parseCellInput,
  parseNumberText,
  serialFromYmd,
  timeFraction,
} from "../src/spreadsheet/formula/parse-input.js";
import {
  builtinNumberFormat,
  builtinNumberFormatId,
  dateValueToSerial,
  formatGeneralFit,
  formatNumberFormatValue,
  formatTextFunction,
  NumberFormat,
  numberFormatColorToCss,
} from "../src/spreadsheet/numfmt/index.js";
import {
  cellFormatForNumberFormat,
  isGeneralNumberFormat,
  NUMBER_FORMAT_PRESETS,
  numberFormatForCellFormat,
} from "../src/spreadsheet/numfmt/presets.js";
import { dateFromSerial } from "../src/spreadsheet/numfmt/render.js";
import { conformanceValuesMatch } from "../src/tools/conformance.js";

const FILE = join(
  __dirname,
  "../../swift/Tests/PixerateChartTests/Fixtures/chart-numfmt-vectors.json",
);

type Entry = Record<string, unknown>;
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v ?? null));
const vec = (
  fn: string,
  trig: boolean,
  inputs: Entry,
  compute: () => unknown,
): Entry => ({ fn, trig, ...inputs, out: json(compute()) });

const CODES = [
  "General",
  "0",
  "0.00",
  "#,##0",
  "#,##0.00",
  "#,##0;(#,##0)",
  '#,##0;(#,##0);"-"',
  "0%",
  "0.0%",
  "0.00%",
  "#,##0.0%",
  "0.00E+00",
  "0.0E-0",
  "##0.0E+0",
  "# ?/?",
  "# ??/??",
  "# ???/???",
  "?/?",
  "0 ?/?",
  "# ?/8",
  "# ??/16",
  "$#,##0",
  "$#,##0.00",
  '$#,##0.00;($#,##0.00);"-";"text: "@',
  "[$€-407]#,##0.00",
  "[$£-809]#,##0.00;[Red]-[$£-809]#,##0.00",
  '#,##0.00 "USD"',
  "#,##0,",
  "#,##0.0,",
  '#,##0.0,,"M"',
  '#,##0.0,,,"B"',
  "[Red][<0]-0.0;[Green][>100]0.0;0.0",
  '[Blue][>=1000]#,##0.0,"K";[Red][<0](#,##0.0);0.0',
  '[=0]"Zero";[<0]"Neg "0.0;"Pos "0.0',
  "00000",
  "??0.0??",
  "* #,##0.00",
  '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
  "\\$#,##0.00",
  "yyyy-mm-dd",
  "yyyy/mm/dd hh:mm:ss",
  "m/d/yy",
  "d-mmm-yy",
  "d-mmm",
  "mmm-yy",
  "mmmm d, yyyy",
  "ddd, mmm d, yyyy",
  "dddd",
  "mmmmm",
  "h:mm AM/PM",
  "h:mm:ss AM/PM",
  "h:mm",
  "h:mm:ss",
  "mm:ss",
  "mm:ss.0",
  "mm:ss.00",
  "h:mm:ss.000",
  "[h]:mm:ss",
  "[mm]:ss",
  "[ss].00",
  "@",
  '"Item: "@',
];

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  0.25,
  0.125,
  0.3333333333333333,
  0.6666666666666666,
  0.14285714285714285,
  3.141592653589793,
  -3.141592653589793,
  12.345,
  -12.345,
  99.995,
  100,
  1234.5678,
  -1234.5678,
  1234567.89,
  -1234567.89,
  1e9,
  1.5e12,
  1e-5,
  -2.5e-7,
  1e16,
  60,
  61,
  45323,
  45323.5,
  45323.758680555555,
  1.75,
  2.5,
];

function vectors() {
  const entries: Entry[] = [];
  const builtinIds = [0, 1, 2, 3, 4, 9, 10, 11, 12, 14, 18, 22, 37, 44, 49, 999];
  const builtinCodes = ["General", "0", "0.00", "0%", "yyyy-mm-dd", "@", "not-builtin"];

  entries.push(
    vec("builtinNumberFormat", false, { ids: builtinIds, codes: builtinCodes }, () => ({
      byId: builtinIds.map((id) => builtinNumberFormat(id) ?? null),
      byCode: builtinCodes.map((c) => builtinNumberFormatId(c) ?? null),
    })),
  );

  const cellFormats = [
    "general",
    "number",
    "integer",
    "currency",
    "accounting",
    "percent",
    "scientific",
    "fraction",
    "date",
    "time",
    "datetime",
    "text",
  ] as const;
  const presetCodes = [
    "",
    "General",
    "0.00",
    "#,##0.00",
    "$#,##0.00",
    "0%",
    "0.00E+00",
    "# ?/?",
    "yyyy-mm-dd",
    "hh:mm:ss",
    "yyyy-mm-dd hh:mm",
    "@",
  ];

  entries.push(
    vec(
      "numberFormatPresets",
      false,
      { cellFormats: [...cellFormats], presetCodes },
      () => ({
        presets: NUMBER_FORMAT_PRESETS,
        forCellFormat: cellFormats.map((f) => numberFormatForCellFormat(f)),
        cellFormatForCode: presetCodes.map((c) => cellFormatForNumberFormat(c)),
        isGeneral: presetCodes.map((c) => isGeneralNumberFormat(c)),
      }),
    ),
  );

  const validationCodes = [
    ...CODES,
    "",
    "   ",
    '"unterminated',
    "0\\",
    "[unclosed",
    "[Red][Blue]0",
    "[>10][<5]0",
    "0.0E",
    "0.0E+0;(#,##0)",
  ];

  entries.push(
    vec("parseNumberFormatProps", false, { codes: validationCodes }, () =>
      validationCodes.map((c) => {
        const nf = NumberFormat.parse(c);
        return {
          code: nf.code,
          kind: nf.kind(),
          isGeneral: nf.isGeneral(),
          isDate: nf.isDate(),
          isPercent: nf.isPercent(),
          isText: nf.isText(),
        };
      }),
    ),
  );

  entries.push(
    vec("compileChartFormatCode", false, { codes: validationCodes }, () =>
      validationCodes.map((c) => compileChartFormatCode(c) !== null),
    ),
  );

  const rawValues: (string | number | boolean | null)[] = [
    null,
    "",
    true,
    false,
    "North",
    "#DIV/0!",
    "2024-03-15",
    "2024-03-15 14:30:00",
    ...NUMBERS,
  ];

  entries.push(
    vec(
      "formatNumberFormatValue",
      false,
      {
        codes: CODES,
        values: rawValues,
      },
      () =>
        CODES.map((code) =>
          rawValues.map((val) => {
            const r = formatNumberFormatValue(val, code);
            return {
              text: r.text,
              color: r.color ?? null,
              cssColor: r.color ? numberFormatColorToCss(r.color) : null,
              numeric: r.numeric,
              fill: r.fill ?? null,
            };
          }),
        ),
    ),
  );

  const textFnCodes = ["0.00", "$#,##0.00", "0.0%", "yyyy-mm-dd", "@", '"Val: "@'];
  const textFnValues: (string | number | boolean | null)[] = [
    null,
    "",
    true,
    "Hello",
    "#DIV/0!",
    "2024-03-15",
    "1,234.5",
    1234.567,
    45366,
  ];

  entries.push(
    vec(
      "formatTextFunction",
      false,
      { codes: textFnCodes, values: textFnValues },
      () =>
        textFnCodes.map((code) =>
          textFnValues.map((v) => formatTextFunction(v, code)),
        ),
    ),
  );

  const fitWidths = [0, 3, 5, 8, 10, 12, 15];
  entries.push(
    vec("formatGeneralFit", false, { values: NUMBERS, widths: fitWidths }, () =>
      fitWidths.map((w) => NUMBERS.map((n) => formatGeneralFit(n, w))),
    ),
  );

  entries.push(
    vec("formatChartValueWithCode", false, { codes: CODES, values: NUMBERS }, () =>
      CODES.map((code) => NUMBERS.map((n) => formatChartValueWithCode(n, code))),
    ),
  );

  const cellInputs = [
    "",
    "   ",
    "'00123",
    "TRUE",
    "false",
    "#N/A",
    "#VALUE!",
    "#REF!",
    "#DIV/0!",
    "#NUM!",
    "#NAME?",
    "#NULL!",
    "42",
    "-3.14",
    "1,234.56",
    "$1,234.50",
    "(1,234.50)",
    "($45.20)",
    "-€99.5",
    "12.5%",
    "-0.5%",
    "2024-03-15",
    "2024/03/15",
    "2024-02-29",
    "2023-02-29",
    "2024-03-15 14:30:00",
    "03/15/2024",
    "14:30",
    "14:30:45",
    "2:30 pm",
    "12:00 am",
    "12:00 pm",
    "hello world",
  ];

  entries.push(
    vec("parseCellInput", false, { inputs: cellInputs }, () =>
      cellInputs.map((raw) => ({
        parsed: parseCellInput(raw),
        numText: parseNumberText(raw) ?? null,
      })),
    ),
  );

  const dates: [number, number, number][] = [
    [1900, 1, 1],
    [1900, 2, 28],
    [1900, 2, 29],
    [1900, 3, 1],
    [1970, 1, 1],
    [2000, 2, 29],
    [2024, 3, 15],
    [2026, 12, 31],
  ];
  const serials = [0, 1, 59, 60, 61, 25569, 36585, 45366, 45366.5, 46387];
  const times: [number, number, number][] = [
    [0, 0, 0],
    [6, 0, 0],
    [12, 0, 0],
    [14, 30, 45],
    [23, 59, 59],
  ];

  entries.push(
    vec("dateTimeSerials", false, { dates, serials, times }, () => ({
      daysFromCivil: dates.map(([y, m, d]) => daysFromCivil(y, m, d)),
      daysInMonth: dates.map(([y, m]) => daysInMonth(y, m)),
      daysInMonth1900: dates.map(([y, m]) => daysInMonth1900(y, m)),
      serialFromYmd: dates.map(([y, m, d]) => serialFromYmd(y, m, d)),
      dateFromSerial: serials.map((s) => dateFromSerial(Math.floor(s))),
      timeFraction: times.map(([h, m, s]) => timeFraction(h, m, s)),
      dateValueToSerial: [
        "2024-03-15",
        "2024-03-15 12:00:00",
        "14:30",
        "not-a-date",
      ].map((s) => dateValueToSerial(s)),
      chartSerialRoundTrip: [1, 61, 25569, 45366].map((s) => {
        const dt = chartSerialToDate(s);
        return {
          iso: dt.toISOString(),
          back: chartDateToSerial(dt),
        };
      }),
    })),
  );

  return { version: 1, entries };
}

describe("Swift chart number-format test vectors", () => {
  it("match the committed fixture (the Swift tests read it)", () => {
    const now = json(vectors());
    if (process.env.UPDATE_SWIFT_VECTORS) {
      mkdirSync(dirname(FILE), { recursive: true });
      writeFileSync(FILE, JSON.stringify(now) + "\n");
    }
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    if (!conformanceValuesMatch(now, committed)) expect(now).toEqual(committed);
  });
});
