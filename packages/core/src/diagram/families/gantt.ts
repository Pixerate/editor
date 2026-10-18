import type { DiagramGraph } from "../types.js";
import type { FamilyUI } from "./types.js";
import { GANTT_TAGS, formatGanttDate } from "../gantt/index.js";

function nextTaskId(graph: DiagramGraph): string {
  const taken = new Set([...graph.nodes.map((n) => n.id), ...graph.groups.map((g) => g.id)]);
  let i = graph.nodes.length + 1;
  while (taken.has(`task${i}`)) i++;
  return `task${i}`;
}

/**
 * Start date for a new task: right after the latest computed end, else the
 * earliest written start, else `2026-01-01`.
 */
function newTaskStart(graph: DiagramGraph): string {
  const format = typeof graph.data?.dateFormat === "string" ? graph.data.dateFormat : undefined;
  const ends = graph.nodes
    .map((n) => n.data?.endTime)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (ends.length) return formatGanttDate(Math.max(...ends), format);
  const starts = graph.nodes
    .map((n) => n.data?.startTime)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (starts.length) return formatGanttDate(Math.min(...starts), format);
  return "2026-01-01";
}

export const ganttUI: FamilyUI = {
  family: "gantt",
  title: "Gantt chart",
  shapes: [
    { value: "task", label: "Task" },
    { value: "milestone", label: "Milestone" },
  ],
  edgeKinds: [
    {
      value: "depends",
      label: "Depends on",
      arrowStart: "none",
      arrowEnd: "arrow_point",
      pattern: "solid",
    },
  ],
  patterns: [],
  arrowHeads: [],
  groups: { supported: true, label: "Section" },
  labels: true,
  nodeNoun: "Task",
  edgeNoun: "Dependency",
  nextId: nextTaskId,
  canDetach: true,
  styling: false,
  // Connecting A → B writes `after A` into B's start.
  connectable: true,
  directions: false,
  arrange: false,
  preview: false,
  nodeFields: [
    { key: "start", label: "Start", type: "text", placeholder: "2026-10-01 or after ds" },
    { key: "end", label: "End or duration", type: "text", placeholder: "14d" },
    {
      key: "tags",
      label: "Tags",
      type: "tags",
      hint: "done, active, crit, milestone, vert",
      options: GANTT_TAGS.map((t) => ({ value: t, label: t })),
    },
    { key: "id", label: "Task id", type: "text" },
  ],
  diagramFields: [
    { key: "dateFormat", label: "Date format", type: "text", placeholder: "YYYY-MM-DD" },
    { key: "axisFormat", label: "Axis format", type: "text", placeholder: "%b %d" },
    { key: "excludes", label: "Excludes", type: "text", placeholder: "weekends" },
    { key: "tickInterval", label: "Tick interval", type: "text", placeholder: "1week" },
    { key: "todayMarker", label: "Today marker", type: "text", placeholder: "off" },
  ],
  newNode: (graph) => ({
    label: "New task",
    shape: "task",
    data: { start: newTaskStart(graph), end: "7d" },
  }),
};
