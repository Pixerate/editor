import React, { useState } from "react";
import { chartToSvg, type ChartSpec } from "@pixerate/editor/chart";
import { ChartEditor, useChartCommands, useChartController, useChartState } from "@pixerate/editor-react/chart";
import { BarChart3 } from "lucide-react";
import { demoCommandRegistry } from "../agentTools";

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
      { id: "target", name: "Target", values: [90000, 95000, 105000, 120000], type: "line" },
    ],
    yAxis: { show: true, title: "", min: null, max: null, gridlines: true, format: { style: "currency" } },
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
    yAxis: { show: true, title: "", min: null, max: null, gridlines: true, format: { style: "compact" } },
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

export function ChartTab() {
  const controller = useChartController({ spec: SAMPLES.Revenue });
  const state = useChartState(controller);
  useChartCommands(demoCommandRegistry, controller);
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [copied, setCopied] = useState(false);

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

  const button = "px-2.5 py-1 rounded-md text-xs border border-slate-700 bg-slate-800/60 text-slate-200 hover:bg-slate-700";
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-rose-400" />
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Chart editor</h2>
            <p className="text-xs text-slate-400">
              Click any part of the chart to select it, drag bars and points to change values, use ← → ↑ ↓ and Delete with the chart focused, or edit the grid below
              (paste TSV from a spreadsheet). Agents get <code>chart.*</code> commands in the palette.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {Object.keys(SAMPLES).map((name) => (
            <button key={name} type="button" className={button} onClick={() => controller.load(SAMPLES[name], { clearHistory: true })}>
              {name}
            </button>
          ))}
          <button type="button" className={button} onClick={copySvg}>
            {copied ? "Copied!" : "Copy SVG"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
        <ChartEditor controller={controller} height={400} />
      </div>

      <details className="rounded-xl border border-slate-800 bg-slate-900 p-3 text-xs text-slate-300">
        <summary className="cursor-pointer text-slate-200">Import CSV</summary>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={6}
          className="mt-2 w-full rounded-md border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-200"
        />
        <button type="button" className={`${button} mt-2`} onClick={() => controller.importCsv(csv)}>
          Replace data
        </button>
      </details>
    </section>
  );
}
