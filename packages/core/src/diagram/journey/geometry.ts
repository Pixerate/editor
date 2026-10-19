import type { DiagramGraph, GraphNode } from "../types.js";
import type { SectionSpan } from "../statements/sections.js";

/**
 * Geometry of a user journey as Mermaid draws it (`journeyRenderer.ts`): an
 * actor legend on the left, section bars on top, one 150×50 task box per
 * column below them, a dashed line down from each task to its face (higher
 * score = higher face, 30px per point), and a thick axis between the tasks
 * and the faces. Shared by the layout (task and section boxes), the adapter
 * (dragging a task sideways reorders it) and the React canvas (faces, lines,
 * legend, axis, title), so all three agree.
 *
 * Coordinates are Mermaid's own (the legend starts at x = 0, the title
 * baseline is at y = 25).
 *
 * @module
 */

/** Mermaid's `journey` config defaults and renderer constants, in canvas pixels. */
export const JOURNEY_METRICS = {
  leftMargin: 150,
  taskWidth: 150,
  taskHeight: 50,
  /** `width + taskMargin`: distance between the left edges of two tasks. */
  taskStep: 200,
  sectionY: 50,
  /** `height * 2 + diagramMarginY`. */
  taskY: 110,
  /** Centre of a score-5 face; each point lower is 30px further down. */
  faceTop: 300,
  faceStep: 30,
  faceRadius: 15,
  /** Bottom of the dashed task lines (`300 + 5 * 30`). */
  lineBottom: 450,
  /** `height * 4`. */
  axisY: 200,
  axisWidth: 4,
  legendX: 20,
  legendY: 60,
  legendStep: 20,
  /** Legend labels start at `40 + 2 * boxTextMargin`. */
  legendTextX: 50,
  actorRadius: 7,
  /** Actor dots on a task: first centre 14px in, then every 10px. */
  actorInset: 14,
  actorStep: 10,
  titleBaseline: 25,
  fontSize: 16,
  /** `journey.sectionFills` has 7 entries; sections cycle through `fillType0…6`. */
  sectionColours: 7,
  /** `journey.actorColours` has 6 entries. */
  actorColours: 6,
} as const;

const M = JOURNEY_METRICS;

export interface JourneyBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface JourneyTaskBox extends JourneyBox {
  id: string;
  /** `fillType` slot of the task's section. */
  colour: number;
  score: number;
  /** Centre of the face. */
  face: { x: number; y: number };
  /** Actor dots across the top edge, with their legend slot. */
  actors: { name: string; colour: number; x: number; y: number }[];
  index: number;
}

export interface JourneySectionBox extends JourneyBox {
  id: string;
  colour: number;
  /** Mermaid draws no bar for a section without tasks; the canvas parks one after the tasks. */
  empty: boolean;
}

export interface JourneyGeometry {
  tasks: Map<string, JourneyTaskBox>;
  sections: Map<string, JourneySectionBox>;
  /** Actors in Mermaid's order (sorted), with their legend dot and label positions. */
  legend: { name: string; colour: number; x: number; y: number; labelX: number }[];
  /** `leftMargin` plus the widest legend label when it exceeds half of it. */
  left: number;
  axis: { x1: number; x2: number; y: number };
  title: { x: number; baseline: number };
  spans: SectionSpan[];
  width: number;
  height: number;
}

let measurer: CanvasRenderingContext2D | null | undefined;

/**
 * Width of text in Mermaid's default font: measured with a canvas in a
 * browser, estimated (0.47em per character) elsewhere (tests, SSR, jsdom).
 */
export function textWidth(text: string, fontSize: number = M.fontSize, bold = false): number {
  if (measurer === undefined) {
    measurer = null;
    const browser =
      typeof document !== "undefined" &&
      typeof navigator !== "undefined" &&
      !/jsdom/i.test(navigator.userAgent);
    if (browser)
      try {
        measurer = document.createElement("canvas").getContext("2d");
      } catch {
        measurer = null;
      }
  }
  if (!measurer) return text.length * fontSize * 0.47;
  measurer.font = `${bold ? "bold " : ""}${fontSize}px "trebuchet ms", verdana, arial, sans-serif`;
  return measurer.measureText(text).width;
}

/** Score clamped to Mermaid's 1–5 range for drawing. */
export function faceY(score: number): number {
  return M.faceTop + (5 - score) * M.faceStep;
}

/** The whole score (1–5) whose face row is nearest to `y`. */
export function scoreAt(y: number): number {
  return Math.min(5, Math.max(1, Math.round(5 - (y - M.faceTop) / M.faceStep)));
}

function actorsOf(node: GraphNode): string[] {
  const actors = node.data?.actors;
  return Array.isArray(actors) ? actors.map(String) : [];
}

export function journeyGeometry(graph: DiagramGraph): JourneyGeometry {
  // Mermaid: unique actors of all tasks, sorted; colours follow that order.
  const names = [...new Set(graph.nodes.flatMap(actorsOf))].sort();
  const slot = new Map(names.map((n, i) => [n, i]));
  const legend = names.map((name, i) => ({
    name,
    colour: i % M.actorColours,
    x: M.legendX,
    y: M.legendY + i * M.legendStep,
    labelX: M.legendTextX,
  }));
  const widest = Math.max(0, ...names.map((n) => textWidth(n)));
  const left = M.leftMargin + (widest > M.leftMargin / 2 ? widest : 0);

  const groups = graph.groups;
  const inGroup = (n: GraphNode) => !!n.parentId && groups.some((g) => g.id === n.parentId);
  // Mermaid's columns follow document order; the graph lists the tasks
  // before the first section first, then each section's tasks.
  const ordered = [
    ...graph.nodes.filter((n) => !inGroup(n)),
    ...groups.flatMap((g) => graph.nodes.filter((n) => n.parentId === g.id)),
  ];
  const tasks = new Map<string, JourneyTaskBox>();
  const colourOf = new Map<string | undefined, number>();
  let drawn = 0;
  for (const g of groups)
    if (graph.nodes.some((n) => n.parentId === g.id))
      colourOf.set(g.id, drawn++ % M.sectionColours);
  ordered.forEach((n, i) => {
    const x = left + i * M.taskStep;
    const score = typeof n.data?.score === "number" ? n.data.score : 0;
    const cx = x + M.taskWidth / 2;
    tasks.set(n.id, {
      id: n.id,
      x,
      y: M.taskY,
      width: M.taskWidth,
      height: M.taskHeight,
      // Tasks before the first section get Mermaid's default slot 0.
      colour: inGroup(n) ? (colourOf.get(n.parentId) ?? 0) : 0,
      score,
      face: { x: cx, y: faceY(score) },
      actors: actorsOf(n)
        .filter((a) => slot.has(a))
        .map((name, k) => ({
          name,
          colour: slot.get(name)! % M.actorColours,
          x: x + M.actorInset + k * M.actorStep,
          y: M.taskY,
        })),
      index: i,
    });
  });

  const sections = new Map<string, JourneySectionBox>();
  const spans: SectionSpan[] = [];
  const looseIds = ordered.filter((n) => !inGroup(n)).map((n) => n.id);
  const centre = (id: string) => tasks.get(id)!.x + M.taskWidth / 2;
  if (looseIds.length)
    spans.push({
      x0: left,
      x1: left + looseIds.length * M.taskStep,
      items: looseIds.map((id) => ({ id, centre: centre(id) })),
    });
  let parked = ordered.length;
  for (const g of groups) {
    const members = ordered.filter((n) => n.parentId === g.id).map((n) => n.id);
    const first = members.length ? tasks.get(members[0]!)!.index : parked++;
    const x = left + first * M.taskStep;
    const count = Math.max(members.length, 1);
    sections.set(g.id, {
      id: g.id,
      x,
      y: M.sectionY,
      width: M.taskWidth * count + (M.taskStep - M.taskWidth) * (count - 1),
      height: M.taskHeight,
      colour: colourOf.get(g.id) ?? 0,
      empty: !members.length,
    });
    spans.push({
      section: g.id,
      x0: x,
      x1: x + count * M.taskStep,
      items: members.map((id) => ({ id, centre: centre(id) })),
    });
  }
  spans.sort((a, b) => a.x0 - b.x0);

  // Mermaid: from `leftMargin` to `width - leftMargin - 4`, i.e. 196px past the last task's left edge.
  const last = left + (ordered.length - 1) * M.taskStep;
  const width = Math.max(left + Math.max(parked, 1) * M.taskStep, left + M.taskStep);
  return {
    tasks,
    sections,
    legend,
    left,
    axis: { x1: left, x2: ordered.length ? last + 196 : left + 96, y: M.axisY },
    title: { x: left, baseline: M.titleBaseline },
    spans,
    width,
    height: M.lineBottom + M.faceRadius,
  };
}
