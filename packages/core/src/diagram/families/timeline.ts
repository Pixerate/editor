import type { DiagramGraph } from "../types.js";
import type { FamilyUI } from "./types.js";

function nextPeriodId(graph: DiagramGraph): string {
  const taken = new Set([...graph.nodes.map((n) => n.id), ...graph.groups.map((g) => g.id)]);
  let i = graph.nodes.length + 1;
  while (taken.has(`period${i}`)) i++;
  return `period${i}`;
}

export const timelineUI: FamilyUI = {
  family: "timeline",
  title: "Timeline",
  shapes: [{ value: "rounded", label: "Period" }],
  edgeKinds: [],
  patterns: [],
  arrowHeads: [],
  groups: { supported: true, label: "Section" },
  labels: true,
  nodeNoun: "Period",
  nextId: nextPeriodId,
  canDetach: true,
  styling: false,
  connectable: false,
  directions: false,
  arrange: false,
  preview: false,
  nodeFields: [{ key: "events", label: "Events (one per line)", type: "lines" }],
  newNode: () => ({ label: "New period", shape: "rounded", data: { events: ["Event"] } }),
};
