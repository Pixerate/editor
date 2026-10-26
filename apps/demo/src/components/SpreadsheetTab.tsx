import React, { useMemo, useRef, useState } from "react";
import {
  NameManager,
  SpreadsheetEditor,
  useSpreadsheetEditor,
  useAgentToolProvider,
} from "@pixerate/editor-react";
import {
  defaultImportRegistry,
  importFileIntoSpreadsheet,
  registerSpreadsheetImportAdapters,
  type CellData,
  type SpreadsheetColumn,
  type SpreadsheetDocument,
  type SpreadsheetRow,
  type SpreadsheetWorkbook,
} from "@pixerate/editor";
import { createSpreadsheetToolProvider } from "@pixerate/editor/agent";
import { createSpreadsheetEditorDocument } from "@pixerate/editor/spreadsheet";
import { EditorDocumentAutosave, useDemoEditorDocument } from "./EditorDocumentAutosave";
import {
  Table2,
  Upload,
  Download,
  Undo2,
  Redo2,
  MousePointerClick,
  Tags,
  Rows3,
} from "lucide-react";
import { demoPlayback, demoToolRegistry } from "../agentTools";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { SHEET_SCRIPTS } from "../agentScripts";

// CSV and TSV adapters for `importFileIntoSpreadsheet` (registered once).
registerSpreadsheetImportAdapters(defaultImportRegistry);

const HEADER = ["Region", "Rep", "Product", "Units", "Price", "Revenue", "Status"];

const DATA: Array<[string, string, string, number, number]> = [
  ["North", "Ava", "Widget", 120, 9.5],
  ["West", "Ben", "Gadget", 45, 24],
  ["East", "Chloe", "Widget", 80, 9.5],
  ["North", "Dev", "Gizmo", 30, 42],
  ["South", "Eli", "Gadget", 64, 24],
  ["West", "Fay", "Gizmo", 18, 42],
  ["East", "Gus", "Gadget", 95, 24],
  ["South", "Hana", "Widget", 150, 9.5],
  ["North", "Ivo", "Gadget", 52, 24],
  ["West", "Jun", "Widget", 70, 9.5],
];

const LAST_DATA_ROW = DATA.length + 1; // row 1 is the header
const range = (col: string) => `${col}2:${col}${LAST_DATA_ROW}`;

// Footer rows (never sorted, filtered or grouped) exercising the formula library.
const FOOTER: Array<[string, string]> = [
  ["Total revenue", `=SUM(${range("F")})`],
  ["North revenue (SUMIF)", `=SUMIF(${range("A")},"North",${range("F")})`],
  ["East orders > 50 units (COUNTIFS)", `=COUNTIFS(${range("A")},"East",${range("D")},">50")`],
  ["Avg West units (AVERAGEIFS)", `=ROUND(AVERAGEIFS(${range("D")},${range("A")},"West"),1)`],
  ["Top rep (XLOOKUP)", `=XLOOKUP(MAX(${range("F")}),${range("F")},${range("B")})`],
  ["First three reps (TEXTJOIN)", `=TEXTJOIN(", ",TRUE,B2:B4)`],
  ["Days since 1 Jan 2026 (DATEDIF)", `=DATEDIF(DATE(2026,1,1),TODAY(),"d")`],
  ["Error with a reason (hover me)", `=SUMIF(5,"North",${range("F")})`],
];

/** The data rows (below the header) of one column, as a 0-based range. */
const dataColumn = (col: number) => ({ startRow: 1, startCol: col, endRow: DATA.length, endCol: col });

function buildSampleDocument(): SpreadsheetDocument {
  const keys = HEADER.map((_, i) => String.fromCharCode(65 + i));
  const columns: SpreadsheetColumn[] = keys.map((key, i) => ({
    id: `col_${key.toLowerCase()}`,
    key,
    title: key,
    width: i === 0 ? 220 : i === 1 ? 150 : 110,
    type: "freeform",
  }));
  const matrix: string[][] = [
    HEADER,
    ...DATA.map((row, i) => {
      const r = i + 2;
      return [
        ...row.map(String),
        `=D${r}*E${r}`,
        `=IF(F${r}>=1000,"On target","Below")`,
      ];
    }),
    ...FOOTER.map(([label, formula]) => [label, formula]),
  ];
  const rows: SpreadsheetRow[] = matrix.map((_, i) => ({
    id: `row_${i + 1}`,
    index: i,
    height: 30,
    type: "freeform",
  }));
  const cells: Record<string, Record<string, CellData>> = {};
  matrix.forEach((line, r) => {
    cells[rows[r].id] = {};
    line.forEach((raw, c) => {
      // Formulas are evaluated by the controller; typed values are text.
      cells[rows[r].id][columns[c].id] = { raw, value: raw.startsWith("=") ? null : raw };
    });
  });
  return {
    id: "demo-sales",
    name: "Sales",
    columns,
    rows,
    cells,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    table: {
      headerRowCount: 1,
      footerRowCount: FOOTER.length,
      frozenRowCount: 1,
      frozenColumnCount: 1,
      // Conditional formatting (right-click → "Conditional formatting…" to manage).
      conditionalFormats: [
        {
          id: "cf_revenue_scale",
          type: "colorScale",
          ranges: [dataColumn(5)],
          stops: [
            { value: { type: "min" }, color: "#f8696b" },
            { value: { type: "percentile", value: 50 }, color: "#ffeb84" },
            { value: { type: "max" }, color: "#63be7b" },
          ],
        },
        { id: "cf_units_bars", type: "dataBar", ranges: [dataColumn(3)], color: "#638ec6" },
        {
          id: "cf_below_target",
          type: "containsText",
          text: "Below",
          ranges: [dataColumn(6)],
          style: { fill: "#ffc7ce", color: "#9c0006", bold: true },
        },
      ],
      // A list-validated Region column with a dropdown (right-click → "Data validation…").
      dataValidations: [
        {
          id: "dv_region",
          type: "list",
          formula1: "North,South,East,West",
          ranges: [dataColumn(0)],
          inputTitle: "Region",
          inputMessage: "Pick North, South, East or West.",
          errorTitle: "Unknown region",
          errorMessage: "Choose a region from the list.",
        },
      ],
    },
  };
}

// A second sheet that reads the Sales sheet through cross-sheet references,
// named ranges and LAMBDA functions.
const SUMMARY: Array<[string, string]> = [
  ["Metric", "Value"],
  ["Total revenue (named range Revenue)", "=SUM(Revenue)"],
  ["Revenue incl. tax (named LAMBDA WithTax)", "=WithTax(B2)"],
  ["Units sold (cross-sheet Sales!D2:D11)", `=SUM(Sales!${range("D")})`],
  ["North revenue (LET + FILTER)", '=LET(north, Regions="North", SUM(FILTER(Revenue, north)))'],
  ["5! (recursive named LAMBDA Fact)", "=Fact(5)"],
  ["Largest order (REDUCE)", `=REDUCE(0, Sales!${range("D")}, LAMBDA(a, v, MAX(a, v)))`],
  ["Squares (MAP spills down)", "=MAP(SEQUENCE(3), LAMBDA(x, x*x))"],
];

function buildSummaryDocument(): SpreadsheetDocument {
  const columns: SpreadsheetColumn[] = ["A", "B", "C"].map((key, i) => ({
    id: `col_${key.toLowerCase()}`,
    key,
    title: key,
    width: i === 0 ? 300 : 140,
    type: "freeform",
  }));
  const rows: SpreadsheetRow[] = Array.from({ length: 12 }, (_, i) => ({ id: `row_${i + 1}`, index: i, height: 30, type: "freeform" }));
  const cells: Record<string, Record<string, CellData>> = {};
  SUMMARY.forEach(([label, formula], r) => {
    cells[rows[r].id] = {
      col_a: { raw: label, value: label },
      col_b: { raw: formula, value: formula.startsWith("=") ? null : formula },
    };
  });
  return {
    id: "demo-summary",
    name: "Summary",
    columns,
    rows,
    cells,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    table: { headerRowCount: 1, frozenRowCount: 1 },
  };
}

function buildSampleWorkbook(): SpreadsheetWorkbook {
  return {
    sheets: [buildSampleDocument(), buildSummaryDocument()],
    activeSheetId: "demo-sales",
    names: [
      { name: "Revenue", refersTo: `=Sales!$F$2:$F$${LAST_DATA_ROW}`, comment: "Revenue column" },
      { name: "Regions", refersTo: `=Sales!$A$2:$A$${LAST_DATA_ROW}` },
      { name: "TaxRate", refersTo: "=0.2" },
      { name: "WithTax", refersTo: "=LAMBDA(amount, amount*(1+TaxRate))", comment: "Adds TaxRate" },
      { name: "Fact", refersTo: "=LAMBDA(n, IF(n<=1, 1, n*Fact(n-1)))", comment: "Recursive factorial" },
    ],
  };
}

const LARGE_SHEET_NAME = "Large";
const LARGE_SHEET_ROWS = 10_000;

/**
 * A 10,000 × 5 sheet (50k cells): values, per-row formulas and whole-column
 * aggregates. Editing one value recalculates only the formulas that read it,
 * and the grid renders only the rows in view.
 */
function buildLargeSheet(): Partial<SpreadsheetDocument> {
  const columns: SpreadsheetColumn[] = ["Value", "Double", "Sum", "Band", "Totals"].map((title, i) => ({
    id: `large_c${i}`,
    key: String.fromCharCode(65 + i),
    title,
    width: 120,
    type: "freeform" as const,
  }));
  const rows: SpreadsheetRow[] = Array.from({ length: LARGE_SHEET_ROWS }, (_, r) => ({
    id: `large_r${r}`,
    index: r,
    height: 32,
    type: "freeform" as const,
  }));
  const totals = ["=SUM(A:A)", "=AVERAGE(B:B)", '=COUNTIF(A:A,">50")', `=SUMIF(D1:D${LARGE_SHEET_ROWS},"high",A1:A${LARGE_SHEET_ROWS})`];
  const cells: Record<string, Record<string, CellData>> = {};
  for (let r = 0; r < LARGE_SHEET_ROWS; r++) {
    const n = r + 1;
    const value = (r * 37) % 100;
    cells[`large_r${r}`] = {
      large_c0: { raw: String(value), value },
      large_c1: { raw: `=A${n}*2`, value: "" },
      large_c2: { raw: `=A${n}+B${n}`, value: "" },
      large_c3: { raw: value > 50 ? "high" : "low", value: value > 50 ? "high" : "low" },
      large_c4: r < totals.length ? { raw: totals[r], value: "" } : { raw: String(n), value: n },
    };
  }
  // The totals (E1:E4) stay in view while scrolling.
  return { name: LARGE_SHEET_NAME, columns, rows, cells, table: { frozenRowCount: 4 } };
}

export const SpreadsheetTab: React.FC = () => {
  const initialWorkbook = useMemo(buildSampleWorkbook, []);
  const state = useSpreadsheetEditor({ workbook: initialWorkbook });
  const [showNames, setShowNames] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const provider = useMemo(
    () => createSpreadsheetToolProvider(state.controller, { id: "sheet", namespace: "sheet" }),
    [state.controller]
  );
  useAgentToolProvider(demoToolRegistry, provider);
  const editorDocument = useDemoEditorDocument(state.controller, createSpreadsheetEditorDocument, { namespace: "sheet", skill: "pixerate-spreadsheet" });

  const importFile = async (file: File) => {
    try {
      const outcome = await importFileIntoSpreadsheet(state.controller, file, {
        registry: defaultImportRegistry,
        startRow: 0,
        startCol: 0,
      });
      setStatus(
        `Imported ${outcome.result.rows.length} rows from ${file.name} (adapter: ${outcome.adapterId}). Undo restores the previous sheet.`
      );
    } catch (error) {
      setStatus(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const exportCsv = () => setCsvPreview(state.exportToCsv());

  const openLargeSheet = () => {
    const existing = state.controller.getSheets().find((sheet) => sheet.name === LARGE_SHEET_NAME);
    if (existing) {
      state.setActiveSheet(existing.id);
      return;
    }
    const start = performance.now();
    state.addSheet({ name: LARGE_SHEET_NAME, document: buildLargeSheet(), activate: true });
    const { evaluated } = state.controller.getRecalculationStats();
    setStatus(
      `Built "${LARGE_SHEET_NAME}" (${LARGE_SHEET_ROWS.toLocaleString()} rows × 5 columns) and evaluated ${evaluated.toLocaleString()} formulas in ${Math.round(performance.now() - start)} ms. Edit a value in column A: only the formulas reading it recalculate (see the totals in E1:E4), and only the rows in view are rendered.`
    );
  };

  const csvHref = useMemo(
    () =>
      csvPreview === null
        ? undefined
        : `data:text/csv;charset=utf-8,${encodeURIComponent(csvPreview)}`,
    [csvPreview]
  );

  const buttonClass =
    "flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors";

  return (
    <div className="space-y-4">
      <EditorDocumentAutosave doc={editorDocument} name="Spreadsheet" />
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 flex flex-wrap items-center gap-2 shadow-md">
        <div className="flex items-center gap-2 mr-2">
          <Table2 className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold tracking-wide uppercase text-slate-300">
            Spreadsheet
          </h2>
        </div>
        <button type="button" className={buttonClass} onClick={() => state.undo()} title="Undo (Mod+Z)">
          <Undo2 className="w-3.5 h-3.5" /> Undo
        </button>
        <button type="button" className={buttonClass} onClick={() => state.redo()} title="Redo (Mod+Shift+Z)">
          <Redo2 className="w-3.5 h-3.5" /> Redo
        </button>
        <div className="w-px h-5 bg-slate-800 mx-1" />
        <button type="button" className={buttonClass} onClick={() => fileInputRef.current?.click()}>
          <Upload className="w-3.5 h-3.5" /> Import CSV / TSV
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={defaultImportRegistry.accept("spreadsheet")}
          className="hidden"
          data-testid="spreadsheet-file-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = "";
          }}
        />
        <button type="button" className={buttonClass} onClick={exportCsv}>
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
        <button type="button" className={buttonClass} onClick={openLargeSheet} title="Adds a 10,000-row sheet to try fast recalculation and virtualised rendering">
          <Rows3 className="w-3.5 h-3.5" /> Large sheet (50k cells)
        </button>
        <button
          type="button"
          className={buttonClass}
          aria-pressed={showNames}
          onClick={() => setShowNames((v) => !v)}
        >
          <Tags className="w-3.5 h-3.5" /> Name Manager
        </button>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
          <MousePointerClick className="w-3.5 h-3.5 text-amber-400" />
          Right-click a cell for sort, filter, freeze, hide, merge and categories
        </span>
      </div>

      <div className="relative">
      <div
        className={`h-[560px] rounded-xl overflow-hidden border ${
          dragOver ? "border-emerald-500 ring-2 ring-emerald-500/40" : "border-slate-800"
        }`}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          const file = e.dataTransfer.files?.[0];
          setDragOver(false);
          if (!file) return;
          e.preventDefault();
          void importFile(file);
        }}
      >
        <SpreadsheetEditor state={state} showSheetTabs playback={demoPlayback} />
      </div>
      </div>
      <AgentScriptPanel scripts={SHEET_SCRIPTS} hint="Plays a scripted agent turn with the sheet__* tools: it reads a range, writes formulas with set_range and checks what they computed. The grid acts each call out with the agent's cursor." />

      {showNames && (
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-slate-200">
          <NameManager state={state} onClose={() => setShowNames(false)} />
        </div>
      )}

      {status && (
        <div className="text-xs text-emerald-300 bg-emerald-950/30 border border-emerald-500/30 rounded-lg px-3 py-2">
          {status}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 text-xs text-slate-400 space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">Try it</h3>
          <p>Type <code className="text-slate-200">=SU</code> in a cell or the formula bar for autocomplete; inside the parentheses the argument hint follows the caret.</p>
          <p>Select cells and drag the small square at the bottom-right corner (fill handle) to extend a series or shift formulas.</p>
          <p>Copy (Mod+C) and paste (Mod+V) a range inside the sheet or to/from another spreadsheet app (TSV + HTML + lossless JSON).</p>
          <p>Drop a <code className="text-slate-200">.csv</code> / <code className="text-slate-200">.tsv</code> file on the grid to import it.</p>
          <p>Open the <strong>Summary</strong> tab: it reads Sales through <code className="text-slate-200">Sales!D2:D11</code>, named ranges and LAMBDA names. Double-click a tab to rename it (formulas follow), drag tabs to reorder, right-click for more.</p>
          <p>Try <code className="text-slate-200">=LAMBDA(x, x*2)(21)</code>, <code className="text-slate-200">=BYROW(Sales!D2:E4, LAMBDA(r, PRODUCT(r)))</code> or define your own names in the Name Manager.</p>
          <p>Revenue has a colour scale, Units data bars and Status a highlight rule: edit a number to see them update. Right-click → <em>Conditional formatting…</em> manages the rules.</p>
          <p>Region is list-validated: select a Region cell for its dropdown, or type an unknown region to see the stop alert. Right-click → <em>Data validation…</em> or <em>Circle invalid data</em>.</p>
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">CSV Export (RFC 4180)</h3>
            {csvHref && (
              <a
                href={csvHref}
                download="sales.csv"
                className="text-xs text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
              >
                Download sales.csv
              </a>
            )}
          </div>
          <pre
            data-testid="csv-preview"
            className="max-h-48 overflow-auto text-[11px] font-mono text-slate-300 bg-slate-950 border border-slate-800 rounded-lg p-2 whitespace-pre"
          >
            {csvPreview ?? "Click “Export CSV” to serialize the computed values."}
          </pre>
        </div>
      </div>
    </div>
  );
};
