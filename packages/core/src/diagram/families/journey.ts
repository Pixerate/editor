import type { DiagramGraph } from "../types.js";
import type { FamilyUI } from "./types.js";

function nextTaskId(graph: DiagramGraph): string {
  const taken = new Set([...graph.nodes.map((n) => n.id), ...graph.groups.map((g) => g.id)]);
  let i = graph.nodes.length + 1;
  while (taken.has(`task${i}`)) i++;
  return `task${i}`;
}

export const journeyUI: FamilyUI = {
  family: "journey",
  title: "User journey",
  shapes: [{ value: "rect", label: "Task" }],
  edgeKinds: [],
  patterns: [],
  arrowHeads: [],
  groups: { supported: true, label: "Section" },
  labels: true,
  nodeNoun: "Task",
  nextId: nextTaskId,
  canDetach: true,
  styling: false,
  connectable: false,
  directions: false,
  arrange: false,
  preview: false,
  nodeFields: [
    { key: "score", label: "Score", type: "number", min: 1, max: 5, step: 1 },
    { key: "actors", label: "Actors", type: "tags" },
  ],
  newNode: () => ({ label: "New task", shape: "rect", data: { score: 3, actors: [] } }),
};
