import type { DiagramGraph, GraphNode } from "../types.js";

/**
 * Geometry of a Gantt chart as Mermaid draws it: one row per task in
 * document order, sections as full-width bands with their name on the left,
 * bars placed on a shared time scale, milestones as diamonds, vertical grid
 * lines with date ticks along the bottom, and a "today" line. Shared by the
 * layout, the editor (dragging a bar changes its dates or its row) and the
 * React canvas.
 *
 * @module
 */

export const DAY_MS = 86_400_000;

export const GANTT_METRICS = {
  /** Mermaid's barHeight 20 / barGap 4, scaled up a little for editing. */
  barHeight: 24,
  barGap: 6,
  /** Width of the section-name column left of the chart. */
  labelWidth: 150,
  rightPadding: 40,
  /** Space for the date ticks under the chart. */
  axisHeight: 32,
  milestoneSize: 22,
  minChartWidth: 960,
  maxPxPerDay: 48,
  minPxPerDay: 4,
} as const;

export interface GanttRow {
  id: string;
  /** Section id, if the task belongs to one. */
  section?: string;
  sectionIndex: number;
  row: number;
  /** Bar box (absolute). */
  x: number;
  y: number;
  width: number;
  height: number;
  milestone: boolean;
  start?: number;
  end?: number;
}

export interface GanttBand {
  id?: string;
  label?: string;
  index: number;
  y: number;
  height: number;
}

export interface GanttTick {
  x: number;
  time: number;
  label: string;
}

export interface GanttGeometry {
  origin: number;
  pxPerDay: number;
  rows: GanttRow[];
  rowById: Map<string, GanttRow>;
  bands: GanttBand[];
  /** Chart area (right of the section labels). */
  chartX: number;
  chartWidth: number;
  top: number;
  bottom: number;
  ticks: GanttTick[];
  today?: number;
}

const time = (n: GraphNode, key: "startTime" | "endTime"): number | undefined =>
  typeof n.data?.[key] === "number" && Number.isFinite(n.data[key] as number)
    ? (n.data[key] as number)
    : undefined;

/**
 * Pixels per day: the largest of a few fixed steps that keeps the chart
 * around a comfortable width. Snapping to steps means small edits (dragging a
 * bar a few days) do not rescale the whole chart under the pointer.
 */
const SCALE_STEPS = [48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1];
function scaleFor(spanDays: number): number {
  const step = SCALE_STEPS.find((px) => spanDays * px <= 1200) ?? 1;
  return Math.min(GANTT_METRICS.maxPxPerDay, step);
}

export function ganttGeometry(graph: DiagramGraph, now = Date.now()): GanttGeometry {
  const M = GANTT_METRICS;
  const starts = graph.nodes.map((n) => time(n, "startTime")).filter((t) => t !== undefined);
  const ends = graph.nodes.map((n) => time(n, "endTime")).filter((t) => t !== undefined);
  const origin = starts.length ? Math.min(...starts) : Date.UTC(2026, 0, 1);
  const last = ends.length ? Math.max(...ends) : origin + 7 * DAY_MS;
  const spanDays = Math.max(1, (last - origin) / DAY_MS);
  const pxPerDay = scaleFor(spanDays);
  const chartX = 0;
  const chartWidth = Math.max(M.minChartWidth, spanDays * pxPerDay);
  const xOf = (t: number) => chartX + ((t - origin) / DAY_MS) * pxPerDay;

  // Bands: tasks without a section first (Mermaid's implicit section), then sections in order.
  const sectionIndex = new Map(graph.groups.map((g, i) => [g.id, i]));
  const ordered = [...graph.nodes].sort((a, b) => {
    const sa = a.parentId ? sectionIndex.get(a.parentId)! + 1 : 0;
    const sb = b.parentId ? sectionIndex.get(b.parentId)! + 1 : 0;
    return sa - sb;
  });
  const rowH = M.barHeight + M.barGap;
  const rows: GanttRow[] = [];
  const bands: GanttBand[] = [];
  const top = 0;
  let y = top;
  let row = 0;
  const pushBand = (
    id: string | undefined,
    label: string | undefined,
    index: number,
    nodes: GraphNode[],
  ) => {
    const bandTop = y;
    for (const n of nodes) {
      const start = time(n, "startTime");
      const end = time(n, "endTime");
      const milestone = n.shape === "milestone";
      const x = start !== undefined ? xOf(start) : chartX;
      const width = milestone
        ? M.milestoneSize
        : Math.max(
            6,
            start !== undefined && end !== undefined
              ? ((end - start) / DAY_MS) * pxPerDay
              : 6 * pxPerDay,
          );
      rows.push({
        id: n.id,
        section: id,
        sectionIndex: index,
        row: row++,
        x: milestone ? x - M.milestoneSize / 2 : x,
        y: y + M.barGap / 2 + (milestone ? (M.barHeight - M.milestoneSize) / 2 : 0),
        width,
        height: milestone ? M.milestoneSize : M.barHeight,
        milestone,
        start,
        end,
      });
      y += rowH;
    }
    // Empty sections still take one row, as Mermaid reserves their title.
    if (!nodes.length) y += rowH;
    bands.push({ id, label, index, y: bandTop, height: y - bandTop });
  };
  const loose = ordered.filter((n) => !n.parentId);
  if (loose.length) pushBand(undefined, undefined, -1, loose);
  graph.groups.forEach((g, i) =>
    pushBand(
      g.id,
      g.label,
      i,
      ordered.filter((n) => n.parentId === g.id),
    ),
  );

  return {
    origin,
    pxPerDay,
    rows,
    rowById: new Map(rows.map((r) => [r.id, r])),
    bands,
    chartX,
    chartWidth,
    top,
    bottom: y,
    ticks: ticksFor(
      origin,
      origin + (chartWidth / pxPerDay) * DAY_MS,
      xOf,
      graph.data?.axisFormat as string | undefined,
    ),
    today: graph.data?.todayMarker !== "off" && now >= origin && now <= last ? xOf(now) : undefined,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Formats UTC time with the d3 specifiers Mermaid's `axisFormat` uses (`%Y-%m-%d`, `%b %d`…). */
export function formatAxis(t: number, format = "%Y-%m-%d"): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return format.replace(/%([a-zA-Z%])/g, (_, c: string) => {
    switch (c) {
      case "Y":
        return String(d.getUTCFullYear());
      case "y":
        return pad(d.getUTCFullYear() % 100);
      case "m":
        return pad(d.getUTCMonth() + 1);
      case "d":
        return pad(d.getUTCDate());
      case "e":
        return String(d.getUTCDate());
      case "b":
        return MONTHS[d.getUTCMonth()]!;
      case "B":
        return MONTHS_LONG[d.getUTCMonth()]!;
      case "a":
        return DAYS[d.getUTCDay()]!;
      case "H":
        return pad(d.getUTCHours());
      case "M":
        return pad(d.getUTCMinutes());
      case "%":
        return "%";
      default:
        return `%${c}`;
    }
  });
}

/** Tick times on day, week (Mondays), month or year boundaries, like d3's time scale. */
function ticksFor(
  from: number,
  to: number,
  xOf: (t: number) => number,
  axisFormat: string | undefined,
): GanttTick[] {
  const days = (to - from) / DAY_MS;
  const start = new Date(from);
  const out: number[] = [];
  if (days <= 14) {
    for (
      let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
      t <= to;
      t += DAY_MS
    )
      if (t >= from) out.push(t);
  } else if (days <= 120) {
    let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    while (new Date(t).getUTCDay() !== 1) t += DAY_MS;
    for (; t <= to; t += 7 * DAY_MS) out.push(t);
  } else if (days <= 900) {
    for (let y = start.getUTCFullYear(), m = start.getUTCMonth() + 1; ; m++) {
      const t = Date.UTC(y, m, 1);
      if (t > to) break;
      out.push(t);
    }
  } else {
    for (let y = start.getUTCFullYear() + 1; Date.UTC(y, 0, 1) <= to; y++)
      out.push(Date.UTC(y, 0, 1));
  }
  return out.map((t) => ({ time: t, x: xOf(t), label: formatAxis(t, axisFormat || "%Y-%m-%d") }));
}

/** Date (UTC ms, snapped to whole days) at canvas x. */
export function timeAtX(geometry: GanttGeometry, x: number): number {
  const days = Math.round((x - geometry.chartX) / geometry.pxPerDay);
  return geometry.origin + days * DAY_MS;
}

/** Index (into `rows`) of the row nearest to canvas y. */
export function rowAtY(geometry: GanttGeometry, y: number): number {
  let best = 0;
  let bestDist = Infinity;
  geometry.rows.forEach((r, i) => {
    const d = Math.abs(r.y + r.height / 2 - y);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}
