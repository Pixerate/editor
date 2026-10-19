import type { DiagramGraph } from "../types.js";

/**
 * Geometry of a pie chart as Mermaid draws it (`pieRenderer.ts`): a 450×450
 * frame with the pie centred in it (radius 185 = 450 / 2 − 40), wedges in
 * document order clockwise from 12 o'clock, a percentage label on each wedge
 * at 0.75 of the radius, the legend to the right of the pie (one 18 px colour
 * square + name per row, 22 px apart, vertically centred) and the title
 * centred above. Shared by the layout and the React canvas, so both agree.
 *
 * Mermaid's quirks are kept: a label that repeats an earlier one is ignored
 * (the first value wins); slices under 1 % of the total get no wedge (the
 * others share the full circle) but keep their legend row; wedge colours
 * follow the order of the distinct labels (`pie1`…`pie12`, cycling).
 *
 * All coordinates are canvas pixels in the frame of Mermaid's SVG.
 *
 * @module
 */

/** Mermaid's pie defaults. */
export const PIE_METRICS = {
  height: 450,
  margin: 40,
  legendRectSize: 18,
  legendSpacing: 4,
  /** `pie.textPosition`: label distance from the centre, as a fraction of the radius. */
  textPosition: 0.75,
  /** `pieOuterStrokeWidth` (the outer circle sits half a stroke outside the wedges). */
  outerStrokeWidth: 2,
  titleFontSize: 25,
  legendFontSize: 17,
  /** Wedges under this percentage of the total are not drawn. */
  minPercent: 1,
} as const;

export interface PieSliceGeometry {
  id: string;
  label: string;
  value: number;
  /** Share of the total, 0–100 (what the wedge label shows, rounded). */
  percent: number;
  /** Index into Mermaid's `pie1`…`pie12` palette (0-based, already wrapped). */
  colorIndex: number;
  /** False for slices too small to get a wedge (and for duplicate labels). */
  drawn: boolean;
  /** Radians clockwise from 12 o'clock. */
  startAngle: number;
  endAngle: number;
  /** SVG path of the wedge, in canvas coordinates. */
  path: string;
  /** Anchor of the percentage label (`text-anchor: middle`, alphabetic baseline). */
  labelX: number;
  labelY: number;
  /** The wedge's label text, e.g. `42%`. */
  labelText: string;
}

export interface PieLegendEntry {
  sliceId: string;
  label: string;
  /** Text Mermaid prints: the label, plus ` [value]` with `showData`. */
  text: string;
  colorIndex: number;
  /** Top-left of the colour square. */
  x: number;
  y: number;
}

export interface PieGeometry {
  cx: number;
  cy: number;
  radius: number;
  /** Radius of the outer circle's centre line. */
  outerRadius: number;
  /** Square every wedge node shares (the pie plus its outer stroke). */
  box: { x: number; y: number; width: number; height: number };
  /** One entry per graph node, in document order (duplicates have `drawn: false`). */
  slices: PieSliceGeometry[];
  legend: PieLegendEntry[];
  /** Title anchor (`text-anchor: middle`, alphabetic baseline), when there is a title. */
  title?: { text: string; x: number; y: number };
}

const TAU = Math.PI * 2;

const round = (v: number) => Math.round(v * 1000) / 1000;

/** The point at `angle` (clockwise from 12 o'clock) on a circle. */
function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [round(cx + r * Math.sin(angle)), round(cy - r * Math.cos(angle))];
}

/** A wedge path as d3's `arc()` draws it (a full circle for a lone slice). */
export function wedgePath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
): string {
  const sweep = endAngle - startAngle;
  if (sweep <= 0) return "";
  if (sweep >= TAU - 1e-6) {
    const [x0, y0] = polar(cx, cy, r, 0);
    const [x1, y1] = polar(cx, cy, r, Math.PI);
    return `M${x0},${y0}A${r},${r},0,1,1,${x1},${y1}A${r},${r},0,1,1,${x0},${y0}Z`;
  }
  const [x0, y0] = polar(cx, cy, r, startAngle);
  const [x1, y1] = polar(cx, cy, r, endAngle);
  const large = sweep > Math.PI ? 1 : 0;
  return `M${x0},${y0}A${r},${r},0,${large},1,${x1},${y1}L${cx},${cy}Z`;
}

/** Rough legend text width (Mermaid measures the DOM; the canvas only needs a hit box). */
export function legendTextWidth(text: string): number {
  return Math.ceil(text.length * PIE_METRICS.legendFontSize * 0.56);
}

/** Computes the pie as Mermaid would draw `graph`. */
export function pieGeometry(graph: Pick<DiagramGraph, "nodes" | "title" | "data">): PieGeometry {
  const M = PIE_METRICS;
  const cx = M.height / 2;
  const cy = M.height / 2;
  const radius = M.height / 2 - M.margin;
  const outerRadius = radius + M.outerStrokeWidth / 2;
  const pad = M.outerStrokeWidth;
  const box = {
    x: cx - outerRadius - pad,
    y: cy - outerRadius - pad,
    width: 2 * (outerRadius + pad),
    height: 2 * (outerRadius + pad),
  };

  // Mermaid keeps the first section for each label.
  const seen = new Set<string>();
  const sections: { id: string; label: string; value: number }[] = [];
  const duplicates = new Set<string>();
  for (const n of graph.nodes) {
    const value = typeof n.data?.value === "number" ? n.data.value : 0;
    if (seen.has(n.label)) {
      duplicates.add(n.id);
      continue;
    }
    seen.add(n.label);
    sections.push({ id: n.id, label: n.label, value });
  }
  const sum = sections.reduce((acc, s) => acc + s.value, 0);
  const pct = (v: number) => (sum > 0 ? (v / sum) * 100 : 0);
  const drawn = sections.filter((s) => pct(s.value) >= M.minPercent);
  const drawnSum = drawn.reduce((acc, s) => acc + s.value, 0);

  const angles = new Map<string, [number, number]>();
  let angle = 0;
  for (const s of drawn) {
    const sweep = drawnSum > 0 ? (s.value / drawnSum) * TAU : 0;
    angles.set(s.id, [angle, angle + sweep]);
    angle += sweep;
  }

  const colorOf = new Map(sections.map((s, i) => [s.id, i % 12]));
  const labelRadius = radius * M.textPosition;
  const slices: PieSliceGeometry[] = graph.nodes.map((n) => {
    const section = sections.find((s) => s.id === n.id);
    const range = angles.get(n.id);
    const value = section?.value ?? (typeof n.data?.value === "number" ? n.data.value : 0);
    const percent = section ? pct(section.value) : 0;
    const [startAngle, endAngle] = range ?? [0, 0];
    const mid = (startAngle + endAngle) / 2;
    const [labelX, labelY] = polar(cx, cy, labelRadius, mid);
    return {
      id: n.id,
      label: n.label,
      value,
      percent,
      colorIndex: colorOf.get(n.id) ?? 0,
      drawn: !!range && !duplicates.has(n.id),
      startAngle,
      endAngle,
      path: range ? wedgePath(cx, cy, radius, startAngle, endAngle) : "",
      labelX,
      labelY,
      labelText: `${percent.toFixed(0)}%`,
    };
  });

  const rowHeight = M.legendRectSize + M.legendSpacing;
  const offset = (rowHeight * sections.length) / 2;
  const showData = !!graph.data?.showData;
  const legend: PieLegendEntry[] = sections.map((s, i) => ({
    sliceId: s.id,
    label: s.label,
    text: showData ? `${s.label} [${s.value}]` : s.label,
    colorIndex: i % 12,
    x: cx + 12 * M.legendRectSize,
    y: cy + i * rowHeight - offset,
  }));

  return {
    cx,
    cy,
    radius,
    outerRadius,
    box,
    slices,
    legend,
    ...(graph.title ? { title: { text: graph.title, x: cx, y: cy - (M.height - 50) / 2 } } : {}),
  };
}
