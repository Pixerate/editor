import type { DiagramGraph, GraphNode } from "../types.js";
import type { SectionSpan } from "../statements/sections.js";

/**
 * Geometry of a timeline as Mermaid's (left-to-right) renderer draws it:
 * section header bands on top, one 190px column per period with its box
 * below the header, a thick time axis under the periods, and each period's
 * events stacked further down on a dashed line. Shared by the layout (period
 * and section boxes), the adapter (dragging a period sideways reorders it)
 * and the React canvas (events, lines, axis, title), so all three agree.
 *
 * Coordinates are Mermaid's, shifted so the first column starts at x = 0 and
 * the top of the first row (headers, or periods without sections) at y = 0.
 *
 * @module
 */

/** Mermaid's timeline constants (`timelineRenderer.ts`, `svgDraw.js`), in canvas pixels. */
export const TIMELINE_METRICS = {
  /** Box width: 150px of text plus 20px padding on both sides. */
  nodeWidth: 190,
  /** Width text wraps at. */
  wrapWidth: 150,
  padding: 20,
  /** Distance between the left edges of two columns. */
  columnStep: 200,
  fontSize: 16,
  lineHeight: 17.6,
  /** Events are at least this tall. */
  eventMinHeight: 50,
  eventGap: 10,
  /** From a period's top to its first event. */
  eventOffset: 200,
  /** Between the section headers and the periods. */
  sectionGap: 50,
  /** Between the bottom of the period row and the axis. */
  axisGap: 50,
  /** The axis starts this far left of the first column… */
  axisBefore: 50,
  /** …and ends this far right of the last one. */
  axisAfter: 250,
  axisWidth: 4,
  eventLineWidth: 2,
  /** Mermaid's colour scale has 12 slots (`cScale0`…`cScale11`). */
  colours: 12,
} as const;

const M = TIMELINE_METRICS;

/** Colour slot: an index into Mermaid's `cScale` scale, or `root` (`git0`). */
export type TimelineColour = number | "root";

export interface TimelineBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TimelinePeriodBox extends TimelineBox {
  id: string;
  colour: TimelineColour;
  /** Index in visual (document) order. */
  index: number;
}

export interface TimelineEventBox extends TimelineBox {
  periodId: string;
  /** Index in the period's `events`. */
  index: number;
  text: string;
  colour: TimelineColour;
}

export interface TimelineSectionBox extends TimelineBox {
  id: string;
  colour: TimelineColour;
  /** True when the section has no periods (Mermaid still reserves a column). */
  empty: boolean;
}

export interface TimelineGeometry {
  periods: Map<string, TimelinePeriodBox>;
  sections: Map<string, TimelineSectionBox>;
  /** Events of every period, in order. */
  events: TimelineEventBox[];
  /** Dashed line under each period, from the bottom of its box past its events. */
  eventLines: { periodId: string; x: number; y1: number; y2: number }[];
  /** Where the "add event" affordance goes under each period's last event. */
  addEvent: Map<string, { x: number; y: number }>;
  axis: { x1: number; x2: number; y: number };
  /** Top-left of the title text box (Mermaid: `x = width / 2 - leftMargin`, baseline 20). */
  title: { x: number; baseline: number };
  /** Section spans for drag-to-reorder (see `sectionDropTarget`). */
  spans: SectionSpan[];
  hasSections: boolean;
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

/** Lines `text` wraps to at `width` (word wrap, `<br>` breaks), as Mermaid's `wrap`. */
export function wrapLines(text: string, width: number = M.wrapWidth): number {
  let lines = 0;
  for (const part of String(text).split(/<br\s*\/?>|\n/i)) {
    lines++;
    let line = "";
    for (const word of part.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next) > width) {
        lines++;
        line = word;
      } else line = next;
    }
  }
  return Math.max(1, lines);
}

/**
 * Height Mermaid gives a box of text (`getVirtualNodeHeight`): the text's
 * bounding box, half a line and the padding.
 */
export function textBoxHeight(text: string, width: number = M.wrapWidth): number {
  const lines = wrapLines(text, width);
  const bbox = M.fontSize * 1.15 + (lines - 1) * M.lineHeight;
  return bbox + M.fontSize * 1.1 * 0.5 + M.padding;
}

function eventsOf(node: GraphNode): string[] {
  const events = node.data?.events;
  return Array.isArray(events) ? events.map(String) : [];
}

export function timelineGeometry(graph: DiagramGraph): TimelineGeometry {
  const groups = graph.groups;
  const hasSections = groups.length > 0;
  const inGroup = (n: GraphNode) => !!n.parentId && groups.some((g) => g.id === n.parentId);
  // Mermaid sizes every period box from the text "[object Object]" (it
  // measures the task object), so the row height is the same for all.
  const rowHeight = graph.nodes.length ? textBoxHeight("[object Object]") + 20 : 0;
  const headerHeight = Math.max(0, ...groups.map((g) => textBoxHeight(g.label) + 20));
  const eventStack = Math.max(
    0,
    ...graph.nodes.map((n) => {
      const events = eventsOf(n);
      return (
        events.reduce((sum, e) => sum + textBoxHeight(e), 0) +
        Math.max(0, events.length - 1) * M.eventGap
      );
    }),
  );
  const periodY = hasSections ? headerHeight + M.sectionGap : 0;

  const periods = new Map<string, TimelinePeriodBox>();
  const sections = new Map<string, TimelineSectionBox>();
  const events: TimelineEventBox[] = [];
  const eventLines: TimelineGeometry["eventLines"] = [];
  const addEvent = new Map<string, { x: number; y: number }>();
  const spans: SectionSpan[] = [];

  const centreOf = (id: string): number => {
    const p = periods.get(id);
    return p ? p.x + p.width / 2 : 0;
  };
  let x = 0;
  let index = 0;
  const place = (node: GraphNode, colour: TimelineColour) => {
    const height = Math.max(textBoxHeight(node.label ?? node.id), rowHeight);
    periods.set(node.id, { id: node.id, x, y: periodY, width: M.nodeWidth, height, colour, index });
    let y = periodY + M.eventOffset;
    eventsOf(node).forEach((text, i) => {
      const h = Math.max(textBoxHeight(text), M.eventMinHeight);
      events.push({
        periodId: node.id,
        index: i,
        text,
        colour,
        x,
        y,
        width: M.nodeWidth,
        height: h,
      });
      y += h + M.eventGap;
    });
    const centre = x + M.nodeWidth / 2;
    addEvent.set(node.id, { x: centre, y: y - M.eventGap + 14 });
    eventLines.push({
      periodId: node.id,
      x: centre,
      y1: periodY + height,
      y2: periodY + rowHeight + M.eventOffset + eventStack,
    });
    index++;
    x += M.columnStep;
  };

  // Periods before the first section: Mermaid skips them once there are
  // sections; the canvas keeps them (in Mermaid's "root" colour) so they stay editable.
  const loose = graph.nodes.filter((n) => !inGroup(n));
  if (loose.length) {
    const x0 = x;
    loose.forEach((n, i) => place(n, hasSections ? "root" : i % M.colours));
    spans.push({ x0, x1: x, items: loose.map((n) => ({ id: n.id, centre: centreOf(n.id) })) });
  }
  groups.forEach((g, s) => {
    const members = graph.nodes.filter((n) => n.parentId === g.id);
    const x0 = x;
    const colour = s % M.colours;
    if (members.length) members.forEach((n) => place(n, colour));
    else x += M.columnStep;
    const width = M.columnStep * Math.max(members.length, 1) - 10;
    sections.set(g.id, {
      id: g.id,
      x: x0,
      y: 0,
      width,
      height: Math.max(textBoxHeight(g.label, width - 2 * M.padding), headerHeight),
      colour,
      empty: !members.length,
    });
    spans.push({
      section: g.id,
      x0,
      x1: x,
      items: members.map((n) => ({ id: n.id, centre: centreOf(n.id) })),
    });
  });
  const width = Math.max(0, x - (M.columnStep - M.nodeWidth));
  const axisY = periodY + rowHeight + M.axisGap;
  const bottom = Math.max(
    axisY,
    ...eventLines.map((l) => l.y2),
    ...events.map((e) => e.y + e.height),
  );
  return {
    periods,
    sections,
    events,
    eventLines,
    addEvent,
    axis: { x1: -M.axisBefore, x2: width + M.axisAfter, y: axisY },
    // Mermaid: `x = box.width / 2 - leftMargin` with the content starting at
    // 50 + leftMargin (leftMargin 150), baseline at y = 20 (30 above the content).
    title: { x: width / 2 - 350, baseline: -30 },
    spans,
    hasSections,
    width,
    height: bottom,
  };
}
