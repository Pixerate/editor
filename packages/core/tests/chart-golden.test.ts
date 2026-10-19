// Golden renders, after filmcraft-main/crates/golden: canonical charts are laid out and written as SVG, then compared
// with committed files. Layout is pure, so these are stable across machines. Regenerate with `vitest -u`.
import { describe, expect, it } from "vitest";
import { chartToSvg, createChartSpec, sparklineToSvg, type ChartSpec } from "../src/chart";

const GOLDENS: Record<string, Partial<ChartSpec>> = {
  "bar-combo-secondary": {
    title: "Revenue and margin",
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { id: "na", name: "North America", values: [42, 48.5, 51.2, 60.3] },
      { id: "eu", name: "Europe", values: [31, 29.8, 35.6, 41.2] },
      { id: "m", name: "Margin", values: [0.21, 0.24, 0.23, 0.28], type: "line", axis: "secondary", marker: "diamond" },
    ],
    yAxis2: { format: { style: "percent" } },
    dataLabels: true,
  },
  "stacked-horizontal": { orientation: "horizontal", stacking: "stacked", dataLabels: true, categories: ["Alpha", "Beta", "Gamma"], series: [{ name: "Done", values: [5, 3, 8] }, { name: "Open", values: [2, 6, 1] }] },
  "line-dates-trend": {
    type: "line",
    xAxis: { kind: "date" },
    categories: Array.from({ length: 24 }, (_, i) => `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`),
    series: [{ name: "Signups", values: Array.from({ length: 24 }, (_, i) => 100 + i * 7 + ((i * 13) % 11)), trendlines: [{ type: "linear", showEquation: true, showR2: true }] }],
  },
  "scatter-xy": { type: "scatter", categories: ["a", "b", "c", "d", "e"], series: [{ name: "P", values: [158, 162, 171, 168, 180], x: [52, 57, 66, 64, 78] }], xAxis: { title: "Weight" }, yAxis: { title: "Height" } },
  waterfall: { type: "waterfall", dataLabels: true, categories: ["Open", "Sales", "Refunds", "Costs", "Subtotal", "Tax"], series: [{ name: "Cash", values: [120, 85, -12, -60, null, -18] }] },
  histogram: { type: "histogram", categories: Array.from({ length: 40 }, (_, i) => `${i}`), series: [{ name: "T", values: Array.from({ length: 40 }, (_, i) => (i * 37) % 23) }] },
  box: { type: "box", categories: Array.from({ length: 12 }, (_, i) => `${i}`), series: [{ name: "A", values: [3, 5, 7, 6, 4, 5, 6, 9, 5, 4, 30, 6] }, { name: "B", values: [8, 9, 7, 10, 9, 8, 11, 9, 10, 7, 9, 8] }] },
  radar: { type: "radar", categories: ["Speed", "Power", "Range", "Comfort", "Price"], series: [{ name: "A", values: [4, 3, 5, 2, 4] }, { name: "B", values: [3, 5, 2, 4, 3] }] },
  funnel: { type: "funnel", categories: ["Visits", "Sign-ups", "Trials", "Paid"], series: [{ name: "Users", values: [1000, 420, 180, 60] }] },
  treemap: { type: "treemap", categories: ["North", "South", "East", "West", "Online"], series: [{ name: "Sales", values: [40, 25, 18, 12, 30] }] },
  donut: { type: "donut", dataLabels: true, categories: ["A", "B", "C"], series: [{ name: "S", values: [5, 3, 2] }] },
  bubble: { type: "bubble", categories: ["a", "b", "c"], series: [{ name: "M", values: [10, 20, 15], x: [1, 2, 3], sizes: [5, 40, 10] }] },
  "error-bars": {
    title: "Trial results",
    categories: ["Control", "Low dose", "High dose"],
    series: [
      { name: "Week 4", values: [4.2, 6.8, 9.1], errorBars: { type: "custom", plus: [0.6, 1.1, 0.9], minus: [0.5, 0.8, 1.4] } },
      { name: "Target", type: "line", values: [5, 7, 8], errorBars: { type: "percent", value: 10, direction: "plus" } },
    ],
  },
  "log-line": { type: "line", title: "Users", categories: ["2019", "2020", "2021", "2022", "2023"], yAxis: { scale: "log" } as ChartSpec["yAxis"], series: [{ name: "Users", values: [12, 140, 2100, 18000, 0] }] },
  "reversed-bars": { type: "bar", orientation: "horizontal", dataLabels: true, xAxis: { reverse: true } as ChartSpec["xAxis"], yAxis: { reverse: true } as ChartSpec["yAxis"], categories: ["First", "Second", "Third"], series: [{ name: "Rank", values: [3, 5, 8] }] },
  "scatter-log-errors": { type: "scatter", categories: ["a", "b", "c", "d"], xAxis: { scale: "log", title: "Dose" } as ChartSpec["xAxis"], series: [{ name: "Response", values: [12, 20, 31, 38], x: [1, 10, 100, 1000], errorBars: { type: "stderr" }, xErrorBars: { type: "percent", value: 25 } }] },
};

describe("golden chart renders", () => {
  it.each(Object.keys(GOLDENS))("%s", async (name) => {
    const svg = chartToSvg(createChartSpec(GOLDENS[name]), { width: 480, height: 300 });
    await expect(svg.replace(/></g, ">\n<") + "\n").toMatchFileSnapshot(`./__goldens__/chart-${name}.svg`);
  });

  it("sparklines", async () => {
    const svg = [sparklineToSvg([1, 3, 2, null, 5, 4], { width: 80, height: 20, highLow: true }), sparklineToSvg([1, -2, 3], { kind: "column", width: 60, height: 20 }), sparklineToSvg([1, -1, 0, 2], { kind: "win-loss", width: 60, height: 20 })].join("\n");
    await expect(svg.replace(/></g, ">\n<") + "\n").toMatchFileSnapshot("./__goldens__/chart-sparklines.svg");
  });
});
