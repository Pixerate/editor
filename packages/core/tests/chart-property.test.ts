// Random command sequences with invariants after every step, after vectorcraft-main/crates/testkit (`arb_ops`,
// `junk_values`, `check_document`, `undo_all` / `redo_all`) (MIT OR Apache-2.0, © ArtCraft Team and contributors).
// A seeded generator keeps failures reproducible without a property-testing dependency.
import { describe, expect, it } from "vitest";
import { HistoryManager } from "../src/history/HistoryManager";
import { CHART_TYPES, ChartController, chartToSvg, layoutChart, normalizeChartSpec, type ChartMark, type ChartSpec } from "../src/chart";

/** Mulberry32: a small seeded PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK: unknown[] = [0, -0, 1, -1, 0.1, 1e-12, 1e15, -1e15, 1e300, -1e300, Number.MAX_VALUE, NaN, Infinity, -Infinity, null, "", "12%", "1,234.5", "(3)", "abc", undefined, {}, [], true];

const finite = (m: ChartMark) => {
  const nums =
    m.kind === "rect" ? [m.x, m.y, m.width, m.height] : m.kind === "circle" ? [m.cx, m.cy, m.r] : m.kind === "line" ? [m.x1, m.y1, m.x2, m.y2] : m.kind === "text" ? [m.x, m.y] : (m.d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  return nums.every(Number.isFinite) && !(m.kind === "path" && /NaN|Infinity/.test(m.d));
};

function randomStep(c: ChartController, r: () => number) {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const spec = c.getSpec();
  const series = spec.series[Math.floor(r() * Math.max(1, spec.series.length))];
  const index = Math.floor(r() * Math.max(1, spec.categories.length + 1)) - (r() < 0.1 ? 2 : 0);
  switch (Math.floor(r() * 16)) {
    case 0:
      return c.setType(pick(CHART_TYPES));
    case 1:
      return series && c.setValue(series.id, index, pick(JUNK));
    case 2:
      return c.addSeries({ name: `S${Math.floor(r() * 99)}`, values: Array.from({ length: 4 }, () => pick(JUNK)) });
    case 3:
      return series && c.removeSeries(series.id);
    case 4:
      return c.addCategory(r() < 0.5 ? undefined : `2024-0${1 + Math.floor(r() * 9)}`);
    case 5:
      return c.removeCategory(index);
    case 6:
      return c.update({ stacking: pick(["none", "stacked", "percent"] as const), orientation: pick(["vertical", "horizontal"] as const), gapWidth: r() * 0.9, overlap: r() * 2 - 1 });
    case 7:
      return series && c.updateSeries(series.id, { axis: r() < 0.5 ? "secondary" : null, marker: pick(["circle", "square", "diamond", "triangle", "cross", "none"] as const), x: r() < 0.5 ? spec.categories.map(() => pick(JUNK)) : null, sizes: r() < 0.3 ? spec.categories.map(() => Math.abs(Number(pick(JUNK))) || null) : null });
    case 8:
      return series && c.addTrendline(series.id, { type: pick(["linear", "exponential", "logarithmic", "power", "polynomial", "moving-average"] as const), order: 2 + Math.floor(r() * 5), period: 2 + Math.floor(r() * 4), forward: r() * 3 });
    case 9:
      return c.setAxis(pick(["x", "y", "y2"] as const), { min: r() < 0.3 ? (pick(JUNK) as any) : null, max: null, step: r() < 0.3 ? r() * 10 : null, kind: r() < 0.2 ? "date" : undefined });
    case 10:
      return c.transpose();
    case 11:
      return c.applyPreset({ layout: pick(["standard", "minimal", "labelled", "presentation"]), colors: pick(["default", "monochrome-blue", "okabe-ito"]) });
    case 12:
      return c.update({ dataLabels: r() < 0.5, labelPosition: pick(["auto", "inside", "outside", "center"] as const), bins: r() < 0.5 ? null : 1 + Math.floor(r() * 30), showTotal: r() < 0.5 });
    case 13:
      return c.pasteCells(Math.floor(r() * 3), Math.floor(r() * 3) - 1, [[pick(JUNK), pick(JUNK)], [pick(JUNK), pick(JUNK)]]);
    case 14:
      return c.update({ yAxis: { format: pick([{}, { style: "percent" }, { code: '#,##0.0,,"M"' }, { code: "0.00E+00" }, { style: "compact" }]) as any } });
    default:
      return c.undo();
  }
}

describe("chart properties: random command sequences", () => {
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))("seed %i: every step leaves a valid spec that lays out to finite marks, and undo-all / redo-all are exact", (seed) => {
    const r = rng(seed * 7919);
    const c = new ChartController({ history: new HistoryManager({ maxDepth: 1000 }), spec: { categories: ["a", "b", "c"], series: [{ name: "A", values: [1, 2, 3] }, { name: "B", values: [-1, 0, 4] }] } });
    const initial = JSON.stringify(c.toJSON());
    for (let step = 0; step < 60; step++) {
      randomStep(c, r);
      const spec = c.getSpec() as ChartSpec;
      // The spec is always one normalization would accept unchanged.
      const again = normalizeChartSpec(JSON.parse(JSON.stringify(spec)));
      expect(again.issues, `seed ${seed} step ${step}`).toEqual([]);
      expect(spec.series.every((s) => s.values.length === spec.categories.length)).toBe(true);
      const sel = c.getState().selection;
      if (sel && "seriesId" in sel) expect(spec.series.some((s) => s.id === sel.seriesId)).toBe(true);
      for (const size of [{ width: 320, height: 200 }, { width: 37, height: 23 }]) {
        const scene = layoutChart(spec, size);
        const bad = scene.marks.filter((m) => !finite(m));
        expect(bad, `seed ${seed} step ${step} ${spec.type} ${size.width}`).toEqual([]);
      }
    }
    expect(chartToSvg(c.toJSON(), { width: 320, height: 200 })).not.toMatch(/NaN|Infinity/);
    // Redo anything a trailing undo took back, so "final" is the tip of the history.
    while (c.redo());
    const final = JSON.stringify(c.toJSON());
    while (c.undo());
    expect(JSON.stringify(c.toJSON())).toBe(initial);
    while (c.redo());
    expect(JSON.stringify(c.toJSON())).toBe(final);
  });
});
