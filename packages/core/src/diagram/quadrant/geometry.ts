import type { DiagramGraph, Point } from "../types.js";

/**
 * Geometry of a quadrant chart as Mermaid draws it (`quadrantBuilder.ts`): a
 * 500×500 chart with the title on top, the y-axis labels in a strip on the
 * left, the x-axis labels in a strip under the chart (above it when there
 * are no points), the square chart area split into four quadrants, and every
 * point a circle on its `[x, y]` with its label just below. Shared by the
 * layout, the editor (dragging a point rewrites its coordinates) and the
 * React canvas, so all three agree.
 *
 * All coordinates are canvas pixels in the frame of Mermaid's SVG.
 *
 * @module
 */

/** Mermaid's `quadrantChart` defaults. */
export const QUADRANT_METRICS = {
  chartWidth: 500,
  chartHeight: 500,
  titleFontSize: 20,
  titlePadding: 10,
  quadrantPadding: 5,
  xAxisLabelPadding: 5,
  yAxisLabelPadding: 5,
  xAxisLabelFontSize: 16,
  yAxisLabelFontSize: 16,
  quadrantLabelFontSize: 16,
  quadrantTextTopPadding: 5,
  pointTextPadding: 5,
  pointLabelFontSize: 12,
  pointRadius: 5,
  internalBorderWidth: 1,
  externalBorderWidth: 2,
} as const;

/** Side of the square node box every point gets on the canvas (centred on the point). */
export const POINT_BOX = 24;

export interface QuadrantSpace {
  /** Left / top of the chart area (the four quadrants). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Mermaid moves the x-axis labels under the chart once there are points. */
  xAxisPosition: "top" | "bottom";
}

export interface QuadrantSpaceInput {
  title: boolean;
  xAxis: boolean;
  yAxis: boolean;
  points: boolean;
}

/** Mermaid's `calculateSpace`. */
export function quadrantSpace({ title, xAxis, yAxis, points }: QuadrantSpaceInput): QuadrantSpace {
  const M = QUADRANT_METRICS;
  const xAxisPosition = points ? "bottom" : "top";
  const xAxisSpace = xAxis ? M.xAxisLabelPadding * 2 + M.xAxisLabelFontSize : 0;
  const yAxisSpace = yAxis ? M.yAxisLabelPadding * 2 + M.yAxisLabelFontSize : 0;
  const titleSpace = title ? M.titleFontSize + M.titlePadding * 2 : 0;
  const top = M.quadrantPadding + (xAxisPosition === "top" ? xAxisSpace : 0) + titleSpace;
  return {
    left: M.quadrantPadding + yAxisSpace,
    top,
    width: M.chartWidth - M.quadrantPadding * 2 - yAxisSpace,
    height: M.chartHeight - M.quadrantPadding * 2 - xAxisSpace - titleSpace,
    xAxisPosition,
  };
}

type GraphLike = Pick<DiagramGraph, "nodes" | "title" | "data">;

/** What the space depends on, read from a graph. */
export function spaceInput(graph: GraphLike, pointCount = graph.nodes.length): QuadrantSpaceInput {
  const d = graph.data ?? {};
  return {
    title: !!graph.title,
    xAxis: !!(d.xAxisLeft || d.xAxisRight),
    yAxis: !!(d.yAxisBottom || d.yAxisTop),
    points: pointCount > 0,
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** Centre of a point with coordinates `[x, y]` (0–1). */
export function pointCentre(x: number, y: number, space: QuadrantSpace): Point {
  return [space.left + x * space.width, space.top + (1 - y) * space.height];
}

/** Top-left of a point's node box (see {@link POINT_BOX}). */
export function pointPosition(x: number, y: number, space: QuadrantSpace): Point {
  const [cx, cy] = pointCentre(x, y, space);
  return [cx - POINT_BOX / 2, cy - POINT_BOX / 2];
}

/** Coordinates (0–1, two decimals, clamped) of a point whose node box is at `position`. */
export function positionToData(position: Point, space: QuadrantSpace): { x: number; y: number } {
  const cx = position[0] + POINT_BOX / 2;
  const cy = position[1] + POINT_BOX / 2;
  return {
    x: clamp01(round((cx - space.left) / space.width, 2)),
    y: clamp01(round(1 - (cy - space.top) / space.height, 2)),
  };
}

export interface QuadrantBox {
  n: 1 | 2 | 3 | 4;
  /** Group id (`quadrant-1`…). */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Label anchor: centred horizontally; `top` hangs from y, `middle` is centred on it. */
  labelX: number;
  labelY: number;
  labelBaseline: "top" | "middle";
}

export type AxisKey = "xAxisLeft" | "xAxisRight" | "yAxisBottom" | "yAxisTop";

export interface QuadrantAxisLabel {
  key: AxisKey;
  text: string;
  /** Anchor; the text hangs from it (rotated −90° for the y axis, reading upwards). */
  x: number;
  y: number;
  anchor: "start" | "middle";
  rotation: 0 | -90;
  /** Length of the strip the label belongs to (for hit boxes). */
  span: number;
}

export interface QuadrantPointGeometry {
  id: string;
  label: string;
  cx: number;
  cy: number;
  radius: number;
  color?: string;
  strokeColor?: string;
  strokeWidth?: string;
}

export interface QuadrantBorder {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  external: boolean;
}

export interface QuadrantGeometry {
  space: QuadrantSpace;
  /** Title anchor (centred, hanging from y), when there is a title. */
  title?: { text: string; x: number; y: number };
  quadrants: QuadrantBox[];
  axisLabels: QuadrantAxisLabel[];
  borders: QuadrantBorder[];
  points: QuadrantPointGeometry[];
}

/** `["color: #f00", "radius: 4"]` → `{ color: "#f00", radius: "4" }`. */
function styleMap(styles: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of styles ?? []) {
    const i = s.indexOf(":");
    if (i !== -1) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

/** Computes the chart as Mermaid would draw `graph`. */
export function quadrantGeometry(
  graph: GraphLike & Partial<Pick<DiagramGraph, "classDefs">>,
): QuadrantGeometry {
  const M = QUADRANT_METRICS;
  const space = quadrantSpace(spaceInput(graph));
  const { left, top, width, height } = space;
  const halfW = width / 2;
  const halfH = height / 2;
  const d = (graph.data ?? {}) as Record<string, unknown>;
  const text = (k: AxisKey) => (typeof d[k] === "string" ? (d[k] as string) : "");
  const hasPoints = graph.nodes.length > 0;

  const origin: Record<1 | 2 | 3 | 4, [number, number]> = {
    1: [left + halfW, top],
    2: [left, top],
    3: [left, top + halfH],
    4: [left + halfW, top + halfH],
  };
  const quadrants: QuadrantBox[] = ([1, 2, 3, 4] as const).map((n) => {
    const [x, y] = origin[n];
    return {
      n,
      id: `quadrant-${n}`,
      x,
      y,
      width: halfW,
      height: halfH,
      labelX: x + halfW / 2,
      labelY: hasPoints ? y + M.quadrantTextTopPadding : y + halfH / 2,
      labelBaseline: hasPoints ? "top" : "middle",
    };
  });

  const axisLabels: QuadrantAxisLabel[] = [];
  const xInMiddle = !!text("xAxisRight");
  const yInMiddle = !!text("yAxisTop");
  const titleSpace = graph.title ? M.titleFontSize + M.titlePadding * 2 : 0;
  const xY =
    space.xAxisPosition === "top"
      ? M.xAxisLabelPadding + titleSpace
      : M.xAxisLabelPadding + top + height + M.quadrantPadding;
  if (text("xAxisLeft"))
    axisLabels.push({
      key: "xAxisLeft",
      text: text("xAxisLeft"),
      x: left + (xInMiddle ? halfW / 2 : 0),
      y: xY,
      anchor: xInMiddle ? "middle" : "start",
      rotation: 0,
      span: xInMiddle ? halfW : width,
    });
  if (text("xAxisRight"))
    axisLabels.push({
      key: "xAxisRight",
      text: text("xAxisRight"),
      x: left + halfW + (xInMiddle ? halfW / 2 : 0),
      y: xY,
      anchor: xInMiddle ? "middle" : "start",
      rotation: 0,
      span: halfW,
    });
  if (text("yAxisBottom"))
    axisLabels.push({
      key: "yAxisBottom",
      text: text("yAxisBottom"),
      x: M.yAxisLabelPadding,
      y: top + height - (yInMiddle ? halfH / 2 : 0),
      anchor: yInMiddle ? "middle" : "start",
      rotation: -90,
      span: yInMiddle ? halfH : height,
    });
  if (text("yAxisTop"))
    axisLabels.push({
      key: "yAxisTop",
      text: text("yAxisTop"),
      x: M.yAxisLabelPadding,
      y: top + halfH - (yInMiddle ? halfH / 2 : 0),
      anchor: yInMiddle ? "middle" : "start",
      rotation: -90,
      span: halfH,
    });

  const hb = M.externalBorderWidth / 2;
  const borders: QuadrantBorder[] = [
    { x1: left - hb, y1: top, x2: left + width + hb, y2: top, external: true },
    { x1: left + width, y1: top + hb, x2: left + width, y2: top + height - hb, external: true },
    { x1: left - hb, y1: top + height, x2: left + width + hb, y2: top + height, external: true },
    { x1: left, y1: top + hb, x2: left, y2: top + height - hb, external: true },
    { x1: left + halfW, y1: top + hb, x2: left + halfW, y2: top + height - hb, external: false },
    { x1: left + hb, y1: top + halfH, x2: left + width - hb, y2: top + halfH, external: false },
  ];

  const points: QuadrantPointGeometry[] = graph.nodes.map((n) => {
    const x = typeof n.data?.x === "number" ? n.data.x : 0.5;
    const y = typeof n.data?.y === "number" ? n.data.y : 0.5;
    const [cx, cy] = pointCentre(x, y, space);
    // Class styles first, the point's own styles over them (as Mermaid merges them).
    const cls = n.classes.reduce<Record<string, string>>(
      (acc, c) => ({ ...acc, ...styleMap(graph.classDefs?.[c]) }),
      {},
    );
    const own = n.data ?? {};
    const classRadius = cls.radius !== undefined ? parseInt(cls.radius, 10) : NaN;
    const radius =
      typeof own.radius === "number"
        ? own.radius
        : Number.isFinite(classRadius)
          ? classRadius
          : M.pointRadius;
    const color = (typeof own.color === "string" ? own.color : undefined) ?? cls.color;
    const strokeColor =
      (typeof own.strokeColor === "string" ? own.strokeColor : undefined) ?? cls["stroke-color"];
    const strokeWidth =
      (typeof own.strokeWidth === "string" ? own.strokeWidth : undefined) ?? cls["stroke-width"];
    return {
      id: n.id,
      label: n.label,
      cx,
      cy,
      radius,
      ...(color ? { color } : {}),
      ...(strokeColor ? { strokeColor } : {}),
      ...(strokeWidth ? { strokeWidth } : {}),
    };
  });

  return {
    space,
    ...(graph.title
      ? { title: { text: graph.title, x: M.chartWidth / 2, y: M.titlePadding } }
      : {}),
    quadrants,
    axisLabels,
    borders,
    points,
  };
}
