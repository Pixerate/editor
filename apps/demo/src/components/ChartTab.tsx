import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  chartToMermaid,
  chartToSvg,
  downloadChartPng,
  chartFromMermaid,
  describeOfficeChartPlace,
  extractOfficeCharts,
  recommendChartTypes,
  summarizeChart,
  type ChartSpec,
  type OfficeChartFile,
  type OfficeChartsResult,
  createChartEditorDocument,
  createChartStyleToolProvider,
} from "@pixerate/editor/chart";
import { StyleFindings, useAgentToolProvider, useStyleFindings } from "@pixerate/editor-react";
import type { ChartSelection } from "@pixerate/editor/chart";
import { demoStyles } from "../houseStyles";
import { EditorDocumentAutosave, useDemoEditorDocument } from "./EditorDocumentAutosave";
import { parseCsv } from "@pixerate/editor/spreadsheet";
import {
  ChartEditor,
  ChartSparkline,
  ChartStreamingView,
  useChartCommands,
  useChartController,
  useChartDirector,
  useChartState,
  useChartToolProvider,
  useOfficeChartToolProvider,
} from "@pixerate/editor-react/chart";
import { BarChart3 } from "lucide-react";
import { demoCommandRegistry, demoPlayback, demoToolRegistry } from "../agentTools";
import { AgentScriptPanel } from "./AgentScriptPanel";
import { CHART_SCRIPTS } from "../agentScripts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const SAMPLES: Record<string, Partial<ChartSpec>> = {
  Revenue: {
    type: "bar",
    title: "Quarterly revenue",
    subtitle: "By region, USD",
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { id: "na", name: "North America", values: [42000, 48500, 51200, 60300] },
      { id: "eu", name: "Europe", values: [31000, 29800, 35600, 41200] },
      { id: "apac", name: "Asia Pacific", values: [18000, 22400, 27900, 33100] },
      { id: "margin", name: "Margin", values: [0.21, 0.24, 0.23, 0.28], type: "line", axis: "secondary", marker: "diamond" },
    ],
    yAxis: { show: true, title: "", min: null, max: null, step: null, gridlines: true, format: { style: "currency" } },
    yAxis2: { show: true, title: "Margin", min: null, max: null, step: null, gridlines: false, format: { style: "percent" } },
  },
  Targets: {
    type: "bar",
    title: "Support tickets closed per week",
    subtitle: "Week 6 cleared the backlog",
    note: "Source: helpdesk export, Q1 2025",
    categories: ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"],
    series: [{ id: "closed", name: "Closed", values: [118, 124, 131, 109, 140, 182, 150, 146], callouts: [null, null, null, "Outage", null, "Backlog cleared", null, null] }],
    referenceLines: [{ value: 135, label: "Target" }],
    referenceBands: [{ from: 110, to: 130, label: "Usual range" }],
    highlight: ["W4", "W6"],
  },
  Slope: {
    type: "slope",
    title: "Revenue by product line",
    subtitle: "Cloud overtook Add-ons",
    dataLabels: true,
    categories: ["Core", "Add-ons", "Services", "Cloud", "Support"],
    series: [
      { id: "y24", name: "2024", values: [40, 30, 22, 12, 21] },
      { id: "y25", name: "2025", values: [52, 24, 23, 35, 20] },
    ],
    highlight: ["Cloud", "Add-ons"],
  },
  Survey: {
    type: "likert",
    title: "Customer survey",
    dataLabels: true,
    likertSort: "positive",
    categories: ["Easy to use", "Good value", "Would recommend", "Fast support"],
    series: [
      { id: "sd", name: "Strongly disagree", values: [5, 10, 8, 14] },
      { id: "d", name: "Disagree", values: [10, 15, 12, 20] },
      { id: "n", name: "Neutral", values: [25, 30, 20, 26] },
      { id: "a", name: "Agree", values: [40, 30, 35, 28] },
      { id: "sa", name: "Strongly agree", values: [20, 15, 25, 12] },
    ],
  },
  Customers: {
    type: "sunburst",
    title: "Customers by region",
    sunburstLabel: "customers",
    tree: [
      { name: "Europe", children: [{ name: "France", value: 40 }, { name: "Spain", value: 25 }, { name: "Germany", children: [{ name: "Berlin", value: 18 }, { name: "Munich", value: 12 }] }] },
      { name: "Americas", children: [{ name: "Canada", value: 30 }, { name: "USA", value: 55 }, { name: "Brazil", value: 14 }] },
      { name: "Asia", children: [{ name: "Japan", value: 26 }, { name: "India", value: 20 }] },
    ],
  },
  Budget: {
    type: "treemap",
    title: "Budget by department",
    tree: [
      { name: "Engineering", children: [{ name: "Web", value: 420 }, { name: "Apps", value: 310 }, { name: "Platform", value: 280 }] },
      { name: "Sales", children: [{ name: "Field", value: 260 }, { name: "Inside", value: 140 }] },
      { name: "Marketing", children: [{ name: "Brand", value: 120 }, { name: "Events", value: 90 }, { name: "Search", value: 110 }] },
      { name: "Support", value: 150 },
    ],
  },
  Race: {
    type: "barrace",
    title: "Most visited cities",
    subtitle: "International arrivals, millions",
    raceTopN: 6,
    categories: ["2016", "2017", "2018", "2019", "2020", "2021", "2022", "2023"],
    series: [
      { id: "bkk", name: "Bangkok", values: [21.5, 22.4, 24.2, 22.8, 4.4, 0.4, 11.2, 22.2] },
      { id: "par", name: "Paris", values: [18.0, 17.4, 19.1, 19.1, 7.3, 8.6, 17.2, 17.4] },
      { id: "lon", name: "London", values: [19.9, 19.8, 19.2, 19.6, 4.6, 3.8, 16.9, 18.8] },
      { id: "dxb", name: "Dubai", values: [14.9, 15.8, 15.9, 16.7, 5.5, 7.3, 14.4, 17.2] },
      { id: "sin", name: "Singapore", values: [13.1, 13.9, 14.7, 14.7, 2.7, 0.3, 6.3, 13.6] },
      { id: "ist", name: "Istanbul", values: [9.2, 10.7, 13.4, 14.7, 5.9, 8.1, 16.4, 20.2] },
      { id: "nyc", name: "New York", values: [12.7, 13.1, 13.6, 13.6, 2.4, 2.8, 10.0, 12.6] },
    ],
  },
  Pipeline: {
    type: "sankey",
    title: "Sales pipeline",
    subtitle: "Leads by source, Q3",
    dataLabels: true,
    links: [
      { source: "Website", target: "Discovery", value: 120 },
      { source: "Events", target: "Discovery", value: 60 },
      { source: "Referral", target: "Discovery", value: 40 },
      { source: "Discovery", target: "Proposal", value: 130 },
      { source: "Discovery", target: "Lost", value: 90 },
      { source: "Proposal", target: "Won", value: 70 },
      { source: "Proposal", target: "Lost", value: 60 },
    ],
    sankeyNodes: ["Website", "Events", "Referral", "Discovery", "Proposal", "Won", "Lost"],
  },
  Parliament: {
    type: "parliament",
    title: "Council seats",
    categories: ["Alliance", "Union", "Greens", "Independents"],
    series: [{ id: "seats", name: "Seats", values: [148, 117, 40, 45] }],
  },
  "Web traffic": {
    type: "area",
    title: "Weekly visitors",
    categories: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    series: [
      { id: "organic", name: "Organic", values: [1200, 1350, 1280, 1500, 1620, 900, 780] },
      { id: "paid", name: "Paid", values: [400, 420, 610, 580, 700, 300, 250] },
      { id: "social", name: "Social", values: [220, 260, 240, 310, null, 450, 520] },
    ],
    stacking: "stacked",
    curve: "smooth",
    yAxis: { show: true, title: "", min: null, max: null, step: null, gridlines: true, format: { style: "compact" } },
  },
  Trend: {
    type: "line",
    title: "Monthly signups",
    xAxis: { show: true, title: "", min: null, max: null, step: null, gridlines: false, format: {}, kind: "date" },
    categories: MONTHS.map((_, i) => `2025-${String(i + 1).padStart(2, "0")}`),
    series: [{ id: "signups", name: "Signups", values: [120, 135, 128, 160, 172, 169, 190, 205, 198, 230, 244, 260], trendlines: [{ type: "linear", forward: 2, showEquation: true, showR2: true }] }],
  },
  Scatter: {
    type: "scatter",
    title: "Height vs weight",
    categories: ["a", "b", "c", "d", "e", "f", "g", "h"],
    series: [{ id: "people", name: "People", values: [158, 162, 171, 168, 180, 186, 175, 191], x: [52, 57, 66, 64, 78, 88, 72, 95], trendlines: [{ type: "linear", showR2: true }] }],
    xAxis: { show: true, title: "Weight (kg)", min: null, max: null, step: null, gridlines: true, format: {} },
    yAxis: { show: true, title: "Height (cm)", min: null, max: null, step: null, gridlines: true, format: {} },
  },
  "Error bars": {
    type: "bar",
    title: "Trial results",
    subtitle: "Mean score with 95% intervals",
    categories: ["Control", "Low dose", "High dose"],
    series: [
      { id: "week4", name: "Week 4", values: [4.2, 6.8, 9.1], errorBars: { type: "custom", plus: [0.6, 1.1, 0.9], minus: [0.5, 0.8, 1.4] } },
      { id: "week8", name: "Week 8", values: [4.5, 7.9, 11.2], errorBars: { type: "percent", value: 10 } },
      { id: "target", name: "Target", type: "line", values: [5, 8, 10], marker: "diamond" },
    ],
  },
  "Log scale": {
    type: "line",
    title: "Active users",
    subtitle: "Logarithmic value axis",
    categories: ["2018", "2019", "2020", "2021", "2022", "2023", "2024"],
    series: [
      { id: "app", name: "App", values: [40, 310, 2800, 21000, 160000, 900000, 2400000] },
      { id: "web", name: "Web", values: [1200, 2600, 5100, 9800, 21000, 40000, 76000] },
    ],
    yAxis: { show: true, title: "Users", min: null, max: null, step: null, gridlines: true, format: { style: "compact" }, scale: "log" },
  },
  Bubble: {
    type: "bubble",
    title: "Markets",
    categories: ["UK", "DE", "FR", "US", "JP"],
    series: [{ id: "m", name: "Markets", values: [12, 18, 9, 30, 14], x: [2.1, 3.4, 1.8, 6.2, 2.9], sizes: [67, 83, 68, 331, 125] }],
    xAxis: { show: true, title: "Growth %", min: null, max: null, step: null, gridlines: true, format: {} },
  },
  Waterfall: {
    type: "waterfall",
    title: "Cash flow",
    categories: ["Opening", "Sales", "Refunds", "Salaries", "Subtotal", "Tax"],
    series: [{ id: "cash", name: "Cash", values: [120, 85, -12, -60, null, -18] }],
    dataLabels: true,
  },
  Histogram: {
    type: "histogram",
    title: "Response times (ms)",
    categories: Array.from({ length: 120 }, (_, i) => String(i + 1)),
    series: [{ id: "t", name: "Times", values: Array.from({ length: 120 }, (_, i) => Math.round(220 + 60 * Math.sin(i * 1.7) + 40 * Math.cos(i * 0.31) + (i % 17))) }],
  },
  "Box plot": {
    type: "box",
    title: "Scores by class",
    categories: Array.from({ length: 24 }, (_, i) => String(i + 1)),
    series: ["A", "B", "C"].map((name, k) => ({ id: name, name: `Class ${name}`, values: Array.from({ length: 24 }, (_, i) => 55 + k * 6 + ((i * (7 + k)) % 23) + (i === 5 && k === 1 ? 30 : 0)) })),
  },
  Radar: {
    type: "radar",
    title: "Product comparison",
    categories: ["Speed", "Power", "Range", "Comfort", "Price"],
    series: [
      { id: "a", name: "Model A", values: [4, 3, 5, 2, 4] },
      { id: "b", name: "Model B", values: [3, 5, 2, 4, 3] },
    ],
  },
  Funnel: {
    type: "funnel",
    title: "Signup funnel",
    categories: ["Visits", "Sign-ups", "Trials", "Paid"],
    series: [{ id: "u", name: "Users", values: [12000, 4200, 1800, 640] }],
    yAxis: { show: true, title: "", min: null, max: null, step: null, gridlines: true, format: { code: "#,##0" } },
  },
  Treemap: {
    type: "treemap",
    title: "Sales by region",
    categories: ["North", "South", "East", "West", "Central", "Online", "Other"],
    series: [{ id: "s", name: "Sales", values: [40, 25, 18, 12, 9, 30, 3] }],
    yAxis: { show: true, title: "", min: null, max: null, step: null, gridlines: true, format: { code: '$#,##0"k"' } },
  },
  "Market share": {
    type: "donut",
    title: "Browser share",
    categories: ["Chrome", "Safari", "Edge", "Firefox", "Other"],
    series: [{ id: "share", name: "Share", values: [64, 19, 5, 3, 9] }],
    dataLabels: true,
    legend: { show: true, position: "right" },
  },
};

const SAMPLE_CSV = "Month,Coffee,Tea\nJan,120,80\nFeb,135,76\nMar,150,90\nApr,142,101\nMay,160,95";

const STREAM_SOURCE = `xychart-beta
    title "Revenue (streamed)"
    x-axis [Jan, Feb, Mar, Apr, May, Jun, Jul, Aug]
    y-axis "USD (k)"
    bar "Revenue" [32, 41, 38, 52, 61, 58, 70, 76]
    line "Forecast" [30, 38, 42, 50, 56, 62, 68, 74]
`;

export function ChartTab() {
  const controller = useChartController({ spec: SAMPLES.Revenue });
  const state = useChartState(controller);
  const { presence, director, sceneRef } = useChartDirector(controller);
  useChartCommands(demoCommandRegistry, controller);
  useChartToolProvider(demoToolRegistry, controller, { id: "chart", namespace: "chart", director, actor: { id: "agent", name: "Agent" } });
  // House style: `check_chart_style` joins the chart toolset (the `style` toolset is registered once in houseStyles.ts).
  useAgentToolProvider(demoToolRegistry, useMemo(() => createChartStyleToolProvider(controller, demoStyles), [controller]));
  const houseStyle = useStyleFindings(demoStyles, "chart", state.spec);
  // Office files the user opened: listed in the "Open an Office file" panel and readable by the agent.
  const [officeFiles, setOfficeFiles] = useState<OfficeChartFile[]>([]);
  const officeFilesRef = useRef(officeFiles);
  officeFilesRef.current = officeFiles;
  useOfficeChartToolProvider(demoToolRegistry, { id: "chart-files", namespace: "chart_files", controller, files: () => officeFilesRef.current });
  const editorDocument = useDemoEditorDocument(controller, createChartEditorDocument, { namespace: "chart", skill: "pixerate-chart", history: false });
  const [officeCharts, setOfficeCharts] = useState<{ file: string; result?: OfficeChartsResult; error?: string } | null>(null);
  const openOfficeFile = async (file: File | undefined) => {
    if (!file) return;
    const data = new Uint8Array(await file.arrayBuffer());
    setOfficeFiles((files) => [...files.filter((f) => f.name !== file.name), { name: file.name, data }]);
    try {
      setOfficeCharts({ file: file.name, result: await extractOfficeCharts(data) });
    } catch (error) {
      setOfficeCharts({ file: file.name, error: (error as Error).message });
    }
  };
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [copied, setCopied] = useState(false);
  const [mermaid, setMermaid] = useState("");
  const [mermaidIssues, setMermaidIssues] = useState<string[]>([]);
  const [streamed, setStreamed] = useState({ text: "", complete: false });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const summary = useMemo(() => summarizeChart(state.spec as ChartSpec, { width: 640, height: 400 }), [state.spec]);
  const recommendations = useMemo(() => recommendChartTypes(parseCsv(csv)), [csv]);

  const copySvg = async () => {
    const svg = chartToSvg(state.spec, { width: 800, height: 450 });
    try {
      await navigator.clipboard.writeText(svg);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.open(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), "_blank");
    }
  };

  const [pngError, setPngError] = useState("");
  const downloadPng = () => {
    setPngError("");
    downloadChartPng(state.spec, { width: 800, height: 450 }).catch((error: unknown) => setPngError(error instanceof Error ? error.message : String(error)));
  };

  const stream = () => {
    if (timer.current) clearInterval(timer.current);
    let i = 0;
    setStreamed({ text: "", complete: false });
    timer.current = setInterval(() => {
      i += 3;
      const done = i >= STREAM_SOURCE.length;
      setStreamed({ text: STREAM_SOURCE.slice(0, i), complete: done });
      if (done && timer.current) clearInterval(timer.current);
    }, 30);
  };

  const button = "px-2.5 py-1 rounded-md text-xs border border-slate-700 bg-slate-800/60 text-slate-200 hover:bg-slate-700";
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-rose-400" />
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Chart editor</h2>
            <p className="text-xs text-slate-400">
              Click any part of the chart to select it, drag bars and points to change values (Alt: fine, Shift: one axis, Esc: cancel), use ← → ↑ ↓ and Delete with the
              chart focused, or edit the grid below (paste TSV from a spreadsheet). Agents get <code>chart__*</code> tools in the panel and <code>chart.*</code> commands
              in the palette; their edits are acted out with a cursor.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={button} onClick={copySvg}>
            {copied ? "Copied!" : "Copy SVG"}
          </button>
          <button type="button" className={button} onClick={downloadPng} title={pngError || "Download the chart as an 800 × 450 PNG (drawn at 2×, longest side 1024 px)"}>
            {pngError ? "PNG failed" : "Download PNG"}
          </button>
        </div>
      </div>
      <EditorDocumentAutosave doc={editorDocument} name="Chart" />
      <div className="flex flex-wrap gap-1.5">
        {Object.keys(SAMPLES).map((name) => (
          <button key={name} type="button" className={button} onClick={() => controller.load(SAMPLES[name], { clearHistory: true })}>
            {name}
          </button>
        ))}
      </div>

      <div className="relative rounded-xl border border-slate-800 bg-slate-900 p-3">
        {/* The director's presence is the editor's playback cursor too: value drags and inspector edits share it. */}
        <ChartEditor controller={controller} height={400} canvasProps={{ presence, sceneRef }} playback={demoPlayback} />
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-slate-200" data-testid="chart-house-style">
          <StyleFindings report={houseStyle.report} title="House style (org: Acme, locked · user: big labels)" onSelect={(f) => controller.select(f.target as ChartSelection)} />
          {houseStyle.error && <p className="text-xs text-rose-400">{houseStyle.error}</p>}
        </div>
      </div>
      <AgentScriptPanel scripts={CHART_SCRIPTS} hint="Plays a scripted agent turn with the chart__* tools. Value changes go through the chart's director, so its cursor drags each bar into place; every other call is acted out on the inspector, data grid and toolbar." />

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300 space-y-1" data-chart-summary="">
        <p>{summary.description}</p>
        {summary.warnings.map((w) => (
          <p key={w.message} className="text-amber-400">
            {w.message}
          </p>
        ))}
        {!summary.colors.ok && <p className="text-amber-400">{summary.colors.issues[0]}</p>}
        <div className="flex flex-wrap gap-3 pt-1">
          {state.spec.series
            .filter((s) => !s.hidden)
            .map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1.5">
                {s.name} <ChartSparkline values={s.values} highLow kind={state.spec.type === "bar" ? "column" : "line"} />
              </span>
            ))}
        </div>
      </div>

      <details className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300" data-office-charts="">
        <summary className="cursor-pointer text-slate-200">Open an Office file</summary>
        <p className="mt-2 text-slate-400">
          Read the charts in an Excel workbook, PowerPoint deck or Word document and load one into the editor. Agents can do the same with the{" "}
          <code>chart_files__*</code> tools (<code>list_open_files</code>, <code>list_file_charts</code>, <code>load_file_chart</code>).
        </p>
        <input
          type="file"
          accept=".xlsx,.xlsm,.pptx,.pptm,.docx,.docm"
          className="mt-2 block text-xs text-slate-300"
          onChange={(e) => {
            void openOfficeFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {officeCharts?.error && <p className="mt-2 text-amber-400">{officeCharts.error}</p>}
        {officeCharts?.result && (
          <div className="mt-2 space-y-1.5">
            <p className="text-slate-400">
              {officeCharts.file}: {officeCharts.result.charts.length} chart{officeCharts.result.charts.length === 1 ? "" : "s"}
            </p>
            {officeCharts.result.charts.map((chart) => (
              <div key={chart.id} className="flex flex-wrap items-center gap-2">
                <button type="button" className={button} onClick={() => controller.load(chart.spec)}>
                  Load
                </button>
                <span>
                  {chart.title || chart.name || "Untitled"} <span className="text-slate-500">({chart.spec.type}, {describeOfficeChartPlace(chart)})</span>
                </span>
                {[...chart.unsupported.map((u) => `Not kept: ${u}`), ...chart.issues].slice(0, 3).map((m) => (
                  <span key={m} className="text-amber-400">
                    {m}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </details>

      <details className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
        <summary className="cursor-pointer text-slate-200">Import CSV</summary>
        <textarea value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-200" />
        <p className="mt-1 text-slate-400">Suggested: {recommendations.map((r) => r.label).join(", ") || "—"}</p>
        <div className="mt-2 flex gap-1.5">
          <button type="button" className={button} onClick={() => controller.importCsv(csv)}>
            Replace data
          </button>
          <button
            type="button"
            className={button}
            onClick={() => {
              const rec = recommendations[0];
              controller.importCsv(csv);
              if (rec) controller.update({ type: rec.type, stacking: rec.stacking ?? "none" });
            }}
          >
            Replace data and pick a type
          </button>
        </div>
      </details>

      <details className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
        <summary className="cursor-pointer text-slate-200">Mermaid</summary>
        <textarea value={mermaid} onChange={(e) => setMermaid(e.target.value)} rows={8} placeholder="xychart-beta, pie or radar-beta" className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-200" />
        {mermaidIssues.map((m) => (
          <p key={m} className="text-amber-400">
            {m}
          </p>
        ))}
        <div className="mt-2 flex gap-1.5">
          <button type="button" className={button} onClick={() => setMermaid(chartToMermaid(controller.toJSON()))}>
            Export
          </button>
          <button
            type="button"
            className={button}
            onClick={() => {
              const read = chartFromMermaid(mermaid);
              setMermaidIssues(read.issues.map((i) => i.message));
              if (read.family) controller.load(read.spec);
            }}
          >
            Import
          </button>
        </div>
      </details>

      <details className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
        <summary className="cursor-pointer text-slate-200">Streaming from a model</summary>
        <button type="button" className={`${button} mt-2`} onClick={stream}>
          Stream a chart
        </button>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <pre className="whitespace-pre-wrap rounded-md border border-slate-700 bg-slate-950 p-2 font-mono text-[11px] text-slate-300 min-h-[140px]">{streamed.text}</pre>
          {streamed.text && <ChartStreamingView source={streamed.text} complete={streamed.complete} width={420} height={260} />}
        </div>
      </details>
    </section>
  );
}
